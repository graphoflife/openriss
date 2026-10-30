// Stabbewehrung (Bewehrungssatz): Schenkelpolylinie des ersten Stabes in Weltkoordinaten + Haken,
// Verteilrichtung und Verlegeregel. Darstellung in jeder Ansicht: parallel → Stab(e) + Verteilungslinie,
// geschnitten → gefüllte Punkte Ø; 3D über achteckige Prismen. Positionsnummern, Längen, Gewichte.
import type { Doc, El, Id } from '../../../core/doc';
import {
  V2, V3, add, sub, mul, norm, perp, len, lerp, dist, offsetPolyline, add3, sub3, mul3, dot3, len3, norm3, cross3, lerp3,
} from '../../../core/geom';
import { registerCategory, GROUPS, PropDef, Grip, PlanCtx, SectionCtx, Solid, catDef } from '../../../core/registry';
import type { View } from '../../../core/view';
import { cached } from '../../../core/cache';
import { extrudeProfile } from '../../../views/sectionEngine';
import type { DisplayList } from '../../../render/displayList';
import type { Pen } from '../../../render/styles';
import { fmtNum, fmtLen } from '../../../core/units';
import { DIAS, kgPerM, bendR, fullPolyline, fillet, layoutOffsets, legLengths, barSignature, Layout, LAYOUT_LABELS, mandrel } from './math';
import { VF, vfOf, xfOfView, xfTranslate, Xf3, planFrame } from './frame';
import { refit, coverFor } from './build';
import { REBAR_COLOR, solidBox } from '../common';
import { planOf, currentPlan, rebarMandrel, rebarNorm } from './norm';
import type { Roll, Figure } from './sshv';
import { figureOf } from './sshv';

export type Display = 'first' | 'all' | 'firstLast' | 'middle';
export const DISPLAY_LABELS: [Display, string][] = [['first', 'Erster + Verteilungslinie'], ['all', 'Alle'], ['firstLast', 'Erster und letzter'], ['middle', 'Mittlerer']];
export const SHAPE_NAMES: Record<string, string> = { '00': 'Gerader Stab', '11': 'Winkel (L)', '21': 'U-Bügel / Steckbügel', '51': 'Bügel geschlossen', '99': 'Freiform (Skizze)' };
export const HOOK_OPTIONS: [string, string][] = [['0', 'Kein Haken'], ['90', 'Winkelhaken 90°'], ['135', 'Haken 135°'], ['180', 'Haken 180°']];

/** Einpass-Information (zum Neuberechnen bei Änderung von Ø/Deckung) */
export interface RebarFit { o: V3; r: V3; u: V3; d: V3; c: V2; kind: string; legLen: number; single?: boolean; slab?: 'u1' | 'u2' | 'o1' | 'o2'; orient?: 'par' | 'perp' }

export interface Rebar extends El {
  cat: 'rebar';
  hostId: Id;
  pos: number;
  dia: number;
  shape: string;
  pts: V3[];
  hookA?: number; hookB?: number; hookNA?: V3; hookNB?: V3;
  dir: V3;
  span: number;
  layout: Layout;
  count: number;
  spacing: number;
  /** Überdeckung-Überschreibung (sonst Bauteil/Projekt) */
  cover?: number;
  coverUsed?: number;
  display?: Display;
  fit?: RebarFit;
  /** Bewehrungsplan = Nummernkreis der Positionsnummer (z. B. 'T-205'); leer = Kommentar, falls Plannummer */
  plan?: string;
  /** Biegerolle: 'd3' (Standard 4 Ø / 7 Ø) oder 'd1' = 15 Ø */
  bendRoll?: Roll;
  /** Schraubanschluss (Muffe) an Anfang/Ende → Spezialbewehrung, ABS-Muffenblock */
  coupler?: Coupler;
  /** SSHV-Formnummer manuell (sonst aus der Geometrie erkannt) */
  form?: string;
}
export interface CouplerEnd { sys: string; type: string }
export interface Coupler { start?: CouplerEnd; end?: CouplerEnd }

// ------------------------------------------------------------ Geometrie
export interface RebarGeo { full: V3[]; path: V3[]; len: number; offs: number[]; n: number; legs: number[]; sig: string; code: string }
export function shapeCode(el: Rebar): string { return el.shape || '00'; }
export function rebarGeo(doc: Doc, el: Rebar): RebarGeo {
  const calc = (): RebarGeo => {
    const full = fullPolyline(el);
    const f = fillet(full, rebarMandrel(doc, el) / 2 + el.dia / 2);
    const offs = layoutOffsets(el.layout ?? 'single', el.count ?? 1, el.spacing ?? 150, el.span ?? 0);
    const code = shapeCode(el);
    return { full, path: f.path, len: f.len, offs, n: offs.length, legs: legLengths(full, el.dia), sig: barSignature(el.dia, full, code), code };
  };
  return el.id.startsWith('__') ? calc() : cached(doc, 'rebarGeo', el.id, calc);
}
export const rebarWeight = (doc: Doc, el: Rebar) => { const g = rebarGeo(doc, el); return (g.len * g.n / 1000) * kgPerM(el.dia); };
export function effSpacing(doc: Doc, el: Rebar): number { const o = rebarGeo(doc, el).offs; return o.length > 1 ? o[1] - o[0] : 0; }

/** nächste freie Positionsnummer im Bewehrungsplan; gleiche Stäbe im selben Plan erhalten dieselbe Nummer.
 *  Neue Sätze ohne `plan` erhalten den aktuellen Bewehrungsplan (el.plan wird gesetzt). */
export function assignPos(doc: Doc, el: Rebar): number {
  if (el.plan === undefined && currentPlan(doc)) el.plan = currentPlan(doc);
  const sig = rebarGeo(doc, { ...el, id: '__sig' } as Rebar).sig; const plan = planOf(el);
  for (const o of doc.all<Rebar>('rebar')) if (o.id !== el.id && planOf(o) === plan && rebarGeo(doc, o).sig === sig) return o.pos;
  return maxPos(doc, plan) + 1;
}
/** höchste Positionsnummer (plan angegeben: nur in diesem Bewehrungsplan) */
export function maxPos(doc: Doc, plan?: string): number {
  let m = 0;
  for (const o of doc.all<Rebar>('rebar')) if (plan === undefined || planOf(o) === plan) m = Math.max(m, o.pos ?? 0);
  for (const a of doc.all('areaRebar')) if (plan === undefined || planOf(a) === plan) for (const l of a.layers ?? []) m = Math.max(m, l.pos ?? 0);
  return m;
}

// ------------------------------------------------------------ Ansicht
export interface RebarView { lines: V2[][]; dots: V2[]; dist: { a: V2; b: V2; ticks: V2[] } | null; anchor: V2 | null; rep: number; degenerate: boolean }

export function rebarInView(doc: Doc, el: Rebar, vf: VF): RebarView {
  const g = rebarGeo(doc, el);
  const toV = (p: V3): V2 => { const q = sub3(p, vf.origin); return { x: dot3(q, vf.right), y: dot3(q, vf.up) }; };
  const dep = (p: V3) => dot3(sub3(p, vf.origin), vf.dir);
  const dir = el.dir ?? { x: 0, y: 0, z: 1 };
  const kd = dot3(dir, vf.dir);
  const dv = { x: dot3(dir, vf.right), y: dot3(dir, vf.up) };
  const p2 = g.path.map(toV), dp = g.path.map(dep);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of p2) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const degenerate = Math.max(x1 - x0, y1 - y0) < Math.max(2 * el.dia, 5);
  const res: RebarView = { lines: [], dots: [], dist: null, anchor: null, rep: 0, degenerate };
  const dmin = Math.min(...dp), dmax = Math.max(...dp);
  const at = (k: number, u: number, t: number): V2 => add(lerp(p2[k], p2[k + 1], u), mul(dv, t));
  if (degenerate) {
    for (const t of g.offs) {
      const s = t * kd;
      for (let k = 0; k + 1 < dp.length; k++) {
        const da = dp[k] + s, db = dp[k + 1] + s;
        if ((da < 0) !== (db < 0)) res.dots.push(at(k, da / (da - db), t));
      }
    }
    if (res.dots.length) res.anchor = res.dots[Math.floor(res.dots.length / 2)];
    return res;
  }
  // sichtbare Stäbe (innerhalb der Ansichtstiefe), nach Tiefe sortiert
  const vis = g.offs.map((t, i) => ({ t, i, lo: dmin + t * kd })).filter((b) => b.lo - dmin + dmax >= vf.near && b.lo <= vf.far);
  vis.sort((a, b) => Math.round(a.lo) - Math.round(b.lo) || a.i - b.i);
  if (!vis.length) return res;
  const disp = el.display ?? 'first';
  let shown = vis;
  if (disp === 'first') shown = [vis[0]];
  else if (disp === 'firstLast') shown = vis.length > 1 ? [vis[0], vis[vis.length - 1]] : [vis[0]];
  else if (disp === 'middle') shown = [vis[Math.floor(vis.length / 2)]];
  res.rep = shown[0].t;
  for (const b of shown) {
    const s = b.t * kd; let cur: V2[] = [];
    const flush = () => { if (cur.length > 1) res.lines.push(cur); cur = []; };
    for (let k = 0; k + 1 < dp.length; k++) {
      const da = dp[k] + s, db = dp[k + 1] + s;
      let u0 = 0, u1 = 1;
      const clip = (lim: number, keepAbove: boolean) => {
        const fa = keepAbove ? da - lim : lim - da, fb = keepAbove ? db - lim : lim - db;
        if (fa < 0 && fb < 0) { u0 = 2; return; }
        if (fa < 0) u0 = Math.max(u0, fa / (fa - fb));
        else if (fb < 0) u1 = Math.min(u1, fa / (fa - fb));
      };
      clip(vf.near, true); clip(vf.far, false);
      if (u0 >= u1) { flush(); continue; }
      const a = at(k, u0, b.t), c = at(k, u1, b.t);
      if (!cur.length) cur.push(a);
      else if (dist(cur[cur.length - 1], a) > 0.01) { flush(); cur.push(a); }
      cur.push(c);
      if (u1 < 1) flush();
    }
    flush();
  }
  res.lines = res.lines.filter((l) => { let L = 0; for (let i = 1; i < l.length; i++) L += dist(l[i - 1], l[i]); return L > Math.max(el.dia * 0.5, 1); });
  // Verteilungslinie
  if (g.n > 1 && disp !== 'all' && len(dv) > 0.3) {
    const m3 = pathCenter(g.path); const m2 = toV(m3);
    const a = add(m2, mul(dv, g.offs[0])), b = add(m2, mul(dv, g.offs[g.n - 1]));
    res.dist = { a, b, ticks: g.offs.map((t) => add(m2, mul(dv, t))) };
  }
  if (res.lines.length) res.anchor = pointAtHalf2(res.lines[0]);
  else if (res.dist) res.anchor = lerp(res.dist.a, res.dist.b, 0.5);
  return res;
}

/** Mitte der Bounding-Box des Stabes (Lage der Verteilungslinie) */
export function pathCenter(path: V3[]): V3 {
  const lo = { ...path[0] }, hi = { ...path[0] };
  for (const p of path) { lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z); hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z); }
  return mul3(add3(lo, hi), 0.5);
}
export function pointAtHalf(path: V3[]): V3 {
  let L = 0; for (let i = 1; i < path.length; i++) L += len3(sub3(path[i], path[i - 1]));
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const l = len3(sub3(path[i], path[i - 1]));
    if (acc + l >= L / 2 && l > 0) return lerp3(path[i - 1], path[i], (L / 2 - acc) / l);
    acc += l;
  }
  return path[0];
}
function pointAtHalf2(path: V2[]): V2 {
  let L = 0; for (let i = 1; i < path.length; i++) L += dist(path[i], path[i - 1]);
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const l = dist(path[i], path[i - 1]);
    if (acc + l >= L / 2 && l > 0) return lerp(path[i - 1], path[i], (L / 2 - acc) / l);
    acc += l;
  }
  return path[0];
}

/** Bewehrungssatz in die Display-Liste zeichnen */
export function drawRebar(dl: DisplayList, doc: Doc, el: Rebar, vf: VF, color?: string): RebarView {
  const rv = rebarInView(doc, el, vf);
  const col = color ?? '#000000';
  const s = vf.scale;
  const thick: Pen = { w: 6, color: col }, thin: Pen = { w: 1, color: col };
  for (const l of rv.lines) {
    if (vf.detail === 'fine') {
      const a = offsetPolyline(l, el.dia / 2), b = offsetPolyline(l, -el.dia / 2);
      dl.poly(a, thin); dl.poly(b, thin);
      dl.line(a[0], b[0], thin, { ns: true }); dl.line(a[a.length - 1], b[b.length - 1], thin, { ns: true });
      dl.poly(l, thin, false, { inv: true });
    } else dl.poly(l, thick);
  }
  const r = Math.max(el.dia / 2, 0.3 * s);
  for (const p of rv.dots) dl.circle(p, r, vf.detail === 'fine' ? thin : undefined, { color: col });
  if (rv.dist) {
    const { a, b, ticks } = rv.dist;
    const dlen = dist(a, b); const d = norm(sub(b, a)); const n = perp(d);
    dl.line(a, b, thin, { ns: true });
    const tk = 1.2 * s; const diag = norm(add(d, n));
    for (const q of [a, b]) {
      dl.line(sub(q, mul(n, tk * 1.5)), add(q, mul(n, tk * 1.5)), thin, { ns: true });
      dl.line(sub(q, mul(diag, tk)), add(q, mul(diag, tk)), { w: 2, color: col }, { ns: true });
    }
    if (ticks.length > 2 && dlen / (ticks.length - 1) >= 1.2 * s) for (const q of ticks.slice(1, -1)) dl.line(sub(q, mul(n, tk * 0.6)), add(q, mul(n, tk * 0.6)), thin, { ns: true });
  }
  return rv;
}

// ------------------------------------------------------------ 3D
const OCT: V2[] = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos((i * Math.PI) / 4 + Math.PI / 8), y: Math.sin((i * Math.PI) / 4 + Math.PI / 8) }));
function rebarSolids(doc: Doc, el: Rebar): Solid[] {
  const g = rebarGeo(doc, el);
  const prof = OCT.map((q) => mul(q, el.dia / 2));
  const faces = [];
  const segs: { o: V3; d: V3; L: number; u: V3; v: V3 }[] = [];
  for (let k = 0; k + 1 < g.path.length; k++) {
    const a = g.path[k], b = g.path[k + 1]; const L = len3(sub3(b, a)); if (L < 0.5) continue;
    const d = mul3(sub3(b, a), 1 / L);
    const ref = Math.abs(d.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const u = norm3(cross3(d, ref)); const v = cross3(d, u);
    segs.push({ o: a, d, L, u, v });
  }
  const dir = el.dir ?? { x: 0, y: 0, z: 1 };
  const maxBars = 400;
  for (const t of g.offs.slice(0, maxBars)) {
    const sh = mul3(dir, t);
    for (const s of segs) faces.push(...extrudeProfile(prof, add3(s.o, sh), s.u, s.v, s.d, s.L));
  }
  return [{ faces, mat: 'm_betonstahl', color: REBAR_COLOR, role: 'rebar' }];
}

// ------------------------------------------------------------ Transformation
export function xfRebar(el: Rebar, X: Xf3, keepFit: boolean): Partial<Rebar> {
  const nv = (v: V3 | undefined) => (v ? norm3(X.v(v)) : v);
  const p: Partial<Rebar> = { pts: el.pts.map((q) => X.p(q)), dir: norm3(X.v(el.dir)), hookNA: nv(el.hookNA), hookNB: nv(el.hookNB) };
  if (el.fit && keepFit) p.fit = { ...el.fit, o: X.p(el.fit.o), r: X.v(el.fit.r), u: X.v(el.fit.u), d: X.v(el.fit.d) };
  else p.fit = undefined;
  return p;
}

// ------------------------------------------------------------ Eigenschaften
export function hostLabel(doc: Doc, id: Id | undefined): string {
  const h = doc.get(id); if (!h) return '–';
  const def = catDef(h.cat); const t = doc.get(h.typeId);
  return `${def?.label ?? h.cat}${t ? ': ' + t.name : ''}${h.mark ? ' (' + h.mark + ')' : ''}`;
}
const m2 = (mm: number) => fmtNum(mm / 1000, 2) + ' m';

function rebarProps(): PropDef[] {
  const g = GROUPS.rebar, gi = GROUPS.identity, gc = GROUPS.constraints;
  const withRefit = (doc: Doc, e: El, patch: Partial<Rebar>) => refit(doc, e as Rebar, patch);
  return [
    { key: 'pos', label: 'Positionsnummer', group: g, type: 'int', get: (e) => e.pos, set: (_e, v) => (v > 0 ? { pos: v } : undefined) },
    { key: 'dia', label: 'Stabdurchmesser Ø', group: g, type: 'select', options: DIAS.map((d) => [String(d), 'Ø ' + d + ' mm'] as [string, string]), get: (e) => String(e.dia), set: (e, v, doc) => withRefit(doc, e, { dia: Number(v) }) },
    { key: 'shape', label: 'Biegeform', group: g, type: 'readonly', get: (e) => `${e.shape} – ${SHAPE_NAMES[e.shape] ?? ''}${e.hookA || e.hookB ? ' mit Haken' : ''}` },
    { key: 'layout', label: 'Layoutregel', group: g, type: 'select', options: LAYOUT_LABELS, get: (e) => e.layout, set: (e, v, doc) => (e.layout === 'single' || v === 'single' ? withRefit(doc, e, { layout: v }) : { layout: v }) },
    { key: 'count', label: 'Anzahl', group: g, type: 'int', get: (e, doc) => rebarGeo(doc, e as Rebar).n, set: (e, v, doc) => {
      if (!(v >= 1)) return;
      if (e.layout === 'count' || e.layout === 'countSpacing') return { count: v };
      if (e.layout === 'maxSpacing') return { layout: 'count', count: v };
      return v > 1 ? withRefit(doc, e, { layout: 'count', count: v }) : undefined;
    } },
    { key: 'spacing', label: 'Abstand', group: g, type: 'length', get: (e, doc) => (e.layout === 'single' ? 0 : e.layout === 'count' ? effSpacing(doc, e as Rebar) : e.spacing), set: (e, v, doc) => {
      if (!(v > 0)) return;
      if (e.layout === 'maxSpacing' || e.layout === 'countSpacing') return { spacing: v };
      if (e.layout === 'count') return { layout: 'maxSpacing', spacing: v };
      return withRefit(doc, e, { layout: 'maxSpacing', spacing: v });
    } },
    { key: 'span', label: 'Verteillänge', group: g, type: 'length', get: (e) => e.span ?? 0, set: (_e, v) => (v >= 0 ? { span: v, fit: undefined } : undefined) },
    { key: 'display', label: 'Darstellung', group: GROUPS.graphics, type: 'select', options: DISPLAY_LABELS, get: (e) => e.display ?? 'first', set: (_e, v) => ({ display: v }) },
    { key: 'hookA', label: 'Haken am Anfang', group: g, type: 'select', options: HOOK_OPTIONS, get: (e) => String(e.hookA ?? 0), set: (e, v, doc) => hookPatch(doc, e as Rebar, 'A', Number(v)) },
    { key: 'hookB', label: 'Haken am Ende', group: g, type: 'select', options: HOOK_OPTIONS, get: (e) => String(e.hookB ?? 0), set: (e, v, doc) => hookPatch(doc, e as Rebar, 'B', Number(v)) },
    { key: 'mandrel', label: 'Biegerollendurchmesser', group: g, type: 'readonly', get: (e) => fmtLen(mandrel(e.dia)) + ' mm' },
    { key: 'len', label: 'Einzellänge', group: GROUPS.dims, type: 'readonly', get: (e, doc) => m2(rebarGeo(doc, e as Rebar).len) },
    { key: 'total', label: 'Gesamtlänge', group: GROUPS.dims, type: 'readonly', get: (e, doc) => { const g2 = rebarGeo(doc, e as Rebar); return m2(g2.len * g2.n); } },
    { key: 'weight', label: 'Gewicht', group: GROUPS.dims, type: 'readonly', get: (e, doc) => fmtNum(rebarWeight(doc, e as Rebar), 2) + ' kg' },
    { key: 'cover', label: 'Überdeckung', group: gc, type: 'length', get: (e, doc) => e.cover ?? coverFor(doc, doc.get(e.hostId)), set: (e, v, doc) => withRefit(doc, e, { cover: v > 0 ? v : undefined }) },
    { key: 'host', label: 'Host', group: gc, type: 'readonly', get: (e, doc) => hostLabel(doc, e.hostId) },
    { key: 'fitted', label: 'An Bauteil angepasst', group: gc, type: 'readonly', get: (e) => (e.fit ? 'Ja' : 'Nein (frei)') },
    { key: 'mark', label: 'Kennzeichen', group: gi, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: gi, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

/** Standard-Hakenrichtung: senkrecht zu Stab und Verteilrichtung, zum Bauteilinneren */
function hookPatch(doc: Doc, el: Rebar, end: 'A' | 'B', ang: number): Partial<Rebar> {
  const p: Partial<Rebar> = end === 'A' ? { hookA: ang } : { hookB: ang };
  const key = end === 'A' ? 'hookNA' : 'hookNB';
  if (ang && !el[key]) {
    const m = el.pts.length;
    const t = end === 'A' ? norm3(sub3(el.pts[0], el.pts[1])) : norm3(sub3(el.pts[m - 1], el.pts[m - 2]));
    let n = norm3(cross3(t, el.dir));
    if (len3(n) < 0.5) n = norm3(cross3(t, { x: 0, y: 0, z: 1 }));
    const hb = doc.get(el.hostId);
    const E = end === 'A' ? el.pts[0] : el.pts[m - 1];
    const c = hb ? hostCenter(doc, hb) : null;
    if (c && dot3(n, sub3(c, E)) < 0) n = mul3(n, -1);
    (p as any)[key] = n;
  }
  return el.fit ? refit(doc, el, p) : p;
}
function hostCenter(doc: Doc, h: El): V3 | null {
  const b = solidBox(doc, h); return b ? mul3(add3(b.min, b.max), 0.5) : null;
}

// ------------------------------------------------------------ Griffe
function rebarGrips(doc: Doc, el: Rebar, view: View): Grip[] {
  const vf = vfOf(doc, view); if (!vf) return [];
  const rv = rebarInView(doc, el, vf);
  if (rv.degenerate || !rv.lines.length) return [];
  const t = rv.rep; const out: Grip[] = [];
  const toV = (p: V3): V2 => { const q = sub3(p, vf.origin); return { x: dot3(q, vf.right), y: dot3(q, vf.up) }; };
  const P = (i: number) => toV(add3(el.pts[i], mul3(el.dir, t)));
  if (el.shape !== '51' && el.pts.length >= 2) {
    const idx = el.shape === '99' ? el.pts.map((_, i) => i) : [0, el.pts.length - 1];
    for (const i of idx) {
      const nb = i === 0 ? 1 : i - 1;
      if (dist(P(i), P(nb)) < 1) continue;
      out.push({ id: 'v' + i, p: P(i), kind: 'end', tip: 'Stabende ziehen' });
    }
  }
  if (rv.dist && (el.layout === 'count' || el.layout === 'maxSpacing')) out.push({ id: 'span', p: rv.dist.b, kind: 'end', tip: 'Verteillänge ändern' });
  return out;
}
function rebarDragGrip(doc: Doc, el: Rebar, id: string, p: V2, view: View): Partial<Rebar> | void {
  const vf = vfOf(doc, view); if (!vf) return;
  const rv = rebarInView(doc, el, vf); const t = rv.rep;
  const dep = (q: V3) => dot3(sub3(q, vf.origin), vf.dir);
  const world = (q: V2, d: number): V3 => add3(add3(add3(vf.origin, mul3(vf.right, q.x)), mul3(vf.up, q.y)), mul3(vf.dir, d));
  if (id === 'span') {
    const g = rebarGeo(doc, el); const m3 = pathCenter(g.path);
    const ref = add3(m3, mul3(el.dir, g.offs[g.n - 1] ?? 0));
    const w = world(p, dep(ref));
    return { span: Math.max(0, Math.round(dot3(sub3(w, m3), el.dir))), fit: undefined };
  }
  if (!id.startsWith('v')) return;
  const i = parseInt(id.slice(1), 10); if (!(i >= 0 && i < el.pts.length)) return;
  const orig = add3(el.pts[i], mul3(el.dir, t));
  let w = sub3(world(p, dep(orig)), mul3(el.dir, t));
  if (el.shape !== '99' && el.pts.length >= 2) {
    const nb = el.pts[i === 0 ? 1 : i - 1];
    const ld = norm3(sub3(el.pts[i], nb));
    w = add3(nb, mul3(ld, Math.max(10, Math.round(dot3(sub3(w, nb), ld)))));
  }
  const pts = el.pts.slice(); pts[i] = w;
  return { pts, fit: undefined };
}

// ------------------------------------------------------------ Kategorie
registerCategory({
  cat: 'rebar', label: 'Tragwerksbewehrung', plural: 'Tragwerksbewehrung', planOrder: 80, sectionOnlyCustom: true,
  hostCats: ['wall', 'floor', 'column', 'beam', 'foundationIsolated', 'foundationWall', 'foundationSlab', 'stair'],
  drawPlan: (ctx: PlanCtx, el) => {
    if (ctx.view.kind !== 'plan') return;
    const vf = vfOf(ctx.doc, ctx.view); if (!vf) return;
    drawRebar(ctx.dl, ctx.doc, el as Rebar, vf);
  },
  drawSection: (ctx: SectionCtx, el) => {
    if (ctx.view.kind !== 'section') return;
    const vf = vfOf(ctx.doc, ctx.view); if (!vf) return;
    drawRebar(ctx.dl, ctx.doc, el as Rebar, vf);
  },
  visibleIn: (_el, _doc, view) => view.kind !== 'elevation' && view.kind !== 'ceiling',
  solids: (el, doc) => rebarSolids(doc, el as Rebar),
  center: (el, doc, view) => { const vf = vfOf(doc, view); return vf ? rebarInView(doc, el as Rebar, vf).anchor : null; },
  tagPoint: (el, doc, view) => { const vf = vfOf(doc, view); return vf ? rebarInView(doc, el as Rebar, vf).anchor : null; },
  tagText: (el, doc) => rebarLabel(doc, el as Rebar, 'std'),
  grips: (el, doc, view) => rebarGrips(doc, el as Rebar, view),
  dragGrip: (el, id, p, doc, view) => rebarDragGrip(doc, el as Rebar, id, p, view),
  transform: (el, m, _doc, view) => { const X = xfOfView(m, view); return X ? xfRebar(el as Rebar, X, false) : undefined; },
  translate3d: (el, d) => xfRebar(el as Rebar, xfTranslate(d), false),
  props: () => rebarProps(),
  scheduleFields: () => [
    { key: 'pos', label: 'Position', get: (el) => el.pos },
    { key: 'dia', label: 'Ø', get: (el) => el.dia },
    { key: 'shape', label: 'Biegeform', get: (el) => el.shape },
    { key: 'count', label: 'Anzahl', unit: 'num', get: (el, doc) => rebarGeo(doc, el as Rebar).n },
    { key: 'barLen', label: 'Einzellänge', unit: 'len', get: (el, doc) => rebarGeo(doc, el as Rebar).len },
    { key: 'totalLen', label: 'Gesamtlänge', unit: 'len', get: (el, doc) => { const g = rebarGeo(doc, el as Rebar); return g.len * g.n; } },
    { key: 'weight', label: 'Gewicht', unit: 'kg', get: (el, doc) => rebarWeight(doc, el as Rebar) },
    { key: 'host', label: 'Host', get: (el, doc) => hostLabel(doc, el.hostId) },
  ],
});

// ------------------------------------------------------------ Beschriftungstexte
export type TagFmt = 'std' | 'long' | 'short' | 'count' | 'ch';
export const TAG_FORMATS: [TagFmt, string][] = [['std', '12 Ø10 - 15  ③'], ['long', '③ 12 Ø10 a=15 l=2,35'], ['short', '③ Ø10'], ['count', '12 Ø10'], ['ch', '③ 12 Ø10 s=150 L=2.35 F21 (Schweiz)']];
const cm = (mm: number) => fmtNum(mm / 10, mm % 10 ? 1 : 0);
/** Text ohne Positionskreis; Positionsnummer separat */
export function rebarLabel(doc: Doc, el: Rebar, fmt: TagFmt): string {
  const g = rebarGeo(doc, el); const s = effSpacing(doc, el);
  const n = g.n, d = el.dia;
  switch (fmt) {
    case 'std': return `${n} Ø${d}${n > 1 && s > 0 ? ' - ' + cm(s) : ''}`;
    case 'long': return `${n} Ø${d}${n > 1 && s > 0 ? ' a=' + cm(s) : ''} l=${fmtNum(g.len / 1000, 2)}`;
    case 'short': return `Ø${d}`;
    case 'count': return `${n} Ø${d}`;
    case 'ch': {
      // SSHV-Formnummer und Länge wie Eisenliste (SIA: abgewickelte Länge = Σ Aussenmasse)
      const f = chFigure(doc, el);
      const L = rebarNorm(doc) === 'SIA' ? f.legs.reduce((a, l) => a + Math.round(l), 0) : g.len;
      return `${n} Ø${d}${n > 1 && s > 0 ? ' s=' + Math.round(s) : ''} L=${(L / 1000).toFixed(2)}${f.nr && f.nr !== '1' ? ' F' + f.nr : ''}`; // gerade Stäbe (Form 1) ohne Formangabe wie T-205
    }
  }
}
/** SSHV-Figur des Satzes – gleiche Berechnung und gleicher Cache wie rebarFigure() in steel.ts
 *  (dort nicht importiert: steel.ts → area.ts → tag.ts würde einen Importzyklus beim Laden auslösen) */
function chFigure(doc: Doc, el: Rebar): Figure {
  const calc = () => figureOf(rebarGeo(doc, el).full, el.dia, rebarMandrel(doc, el), { nr: el.form, d1: el.bendRoll === 'd1' });
  return el.id.startsWith('__') ? calc() : cached(doc, 'rebarFigure', el.id, calc);
}

export { planFrame };
