// Geometrie-Grundlagen: Vektoren, Linien, Polygone, 2D-Transformationen.
// Alle Modellkoordinaten in Millimetern. X = Ost, Y = Nord, Z = oben.
import polygonClipping from 'polygon-clipping';

export interface V2 { x: number; y: number }
export interface V3 { x: number; y: number; z: number }

export const EPS = 1e-6;

export const v2 = (x: number, y: number): V2 => ({ x, y });
export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const cross = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.y);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: V2): V2 => { const l = len(a); return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; };
export const perp = (a: V2): V2 => ({ x: -a.y, y: a.x }); // 90° gegen den Uhrzeigersinn (links)
export const lerp = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: V2, b: V2): V2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const eq = (a: V2, b: V2, tol = 0.5): boolean => dist(a, b) <= tol;
export const angleOf = (a: V2): number => Math.atan2(a.y, a.x);
export const fromAngle = (ang: number, l = 1): V2 => ({ x: Math.cos(ang) * l, y: Math.sin(ang) * l });
export const rotate = (p: V2, ang: number, c: V2 = { x: 0, y: 0 }): V2 => {
  const s = Math.sin(ang), co = Math.cos(ang);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
};
export const clone2 = (a: V2): V2 => ({ x: a.x, y: a.y });

export const add3 = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul3 = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const len3 = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const norm3 = (a: V3): V3 => { const l = len3(a); return l < EPS ? { x: 0, y: 0, z: 0 } : mul3(a, 1 / l); };
export const lerp3 = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export const to3 = (p: V2, z = 0): V3 => ({ x: p.x, y: p.y, z });
export const to2 = (p: V3): V2 => ({ x: p.x, y: p.y });

export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;
export const normAngle = (a: number): number => { let r = a % (2 * Math.PI); if (r < 0) r += 2 * Math.PI; return r; };

// ---------------------------------------------------------------- Linien / Segmente

/** Parameter t des Lotfußpunkts von p auf die Gerade a-b (0 = a, 1 = b). */
export function projectT(p: V2, a: V2, b: V2): number {
  const d = sub(b, a); const l2 = dot(d, d);
  return l2 < EPS ? 0 : dot(sub(p, a), d) / l2;
}
export function closestOnSeg(p: V2, a: V2, b: V2): V2 {
  const t = Math.max(0, Math.min(1, projectT(p, a, b)));
  return lerp(a, b, t);
}
export function closestOnLine(p: V2, a: V2, b: V2): V2 { return lerp(a, b, projectT(p, a, b)); }
export function distToSeg(p: V2, a: V2, b: V2): number { return dist(p, closestOnSeg(p, a, b)); }
export function distToLine(p: V2, a: V2, b: V2): number { return dist(p, closestOnLine(p, a, b)); }
/** Vorzeichenbehafteter Abstand (positiv = links der Richtung a->b). */
export function sideDist(p: V2, a: V2, b: V2): number {
  const d = norm(sub(b, a));
  return cross(d, sub(p, a));
}

/** Schnittpunkt zweier unendlicher Geraden. */
export function lineLine(a1: V2, a2: V2, b1: V2, b2: V2): { p: V2; t: number; u: number } | null {
  const r = sub(a2, a1), s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9 * (len(r) * len(s) + 1)) return null;
  const qp = sub(b1, a1);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  return { p: add(a1, mul(r, t)), t, u };
}
export function segSeg(a1: V2, a2: V2, b1: V2, b2: V2, tol = 1e-9): V2 | null {
  const r = lineLine(a1, a2, b1, b2);
  if (!r) return null;
  if (r.t < -tol || r.t > 1 + tol || r.u < -tol || r.u > 1 + tol) return null;
  return r.p;
}
/** Linie mit Kreis schneiden (unendliche Gerade). */
export function lineCircle(a: V2, b: V2, c: V2, r: number): V2[] {
  const d = sub(b, a); const f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < EPS) return [];
  const sq = Math.sqrt(disc);
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map((t) => add(a, mul(d, t)));
}
export function isParallel(a1: V2, a2: V2, b1: V2, b2: V2, angTol = 1e-3): boolean {
  const d1 = norm(sub(a2, a1)), d2 = norm(sub(b2, b1));
  return Math.abs(cross(d1, d2)) < angTol;
}

// ---------------------------------------------------------------- Polygone

export type Ring = V2[];
/** Polygon mit Löchern: erster Ring außen, weitere Ringe Löcher. */
export type Poly = Ring[];
export type MultiPoly = Poly[];

export function signedArea(r: Ring): number {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}
export function area(r: Ring): number { return Math.abs(signedArea(r)); }
export function polyArea(p: Poly): number { return p.reduce((s, r, i) => s + (i === 0 ? area(r) : -area(r)), 0); }
export function perimeter(r: Ring, closed = true): number {
  let s = 0; const n = r.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) s += dist(r[i], r[(i + 1) % n]);
  return s;
}
export function centroid(r: Ring): V2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n]; const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f; a += f;
  }
  if (Math.abs(a) < EPS) { const b = bboxOf(r); return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }; }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
export function pointInRing(p: V2, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function pointInPoly(p: V2, poly: Poly): boolean {
  if (!poly.length || !pointInRing(p, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(p, poly[i])) return false;
  return true;
}
export function ensureCCW(r: Ring): Ring { return signedArea(r) < 0 ? r.slice().reverse() : r; }
export function ensureCW(r: Ring): Ring { return signedArea(r) > 0 ? r.slice().reverse() : r; }

/** Punkt, der sicher im Polygon liegt (für Beschriftungen). */
export function interiorPoint(poly: Poly): V2 {
  const c = centroid(poly[0]);
  if (pointInPoly(c, poly)) return c;
  // horizontale Abtastlinie durch die Mitte, längstes Innenstück wählen
  const b = bboxOf(poly[0]);
  let best: V2 = c; let bestLen = -1;
  for (let k = 1; k < 10; k++) {
    const y = b.min.y + ((b.max.y - b.min.y) * k) / 10;
    const xs: number[] = [];
    for (const r of poly) for (let i = 0; i < r.length; i++) {
      const a = r[i], q = r[(i + 1) % r.length];
      if ((a.y > y) !== (q.y > y)) xs.push(a.x + ((y - a.y) / (q.y - a.y)) * (q.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const l = xs[i + 1] - xs[i];
      if (l > bestLen) { bestLen = l; best = { x: (xs[i] + xs[i + 1]) / 2, y }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------- Bounding Box

export interface BBox { min: V2; max: V2 }
export function bboxOf(pts: V2[]): BBox {
  const b = emptyBox();
  for (const p of pts) extendBox(b, p);
  return b;
}
export function emptyBox(): BBox { return { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } }; }
export function extendBox(b: BBox, p: V2): void {
  if (p.x < b.min.x) b.min.x = p.x; if (p.y < b.min.y) b.min.y = p.y;
  if (p.x > b.max.x) b.max.x = p.x; if (p.y > b.max.y) b.max.y = p.y;
}
export function boxValid(b: BBox): boolean { return b.min.x <= b.max.x && b.min.y <= b.max.y; }
export function boxUnion(a: BBox, b: BBox): BBox {
  return { min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y) }, max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y) } };
}
export function boxInflate(b: BBox, d: number): BBox { return { min: { x: b.min.x - d, y: b.min.y - d }, max: { x: b.max.x + d, y: b.max.y + d } }; }
export function boxContains(b: BBox, p: V2): boolean { return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y; }
export function boxOverlap(a: BBox, b: BBox): boolean { return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y; }
export function boxCorners(b: BBox): Ring { return [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }]; }
export function segIntersectsBox(a: V2, c: V2, b: BBox): boolean {
  if (boxContains(b, a) || boxContains(b, c)) return true;
  const r = boxCorners(b);
  for (let i = 0; i < 4; i++) if (segSeg(a, c, r[i], r[(i + 1) % 4])) return true;
  return false;
}

// ---------------------------------------------------------------- 2D-Affintransformation
// | a c e |
// | b d f |
export interface Mat2 { a: number; b: number; c: number; d: number; e: number; f: number }
export const I2: Mat2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export function apply(m: Mat2, p: V2): V2 { return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; }
export function applyVec(m: Mat2, p: V2): V2 { return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y }; }
export function compose(m: Mat2, n: Mat2): Mat2 { // m ∘ n (erst n, dann m)
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  };
}
export function invert(m: Mat2): Mat2 {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}
export const translation = (dx: number, dy: number): Mat2 => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export const scaling = (s: number, c: V2 = { x: 0, y: 0 }): Mat2 => ({ a: s, b: 0, c: 0, d: s, e: c.x - s * c.x, f: c.y - s * c.y });
export function rotation(ang: number, c: V2 = { x: 0, y: 0 }): Mat2 {
  const co = Math.cos(ang), s = Math.sin(ang);
  return { a: co, b: s, c: -s, d: co, e: c.x - co * c.x + s * c.y, f: c.y - s * c.x - co * c.y };
}
/** Spiegelung an der Geraden p1-p2. */
export function mirrorMat(p1: V2, p2: V2): Mat2 {
  const d = norm(sub(p2, p1));
  const a = d.x * d.x - d.y * d.y, b = 2 * d.x * d.y;
  const m: Mat2 = { a, b, c: b, d: -a, e: 0, f: 0 };
  const q = apply(m, p1);
  return { ...m, e: p1.x - q.x, f: p1.y - q.y };
}
export const isMirror = (m: Mat2) => m.a * m.d - m.b * m.c < 0;
export const matAngle = (m: Mat2) => Math.atan2(m.b, m.a);
export const matScale = (m: Mat2) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

// ---------------------------------------------------------------- Polygon-Boolesche Operationen

type PCPoly = [number, number][][];
const toPC = (p: Poly): PCPoly => p.map((r) => r.map((q) => [q.x, q.y] as [number, number]));
const fromPC = (m: [number, number][][][]): MultiPoly =>
  m.map((poly) => poly.map((ring) => {
    const r = ring.map(([x, y]) => ({ x, y }));
    if (r.length > 1 && eq(r[0], r[r.length - 1], 1e-9)) r.pop();
    return r;
  }));

function safe(fn: () => [number, number][][][]): MultiPoly {
  try { return fromPC(fn()); } catch (e) { console.warn('Polygonoperation fehlgeschlagen', e); return []; }
}
const valid = (p: Poly) => p.length > 0 && p[0].length >= 3;
export function union(polys: Poly[]): MultiPoly {
  const v = polys.filter(valid);
  if (v.length === 0) return [];
  if (v.length === 1) return safe(() => polygonClipping.union(toPC(v[0]) as any));
  return safe(() => polygonClipping.union(toPC(v[0]) as any, ...v.slice(1).map((p) => toPC(p) as any)));
}
export function difference(a: Poly | MultiPoly, ...b: (Poly | MultiPoly)[]): MultiPoly {
  const A = isMulti(a) ? (a as MultiPoly).map(toPC) : [toPC(a as Poly)];
  const B = b.flatMap((x) => (isMulti(x) ? (x as MultiPoly).map(toPC) : [toPC(x as Poly)])).filter((x) => x.length && x[0].length >= 3);
  if (!A.length || !A[0].length) return [];
  if (!B.length) return safe(() => polygonClipping.union(A as any));
  return safe(() => polygonClipping.difference(A as any, ...(B as any)));
}
export function intersection(a: Poly | MultiPoly, b: Poly | MultiPoly): MultiPoly {
  const A = isMulti(a) ? (a as MultiPoly).map(toPC) : [toPC(a as Poly)];
  const B = isMulti(b) ? (b as MultiPoly).map(toPC) : [toPC(b as Poly)];
  if (!A.length || !B.length) return [];
  return safe(() => polygonClipping.intersection(A as any, B as any));
}
function isMulti(x: Poly | MultiPoly): boolean {
  return Array.isArray(x) && x.length > 0 && Array.isArray(x[0]) && (x[0] as any).length > 0 && Array.isArray((x[0] as any)[0]);
}

/** Rechteck (als Ring) um ein Segment mit halber Breite w. */
export function segRect(a: V2, b: V2, wLeft: number, wRight = wLeft, extA = 0, extB = 0): Ring {
  const d = norm(sub(b, a)); const n = perp(d);
  const a2 = sub(a, mul(d, extA)), b2 = add(b, mul(d, extB));
  return [add(a2, mul(n, -wRight)), add(b2, mul(n, -wRight)), add(b2, mul(n, wLeft)), add(a2, mul(n, wLeft))];
}

/** Polylinie (offen) parallel versetzen; positiver Wert = links. */
export function offsetPolyline(pts: V2[], d: number, closed = false): V2[] {
  const n = pts.length; if (n < 2) return pts.slice();
  const res: V2[] = [];
  const segs: [V2, V2][] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n]; const nn = mul(perp(norm(sub(b, a))), d);
    segs.push([add(a, nn), add(b, nn)]);
  }
  const m = segs.length;
  for (let i = 0; i < n; i++) {
    if (!closed && i === 0) { res.push(segs[0][0]); continue; }
    if (!closed && i === n - 1) { res.push(segs[m - 1][1]); continue; }
    const s1 = segs[(i - 1 + m) % m], s2 = segs[i % m];
    const x = lineLine(s1[0], s1[1], s2[0], s2[1]);
    res.push(x ? x.p : s2[0]);
  }
  return res;
}

/** Polygon an Ebene clippen (3D, Sutherland-Hodgman). Behält den Teil mit dot(p-o,n) >= 0. */
export function clipPolyByPlane(pts: V3[], o: V3, n: V3): V3[] {
  const out: V3[] = []; const m = pts.length;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const da = dot3(sub3(a, o), n), db = dot3(sub3(b, o), n);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(lerp3(a, b, t)); }
  }
  return out;
}

/** Ring (2D) an Halbebene clippen: behält Seite mit cross(dir, p-a) >= 0 (links). */
export function clipRingHalfPlane(r: Ring, a: V2, dir: V2): Ring {
  const out: Ring = []; const m = r.length;
  const s = (p: V2) => cross(dir, sub(p, a));
  for (let i = 0; i < m; i++) {
    const p = r[i], q = r[(i + 1) % m]; const sp = s(p), sq = s(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) out.push(lerp(p, q, sp / (sp - sq)));
  }
  return out;
}

export function polylineLength(pts: V2[]): number { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

export function roundTo(v: number, step: number): number { return Math.round(v / step) * step; }
export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

/** Kreisbogen als Polylinie (Winkel in rad, gegen Uhrzeigersinn von a0 nach a1). */
export function arcPoints(c: V2, r: number, a0: number, a1: number, segs = 24): V2[] {
  let sweep = a1 - a0; if (sweep < 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil((segs * sweep) / (Math.PI * 2)) + 1);
  const pts: V2[] = [];
  for (let i = 0; i <= n; i++) pts.push(add(c, fromAngle(a0 + (sweep * i) / n, r)));
  return pts;
}
