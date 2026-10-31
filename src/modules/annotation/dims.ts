// Bemaßungen: ausgerichtete / lineare Maßketten (im Grundriss assoziativ zu Wänden, Öffnungen,
// Rastern, Linien), Winkel-, Radius- und Bogenlängenbemaßung. Deutsche Darstellung: Text über der
// Maßlinie, Schrägstriche, Maßhilfslinien mit Abstand und Überstand.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, add, sub, mul, dot, norm, perp, dist, len, lerp, mid, cross, angleOf, fromAngle, normAngle, distToSeg,
  lineLine, apply, applyVec, Mat2, projectT, sideDist, clamp, bboxOf, eq,
} from '../../core/geom';
import { registerCategory, catDef, PropDef, GROUPS, Grip } from '../../core/registry';
import { View, isPlanLike, makeProjector, Level, annoViewId, annoIn } from '../../core/view';
import { DisplayList, textWidth } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtLen, fmtAngle, LengthUnit } from '../../core/units';
import { Wall, wallInfo, layerOffsets, wallShape } from '../../elements/wall';
import { hostedBy } from '../../core/cache';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { modal } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { drawTick, TickKind, readable, tint, PREV_COL, ANNO_KINDS, fontFamily, TICK_OPTIONS, FONTS, myPlacement } from './common';
import { DIM_ARROW, defaultDimType } from './types';
import { fmtDimLen, DimUnit, DecSep, SupMode } from './numfmt';

// ------------------------------------------------------------ Datenmodell
export interface ArcG { c: V2; r: number; a0: number; a1: number }
/** Referenz einer Bemaßung: Element-ID + Unterreferenz; a/b/p/arc = gespeicherte Geometrie (Rückfall / punktbasiert) */
export interface DimRef { id?: Id; sub?: string; side?: number; i?: number; a?: V2; b?: V2; p?: V2; arc?: ArcG }
export type G = { k: 'seg'; a: V2; b: V2 } | { k: 'pt'; p: V2 } | ({ k: 'arc' } & ArcG);
export interface Dim extends El {
  cat: 'dimension';
  viewId: Id;
  kind: 'linear' | 'angular' | 'radial' | 'arc';
  aligned?: boolean;
  refs: DimRef[];
  /** linear: Messrichtung und Punkt auf der Maßlinie */
  dir?: V2; line?: V2;
  /** Winkel/Radius/Bogen: Lage der Maßlinie bzw. des Textes */
  pt?: V2;
  /** je Segment: Wert ersetzen, Textverschiebung */
  over?: (string | null)[];
  tOff?: (V2 | null)[];
  prefix?: string; suffix?: string;
}

// ------------------------------------------------------------ Referenzgeometrie
const FAR = 1e6;

function wallOffsets(doc: Doc, w: Wall) {
  const wi = wallInfo(doc, w); const L = layerOffsets(doc, w);
  const core = L.filter((l) => l.lay.core);
  const hasCore = core.length > 0 && L.length > 1;
  const cMin = hasCore ? Math.min(...core.map((c) => c.o0)) : -wi.T / 2;
  const cMax = hasCore ? Math.max(...core.map((c) => c.o1)) : wi.T / 2;
  const bounds = [...new Set(L.flatMap((l) => [l.o0, l.o1]).map((v) => Math.round(v * 1000) / 1000))]
    .filter((v) => Math.abs(Math.abs(v) - wi.T / 2) > 0.01).sort((a, b) => a - b);
  return { wi, cMin, cMax, bounds, hasCore };
}

export function wallRefGeom(doc: Doc, w: Wall, r: DimRef): G | null {
  const o = wallOffsets(doc, w); const wi = o.wi;
  if (wi.L < 1) return null;
  const line = (off: number): G => ({ k: 'seg', a: add(wi.c0, mul(wi.n, off)), b: add(wi.c1, mul(wi.n, off)) });
  const s = r.side ?? 1;
  switch (r.sub) {
    case 'face': return line((s * wi.T) / 2);
    case 'center': return line(0);
    case 'core': return line(s > 0 ? o.cMax : o.cMin);
    case 'coreC': return line((o.cMin + o.cMax) / 2);
    case 'layer': { const v = o.bounds[r.i ?? 0]; return v === undefined ? null : line(v); }
    case 'end': {
      const sh = wallShape(doc, w);
      const us = (s === 0 ? [sh.A.L, sh.A.R] : [sh.B.L, sh.B.R]).map((p) => dot(sub(p, wi.c0), wi.d));
      const u = s === 0 ? Math.min(...us) : Math.max(...us);
      const p = add(wi.c0, mul(wi.d, u));
      return { k: 'seg', a: add(p, mul(wi.n, -wi.T / 2)), b: add(p, mul(wi.n, wi.T / 2)) };
    }
  }
  return null;
}

function openingRefGeom(doc: Doc, el: El, r: DimRef): G | null {
  const host = doc.get<Wall>(el.hostId);
  const ho = catDef(el.cat)?.hostOpening?.(el, doc);
  if (!host || host.cat !== 'wall' || !ho) return null;
  const wi = wallInfo(doc, host);
  const u = r.sub === 'oc' ? (ho.u0 + ho.u1) / 2 : r.side === 1 ? ho.u1 : ho.u0;
  const p = add(wi.c0, mul(wi.d, u));
  return { k: 'seg', a: add(p, mul(wi.n, -wi.T / 2)), b: add(p, mul(wi.n, wi.T / 2)) };
}

function gridSectionSeg(view: View, g: El): G | null {
  const pr = makeProjector(view);
  const o = { x: pr.origin.x, y: pr.origin.y }; const right = { x: pr.right.x, y: pr.right.y };
  const x = lineLine(g.a, g.b, o, add(o, right)); if (!x) return null;
  const vx = pr.toView({ x: x.p.x, y: x.p.y, z: 0 }).x;
  return { k: 'seg', a: { x: vx, y: -FAR }, b: { x: vx, y: FAR } };
}

function elemRefGeom(doc: Doc, view: View, el: El, r: DimRef): G | null {
  switch (r.sub) {
    case 'face': case 'center': case 'core': case 'coreC': case 'layer': case 'end':
      return el.cat === 'wall' ? wallRefGeom(doc, el as Wall, r) : null;
    case 'jamb': case 'oc': return openingRefGeom(doc, el, r);
    case 'level': {
      if (el.cat !== 'level') return null;
      const y = (el as Level).elev - makeProjector(view).origin.z;
      return { k: 'seg', a: { x: -FAR, y }, b: { x: FAR, y } };
    }
    case 'gridS': return el.cat === 'grid' ? gridSectionSeg(view, el) : null;
    case 'line': return el.a && el.b && !el.arc ? { k: 'seg', a: el.a, b: el.b } : null;
    case 'a': return el.a ? { k: 'pt', p: el.a } : null;
    case 'b': return el.b ? { k: 'pt', p: el.b } : null;
    case 'c': return el.arc ? { k: 'pt', p: el.arc.c } : null;
    case 'arc': return el.arc ? { k: 'arc', ...el.arc } : null;
    case 'curve': { const c = catDef(el.cat)?.curve?.(el, doc, view); return c ? { k: 'seg', a: c.a, b: c.b } : null; }
  }
  return null;
}

/** Aktuelle Geometrie einer Referenz; null = Element gelöscht (Segment entfällt) */
export function refGeom(doc: Doc, view: View, r: DimRef): G | null {
  if (r.id) {
    const el = doc.get(r.id);
    if (!el) return null;
    const g = elemRefGeom(doc, view, el, r);
    if (g) return g;
  }
  if (r.arc) return { k: 'arc', ...r.arc };
  if (r.a && r.b) return { k: 'seg', a: r.a, b: r.b };
  if (r.p) return { k: 'pt', p: r.p };
  return null;
}
const repPt = (g: G): V2 => (g.k === 'seg' ? mid(g.a, g.b) : g.k === 'pt' ? g.p : g.c);

// ------------------------------------------------------------ Stil (Typ)
interface DimStyle {
  tick: TickKind; tickSize: number; tickW: number; lineW: number; color: string; size: number; font: string;
  textGap: number; wGap: number; wExt: number; dimExt: number; unit: string; dec: number; opaque: boolean; bold: boolean;
  /** Dezimaltrennzeichen und hochgestellte mm-Stelle (fehlt = Projekteinstellung, wie bisher) */
  sep: DecSep; sup?: SupMode;
}
function dimStyle(doc: Doc, el: El): DimStyle {
  const t: any = doc.get(el.typeId) ?? {};
  const n = (v: any, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
  return {
    tick: t.tick ?? 'slash', tickSize: n(t.tickSize, 2.5), tickW: n(t.tickW, 5), lineW: n(t.lineW, 1), color: t.color || '#000000',
    size: n(t.size, 2.5), font: t.font ?? 'Arial', textGap: n(t.textGap, 0.7), wGap: n(t.wGap, 1.5), wExt: n(t.wExt, 1.5),
    dimExt: n(t.dimExt, 1.5), unit: t.unit ?? '', dec: n(t.dec, 2), opaque: !!t.opaque, bold: !!t.bold,
    sep: t.sep === '.' ? '.' : ',', sup: t.sup || undefined,
  };
}
const isArrow = (k: TickKind) => k === 'arrow' || k === 'arrowOpen';
function fmtVal(st: DimStyle, v: number): string {
  // neue Formatierung (Typ mit Hochstellung oder Einheit «CH»), sonst wie bisher über die Projekteinheiten
  if (st.sup || st.unit === 'ch') return fmtDimLen(v, st.unit as DimUnit, st.dec, st.sep, st.sup ?? 'none');
  const s = st.unit ? fmtLen(v, st.unit as LengthUnit, st.dec) : fmtLen(v);
  return st.sep === '.' ? s.replace(',', '.') : s;
}
function defPrefix(el: Dim): string { return el.prefix ?? (el.kind === 'radial' ? 'R ' : el.kind === 'arc' ? '⌒ ' : ''); }
function finalText(el: Dim, i: number, val: string): string {
  const o = el.over?.[i];
  return defPrefix(el) + (o ? o : val) + (el.suffix ?? '');
}
function textFont(st: DimStyle, rot: number, va: 'bottom' | 'top' | 'middle' = 'bottom') {
  return { size: st.size, rot, ha: 'center' as const, va, color: st.color, family: fontFamily(st.font), opaque: st.opaque, bold: st.bold };
}

// ------------------------------------------------------------ Lineare Bemaßung (Kette)
interface LinPt { anchor: V2; P: V2; c: number }
interface LinLayout { dir: V2; w: V2; L0: V2; pts: LinPt[]; td: { ang: number; dir: V2; up: V2 } }

function anchorOf(g: G, L0: V2, w: V2): V2 {
  if (g.k === 'pt') return g.p;
  if (g.k === 'arc') return g.c;
  const sa = dot(sub(g.a, L0), w), sb = dot(sub(g.b, L0), w);
  if (Math.abs(sb - sa) < 1e-6) return mid(g.a, g.b);
  return lerp(g.a, g.b, clamp(-sa / (sb - sa), 0, 1));
}

export function linearLayout(doc: Doc, view: View, el: Dim): LinLayout | null {
  if (!el.dir || !el.line) return null;
  const dir = norm(el.dir); const L0 = el.line; const w = perp(dir);
  if (len(dir) < 0.5) return null;
  const pts: LinPt[] = [];
  for (const r of el.refs ?? []) {
    const g = refGeom(doc, view, r); if (!g) continue;
    const a = anchorOf(g, L0, w); const c = dot(a, dir);
    pts.push({ anchor: a, c, P: add(L0, mul(dir, c - dot(L0, dir))) });
  }
  pts.sort((p, q) => p.c - q.c);
  const out: LinPt[] = [];
  for (const p of pts) if (!out.length || Math.abs(p.c - out[out.length - 1].c) > 0.05) out.push(p);
  return out.length >= 2 ? { dir, w, L0, pts: out, td: readable(dir) } : null;
}

/** Textposition eines Segments (ohne/mit Verschiebung) */
function segTextPos(lay: LinLayout, st: DimStyle, s: number, i: number, txt: string, off: V2 | null | undefined): { p: V2; base: V2 } {
  const P0 = lay.pts[i].P, P1 = lay.pts[i + 1].P; const m = mid(P0, P1); const segL = dist(P0, P1);
  const size = st.size * s; const gap = st.textGap * s; const tw = textWidth(txt, size);
  let p = add(m, mul(lay.td.up, gap));
  const n = lay.pts.length - 1;
  if (tw > segL - size * 0.4) {
    const outOff = tw / 2 + size * 0.6 + (isArrow(st.tick) ? st.tickSize * s : st.dimExt * s);
    if (i === n - 1) p = add(add(P1, mul(lay.dir, outOff)), mul(lay.td.up, gap));
    else if (i === 0) p = add(sub(P0, mul(lay.dir, outOff)), mul(lay.td.up, gap));
    else if (i % 2 === 1) p = add(m, mul(lay.td.up, gap + size * 1.4));
  }
  const base = p;
  return { p: off ? add(p, off) : p, base };
}

function witness(dl: DisplayList, anchor: V2, P: V2, st: DimStyle, pen: Pen): void {
  const s = dl.scale; const v = sub(P, anchor); const L = len(v);
  if (L <= st.wGap * s + 0.01) return;
  const u = mul(v, 1 / L);
  dl.line(add(anchor, mul(u, st.wGap * s)), add(P, mul(u, st.wExt * s)), pen, { ns: true, sub: 'witness' });
}

function linearValues(lay: LinLayout): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < lay.pts.length; i++) out.push(lay.pts[i + 1].c - lay.pts[i].c);
  return out;
}

function drawLinear(dl: DisplayList, el: Dim, doc: Doc, view: View): void {
  const lay = linearLayout(doc, view, el); if (!lay) return;
  const st = dimStyle(doc, el); const s = dl.scale;
  const pen: Pen = { w: st.lineW, color: st.color }; const tpen: Pen = { w: st.tickW, color: st.color };
  const pts = lay.pts; const first = pts[0].P, last = pts[pts.length - 1].P;
  const ext = isArrow(st.tick) ? 0 : st.dimExt * s;
  dl.line(sub(first, mul(lay.dir, ext)), add(last, mul(lay.dir, ext)), pen, { ns: true, sub: 'dimline' });
  for (const q of pts) witness(dl, q.anchor, q.P, st, pen);
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i].P;
    if (isArrow(st.tick)) {
      if (i > 0) drawTick(dl, P, lay.dir, st.tick, st.tickSize, tpen);
      if (i < pts.length - 1) drawTick(dl, P, mul(lay.dir, -1), st.tick, st.tickSize, tpen);
    } else drawTick(dl, P, lay.dir, st.tick, st.tickSize, tpen, lay.td.dir);
  }
  linearValues(lay).forEach((v, i) => {
    const txt = finalText(el, i, fmtVal(st, v));
    const tp = segTextPos(lay, st, s, i, txt, el.tOff?.[i]);
    dl.text(tp.p, txt, textFont(st, lay.td.ang), { sub: 'text' + i });
    if (el.tOff?.[i] && dist(tp.p, tp.base) > st.size * s * 2) {
      dl.line(sub(tp.p, mul(lay.td.up, st.textGap * s * 0.5)), mid(pts[i].P, pts[i + 1].P), { w: 1, color: st.color }, { ns: true });
    }
  });
}

// ------------------------------------------------------------ Winkelbemaßung
interface AngLayout { C: V2; R: number; a0: number; a1: number; sweep: number; segs: G[] }
function angularLayout(doc: Doc, view: View, el: Dim): AngLayout | null {
  if (!el.pt || (el.refs?.length ?? 0) < 2) return null;
  const g1 = refGeom(doc, view, el.refs[0]), g2 = refGeom(doc, view, el.refs[1]);
  if (!g1 || !g2 || g1.k !== 'seg' || g2.k !== 'seg') return null;
  const x = lineLine(g1.a, g1.b, g2.a, g2.b); if (!x) return null;
  const C = x.p; const R = dist(C, el.pt); if (R < 1e-6) return null;
  const u1 = angleOf(sub(g1.b, g1.a)), u2 = angleOf(sub(g2.b, g2.a));
  const rays = [u1, u1 + Math.PI, u2, u2 + Math.PI].map(normAngle).sort((a, b) => a - b);
  const phi = normAngle(angleOf(sub(el.pt, C)));
  let k = 3;
  for (let i = 0; i < 4; i++) if (phi >= rays[i] && (i === 3 || phi < rays[i + 1])) k = i;
  if (phi < rays[0]) k = 3;
  const a0 = rays[k], a1 = rays[(k + 1) % 4];
  return { C, R, a0, a1, sweep: normAngle(a1 - a0), segs: [g1, g2] };
}

/** Radiale Maßhilfslinie vom Element (Segment entlang Strahl) bis zum Radius R */
function radialWitness(dl: DisplayList, C: V2, ang: number, R: number, segs: G[], st: DimStyle, pen: Pen): void {
  const s = dl.scale; const u = fromAngle(ang);
  let best: G | null = null; let bc = 1;
  for (const g of segs) if (g.k === 'seg') { const c = Math.abs(cross(norm(sub(g.b, g.a)), u)); if (c < bc) { bc = c; best = g; } }
  if (!best || best.k !== 'seg') return;
  const ta = dot(sub(best.a, C), u), tb = dot(sub(best.b, C), u);
  const tmax = Math.max(0, ta, tb), tmin = Math.max(0, Math.min(ta, tb));
  const gap = st.wGap * s, ext = st.wExt * s;
  if (R > tmax + gap) dl.line(add(C, mul(u, tmax + gap)), add(C, mul(u, R + ext)), pen, { ns: true });
  else if (R < tmin - gap) dl.line(add(C, mul(u, tmin - gap)), add(C, mul(u, Math.max(0, R - ext))), pen, { ns: true });
}

function arcTicks(dl: DisplayList, C: V2, R: number, a0: number, a1: number, st: DimStyle, pen: Pen): void {
  const E0 = add(C, fromAngle(a0, R)), E1 = add(C, fromAngle(a1, R));
  const t0 = fromAngle(a0 + Math.PI / 2), t1 = fromAngle(a1 + Math.PI / 2);
  if (isArrow(st.tick)) { drawTick(dl, E0, mul(t0, -1), st.tick, st.tickSize, pen); drawTick(dl, E1, t1, st.tick, st.tickSize, pen); }
  else { drawTick(dl, E0, t0, st.tick, st.tickSize, pen, readable(t0).dir); drawTick(dl, E1, t1, st.tick, st.tickSize, pen, readable(t1).dir); }
}

function arcText(dl: DisplayList, el: Dim, C: V2, R: number, am: number, txt: string, st: DimStyle): void {
  const s = dl.scale; const td = readable(fromAngle(am + Math.PI / 2));
  const base = add(add(C, fromAngle(am, R)), mul(td.up, st.textGap * s));
  const off = el.tOff?.[0];
  dl.text(off ? add(base, off) : base, txt, textFont(st, td.ang), { sub: 'text0' });
}

function drawAngular(dl: DisplayList, el: Dim, doc: Doc, view: View): void {
  const L = angularLayout(doc, view, el); if (!L) return;
  const st = dimStyle(doc, el);
  const pen: Pen = { w: st.lineW, color: st.color }; const tpen: Pen = { w: st.tickW, color: st.color };
  dl.arc(L.C, L.R, L.a0, L.a1, pen, { ns: true, sub: 'dimline' });
  radialWitness(dl, L.C, L.a0, L.R, L.segs, st, pen);
  radialWitness(dl, L.C, L.a1, L.R, L.segs, st, pen);
  arcTicks(dl, L.C, L.R, L.a0, L.a1, st, tpen);
  arcText(dl, el, L.C, L.R, L.a0 + L.sweep / 2, finalText(el, 0, fmtAngle(L.sweep)), st);
}

// ------------------------------------------------------------ Radius / Bogenlänge
function arcOf(doc: Doc, view: View, el: Dim): ArcG | null {
  const g = el.refs?.[0] ? refGeom(doc, view, el.refs[0]) : null;
  return g && g.k === 'arc' ? { c: g.c, r: g.r, a0: g.a0, a1: g.a1 } : null;
}
const sweepOf = (a: ArcG) => (Math.abs(a.a1 - a.a0) >= Math.PI * 2 - 1e-6 ? Math.PI * 2 : normAngle(a.a1 - a.a0) || Math.PI * 2);

function drawRadial(dl: DisplayList, el: Dim, doc: Doc, view: View): void {
  const A = arcOf(doc, view, el); if (!A || !el.pt) return;
  const st = dimStyle(doc, el); const s = dl.scale;
  const pen: Pen = { w: st.lineW, color: st.color }; const tpen: Pen = { w: st.tickW, color: st.color };
  const dv = sub(el.pt, A.c); const D = len(dv); if (D < 1e-6) return;
  const u = mul(dv, 1 / D); const P = add(A.c, mul(u, A.r));
  const outside = D > A.r;
  const txt = finalText(el, 0, fmtVal(st, A.r));
  const td = readable(u); const tw = textWidth(txt, st.size * s);
  // Mittelpunktkreuz
  const cm = 1.2 * s;
  dl.line(sub(A.c, { x: cm, y: 0 }), add(A.c, { x: cm, y: 0 }), pen, { ns: true });
  dl.line(sub(A.c, { x: 0, y: cm }), add(A.c, { x: 0, y: cm }), pen, { ns: true });
  let tc: V2;
  if (outside) {
    const E = add(P, mul(u, Math.max(D - A.r, tw + st.size * s)));
    dl.line(P, E, pen, { ns: true, sub: 'dimline' });
    drawTick(dl, P, mul(u, -1), isArrow(st.tick) ? st.tick : 'arrow', st.tickSize, isArrow(st.tick) ? tpen : pen);
    tc = add(P, mul(u, (dist(P, E) + st.tickSize * s) / 2));
  } else {
    dl.line(A.c, P, pen, { ns: true, sub: 'dimline' });
    drawTick(dl, P, u, isArrow(st.tick) ? st.tick : 'arrow', st.tickSize, isArrow(st.tick) ? tpen : pen);
    tc = add(A.c, mul(u, clamp(D, tw / 2 + st.size * s * 0.5, Math.max(tw / 2 + st.size * s * 0.5, A.r - tw / 2 - st.tickSize * s))));
  }
  const off = el.tOff?.[0];
  const base = add(tc, mul(td.up, st.textGap * s));
  dl.text(off ? add(base, off) : base, txt, textFont(st, td.ang), { sub: 'text0' });
}

function drawArcLen(dl: DisplayList, el: Dim, doc: Doc, view: View): void {
  const A = arcOf(doc, view, el); if (!A || !el.pt) return;
  const st = dimStyle(doc, el); const s = dl.scale;
  const pen: Pen = { w: st.lineW, color: st.color }; const tpen: Pen = { w: st.tickW, color: st.color };
  const R = dist(A.c, el.pt); const sw = sweepOf(A); const a1 = A.a0 + sw;
  dl.arc(A.c, R, A.a0, a1, pen, { ns: true, sub: 'dimline' });
  const gap = st.wGap * s, ext = st.wExt * s;
  for (const ang of sw < Math.PI * 2 - 1e-6 ? [A.a0, a1] : []) {
    const u = fromAngle(ang);
    if (R > A.r + gap) dl.line(add(A.c, mul(u, A.r + gap)), add(A.c, mul(u, R + ext)), pen, { ns: true });
    else if (R < A.r - gap) dl.line(add(A.c, mul(u, A.r - gap)), add(A.c, mul(u, Math.max(0, R - ext))), pen, { ns: true });
  }
  if (sw < Math.PI * 2 - 1e-6) arcTicks(dl, A.c, R, A.a0, a1, st, tpen);
  arcText(dl, el, A.c, R, A.a0 + sw / 2, finalText(el, 0, fmtVal(st, A.r * sw)), st);
}

export function drawDim(dl: DisplayList, el: Dim, doc: Doc, view: View): void {
  switch (el.kind) {
    case 'angular': drawAngular(dl, el, doc, view); break;
    case 'radial': drawRadial(dl, el, doc, view); break;
    case 'arc': drawArcLen(dl, el, doc, view); break;
    default: drawLinear(dl, el, doc, view);
  }
}

/** Formatierte Werte je Segment (ohne Präfix/Suffix/Ersetzung) */
export function dimValues(doc: Doc, view: View, el: Dim): string[] {
  const st = dimStyle(doc, el);
  try {
    if (el.kind === 'angular') { const L = angularLayout(doc, view, el); return L ? [fmtAngle(L.sweep)] : []; }
    if (el.kind === 'radial') { const A = arcOf(doc, view, el); return A ? [fmtVal(st, A.r)] : []; }
    if (el.kind === 'arc') { const A = arcOf(doc, view, el); return A ? [fmtVal(st, A.r * sweepOf(A))] : []; }
    const lay = linearLayout(doc, view, el);
    return lay ? linearValues(lay).map((v) => fmtVal(st, v)) : [];
  } catch { return []; }
}

// ------------------------------------------------------------ Kategorie
const viewOfDim = (doc: Doc, el: El): View | undefined => doc.get<View>(el.viewId);

function trRef(r: DimRef, m: Mat2): DimRef {
  const o: DimRef = { ...r };
  if (r.a) o.a = apply(m, r.a);
  if (r.b) o.b = apply(m, r.b);
  if (r.p) o.p = apply(m, r.p);
  if (r.arc) {
    const c = apply(m, r.arc.c); const rot = Math.atan2(m.b, m.a); const sc = Math.hypot(m.a, m.b);
    const mir = m.a * m.d - m.b * m.c < 0;
    o.arc = mir ? { c, r: r.arc.r * sc, a0: rot - r.arc.a1, a1: rot - r.arc.a0 } : { c, r: r.arc.r * sc, a0: r.arc.a0 + rot, a1: r.arc.a1 + rot };
  }
  return o;
}

function dimGrips(el: Dim, doc: Doc, view: View): Grip[] {
  if (!annoIn(doc, el, view)) return [];
  const st = dimStyle(doc, el); const s = view.scale;
  if (el.kind === 'linear') {
    const lay = linearLayout(doc, view, el); if (!lay) return [];
    const g: Grip[] = [{ id: 'line', p: sub(lay.pts[0].P, mul(lay.dir, (st.dimExt + 2.5) * s)), kind: 'arrow', dir: lay.w, tip: 'Maßlinie verschieben' }];
    linearValues(lay).forEach((v, i) => {
      const tp = segTextPos(lay, st, s, i, finalText(el, i, fmtVal(st, v)), el.tOff?.[i]);
      g.push({ id: 't' + i, p: tp.p, kind: 'text', tip: 'Text verschieben' });
    });
    return g;
  }
  if (!el.pt) return [];
  const g: Grip[] = [{ id: 'pt', p: el.pt, kind: 'end', tip: el.kind === 'radial' ? 'Maßlinie drehen' : 'Lage der Maßlinie' }];
  return g;
}

function dimDragGrip(el: Dim, id: string, p: V2, doc: Doc, view: View): Partial<Dim> | void {
  if (id === 'line') return { line: p };
  if (id === 'pt') return { pt: p };
  if (id.startsWith('t') && el.kind === 'linear') {
    const i = parseInt(id.slice(1), 10);
    const lay = linearLayout(doc, view, el); if (!lay) return;
    const st = dimStyle(doc, el); const vals = linearValues(lay);
    const tp = segTextPos(lay, st, view.scale, i, finalText(el, i, fmtVal(st, vals[i] ?? 0)), null);
    const arr = (el.tOff ?? []).slice(); while (arr.length < vals.length) arr.push(null);
    arr[i] = sub(p, tp.base);
    return { tOff: arr };
  }
}

function dimCenter(el: Dim, doc: Doc, view: View): V2 | null {
  if (el.kind === 'linear') { const l = linearLayout(doc, view, el); return l ? mid(l.pts[0].P, l.pts[l.pts.length - 1].P) : el.line ?? null; }
  return el.pt ?? null;
}

const UNIT_OPTS: [string, string][] = [['', 'Projekteinstellung'], ['mm', 'Millimeter'], ['cm', 'Zentimeter'], ['m', 'Meter'], ['ch', 'Schweiz: < 1 m in cm, sonst m']];
const SEP_OPTS: [string, string][] = [[',', 'Komma (2,40)'], ['.', 'Punkt (2.40)']];
const SUP_OPTS: [string, string][] = [['', 'Projekteinstellung'], ['none', 'Keine'], ['5', 'Nur 5 (auf 5 mm gerundet: 1.82⁵)'], ['all', 'Jede Ziffer (1.82³)']];

registerCategory({
  cat: 'dimension', label: 'Bemaßung', plural: 'Bemaßungen', annotation: true, hasTypes: true, planOrder: 90,
  drawAnnotation: (dl, el, doc, view) => drawDim(dl, el as Dim, doc, view),
  grips: (el, doc, view) => dimGrips(el as Dim, doc, view),
  dragGrip: (el, id, p, doc, view) => dimDragGrip(el as Dim, id, p, doc, view),
  transform: (el, m) => {
    const d = el as Dim; const patch: Partial<Dim> = { refs: (d.refs ?? []).map((r) => trRef(r, m)) };
    if (d.dir) patch.dir = norm(applyVec(m, d.dir));
    if (d.line) patch.line = apply(m, d.line);
    if (d.pt) patch.pt = apply(m, d.pt);
    if (d.tOff) patch.tOff = d.tOff.map((o) => (o ? applyVec(m, o) : o));
    return patch;
  },
  onCopy: (el, _doc, idMap) => ({ ...el, refs: (el.refs ?? []).map((r: DimRef) => (r.id && idMap.has(r.id) ? { ...r, id: idMap.get(r.id) } : r)) }),
  center: (el, doc, view) => dimCenter(el as Dim, doc, view),
  props: () => dimProps(),
  typeProps: () => dimTypeProps(),
});

function dimProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'value', label: 'Wert', group: g.dims, type: 'readonly', get: (e, doc) => { const v = viewOfDim(doc, e); return v && e.refs ? dimValues(doc, v, e as Dim).join(' + ') : ''; } },
    { key: 'prefix', label: 'Präfix', group: g.text, type: 'text', get: (e) => e.prefix ?? '', set: (_e, v) => ({ prefix: v === '' ? undefined : v }) },
    { key: 'suffix', label: 'Suffix', group: g.text, type: 'text', get: (e) => e.suffix ?? '', set: (_e, v) => ({ suffix: v || undefined }) },
    { key: 'over', label: 'Wert ersetzen (1. Segment)', group: g.text, type: 'text', get: (e) => e.over?.[0] ?? '',
      set: (e, v) => { const a = ((e.over ?? []) as (string | null)[]).slice(); a[0] = v || null; return { over: a.some((x) => x) ? a : undefined }; } },
    { key: 'dimText', label: 'Bemaßungstext', group: g.text, type: 'button', get: () => 'Bearbeiten…', action: (e) => { if (e.id) dimTextDialog(e as Dim); } },
    { key: 'resetText', label: 'Textposition', group: g.text, type: 'button', get: () => 'Zurücksetzen',
      action: (e, doc) => { if (e.id && doc.get(e.id)) doc.transaction('Textposition zurücksetzen', () => doc.update(e.id, { tOff: undefined })); } },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

function dimTypeProps(): PropDef[] {
  const g = GROUPS;
  const num = (key: string, label: string, group: string, def: number): PropDef => ({ key, label, group, type: 'number', get: (t) => t[key] ?? def, set: (_t, v) => ({ [key]: Math.max(0, v) }) });
  const pen = (key: string, label: string, def: number): PropDef => ({ key, label, group: g.graphics, type: 'int', get: (t) => t[key] ?? def, set: (_t, v) => ({ [key]: clamp(Math.round(v), 1, 16) }) });
  return [
    { key: 'tick', label: 'Markierung', group: g.graphics, type: 'select', options: TICK_OPTIONS, get: (t) => t.tick ?? 'slash', set: (_t, v) => ({ tick: v }) },
    num('tickSize', 'Markierungsgröße (mm)', g.graphics, 2.5),
    pen('tickW', 'Linienstärke Markierung', 5),
    pen('lineW', 'Linienstärke', 1),
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    num('wGap', 'Maßhilfslinie: Abstand zum Element (mm)', g.graphics, 1.5),
    num('wExt', 'Maßhilfslinie: Verlängerung (mm)', g.graphics, 1.5),
    num('dimExt', 'Maßlinienverlängerung (mm)', g.graphics, 1.5),
    num('size', 'Textgröße (mm)', g.text, 2.5),
    { key: 'font', label: 'Schriftart', group: g.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    num('textGap', 'Textabstand zur Maßlinie (mm)', g.text, 0.7),
    { key: 'bold', label: 'Fett', group: g.text, type: 'bool', get: (t) => !!t.bold, set: (_t, v) => ({ bold: v }) },
    { key: 'opaque', label: 'Texthintergrund undurchsichtig', group: g.text, type: 'bool', get: (t) => !!t.opaque, set: (_t, v) => ({ opaque: v }) },
    { key: 'unit', label: 'Einheit', group: g.other, type: 'select', options: UNIT_OPTS, get: (t) => t.unit ?? '', set: (_t, v) => ({ unit: v }) },
    { key: 'dec', label: 'Nachkommastellen', group: g.other, type: 'int', get: (t) => t.dec ?? 2, set: (_t, v) => ({ dec: clamp(Math.round(v), 0, 4) }) },
    { key: 'sep', label: 'Dezimaltrennzeichen', group: g.other, type: 'select', options: SEP_OPTS, get: (t) => (t.sep === '.' ? '.' : ','), set: (_t, v) => ({ sep: v }) },
    { key: 'sup', label: 'Hochgestellte mm-Stelle', group: g.other, type: 'select', options: SUP_OPTS, get: (t) => t.sup ?? '', set: (_t, v) => ({ sup: v || undefined }) },
  ];
}

/** Dialog "Bemaßungstext": Wert ersetzen je Segment, Präfix, Suffix */
export function dimTextDialog(el0: Dim): void {
  const doc = app.doc; const el = doc.get<Dim>(el0.id); if (!el) return;
  const view = viewOfDim(doc, el); if (!view) return;
  const vals = dimValues(doc, view, el);
  const inp = (v: string, ph = '') => h('input', { type: 'text', value: v, placeholder: ph }) as HTMLInputElement;
  const pre = inp(el.prefix ?? '', defPrefix({ ...el, prefix: undefined } as Dim)); const suf = inp(el.suffix ?? '');
  const overs = vals.map((v, i) => inp(el.over?.[i] ?? '', v));
  const body = h('div', { style: 'min-width:380px' });
  body.append(h('div', { class: 'hint' }, 'Leeres Feld = gemessener Wert. „Wert ersetzen“ zeigt den eingegebenen Text statt des Werts.'));
  vals.forEach((v, i) => body.append(h('div', { class: 'form-row' }, h('label', {}, vals.length > 1 ? `Segment ${i + 1} (${v})` : `Wert (${v})`), overs[i])));
  body.append(h('div', { class: 'form-row' }, h('label', {}, 'Präfix'), pre), h('div', { class: 'form-row' }, h('label', {}, 'Suffix'), suf));
  modal('Bemaßungstext', body, [
    { label: 'OK', primary: true, onClick: () => {
      const over = overs.map((i) => i.value.trim() || null);
      doc.transaction('Bemaßungstext', () => doc.update(el.id, { over: over.some((x) => x) ? over : undefined, prefix: pre.value === '' ? undefined : pre.value, suffix: suf.value || undefined }));
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}

// ------------------------------------------------------------ Referenzsuche (Werkzeuge)
export interface Cand { ref: DimRef; g: G; d: number; hl: { a: V2; b: V2 } | { p: V2 } }
export type Pref = 'center' | 'faces' | 'coreC' | 'cores';
export const dimOpts = { pref: 'center' as Pref, pick: 'single' as 'single' | 'walls', openings: 'widths' as 'none' | 'centers' | 'widths', inter: 'faces' as 'none' | 'centers' | 'faces' };

const sameG = (a: G, b: G) => a.k === 'seg' && b.k === 'seg' && ((eq(a.a, b.a, 0.5) && eq(a.b, b.b, 0.5)) || (eq(a.a, b.b, 0.5) && eq(a.b, b.a, 0.5)));

function wallCands(doc: Doc, w: Wall, raw: V2, tol: number): Cand[] {
  const o = wallOffsets(doc, w); const wi = o.wi;
  if (wi.L < 1) return [];
  const refs: DimRef[] = [{ sub: 'face', side: 1 }, { sub: 'face', side: -1 }];
  if (o.hasCore) refs.push({ sub: 'core', side: 1 }, { sub: 'core', side: -1 });
  refs.push({ sub: 'center' });
  if (o.hasCore) refs.push({ sub: 'coreC' });
  o.bounds.forEach((_, i) => refs.push({ sub: 'layer', i }));
  refs.push({ sub: 'end', side: 0 }, { sub: 'end', side: 1 });
  const t = projectT(raw, wi.c0, wi.c1); const sd = sideDist(raw, wi.c0, wi.c1);
  const inside = t >= 0 && t <= 1 && Math.abs(sd) <= wi.T / 2 + tol * 0.2;
  const sgn = sd >= 0 ? 1 : -1; const pref = dimOpts.pref;
  const isPref = (r: DimRef) => {
    if (pref === 'center') return r.sub === 'center';
    if (pref === 'coreC') return o.hasCore ? r.sub === 'coreC' : r.sub === 'center';
    if (pref === 'faces' || !o.hasCore) return r.sub === 'face' && r.side === sgn;
    return r.sub === 'core' && r.side === sgn;
  };
  const out: Cand[] = [];
  for (const r0 of refs) {
    const r: DimRef = { id: w.id, ...r0 };
    const g = wallRefGeom(doc, w, r); if (!g || g.k !== 'seg') continue;
    let d = distToSeg(raw, g.a, g.b);
    // unsichtbare Achsen nur über "Bevorzugt" oder Tab
    if (r.sub === 'center' || r.sub === 'coreC') d = inside ? Math.max(d, tol * 0.95) : Infinity;
    // in der Wand: bevorzugte Referenz, außer der Cursor liegt praktisch auf einer Linie
    if (inside && isPref(r)) d = Math.min(d, tol * 0.05);
    if (d > tol) continue;
    if (out.some((c) => sameG(c.g, g))) continue;
    out.push({ ref: { ...r, a: g.a, b: g.b }, g, d, hl: { a: g.a, b: g.b } });
  }
  return out;
}

function openingCands(doc: Doc, el: El, raw: V2, tol: number): Cand[] {
  const out: Cand[] = [];
  for (const r0 of [{ sub: 'jamb', side: 0 }, { sub: 'jamb', side: 1 }, { sub: 'oc' }] as DimRef[]) {
    const r: DimRef = { id: el.id, ...r0 };
    const g = openingRefGeom(doc, el, r); if (!g || g.k !== 'seg') continue;
    const d = distToSeg(raw, g.a, g.b);
    if (d <= tol) out.push({ ref: { ...r, a: g.a, b: g.b }, g, d: d * (r.sub === 'oc' ? 1.2 : 1), hl: { a: g.a, b: g.b } });
  }
  return out;
}

const PT_KINDS = ['end', 'int', 'center', 'quad', 'point'];

/** Referenzkandidaten unter dem Cursor (sortiert nach Abstand) */
export function collectCands(e: ToolEvent, withPoints = true): Cand[] {
  const doc = app.doc; const vp = e.vp; const raw = e.raw; const view = e.view;
  const tol: number = vp.hitTol(); const plan = isPlanLike(view);
  const out: Cand[] = [];
  const seenEl = new Set<Id>();
  if (plan) {
    for (const h of vp.hit(raw).slice(0, 8)) {
      const el = doc.get(h.id); if (!el || seenEl.has(el.id)) continue;
      seenEl.add(el.id);
      if (el.cat === 'wall') out.push(...wallCands(doc, el as Wall, raw, tol));
      else if (el.cat === 'door' || el.cat === 'window') out.push(...openingCands(doc, el, raw, tol));
    }
  }
  const segs = vp.displayList().segmentsNear(raw, tol) as { a: V2; b: V2; o: Id | null; sub?: string }[];
  for (const s of segs) {
    const el = s.o ? doc.get(s.o) : undefined;
    if (el && plan && (el.cat === 'wall' || el.cat === 'door' || el.cat === 'window')) continue;
    if (el && (el.cat === 'dimension' || el.id === view.id)) continue;
    let ref: DimRef = {};
    if (el) {
      if (el.cat === 'level' && s.sub === 'line') ref = { id: el.id, sub: 'level' };
      else if (el.cat === 'grid' && s.sub === 'line') ref = { id: el.id, sub: plan ? 'line' : 'gridS' };
      else if ((el.cat === 'line' || el.cat === 'refplane') && el.a && el.b && !el.arc && s.sub === 'line') ref = { id: el.id, sub: 'line' };
      else {
        try {
          const c = catDef(el.cat)?.curve?.(el, doc, view);
          if (c && distToSeg(s.a, c.a, c.b) < 1 && distToSeg(s.b, c.a, c.b) < 1 && (eq(s.a, c.a, 1) || eq(s.a, c.b, 1) || eq(s.b, c.a, 1) || eq(s.b, c.b, 1))) ref = { id: el.id, sub: 'curve' };
        } catch { /* */ }
      }
    }
    const g: G = { k: 'seg', a: s.a, b: s.b };
    if (out.some((c) => sameG(c.g, g))) continue;
    out.push({ ref: { ...ref, a: s.a, b: s.b }, g, d: distToSeg(raw, s.a, s.b), hl: { a: s.a, b: s.b } });
  }
  const sn = e.snap;
  if (withPoints && sn && PT_KINDS.includes(sn.kind)) {
    let ref: DimRef = { p: sn.p };
    for (const s of segs) {
      const el = s.o ? doc.get(s.o) : undefined; if (!el) continue;
      if (el.cat === 'line' || (el.cat === 'grid' && plan) || (el.cat === 'refplane' && plan)) {
        if (el.a && eq(el.a, sn.p, 0.5)) { ref = { id: el.id, sub: 'a', p: sn.p }; break; }
        if (el.b && eq(el.b, sn.p, 0.5)) { ref = { id: el.id, sub: 'b', p: sn.p }; break; }
      }
    }
    if (!ref.id && sn.kind === 'center') {
      for (const l of doc.all('line')) if (l.arc && (annoIn(doc, l, view) || (!l.viewId && plan)) && eq(l.arc.c, sn.p, 0.5)) { ref = { id: l.id, sub: 'c', p: sn.p }; break; }
    }
    out.push({ ref, g: { k: 'pt', p: sn.p }, d: dist(sn.p, raw) - tol * 0.3, hl: { p: sn.p } });
  }
  return out.sort((a, b) => a.d - b.d);
}

const refKey = (r: DimRef) => r.id ? `${r.id}|${r.sub}|${r.side ?? ''}|${r.i ?? ''}` : r.p ? `p${Math.round(r.p.x)},${Math.round(r.p.y)}` : r.a && r.b ? `s${Math.round(r.a.x)},${Math.round(r.a.y)},${Math.round(r.b.x)},${Math.round(r.b.y)}` : '?';

function drawHl(dl: DisplayList, hl: Cand['hl'], strong: boolean): void {
  const s = dl.scale; const pen: Pen = { w: strong ? 6 : 4, color: strong ? '#2f8ff0' : PREV_COL };
  if ('p' in hl) { const r = 1.2 * s; dl.poly([{ x: hl.p.x - r, y: hl.p.y - r }, { x: hl.p.x + r, y: hl.p.y - r }, { x: hl.p.x + r, y: hl.p.y + r }, { x: hl.p.x - r, y: hl.p.y + r }], pen, true, { ns: true }); }
  else {
    // sehr lange Bezugslinien (Ebenen im Schnitt) kürzen
    let { a, b } = hl;
    if (dist(a, b) > 1e5) { const c = closestOnLineSafe(a, b, dl); a = add(c, mul(norm(sub(hl.a, hl.b)), 3000)); b = sub(c, mul(norm(sub(hl.a, hl.b)), 3000)); }
    dl.line(a, b, pen, { ns: true });
  }
}
let lastCursor: V2 = { x: 0, y: 0 };
function closestOnLineSafe(a: V2, b: V2, _dl: DisplayList): V2 { return lerp(a, b, clamp(projectT(lastCursor, a, b), 0, 1)); }

/** Referenzen einer ganzen Wand (Enden, Öffnungen, schneidende Wände) */
function wholeWallRefs(doc: Doc, w: Wall): DimRef[] {
  const wi = wallInfo(doc, w);
  const refs: DimRef[] = [{ id: w.id, sub: 'end', side: 0 }, { id: w.id, sub: 'end', side: 1 }];
  if (dimOpts.openings !== 'none') for (const hEl of hostedBy(doc, w.id)) {
    if (!catDef(hEl.cat)?.hostOpening?.(hEl, doc)) continue;
    if (dimOpts.openings === 'centers') refs.push({ id: hEl.id, sub: 'oc' });
    else refs.push({ id: hEl.id, sub: 'jamb', side: 0 }, { id: hEl.id, sub: 'jamb', side: 1 });
  }
  if (dimOpts.inter !== 'none') for (const o of doc.all<Wall>('wall')) {
    if (o.id === w.id) continue;
    const oi = wallInfo(doc, o);
    if (oi.L < 1 || Math.abs(cross(oi.d, wi.d)) < 0.2) continue;
    if (!(oi.z0 < wi.z1 && wi.z0 < oi.z1)) continue;
    const x = lineLine(wi.c0, wi.c1, oi.c0, oi.c1); if (!x) continue;
    const tolT = (oi.T / 2 + 5) / Math.max(1, wi.L), tolU = (wi.T / 2 + 5) / Math.max(1, oi.L);
    if (x.t < -tolT || x.t > 1 + tolT || x.u < -tolU || x.u > 1 + tolU) continue;
    if (dimOpts.inter === 'centers') refs.push({ id: o.id, sub: 'center' });
    else refs.push({ id: o.id, sub: 'face', side: 1 }, { id: o.id, sub: 'face', side: -1 });
  }
  // Rückfallgeometrie speichern
  return refs.map((r) => {
    const el = doc.get(r.id); const g = el ? elemRefGeom(doc, { kind: 'plan' } as View, el, r) : null;
    return g && g.k === 'seg' ? { ...r, a: g.a, b: g.b } : r;
  });
}

// ------------------------------------------------------------ Werkzeug: ausgerichtet / linear
export class DimTool extends Tool {
  id: string; label: string;
  kinds = ANNO_KINDS;
  snapping = true;
  private refs: DimRef[] = [];
  private dir: V2 | null = null;
  private cur: V2 | null = null;
  private view: View | null = null;
  private cands: Cand[] = [];
  private cyc = 0; private candKey = '';
  private hoverWall: Wall | null = null;

  constructor(public aligned: boolean) {
    super();
    this.id = aligned ? 'dimAligned' : 'dimLinear';
    this.label = aligned ? 'Ausgerichtete Bemaßung' : 'Lineare Bemaßung';
  }
  activate(): void { this.placement = myPlacement('dimLinear', 'dimension', defaultDimType(app.doc)); }
  private whole(): boolean { return this.aligned && dimOpts.pick === 'walls' && !!this.view && isPlanLike(this.view); }
  prompt(): string {
    if (this.whole()) return this.refs.length ? 'Weitere parallele Wand wählen oder in freien Bereich klicken, um die Maßkette zu platzieren.' : 'Wand wählen (Maßkette mit Enden, Öffnungen und schneidenden Wänden).';
    if (this.refs.length < 2) return 'Referenz wählen: Wand, Linie, Raster oder Punkt. Tab wechselt zwischen überlagerten Referenzen.';
    return 'Weitere Referenzen wählen oder in einen freien Bereich klicken, um die Bemaßung zu platzieren (Esc bricht ab).';
  }
  options(): OptionItem[] {
    const o: OptionItem[] = [
      { kind: 'select', key: 'pref', label: 'Bevorzugt', value: dimOpts.pref, options: [['center', 'Wandachse'], ['faces', 'Wandoberflächen'], ['coreC', 'Tragschichtachse'], ['cores', 'Tragschichtoberflächen']], onChange: (v) => { dimOpts.pref = v as Pref; } },
    ];
    if (this.aligned) {
      o.push({ kind: 'select', key: 'pick', label: 'Auswählen', value: dimOpts.pick, options: [['single', 'Einzelne Referenzen'], ['walls', 'Ganze Wände']], onChange: (v) => { dimOpts.pick = v as any; this.reset(); app.emit('tool'); } });
      if (dimOpts.pick === 'walls') {
        o.push({ kind: 'select', key: 'open', label: 'Öffnungen', value: dimOpts.openings, options: [['widths', 'Breiten'], ['centers', 'Mitten'], ['none', 'Keine']], onChange: (v) => { dimOpts.openings = v as any; } });
        o.push({ kind: 'select', key: 'inter', label: 'Schneidende Wände', value: dimOpts.inter, options: [['faces', 'Oberflächen'], ['centers', 'Achsen'], ['none', 'Keine']], onChange: (v) => { dimOpts.inter = v as any; } });
      }
    }
    return o;
  }
  private reset(): void { this.refs = []; this.dir = null; this.cands = []; this.cyc = 0; app.setPrompt(this.prompt()); }

  move(e: ToolEvent): void {
    this.cur = e.raw; this.view = e.view; lastCursor = e.raw;
    this.hoverWall = null; this.cands = [];
    if (this.whole()) {
      for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el?.cat === 'wall') { this.hoverWall = el as Wall; break; } }
      return;
    }
    this.cands = collectCands(e);
    const key = this.cands.map((c) => refKey(c.ref)).join(';');
    if (key !== this.candKey) { this.candKey = key; this.cyc = 0; }
  }
  key(e: KeyboardEvent): boolean {
    if (e.key === 'Tab' && this.cands.length > 1) { this.cyc++; app.redrawOverlay(); return true; }
    return false;
  }
  private cand(): Cand | null { return this.cands.length ? this.cands[this.cyc % this.cands.length] : null; }

  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    this.view = e.view;
    if (this.whole()) {
      this.move(e);
      if (this.hoverWall) { this.addWall(this.hoverWall); return; }
      if (this.refs.length >= 2) this.place(e.raw, e.view);
      return;
    }
    const c = this.cand();
    if (c) { this.addRef(c, e.view); app.setPrompt(this.prompt()); return; }
    if (this.refs.length >= 2) this.place(e.raw, e.view);
    else app.status('Keine Referenz unter dem Cursor.');
  }

  private addWall(w: Wall): void {
    const wi = wallInfo(app.doc, w);
    const d = wi.d;
    if (this.dir && Math.abs(cross(this.dir, d)) > 0.02) { app.status('Die Wand ist nicht parallel zur ersten Wand.'); return; }
    if (!this.dir) this.dir = d;
    for (const r of wholeWallRefs(app.doc, w)) if (!this.refs.some((x) => refKey(x) === refKey(r))) this.refs.push(r);
    app.setPrompt(this.prompt());
  }

  private addRef(c: Cand, view: View): void {
    if (this.refs.some((r) => refKey(r) === refKey(c.ref))) { app.status('Diese Referenz ist bereits gewählt.'); return; }
    if (this.aligned && c.g.k === 'seg') {
      const sd = norm(sub(c.g.b, c.g.a));
      if (this.dir && Math.abs(dot(sd, this.dir)) > 0.02) { app.status('Die Referenz ist nicht parallel zu den bisherigen Referenzen.'); return; }
      if (!this.dir) this.dir = perp(sd);
    }
    this.refs.push(c.ref);
    if (this.aligned && !this.dir && this.refs.length >= 2) {
      const g0 = refGeom(app.doc, view, this.refs[0]), g1 = refGeom(app.doc, view, this.refs[1]);
      if (g0 && g1 && dist(repPt(g0), repPt(g1)) > 0.5) this.dir = norm(sub(repPt(g1), repPt(g0)));
      else { this.refs.pop(); app.status('Punkte fallen zusammen.'); }
    }
  }

  private currentDir(p: V2, view: View): V2 | null {
    if (this.aligned) return this.dir;
    const reps = this.refs.map((r) => refGeom(app.doc, view, r)).filter((g): g is G => !!g).map(repPt);
    if (reps.length < 2) return null;
    const b = bboxOf(reps);
    const dx = p.x < b.min.x ? b.min.x - p.x : p.x > b.max.x ? p.x - b.max.x : 0;
    const dy = p.y < b.min.y ? b.min.y - p.y : p.y > b.max.y ? p.y - b.max.y : 0;
    if (dx === 0 && dy === 0) return b.max.x - b.min.x >= b.max.y - b.min.y ? { x: 1, y: 0 } : { x: 0, y: 1 };
    return dy >= dx ? { x: 1, y: 0 } : { x: 0, y: 1 };
  }

  private temp(p: V2, view: View): Dim | null {
    const dir = this.currentDir(p, view); if (!dir) return null;
    const pr = this.placement!.proto;
    return { id: '__dim', cat: 'dimension', viewId: annoViewId(app.doc, view), typeId: pr.typeId, kind: 'linear', aligned: this.aligned, refs: this.refs, dir, line: p, prefix: pr.prefix, suffix: pr.suffix } as Dim;
  }

  private place(p: V2, view: View): void {
    const t = this.temp(p, view);
    if (!t || !linearLayout(app.doc, view, t)) { app.status('Bemaßung kann hier nicht erstellt werden.'); return; }
    const el = { ...t, id: newId('dm') } as Dim;
    if (el.prefix === undefined) delete el.prefix;
    if (el.suffix === undefined) delete el.suffix;
    app.doc.transaction(this.label, () => app.doc.add(el));
    this.reset();
  }
  enter(): boolean {
    if (this.refs.length >= 2 && this.cur && this.view) { this.place(this.cur, this.view); return true; }
    return false;
  }
  escape(): boolean { if (this.refs.length) { this.reset(); return true; } return false; }

  preview(dl: DisplayList, vp: any): void {
    const view: View = vp.view;
    for (const r of this.refs) {
      const g = refGeom(app.doc, view, r); if (!g) continue;
      drawHl(dl, g.k === 'seg' ? { a: g.a, b: g.b } : { p: repPt(g) }, false);
    }
    if (this.whole() && this.hoverWall) {
      for (const r of wholeWallRefs(app.doc, this.hoverWall)) { const g = refGeom(app.doc, view, r); if (g?.k === 'seg') drawHl(dl, g, true); }
    }
    const c = this.cand(); if (c) drawHl(dl, c.hl, true);
    if (this.refs.length >= 2 && this.cur && !c && !(this.whole() && this.hoverWall)) {
      const t = this.temp(this.cur, view);
      if (t) { const i0 = dl.items.length; drawLinear(dl, t, app.doc, view); tint(dl, i0); }
    }
  }
}

// ------------------------------------------------------------ Werkzeug: Winkel
export class AngularDimTool extends Tool {
  id = 'dimAngular'; label = 'Winkelbemaßung'; kinds = ANNO_KINDS;
  private refs: DimRef[] = []; private cands: Cand[] = []; private cur: V2 | null = null;
  activate(): void { this.placement = myPlacement('dimAngular', 'dimension', DIM_ARROW); }
  prompt(): string { return this.refs.length < 2 ? `${this.refs.length + 1}. Linie wählen (Wand, Linie, Raster).` : 'Klicken Sie, um den Maßbogen zu platzieren (Quadrant folgt dem Cursor).'; }
  move(e: ToolEvent): void { this.cur = e.raw; lastCursor = e.raw; this.cands = this.refs.length < 2 ? collectCands(e, false).filter((c) => c.g.k === 'seg') : []; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.refs.length < 2) {
      const c = this.cands[0];
      if (!c || c.g.k !== 'seg') { app.status('Keine Linie unter dem Cursor.'); return; }
      if (this.refs.length === 1) {
        const g0 = refGeom(app.doc, e.view, this.refs[0]);
        if (g0?.k === 'seg' && Math.abs(cross(norm(sub(g0.b, g0.a)), norm(sub(c.g.b, c.g.a)))) < 0.01) { app.status('Die Linien sind parallel.'); return; }
      }
      this.refs.push(c.ref);
      return;
    }
    const el = this.temp(e.raw, e.view);
    if (!angularLayout(app.doc, e.view, el)) { app.status('Winkel kann nicht bestimmt werden.'); return; }
    app.doc.transaction(this.label, () => app.doc.add({ ...el, id: newId('dm') }));
    this.refs = [];
  }
  private temp(p: V2, view: View): Dim {
    return { id: '__dim', cat: 'dimension', viewId: annoViewId(app.doc, view), typeId: this.placement!.proto.typeId, kind: 'angular', refs: this.refs, pt: p } as Dim;
  }
  escape(): boolean { if (this.refs.length) { this.refs = []; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    const view: View = vp.view;
    for (const r of this.refs) { const g = refGeom(app.doc, view, r); if (g?.k === 'seg') drawHl(dl, g, false); }
    if (this.cands[0]) drawHl(dl, this.cands[0].hl, true);
    if (this.refs.length === 2 && this.cur) { const i0 = dl.items.length; drawAngular(dl, this.temp(this.cur, view), app.doc, view); tint(dl, i0); }
  }
}

// ------------------------------------------------------------ Werkzeug: Radius / Bogenlänge
function arcsNear(vp: any, raw: V2, view: View): DimRef[] {
  const doc = app.doc; const tol: number = vp.hitTol(); const out: DimRef[] = [];
  const dl: DisplayList = vp.displayList();
  for (const it of dl.items) {
    if (it.k !== 'arc' && it.k !== 'circle') continue;
    if (!it.o) continue;
    const el = doc.get(it.o); if (!el || el.cat === 'dimension' || el.id === view.id) continue;
    if (Math.abs(dist(raw, it.c) - it.r) > tol) continue;
    let arc: ArcG;
    if (it.k === 'arc') {
      const ang = angleOf(sub(raw, it.c));
      if (normAngle(ang - it.a0) > normAngle(it.a1 - it.a0) + 1e-6) continue;
      arc = { c: it.c, r: it.r, a0: it.a0, a1: it.a1 };
    } else arc = { c: it.c, r: it.r, a0: 0, a1: Math.PI * 2 };
    out.push(el.cat === 'line' && el.arc ? { id: el.id, sub: 'arc', arc } : { arc });
  }
  return out;
}

export class ArcDimTool extends Tool {
  id: string; label: string; kinds = ANNO_KINDS;
  private ref: DimRef | null = null; private hover: DimRef | null = null; private cur: V2 | null = null;
  constructor(public kind: 'radial' | 'arc') {
    super();
    this.id = kind === 'radial' ? 'dimRadial' : 'dimArc';
    this.label = kind === 'radial' ? 'Radiusbemaßung' : 'Bogenlängenbemaßung';
  }
  activate(): void { this.placement = myPlacement('dimRadial', 'dimension', DIM_ARROW); }
  prompt(): string { return this.ref ? 'Klicken Sie, um die Bemaßung zu platzieren.' : 'Bogen oder Kreis wählen.'; }
  move(e: ToolEvent): void { this.cur = e.raw; this.hover = this.ref ? null : arcsNear(e.vp, e.raw, e.view)[0] ?? null; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.ref) { if (this.hover) this.ref = this.hover; else app.status('Kein Bogen unter dem Cursor.'); return; }
    app.doc.transaction(this.label, () => app.doc.add({ ...this.temp(e.raw, e.view), id: newId('dm') }));
    this.ref = null;
  }
  private temp(p: V2, view: View): Dim {
    return { id: '__dim', cat: 'dimension', viewId: annoViewId(app.doc, view), typeId: this.placement!.proto.typeId, kind: this.kind, refs: [this.ref!], pt: p } as Dim;
  }
  escape(): boolean { if (this.ref) { this.ref = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    const view: View = vp.view;
    const a = (this.hover ?? this.ref)?.arc;
    if (a) dl.arc(a.c, a.r, a.a0, a.a1, { w: this.ref ? 4 : 6, color: this.ref ? PREV_COL : '#2f8ff0' }, { ns: true });
    if (this.ref && this.cur) { const i0 = dl.items.length; drawDim(dl, this.temp(this.cur, view), app.doc, view); tint(dl, i0); }
  }
}

export { mid };
