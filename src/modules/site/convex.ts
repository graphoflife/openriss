// Konvexe Polygone (lokale Koordinaten, gegen den Uhrzeigersinn): Halbebenen-Schnitt und -Teilung, Ebenen
// z = a·x + b·y + c, Flächen/Integrale, Zerlegung einfacher Polygone in konvexe Teile (Ohrenschnitt + Hertel–Mehlhorn).
import type { V2 } from '../../core/geom';
import type { Plane } from './tin';

export type Conv = V2[];
const EPS = 1e-7;
const AREA_MIN = 1e-4;

export function sArea(p: Conv): number { let s = 0; for (let i = 0, n = p.length; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; s += a.x * b.y - b.x * a.y; } return s / 2; }
export function centroidOf(p: Conv): V2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[i], r = p[(i + 1) % n]; const f = q.x * r.y - r.x * q.y; cx += (q.x + r.x) * f; cy += (q.y + r.y) * f; a += f; }
  if (Math.abs(a) < 1e-12) { let x = 0, y = 0; for (const q of p) { x += q.x; y += q.y; } return { x: x / p.length, y: y / p.length }; }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
export const evalP = (f: Plane, x: number, y: number): number => f[0] * x + f[1] * y + f[2];
export const addP = (f: Plane, g: Plane): Plane => [f[0] + g[0], f[1] + g[1], f[2] + g[2]];
export const subP = (f: Plane, g: Plane): Plane => [f[0] - g[0], f[1] - g[1], f[2] - g[2]];

function clean(p: V2[]): Conv | null {
  const out: V2[] = [];
  for (const q of p) { const l = out[out.length - 1]; if (!l || Math.abs(l.x - q.x) > 1e-9 || Math.abs(l.y - q.y) > 1e-9) out.push(q); }
  while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) <= 1e-9 && Math.abs(out[0].y - out[out.length - 1].y) <= 1e-9) out.pop();
  return out.length >= 3 && sArea(out) > AREA_MIN ? out : null;
}

/** Teilt p an der Geraden n·x = c (n normiert): [Teil mit n·x ≤ c, Teil mit n·x ≥ c] */
export function splitHP(p: Conv, nx: number, ny: number, c: number): [Conv | null, Conv | null] {
  const m = p.length; const s = new Array<number>(m);
  let lo = false, hi = false;
  for (let i = 0; i < m; i++) { s[i] = nx * p[i].x + ny * p[i].y - c; if (s[i] < -EPS) lo = true; if (s[i] > EPS) hi = true; }
  if (!hi) return [p, null];
  if (!lo) return [null, p];
  const A: V2[] = [], B: V2[] = [];
  for (let i = 0; i < m; i++) {
    const P = p[i], Q = p[(i + 1) % m], sp = s[i], sq = s[(i + 1) % m];
    if (sp <= EPS) A.push(P); if (sp >= -EPS) B.push(P);
    if ((sp < -EPS && sq > EPS) || (sp > EPS && sq < -EPS)) { const t = sp / (sp - sq); const X = { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t }; A.push(X); B.push(X); }
  }
  return [clean(A), clean(B)];
}
/** Teil mit n·x ≤ c */
export const clipHP = (p: Conv, nx: number, ny: number, c: number): Conv | null => splitHP(p, nx, ny, c)[0];
/** Halbebene links der gerichteten Kante a→b als (n, c) mit n·x ≤ c */
export function leftOf(a: V2, b: V2): [number, number, number] {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const nx = dy / L, ny = -dx / L; // rechte Normale: links ⇔ n·(x−a) ≤ 0
  return [nx, ny, nx * a.x + ny * a.y];
}
/** Schnitt zweier konvexer Polygone */
export function clipConv(p: Conv, q: Conv): Conv | null {
  let r: Conv | null = p;
  for (let i = 0; i < q.length && r; i++) { const [nx, ny, c] = leftOf(q[i], q[(i + 1) % q.length]); r = clipHP(r, nx, ny, c); }
  return r;
}
/** Teilt p nach dem Vergleich zweier Ebenen: [Teil mit f < g, Rest] */
export function splitLower(p: Conv, f: Plane, g: Plane): [Conv | null, Conv | null] {
  const da = f[0] - g[0], db = f[1] - g[1], dc = f[2] - g[2]; const L = Math.hypot(da, db);
  if (L < 1e-12) return dc < -1e-9 ? [p, null] : [null, p];
  return splitHP(p, da / L, db / L, -dc / L - 1e-9);
}
export function bboxC(p: Conv): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y; }
  return [x0, y0, x1, y1];
}
export const boxHit = (a: number[], b: number[], tol = 1e-6) => a[0] <= b[2] + tol && a[2] >= b[0] - tol && a[1] <= b[3] + tol && a[3] >= b[1] - tol;
/** Integral einer Ebene über ein Polygon (= Fläche × Wert im Schwerpunkt) */
export function integral(p: Conv, f: Plane): number { const A = sArea(p); const c = centroidOf(p); return A * evalP(f, c.x, c.y); }
/** wahre (geneigte) Fläche */
export const trueArea = (p: Conv, f: Plane): number => sArea(p) * Math.sqrt(1 + f[0] * f[0] + f[1] * f[1]);

// ------------------------------------------------------------ Zerlegung in konvexe Teile
const cr = (o: V2, a: V2, b: V2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
export function isConvex(r: V2[]): boolean {
  const n = r.length; if (n < 3) return false;
  for (let i = 0; i < n; i++) if (cr(r[i], r[(i + 1) % n], r[(i + 2) % n]) < -1e-6 * (1 + Math.hypot(r[(i + 1) % n].x - r[i].x, r[(i + 1) % n].y - r[i].y) ** 2)) return false;
  return true;
}

/** Teil einer Zerlegung: Ecken (gegen den Uhrzeigersinn) und je Kante pts[i] → pts[i+1] die Umrisskante (−1 = Schnitt) */
export interface Part { pts: V2[]; ci: number[] }

/**
 * Einfaches Polygon (gegen den Uhrzeigersinn) in konvexe Teile zerlegen – nur mit Schnitten entlang der Verlängerung
 * einer Kante an einer einspringenden Ecke (Steinerpunkte auf dem Umriss). So behält jede ausspringende Ecke ihre beiden
 * Kanten im selben Teil (Grat der Böschungen), und der Schnitt ist im einen Teil die Fortsetzung der Umrisskante.
 * ci: Umrisskante je Kante (Standard: Index).
 */
export function convexParts(r: V2[], ci: number[] = r.map((_, i) => i)): Part[] {
  const out: Part[] = [];
  const todo: Part[] = [{ pts: r.slice(), ci: ci.slice() }];
  for (let guard = 0; todo.length && guard < 200; guard++) {
    const P = mergeCollinear(todo.pop()!); const n = P.pts.length;
    if (n < 3) continue;
    let iv = -1;
    for (let i = 0; i < n && iv < 0; i++) { const a = P.pts[(i + n - 1) % n], b = P.pts[i], c = P.pts[(i + 1) % n]; if (cr(a, b, c) < -1e-6 * (1 + Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y))) iv = i; }
    if (iv < 0) { out.push(P); continue; }
    // Strahl in Verlängerung der ankommenden Kante
    const v = P.pts[iv], w = P.pts[(iv + n - 1) % n]; const L = Math.hypot(v.x - w.x, v.y - w.y) || 1;
    const d = { x: (v.x - w.x) / L, y: (v.y - w.y) / L };
    let best = Infinity, bj = -1, bu = 0;
    for (let j = 0; j < n; j++) {
      if (j === iv || j === (iv + n - 1) % n) continue;
      const a = P.pts[j], b = P.pts[(j + 1) % n]; const ex = b.x - a.x, ey = b.y - a.y;
      const den = d.x * ey - d.y * ex; if (Math.abs(den) < 1e-12) continue;
      const qx = a.x - v.x, qy = a.y - v.y;
      const t = (qx * ey - qy * ex) / den, u = (qx * d.y - qy * d.x) / den;
      if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) { best = t; bj = j; bu = u; }
    }
    if (bj < 0) { out.push(P); continue; }
    const s = { x: v.x + d.x * best, y: v.y + d.y * best };
    const at = (k: number) => P.pts[((k % n) + n) % n], cAt = (k: number) => P.ci[((k % n) + n) % n];
    const jEnd = bu > 1 - 1e-9 ? bj + 1 : bj; // Treffer auf einer Ecke: keine neue Ecke
    const steiner = bu > 1e-9 && bu < 1 - 1e-9;
    // Teil 1: v → … → Kante bj → s, Schnitt s → v (innen)
    const A: Part = { pts: [], ci: [] };
    for (let k = iv; ; k++) { const kk = ((k % n) + n) % n; A.pts.push(at(kk)); if (kk === ((jEnd % n) + n) % n) break; A.ci.push(cAt(kk)); }
    if (steiner) { A.ci.push(cAt(bj)); A.pts.push(s); }
    A.ci.push(-1);
    // Teil 2: s → … → w → (v) mit Schnitt v → s als Fortsetzung der ankommenden Kante
    const B: Part = { pts: [], ci: [] };
    if (steiner) { B.pts.push(s); B.ci.push(cAt(bj)); }
    for (let k = bj + 1; ; k++) { const kk = ((k % n) + n) % n; B.pts.push(at(kk)); if (kk === iv) break; B.ci.push(cAt(kk)); }
    B.ci.push(cAt(iv - 1));
    todo.push(A, B);
  }
  return out;
}
/** aufeinanderfolgende kollineare Kanten mit gleicher Umrisskante zusammenfassen, doppelte Punkte entfernen */
function mergeCollinear(P: Part): Part {
  let pts = P.pts.slice(), ci = P.ci.slice();
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length; const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const dup = Math.hypot(b.x - a.x, b.y - a.y) < 1e-6;
      const col = Math.abs(cr(a, b, c)) < 1e-9 * (1 + Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)) && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0;
      if (dup || (col && ci[(i + n - 1) % n] === ci[i])) { pts.splice(i, 1); ci.splice(i, 1); changed = true; break; }
    }
  }
  return { pts, ci };
}
