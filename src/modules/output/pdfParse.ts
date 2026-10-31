// PDF-Leser für den Vektorimport (DOM-frei): Objekte, Querverweistabellen und -ströme (PDF 1.5), Objektströme,
// Wiederherstellung bei defekter Tabelle, Filter (Flate/LZW mit PNG-/TIFF-Prädiktoren, ASCIIHex, ASCII85, RunLength),
// Seitenbaum mit Vererbung (MediaBox/CropBox/Rotate/Resources).
// Inhaltsströme: Pfade (m l c v y h re), Malen (S s f F f* B B* b b* n), Clipping (W W* → umschliessendes Rechteck),
// Linienbreite/Strichmuster (w d, ExtGState), Farben (Gray/RGB/CMYK, ICCBased, Indexed, Separation, Muster: OpenRiss-
// Füllmuster werden wiedererkannt), cm q Q, Form-XObjekte (rekursiv, /Matrix, /BBox), Text (BT ET Tf Td TD Tm T* Tj TJ
// ' " Tc Tw Tz TL Ts Tr) mit ToUnicode-CMaps (bfchar/bfrange), Kodierungen (WinAnsi, MacRoman, Standard, Differences)
// und Breiten (Widths, W/DW), optionale Inhalte (Ebenen/OCG). Ergebnis in Papier-mm, y nach oben, Ursprung links unten.
import { unzlibSync, inflateSync } from 'fflate';
import { V2, Mat2, BBox, compose, emptyBox, extendBox, boxValid } from '../../core/geom';
import { PATTERNS, TileCtx } from '../../render/styles';
import { textWidth } from '../../render/displayList';
import { VecData, VPath, VFill, VText, HAl, PathBuilder, emptyVec, skip, rgbHex, subPoints, fontOf } from './vectorImport';

// ------------------------------------------------------------ Objekte
class PName { constructor(readonly n: string) {} }
class PRef { constructor(readonly n: number, readonly g: number) {} }
class PStr { constructor(readonly b: Uint8Array) {} }
class PStream { constructor(public dict: PDict, public raw: Uint8Array) {} }
type PDict = Record<string, any>;
const EOF = Symbol('eof');
const D_OPEN = Symbol('<<'), D_CLOSE = Symbol('>>'), A_OPEN = Symbol('['), A_CLOSE = Symbol(']');

const WS = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256); for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const latin1 = (b: Uint8Array, s = 0, e = b.length) => { let o = ''; for (let i = s; i < e; i += 8192) o += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192))); return o; };

class Lexer {
  constructor(public b: Uint8Array, public i = 0) {}
  ws(): void {
    const b = this.b;
    for (;;) {
      while (this.i < b.length && WS[b[this.i]]) this.i++;
      if (b[this.i] === 37) { while (this.i < b.length && b[this.i] !== 10 && b[this.i] !== 13) this.i++; continue; }
      break;
    }
  }
  /** nächstes Token: Zahl, PName, PStr, Schlüsselwort (string), Klammer-Symbol oder EOF */
  tok(): any {
    this.ws();
    const b = this.b; const n = b.length;
    if (this.i >= n) return EOF;
    const c = b[this.i];
    if (c === 47) { // Name
      let j = this.i + 1; let s = '';
      while (j < n && !WS[b[j]] && !DELIM[b[j]]) {
        if (b[j] === 35 && j + 2 < n) { s += String.fromCharCode(parseInt(String.fromCharCode(b[j + 1], b[j + 2]), 16)); j += 3; } else s += String.fromCharCode(b[j++]);
      }
      this.i = j; return new PName(s);
    }
    if (c === 40) return this.litStr();
    if (c === 60) {
      if (b[this.i + 1] === 60) { this.i += 2; return D_OPEN; }
      const out: number[] = []; let j = this.i + 1; let hi = -1;
      for (; j < n && b[j] !== 62; j++) {
        const v = hexVal(b[j]); if (v < 0) continue;
        if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      this.i = j + 1; return new PStr(new Uint8Array(out));
    }
    if (c === 62) { this.i += b[this.i + 1] === 62 ? 2 : 1; return D_CLOSE; }
    if (c === 91) { this.i++; return A_OPEN; }
    if (c === 93) { this.i++; return A_CLOSE; }
    if (c === 123 || c === 125) { this.i++; return c === 123 ? '{' : '}'; }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const start = this.i; let j = start; let neg = false; let v = 0; let frac = 0; let sc = 1; let any = false;
      while (j < n && (b[j] === 43 || b[j] === 45)) { if (b[j] === 45) neg = !neg; j++; }
      for (; j < n; j++) {
        const d = b[j];
        if (d >= 48 && d <= 57) { any = true; if (frac) { sc /= 10; v += (d - 48) * sc; } else v = v * 10 + d - 48; }
        else if (d === 46 && !frac) frac = 1;
        else break;
      }
      this.i = j > start ? j : start + 1;
      if (!any) return 0;
      return neg ? -v : v;
    }
    let j = this.i;
    while (j < n && !WS[b[j]] && !DELIM[b[j]]) j++;
    if (j === this.i) { this.i++; return this.tok(); }
    const s = latin1(b, this.i, j); this.i = j; return s;
  }
  private litStr(): PStr {
    const b = this.b; const n = b.length; const out: number[] = []; let depth = 1; let j = this.i + 1;
    while (j < n) {
      const c = b[j++];
      if (c === 92) {
        const e = b[j++];
        switch (e) {
          case 110: out.push(10); break; case 114: out.push(13); break; case 116: out.push(9); break;
          case 98: out.push(8); break; case 102: out.push(12); break;
          case 13: if (b[j] === 10) j++; break; case 10: break;
          default:
            if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[j] >= 48 && b[j] <= 55; k++) v = v * 8 + b[j++] - 48;
              out.push(v & 255);
            } else out.push(e);
        }
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
      out.push(c);
    }
    this.i = j;
    return new PStr(new Uint8Array(out));
  }
  /** Objekt lesen (refs: «n g R» erkennen) */
  obj(refs = true): any {
    const t = this.tok();
    return this.objFrom(t, refs);
  }
  objFrom(t: any, refs: boolean): any {
    if (t === A_OPEN) { const a: any[] = []; for (;;) { const x = this.tok(); if (x === A_CLOSE || x === EOF) break; a.push(this.objFrom(x, refs)); } return a; }
    if (t === D_OPEN) {
      const d: PDict = {};
      for (;;) {
        const k = this.tok(); if (k === D_CLOSE || k === EOF) break;
        if (!(k instanceof PName)) continue;
        d[k.n] = this.obj(refs);
      }
      return d;
    }
    if (typeof t === 'number' && refs && Number.isInteger(t) && t >= 0) {
      const save = this.i; const g = this.tok();
      if (typeof g === 'number' && Number.isInteger(g)) { const r = this.tok(); if (r === 'R') return new PRef(t, g); }
      this.i = save;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    return t;
  }
}
function hexVal(c: number): number { return c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1; }

// ------------------------------------------------------------ Filter
function inflate(d: Uint8Array): Uint8Array | null {
  try { return unzlibSync(d); } catch { /* weiter */ }
  try { return inflateSync(d.subarray(2)); } catch { /* weiter */ }
  try { return inflateSync(d); } catch { return null; }
}
function predict(d: Uint8Array, p: PDict | null | undefined): Uint8Array {
  const pred = p?.Predictor ?? 1; if (pred <= 1) return d;
  const colors = p?.Colors ?? 1, bpc = p?.BitsPerComponent ?? 8, cols = p?.Columns ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)); const row = Math.ceil((colors * bpc * cols) / 8);
  if (pred === 2) {
    if (bpc !== 8) return d;
    const out = d.slice();
    for (let r = 0; r + row <= out.length; r += row) for (let i = bpp; i < row; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(d.length / (row + 1)); const out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const ft = d[r * (row + 1)]; const src = r * (row + 1) + 1; const o = r * row;
    for (let i = 0; i < row; i++) {
      const x = d[src + i]; const a = i >= bpp ? out[o + i - bpp] : 0; const up = r ? out[o - row + i] : 0; const ul = r && i >= bpp ? out[o - row + i - bpp] : 0;
      let v = x;
      if (ft === 1) v = x + a; else if (ft === 2) v = x + up; else if (ft === 3) v = x + ((a + up) >> 1);
      else if (ft === 4) { const pp = a + up - ul, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - ul); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      out[o + i] = v & 255;
    }
  }
  return out;
}
function lzw(d: Uint8Array, early = 1): Uint8Array {
  const out: number[] = []; let dict: number[][] = []; let bits = 9; let buf = 0, nb = 0; let prev: number[] | null = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); bits = 9; };
  reset();
  for (let i = 0; i < d.length; i++) {
    buf = (buf << 8) | d[i]; nb += 8;
    while (nb >= bits) {
      const code = (buf >> (nb - bits)) & ((1 << bits) - 1); nb -= bits;
      if (code === 256) { reset(); prev = null; continue; }
      if (code === 257) return new Uint8Array(out);
      let e: number[];
      if (code < dict.length && dict[code].length) e = dict[code];
      else if (prev) e = [...prev, prev[0]]; else continue;
      out.push(...e);
      if (prev) dict.push([...prev, e[0]]);
      prev = e;
      if (dict.length + early >= 1 << bits && bits < 12) bits++;
    }
  }
  return new Uint8Array(out);
}
function a85(d: Uint8Array): Uint8Array {
  const out: number[] = []; let g: number[] = [];
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === 126) break; // ~>
    if (WS[c]) continue;
    if (c === 122 && !g.length) { out.push(0, 0, 0, 0); continue; }
    g.push(c - 33);
    if (g.length === 5) { let v = 0; for (const x of g) v = v * 85 + x; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); g = []; }
  }
  if (g.length > 1) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const x of g) v = v * 85 + x; const bs = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...bs.slice(0, n - 1)); }
  return new Uint8Array(out);
}
function ahx(d: Uint8Array): Uint8Array {
  const out: number[] = []; let hi = -1;
  for (const c of d) { if (c === 62) break; const v = hexVal(c); if (v < 0) continue; if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; } }
  if (hi >= 0) out.push(hi * 16);
  return new Uint8Array(out);
}
function rle(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < d.length;) { const n = d[i++]; if (n === 128) break; if (n < 128) { for (let k = 0; k <= n; k++) out.push(d[i++]); } else { const v = d[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); } }
  return new Uint8Array(out);
}

// ------------------------------------------------------------ Datei
type XEnt = { t: 0 } | { t: 1; off: number } | { t: 2; stm: number; idx: number };
class PdfFile {
  xref = new Map<number, XEnt>();
  trailer: PDict = {};
  private cache = new Map<number, any>();
  private objStm = new Map<number, { data: Uint8Array; offs: Map<number, number>; first: number }>();
  constructor(readonly b: Uint8Array) {
    try { this.readXref(); } catch { this.xref.clear(); this.trailer = {}; }
    if (!this.trailer.Root || !this.get(this.trailer.Root)) this.rebuild();
    if (this.trailer.Encrypt) throw new Error('Verschlüsselte PDF-Dateien werden nicht unterstützt.');
  }
  private readXref(): void {
    const tail = latin1(this.b, Math.max(0, this.b.length - 2048));
    const m = /startxref\s+(\d+)/g; let off = -1; let r: RegExpExecArray | null;
    while ((r = m.exec(tail))) off = parseInt(r[1], 10);
    const seen = new Set<number>();
    while (off >= 0 && off < this.b.length && !seen.has(off)) {
      seen.add(off);
      const lx = new Lexer(this.b, off); const t = lx.tok();
      let tr: PDict;
      if (t === 'xref') {
        for (;;) {
          const a = lx.tok(); if (a === 'trailer' || a === EOF) break;
          const cnt = lx.tok() as number;
          for (let k = 0; k < cnt; k++) {
            const o = lx.tok() as number; lx.tok(); const ty = lx.tok();
            const id = (a as number) + k;
            if (!this.xref.has(id)) this.xref.set(id, ty === 'n' ? { t: 1, off: o } : { t: 0 });
          }
        }
        tr = lx.obj();
        if (typeof tr.XRefStm === 'number') this.xrefStream(tr.XRefStm, seen);
      } else tr = this.xrefStream(off, seen);
      for (const [k, v] of Object.entries(tr)) if (!(k in this.trailer)) this.trailer[k] = v;
      off = typeof tr.Prev === 'number' ? tr.Prev : -1;
    }
  }
  private xrefStream(off: number, seen: Set<number>): PDict {
    seen.add(off);
    const s = this.parseAt(off);
    if (!(s instanceof PStream)) throw new Error('xref');
    const d = s.dict; const data = this.decode(s); if (!data) throw new Error('xref');
    const W: number[] = d.W; const size = d.Size ?? 0; const idx: number[] = d.Index ?? [0, size];
    let p = 0; const rd = (w: number) => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[p++]; return v; };
    for (let i = 0; i + 1 < idx.length; i += 2) for (let k = 0; k < idx[i + 1] && p < data.length; k++) {
      const ty = W[0] ? rd(W[0]) : 1, f2 = rd(W[1]), f3 = rd(W[2]); const id = idx[i] + k;
      if (this.xref.has(id)) continue;
      this.xref.set(id, ty === 1 ? { t: 1, off: f2 } : ty === 2 ? { t: 2, stm: f2, idx: f3 } : { t: 0 });
    }
    return d;
  }
  /** Tabelle aus den «n g obj»-Stellen neu aufbauen */
  private rebuild(): void {
    this.xref.clear(); this.cache.clear(); this.objStm.clear();
    const s = latin1(this.b);
    const re = /(\d+)\s+(\d+)\s+obj\b/g; let m: RegExpExecArray | null;
    while ((m = re.exec(s))) this.xref.set(parseInt(m[1], 10), { t: 1, off: m.index });
    const tr: PDict = {};
    const tre = /trailer\s*<</g;
    while ((m = tre.exec(s))) { try { const d = new Lexer(this.b, m.index + 7).obj(); if (d?.Root) Object.assign(tr, d); } catch { /* weiter */ } }
    // Objektströme
    for (const id of [...this.xref.keys()]) {
      const o = this.get(new PRef(id, 0));
      if (o instanceof PStream && o.dict.Type instanceof PName) {
        if (o.dict.Type.n === 'ObjStm') { const st = this.stm(id); if (st) for (const [n, k] of st.offs) if (!this.xref.has(n) || (this.xref.get(n) as any).t !== 1) this.xref.set(n, { t: 2, stm: id, idx: k }); }
        if (o.dict.Type.n === 'XRef' && o.dict.Root && !tr.Root) Object.assign(tr, o.dict);
      }
    }
    if (!tr.Root) for (const id of this.xref.keys()) { const o = this.get(new PRef(id, 0)); if (o && !(o instanceof PStream) && o.Type instanceof PName && o.Type.n === 'Catalog') { tr.Root = new PRef(id, 0); break; } }
    this.trailer = tr;
    if (!tr.Root) throw new Error('PDF: Katalog nicht gefunden');
  }
  private parseAt(off: number): any {
    const lx = new Lexer(this.b, off);
    lx.tok(); lx.tok(); const kw = lx.tok(); if (kw !== 'obj') return undefined;
    const o = lx.obj();
    const save = lx.i; const t = lx.tok();
    if (t !== 'stream' || typeof o !== 'object' || o === null || Array.isArray(o)) { lx.i = save; return o; }
    let p = lx.i; if (this.b[p] === 13) p++; if (this.b[p] === 10) p++;
    let L = typeof o.Length === 'number' ? o.Length : o.Length instanceof PRef ? this.get(o.Length) : -1;
    const ok = (e: number) => { const l2 = new Lexer(this.b, e); return l2.tok() === 'endstream'; };
    if (!(typeof L === 'number' && L >= 0 && p + L <= this.b.length && ok(p + L))) {
      const s = latin1(this.b, p, Math.min(this.b.length, p + 64 * 1024 * 1024));
      let e = s.indexOf('endstream'); if (e < 0) e = s.length;
      while (e > 0 && (s.charCodeAt(e - 1) === 10 || s.charCodeAt(e - 1) === 13)) e--;
      L = e;
    }
    return new PStream(o, this.b.subarray(p, p + L));
  }
  private stm(id: number): { data: Uint8Array; offs: Map<number, number>; first: number } | null {
    let s = this.objStm.get(id);
    if (s) return s;
    const o = this.get(new PRef(id, 0)); if (!(o instanceof PStream)) return null;
    const data = this.decode(o); if (!data) return null;
    const lx = new Lexer(data); const offs = new Map<number, number>(); const N = o.dict.N ?? 0;
    for (let i = 0; i < N; i++) { const n = lx.tok(), off = lx.tok(); if (typeof n !== 'number' || typeof off !== 'number') break; offs.set(n, off); }
    s = { data, offs, first: o.dict.First ?? 0 }; this.objStm.set(id, s);
    return s;
  }
  /** Objekt auflösen (Verweise folgen) */
  get(x: any): any {
    let n = 0;
    while (x instanceof PRef && n++ < 32) {
      const id = x.n;
      if (this.cache.has(id)) { x = this.cache.get(id); continue; }
      const e = this.xref.get(id); let v: any = null;
      try {
        if (e?.t === 1) v = this.parseAt(e.off);
        else if (e?.t === 2) { const s = this.stm(e.stm); const off = s?.offs.get(id); if (s && off !== undefined) v = new Lexer(s.data, s.first + off).obj(); }
      } catch { v = null; }
      this.cache.set(id, v ?? null);
      x = v ?? null;
    }
    return x;
  }
  decode(s: PStream): Uint8Array | null {
    let data: Uint8Array | null = s.raw;
    const fl = this.get(s.dict.Filter); const pa = this.get(s.dict.DecodeParms);
    const fs = fl ? (Array.isArray(fl) ? fl : [fl]) : []; const ps = Array.isArray(pa) ? pa : [pa];
    for (let i = 0; i < fs.length && data; i++) {
      const f = (this.get(fs[i]) as PName)?.n; const p = this.get(ps[i]);
      if (f === 'FlateDecode' || f === 'Fl') { data = inflate(data); if (data) data = predict(data, p); }
      else if (f === 'LZWDecode' || f === 'LZW') data = predict(lzw(data, p?.EarlyChange ?? 1), p);
      else if (f === 'ASCII85Decode' || f === 'A85') data = a85(data);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') data = ahx(data);
      else if (f === 'RunLengthDecode' || f === 'RL') data = rle(data);
      else if (f === 'Crypt') continue;
      else return null;
    }
    return data;
  }
}

// ------------------------------------------------------------ Schriften
const STD = (() => { const a: string[] = []; for (let i = 0; i < 256; i++) a.push(String.fromCharCode(i)); a[0x27] = '’'; a[0x60] = '‘'; return a; })();
const table = (label: string) => { try { const d = new TextDecoder(label); const a: string[] = []; for (let i = 0; i < 256; i++) a.push(d.decode(new Uint8Array([i]))); return a; } catch { return STD.slice(); } };
let WIN: string[] | null = null, MAC: string[] | null = null;
const winAnsi = () => (WIN ??= table('windows-1252'));
const macRoman = () => (MAC ??= table('macintosh'));
const ASCII_NAMES = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at'.split(' ');
const PUNCT2 = 'bracketleft backslash bracketright asciicircum underscore grave'.split(' ');
const PUNCT3 = 'braceleft bar braceright asciitilde'.split(' ');
const LAT1 = ('nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown ' +
  'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls ' +
  'agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis').split(' ');
let GLYPHS: Map<string, string> | null = null;
function glyphUni(name: string): string | undefined {
  if (!GLYPHS) {
    const g = new Map<string, string>();
    ASCII_NAMES.forEach((n, i) => g.set(n, String.fromCharCode(32 + i)));
    for (let i = 0; i < 26; i++) { g.set(String.fromCharCode(65 + i), String.fromCharCode(65 + i)); g.set(String.fromCharCode(97 + i), String.fromCharCode(97 + i)); }
    PUNCT2.forEach((n, i) => g.set(n, String.fromCharCode(91 + i))); PUNCT3.forEach((n, i) => g.set(n, String.fromCharCode(123 + i)));
    LAT1.forEach((n, i) => g.set(n, String.fromCharCode(160 + i)));
    const ex: [string, number][] = [['Euro', 0x20ac], ['quotesinglbase', 0x201a], ['florin', 0x192], ['quotedblbase', 0x201e], ['ellipsis', 0x2026], ['dagger', 0x2020], ['daggerdbl', 0x2021], ['circumflex', 0x2c6],
      ['perthousand', 0x2030], ['Scaron', 0x160], ['guilsinglleft', 0x2039], ['OE', 0x152], ['Zcaron', 0x17d], ['quoteleft', 0x2018], ['quoteright', 0x2019], ['quotedblleft', 0x201c], ['quotedblright', 0x201d],
      ['bullet', 0x2022], ['endash', 0x2013], ['emdash', 0x2014], ['tilde', 0x2dc], ['trademark', 0x2122], ['scaron', 0x161], ['guilsinglright', 0x203a], ['oe', 0x153], ['zcaron', 0x17e], ['Ydieresis', 0x178],
      ['minus', 0x2212], ['fi', 0xfb01], ['fl', 0xfb02], ['dotlessi', 0x131], ['Lslash', 0x141], ['lslash', 0x142], ['space', 32], ['nonbreakingspace', 0xa0], ['periodcentered', 0xb7], ['middot', 0xb7],
      ['Omega', 0x3a9], ['mu', 0xb5], ['approxequal', 0x2248], ['lessequal', 0x2264], ['greaterequal', 0x2265], ['notequal', 0x2260], ['arrowright', 0x2192], ['arrowleft', 0x2190], ['diameter', 0x2300], ['emptyset', 0x2205]];
    for (const [n, c] of ex) g.set(n, String.fromCharCode(c));
    GLYPHS = g;
  }
  const v = GLYPHS.get(name); if (v) return v;
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name); if (m) return String.fromCodePoint(parseInt(m[1].slice(0, 4), 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name); if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^([A-Za-z]+)\.\w+$/.exec(name); if (m) return glyphUni(m[1]);
  return undefined;
}
const utf16 = (b: Uint8Array): string => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; };
/** PDF-Textzeichenkette (UTF-16BE mit BOM oder PDFDocEncoding) */
const textStr = (x: any): string => (x instanceof PStr ? (x.b[0] === 0xfe && x.b[1] === 0xff ? utf16(x.b.subarray(2)) : latin1(x.b)) : x instanceof PName ? x.n : String(x ?? ''));

interface PFont {
  /** Code-Bytes → Codes */
  codes(b: Uint8Array): { c: number; u: string; w: number; sp: boolean }[];
  bold: boolean; italic: boolean;
  /** OpenRiss-Schrift */
  font: string;
}
interface CMap { ranges: [number, number, number][]; map: Map<number, string> }
function parseCMap(data: Uint8Array): CMap {
  const lx = new Lexer(data); const cm: CMap = { ranges: [], map: new Map() };
  const num = (s: PStr) => { let v = 0; for (const x of s.b) v = v * 256 + x; return v; };
  const ops: any[] = [];
  for (;;) {
    const t = lx.obj(false); if (t === EOF) break;
    if (t === 'endcodespacerange') { for (let i = 0; i + 1 < ops.length; i += 2) if (ops[i] instanceof PStr) cm.ranges.push([ops[i].b.length, num(ops[i]), num(ops[i + 1])]); ops.length = 0; continue; }
    if (t === 'endbfchar') { for (let i = 0; i + 1 < ops.length; i += 2) if (ops[i] instanceof PStr) cm.map.set(num(ops[i]), ops[i + 1] instanceof PStr ? utf16(ops[i + 1].b) : ops[i + 1] instanceof PName ? glyphUni(ops[i + 1].n) ?? '' : ''); ops.length = 0; continue; }
    if (t === 'endbfrange') {
      for (let i = 0; i + 2 < ops.length; i += 3) {
        const lo = num(ops[i]), hi = num(ops[i + 1]), dst = ops[i + 2];
        if (hi - lo > 65535) continue;
        if (Array.isArray(dst)) dst.forEach((d: any, k: number) => { if (d instanceof PStr) cm.map.set(lo + k, utf16(d.b)); });
        else if (dst instanceof PStr) {
          const base = dst.b.slice();
          for (let c = lo; c <= hi; c++) { cm.map.set(c, utf16(base)); base[base.length - 1]++; if (base[base.length - 1] === 0 && base.length > 1) base[base.length - 2]++; }
        }
      }
      ops.length = 0; continue;
    }
    if (typeof t === 'string' && /^(begin|end)/.test(t)) { ops.length = 0; continue; }
    ops.push(t);
  }
  return cm;
}

function loadFont(f: PdfFile, fd: any): PFont {
  const d: PDict = f.get(fd) ?? {};
  const sub = (f.get(d.Subtype) as PName)?.n ?? 'Type1';
  const baseName = (f.get(d.BaseFont) as PName)?.n ?? '';
  let desc = f.get(d.FontDescriptor);
  let tu: CMap | null = null;
  const tus = f.get(d.ToUnicode);
  if (tus instanceof PStream) { const dd = f.decode(tus); if (dd) tu = parseCMap(dd); }
  let widthOf: (c: number) => number; let two = false; let ranges: [number, number, number][] = [];
  let enc: string[] | null = null;
  if (sub === 'Type0') {
    const df = f.get((f.get(d.DescendantFonts) ?? [])[0]) ?? {};
    desc = f.get(df.FontDescriptor) ?? desc;
    const dw = f.get(df.DW) ?? 1000; const W = f.get(df.W) ?? []; const wm = new Map<number, number>();
    for (let i = 0; i < W.length;) {
      const c0 = f.get(W[i]); const nx = f.get(W[i + 1]);
      if (Array.isArray(nx)) { nx.forEach((w: any, k: number) => wm.set(c0 + k, f.get(w))); i += 2; }
      else { const w = f.get(W[i + 2]); for (let c = c0; c <= nx && c - c0 < 65536; c++) wm.set(c, w); i += 3; }
    }
    widthOf = (c) => (wm.get(c) ?? dw) / 1000;
    two = true;
    const encS = f.get(d.Encoding);
    if (encS instanceof PStream) { const dd = f.decode(encS); if (dd) ranges = parseCMap(dd).ranges; }
  } else {
    const fc = f.get(d.FirstChar) ?? 0; const ws: any[] = f.get(d.Widths) ?? [];
    const fm: number[] = f.get(d.FontMatrix) ?? [0.001];
    const k = sub === 'Type3' ? (f.get(fm[0]) ?? 0.001) : 0.001;
    const mw = f.get(f.get(desc)?.MissingWidth) ?? 0;
    const mono = /Courier/i.test(baseName);
    widthOf = (c) => { const w = f.get(ws[c - fc]); return typeof w === 'number' ? w * k : mw ? mw * 0.001 : mono ? 0.6 : textWidth(enc ? enc[c] ?? ' ' : String.fromCharCode(c), 1); };
    const e = f.get(d.Encoding);
    const baseEnc = (n: string | undefined) => (n === 'WinAnsiEncoding' ? winAnsi() : n === 'MacRomanEncoding' ? macRoman() : n === 'StandardEncoding' ? STD : null);
    if (e instanceof PName) enc = baseEnc(e.n)?.slice() ?? null;
    else if (e && typeof e === 'object') {
      enc = (baseEnc((f.get(e.BaseEncoding) as PName)?.n) ?? (/Symbol|Dingbats/i.test(baseName) ? STD : winAnsi())).slice();
      const diff: any[] = f.get(e.Differences) ?? []; let c = 0;
      for (const x0 of diff) { const x = f.get(x0); if (typeof x === 'number') c = x; else if (x instanceof PName) { const u = glyphUni(x.n); if (u !== undefined) enc[c] = u; c++; } }
    }
    if (!enc) enc = winAnsi().slice();
  }
  if (tu?.ranges.length && !ranges.length) ranges = tu.ranges;
  const dsc = f.get(desc) ?? {};
  const fname = baseName + ' ' + ((f.get(dsc.FontName) as PName)?.n ?? '');
  const flags = f.get(dsc.Flags) ?? 0; const weight = f.get(dsc.FontWeight) ?? 0;
  const bold = /Bold|Black|Heavy|Semibold|Demi/i.test(fname) || (flags & (1 << 18)) !== 0 || weight >= 600;
  const italic = /Italic|Oblique/i.test(fname) || Math.abs(f.get(dsc.ItalicAngle) ?? 0) > 1;
  const lenOf = (b: Uint8Array, i: number): number => {
    if (two && ranges.length) {
      for (let n = 1; n <= 4 && i + n <= b.length; n++) { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[i + k]; if (ranges.some((r) => r[0] === n && v >= r[1] && v <= r[2])) return n; }
    }
    return two ? 2 : 1;
  };
  return {
    bold, italic, font: fontOf(fname),
    codes: (b) => {
      const out: { c: number; u: string; w: number; sp: boolean }[] = [];
      for (let i = 0; i < b.length;) {
        const n = Math.min(lenOf(b, i), b.length - i); let c = 0; for (let k = 0; k < n; k++) c = c * 256 + b[i + k];
        i += n;
        let u = tu?.map.get(c);
        if (u === undefined) u = two ? (c > 31 ? String.fromCharCode(c) : '') : enc![c] ?? '';
        if (u === '\u0000') u = '';
        out.push({ c, u, w: widthOf(c), sp: n === 1 && c === 32 });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------ Farbräume
interface CS { n: number; k: 'gray' | 'rgb' | 'cmyk' | 'lab' | 'idx' | 'sep' | 'pat' | 'none'; base?: CS; lut?: Uint8Array; hival?: number }
const GRAY: CS = { n: 1, k: 'gray' }, RGB: CS = { n: 3, k: 'rgb' }, CMYK: CS = { n: 4, k: 'cmyk' };
function colorHex(cs: CS, v: number[]): string | null {
  const c = (i: number, d = 0) => Math.max(0, Math.min(1, v[i] ?? d));
  switch (cs.k) {
    case 'gray': return rgbHex(c(0), c(0), c(0));
    case 'rgb': return rgbHex(c(0), c(1), c(2));
    case 'cmyk': { const k = c(3, 1); return rgbHex((1 - c(0)) * (1 - k), (1 - c(1)) * (1 - k), (1 - c(2)) * (1 - k)); }
    case 'lab': { const L = Math.max(0, Math.min(100, v[0] ?? 0)) / 100; return rgbHex(L, L, L); }
    case 'idx': {
      const b = cs.base!; const i = Math.max(0, Math.min(cs.hival ?? 255, Math.round(v[0] ?? 0)));
      const comps: number[] = []; for (let k = 0; k < b.n; k++) comps.push((cs.lut?.[i * b.n + k] ?? 0) / 255);
      return colorHex(b, comps);
    }
    case 'sep': { const t = 1 - c(0, 1); return rgbHex(t, t, t); }
    case 'none': return null;
    default: return '#000000';
  }
}

// ------------------------------------------------------------ OpenRiss-Füllmuster wiedererkennen
type Sig = { k: 'L' | 'D' | 'T'; v: number[] }[];
let PAT_SIGS: { name: string; w: number; h: number; sig: Sig }[] | null = null;
function patSigs() {
  if (PAT_SIGS) return PAT_SIGS;
  PAT_SIGS = [];
  for (const [name, def] of Object.entries(PATTERNS)) {
    if (def.solid) continue;
    const sig: Sig = [];
    const t: TileCtx = { line: (x1, y1, x2, y2) => sig.push({ k: 'L', v: [x1, y1, x2, y2] }), dot: (x, y, r) => sig.push({ k: 'D', v: [x, y, r] }), tri: (...a) => sig.push({ k: 'T', v: a }) };
    def.draw(t);
    PAT_SIGS.push({ name, w: def.w, h: def.h, sig });
  }
  return PAT_SIGS;
}
function sigOf(d: VecData): Sig {
  const sig: Sig = [];
  for (const p of d.paths) for (const s of p.subs) {
    if (p.fill) { const bb = emptyBox(); extendBox(bb, s.p0); for (const g of s.segs) { extendBox(bb, g.p); if (g.arc) { extendBox(bb, { x: g.arc.c.x - g.arc.r, y: g.arc.c.y - g.arc.r }); extendBox(bb, { x: g.arc.c.x + g.arc.r, y: g.arc.c.y + g.arc.r }); } } sig.push({ k: 'D', v: [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.max.x - bb.min.x) / 2] }); }
    else if (s.closed && s.segs.length === 2) sig.push({ k: 'T', v: [s.p0.x, s.p0.y, s.segs[0].p.x, s.segs[0].p.y, s.segs[1].p.x, s.segs[1].p.y] });
    else if (s.segs.length === 1) sig.push({ k: 'L', v: [s.p0.x, s.p0.y, s.segs[0].p.x, s.segs[0].p.y] });
    else sig.push({ k: 'T', v: [] });
  }
  return sig;
}
function matchPattern(sig: Sig, w: number, h: number): string {
  const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.012);
  for (const c of patSigs()) {
    if (Math.abs(c.w - w) > 0.01 || Math.abs(c.h - h) > 0.01 || c.sig.length !== sig.length) continue;
    const used = new Set<number>();
    const ok = c.sig.every((it) => {
      const j = sig.findIndex((s, k) => !used.has(k) && s.k === it.k && (near(s.v, it.v) || (it.k === 'L' && near(s.v, [it.v[2], it.v[3], it.v[0], it.v[1]]))));
      if (j < 0) return false; used.add(j); return true;
    });
    if (ok) return c.name;
  }
  // ähnliche Kachelgrösse, sonst Schraffur
  let best = 'diag', bd = Infinity;
  for (const c of patSigs()) { const dd = Math.abs(Math.log(c.w / Math.max(w, 1e-3))) + Math.abs(Math.log(c.h / Math.max(h, 1e-3))); if (dd < bd && dd < 0.1) { bd = dd; best = c.name; } }
  return best;
}

// ------------------------------------------------------------ Inhaltsstrom ausführen
interface GS {
  ctm: Mat2; lw: number; dash: number[];
  scs: CS; fcs: CS; sc: string | null; fc: string | null; fpat: VFill | null; spat: boolean;
  font: PFont | null; fs: number; tc: number; tw: number; th: number; tl: number; ts: number; tr: number;
  clip: BBox | null; clipPolys: V2[][][] | null;
}
interface Run { p: V2; e: V2; s: string; size: number; rot: number; color: string; bold: boolean; italic: boolean; font: string; block: number; clip: BBox | null; layer?: string }
const I: Mat2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
/** achsparalleles Rechteck (ein Ring, vier Ecken)? */
function isRect(rings: V2[][]): boolean {
  if (rings.length !== 1) return false;
  const r = rings[0].filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-6);
  if (r.length > 4 && Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-6) r.pop();
  if (r.length !== 4) return false;
  for (let i = 0; i < 4; i++) { const p = r[i], q = r[(i + 1) % 4]; if (Math.abs(p.x - q.x) > 1e-6 && Math.abs(p.y - q.y) > 1e-6) return false; }
  return true;
}
const isect = (a: BBox | null, b: BBox): BBox => (a ? { min: { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y) }, max: { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y) } } : b);

class Interp {
  gs: GS; stack: GS[] = [];
  pb: PathBuilder; private pendClip = false;
  runs: Run[] = []; private block = 0; private tm: Mat2 = I; private tlm: Mat2 = I;
  private fonts = new Map<any, PFont>();
  private mc: { layer?: string; hidden: boolean }[] = [];
  private forms = new Set<any>();
  constructor(private f: PdfFile, private out: VecData, base: Mat2, private hiddenOcg: Set<number>, tol: number, private depthLimit = 12) {
    this.gs = { ctm: base, lw: 1, dash: [], scs: GRAY, fcs: GRAY, sc: '#000000', fc: '#000000', fpat: null, spat: false, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, clip: null, clipPolys: null };
    this.pb = new PathBuilder(tol);
  }
  private get layer() { for (let i = this.mc.length - 1; i >= 0; i--) if (this.mc[i].layer) return this.mc[i].layer; return undefined; }
  private get hidden() { return this.mc.some((m) => m.hidden); }
  private P(x: number, y: number): V2 { const m = this.gs.ctm; return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }

  run(content: Uint8Array, res: PDict, depth = 0): void {
    const lx = new Lexer(content); const ops: any[] = [];
    for (;;) {
      const t = lx.tok();
      if (t === EOF) break;
      if (typeof t !== 'string' || t === 'true' || t === 'false' || t === 'null') { ops.push(t === A_OPEN || t === D_OPEN ? lx.objFrom(t, false) : t === 'true' ? true : t === 'false' ? false : t === 'null' ? null : t); continue; }
      if (t === 'BI') { this.skipInline(lx); ops.length = 0; continue; }
      try { this.op(t, ops, res, depth); } catch { skip(this.out, 'Fehlerhafter Operator ' + t); }
      ops.length = 0;
    }
  }
  private skipInline(lx: Lexer): void {
    for (;;) { const t = lx.tok(); if (t === EOF || t === 'ID') break; }
    const b = lx.b; let i = lx.i + 1;
    for (; i + 1 < b.length; i++) if (b[i] === 69 && b[i + 1] === 73 && WS[b[i - 1]] && (i + 2 >= b.length || WS[b[i + 2]] || DELIM[b[i + 2]])) break;
    lx.i = i + 2;
    skip(this.out, 'Bild');
  }
  private cs(name: any, res: PDict): CS {
    const f = this.f; let x = f.get(name);
    if (x instanceof PName) {
      switch (x.n) {
        case 'DeviceGray': case 'G': case 'CalGray': return GRAY;
        case 'DeviceRGB': case 'RGB': case 'CalRGB': return RGB;
        case 'DeviceCMYK': case 'CMYK': return CMYK;
        case 'Pattern': return { n: 0, k: 'pat' };
      }
      const r = f.get(f.get(res.ColorSpace)?.[x.n]);
      if (r === undefined || r === null) return GRAY;
      x = r;
      if (x instanceof PName) return this.cs(x, res);
    }
    if (!Array.isArray(x)) return GRAY;
    const fam = (f.get(x[0]) as PName)?.n;
    switch (fam) {
      case 'ICCBased': { const s = f.get(x[1]); const n = s instanceof PStream ? f.get(s.dict.N) ?? 3 : 3; return n === 1 ? GRAY : n === 4 ? CMYK : RGB; }
      case 'CalRGB': return RGB; case 'CalGray': return GRAY; case 'Lab': return { n: 3, k: 'lab' };
      case 'Indexed': case 'I': {
        const base = this.cs(x[1], res); const lu = f.get(x[3]);
        const lut = lu instanceof PStr ? lu.b : lu instanceof PStream ? f.decode(lu) ?? undefined : undefined;
        return { n: 1, k: 'idx', base, hival: f.get(x[2]) ?? 255, lut };
      }
      case 'Separation': { const nm = (f.get(x[1]) as PName)?.n; return nm === 'None' ? { n: 1, k: 'none' } : { n: 1, k: 'sep' }; }
      case 'DeviceN': { const names = f.get(x[1]) ?? []; return { n: names.length || 1, k: 'sep' }; }
      case 'Pattern': return { n: 0, k: 'pat', base: x[1] ? this.cs(x[1], res) : undefined };
      case 'DeviceRGB': return RGB; case 'DeviceCMYK': return CMYK;
    }
    return GRAY;
  }
  private initColor(cs: CS): number[] { return cs.k === 'cmyk' ? [0, 0, 0, 1] : cs.k === 'sep' ? [1] : cs.k === 'idx' ? [0] : [0, 0, 0].slice(0, Math.max(1, cs.n)); }
  private setColor(stroke: boolean, ops: any[], res: PDict): void {
    const g = this.gs; const cs = stroke ? g.scs : g.fcs;
    if (cs.k === 'pat') {
      const nm = ops[ops.length - 1];
      const comps = ops.filter((x) => typeof x === 'number');
      if (stroke) { g.sc = cs.base ? colorHex(cs.base, comps) : '#000000'; g.spat = true; return; }
      g.fpat = nm instanceof PName ? this.pattern(nm, comps, cs, res) : null;
      g.fc = g.fpat?.color ?? '#000000';
      return;
    }
    const v = ops.filter((x) => typeof x === 'number');
    const c = colorHex(cs, v);
    if (stroke) { g.sc = c; g.spat = false; } else { g.fc = c; g.fpat = null; }
  }
  private patCache = new Map<string, VFill | null>();
  private pattern(nm: PName, comps: number[], cs: CS, res: PDict): VFill | null {
    const f = this.f;
    const pr = f.get(f.get(res.Pattern)?.[nm.n]);
    const col = cs.base ? colorHex(cs.base, comps) ?? '#000000' : '#000000';
    const key = nm.n + '|' + col;
    if (this.patCache.has(key)) return this.patCache.get(key)!;
    let r: VFill | null = null;
    if (pr instanceof PStream && f.get(pr.dict.PatternType) === 1) {
      const d = pr.dict; const m: number[] = f.get(d.Matrix) ?? [1, 0, 0, 1, 0, 0];
      // Kachel in Papier-mm (OpenRiss: Kachelkoordinaten in mm, Matrix = mm → pt)
      const k = (Math.hypot(m[0], m[1]) * 25.4) / 72;
      const tile = emptyVec(); const data = f.decode(pr);
      if (data) { const it = new Interp(f, tile, I, this.hiddenOcg, 0.005, 2); it.run(data, f.get(d.Resources) ?? {}); }
      const sig = sigOf(tile).map((x) => ({ k: x.k, v: x.v.map((v) => v * k) }));
      const name = matchPattern(sig, Math.abs(f.get(d.XStep) ?? 1) * k, Math.abs(f.get(d.YStep) ?? 1) * k);
      const pc = f.get(d.PaintType) === 2 ? col : tile.paths.find((p) => p.stroke)?.stroke?.color ?? tile.paths[0]?.fill?.color ?? '#000000';
      r = { color: pc, pattern: name };
    } else if (pr) { r = { color: '#c0c0c0', pattern: 'solid' }; skip(this.out, 'Verlauf (als Grau)'); }
    this.patCache.set(key, r);
    return r;
  }
  private font(name: PName, res: PDict): PFont | null {
    const ref = this.f.get(res.Font)?.[name.n]; if (!ref) return null;
    const key = ref instanceof PRef ? ref.n : ref;
    let ft = this.fonts.get(key);
    if (!ft) { ft = loadFont(this.f, ref); this.fonts.set(key, ft); }
    return ft;
  }

  private paint(stroke: boolean, fill: boolean, close: boolean): void {
    if (close) this.pb.close();
    const subs = this.pb.take(); const g = this.gs;
    if (this.pendClip) {
      this.pendClip = false;
      const rings = subs.map((s) => subPoints(s, this.pb.tol)).filter((r) => r.length >= 3);
      const bb = emptyBox(); for (const r of rings) for (const q of r) extendBox(bb, q);
      if (boxValid(bb)) { g.clip = isect(g.clip, bb); if (!isRect(rings)) g.clipPolys = [...(g.clipPolys ?? []), rings]; }
      else g.clip = { min: { x: 0, y: 0 }, max: { x: -1, y: -1 } };
    }
    if ((!stroke && !fill) || !subs.length || this.hidden) return;
    const p: VPath = { subs, clip: g.clip, clipPolys: g.clipPolys, layer: this.layer };
    if (fill && g.fc) p.fill = g.fpat ?? { color: g.fc, pattern: 'solid' };
    if (stroke && g.sc) {
      const k = Math.sqrt(Math.abs(g.ctm.a * g.ctm.d - g.ctm.b * g.ctm.c));
      p.stroke = { color: g.sc, width: g.lw * k, dash: g.dash.length ? g.dash.map((v) => v * k) : undefined };
    }
    if (p.fill || p.stroke) this.out.paths.push(p);
  }

  private show(b: Uint8Array): void {
    const g = this.gs; const ft = g.font; if (!ft) return;
    const codes = ft.codes(b);
    const Trm = () => compose(g.ctm, compose(this.tm, { a: g.fs * g.th, b: 0, c: 0, d: g.fs, e: 0, f: g.ts }));
    const m0 = Trm(); let s = '';
    for (const c of codes) {
      s += c.u;
      const tx = (c.w * g.fs + g.tc + (c.sp ? g.tw : 0)) * g.th;
      this.tm = compose(this.tm, { a: 1, b: 0, c: 0, d: 1, e: tx, f: 0 });
    }
    if (g.tr === 3 || g.tr === 7) { if (s.trim()) skip(this.out, 'Unsichtbarer Text'); return; }
    if (this.hidden || !s) return;
    const m1 = Trm();
    // Schrifthöhe senkrecht zur Grundlinie (schräggestellte Schrift = kursiv)
    const xl = Math.hypot(m0.a, m0.b) || 1e-12; const size = Math.abs(m0.a * m0.d - m0.b * m0.c) / xl;
    if (!(size > 1e-4)) return;
    const shear = (m0.a * m0.c + m0.b * m0.d) / (xl * (Math.hypot(m0.c, m0.d) || 1e-12));
    const color = (g.tr === 1 || g.tr === 5 ? g.sc : g.fc) ?? '#000000';
    this.addRun({ p: { x: m0.e, y: m0.f }, e: { x: m1.e, y: m1.f }, s, size, rot: Math.atan2(m0.b, m0.a), color, bold: ft.bold, italic: ft.italic || shear > 0.1, font: ft.font, block: this.block, clip: g.clip, layer: this.layer });
  }
  private pend: Run | null = null;
  private addRun(r: Run): void {
    const q = this.pend;
    if (q && q.color === r.color && q.font === r.font && Math.abs(q.size - r.size) < q.size * 0.03 && Math.abs(q.rot - r.rot) < 1e-3 && q.layer === r.layer) {
      const dx = { x: Math.cos(q.rot), y: Math.sin(q.rot) }; const up = { x: -dx.y, y: dx.x };
      const v = { x: r.p.x - q.e.x, y: r.p.y - q.e.y };
      const along = v.x * dx.x + v.y * dx.y, perpd = v.x * up.x + v.y * up.y;
      if (Math.abs(perpd) < q.size * 0.2 && along > -q.size * 0.3 && along < q.size * 0.6) {
        if (along > q.size * 0.18 && !/\s$/.test(q.s) && !/^\s/.test(r.s)) q.s += ' ';
        q.s += r.s; q.e = r.e; return;
      }
    }
    if (q) this.runs.push(q);
    this.pend = r;
  }
  flushText(): void { if (this.pend) { this.runs.push(this.pend); this.pend = null; } }

  private op(op: string, o: any[], res: PDict, depth: number): void {
    const g = this.gs; const pb = this.pb; const n = (i: number) => (typeof o[i] === 'number' ? o[i] : 0);
    switch (op) {
      // Pfade
      case 'm': pb.move(this.P(n(0), n(1))); break;
      case 'l': pb.line(this.P(n(0), n(1))); break;
      case 'c': pb.cubic(this.P(n(0), n(1)), this.P(n(2), n(3)), this.P(n(4), n(5))); break;
      case 'v': { const p0 = pb.last; if (!p0) break; pb.cubic(p0, this.P(n(0), n(1)), this.P(n(2), n(3))); break; }
      case 'y': { const p3 = this.P(n(2), n(3)); pb.cubic(this.P(n(0), n(1)), p3, p3); break; }
      case 'h': pb.close(); break;
      case 're': {
        const x = n(0), y = n(1), w = n(2), h = n(3);
        pb.move(this.P(x, y)); pb.line(this.P(x + w, y)); pb.line(this.P(x + w, y + h)); pb.line(this.P(x, y + h)); pb.close();
        break;
      }
      case 'S': this.paint(true, false, false); break;
      case 's': this.paint(true, false, true); break;
      case 'f': case 'F': case 'f*': this.paint(false, true, false); break;
      case 'B': case 'B*': this.paint(true, true, false); break;
      case 'b': case 'b*': this.paint(true, true, true); break;
      case 'n': this.paint(false, false, false); break;
      case 'W': case 'W*': this.pendClip = true; break;
      // Zustand
      case 'q': this.stack.push({ ...g }); if (this.stack.length > 256) this.stack.shift(); break;
      case 'Q': { const p = this.stack.pop(); if (p) this.gs = p; break; }
      case 'cm': g.ctm = compose(g.ctm, { a: n(0), b: n(1), c: n(2), d: n(3), e: n(4), f: n(5) }); break;
      case 'w': g.lw = n(0); break;
      case 'd': g.dash = Array.isArray(o[0]) ? o[0].filter((x: any) => typeof x === 'number') : []; break;
      case 'gs': {
        const e = this.f.get(this.f.get(res.ExtGState)?.[(o[0] as PName)?.n]); if (!e) break;
        if (typeof e.LW === 'number') g.lw = e.LW;
        const D = this.f.get(e.D); if (Array.isArray(D) && Array.isArray(D[0])) g.dash = D[0].filter((x: any) => typeof x === 'number');
        if (e.Font && Array.isArray(e.Font)) { const fr = e.Font[0]; const key = fr instanceof PRef ? fr.n : fr; let ft = this.fonts.get(key); if (!ft) { ft = loadFont(this.f, fr); this.fonts.set(key, ft); } g.font = ft; g.fs = e.Font[1] ?? g.fs; }
        break;
      }
      // Farben
      case 'G': g.scs = GRAY; g.sc = colorHex(GRAY, [n(0)]); g.spat = false; break;
      case 'g': g.fcs = GRAY; g.fc = colorHex(GRAY, [n(0)]); g.fpat = null; break;
      case 'RG': g.scs = RGB; g.sc = colorHex(RGB, [n(0), n(1), n(2)]); g.spat = false; break;
      case 'rg': g.fcs = RGB; g.fc = colorHex(RGB, [n(0), n(1), n(2)]); g.fpat = null; break;
      case 'K': g.scs = CMYK; g.sc = colorHex(CMYK, [n(0), n(1), n(2), n(3)]); g.spat = false; break;
      case 'k': g.fcs = CMYK; g.fc = colorHex(CMYK, [n(0), n(1), n(2), n(3)]); g.fpat = null; break;
      case 'CS': g.scs = this.cs(o[0], res); g.sc = g.scs.k === 'pat' ? '#000000' : colorHex(g.scs, this.initColor(g.scs)); break;
      case 'cs': g.fcs = this.cs(o[0], res); g.fc = g.fcs.k === 'pat' ? '#000000' : colorHex(g.fcs, this.initColor(g.fcs)); g.fpat = null; break;
      case 'SC': case 'SCN': this.setColor(true, o, res); break;
      case 'sc': case 'scn': this.setColor(false, o, res); break;
      // XObjekte, Schattierungen
      case 'Do': {
        const nm = o[0] as PName; const ref = this.f.get(res.XObject)?.[nm?.n];
        const x = this.f.get(ref);
        if (!(x instanceof PStream)) break;
        const st = (this.f.get(x.dict.Subtype) as PName)?.n;
        if (st === 'Image') { if (!this.hidden) skip(this.out, 'Bild'); break; }
        if (st !== 'Form' || depth >= this.depthLimit || this.forms.has(ref)) break;
        const data = this.f.decode(x); if (!data) break;
        const m: number[] = this.f.get(x.dict.Matrix) ?? [1, 0, 0, 1, 0, 0];
        this.stack.push({ ...g });
        const oc = this.ocLayer(x.dict.OC);
        if (oc) this.mc.push(oc);
        g.ctm = compose(g.ctm, { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
        const bb: number[] | undefined = this.f.get(x.dict.BBox);
        if (Array.isArray(bb) && bb.length === 4) {
          const ring = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([px, py]) => this.P(px, py));
          const b2 = emptyBox(); for (const q of ring) extendBox(b2, q);
          g.clip = isect(g.clip, b2);
          if (!isRect([ring])) g.clipPolys = [...(g.clipPolys ?? []), [ring]];
        }
        this.forms.add(ref);
        try { this.run(data, this.f.get(x.dict.Resources) ?? res, depth + 1); } finally { this.forms.delete(ref); }
        if (oc) this.mc.pop();
        const p = this.stack.pop(); if (p) this.gs = p;
        break;
      }
      case 'sh': if (!this.hidden) skip(this.out, 'Verlauf'); break;
      // Markierte Inhalte (optionale Inhalte = Ebenen)
      case 'BMC': this.mc.push({ hidden: false }); break;
      case 'BDC': {
        const tag = (o[0] as PName)?.n; let e: { layer?: string; hidden: boolean } = { hidden: false };
        if (tag === 'OC') { const pr = o[1] instanceof PName ? this.f.get(res.Properties)?.[o[1].n] : o[1]; e = this.ocLayer(pr) ?? e; }
        this.mc.push(e); break;
      }
      case 'EMC': this.mc.pop(); break;
      // Text
      case 'BT': this.tm = I; this.tlm = I; this.block++; break;
      case 'ET': break;
      case 'Tf': g.font = o[0] instanceof PName ? this.font(o[0], res) : null; g.fs = n(1); break;
      case 'Tc': g.tc = n(0); break;
      case 'Tw': g.tw = n(0); break;
      case 'Tz': g.th = n(0) / 100; break;
      case 'TL': g.tl = n(0); break;
      case 'Ts': g.ts = n(0); break;
      case 'Tr': g.tr = n(0); break;
      case 'Td': this.tlm = compose(this.tlm, { a: 1, b: 0, c: 0, d: 1, e: n(0), f: n(1) }); this.tm = this.tlm; break;
      case 'TD': g.tl = -n(1); this.tlm = compose(this.tlm, { a: 1, b: 0, c: 0, d: 1, e: n(0), f: n(1) }); this.tm = this.tlm; break;
      case 'Tm': this.tlm = { a: n(0), b: n(1), c: n(2), d: n(3), e: n(4), f: n(5) }; this.tm = this.tlm; break;
      case 'T*': this.tlm = compose(this.tlm, { a: 1, b: 0, c: 0, d: 1, e: 0, f: -g.tl }); this.tm = this.tlm; break;
      case 'Tj': if (o[0] instanceof PStr) this.show(o[0].b); break;
      case "'": this.op('T*', [], res, depth); if (o[0] instanceof PStr) this.show(o[0].b); break;
      case '"': g.tw = n(0); g.tc = n(1); this.op('T*', [], res, depth); if (o[2] instanceof PStr) this.show(o[2].b); break;
      case 'TJ': {
        if (!Array.isArray(o[0])) break;
        let gap = false;
        for (const x of o[0]) {
          if (x instanceof PStr) {
            if (gap) { const pr = this.pend; if (pr && !/\s$/.test(pr.s)) pr.s += ' '; gap = false; }
            this.show(x.b);
          } else if (typeof x === 'number') {
            const tx = (-x / 1000) * g.fs * g.th;
            this.tm = compose(this.tm, { a: 1, b: 0, c: 0, d: 1, e: tx, f: 0 });
            if (-x > 200) gap = true;
          }
        }
        break;
      }
      default: break;
    }
  }
  private ocLayer(x: any): { layer?: string; hidden: boolean } | null {
    const f = this.f; const d = f.get(x); if (!d || typeof d !== 'object') return null;
    const ocgs = (f.get(d.Type) as PName)?.n === 'OCMD' ? [].concat(f.get(d.OCGs) ?? []) : [x];
    let layer: string | undefined; let hidden = ocgs.length > 0;
    for (const r of ocgs) {
      const g = f.get(r); if (!g) continue;
      layer ??= textStr(f.get(g.Name));
      if (!(r instanceof PRef && this.hiddenOcg.has((r as PRef).n))) hidden = false;
    }
    if (layer && !this.out.layers.includes(layer)) this.out.layers.push(layer);
    return { layer, hidden };
  }
}

// ------------------------------------------------------------ Texte zusammensetzen (Zeilen → mehrzeiliger Text)
function runsToTexts(runs: Run[], out: VText[]): void {
  const single = (r: Run): VText => ({ p: r.p, s: r.s, size: r.size, rot: r.rot, color: r.color, bold: r.bold || undefined, italic: r.italic || undefined, font: r.font, clip: r.clip, layer: r.layer });
  let i = 0;
  while (i < runs.length) {
    const r0 = runs[i]; const grp = [r0];
    const dx = { x: Math.cos(r0.rot), y: Math.sin(r0.rot) }; const up = { x: -dx.y, y: dx.x };
    const along = (p: V2) => p.x * dx.x + p.y * dx.y; const across = (p: V2) => p.x * up.x + p.y * up.y;
    let al: HAl | null = null;
    for (let j = i + 1; j < runs.length; j++) {
      const r = runs[j]; const q = grp[grp.length - 1];
      if (r.block !== r0.block || r.color !== r0.color || r.font !== r0.font || Math.abs(r.size - r0.size) > r0.size * 0.03 || Math.abs(r.rot - r0.rot) > 1e-3 || r.layer !== r0.layer || r.bold !== r0.bold) break;
      const lh = across(q.p) - across(r.p);
      if (lh < r0.size * 1.1 || lh > r0.size * 1.4) break;
      const t = r0.size * 0.12;
      const L = Math.abs(along(r.p) - along(q.p)) < t, C = Math.abs((along(r.p) + along(r.e)) / 2 - (along(q.p) + along(q.e)) / 2) < t, R = Math.abs(along(r.e) - along(q.e)) < t;
      const a: HAl | null = al ? ((al === 'left' && L) || (al === 'center' && C) || (al === 'right' && R) ? al : null) : L ? 'left' : C ? 'center' : R ? 'right' : null;
      if (!a) break;
      al = a; grp.push(r);
    }
    if (grp.length === 1) out.push(single(r0));
    else {
      const t = single(r0);
      t.s = grp.map((r) => r.s.replace(/\s+$/, '')).join('\n');
      t.ha = al ?? 'left';
      if (t.ha === 'center') t.p = { x: (r0.p.x + r0.e.x) / 2, y: (r0.p.y + r0.e.y) / 2 };
      else if (t.ha === 'right') t.p = r0.e;
      out.push(t);
    }
    i += grp.length;
  }
}

// ------------------------------------------------------------ Einstieg
/** PDF-Seite (page ab 1) → Zwischenformat in Papier-mm (y nach oben, Ursprung links unten) */
export function parsePdf(bytes: Uint8Array, o: { page?: number; tol?: number } = {}): VecData {
  const f = new PdfFile(bytes);
  const cat = f.get(f.trailer.Root) ?? {};
  // Seiten (mit vererbten Eigenschaften)
  const pages: { d: PDict; res: PDict; box: number[]; rot: number }[] = [];
  const walk = (x: any, inh: { res?: PDict; box?: number[]; crop?: number[]; rot?: number }, depth: number) => {
    const d = f.get(x); if (!d || depth > 64) return;
    const res = f.get(d.Resources) ?? inh.res; const mb = f.get(d.MediaBox) ?? inh.box; const cb = f.get(d.CropBox) ?? inh.crop; const rot = f.get(d.Rotate) ?? inh.rot;
    const kids = f.get(d.Kids);
    if (Array.isArray(kids)) { for (const k of kids) walk(k, { res, box: mb, crop: cb, rot }, depth + 1); return; }
    const box = (Array.isArray(cb) ? cb : mb ?? [0, 0, 595, 842]).map((v: any) => f.get(v));
    pages.push({ d, res: res ?? {}, box, rot: rot ?? 0 });
  };
  walk(cat.Pages, {}, 0);
  if (!pages.length) throw new Error('PDF: keine Seiten gefunden');
  const pi = Math.max(1, Math.min(pages.length, o.page ?? 1)) - 1; const pg = pages[pi];
  const out = emptyVec(); out.pages = pages.length;
  const K = 25.4 / 72;
  const [x0, y0, x1, y1] = [Math.min(pg.box[0], pg.box[2]), Math.min(pg.box[1], pg.box[3]), Math.max(pg.box[0], pg.box[2]), Math.max(pg.box[1], pg.box[3])];
  const W = (x1 - x0) * K, H = (y1 - y0) * K;
  let base: Mat2 = { a: K, b: 0, c: 0, d: K, e: -x0 * K, f: -y0 * K };
  const rot = ((Math.round(pg.rot / 90) * 90) % 360 + 360) % 360;
  if (rot === 90) base = compose({ a: 0, b: -1, c: 1, d: 0, e: 0, f: W }, base);
  else if (rot === 180) base = compose({ a: -1, b: 0, c: 0, d: -1, e: W, f: H }, base);
  else if (rot === 270) base = compose({ a: 0, b: 1, c: -1, d: 0, e: H, f: 0 }, base);
  out.w = rot % 180 ? H : W; out.h = rot % 180 ? W : H;
  // ausgeblendete Ebenen
  const hidden = new Set<number>();
  const ocp = f.get(cat.OCProperties);
  for (const r of f.get(f.get(ocp?.D)?.OFF) ?? []) if (r instanceof PRef) hidden.add(r.n);
  for (const r of f.get(ocp?.OCGs) ?? []) { const g = f.get(r); const nm = g ? textStr(f.get(g.Name)) : ''; if (nm && !out.layers.includes(nm)) out.layers.push(nm); }
  // Inhalt
  const cs = f.get(pg.d.Contents); const parts: Uint8Array[] = [];
  for (const c of Array.isArray(cs) ? cs : cs ? [cs] : []) { const s = f.get(c); if (s instanceof PStream) { const d = f.decode(s); if (d) parts.push(d); } }
  let total = 0; for (const p of parts) total += p.length + 1;
  const content = new Uint8Array(total); let off = 0;
  for (const p of parts) { content.set(p, off); off += p.length; content[off++] = 10; }
  const it = new Interp(f, out, base, hidden, o.tol ?? 0.05);
  it.run(content, pg.res);
  it.flushText();
  runsToTexts(it.runs, out.texts);
  return out;
}
/** Anzahl Seiten einer PDF-Datei */
export function pdfPageCount(bytes: Uint8Array): number {
  const f = new PdfFile(bytes);
  const cnt = f.get(f.get(f.get(f.trailer.Root)?.Pages)?.Count);
  return typeof cnt === 'number' ? cnt : 1;
}
