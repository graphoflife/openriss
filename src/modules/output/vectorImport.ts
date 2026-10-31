// Vektorgrafik-Import (DXF/SVG/PDF) als bearbeitbare Detailelemente einer Ansicht:
// Striche → Detaillinien (Bögen bleiben Bögen) mit Linienstil-Typen je Farbe/Stift/Strichart (wiederverwendet),
// Füllungen → Füllbereiche (Typ je Farbe bzw. Muster, Weiss = Maskierung), Texte → Textnotizen (Typ je Höhe/Farbe).
// Gemeinsames Zwischenformat der Leser (svgParse, pdfParse, DXF) in «Datei-Einheiten» (SVG/PDF: Papier-mm, y nach oben).
// DOM-frei (Node/CLI und Browser).
import type { Doc, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import type { View, TypeEl } from '../../core/view';
import { typesOf } from '../../core/view';
import { V2, Mat2, BBox, I2, intersection, distToSeg, apply, applyVec, perp, fromAngle, signedArea, pointInRing, isMirror, matScale, emptyBox, extendBox, boxValid, boxOverlap, normAngle } from '../../core/geom';
import { PEN_MM, DASHES, DashName } from '../../render/styles';
import { textWidth } from '../../render/displayList';
import { findOrAddLineStyle, LINE_STYLES } from '../../elements/datums';
import { parseSvg } from './svgParse';
import { parsePdf } from './pdfParse';
import { parseDxf, decodeDxf, CadData, INSUNITS_MM } from './dxfParse';
import { cadToVec, CadImport } from './cadGeom';

// ------------------------------------------------------------ Zwischenformat
/** Kreisbogen zum Segmentende (Mittelpunkt, Radius, Drehsinn) */
export interface VArc { c: V2; r: number; ccw: boolean }
/** Segment bis p (gerade oder Kreisbogen) */
export interface VSeg { p: V2; arc?: VArc }
export interface VSub { p0: V2; segs: VSeg[]; closed: boolean }
/** Strich: Breite und Strichmuster in Papier-mm; dashName übersteuert das Muster */
export interface VStroke { color: string; width: number; dash?: number[]; dashName?: DashName }
/** Füllung: pattern = OpenRiss-Füllmuster ('solid' = Vollfüllung), bg = Hintergrundfarbe bei Mustern */
export interface VFill { color: string; pattern?: string; bg?: string }
/** clip: umschliessendes Rechteck des Zuschneidebereichs; clipPolys: nicht rechteckige Zuschneidebereiche (je Ringe, gerade-ungerade) */
export interface VPath { subs: VSub[]; stroke?: VStroke; fill?: VFill; layer?: string; clip?: BBox | null; clipPolys?: V2[][][] | null }
export type HAl = 'left' | 'center' | 'right';
export type VAl = 'baseline' | 'top' | 'middle' | 'bottom';
/** Text: p = Bezugspunkt nach ha/va, size = Schriftgrösse (Geviert) in Papier-mm, rot = Winkel der Grundlinie, font = Schriftname */
export interface VText { p: V2; s: string; size: number; rot: number; color: string; bold?: boolean; italic?: boolean; ha?: HAl; va?: VAl; font?: string; layer?: string; clip?: BBox | null }
export interface VecData {
  paths: VPath[]; texts: VText[];
  /** Seitengrösse (Datei-Einheiten; 0 = unbekannt) */
  w: number; h: number;
  layers: string[];
  skipped: Record<string, number>;
  /** Seitenzahl (PDF) */
  pages?: number;
}
export const emptyVec = (): VecData => ({ paths: [], texts: [], w: 0, h: 0, layers: [], skipped: {} });
export const skip = (d: { skipped: Record<string, number> }, k: string, n = 1) => { d.skipped[k] = (d.skipped[k] ?? 0) + n; };

// ------------------------------------------------------------ Pfade aufbauen (Bézier → Bogen oder Polylinie)
const hyp = Math.hypot;
/** Pfadaufbau in Zielkoordinaten (Papier-mm): Kubische Béziers, die einen Kreisbogen annähern, werden zu Bögen. */
export class PathBuilder {
  subs: VSub[] = [];
  cur: VSub | null = null;
  /** Abweichung beim Auflösen von Kurven */
  constructor(public tol = 0.05) {}
  get last(): V2 | null { const c = this.cur; return c ? (c.segs.length ? c.segs[c.segs.length - 1].p : c.p0) : null; }
  move(p: V2): void { this.cur = { p0: p, segs: [], closed: false }; this.subs.push(this.cur); }
  line(p: V2): void { if (!this.cur) this.move(p); else this.cur.segs.push({ p }); }
  arc(p: V2, c: V2, r: number, ccw: boolean): void { if (!this.cur) this.move(p); else this.cur.segs.push({ p, arc: { c, r, ccw } }); }
  close(): void {
    const c = this.cur; if (!c) return;
    c.closed = true;
    const l = this.last!;
    if (c.segs.length && !c.segs[c.segs.length - 1].arc && hyp(l.x - c.p0.x, l.y - c.p0.y) < 1e-9) c.segs.pop();
    // nach h beginnt ein neuer Teilpfad am Startpunkt
    this.cur = { p0: c.p0, segs: [], closed: false }; this.subs.push(this.cur);
  }
  cubic(p1: V2, p2: V2, p3: V2): void {
    const p0 = this.last; if (!p0) { this.move(p3); return; }
    const a = cubicArc(p0, p1, p2, p3, this.tol);
    if (a) { this.arc(p3, a.c, a.r, a.ccw); return; }
    flattenCubic(p0, p1, p2, p3, this.tol, (q) => this.line(q));
  }
  quad(p1: V2, p2: V2): void {
    const p0 = this.last; if (!p0) { this.move(p2); return; }
    this.cubic({ x: p0.x + (2 / 3) * (p1.x - p0.x), y: p0.y + (2 / 3) * (p1.y - p0.y) }, { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) }, p2);
  }
  /** fertige Teilpfade (leere entfernt) */
  take(): VSub[] {
    const out = this.subs.filter((s) => s.segs.length > 0);
    this.subs = []; this.cur = null;
    return out;
  }
}

/** Kubische Bézierkurve als Kreisbogen erkennen (Tangenten, Radius, Henkellänge 4/3·tan(θ/4)·r, Kurvenmitte) */
export function cubicArc(p0: V2, p1: V2, p2: V2, p3: V2, tol: number): VArc | null {
  const t0 = { x: p1.x - p0.x, y: p1.y - p0.y }, t1 = { x: p3.x - p2.x, y: p3.y - p2.y };
  const l0 = hyp(t0.x, t0.y), l1 = hyp(t1.x, t1.y); const ch = hyp(p3.x - p0.x, p3.y - p0.y);
  if (l0 < 1e-9 || l1 < 1e-9 || ch < tol) return null;
  // Schnitt der Normalen in p0 und p3
  const n0 = { x: -t0.y, y: t0.x }, n1 = { x: -t1.y, y: t1.x };
  const den = n0.x * n1.y - n0.y * n1.x;
  if (Math.abs(den) < 1e-9 * l0 * l1) return null;
  const s = ((p3.x - p0.x) * n1.y - (p3.y - p0.y) * n1.x) / den;
  const c = { x: p0.x + n0.x * s, y: p0.y + n0.y * s };
  const r = hyp(p0.x - c.x, p0.y - c.y), r1 = hyp(p3.x - c.x, p3.y - c.y);
  if (r < tol || Math.abs(r - r1) > Math.max(tol * 0.25, r * 2e-3) || r > 1e5 * ch) return null;
  const ccw = (p0.x - c.x) * t0.y - (p0.y - c.y) * t0.x > 0;
  let th = Math.atan2(p3.y - c.y, p3.x - c.x) - Math.atan2(p0.y - c.y, p0.x - c.x);
  if (ccw) { while (th <= 0) th += 2 * Math.PI; } else { while (th >= 0) th -= 2 * Math.PI; th = -th; }
  if (th > Math.PI * 0.75 + 1e-6) return null;
  const k = (4 / 3) * Math.tan(th / 4) * r;
  if (Math.abs(l0 - k) > Math.max(tol, k * 0.02) || Math.abs(l1 - k) > Math.max(tol, k * 0.02)) return null;
  const m = { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 };
  if (Math.abs(hyp(m.x - c.x, m.y - c.y) - r) > Math.max(tol * 0.25, r * 1e-3)) return null;
  return { c, r, ccw };
}

/** Kubische Bézierkurve rekursiv unterteilen (Flachheit ≤ tol) */
export function flattenCubic(p0: V2, p1: V2, p2: V2, p3: V2, tol: number, out: (p: V2) => void, depth = 0): void {
  const dx = p3.x - p0.x, dy = p3.y - p0.y; const L = hyp(dx, dy) || 1e-12;
  const d1 = Math.abs((p1.x - p0.x) * dy - (p1.y - p0.y) * dx) / L, d2 = Math.abs((p2.x - p0.x) * dy - (p2.y - p0.y) * dx) / L;
  const deg = L < 1e-9 && hyp(p1.x - p0.x, p1.y - p0.y) + hyp(p2.x - p0.x, p2.y - p0.y) > tol;
  if ((!deg && Math.max(d1, d2) <= tol) || depth > 12) { out(p3); return; }
  const m = (a: V2, b: V2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const a = m(p0, p1), b = m(p1, p2), c = m(p2, p3), ab = m(a, b), bc = m(b, c), q = m(ab, bc);
  flattenCubic(p0, a, ab, q, tol, out, depth + 1); flattenCubic(q, bc, c, p3, tol, out, depth + 1);
}

/** Bogenpunkte von a nach b (ohne a) */
export function arcPoints(a: V2, b: V2, arc: VArc, tol: number): V2[] {
  const { c, r, ccw } = arc;
  const a0 = Math.atan2(a.y - c.y, a.x - c.x); let sw = Math.atan2(b.y - c.y, b.x - c.x) - a0;
  if (ccw) { while (sw <= 1e-12) sw += 2 * Math.PI; } else { while (sw >= -1e-12) sw -= 2 * Math.PI; }
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
  const n = Math.max(1, Math.min(720, Math.ceil(Math.abs(sw) / Math.max(step, 1e-3))));
  const out: V2[] = [];
  for (let i = 1; i < n; i++) { const t = a0 + (sw * i) / n; out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r }); }
  out.push(b);
  return out;
}
/** Teilpfad als Punktfolge (Bögen aufgelöst) */
export function subPoints(s: VSub, tol: number): V2[] {
  const pts: V2[] = [s.p0]; let prev = s.p0;
  for (const g of s.segs) { if (g.arc) pts.push(...arcPoints(prev, g.p, g.arc, tol)); else pts.push(g.p); prev = g.p; }
  return pts;
}

// ------------------------------------------------------------ Zuordnung: Stift, Strichart, Farbe
/** Papier-Strichbreite (mm) → nächste Stiftnummer 1–16 */
export function penOfWidth(w: number): number {
  if (!(w > PEN_MM[1])) return 1;
  let best = 1, bd = Infinity;
  for (let i = 1; i < PEN_MM.length; i++) { const d = Math.abs(Math.log(w / PEN_MM[i])); if (d < bd) { bd = d; best = i; } }
  return best;
}
/** Strichmuster (Papier-mm, Strich/Lücke …) → nächste OpenRiss-Strichart */
export function dashOfArray(arr: number[] | undefined): DashName {
  const a = (arr ?? []).map((v) => Math.abs(v)).filter((v) => isFinite(v));
  if (!a.length || a.every((v) => v < 1e-6)) return 'solid';
  const d = a.length % 2 ? [...a, ...a] : a;
  if (d.every((v, i) => i % 2 === 0 || v < 1e-6)) return 'solid';
  const lg = (x: number) => Math.log(Math.max(x, 0.05));
  const dist = (p: number[], q: number[]) => p.reduce((s, v, i) => s + (lg(v) - lg(q[i])) ** 2, 0);
  if (d.length === 2) {
    if (d[0] <= 0.4 && d[0] < d[1]) return 'dot';
    let best: DashName = 'dash', bd = Infinity;
    for (const k of ['dash', 'hidden', 'longdash'] as DashName[]) { const x = dist(d, DASHES[k]); if (x < bd) { bd = x; best = k; } }
    return best;
  }
  if (d.length === 4) {
    if (Math.min(d[0], d[2]) > 1.2) return dashOfArray([d[0], d[1]]);
    // Strich + Punkt/kurzer Strich: Achse (langer Strich) oder Strich-Punkt
    const [L, g1, sh, g2] = d[0] >= d[2] ? d : [d[2], d[3], d[0], d[1]];
    return dist([L, g1, sh, g2], DASHES.center) <= dist([L, g1, sh, g2], DASHES.dashdot) ? 'center' : 'dashdot';
  }
  return 'dashdot';
}
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/** RGB 0..1 → #rrggbb */
export const rgbHex = (r: number, g: number, b: number) => '#' + hex2(r * 255) + hex2(g * 255) + hex2(b * 255);
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff', gray: '#808080', grey: '#808080',
  yellow: '#ffff00', orange: '#ffa500', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff', silver: '#c0c0c0', brown: '#a52a2a',
  maroon: '#800000', navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080', pink: '#ffc0cb', gold: '#ffd700', violet: '#ee82ee',
  darkred: '#8b0000', darkgreen: '#006400', darkblue: '#00008b', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5', beige: '#f5f5dc', khaki: '#f0e68c', tan: '#d2b48c', salmon: '#fa8072',
  crimson: '#dc143c', indigo: '#4b0082', coral: '#ff7f50', tomato: '#ff6347', orangered: '#ff4500', steelblue: '#4682b4', skyblue: '#87ceeb',
  lightblue: '#add8e6', royalblue: '#4169e1', forestgreen: '#228b22', seagreen: '#2e8b57', limegreen: '#32cd32', chocolate: '#d2691e', sienna: '#a0522d',
  saddlebrown: '#8b4513', darkorange: '#ff8c00', lightgreen: '#90ee90', darkcyan: '#008b8b', darkmagenta: '#8b008b', slategray: '#708090', slategrey: '#708090',
};
/** CSS-Farbe → { hex, alpha }; null = keine Farbe */
export function cssColor(s: string | undefined): { hex: string; a: number } | null {
  if (s === undefined) return null;
  let t = s.trim().toLowerCase();
  if (!t || t === 'none' || t === 'transparent') return null;
  t = NAMED[t] ?? t;
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1]; if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return { hex: '#' + h.slice(0, 6), a };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const c = (x: string) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x));
    const a = p[3] !== undefined ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
    return { hex: '#' + hex2(c(p[0])) + hex2(c(p[1])) + hex2(c(p[2])), a: isFinite(a) ? a : 1 };
  }
  return { hex: '#000000', a: 1 };
}

// ------------------------------------------------------------ Typen finden oder anlegen
const BUILTIN = new Set(Object.keys(LINE_STYLES));
/** Linienstil-Schlüssel (eingebaute Stile unter ihrem Schlüssel wie in den Auswahllisten) */
function styleKeyOf(doc: Doc, color: string, pen: number, dash: DashName, made: Set<Id>): string {
  const n0 = doc.count('type');
  const t = findOrAddLineStyle(doc, { color, pen, dash });
  if (doc.count('type') > n0) made.add(t.id);
  const k = t.id.replace(/^ls_/, '');
  return t.id.startsWith('ls_') && BUILTIN.has(k) ? k : t.id;
}
const same = (a: string | undefined, b: string | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
/** Füllbereichstyp zu Farbe/Muster (vorhandene Typen werden wiederverwendet; Weiss voll = Maskierung) */
export function findOrAddRegionType(doc: Doc, f: VFill, made?: Set<Id>): Id {
  const col = f.color.toLowerCase(); const pat = f.pattern || 'solid'; const bg = (f.bg ?? '').toLowerCase();
  const types = typesOf<TypeEl & Record<string, any>>(doc, 'region');
  const mask = pat === 'solid' && col === '#ffffff';
  const hit = mask ? types.find((t) => t.masking) : types.find((t) => !t.masking && (t.pattern || '') === pat && same(t.patColor || '#000000', col) && (pat === 'solid' || same(t.bg || '', bg)));
  if (hit) return hit.id;
  const base = mask ? 'rgt_imp_mask' : `rgt_imp_${pat}_${col.replace('#', '')}${bg ? '_' + bg.replace('#', '') : ''}`;
  let id = base; while (doc.get(id)) id += '_';
  const name = mask ? 'Maskierungsbereich (Import)' : `${pat === 'solid' ? 'Vollfüllung' : 'Muster ' + pat} ${col}${bg ? ' auf ' + bg : ''} (Import)`;
  doc.add({ id, cat: 'type', of: 'region', name, pattern: mask ? '' : pat, patColor: mask ? '#000000' : col, bg: mask ? '#ffffff' : bg, masking: mask } as any);
  made?.add(id);
  return id;
}
/** Schriftname der Datei → OpenRiss-Schrift (Arial, Arial Narrow, ISOCPEUR, Times New Roman, Courier New) */
export function fontOf(name: string | undefined): string {
  const n = name ?? '';
  if (/narrow|condensed|cond\b|compressed/i.test(n)) return 'Arial Narrow';
  if (/isocp|iso.?3098|osifont/i.test(n)) return 'ISOCPEUR';
  if (/times|serif(?!.*sans)|roman|georgia|garamond/i.test(n) && !/sans/i.test(n)) return 'Times New Roman';
  if (/courier|mono|consol/i.test(n)) return 'Courier New';
  return 'Arial';
}
/** Texttyp zu Grösse (Papier-mm), Farbe, Fett und Schrift */
export function findOrAddTextType(doc: Doc, size: number, color: string, bold: boolean, made?: Set<Id>, font = 'Arial'): Id {
  const sz = Math.round(size * 100) / 100; const col = color.toLowerCase();
  const hit = typesOf<TypeEl & Record<string, any>>(doc, 'text').find((t) => Math.abs((t.size ?? 2.5) - sz) < 0.006 && same(t.color || '#000000', col) && !!t.bold === bold && (t.font || 'Arial') === font && !t.opaque && !t.box && !t.italic && !t.underline);
  if (hit) return hit.id;
  let id = `txt_imp_${String(sz).replace('.', '_')}_${col.replace('#', '')}${bold ? '_b' : ''}${font !== 'Arial' ? '_' + font.replace(/\W+/g, '').toLowerCase() : ''}`; while (doc.get(id)) id += '_';
  const nm = `Text ${String(sz).replace('.', ',')} mm ${font}${bold ? ' fett' : ''}${col !== '#000000' ? ' ' + col : ''} (Import)`;
  doc.add({ id, cat: 'type', of: 'text', name: nm, size: sz, font, bold, italic: false, underline: false, color: col, opaque: false, box: false, leaderArrow: 'arrow', arrowSize: 2.5 } as any);
  made?.add(id);
  return id;
}

// ------------------------------------------------------------ Zuschneiden (Rechteck)
function clipSeg(a: V2, b: V2, r: BBox): [V2, V2] | null {
  let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y;
  const ps = [-dx, dx, -dy, dy], qs = [a.x - r.min.x, r.max.x - a.x, a.y - r.min.y, r.max.y - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(ps[i]) < 1e-15) { if (qs[i] < 0) return null; continue; }
    const t = qs[i] / ps[i];
    if (ps[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }];
}
/** Ring gegen Rechteck (Sutherland–Hodgman; konvexes Fenster, gerade-ungerade bleibt richtig) */
function clipRing(ring: V2[], r: BBox): V2[] {
  let out = ring;
  const edges: [(p: V2) => boolean, (a: V2, b: V2) => V2][] = [
    [(p) => p.x >= r.min.x, (a, b) => ({ x: r.min.x, y: a.y + ((b.y - a.y) * (r.min.x - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= r.max.x, (a, b) => ({ x: r.max.x, y: a.y + ((b.y - a.y) * (r.max.x - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= r.min.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.min.y - a.y)) / (b.y - a.y), y: r.min.y })],
    [(p) => p.y <= r.max.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.max.y - a.y)) / (b.y - a.y), y: r.max.y })],
  ];
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i], q = src[(i + 1) % src.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cut(p, q));
    }
    if (!out.length) break;
  }
  return out;
}
/** in den Ringen (gerade-ungerade)? */
function inRings(p: V2, rings: V2[][]): boolean { let c = false; for (const r of rings) if (pointInRing(p, r)) c = !c; return c; }
/** Strecke gegen beliebigen Zuschneidebereich: Teilstücke innerhalb */
function clipSegPoly(a: V2, b: V2, rings: V2[][]): [V2, V2][] {
  const d = { x: b.x - a.x, y: b.y - a.y };
  return insideParts(a, b, rings, 0).map(([t0, t1]) => [{ x: a.x + d.x * t0, y: a.y + d.y * t0 }, { x: a.x + d.x * t1, y: a.y + d.y * t1 }]);
}
/** Parameterbereiche [t0, t1] der Strecke innerhalb der Ringe (gerade-ungerade); minDist: Abstand vom Rand (Randlinien bleiben aussen) */
function insideParts(a: V2, b: V2, rings: V2[][], minDist: number): [number, number][] {
  const d = { x: b.x - a.x, y: b.y - a.y }; const ts = [0, 1];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length]; const e = { x: q.x - p.x, y: q.y - p.y };
    const den = d.x * e.y - d.y * e.x; if (Math.abs(den) < 1e-15) continue;
    const w = { x: p.x - a.x, y: p.y - a.y };
    const t = (w.x * e.y - w.y * e.x) / den, u = (w.x * d.y - w.y * d.x) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1]; if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2; const m = { x: a.x + d.x * tm, y: a.y + d.y * tm };
    if (!inRings(m, rings)) continue;
    if (minDist > 0 && rings.some((r) => r.some((p, k) => distToSeg(m, p, r[(k + 1) % r.length]) < minDist))) continue;
    const q = out[out.length - 1];
    if (q && Math.abs(q[1] - t0) < 1e-9) q[1] = t1; else out.push([t0, t1]);
  }
  return out;
}
function arcBox(a: V2, b: V2, arc: VArc, bb: BBox): void {
  extendBox(bb, a); extendBox(bb, b);
  const a0 = Math.atan2(a.y - arc.c.y, a.x - arc.c.x), a1 = Math.atan2(b.y - arc.c.y, b.x - arc.c.x);
  const [s, e] = arc.ccw ? [a0, a1] : [a1, a0]; const sw = normAngle(e - s) || 2 * Math.PI;
  for (let k = 0; k < 4; k++) { const t = (k * Math.PI) / 2; if (normAngle(t - s) <= sw) extendBox(bb, { x: arc.c.x + Math.cos(t) * arc.r, y: arc.c.y + Math.sin(t) * arc.r }); }
}
function pathBox(p: VPath): BBox {
  const bb = emptyBox();
  for (const s of p.subs) { let prev = s.p0; extendBox(bb, prev); for (const g of s.segs) { if (g.arc) arcBox(prev, g.p, g.arc, bb); else extendBox(bb, g.p); prev = g.p; } }
  return bb;
}
const inBox = (a: BBox, b: BBox, e: number) => a.min.x >= b.min.x - e && a.min.y >= b.min.y - e && a.max.x <= b.max.x + e && a.max.y <= b.max.y + e;

// ------------------------------------------------------------ Elemente erzeugen
export interface BuildOpts {
  /** Datei-Einheiten → Ansichts-mm */
  xf: Mat2;
  /** Textgrösse (Datei) → Texttyp-Grösse (Papier-mm in der Zielansicht) */
  textK: number;
  texts?: boolean;
  fills?: boolean;
  /** nur diese Layer */
  layers?: string[] | null;
  /** weisse Füllungen immer als Maskierungsbereiche übernehmen (sonst nur über farbigen Bereichen) */
  masks?: boolean;
}
export interface VectorImportResult {
  /** Detaillinien (inkl. Bögen) */
  lines: number;
  /** davon Bögen */
  arcs: number;
  regions: number;
  texts: number;
  /** neu angelegte Linienstile / Füllbereichs- und Texttypen */
  lineStyles: number;
  types: number;
  skipped: Record<string, number>;
  layers: string[];
  pages: number;
  ids: Id[];
}

const ASC = 0.905, DSC = 0.212; // Liberation Sans/Arial (wie PDF-Export)
interface LineRec { a: V2; b: V2; arc?: VArc; key: string; used?: boolean }
interface RegRec { loops: V2[][]; fill: VFill; style?: string }

/** Zwischenformat als Elemente in die Ansicht einfügen (innerhalb einer Transaktion aufrufen) */
export function buildVector(doc: Doc, view: View, data: VecData, o: BuildOpts): VectorImportResult {
  const res: VectorImportResult = { lines: 0, arcs: 0, regions: 0, texts: 0, lineStyles: 0, types: 0, skipped: { ...data.skipped }, layers: data.layers, pages: data.pages ?? 1, ids: [] };
  const V = view.scale || 1; const xs = matScale(o.xf) || 1; const mir = isMirror(o.xf);
  const tol = (0.05 * V) / xs; // Kurven auflösen: 0,05 Papier-mm in Datei-Einheiten
  const eps = (0.001 * V) / xs; // gleiche Punkte
  const want = o.layers?.length ? new Set(o.layers) : null;
  const madeLs = new Set<Id>(), madeT = new Set<Id>();
  const styleCache = new Map<string, string>();
  const styleOf = (s: VStroke): string => {
    const dash = s.dashName ?? dashOfArray(s.dash); const pen = penOfWidth(s.width); const col = s.color.toLowerCase();
    const k = col + '|' + pen + '|' + dash;
    let st = styleCache.get(k);
    if (!st) { st = styleKeyOf(doc, col, pen, dash, madeLs); styleCache.set(k, st); }
    return st;
  };
  const lines: LineRec[] = []; const regs: RegRec[] = [];
  // Rasterindex der Striche (verdecken durch spätere Füllungen)
  const G = (20 * V) / xs; const grid = new Map<string, number[]>();
  const cells = (bb: BBox, f: (k: string) => void) => {
    const x0 = Math.floor(bb.min.x / G), x1 = Math.floor(bb.max.x / G), y0 = Math.floor(bb.min.y / G), y1 = Math.floor(bb.max.y / G);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { f('*'); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) f(x + ',' + y);
  };
  const lineBox = (l: LineRec) => { const bb = emptyBox(); if (l.arc) arcBox(l.a, l.b, l.arc, bb); else { extendBox(bb, l.a); extendBox(bb, l.b); } return bb; };
  const addLine = (l: LineRec) => { const i = lines.length; lines.push(l); cells(lineBox(l), (k) => { const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]); }); };
  /** Füllung (deckend) verdeckt früher gezeichnete Striche – in OpenRiss liegen Bereiche immer unter Linien */
  const hideUnder = (rings: V2[][]) => {
    const bb = emptyBox(); for (const r of rings) for (const q of r) extendBox(bb, q);
    const cand = new Set<number>(); cells(bb, (k) => { for (const i of grid.get(k) ?? []) cand.add(i); }); for (const i of grid.get('*') ?? []) cand.add(i);
    for (const i of cand) {
      const l = lines[i]; if (l.used || !boxOverlap(lineBox(l), bb)) continue;
      const segs: [V2, V2][] = [];
      if (l.arc) { let q = l.a; for (const r of arcPoints(l.a, l.b, l.arc, tol)) { segs.push([q, r]); q = r; } } else segs.push([l.a, l.b]);
      const keep: [V2, V2][] = []; let changed = false;
      for (const [x, y] of segs) {
        const ins = insideParts(x, y, rings, eps * 10);
        if (!ins.length) { keep.push([x, y]); continue; }
        changed = true; let t = 0; const at = (u: number) => ({ x: x.x + (y.x - x.x) * u, y: x.y + (y.y - x.y) * u });
        for (const [t0, t1] of ins) { if (t0 - t > 1e-9) keep.push([at(t), at(t0)]); t = t1; }
        if (1 - t > 1e-9) keep.push([at(t), y]);
      }
      if (!changed) continue;
      l.used = true; skip(res, 'Verdeckte Linienteile');
      for (const [x, y] of keep) if (hyp(y.x - x.x, y.y - x.y) >= eps) addLine({ a: x, b: y, key: l.key });
    }
  };
  const pageA = data.w * data.h;
  for (const p of data.paths) {
    if (want && !(p.layer && want.has(p.layer))) continue;
    if (!p.subs.length) continue;
    let clip = p.clip ?? null;
    if (clip) {
      if (!boxValid(clip)) { skip(res, 'Ausserhalb des Zuschneidebereichs'); continue; }
      const bb = pathBox(p);
      if (!boxOverlap(bb, clip)) { skip(res, 'Ausserhalb des Zuschneidebereichs'); continue; }
      if (inBox(bb, clip, eps)) clip = null;
    }
    if (p.fill && o.fills !== false) {
      let rings = p.subs.map((s) => dedupe(subPoints(s, tol), eps));
      if (clip) rings = rings.map((r) => dedupe(clipRing(r, clip!), eps));
      rings = rings.filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > eps * eps);
      for (const cp of p.clipPolys ?? []) if (rings.length) rings = intersection(rings, cp).flat().map((r) => dedupe(r, eps)).filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > eps * eps);
      const white = !p.fill.pattern || p.fill.pattern === 'solid' ? p.fill.color.toLowerCase() === '#ffffff' : false;
      const bb = emptyBox(); for (const r of rings) for (const q of r) extendBox(bb, q);
      if (white && !p.stroke && pageA > 0 && boxValid(bb) && (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) > pageA * 0.8) skip(res, 'Seitenhintergrund');
      else if (rings.length) {
        // Muster mit Hintergrund: Vollfüllung + Muster auf gleicher Kontur → ein Bereich
        const prev = regs[regs.length - 1];
        if (prev && p.fill.pattern && p.fill.pattern !== 'solid' && (prev.fill.pattern ?? 'solid') === 'solid' && sameLoops(prev.loops, rings, eps)) prev.fill = { ...p.fill, bg: prev.fill.color };
        else {
          regs.push({ loops: rings, fill: p.fill });
          if ((p.fill.pattern ?? 'solid') === 'solid') hideUnder(rings);
        }
      }
    }
    if (p.stroke) {
      const key = styleOf(p.stroke);
      const cps = p.clipPolys?.length ? p.clipPolys : null;
      /** Strecke gegen alle Zuschneidebereiche (Rechteck, dann Polygone) */
      const pieces = (a: V2, b: V2): [V2, V2][] => {
        let ps: [V2, V2][] = [[a, b]];
        if (clip) { const c = clipSeg(a, b, clip); ps = c ? [c] : []; }
        for (const cp of cps ?? []) ps = ps.flatMap(([x, y]) => clipSegPoly(x, y, cp));
        return ps.filter(([x, y]) => hyp(y.x - x.x, y.y - x.y) >= eps);
      };
      for (const s of p.subs) {
        let prev = s.p0;
        const segs = s.closed && hyp(prev.x - (s.segs[s.segs.length - 1]?.p.x ?? prev.x), prev.y - (s.segs[s.segs.length - 1]?.p.y ?? prev.y)) > eps ? [...s.segs, { p: s.p0 }] : s.segs;
        for (const g of segs) {
          const a = prev, b = g.p; prev = b;
          if (g.arc) {
            if (clip || cps) {
              const bb = emptyBox(); arcBox(a, b, g.arc, bb);
              if (clip && !boxOverlap(bb, clip)) continue;
              const pts = arcPoints(a, b, g.arc, tol);
              const whole = (!clip || inBox(bb, clip, eps)) && (!cps || pts.every((r, i) => { const q = i ? pts[i - 1] : a; const c = pieces(q, r); return c.length === 1 && hyp(c[0][0].x - q.x, c[0][0].y - q.y) < eps && hyp(c[0][1].x - r.x, c[0][1].y - r.y) < eps; }));
              if (!whole) { let q = a; for (const r of pts) { for (const c of pieces(q, r)) addLine({ a: c[0], b: c[1], key }); q = r; } continue; }
            }
            addLine({ a, b, arc: g.arc, key });
          } else {
            if (hyp(b.x - a.x, b.y - a.y) < eps) continue;
            if (clip || cps) { for (const c of pieces(a, b)) addLine({ a: c[0], b: c[1], key }); }
            else addLine({ a, b, key });
          }
        }
      }
    }
  }
  // Ränder von Füllungen, die als eigene Striche gezeichnet sind → Begrenzungslinienstil des Bereichs
  const kq = (p: V2) => Math.round(p.x / eps) + ',' + Math.round(p.y / eps);
  const segIdx = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.arc) return;
    const ka = kq(l.a), kb = kq(l.b); const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const arr = segIdx.get(k); if (arr) arr.push(i); else segIdx.set(k, [i]);
  });
  for (const r of regs) {
    let style: string | undefined; const hit: number[] = []; let ok = true;
    for (const ring of r.loops) {
      for (let i = 0; i < ring.length && ok; i++) {
        const ka = kq(ring[i]), kb = kq(ring[(i + 1) % ring.length]); if (ka === kb) continue;
        const cand = (segIdx.get(ka < kb ? ka + '|' + kb : kb + '|' + ka) ?? []).filter((j) => !lines[j].used && (!style || lines[j].key === style) && !hit.includes(j));
        if (!cand.length) { ok = false; break; }
        style = lines[cand[0]].key; hit.push(cand[0]);
      }
      if (!ok) break;
    }
    if (ok && style && hit.length) { r.style = style; for (const j of hit) lines[j].used = true; }
  }
  // Füllbereiche: Ringe nach Verschachtelung in Aussen-/Innenringe gruppieren (gerade-ungerade).
  // Weisse Vollfüllungen dienen meist nur zum Verdecken (Linien darunter sind bereits entfernt): nur übernehmen,
  // wenn sie einen früheren farbigen Bereich überdecken (dann als Maskierungsbereich) oder masks gesetzt ist.
  const typeCache = new Map<string, Id>();
  const rgrid = new Map<string, BBox[]>();
  for (const r of regs) {
    const bb = emptyBox(); for (const l of r.loops) for (const q of l) extendBox(bb, q);
    const white = (r.fill.pattern ?? 'solid') === 'solid' && r.fill.color.toLowerCase() === '#ffffff';
    if (white && !o.masks) {
      let hit = false;
      cells(bb, (k) => { if (!hit) hit = (rgrid.get(k) ?? []).some((b) => boxOverlap(b, bb)); });
      if (!hit) hit = (rgrid.get('*') ?? []).some((b) => boxOverlap(b, bb));
      if (!hit) { skip(res, 'Weisse Abdeckflächen'); continue; }
    } else if (!white) cells(bb, (k) => { const a = rgrid.get(k); if (a) a.push(bb); else rgrid.set(k, [bb]); });
    const tk = r.fill.color + '|' + (r.fill.pattern ?? '') + '|' + (r.fill.bg ?? '');
    let typeId = typeCache.get(tk);
    if (!typeId) { typeId = findOrAddRegionType(doc, r.fill, madeT); typeCache.set(tk, typeId); }
    const rings = r.loops.map((l) => l.map((q) => apply(o.xf, q))).sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const groups: { outer: V2[]; holes: V2[][]; depth: number }[] = [];
    const depthOf: number[] = [];
    rings.forEach((ring, i) => {
      let d = 0; let parent = -1;
      for (let j = i - 1; j >= 0; j--) if (pointInRing(ring[0], rings[j]) && pointInRing(ring[Math.floor(ring.length / 2)], rings[j])) { d = depthOf[j] + 1; parent = j; break; }
      depthOf.push(d);
      if (d % 2 === 0) groups.push({ outer: ring, holes: [], depth: d });
      else { const g = groups.find((x) => x.outer === rings[parent]); if (g) g.holes.push(ring); else groups.push({ outer: ring, holes: [], depth: d }); }
    });
    for (const g of groups) {
      const loops = [ccw(g.outer, true), ...g.holes.map((h) => ccw(h, false))];
      const id = newId('rg');
      doc.add({ id, cat: 'region', viewId: view.id, typeId, loops, lineStyle: r.style ?? 'invisible' } as any);
      res.ids.push(id); res.regions++;
    }
  }
  // Detaillinien (aufeinanderfolgende Bögen gleichen Kreises zusammenfassen, Vollkreis als zwei Hälften; Doppelte weglassen)
  const seen = new Set<string>();
  const out: LineRec[] = [];
  let run: (LineRec & { sw: number }) | null = null;
  const endRun = () => {
    if (!run) return;
    const r = run; run = null;
    if (r.sw < 2 * Math.PI - 1e-3) { out.push(r); return; }
    const a0 = Math.atan2(r.a.y - r.arc!.c.y, r.a.x - r.arc!.c.x) + (r.arc!.ccw ? Math.PI : -Math.PI);
    const m = { x: r.arc!.c.x + Math.cos(a0) * r.arc!.r, y: r.arc!.c.y + Math.sin(a0) * r.arc!.r };
    out.push({ ...r, b: m }, { ...r, a: m, b: r.a });
  };
  for (const l of lines) {
    if (l.used) continue;
    const q = run as (LineRec & { sw: number }) | null;
    const ct = l.arc ? Math.max(eps * 20, l.arc.r * 2e-3) : 0;
    if (l.arc && q && q.key === l.key && q.arc!.ccw === l.arc.ccw && hyp(q.arc!.c.x - l.arc.c.x, q.arc!.c.y - l.arc.c.y) < ct && Math.abs(q.arc!.r - l.arc.r) < ct && hyp(q.b.x - l.a.x, q.b.y - l.a.y) < eps * 10
      && q.sw + sweepOf(l.a, l.b, l.arc) < 2 * Math.PI + 1e-3) { q.b = l.b; q.sw += sweepOf(l.a, l.b, l.arc); continue; }
    endRun();
    if (l.arc) run = { ...l, sw: sweepOf(l.a, l.b, l.arc) }; else out.push({ ...l });
  }
  endRun();
  for (const l of out) {
    let a = apply(o.xf, l.a), b = apply(o.xf, l.b);
    const mp = l.arc ? arcMid(l.a, l.b, l.arc) : null;
    const k = l.key + '|' + [a, b].map((p) => Math.round(p.x * 100) + ',' + Math.round(p.y * 100)).sort().join('|') + (mp ? '|a' + Math.round(mp.x * 100) + ',' + Math.round(mp.y * 100) : '');
    if (seen.has(k)) { skip(res, 'Doppelte Linien'); continue; }
    seen.add(k);
    const id = newId('li');
    if (l.arc) {
      const c = apply(o.xf, l.arc.c); const r = l.arc.r * xs;
      if (l.arc.ccw === mir) [a, b] = [b, a]; // im Uhrzeigersinn → Enden tauschen
      doc.add({ id, cat: 'line', viewId: view.id, a, b, style: l.key, arc: { c, r, a0: Math.atan2(a.y - c.y, a.x - c.x), a1: Math.atan2(b.y - c.y, b.x - c.x) } } as any);
      res.arcs++;
    } else doc.add({ id, cat: 'line', viewId: view.id, a, b, style: l.key } as any);
    res.ids.push(id); res.lines++;
  }
  // Texte
  if (o.texts !== false) {
    const ttCache = new Map<string, Id>();
    for (const t of data.texts) {
      if (want && !(t.layer && want.has(t.layer))) continue;
      const s = t.s.replace(/\s+$/g, '');
      if (!s.trim()) continue;
      if (t.clip && !(boxValid(t.clip) && t.p.x >= t.clip.min.x - eps && t.p.x <= t.clip.max.x + eps && t.p.y >= t.clip.min.y - eps && t.p.y <= t.clip.max.y + eps)) { skip(res, 'Ausserhalb des Zuschneidebereichs'); continue; }
      const size = Math.round(t.size * o.textK * 100) / 100;
      if (!(size > 0)) continue;
      const font = t.font ?? 'Arial';
      const tk = size + '|' + t.color + '|' + !!t.bold + '|' + font;
      let typeId = ttCache.get(tk);
      if (!typeId) { typeId = findOrAddTextType(doc, size, t.color, !!t.bold, madeT, font); ttCache.set(tk, typeId); }
      const A = apply(o.xf, t.p); const dv = applyVec(o.xf, fromAngle(t.rot));
      const rot = Math.atan2(dv.y, dv.x); const ex = fromAngle(rot), ey = perp(ex);
      const sm = size * V; const lh = sm * 1.25; const ls = s.split('\n'); const n = ls.length;
      const W = Math.max(sm * 0.6, ...ls.map((x) => textWidth(x, sm) * (t.bold ? 1.06 : 1)));
      const ha = t.ha ?? 'left'; const xA = ha === 'center' ? W / 2 : ha === 'right' ? W : 0;
      const va = t.va ?? 'baseline';
      const up = va === 'top' ? 0 : va === 'middle' ? ((n - 1) * lh) / 2 - ((ASC - DSC) / 2) * sm + ASC * sm : va === 'bottom' ? (n - 1) * lh + DSC * sm + ASC * sm : ASC * sm;
      const p = { x: A.x - ex.x * xA + ey.x * up, y: A.y - ex.y * xA + ey.y * up };
      const el: any = { id: newId('tx'), cat: 'text', viewId: view.id, typeId, p, s };
      if (Math.abs(rot) > 1e-6) el.rot = rot;
      if (ha !== 'left') el.ha = ha;
      if (t.italic) el.italic = true;
      doc.add(el); res.ids.push(el.id); res.texts++;
    }
  }
  res.lineStyles = madeLs.size; res.types = madeT.size;
  return res;
}
function arcMid(a: V2, b: V2, arc: VArc): V2 {
  const t = Math.atan2(a.y - arc.c.y, a.x - arc.c.x) + (arc.ccw ? 1 : -1) * sweepOf(a, b, arc) / 2;
  return { x: arc.c.x + Math.cos(t) * arc.r, y: arc.c.y + Math.sin(t) * arc.r };
}
function sweepOf(a: V2, b: V2, arc: VArc): number {
  const a0 = Math.atan2(a.y - arc.c.y, a.x - arc.c.x), a1 = Math.atan2(b.y - arc.c.y, b.x - arc.c.x);
  return normAngle(arc.ccw ? a1 - a0 : a0 - a1) || 2 * Math.PI;
}
function dedupe(r: V2[], eps: number): V2[] {
  const out: V2[] = [];
  for (const p of r) { const q = out[out.length - 1]; if (!q || hyp(p.x - q.x, p.y - q.y) > eps) out.push(p); }
  while (out.length > 1 && hyp(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) out.pop();
  return out;
}
function sameLoops(a: V2[][], b: V2[][], eps: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (hyp(a[i][j].x - b[i][j].x, a[i][j].y - b[i][j].y) > eps * 10) return false;
  }
  return true;
}
const ccw = (r: V2[], outer: boolean) => ((signedArea(r) > 0) === outer ? r : r.slice().reverse());

// ------------------------------------------------------------ Einstieg
export interface VectorImportOpts {
  format?: 'dxf' | 'svg' | 'pdf';
  /** SVG/PDF: Papier-mm → Ansichts-mm (Standard: Maßstab der Zielansicht); DXF: Faktor auf die Zeichnungseinheit (Standard 1) */
  scale?: number;
  /** Lage des Seitenursprungs (SVG/PDF: linke untere Ecke; DXF: Zeichnungsursprung) in der Ansicht, mm */
  origin?: V2;
  /** PDF-Seite (ab 1) */
  page?: number;
  /** nur diese Layer (DXF-Layer, PDF-Ebenen/OCG, SVG-Gruppen mit id oder inkscape:label) */
  layers?: string[];
  /** Texte übernehmen (Standard ja) */
  texts?: boolean;
  /** Füllungen als Füllbereiche (Standard ja) */
  fills?: boolean;
  /** weisse Füllungen immer als Maskierungsbereiche (Standard: nur wenn sie farbige Bereiche überdecken) */
  masks?: boolean;
  /** DXF: mm je Zeichnungseinheit (Standard aus $INSUNITS, sonst 1) */
  unit?: number;
  /** Name der Transaktion */
  name?: string;
}

/** Dateiformat aus dem Inhalt erkennen */
export function detectFormat(data: string | Uint8Array): 'dxf' | 'svg' | 'pdf' {
  const head = typeof data === 'string' ? data.slice(0, 2048) : new TextDecoder('latin1').decode(data.subarray(0, 2048));
  if (/^\s*%PDF-/.test(head) || head.includes('%PDF-')) return 'pdf';
  if (/<svg[\s>]/i.test(head) || /^\s*(<\?xml|<!DOCTYPE svg|<svg)/i.test(head)) return 'svg';
  return 'dxf';
}

/** Gelesene Daten (ohne Elemente zu erzeugen) – z.B. für Vorschau und Optionsdialog */
export function readVector(data: string | Uint8Array, o: { format?: 'dxf' | 'svg' | 'pdf'; page?: number } = {}): { format: 'dxf' | 'svg' | 'pdf'; vec?: VecData; cad?: CadData } {
  const format = o.format ?? detectFormat(data);
  if (format === 'pdf') {
    if (typeof data === 'string') { const u = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) u[i] = data.charCodeAt(i) & 255; data = u; }
    return { format, vec: parsePdf(data, { page: o.page }) };
  }
  if (format === 'svg') return { format, vec: parseSvg(typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data)) };
  return { format, cad: parseDxf(typeof data === 'string' ? data : decodeDxf(data)) };
}

/**
 * Vektorgrafik (DXF, SVG oder PDF) als Detaillinien, Füllbereiche und Texte in eine Ansicht importieren
 * (Zeichnungsansicht, Grundriss, Schnitt, Plan …). Eine Transaktion. Liefert die Anzahlen und IDs.
 */
export function importVector(doc: Doc, viewId: Id, data: string | Uint8Array, opts: VectorImportOpts = {}): VectorImportResult {
  return importVectorFrom(doc, viewId, readVector(data, opts), opts);
}
/** Wie importVector, mit bereits gelesenen Daten (readVector) */
export function importVectorFrom(doc: Doc, viewId: Id, r: ReturnType<typeof readVector>, opts: VectorImportOpts = {}): VectorImportResult {
  const view = doc.get<View>(viewId);
  if (!view || view.cat !== 'view') throw new Error('Vektorimport: Ansicht unbekannt: ' + viewId);
  if (view.kind === '3d' || view.kind === 'schedule') throw new Error('Vektorimport: nur in 2D-Ansichten und Plänen möglich');
  const V = view.scale || 1; const org = opts.origin ?? { x: 0, y: 0 };
  let vec: VecData; let xf: Mat2; let textK: number;
  if (r.cad) {
    const cad = r.cad; const u = (opts.unit ?? INSUNITS_MM[cad.insunits] ?? 1) * (opts.scale ?? 1);
    const c: CadImport = { id: '', cat: 'cadimport', viewId, name: '', unit: u, offset: { x: cad.base.x * u + org.x, y: cad.base.y * u + org.y }, rotation: 0,
      base: cad.base, entities: cad.ents, layers: cad.layers, hiddenLayers: opts.layers?.length ? [] : cad.hiddenLayers, ltypes: cad.ltypes, colors: 'keep' };
    vec = cadToVec(c, V); vec.skipped = { ...cad.skipped };
    xf = I2; textK = 1 / V;
  } else {
    vec = r.vec!;
    const s = opts.scale ?? V;
    xf = { a: s, b: 0, c: 0, d: s, e: org.x, f: org.y };
    textK = s / V;
  }
  return doc.transaction(opts.name ?? 'Vektorgrafik importieren', () => buildVector(doc, view, vec, { xf, textK, texts: opts.texts, fills: opts.fills, layers: opts.layers, masks: opts.masks }));
}
