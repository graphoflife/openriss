// Einlagen/Fugen/Fertigteile – gemeinsame Hilfen: Schweizer Kotenformat, Wand- und Plattengeometrie,
// Kreis-/Zickzacksymbole, Vorlagentypen ergänzen, Kategorien additiv erweitern (Eigenschaften, Listenfelder).
import type { Doc, El, Id } from '../../core/doc';
import { V2, V3, add, sub, mul, perp, norm, dist, fromAngle, pointInPoly, MultiPoly, polylineLength } from '../../core/geom';
import { catDef, PropDef } from '../../core/registry';
import { levelElev, typesOf } from '../../core/view';
import { OBJECT_STYLES } from '../../render/styles';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { Wall, wallInfo, WallInfo, layerOffsets } from '../../elements/wall';
import { floorArea, floorTop } from '../architecture/floor';
import { foundInfo } from '../structure/foundation';
import { colInfo, Column } from '../structure/column';
import { cached } from '../../core/cache';
import { surfaceOf } from '../../views/surfaces';

// ------------------------------------------------------------ Zahlen (Schweizer Usanz: Dezimalpunkt)
/** Meter mit Punkt, z.B. 2400 → «2.40» */
export const fmtM = (mm: number, d = 2): string => (mm / 1000).toFixed(d).replace(/^-(0\.0+)$/, '$1');
/** Kote mit Vorzeichen: «+2.75», «−1.20», «±0.00» (Minuszeichen U+2212) */
export function fmtKote(mm: number, d = 2): string {
  const v = mm / 1000; const lim = 0.5 * Math.pow(10, -d);
  return (v >= lim ? '+' : v <= -lim ? '−' : '±') + Math.abs(v).toFixed(d);
}
/** Ganzzahl in mm, z.B. «150» */
export const fmtMm = (mm: number): string => String(Math.round(mm * 10) / 10);
/** Volumen in m³ (3 Dezimalen, Punkt) */
export const fmtM3 = (mm3: number): string => (mm3 / 1e9).toFixed(3) + ' m³';

// ------------------------------------------------------------ Objektstile / Farben
export function addObjStyle(cat: string, label: string, proj: number, cut?: number, color?: string): void {
  if (!OBJECT_STYLES[cat]) OBJECT_STYLES[cat] = { label, proj, cut, color } as any;
}
export const RED = '#d01c1c';
export const AF_PEN: Pen = { w: 5, color: RED };

/** Etappenfarben (Hintergrund unter dem Schnittmuster) */
export const STAGE_COLORS = ['#9ecae1', '#a1d99b', '#fdd49e', '#d4b9da', '#fcae91', '#c7e9c0', '#fee391', '#bdbdbd', '#8dd3c7', '#fb8072'];
export const stageColor = (s: number): string => STAGE_COLORS[(Math.max(1, Math.round(s)) - 1) % STAGE_COLORS.length];

// ------------------------------------------------------------ Wände
export interface WallFrame { w: Wall; wi: WallInfo; P(u: number, v?: number): V2; P3(u: number, v: number, z: number): V3; uOf(p: V2): number; vOf(p: V2): number; core: [number, number] }
/** Lokales System einer Wand: u entlang Achse (ab c0), v quer (links positiv), z absolut */
export function wallFrame(doc: Doc, id: Id | undefined): WallFrame | null {
  const w = doc.get<Wall>(id); if (!w || w.cat !== 'wall') return null;
  const wi = wallInfo(doc, w);
  const P = (u: number, v = 0) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
  const lay = layerOffsets(doc, w).filter((l) => l.lay.core);
  const core: [number, number] = lay.length ? [Math.min(...lay.map((l) => l.o0)), Math.max(...lay.map((l) => l.o1))] : [-wi.T / 2, wi.T / 2];
  return {
    w, wi, P, core,
    P3: (u, v, z) => { const q = P(u, v); return { x: q.x, y: q.y, z }; },
    uOf: (p) => (p.x - wi.c0.x) * wi.d.x + (p.y - wi.c0.y) * wi.d.y,
    vOf: (p) => (p.x - wi.c0.x) * wi.n.x + (p.y - wi.c0.y) * wi.n.y,
  };
}

// ------------------------------------------------------------ Platten (Geschossdecke, Fundamentplatte)
export interface SlabInfo {
  el: El; top: number; bot: number; area: MultiPoly; thick: number;
  /** geneigte Platte: Höhenverschiebung von top/bot im Punkt p (eben: 0); top/bot = Nennhöhen am Bezugspunkt */
  dz: (p: V2) => number; sloped: boolean;
}
const SLAB_CATS = ['floor', 'foundationSlab'];
export function slabInfo(doc: Doc, el: El | undefined): SlabInfo | null {
  if (!el) return null;
  return cached(doc, 'embSlab', el.id, () => {
    const surf = surfaceOf(doc, el);
    const sloped = !!surf && !surf.flat;
    if (el.cat === 'floor') {
      const t = doc.get<any>(el.typeId);
      const layers: { t: number; fn: string }[] = t?.layers ?? [];
      const T = layers.reduce((s, l) => s + l.t, 0) || 200;
      // tragende Schichten (für Volumen/Lage der Einlagen)
      const z0 = floorTop(doc, el); let z = z0; let top = z, bot = z - T; let found = false;
      for (const l of layers) { if (l.fn === 'structure') { if (!found) { top = z; found = true; } bot = z - l.t; } z -= l.t; }
      return { el, top, bot, area: floorArea(doc, el), thick: top - bot, sloped, dz: sloped ? (p: V2) => surf!.topAt(p) - z0 : () => 0 };
    }
    if (el.cat === 'foundationSlab') {
      const fi = foundInfo(doc, el); if (!fi) return null;
      return { el, top: fi.z1, bot: fi.z0, area: fi.polys, thick: fi.z1 - fi.z0, sloped, dz: sloped ? (p: V2) => surf!.topAt(p) - fi.z1 : () => 0 };
    }
    return null;
  });
}
/** Plattenhöhen im Grundrisspunkt p (geneigte Platten: top/bot an dieser Stelle) */
export function slabInfoAt(s: SlabInfo, p: V2): SlabInfo {
  if (!s.sloped) return s;
  const d = s.dz(p); return { ...s, top: s.top + d, bot: s.bot + d };
}
/** Platte unter einem Grundrisspunkt (Höhen an diesem Punkt); zNear: bevorzugt die Platte, deren Höhenlage am nächsten liegt */
export function slabAt(doc: Doc, p: V2, zNear?: number, filter?: (s: SlabInfo) => boolean): SlabInfo | null {
  let best: SlabInfo | null = null; let bd = Infinity;
  for (const c of SLAB_CATS) for (const el of doc.all(c)) {
    const s0 = slabInfo(doc, el); if (!s0 || !s0.area.some((poly) => pointInPoly(p, poly))) continue;
    const s = slabInfoAt(s0, p);
    if (filter && !filter(s)) continue;
    const d = zNear === undefined ? -s.top : zNear < s.bot ? s.bot - zNear : zNear > s.top ? zNear - s.top : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function columnBox(doc: Doc, c: El): { p: V2; rot: number; b: number; h: number; round: boolean; z0: number; z1: number } | null {
  if (c.cat !== 'column') return null;
  const ci = colInfo(doc, c as Column);
  const t = ci.t;
  const round = t?.shape === 'round';
  return { p: c.p, rot: c.rot ?? 0, b: t?.b ?? 300, h: round ? t?.b ?? 300 : t?.h ?? 300, round, z0: ci.z0, z1: ci.z1 };
}

// ------------------------------------------------------------ Geometrie-Hilfen
export function circleRing(c: V2, r: number, n = 24, a0 = 0): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) out.push(add(c, fromAngle(a0 + (i / n) * Math.PI * 2, r)));
  return out;
}
/** Kreisprofil in (u, z) – für runde Wandöffnungen */
export function circleProfile(u: number, z: number, r: number, n = 32): { u: number; z: number }[] {
  const out: { u: number; z: number }[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push({ u: u + Math.cos(a) * r, z: z + Math.sin(a) * r }); }
  return out;
}
/** Rechteck quer zu einem Segment (links +, rechts −) */
export function bandRect(a: V2, b: V2, l: number, r: number): V2[] {
  const n = perp(norm(sub(b, a)));
  return [add(a, mul(n, -r)), add(b, mul(n, -r)), add(b, mul(n, l)), add(a, mul(n, l))];
}
export const plen = (pts: V2[] | undefined): number => (pts && pts.length > 1 ? polylineLength(pts) : 0);
export function polyMid(pts: V2[]): { p: V2; d: V2 } {
  const L = plen(pts); let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const s = dist(pts[i - 1], pts[i]);
    if (acc + s >= L / 2 && s > 0) { const t = (L / 2 - acc) / s; return { p: add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), t)), d: norm(sub(pts[i], pts[i - 1])) }; }
    acc += s;
  }
  return { p: pts[0] ?? { x: 0, y: 0 }, d: { x: 1, y: 0 } };
}

/** Zickzack-Symbol der Arbeitsfuge von a nach b (amp in Ansichts-mm) */
export function zigzag(a: V2, b: V2, amp: number, teeth = 3): V2[] {
  const L = dist(a, b); if (L < 1e-6) return [a, b];
  const d = norm(sub(b, a)), n = perp(d);
  const k = teeth * 2; const out: V2[] = [a];
  for (let i = 1; i < k; i++) out.push(add(add(a, mul(d, (L * i) / k)), mul(n, i % 2 ? amp : -amp)));
  out.push(b);
  return out;
}

/** Kernbohrungssymbol: Kreis mit Schrägstrich (wie Ø) */
export function coreSymbol(dl: DisplayList, c: V2, r: number, pen: Pen, extra: Record<string, any> = {}): void {
  dl.circle(c, r, pen, { color: '#ffffff' }, extra);
  const d = fromAngle(Math.PI / 4, r * 1.45);
  dl.line(sub(c, d), add(c, d), pen, { ns: true, ...extra });
}

// ------------------------------------------------------------ Kategorien additiv erweitern
/** Eigenschaften einer bestehenden Kategorie ergänzen (Original bleibt erhalten) */
export function extendProps(cat: string, fn: (el: El, doc: Doc) => PropDef[]): void {
  const def = catDef(cat); if (!def) return;
  const orig = def.props;
  def.props = (el, doc) => [...(orig ? orig(el, doc) : []), ...fn(el, doc)];
}
type SField = { key: string; label: string; get: (el: El, doc: Doc) => any; unit?: 'len' | 'area' | 'vol' | 'kg' | 'num' };
export function extendScheduleFields(cat: string, fields: () => SField[]): void {
  const def = catDef(cat); if (!def) return;
  const orig = def.scheduleFields;
  def.scheduleFields = () => [...(orig ? orig() : []), ...fields()];
}

// ------------------------------------------------------------ Vorlagentypen
/** Typen/Materialien ergänzen, falls sie fehlen (in Transaktion aufrufen) */
export function addMissing(doc: Doc, els: El[]): void { for (const e of els) if (!doc.get(e.id)) doc.add(e); }
/** Vor Werkzeugstart: fehlende Vorlagentypen in eigener Transaktion anlegen */
export function ensureTemplate(doc: Doc, of: string, make: () => El[]): void {
  if (typesOf(doc, of).length) return;
  doc.transaction('Vorlagentypen ergänzen', () => addMissing(doc, make()));
}
export const lvlZ = (doc: Doc, el: El): number => levelElev(doc, el.levelId);
