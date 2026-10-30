// Dachgeometrie (Dach über Grundfläche): für jede neigungsdefinierende Kante eine Ebene, die
// von der Kante nach innen ansteigt. Dachfläche = untere Hülle der Ebenen, wobei jede Ebene nur
// in ihrem "Keil" gilt (begrenzt durch die gewichteten Winkelhalbierenden an den Kantenenden bzw.
// durch die Linie einer benachbarten Giebelkante).
import {
  V2, Ring, Poly, MultiPoly, sub, add, mul, dot, perp, norm, signedArea, pointInRing, pointInPoly,
  intersection, difference, union, clipRingHalfPlane, bboxOf, rad, polyArea, dist,
} from '../../core/geom';

export interface EdgeAttr { slope?: boolean; angle?: number }

export interface REdge {
  a: V2; b: V2; d: V2;
  /** Innennormale (zur Dachfläche) */
  n: V2;
  slope: boolean;
  tan: number;
  angle: number;
  prev: number; next: number;
}
export interface RoofFace { poly: Poly; edge: number; n: V2; P: V2; tan: number; angle: number }
export interface RoofGeom {
  edges: REdge[];
  footprint: MultiPoly;
  /** null = Flachdach */
  faces: RoofFace[] | null;
  /** größte Höhe über Traufe (Unterseite) */
  rise: number;
}

/** Ringe orientieren: äußere gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn (Dachfläche immer links). */
export function orientRings<T>(rings: V2[][], attrs?: T[][]): { rings: V2[][]; attrs: T[][] } {
  const outR: V2[][] = []; const outA: T[][] = [];
  rings.forEach((r, k) => {
    if (r.length < 3) return;
    // Testpunkt: Mitte der ersten Kante, minimal nach links/rechts versetzt nicht nötig – Ecke reicht meist
    const tp = r[0];
    let depth = 0;
    rings.forEach((o, j) => { if (j !== k && o.length >= 3 && Math.abs(signedArea(o)) > Math.abs(signedArea(r)) && pointInRing(tp, o)) depth++; });
    const wantCCW = depth % 2 === 0;
    const a: T[] = attrs?.[k] ?? r.map(() => ({} as T));
    if ((signedArea(r) > 0) === wantCCW) { outR.push(r.slice()); outA.push(r.map((_, i) => a[i] ?? ({} as T))); }
    else {
      const n = r.length;
      outR.push(r.slice().reverse());
      outA.push(r.map((_, i) => a[(((n - 2 - i) % n) + n) % n] ?? ({} as T)));
    }
  });
  return { rings: outR, attrs: outA };
}

/** Grundfläche aus orientierten Ringen (äußere minus Löcher) */
export function footprintOf(rings: V2[][]): MultiPoly {
  const outer = rings.filter((r) => signedArea(r) > 0).map((r) => [r] as Poly);
  const holes = rings.filter((r) => signedArea(r) < 0).map((r) => [r.slice().reverse()] as Poly);
  if (!outer.length) return [];
  const u = union(outer);
  return holes.length ? difference(u, ...holes) : u;
}

function bisector(e1: REdge, e2: REdge): V2 {
  // Linie, auf der beide Ebenen gleich hoch sind: (t1 n1 - t2 n2) · v = 0
  const g = sub(mul(e1.n, e1.tan), mul(e2.n, e2.tan));
  let v = Math.hypot(g.x, g.y) < 1e-9 ? e1.n : norm(perp(g));
  if (dot(e1.n, v) < 0) v = mul(v, -1);
  return v;
}

/** Koordinaten runden (0,001 mm) und doppelte/kollineare Punkte entfernen – macht polygon-clipping robust */
export function cleanRing(r: Ring): Ring {
  const q = r.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
  let out: Ring = [];
  for (const p of q) { const l = out[out.length - 1]; if (!l || Math.abs(l.x - p.x) > 1e-3 || Math.abs(l.y - p.y) > 1e-3) out.push(p); }
  while (out.length > 2 && Math.abs(out[0].x - out[out.length - 1].x) <= 1e-3 && Math.abs(out[0].y - out[out.length - 1].y) <= 1e-3) out.pop();
  // kollineare Punkte
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const l = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      if (Math.abs(cr) / l < 1e-3) { out = out.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return out;
}
export const cleanPoly = (p: Poly): Poly => p.map(cleanRing).filter((r) => r.length >= 3);
export const cleanMulti = (m: MultiPoly): MultiPoly => m.map(cleanPoly).filter((p) => p.length > 0);

/** Halbebene (als Clip) so, dass Punkt X behalten wird */
function clipKeep(r: Ring, a: V2, dir: V2, X: V2): Ring {
  const c = dir.x * (X.y - a.y) - dir.y * (X.x - a.x);
  return clipRingHalfPlane(r, a, c >= 0 ? dir : mul(dir, -1));
}

export function roofGeom(rings0: V2[][], attrs0: EdgeAttr[][], cutouts: Poly[] = []): RoofGeom {
  const { rings, attrs } = orientRings(rings0, attrs0);
  let footprint = cleanMulti(footprintOf(rings.map(cleanRing)));
  if (cutouts.length && footprint.length) footprint = cleanMulti(difference(footprint, ...cutouts));
  const edges: REdge[] = [];
  for (let k = 0; k < rings.length; k++) {
    const r = rings[k]; const n = r.length; const base = edges.length;
    for (let i = 0; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n]; const d = norm(sub(b, a));
      const at = attrs[k][i] ?? {};
      const angle = at.angle ?? 35;
      const slope = !!at.slope && angle > 0.01 && angle < 89 && dist(a, b) > 1;
      edges.push({ a, b, d, n: perp(d), slope, tan: slope ? Math.tan(rad(angle)) : 0, angle: slope ? angle : 0, prev: base + ((i - 1 + n) % n), next: base + ((i + 1) % n) });
    }
  }
  const sloped = edges.map((e, i) => (e.slope ? i : -1)).filter((i) => i >= 0);
  if (!sloped.length || !footprint.length) return { edges, footprint, faces: null, rise: 0 };

  // großes Rechteck als Ausgangspunkt für Keile
  const all = rings.flat();
  const bb = bboxOf(all);
  const D = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * 2 + 1000;
  const big: Ring = [{ x: bb.min.x - D, y: bb.min.y - D }, { x: bb.max.x + D, y: bb.min.y - D }, { x: bb.max.x + D, y: bb.max.y + D }, { x: bb.min.x - D, y: bb.max.y + D }];

  const W = new Map<number, Ring>();
  for (const i of sloped) {
    const e = edges[i];
    let w = clipRingHalfPlane(big, e.a, e.d);
    const p = edges[e.prev], q = edges[e.next];
    if (p.slope) w = clipKeep(w, e.a, bisector(p, e), add(e.a, e.d));
    else if (dist(p.a, p.b) > 1) w = clipRingHalfPlane(w, p.a, p.d);
    if (q.slope) w = clipKeep(w, e.b, bisector(e, q), sub(e.b, e.d));
    else if (dist(q.a, q.b) > 1) w = clipRingHalfPlane(w, q.a, q.d);
    w = cleanRing(w);
    if (w.length >= 3 && Math.abs(signedArea(w)) > 1) W.set(i, w);
  }

  const faces: RoofFace[] = [];
  let rise = 0;
  for (const i of sloped) {
    const wi = W.get(i); if (!wi) continue;
    const ei = edges[i];
    const base = cleanMulti(intersection(footprint, [wi]));
    if (!base.length) continue;
    const subs: Poly[] = [];
    for (const j of sloped) {
      if (j === i) continue;
      const wj = W.get(j); if (!wj) continue;
      const ej = edges[j];
      // Bereich, in dem Ebene j tiefer liegt als Ebene i: g·p + c > 0
      const g = sub(mul(ei.n, ei.tan), mul(ej.n, ej.tan));
      const c = -ei.tan * dot(ei.n, ei.a) + ej.tan * dot(ej.n, ej.a);
      const gl = Math.hypot(g.x, g.y);
      if (gl < 1e-9) {
        if (c > 1e-6 || (Math.abs(c) <= 1e-6 && j < i)) subs.push([wj]);
        continue;
      }
      const p0 = mul(g, -c / (gl * gl));
      const r = cleanRing(clipRingHalfPlane(wj, p0, { x: g.y, y: -g.x }));
      if (r.length >= 3 && Math.abs(signedArea(r)) > 1) subs.push([r]);
    }
    const res = cleanMulti(subs.length ? difference(base, ...subs) : base);
    for (const poly of res) {
      if (polyArea(poly) < 100) continue;
      faces.push({ poly, edge: i, n: ei.n, P: ei.a, tan: ei.tan, angle: ei.angle });
      for (const ring of poly) for (const pt of ring) rise = Math.max(rise, ei.tan * dot(ei.n, sub(pt, ei.a)));
    }
  }
  return { edges, footprint, faces, rise };
}

/** Höhe der Dachunterseite (relativ zur Traufe) an Punkt p, null = außerhalb */
export function riseAt(g: RoofGeom, p: V2): { h: number; face: RoofFace | null } | null {
  if (!g.faces) return g.footprint.some((poly) => pointInPoly(p, poly)) ? { h: 0, face: null } : null;
  for (const f of g.faces) if (pointInPoly(p, f.poly)) return { h: f.tan * dot(f.n, sub(p, f.P)), face: f };
  return null;
}

export const faceRise = (f: RoofFace, p: V2): number => f.tan * dot(f.n, sub(p, f.P));
