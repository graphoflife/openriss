// Rasterbilder für den PDF-Export (DOM-frei): JPEG unverändert (DCTDecode), PNG dekodiert
// (Inflate + Zeilenfilter, alle Farbtypen/Bittiefen, Adam7) zu 8-Bit-Farbe plus Alphakanal (SMask).
import { unzlibSync } from 'fflate';

export interface PdfImage {
  w: number; h: number;
  cs: 'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK';
  filter: 'DCTDecode' | 'raw';
  data: Uint8Array;
  /** 8-Bit-Deckkraft je Pixel (nur PNG mit Transparenz) */
  alpha?: Uint8Array;
  /** z.B. invertiertes Adobe-CMYK-JPEG */
  decode?: number[];
}

/** Daten-URL → Bytes und MIME-Typ */
export function parseDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(src);
  if (!m) return null;
  const body = src.slice(m[0].length);
  let bytes: Uint8Array;
  if (/;base64/i.test(m[2])) {
    const bin = atob(body.replace(/\s+/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const s = decodeURIComponent(body); bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return { mime: m[1].toLowerCase(), bytes };
}

/** Bild aus Daten-URL; null = Format nicht unterstützt (GIF, WebP, SVG …) oder fehlerhaft */
export function decodeImage(src: string): PdfImage | null {
  const d = parseDataUrl(src);
  if (!d) return null;
  const b = d.bytes;
  try {
    if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return png(b);
  } catch (e) { console.warn('PDF: Bild nicht lesbar', e); }
  return null;
}

function jpeg(b: Uint8Array): PdfImage | null {
  let i = 2; let adobe = false;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xee && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7], b[i + 8]) === 'Adobe') adobe = true;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8], nc = b[i + 9];
      const cs = nc === 1 ? 'DeviceGray' : nc === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      return { w, h, cs, filter: 'DCTDecode', data: b, decode: nc === 4 && adobe ? [1, 0, 1, 0, 1, 0, 1, 0] : undefined };
    }
    i += 2 + len;
  }
  return null;
}

function png(b: Uint8Array): PdfImage | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w = 0, h = 0, bd = 8, ct = 0, il = 0;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = []; let idLen = 0;
  for (let i = 8; i + 8 <= b.length;) {
    const len = dv.getUint32(i); const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const data = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(i + 8); h = dv.getUint32(i + 12); bd = b[i + 16]; ct = b[i + 17]; il = b[i + 20]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') { idat.push(data); idLen += len; }
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!w || !h) return null;
  const z = new Uint8Array(idLen); let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = unzlibSync(z);
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const bpp = ch * bd; const bpx = Math.max(1, bpp >> 3);
  const outCh = ct === 0 || ct === 4 ? 1 : 3;
  const col = new Uint8Array(w * h * outCh);
  const hasA = ct === 4 || ct === 6 || !!trns;
  const alpha = hasA ? new Uint8Array(w * h).fill(255) : null;
  const max = (1 << bd) - 1;
  const tv = (k: number) => (trns && trns.length >= 2 * (k + 1) ? (trns[2 * k] << 8) | trns[2 * k + 1] : -1);
  const tg = ct === 0 ? tv(0) : -1, tr = ct === 2 ? [tv(0), tv(1), tv(2)] : null;
  // Abtastwert (volle Bittiefe) des Kanals c von Pixel x einer Zeile
  const sample = (row: Uint8Array, ro: number, x: number, c: number): number => {
    if (bd === 8) return row[ro + x * ch + c];
    if (bd === 16) { const k = ro + (x * ch + c) * 2; return (row[k] << 8) | row[k + 1]; }
    const bit = x * bd; return (row[ro + (bit >> 3)] >> (8 - bd - (bit & 7))) & max;
  };
  const to8 = (v: number) => (bd === 16 ? v >> 8 : bd === 8 ? v : Math.round((v * 255) / max));
  let pos = 0;
  const pass = (x0: number, y0: number, dx: number, dy: number) => {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const rb = Math.ceil((pw * bpp) / 8);
    for (let y = 0; y < ph; y++) {
      const ft = raw[pos]; const ro = pos + 1; const prev = y ? ro - rb - 1 : -1;
      for (let i = 0; i < rb; i++) {
        const a = i >= bpx ? raw[ro + i - bpx] : 0, up = prev >= 0 ? raw[prev + i] : 0, c = prev >= 0 && i >= bpx ? raw[prev + i - bpx] : 0;
        let v = raw[ro + i];
        if (ft === 1) v += a; else if (ft === 2) v += up; else if (ft === 3) v += (a + up) >> 1;
        else if (ft === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        raw[ro + i] = v & 0xff;
      }
      const yy = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const k = yy * w + x0 + x * dx;
        if (ct === 3) {
          const idx = sample(raw, ro, x, 0);
          if (plte) { col[k * 3] = plte[idx * 3]; col[k * 3 + 1] = plte[idx * 3 + 1]; col[k * 3 + 2] = plte[idx * 3 + 2]; }
          if (alpha && trns && idx < trns.length) alpha[k] = trns[idx];
        } else if (ct === 0 || ct === 4) {
          const v = sample(raw, ro, x, 0); col[k] = to8(v);
          if (alpha) alpha[k] = ct === 4 ? to8(sample(raw, ro, x, 1)) : v === tg ? 0 : 255;
        } else {
          const r = sample(raw, ro, x, 0), g = sample(raw, ro, x, 1), bl = sample(raw, ro, x, 2);
          col[k * 3] = to8(r); col[k * 3 + 1] = to8(g); col[k * 3 + 2] = to8(bl);
          if (alpha) alpha[k] = ct === 6 ? to8(sample(raw, ro, x, 3)) : tr && r === tr[0] && g === tr[1] && bl === tr[2] ? 0 : 255;
        }
      }
      pos += rb + 1;
    }
  };
  if (il) for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) pass(x0, y0, dx, dy);
  else pass(0, 0, 1, 1);
  let opaque = true;
  if (alpha) for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) { opaque = false; break; }
  return { w, h, cs: outCh === 1 ? 'DeviceGray' : 'DeviceRGB', filter: 'raw', data: col, alpha: opaque ? undefined : alpha! };
}
