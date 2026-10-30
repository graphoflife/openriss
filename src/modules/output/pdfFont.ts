// TrueType-Schriften für den PDF-Export: Tabellen lesen (head, hhea, maxp, hmtx, OS/2, post, name,
// cmap Format 4/12), Zeichen → Glyphen inkl. Ersatzdarstellung, Teilmenge für die Einbettung (FontFile2).
// DOM-frei.

export interface TtfFont {
  name: string;
  data: Uint8Array;
  upm: number;
  numGlyphs: number;
  /** Vorschub je Glyph in 1/1000 em (gerundet, identisch mit /W im PDF) */
  adv: Uint16Array;
  cmap: Map<number, number>;
  /** in 1/1000 em */
  ascent: number; descent: number; capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  tables: Map<string, { off: number; len: number }>;
  longLoca: boolean;
}

export function parseTtf(data: Uint8Array, fallbackName = 'Font'): TtfFont {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (o: number) => dv.getUint16(o), i16 = (o: number) => dv.getInt16(o), u32 = (o: number) => dv.getUint32(o);
  const tables = new Map<string, { off: number; len: number }>();
  const nt = u16(4);
  for (let i = 0; i < nt; i++) {
    const o = 12 + i * 16;
    tables.set(String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]), { off: u32(o + 8), len: u32(o + 12) });
  }
  const T = (t: string) => { const x = tables.get(t); if (!x) throw new Error('TrueType: Tabelle fehlt: ' + t); return x.off; };
  const head = T('head'), hhea = T('hhea'), maxp = T('maxp'), hmtx = T('hmtx');
  const upm = u16(head + 18); const k = 1000 / upm;
  const numGlyphs = u16(maxp + 4); const nh = u16(hhea + 34);
  const adv = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) adv[g] = Math.round(u16(hmtx + 4 * Math.min(g, nh - 1)) * k);
  let capHeight = 0.716 * 1000;
  const os2 = tables.get('OS/2');
  if (os2 && os2.len >= 90 && u16(os2.off) >= 2) capHeight = i16(os2.off + 88) * k;
  const post = tables.get('post');
  const italicAngle = post ? dv.getInt32(post.off + 4) / 65536 : 0;
  // PostScript-Name (name-ID 6)
  let name = fallbackName;
  const nm = tables.get('name');
  if (nm) {
    const cnt = u16(nm.off + 2), so = nm.off + u16(nm.off + 4);
    for (let i = 0; i < cnt; i++) {
      const r = nm.off + 6 + i * 12;
      if (u16(r + 6) !== 6) continue;
      const pl = u16(r), len = u16(r + 8), off = so + u16(r + 10);
      let s = '';
      if (pl === 3 || pl === 0) for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(u16(off + j));
      else for (let j = 0; j < len; j++) s += String.fromCharCode(data[off + j]);
      s = s.replace(/[^A-Za-z0-9-]/g, '');
      if (s) { name = s; break; }
    }
  }
  return {
    name, data, upm, numGlyphs, adv, cmap: parseCmap(dv, T('cmap')),
    ascent: i16(hhea + 4) * k, descent: i16(hhea + 6) * k, capHeight,
    bbox: [i16(head + 36) * k, i16(head + 38) * k, i16(head + 40) * k, i16(head + 42) * k].map(Math.round) as [number, number, number, number],
    italicAngle, tables, longLoca: i16(head + 50) === 1,
  };
}

function parseCmap(dv: DataView, cmap: number): Map<number, number> {
  const u16 = (o: number) => dv.getUint16(o), u32 = (o: number) => dv.getUint32(o);
  const n = u16(cmap + 2);
  let f4 = -1, f12 = -1;
  for (let i = 0; i < n; i++) {
    const pl = u16(cmap + 4 + i * 8), en = u16(cmap + 6 + i * 8), off = cmap + u32(cmap + 8 + i * 8);
    const fmt = u16(off);
    if (fmt === 12 && (pl === 3 && en === 10 || pl === 0)) f12 = off;
    if (fmt === 4 && (pl === 3 && en === 1 || pl === 0)) f4 = off;
  }
  const m = new Map<number, number>();
  if (f12 >= 0) {
    const ng = u32(f12 + 12);
    for (let i = 0; i < ng; i++) {
      const o = f12 + 16 + i * 12; const s = u32(o), e = u32(o + 4), g = u32(o + 8);
      for (let c = s; c <= e && c - s < 0x10000; c++) m.set(c, g + c - s);
    }
    return m;
  }
  if (f4 < 0) throw new Error('TrueType: keine Unicode-cmap');
  const sc = u16(f4 + 6) / 2;
  const ends = f4 + 14, starts = ends + sc * 2 + 2, deltas = starts + sc * 2, ros = deltas + sc * 2;
  for (let i = 0; i < sc; i++) {
    const e = u16(ends + i * 2), s = u16(starts + i * 2), d = u16(deltas + i * 2), ro = u16(ros + i * 2);
    for (let c = s; c <= e && c !== 0xffff; c++) {
      let g: number;
      if (ro === 0) g = (c + d) & 0xffff;
      else { g = u16(ros + i * 2 + ro + 2 * (c - s)); if (g) g = (g + d) & 0xffff; }
      if (g) m.set(c, g);
    }
  }
  return m;
}

// ------------------------------------------------------------ Zeichen → Glyphen
/** Positionierte Glyphe: x in em (relativ zum Zeilenanfang), sz = Größenfaktor, rise in em */
export interface PGlyph { gid: number; u: string; x: number; sz: number; rise: number }
export interface PLine { glyphs: PGlyph[]; width: number; rings: { x0: number; x1: number }[] }

const SUP: Record<number, string> = { 0x2070: '0', 0x2071: 'i', 0x2074: '4', 0x2075: '5', 0x2076: '6', 0x2077: '7', 0x2078: '8', 0x2079: '9', 0x207a: '+', 0x207b: '-', 0x207c: '=', 0x207d: '(', 0x207e: ')', 0x207f: 'n' };
const SUB: Record<number, string> = { 0x208a: '+', 0x208b: '-', 0x208c: '=', 0x208d: '(', 0x208e: ')' };
for (let i = 0; i < 10; i++) SUB[0x2080 + i] = String(i);
/** Ersatz, wenn die Schrift das Zeichen nicht hat: [Text, eingekreist] */
const SUBST: Record<number, [string, boolean]> = {
  0x2297: ['×', true], 0x2295: ['+', true], 0x2299: ['·', true], 0x2296: ['−', true], 0x25ef: [' ', true], 0x25cb: [' ', true],
  0x2300: ['Ø', false], 0x2205: ['Ø', false], 0x2713: ['√', false], 0x2714: ['√', false], 0x2717: ['×', false], 0x2212: ['-', false],
  0x2009: [' ', false], 0x202f: [' ', false], 0x2002: [' ', false], 0x2003: [' ', false], 0x2011: ['-', false], 0x2010: ['-', false],
};
const SUP_SZ = 0.6, SUP_RISE = 0.33, SUB_RISE = -0.12, RING_SZ = 0.68;

/**
 * Text einer Zeile in positionierte Glyphen umsetzen. Fehlende Zeichen: hochgestellte/tiefgestellte Ziffern
 * werden verkleinert aus normalen Ziffern gesetzt, eingekreiste Zahlen (①…⑳) und ⊗/⊕ mit Kreis gezeichnet,
 * sonst Unicode-Zerlegung (NFKD), zuletzt „?“.
 */
export function layoutLine(f: TtfFont, s: string): PLine {
  const glyphs: PGlyph[] = []; const rings: { x0: number; x1: number }[] = [];
  let x = 0;
  const q = f.cmap.get(0x3f) ?? 0;
  const put = (ch: string, sz = 1, rise = 0): void => {
    for (const c of ch) {
      const g = f.cmap.get(c.codePointAt(0)!);
      const gid = g ?? q; glyphs.push({ gid, u: g === undefined ? '?' : c, x, sz, rise }); x += (f.adv[gid] / 1000) * sz;
    }
  };
  const ring = (t: string): void => {
    let w = 0; for (const c of t) w += f.adv[f.cmap.get(c.codePointAt(0)!) ?? q] / 1000 * RING_SZ;
    const d = Math.max(0.92, w + 0.3); const x0 = x;
    x += (d - w) / 2; put(t, RING_SZ, 0.36 - RING_SZ * 0.36); x = x0 + d;
    rings.push({ x0, x1: x0 + d });
  };
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9) { put(' '); continue; }
    if (cp < 32) continue;
    if (f.cmap.has(cp)) { put(ch); continue; }
    if (SUP[cp]) { put(SUP[cp], SUP_SZ, SUP_RISE); continue; }
    if (SUB[cp]) { put(SUB[cp], SUP_SZ, SUB_RISE); continue; }
    if (cp >= 0x2460 && cp <= 0x2473) { ring(String(cp - 0x245f)); continue; }
    if (cp === 0x24ea) { ring('0'); continue; }
    if (cp >= 0x2776 && cp <= 0x2793) { ring(String((cp - 0x2776) % 10 + 1)); continue; }
    const sb = SUBST[cp];
    if (sb) { if (sb[1]) ring(sb[0]); else put(sb[0]); continue; }
    const d = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (d && d !== ch && [...d].every((c) => f.cmap.has(c.codePointAt(0)!))) { put(d); continue; }
    put('?');
  }
  return { glyphs, width: x, rings };
}

// ------------------------------------------------------------ Teilmenge (Glyph-IDs bleiben erhalten)
const KEEP = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2', 'post', 'prep'];

/** TrueType-Datei mit nur den verwendeten Glyphen (übrige leer); loca wird lang geschrieben. */
export function subsetTtf(f: TtfFont, used: Iterable<number>): Uint8Array {
  const src = f.data;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const loca = f.tables.get('loca')!.off, glyf = f.tables.get('glyf')!.off;
  const at = (g: number) => (f.longLoca ? dv.getUint32(loca + g * 4) : dv.getUint16(loca + g * 2) * 2);
  const keep = new Set<number>();
  const stack = [0, ...used];
  while (stack.length) {
    const g = stack.pop()!;
    if (g < 0 || g >= f.numGlyphs || keep.has(g)) continue;
    keep.add(g);
    const s = at(g), e = at(g + 1);
    if (e <= s || dv.getInt16(glyf + s) >= 0) continue;
    // zusammengesetzte Glyphe: Komponenten mitnehmen
    let o = glyf + s + 10;
    for (;;) {
      const fl = dv.getUint16(o); stack.push(dv.getUint16(o + 2));
      o += 4 + (fl & 1 ? 4 : 2) + (fl & 8 ? 2 : fl & 0x40 ? 4 : fl & 0x80 ? 8 : 0);
      if (!(fl & 0x20)) break;
    }
  }
  // neue glyf/loca
  let size = 0;
  for (const g of keep) size += (at(g + 1) - at(g) + 3) & ~3;
  const ng = new Uint8Array(size); const nl = new Uint8Array((f.numGlyphs + 1) * 4); const nlv = new DataView(nl.buffer);
  let p = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    nlv.setUint32(g * 4, p);
    if (!keep.has(g)) continue;
    const s = at(g), e = at(g + 1);
    if (e > s) { ng.set(src.subarray(glyf + s, glyf + e), p); p += (e - s + 3) & ~3; }
  }
  nlv.setUint32(f.numGlyphs * 4, p);
  const parts: [string, Uint8Array][] = [];
  for (const tag of KEEP) {
    const t = f.tables.get(tag); if (!t) continue;
    let d: Uint8Array;
    if (tag === 'glyf') d = ng.subarray(0, p);
    else if (tag === 'loca') d = nl;
    else if (tag === 'post') { d = src.slice(t.off, t.off + 32); new DataView(d.buffer).setUint32(0, 0x00030000); }
    else d = src.slice(t.off, t.off + t.len);
    if (tag === 'head') { const hv = new DataView(d.buffer, d.byteOffset, d.byteLength); hv.setUint32(8, 0); hv.setInt16(50, 1); }
    parts.push([tag, d]);
  }
  parts.sort((a, b) => (a[0] < b[0] ? -1 : 1)); // Verzeichnis nach Tag sortiert
  const n = parts.length;
  let es = 0; while (1 << (es + 1) <= n) es++;
  let total = 12 + n * 16; for (const [, d] of parts) total += (d.length + 3) & ~3;
  const out = new Uint8Array(total); const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x00010000); ov.setUint16(4, n); ov.setUint16(6, (1 << es) * 16); ov.setUint16(8, es); ov.setUint16(10, n * 16 - (1 << es) * 16);
  let off = 12 + n * 16; let headOff = 0;
  parts.forEach(([tag, d], i) => {
    const r = 12 + i * 16;
    for (let j = 0; j < 4; j++) out[r + j] = tag.charCodeAt(j);
    out.set(d, off);
    ov.setUint32(r + 4, checksum(out, off, d.length)); ov.setUint32(r + 8, off); ov.setUint32(r + 12, d.length);
    if (tag === 'head') headOff = off;
    off += (d.length + 3) & ~3;
  });
  if (headOff) ov.setUint32(headOff + 8, (0xb1b0afba - checksum(out, 0, out.length)) >>> 0);
  return out;
}

function checksum(b: Uint8Array, off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i += 4) s = (s + ((b[off + i] << 24) | ((b[off + i + 1] ?? 0) << 16) | ((b[off + i + 2] ?? 0) << 8) | (b[off + i + 3] ?? 0))) >>> 0;
  return s;
}
