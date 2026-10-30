// Bewehrung – Erzeugen eines Stabbewehrungssatzes aus Host-Treffer + Optionen: Biegeform in die
// Schnittfläche einpassen (Deckung + Ø/2), Verteilung über die Bauteiltiefe, Plattenmodus im Grundriss.
import type { Doc, El, Id } from '../../../core/doc';
import { V2, V3, add, sub, mul, norm, perp, dot, dist } from '../../../core/geom';
import { projectInfo } from '../../../core/view';
import { hostedBy } from '../../../core/cache';
import { Layout, fitShape, cleanRing, insetRing, chordThrough, inwardNormal, FitKind } from './math';
import { Frame, HostHit, fWorld, fVec, hostAt, slabAt, planFrame } from './frame';
import type { Rebar, RebarFit, Display } from './rebar';

export type ShapeKind = FitKind | '99';
export type SlabLayer = 'u1' | 'u2' | 'o1' | 'o2';
export const SLAB_LAYERS: [SlabLayer, string][] = [['u1', 'unten, 1. Lage'], ['u2', 'unten, 2. Lage'], ['o1', 'oben, 1. Lage'], ['o2', 'oben, 2. Lage']];

export interface BuildOpts {
  kind: ShapeKind;
  dia: number;
  hookA: number; hookB: number;
  legLen: number;
  layout: Layout; count: number; spacing: number;
  /** Überdeckung (0 = Bauteil/Projekt) */
  cover: number;
  display: Display;
  layer: SlabLayer;
  orient: 'par' | 'perp';
}

/** Betondeckung: Satz → Bauteil → Projekt */
export function coverFor(doc: Doc, host: El | undefined, ov?: number): number {
  if (ov && ov > 0) return ov;
  if (host?.rebarCover && host.rebarCover > 0) return host.rebarCover;
  return projectInfo(doc)?.rebarCover ?? 30;
}

/** größter Bügeldurchmesser im Bauteil (Längsstäbe liegen innerhalb der Bügel) */
export function stirrupDiaIn(doc: Doc, hostId: Id, exclude?: Id): number {
  let d = 0;
  for (const e of hostedBy(doc, hostId)) if (e.cat === 'rebar' && e.id !== exclude && (e.shape === '51' || e.shape === '21')) d = Math.max(d, e.dia ?? 0);
  return d;
}

const V3Z = (z: number): V3 => ({ x: 0, y: 0, z });
const fitOf = (f: Frame, c: V2, o: BuildOpts, extra: Partial<RebarFit> = {}): RebarFit => ({ o: f.origin, r: f.right, u: f.up, d: f.dir, c, kind: o.kind, legLen: o.legLen, single: o.layout === 'single', ...extra });

function base(hit: HostHit, o: BuildOpts, cover: number): Partial<Rebar> {
  return { hostId: hit.host.id, dia: o.dia, layout: o.layout, count: o.count, spacing: o.spacing, display: o.display, cover: o.cover > 0 ? o.cover : undefined, coverUsed: cover } as Partial<Rebar>;
}

/** Biegeform in die Schnittfläche des Hosts einpassen (Schnitt oder Grundriss in Schnitthöhe) */
export function buildFitted(doc: Doc, hit: HostHit, click: V2, o: BuildOpts, excludeId?: Id): Partial<Rebar> | null {
  const c = coverFor(doc, hit.host, o.cover); const d = o.dia; const f = hit.frame;
  if (o.kind === '99') return null;
  if (o.kind === 'L') {
    const extra = stirrupDiaIn(doc, hit.host.id, excludeId);
    const fit = fitShape('L', hit.ring, click, c + extra + d / 2, 0, o.layout === 'single');
    if (!fit) return null;
    const d0 = hit.dmin + c, d1 = hit.dmax - c;
    if (d1 - d0 < 20) return null;
    const P = fit.pts[0];
    return {
      ...base(hit, o, c), shape: '00', pts: [fWorld(f, P, d0), fWorld(f, P, d1)],
      dir: fit.ldir ? fVec(f, fit.ldir) : fVec(f, { x: 1, y: 0 }), span: fit.lspan ?? 0,
      hookA: 0, hookB: 0, fit: fitOf(f, click, o),
    };
  }
  const fit = fitShape(o.kind, hit.ring, click, c + d / 2, o.legLen);
  if (!fit) return null;
  let d0 = hit.dmin + c + d / 2;
  let span = hit.dmax - c - d / 2 - d0;
  if (span < 0) return null;
  if (o.layout === 'single') { d0 = Math.max(d0, Math.min(d0 + span, 0)); span = 0; }
  const closed = o.kind === '51';
  return {
    ...base(hit, o, c), shape: o.kind, pts: fit.pts.map((q) => fWorld(f, q, d0)), dir: f.dir, span,
    hookA: closed ? 135 : o.hookA, hookB: closed ? 135 : o.hookB, hookNA: fVec(f, fit.nA), hookNB: fVec(f, fit.nB),
    fit: fitOf(f, click, o),
  };
}

function slabZ(hit: HostHit, layer: SlabLayer, c: number, d: number): number {
  switch (layer) {
    case 'u1': return hit.zmin + c + d / 2;
    case 'u2': return hit.zmin + c + 1.5 * d;
    case 'o1': return hit.zmax - c - d / 2;
    case 'o2': return hit.zmax - c - 1.5 * d;
  }
}

/** Grundriss, liegendes Bauteil: gerade Stäbe parallel/senkrecht zur nächsten Kante, verteilt über die Platte */
export function buildSlab(doc: Doc, hit: HostHit, click: V2, o: BuildOpts): Partial<Rebar> | null {
  const c = coverFor(doc, hit.host, o.cover); const d = o.dia;
  const R = insetRing(cleanRing(hit.ring), c + d / 2);
  if (!R) return null;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < R.length; i++) {
    const a = R[i], b = R[(i + 1) % R.length];
    const t = Math.max(0, Math.min(1, dot(sub(click, a), sub(b, a)) / Math.max(1e-9, dot(sub(b, a), sub(b, a)))));
    const dd = dist(click, add(a, mul(sub(b, a), t)));
    if (dd < bd) { bd = dd; bi = i; }
  }
  const e = norm(sub(R[(bi + 1) % R.length], R[bi]));
  const u = o.orient === 'par' ? e : perp(e);
  const ch = chordThrough(R, click, u);
  if (!ch) return null;
  const w = perp(u);
  let smin = Infinity, smax = -Infinity;
  for (const q of R) { const s = dot(sub(q, click), w); if (s < smin) smin = s; if (s > smax) smax = s; }
  const z = slabZ(hit, o.layer, c, d);
  const single = o.layout === 'single';
  const sh = single ? 0 : smin;
  const A = add(ch[0], mul(w, sh)), B = add(ch[1], mul(w, sh));
  const hn = V3Z(o.layer.startsWith('u') ? 1 : -1);
  return {
    ...base(hit, o, c), shape: '00', pts: [{ ...A, z }, { ...B, z }], dir: { x: w.x, y: w.y, z: 0 }, span: single ? 0 : smax - smin,
    hookA: o.hookA, hookB: o.hookB, hookNA: hn, hookNB: hn,
    fit: fitOf(planFrame(z), click, o, { slab: o.layer, orient: o.orient }),
  };
}

/** Frei gezeichneter Stab (Punkt zu Punkt / Skizze). Platte: dist = Klick für Verteilbreite */
export function buildDrawn(doc: Doc, hit: HostHit, pts2: V2[], o: BuildOpts, slab: boolean, distClick?: V2 | null): Partial<Rebar> | null {
  if (pts2.length < 2) return null;
  const c = coverFor(doc, hit.host, o.cover); const d = o.dia; const f = hit.frame;
  const m = pts2.length;
  const shape = m === 2 ? '00' : '99';
  if (slab) {
    const z = slabZ(hit, o.layer, c, d);
    const u = norm(sub(pts2[1], pts2[0])); let w = perp(u); let span = 0;
    if (distClick && o.layout !== 'single') {
      const s = dot(sub(distClick, pts2[0]), w);
      if (s < 0) w = mul(w, -1);
      span = Math.abs(s);
    }
    const hn = V3Z(o.layer.startsWith('u') ? 1 : -1);
    return { ...base(hit, o, c), shape, pts: pts2.map((q) => ({ ...q, z })), dir: { x: w.x, y: w.y, z: 0 }, span, hookA: o.hookA, hookB: o.hookB, hookNA: hn, hookNB: hn };
  }
  let d0 = hit.dmin + c + d / 2;
  let span = hit.dmax - c - d / 2 - d0;
  if (span < 0) return null;
  if (o.layout === 'single') { d0 = Math.max(d0, Math.min(d0 + span, 0)); span = 0; }
  const ctr = pts2.reduce((s, q) => add(s, mul(q, 1 / m)), { x: 0, y: 0 });
  const nA = inwardNormal(pts2[1], pts2[0], hit.ring, ctr), nB = inwardNormal(pts2[m - 2], pts2[m - 1], hit.ring, ctr);
  return {
    ...base(hit, o, c), shape, pts: pts2.map((q) => fWorld(f, q, d0)), dir: f.dir, span,
    hookA: o.hookA, hookB: o.hookB, hookNA: fVec(f, nA), hookNB: fVec(f, nB),
  };
}

/** Optionen eines vorhandenen Satzes (für Neuberechnung) */
export function optsOf(el: Rebar): BuildOpts {
  return {
    kind: (el.fit?.kind ?? el.shape) as ShapeKind, dia: el.dia, hookA: el.hookA ?? 0, hookB: el.hookB ?? 0, legLen: el.fit?.legLen ?? 0,
    layout: el.layout, count: el.count, spacing: el.spacing, cover: el.cover ?? 0, display: el.display ?? 'first',
    layer: el.fit?.slab ?? 'u1', orient: el.fit?.orient ?? 'par',
  };
}

/** Erweiterung: eigene Einpassung (z. B. Treppenbewehrung); null = nicht zuständig */
export const refitHooks: ((doc: Doc, el: Rebar, patch: Partial<Rebar>) => Partial<Rebar> | null)[] = [];

/** Satz neu in den Host einpassen (z. B. nach Änderung von Ø oder Deckung). Liefert Patch. */
export function refit(doc: Doc, el: Rebar, patch: Partial<Rebar>): Partial<Rebar> {
  for (const h of refitHooks) { const r = h(doc, el, patch); if (r) return r; }
  const fit = el.fit; const host = doc.get(el.hostId);
  if (!fit || !host) return patch;
  const o: BuildOpts = optsOf(el);
  if (patch.dia !== undefined) o.dia = patch.dia;
  if ('cover' in patch) o.cover = patch.cover ?? 0;
  if (patch.hookA !== undefined) o.hookA = patch.hookA;
  if (patch.hookB !== undefined) o.hookB = patch.hookB;
  if (patch.layout) o.layout = patch.layout;
  const f: Frame = { origin: fit.o, right: fit.r, up: fit.u, dir: fit.d };
  let r: Partial<Rebar> | null = null;
  if (fit.slab) {
    const hit = slabAt(doc, fit.c, Infinity, host.id);
    if (hit) r = buildSlab(doc, hit, fit.c, o);
  } else {
    const hit = hostAt(doc, f, fit.c, host.id);
    if (hit) r = buildFitted(doc, hit, fit.c, o, el.id);
  }
  if (!r) return patch;
  return { ...patch, pts: r.pts, dir: r.dir, span: r.span, hookNA: r.hookNA, hookNB: r.hookNB, coverUsed: r.coverUsed, fit: { ...fit, single: o.layout === 'single' } };
}
