// Bewehrung – Ansichtsrahmen (Grundriss in Schnitthöhe / Schnittebene) und Host-Suche:
// welches Betonbauteil liegt unter dem Cursor, mit Schnittpolygon und Tiefenausdehnung.
import type { Doc, El, Id } from '../../../core/doc';
import { V2, V3, add3, mul3, sub3, dot3, Poly, pointInPoly, polyArea, Mat2, apply, applyVec } from '../../../core/geom';
import { View, makeProjector, isPlanLike, isSectionLike } from '../../../core/view';
import type { Detail } from '../../../core/view';
import { cutPolysOfElement, solidsOf, Projector } from '../../../views/sectionEngine';
import { planRange } from '../../../views/viewBuilder';
import { HOST_CATS, isConcrete, solidBox } from '../common';

export interface Frame { origin: V3; right: V3; up: V3; dir: V3 }
export const fView = (f: Frame, p: V3): V2 => { const q = sub3(p, f.origin); return { x: dot3(q, f.right), y: dot3(q, f.up) }; };
export const fDepth = (f: Frame, p: V3): number => dot3(sub3(p, f.origin), f.dir);
export const fWorld = (f: Frame, p: V2, d = 0): V3 => add3(add3(add3(f.origin, mul3(f.right, p.x)), mul3(f.up, p.y)), mul3(f.dir, d));
export const fVec = (f: Frame, v: V2): V3 => add3(mul3(f.right, v.x), mul3(f.up, v.y));
export const planFrame = (z: number): Frame => ({ origin: { x: 0, y: 0, z }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 } });
export function sectionFrame(v: View): Frame { const p = makeProjector(v); return { origin: p.origin, right: p.right, up: p.up, dir: p.dir }; }
export const projOf = (f: Frame): Projector => ({ origin: f.origin, dir: f.dir, toView: (p) => fView(f, p), depth: (p) => fDepth(f, p) });

/** Rahmen der Ansicht: Grundriss in Schnitthöhe (Blick nach unten), Schnitt = Schnittebene */
export function viewFrame(doc: Doc, view: View): Frame | null {
  if (view.kind === 'plan') return planFrame(planRange(doc, view).cutZ);
  if (isSectionLike(view)) return sectionFrame(view);
  return null;
}

// ------------------------------------------------------------ Darstellungsrahmen (Sichtbarkeit nach Tiefe)
export interface VF extends Frame { near: number; far: number; scale: number; detail: Detail; plan: boolean }
export function vfOf(doc: Doc, view: View): VF | null {
  if (view.kind === 'plan') {
    const r = planRange(doc, view);
    return { ...planFrame(r.cutZ), near: 0, far: r.cutZ - r.depthZ + 1500, scale: view.scale || 100, detail: view.detail, plan: true };
  }
  if (view.kind === 'section') return { ...sectionFrame(view), near: 0, far: view.far ?? 1e7, scale: view.scale || 100, detail: view.detail, plan: false };
  return null;
}

// ------------------------------------------------------------ 3D-Abbildung aus 2D-Transformation der Ansicht
export interface Xf3 { p(v: V3): V3; v(v: V3): V3 }
export function xfOfView(m: Mat2, view: View): Xf3 | null {
  if (isPlanLike(view)) return {
    p: (q) => ({ ...apply(m, q), z: q.z }),
    v: (q) => ({ ...applyVec(m, q), z: q.z }),
  };
  if (isSectionLike(view)) {
    const f = sectionFrame(view);
    return {
      p: (q) => fWorld(f, apply(m, fView(f, q)), fDepth(f, q)),
      v: (q) => add3(fVec(f, applyVec(m, { x: dot3(q, f.right), y: dot3(q, f.up) })), mul3(f.dir, dot3(q, f.dir))),
    };
  }
  return null;
}
export const xfTranslate = (d: V3): Xf3 => ({ p: (q) => add3(q, d), v: (q) => q });

// ------------------------------------------------------------ Host-Suche
export interface HostHit { host: El; ring: V2[]; poly: Poly; mat?: Id; dmin: number; dmax: number; frame: Frame; zmin: number; zmax: number }

function depthRange(doc: Doc, el: El, f: Frame, mat: Id | undefined): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const s of solidsOf(doc, el)) {
    if (mat !== undefined && s.mat !== mat) continue;
    for (const fc of s.faces) for (const p of fc.pts) { const d = fDepth(f, p); if (d < lo) lo = d; if (d > hi) hi = d; }
  }
  return [lo, hi];
}

export function hostCandidates(doc: Doc): El[] {
  const out: El[] = [];
  for (const c of HOST_CATS) for (const e of doc.all(c)) if (!e.viewId) out.push(e);
  return out;
}

function boxCorners3(b: { min: V3; max: V3 }): V3[] {
  const o: V3[] = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) o.push({ x, y, z });
  return o;
}

/** Betonbauteil, dessen Schnittfläche (Ebene depth = 0 des Rahmens) den Punkt p enthält */
export function hostAt(doc: Doc, f: Frame, p: V2, only?: Id | null): HostHit | null {
  let best: HostHit | null = null; let bestA = Infinity;
  const pr = projOf(f);
  for (const el of hostCandidates(doc)) {
    if (only && el.id !== only) continue;
    const b = solidBox(doc, el); if (!b) continue;
    let dlo = Infinity, dhi = -Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of boxCorners3(b)) {
      const d = fDepth(f, c); if (d < dlo) dlo = d; if (d > dhi) dhi = d;
      const v = fView(f, c); if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x; if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
    }
    if (dlo > 0 || dhi < 0 || p.x < x0 - 1 || p.x > x1 + 1 || p.y < y0 - 1 || p.y > y1 + 1) continue;
    for (const c of cutPolysOfElement(doc, el, pr)) {
      if (!isConcrete(doc, c.mat)) continue;
      for (const poly of c.polys) {
        if (!pointInPoly(p, poly)) continue;
        const a = polyArea(poly);
        if (a >= bestA) continue;
        const [dmin, dmax] = depthRange(doc, el, f, c.mat);
        const bb = solidBox(doc, el, c.mat ?? null) ?? b;
        best = { host: el, ring: poly[0], poly, mat: c.mat, dmin, dmax, frame: f, zmin: bb.min.z, zmax: bb.max.z };
        bestA = a;
      }
    }
  }
  return best;
}

/** Grundriss: liegendes Bauteil (Decke, Bodenplatte …) unterhalb der Schnittebene am Punkt p */
export function slabAt(doc: Doc, p: V2, cutZ: number, only?: Id | null): HostHit | null {
  let best: HostHit | null = null;
  for (const el of hostCandidates(doc)) {
    if (only && el.id !== only) continue;
    if (el.cat === 'wall' || el.cat === 'column' || el.cat === 'stair') continue;
    const b = solidBox(doc, el); if (!b) continue;
    if (b.min.z > cutZ + 1) continue;
    if (p.x < b.min.x || p.x > b.max.x || p.y < b.min.y || p.y > b.max.y) continue;
    if (best && b.max.z <= best.zmax) continue;
    const zm = (b.min.z + b.max.z) / 2;
    const f = planFrame(zm);
    for (const c of cutPolysOfElement(doc, el, projOf(f))) {
      if (!isConcrete(doc, c.mat)) continue;
      const poly = c.polys.find((q) => pointInPoly(p, q));
      if (!poly) continue;
      const bb = solidBox(doc, el, c.mat ?? null) ?? b;
      best = { host: el, ring: poly[0], poly, mat: c.mat, dmin: zm - bb.max.z, dmax: zm - bb.min.z, frame: f, zmin: bb.min.z, zmax: bb.max.z };
      break;
    }
  }
  return best;
}

/** Plan-Umriss eines liegenden Bauteils (für Flächen-/Mattenbewehrung) */
export function slabOutline(doc: Doc, el: El): Poly[] {
  const b = solidBox(doc, el); if (!b) return [];
  const f = planFrame((b.min.z + b.max.z) / 2);
  const out: Poly[] = [];
  for (const c of cutPolysOfElement(doc, el, projOf(f))) if (isConcrete(doc, c.mat)) out.push(...c.polys);
  return out;
}

export { isPlanLike };
