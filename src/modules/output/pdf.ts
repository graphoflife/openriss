// PDF-Export ohne Druckdialog: Display-Liste → Vektor-PDF (mehrseitig, exakter Maßstab, Schrift eingebettet).
// DOM-frei, läuft im Browser und in Node (CLI). Papier-mm: 1 mm = 72/25,4 pt.
//
// Unterstützt: Linien, Polylinien, Füllungen (gerade-ungerade), Bögen/Kreise (Bézier), Strichmuster,
// exakte Stiftbreiten, Zuschneidebereiche, Halbton, Deckkraft, Füllmuster (PDF-Kachelmuster, gleiche Kacheln
// wie PATTERNS), Text (Drehung, Ausrichtung, mehrzeilig, fett, kursiv = schräggestellt, unterstrichen,
// undurchsichtiger Hintergrund, Rahmen), Bilder (JPEG direkt, PNG dekodiert inkl. Transparenz).
// Schrift: Liberation Sans Regular/Bold (OFL), als Teilmenge eingebettet (Type0/Identity-H mit ToUnicode,
// Text bleibt durchsuchbar). Zeichen ohne Glyphe: siehe layoutLine() in pdfFont.ts.
import { zlibSync, unzlibSync } from 'fflate';
import type { Doc, Id } from '../../core/doc';
import type { View } from '../../core/view';
import type { Font, Prim } from '../../render/displayList';
import { PATTERNS, DASHES, penMm, Fill, Pen, TileCtx } from '../../render/styles';
import type { V2 } from '../../core/geom';
import { hasDom } from '../../core/env';
import { Page, pageOf } from './common';
import { TtfFont, parseTtf, layoutLine, subsetTtf } from './pdfFont';
import { PdfImage, decodeImage } from './pdfImage';

export interface PdfOpts {
  /** Linien/Text schwarz, Flächen in Graustufen */
  monochrome?: boolean;
  /** Dokumenttitel (Metadaten) */
  title?: string;
  /** Ersatzbilder für nicht unterstützte Formate (Daten-URL → PNG/JPEG-Daten-URL) */
  images?: Map<string, string>;
}

const K = 72 / 25.4; // pt je mm
const ITALIC = Math.tan((12 * Math.PI) / 180);

// ------------------------------------------------------------ Schriften
let FONTS: TtfFont[] | null = null;
let loading: Promise<void> | null = null;

/** Eigene TrueType-Schriften setzen (Normal, Fett) – z.B. aus einer Datei gelesen */
export function setPdfFonts(regular: Uint8Array, bold: Uint8Array = regular): void {
  const r = parseTtf(regular, 'Sans');
  FONTS = [r, bold === regular ? r : parseTtf(bold, 'Sans-Bold')];
}
export const pdfFontsLoaded = (): boolean => !!FONTS;

/** Lädt die eingebetteten Schriften (Liberation Sans) – im Browser als eigener Code-Teil */
export function loadPdfFonts(): Promise<void> {
  if (FONTS) return Promise.resolve();
  if (!loading) {
    loading = import('./fonts/liberationSans').then((m) => setPdfFonts(unpack(m.REGULAR), unpack(m.BOLD)));
    loading.catch(() => { loading = null; });
  }
  return loading;
}
function unpack(b64: string): Uint8Array {
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return unzlibSync(u);
}

// ------------------------------------------------------------ Einstieg
/** Druckseiten der Ansichten (Pläne in Papiergröße, übrige 2D-Ansichten im Ansichtsmaßstab) */
export function pdfPages(doc: Doc, viewIds: Id[]): Page[] {
  const pages: Page[] = [];
  for (const id of viewIds) {
    const v = doc.get(id) as View | undefined;
    if (!v || v.cat !== 'view') { console.warn('PDF: keine Ansicht', id); continue; }
    const p = pageOf(doc, v);
    if (p) pages.push(p); else console.warn('PDF: Ansicht nicht druckbar', v.name);
  }
  if (!pages.length) throw new Error('PDF: keine druckbaren Pläne oder Ansichten');
  return pages;
}

/** Pläne/Ansichten als ein PDF (je Ansicht eine Seite). Schriften müssen geladen sein (loadPdfFonts). */
export function sheetsToPdf(doc: Doc, viewIds: Id[], opts: PdfOpts = {}): Uint8Array {
  return pagesToPdf(pdfPages(doc, viewIds), opts);
}

/** Wie sheetsToPdf, lädt vorher die Schriften; im Browser werden GIF/WebP/SVG-Bilder über ein Canvas umgewandelt. */
export async function sheetsToPdfAsync(doc: Doc, viewIds: Id[], opts: PdfOpts = {}): Promise<Uint8Array> {
  await loadPdfFonts();
  const pages = pdfPages(doc, viewIds);
  if (hasDom) {
    const images = new Map(opts.images ?? []);
    for (const p of pages) for (const it of p.dl.items) {
      if (it.k !== 'image' || images.has(it.src) || /^data:image\/(png|jpe?g)[;,]/i.test(it.src)) continue;
      const r = await rasterize(it.src); if (r) images.set(it.src, r);
    }
    opts = { ...opts, images };
  }
  return pagesToPdf(pages, opts);
}

async function rasterize(src: string): Promise<string | null> {
  try {
    const im = new Image(); im.src = src; await im.decode();
    const c = document.createElement('canvas');
    c.width = im.naturalWidth || 1024; c.height = im.naturalHeight || 1024;
    c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch { return null; }
}

/** Seiten (siehe pageOf) als PDF */
export function pagesToPdf(pages: Page[], opts: PdfOpts = {}): Uint8Array {
  if (!FONTS) throw new Error('PDF: Schriften nicht geladen – vorher „await loadPdfFonts()“ aufrufen oder sheetsToPdfAsync verwenden.');
  const w = new Writer();
  const res = new Resources(w, FONTS, opts);
  const catalog = w.alloc(), pagesId = w.alloc(), resId = w.alloc(), outl = w.alloc(), info = w.alloc();
  const ids: number[] = [];
  for (const p of pages) {
    const content = new Painter(res, p).run();
    const cid = w.alloc(); w.stream(cid, '', enc(content));
    const pid = w.alloc();
    w.obj(pid, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(p.w * K)} ${n(p.h * K)}] /Resources ${resId} 0 R /Contents ${cid} 0 R >>`);
    ids.push(pid);
  }
  res.write(resId);
  // Lesezeichen je Seite
  const items = pages.map(() => w.alloc());
  pages.forEach((p, i) => {
    const t = p.view.kind === 'sheet' ? `${p.view.sheetNo ?? ''} - ${p.view.name}` : p.view.name;
    w.obj(items[i], `<< /Title ${pdfStr(t)} /Parent ${outl} 0 R${i ? ` /Prev ${items[i - 1]} 0 R` : ''}${i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : ''} /Dest [${ids[i]} 0 R /Fit] >>`);
  });
  w.obj(outl, `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`);
  w.obj(pagesId, `<< /Type /Pages /Kids [${ids.map((i) => i + ' 0 R').join(' ')}] /Count ${ids.length} >>`);
  w.obj(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outl} 0 R /PageMode /UseOutlines >>`);
  const d = new Date(); const z = (v: number) => String(v).padStart(2, '0');
  const date = `D:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  w.obj(info, `<< /Title ${pdfStr(opts.title ?? 'OpenRiss')} /Producer (OpenRiss) /Creator (OpenRiss) /CreationDate (${date}) >>`);
  return w.finish(catalog, info);
}

// ------------------------------------------------------------ Hilfen
const encoder = new TextEncoder();
const enc = (s: string): Uint8Array => encoder.encode(s);
/** Zahl mit höchstens 3 Nachkommastellen (µm-genau in Papier-mm) */
function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 || !Number.isFinite(r) ? '0' : String(r);
}
/** Text als PDF-String (UTF-16BE, hex) */
function pdfStr(s: string): string {
  let h = '<FEFF';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0');
  return h + '>';
}
const hex4 = (g: number) => g.toString(16).padStart(4, '0');

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
  yellow: '#ffff00', orange: '#ffa500', magenta: '#ff00ff', cyan: '#00ffff', silver: '#c0c0c0', brown: '#a52a2a',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
};
/** Farbe → [r,g,b] 0..1; null = keine Farbe */
export function parseColor(c: string): [number, number, number] | null {
  let s = c.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  s = NAMED[s] ?? s;
  const m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]; if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    if (h.length === 8 && h.slice(6) === '00') return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  const r = /^rgba?\(([^)]*)\)$/.exec(s);
  if (r) {
    const p = r[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)));
    if (p.length > 3 && parseFloat(r[1].split(/[\s,/]+/).filter(Boolean)[3]) === 0) return null;
    return [p[0] / 255 || 0, p[1] / 255 || 0, p[2] / 255 || 0];
  }
  return [0, 0, 0];
}

// ------------------------------------------------------------ PDF-Datei
class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;
  private offs: number[] = [];
  private count = 0;
  constructor() { this.put(enc('%PDF-1.7\n')); this.put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); }
  private put(b: Uint8Array): void { this.parts.push(b); this.len += b.length; }
  alloc(): number { return ++this.count; }
  obj(id: number, body: string): void { this.offs[id] = this.len; this.put(enc(`${id} 0 obj\n${body}\nendobj\n`)); }
  /** Datenstrom; dict ohne << >>; ohne filter wird mit Flate komprimiert */
  stream(id: number, dict: string, data: Uint8Array, filter?: string): void {
    const d = filter ? data : zlibSync(data, { level: 6 });
    this.offs[id] = this.len;
    this.put(enc(`${id} 0 obj\n<< ${dict} /Filter /${filter ?? 'FlateDecode'} /Length ${d.length} >>\nstream\n`));
    this.put(d); this.put(enc('\nendstream\nendobj\n'));
  }
  finish(root: number, info: number): Uint8Array {
    const xref = this.len;
    const rows = [`xref\n0 ${this.count + 1}\n0000000000 65535 f \n`];
    for (let i = 1; i <= this.count; i++) rows.push(this.offs[i] === undefined ? '0000000000 00001 f \n' : String(this.offs[i]).padStart(10, '0') + ' 00000 n \n');
    let id = ''; for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    rows.push(`trailer\n<< /Size ${this.count + 1} /Root ${root} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    this.put(enc(rows.join('')));
    const out = new Uint8Array(this.len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

// ------------------------------------------------------------ Gemeinsame Ressourcen (Schriften, Muster, Bilder, Deckkraft)
class Resources {
  used: Map<number, string>[];
  private pats = new Map<string, string>();
  private imgs = new Map<string, { name: string; img: PdfImage } | null>();
  private gs = new Map<string, string>();
  constructor(private w: Writer, readonly fonts: TtfFont[], readonly opts: PdfOpts) { this.used = fonts.map(() => new Map()); }

  glyph(fi: number, gid: number, u: string): void { if (!this.used[fi].has(gid)) this.used[fi].set(gid, u); }
  pattern(name: string): string {
    let r = this.pats.get(name);
    if (!r) { r = 'P' + this.pats.size; this.pats.set(name, r); }
    return r;
  }
  alpha(a: number): string {
    const k = n(a); let r = this.gs.get(k);
    if (!r) { r = 'G' + this.gs.size; this.gs.set(k, r); }
    return r;
  }
  /** Bild-XObject; null = nicht darstellbar */
  image(src: string): string | null {
    if (!this.imgs.has(src)) {
      const img = decodeImage(this.opts.images?.get(src) ?? src);
      this.imgs.set(src, img ? { name: 'I' + this.imgs.size, img } : null);
    }
    return this.imgs.get(src)?.name ?? null;
  }

  write(resId: number): void {
    const w = this.w;
    const fonts = this.fonts.map((f, i) => (this.used[i].size ? `/F${i} ${this.font(f, this.used[i])} 0 R` : '')).join(' ');
    const pats: string[] = [];
    for (const [name, r] of this.pats) {
      const def = PATTERNS[name]; const id = w.alloc(); const ops: string[] = [];
      const t: TileCtx = {
        line: (x1, y1, x2, y2, lw) => ops.push(`${n(lw ? lw * 0.18 : 0.09)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`),
        dot: (x, y, rr) => ops.push(circlePath(x, y, rr) + ' f'),
        tri: (x1, y1, x2, y2, x3, y3) => ops.push(`0.09 w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l ${n(x3)} ${n(y3)} l h S`),
      };
      def.draw(t);
      w.stream(id, `/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 ${n(def.w)} ${n(def.h)}] /XStep ${n(def.w)} /YStep ${n(def.h)} /Matrix [${K} 0 0 ${K} 0 0] /Resources << >>`, enc(ops.join('\n')));
      pats.push(`/${r} ${id} 0 R`);
    }
    const imgs: string[] = [];
    for (const v of this.imgs.values()) {
      if (!v) continue;
      const { img } = v; const id = w.alloc();
      let smask = '';
      if (img.alpha) {
        const sid = w.alloc(); smask = ` /SMask ${sid} 0 R`;
        w.stream(sid, `/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8`, img.alpha);
      }
      const dict = `/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.cs} /BitsPerComponent 8${img.decode ? ` /Decode [${img.decode.join(' ')}]` : ''}${smask}`;
      if (img.filter === 'DCTDecode') w.stream(id, dict, img.data, 'DCTDecode'); else w.stream(id, dict, img.data);
      imgs.push(`/${v.name} ${id} 0 R`);
    }
    const gs = [...this.gs].map(([a, r]) => `/${r} << /Type /ExtGState /ca ${a} >>`);
    w.obj(resId, `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fonts} >> /Pattern << ${pats.join(' ')} >> /XObject << ${imgs.join(' ')} >> /ExtGState << ${gs.join(' ')} >> /ColorSpace << /CsP [/Pattern /DeviceRGB] >> >>`);
  }

  /** Type0-Schrift (Identity-H) mit eingebetteter TrueType-Teilmenge */
  private font(f: TtfFont, used: Map<number, string>): number {
    const w = this.w;
    const gids = [...used.keys()].sort((a, b) => a - b);
    let hsh = 0; for (const g of gids) hsh = (hsh * 31 + g) >>> 0;
    let tag = ''; for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (hsh % 26)); hsh = Math.floor(hsh / 26) + i * 7; }
    const base = `${tag}+${f.name}`;
    const file = w.alloc(); const ttf = subsetTtf(f, gids);
    w.stream(file, `/Length1 ${ttf.length}`, ttf);
    const desc = w.alloc();
    w.obj(desc, `<< /Type /FontDescriptor /FontName /${base} /Flags 32 /FontBBox [${f.bbox.join(' ')}] /ItalicAngle ${n(f.italicAngle)} /Ascent ${n(f.ascent)} /Descent ${n(f.descent)} /CapHeight ${n(f.capHeight)} /StemV 80 /FontFile2 ${file} 0 R >>`);
    const cid = w.alloc();
    w.obj(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${gids.map((g) => `${g} [${f.adv[g]}]`).join(' ')}] /CIDToGIDMap /Identity >>`);
    // ToUnicode für Suchen/Kopieren
    const tu = w.alloc(); const rows: string[] = [];
    for (let i = 0; i < gids.length; i += 100) {
      const part = gids.slice(i, i + 100);
      rows.push(`${part.length} beginbfchar`);
      for (const g of part) { let u = ''; const s = used.get(g)!; for (let j = 0; j < s.length; j++) u += hex4(s.charCodeAt(j)); rows.push(`<${hex4(g)}> <${u}>`); }
      rows.push('endbfchar');
    }
    w.stream(tu, '', enc(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${rows.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`));
    const id = w.alloc();
    w.obj(id, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
    return id;
  }
}

/** Kreis als vier Bézierkurven (Pfad, nicht gezeichnet) */
function circlePath(cx: number, cy: number, r: number): string {
  const k = r * 0.5522847498;
  return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ` +
    `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ` +
    `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ` +
    `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`;
}

// ------------------------------------------------------------ Seite zeichnen
interface GState { lw: string; dash: string; sc: string; fc: string; ga: string }

class Painter {
  private out: string[] = [];
  private st: GState = { lw: '', dash: '', sc: '', fc: '', ga: '1' };
  /** offener Linienpfad (gleicher Stift) */
  private pend = '';
  private clipSnap: GState | null = null;
  private colCache = new Map<string, string | null>();
  private readonly a: number; private readonly b: number; private readonly c: number;
  private readonly d: number; private readonly e: number; private readonly f: number;

  constructor(private r: Resources, private page: Page) {
    const x = page.xf;
    // Ansichts-mm → Papier-mm mit y nach oben
    this.a = x.a; this.b = -x.b; this.c = x.c; this.d = -x.d; this.e = x.e; this.f = page.h - x.f;
  }
  private X(p: V2): number { return this.a * p.x + this.c * p.y + this.e; }
  private Y(p: V2): number { return this.b * p.x + this.d * p.y + this.f; }
  private P(p: V2): string { return n(this.a * p.x + this.c * p.y + this.e) + ' ' + n(this.b * p.x + this.d * p.y + this.f); }

  run(): string {
    this.out.push(`${K} 0 0 ${K} 0 0 cm 0 J 0 j 4 M`);
    for (const it of this.page.dl.items) {
      if (it.sel || it.inv) continue;
      this.prim(it);
    }
    this.flush();
    if (this.clipSnap) this.out.push('Q');
    return this.out.join('\n');
  }

  private prim(it: Prim): void {
    const o = this.out;
    switch (it.k) {
      case 'clip':
        this.flush();
        if (this.clipSnap) { o.push('Q'); this.st = this.clipSnap; this.clipSnap = null; }
        if (it.rings) { this.clipSnap = { ...this.st }; o.push('q', this.rings(it.rings) + ' W* n'); }
        break;
      case 'line': this.stroke(it.pen, it.ht, this.P(it.a) + ' m ' + this.P(it.b) + ' l'); break;
      case 'poly': {
        if (it.pts.length < 2) break;
        let s = this.P(it.pts[0]) + ' m';
        for (let i = 1; i < it.pts.length; i++) s += ' ' + this.P(it.pts[i]) + ' l';
        this.stroke(it.pen, it.ht, it.closed ? s + ' h' : s);
        break;
      }
      case 'fill': {
        const path = this.rings(it.rings);
        this.fill(it.fill, it.ht, path);
        if (it.pen) this.stroke(it.pen, it.ht, path);
        break;
      }
      case 'arc': {
        let sw = it.a1 - it.a0; while (sw < 0) sw += Math.PI * 2;
        if (sw > 1e-9) this.stroke(it.pen, it.ht, this.arcPath(it.c, it.r, it.a0, sw));
        break;
      }
      case 'circle': {
        if (!(it.r > 0)) break;
        const path = this.arcPath(it.c, it.r, 0, Math.PI * 2) + ' h';
        if (it.fill) this.fill(it.fill, it.ht, path);
        if (it.pen) this.stroke(it.pen, it.ht, path);
        break;
      }
      case 'text': this.text(it.p, it.s, it.font, it.ht); break;
      case 'image': this.image(it); break;
    }
  }

  // ---------------------------------------------------------- Zustand
  private col(c: string | undefined, ht: boolean | undefined, line: boolean): string | null {
    const key = (c ?? '') + (ht ? '|h' : '|') + (line ? 'l' : 'f');
    if (this.colCache.has(key)) return this.colCache.get(key)!;
    let v = parseColor(c ?? '#000000');
    if (v && this.r.opts.monochrome && !(v[0] === 1 && v[1] === 1 && v[2] === 1)) {
      const g = line ? 0 : 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]; v = [g, g, g];
    }
    if (v && ht) v = v.map((x) => x * 0.4 + 0.6) as [number, number, number];
    const s = v ? `${n(v[0])} ${n(v[1])} ${n(v[2])}` : null;
    this.colCache.set(key, s);
    return s;
  }
  private setFill(c: string): void { if (this.st.fc !== c) { this.out.push(c + ' rg'); this.st.fc = c; } }
  private setAlpha(a: number): void {
    const k = n(Math.max(0, Math.min(1, a)));
    if (this.st.ga !== k) { this.out.push(`/${this.r.alpha(+k)} gs`); this.st.ga = k; }
  }
  private flush(): void { if (this.pend) { this.out.push('S'); this.pend = ''; } }

  /** Linienpfad zeichnen; aufeinanderfolgende Pfade mit gleichem Stift werden zusammengefasst */
  private stroke(pen: Pen, ht: boolean | undefined, path: string): void {
    const c = this.col(pen.color, ht, true); if (!c) return;
    const lw = n(penMm(pen.w)); const dash = `[${(DASHES[pen.dash ?? 'solid'] ?? []).join(' ')}] 0 d`;
    const key = lw + dash + c;
    if (key !== this.pend) {
      this.flush();
      if (this.st.lw !== lw) { this.out.push(lw + ' w'); this.st.lw = lw; }
      if (this.st.dash !== dash) { this.out.push(dash); this.st.dash = dash; }
      if (this.st.sc !== c) { this.out.push(c + ' RG'); this.st.sc = c; }
      this.pend = key;
    }
    this.out.push(path);
  }

  private fill(fill: Fill, ht: boolean | undefined, path: string): void {
    this.flush();
    const o = this.out;
    this.setAlpha(fill.alpha ?? 1);
    if (fill.pattern === 'solid') {
      const c = this.col(fill.patColor ?? fill.color, ht, false);
      if (c) { this.setFill(c); o.push(path + ' f*'); }
      return;
    }
    if (fill.color && fill.color !== 'none' && fill.color !== 'transparent') {
      const c = this.col(fill.color, ht, false);
      if (c) { this.setFill(c); o.push(path + ' f*'); }
    }
    const def = fill.pattern ? PATTERNS[fill.pattern] : undefined;
    if (def && !def.solid) {
      const c = this.col(fill.patColor, ht, true) ?? '0 0 0';
      o.push(`/CsP cs ${c} /${this.r.pattern(fill.pattern!)} scn`, path + ' f*');
      this.st.fc = '';
    }
  }

  private rings(rings: V2[][]): string {
    const s: string[] = [];
    for (const r of rings) {
      if (r.length < 2) continue;
      s.push(this.P(r[0]) + ' m');
      for (let i = 1; i < r.length; i++) s.push(this.P(r[i]) + ' l');
      s.push('h');
    }
    return s.join(' ');
  }

  /** Bogen (Ansichtskoordinaten, gegen Uhrzeigersinn ab a0 um sw) als Bézierkurven, danach abgebildet */
  private arcPath(c: V2, r: number, a0: number, sw: number): string {
    const segs = Math.max(1, Math.ceil(sw / (Math.PI / 2) - 1e-9)); const th = sw / segs;
    const k = (4 / 3) * Math.tan(th / 4) * r;
    let a = a0; let ca = Math.cos(a), sa = Math.sin(a);
    let s = this.P({ x: c.x + r * ca, y: c.y + r * sa }) + ' m';
    for (let i = 0; i < segs; i++) {
      const b = a + th; const cb = Math.cos(b), sb = Math.sin(b);
      s += ' ' + this.P({ x: c.x + r * ca - k * sa, y: c.y + r * sa + k * ca }) + ' ' + this.P({ x: c.x + r * cb + k * sb, y: c.y + r * sb - k * cb }) +
        ' ' + this.P({ x: c.x + r * cb, y: c.y + r * sb }) + ' c';
      a = b; ca = cb; sa = sb;
    }
    return s;
  }

  // ---------------------------------------------------------- Text
  private text(p: V2, s: string, f: Font, ht?: boolean): void {
    const size = f.size;
    if (!(size > 0) || !s) return;
    const col = this.col(f.color, ht, true); if (!col) return;
    this.flush();
    const fi = f.bold && this.r.fonts.length > 1 ? 1 : 0; const F = this.r.fonts[fi];
    const lines = s.split('\n').map((l) => layoutLine(F, l));
    // Schreibrichtung auf dem Papier (Text wird nie gespiegelt)
    const rot = f.rot ?? 0; const ux = Math.cos(rot), uy = Math.sin(rot);
    let dx = this.a * ux + this.c * uy, dy = this.b * ux + this.d * uy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const asc = (F.ascent / 1000) * size, dsc = (-F.descent / 1000) * size, lh = size * 1.25, nl = lines.length;
    const va = f.va ?? 'baseline';
    const b0 = va === 'top' ? -asc : va === 'middle' ? ((nl - 1) * lh) / 2 - (asc - dsc) / 2 : va === 'bottom' ? (nl - 1) * lh + dsc : 0;
    const xOf = (w: number) => (f.ha === 'center' ? -w / 2 : f.ha === 'right' ? -w : 0);
    const o = this.out;
    this.setAlpha(1);
    const snap = { ...this.st };
    o.push('q', `${n(dx)} ${n(dy)} ${n(-dy)} ${n(dx)} ${n(this.X(p))} ${n(this.Y(p))} cm`);
    if (f.opaque || f.box) {
      const wm = Math.max(...lines.map((l) => l.width)) * size; const x0 = xOf(wm);
      const top = b0 + size, bot = b0 - (nl - 1) * lh;
      if (f.opaque) o.push(`1 1 1 rg ${n(x0 - size * 0.2)} ${n(bot - size * 0.3)} ${n(wm + size * 0.4)} ${n(top - bot + size * 0.3)} re f`);
      if (f.box) o.push(`${col} RG 0.18 w [] 0 d ${n(x0 - size * 0.3)} ${n(bot - size * 0.4)} ${n(wm + size * 0.6)} ${n(top - bot + size * 0.5)} re S`);
    }
    o.push('BT', col + ' rg');
    const sh = f.italic ? n(ITALIC) : '0';
    let curSz = -1;
    lines.forEach((l, j) => {
      const by = b0 - j * lh; const x0 = xOf(l.width * size);
      const g = l.glyphs;
      for (let i = 0; i < g.length;) {
        let k = i; let hx = '';
        while (k < g.length && g[k].sz === g[i].sz && g[k].rise === g[i].rise) { hx += hex4(g[k].gid); this.r.glyph(fi, g[k].gid, g[k].u); k++; }
        const sz = g[i].sz * size;
        if (sz !== curSz) { o.push(`/F${fi} ${n(sz)} Tf`); curSz = sz; }
        o.push(`1 0 ${sh} 1 ${n(x0 + g[i].x * size)} ${n(by + g[i].rise * size)} Tm <${hx}> Tj`);
        i = k;
      }
    });
    o.push('ET');
    const deco: string[] = [];
    lines.forEach((l, j) => {
      const by = b0 - j * lh; const x0 = xOf(l.width * size);
      if (f.underline && l.width > 0) deco.push(`${n(x0)} ${n(by - size * 0.21)} ${n(l.width * size)} ${n(size * 0.06)} re f`);
      for (const r of l.rings) deco.push(circlePath(x0 + ((r.x0 + r.x1) / 2) * size, by + 0.358 * size, ((r.x1 - r.x0) / 2 - 0.03) * size) + ' S');
    });
    if (deco.length) o.push(`${col} RG ${n(size * 0.07)} w [] 0 d`, ...deco);
    o.push('Q');
    this.st = snap;
  }

  // ---------------------------------------------------------- Bild
  private image(it: Extract<Prim, { k: 'image' }>): void {
    this.flush();
    const cs = Math.cos(it.rot ?? 0), sn = Math.sin(it.rot ?? 0);
    const ox = this.X(it.p), oy = this.Y(it.p);
    const px = { x: it.p.x + it.w * cs, y: it.p.y + it.w * sn }, py = { x: it.p.x - it.h * sn, y: it.p.y + it.h * cs };
    const ex = [this.X(px) - ox, this.Y(px) - oy], ey = [this.X(py) - ox, this.Y(py) - oy];
    const name = this.r.image(it.src);
    const o = this.out;
    if (!name) {
      // Platzhalter: Rahmen mit Kreuz
      const snap = { ...this.st };
      o.push('q', `${n(ex[0])} ${n(ex[1])} ${n(ey[0])} ${n(ey[1])} ${n(ox)} ${n(oy)} cm`, '0.5 0.5 0.5 RG 0 w [] 0 d 0 0 1 1 re 0 0 m 1 1 l 0 1 m 1 0 l S', 'Q');
      this.st = snap;
      return;
    }
    this.setAlpha(it.ht ? 0.45 : it.alpha ?? 1);
    o.push(`q ${n(ex[0])} ${n(ex[1])} ${n(ey[0])} ${n(ey[1])} ${n(ox)} ${n(oy)} cm /${name} Do Q`);
  }
}
