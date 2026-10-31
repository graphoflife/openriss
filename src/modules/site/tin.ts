// Geländemodell (TIN): Delaunay-Triangulierung (Sweep-Hull nach dem Verfahren von «Delaunator») in lokalen
// Koordinaten (Schwerpunkt abgezogen – LV95-Koordinaten bleiben genau), Zwangskanten (Höhenlinien, Bruchkanten)
// per Kantentausch (Sloan), Delaunay-Bedingung ausserhalb der Zwangskanten, flache Dreiecke («Terrassen»
// zwischen Höhenlinien) durch Kantentausch entfernt; Höhenabfrage über ein Rasterverzeichnis.
import type { V2, V3 } from '../../core/geom';

/** Ebene z = a·x + b·y + c (lokale Koordinaten) */
export type Plane = [number, number, number];

export interface Tin {
  /** lokaler Ursprung (Modellkoordinaten, mm) */
  ox: number; oy: number;
  /** Punkte (lokal, z absolut) */
  x: Float64Array; y: Float64Array; z: Float64Array; n: number;
  /** Dreiecke (gegen den Uhrzeigersinn), Gegenkanten (−1 = Rand), Zwangskanten je Halbkante */
  tri: Int32Array; opp: Int32Array; cons: Uint8Array; nt: number;
  /** Ebenen je Dreieck (3 Werte) */
  planes: Float64Array;
  /** konvexe Hülle (Punktindizes, gegen den Uhrzeigersinn) */
  hull: number[];
  zMin: number; zMax: number;
  grid: TriGrid;
}
export interface TriGrid { x0: number; y0: number; cs: number; nx: number; ny: number; cells: Int32Array[] }

const nxt = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
const prv = (h: number) => (h % 3 === 0 ? h + 2 : h - 1);

// ------------------------------------------------------------ Delaunay (Sweep-Hull, intern im Uhrzeigersinn)
function delaunay(X: Float64Array, Y: Float64Array, n: number): { tri: Int32Array; nt: number } {
  const empty = { tri: new Int32Array(0), nt: 0 };
  if (n < 3) return empty;
  const maxT = Math.max(2 * n - 5, 1);
  const T = new Int32Array(maxT * 3), H = new Int32Array(maxT * 3).fill(-1);
  const hashSize = Math.max(1, Math.ceil(Math.sqrt(n)));
  const hullPrev = new Int32Array(n), hullNext = new Int32Array(n), hullTri = new Int32Array(n), hullHash = new Int32Array(hashSize).fill(-1);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const x = X[i], y = Y[i]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
  const d2 = (i: number, x: number, y: number) => (X[i] - x) ** 2 + (Y[i] - y) ** 2;
  let i0 = 0, i1 = -1, i2 = -1, md = Infinity;
  for (let i = 0; i < n; i++) { const d = d2(i, cx0, cy0); if (d < md) { md = d; i0 = i; } }
  md = Infinity;
  for (let i = 0; i < n; i++) { if (i === i0) continue; const d = d2(i, X[i0], Y[i0]); if (d < md && d > 0) { md = d; i1 = i; } }
  if (i1 < 0) return empty;
  let minR = Infinity;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1) continue;
    const r = circumR(X[i0], Y[i0], X[i1], Y[i1], X[i], Y[i]);
    if (r < minR) { minR = r; i2 = i; }
  }
  if (minR === Infinity || i2 < 0) return empty; // alle Punkte auf einer Geraden
  // Startdreieck im Uhrzeigersinn
  if (ccw(X[i0], Y[i0], X[i1], Y[i1], X[i2], Y[i2])) { const t = i1; i1 = i2; i2 = t; }
  const cc = circumC(X[i0], Y[i0], X[i1], Y[i1], X[i2], Y[i2]);
  const dists = new Float64Array(n);
  for (let i = 0; i < n; i++) dists[i] = d2(i, cc.x, cc.y);
  const ids = Array.from({ length: n }, (_, i) => i).sort((a, b) => dists[a] - dists[b]);
  const hashKey = (x: number, y: number) => Math.floor(pseudoAngle(x - cc.x, y - cc.y) * hashSize) % hashSize;
  let hullStart = i0;
  hullNext[i0] = hullPrev[i2] = i1; hullNext[i1] = hullPrev[i0] = i2; hullNext[i2] = hullPrev[i1] = i0;
  hullTri[i0] = 0; hullTri[i1] = 1; hullTri[i2] = 2;
  hullHash[hashKey(X[i0], Y[i0])] = i0; hullHash[hashKey(X[i1], Y[i1])] = i1; hullHash[hashKey(X[i2], Y[i2])] = i2;
  let tl = 0;
  const link = (a: number, b: number) => { H[a] = b; if (b !== -1) H[b] = a; };
  const addT = (a: number, b: number, c: number, ha: number, hb: number, hc: number) => {
    const t = tl; T[t] = a; T[t + 1] = b; T[t + 2] = c; link(t, ha); link(t + 1, hb); link(t + 2, hc); tl += 3; return t;
  };
  const stack: number[] = [];
  const legalize = (a: number): number => {
    let i = 0, ar = 0;
    for (;;) {
      const b = H[a]; const a0 = a - (a % 3); ar = a0 + ((a + 2) % 3);
      if (b === -1) { if (i === 0) break; a = stack[--i]; continue; }
      const b0 = b - (b % 3); const al = a0 + ((a + 1) % 3); const bl = b0 + ((b + 2) % 3);
      const p0 = T[ar], pr = T[a], pl = T[al], p1 = T[bl];
      if (inCircleCW(X, Y, p0, pr, pl, p1)) {
        T[a] = p1; T[b] = p0;
        const hbl = H[bl];
        if (hbl === -1) { let e = hullStart; do { if (hullTri[e] === bl) { hullTri[e] = a; break; } e = hullPrev[e]; } while (e !== hullStart); }
        link(a, hbl); link(b, H[ar]); link(ar, bl);
        if (i < 4096) stack[i++] = b0 + ((b + 1) % 3);
      } else { if (i === 0) break; a = stack[--i]; }
    }
    return ar;
  };
  addT(i0, i1, i2, -1, -1, -1);
  for (let k = 0; k < n; k++) {
    const i = ids[k]; if (i === i0 || i === i1 || i === i2) continue;
    const x = X[i], y = Y[i];
    let start = 0;
    for (let j = 0, key = hashKey(x, y); j < hashSize; j++) { start = hullHash[(key + j) % hashSize]; if (start !== -1 && start !== hullNext[start]) break; }
    start = hullPrev[start];
    let e = start, q: number;
    while ((q = hullNext[e]), !ccw(x, y, X[e], Y[e], X[q], Y[q])) { e = q; if (e === start) { e = -1; break; } }
    if (e === -1) continue; // nahezu doppelter Punkt
    let t = addT(e, i, hullNext[e], -1, -1, hullTri[e]);
    hullTri[i] = legalize(t + 2); hullTri[e] = t;
    let nn = hullNext[e];
    while ((q = hullNext[nn]), ccw(x, y, X[nn], Y[nn], X[q], Y[q])) {
      t = addT(nn, i, q, hullTri[i], -1, hullTri[nn]);
      hullTri[i] = legalize(t + 2); hullNext[nn] = nn; nn = q;
    }
    if (e === start) {
      while ((q = hullPrev[e]), ccw(x, y, X[q], Y[q], X[e], Y[e])) {
        t = addT(q, i, e, -1, hullTri[e], hullTri[q]);
        legalize(t + 2); hullTri[q] = t; hullNext[e] = e; e = q;
      }
    }
    hullStart = hullPrev[i] = e; hullNext[e] = hullPrev[nn] = i; hullNext[i] = nn;
    hullHash[hashKey(x, y)] = i; hullHash[hashKey(X[e], Y[e])] = e;
  }
  return { tri: T.subarray(0, tl), nt: tl / 3 };
}
/** (p, q, r) gegen den Uhrzeigersinn */
function ccw(px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean { return (qy - py) * (rx - qx) - (qx - px) * (ry - qy) < 0; }
function pseudoAngle(dx: number, dy: number): number { const p = dx / (Math.abs(dx) + Math.abs(dy) || 1); return (dy > 0 ? 3 - p : 1 + p) / 4; }
function circumR(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const dx = bx - ax, dy = by - ay, ex = cx - ax, ey = cy - ay; const bl = dx * dx + dy * dy, cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex); const x = (ey * bl - dy * cl) * d, y = (dx * cl - ex * bl) * d;
  return isFinite(d) ? x * x + y * y : Infinity;
}
function circumC(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): V2 {
  const dx = bx - ax, dy = by - ay, ex = cx - ax, ey = cy - ay; const bl = dx * dx + dy * dy, cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex); return { x: ax + (ey * bl - dy * cl) * d, y: ay + (dx * cl - ex * bl) * d };
}
/** p im Umkreis des Dreiecks (a, b, c) im Uhrzeigersinn */
function inCircleCW(X: Float64Array, Y: Float64Array, a: number, b: number, c: number, p: number): boolean { return inCircleDet(X, Y, a, b, c, p) < 0; }
/** Determinante relativ zu p (positiv: p im Umkreis eines Dreiecks gegen den Uhrzeigersinn) */
function inCircleDet(X: Float64Array, Y: Float64Array, a: number, b: number, c: number, p: number): number {
  const dx = X[a] - X[p], dy = Y[a] - Y[p], ex = X[b] - X[p], ey = Y[b] - Y[p], fx = X[c] - X[p], fy = Y[c] - Y[p];
  const ap = dx * dx + dy * dy, bp = ex * ex + ey * ey, cp = fx * fx + fy * fy;
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx);
}

// ------------------------------------------------------------ Netz mit Kantentausch (gegen den Uhrzeigersinn)
class Mesh {
  vh: Int32Array;
  constructor(public X: Float64Array, public Y: Float64Array, public Z: Float64Array, public T: Int32Array, public O: Int32Array, public C: Uint8Array) {
    this.vh = new Int32Array(X.length).fill(-1);
    for (let h = 0; h < T.length; h++) this.vh[T[h]] = h;
  }
  orient(a: number, b: number, c: number): number { const { X, Y } = this; return (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]); }
  link(a: number, b: number): void { this.O[a] = b; if (b >= 0) this.O[b] = a; }
  /** Halbkante p → q (−1 wenn nicht vorhanden) */
  find(p: number, q: number): number {
    const { T, O } = this; const h0 = this.vh[p]; if (h0 < 0) return -1;
    let h = h0;
    do { if (T[nxt(h)] === q) return h; const o = O[prv(h)]; if (o < 0) break; h = o; } while (h !== h0);
    h = h0;
    for (let g = 0; g < 10000; g++) { const o = O[h]; if (o < 0) break; h = nxt(o); if (h === h0) break; if (T[nxt(h)] === q) return h; }
    return -1;
  }
  /** ausgehende Halbkanten eines Punkts */
  around(p: number): number[] {
    const { O } = this; const h0 = this.vh[p]; const out: number[] = []; if (h0 < 0) return out;
    let h = h0; let closed = false;
    for (let g = 0; g < 10000; g++) { out.push(h); const o = O[prv(h)]; if (o < 0) break; h = o; if (h === h0) { closed = true; break; } }
    if (!closed) { h = h0; for (let g = 0; g < 10000; g++) { const o = O[h]; if (o < 0) break; h = nxt(o); if (h === h0) break; out.push(h); } }
    return out;
  }
  /** Viereck um Kante h streng konvex (Tausch möglich) */
  convex(h: number): boolean {
    const o = this.O[h]; if (o < 0) return false;
    const { T } = this; const A = T[h], B = T[nxt(h)], Cv = T[prv(h)], D = T[prv(o)];
    const s1 = this.orient(Cv, D, A), s2 = this.orient(Cv, D, B);
    const L = Math.hypot(this.X[Cv] - this.X[D], this.Y[Cv] - this.Y[D]);
    const tol = 1e-9 * L * L;
    return (s1 > tol && s2 < -tol) || (s1 < -tol && s2 > tol);
  }
  flip(h: number): [number, number] {
    const { T, O, C } = this; const o = O[h];
    const t0 = h - (h % 3), t1 = o - (o % 3);
    const A = T[h], B = T[nxt(h)], Cv = T[prv(h)], D = T[prv(o)];
    const hBC = nxt(h), hCA = prv(h), hAD = nxt(o), hDB = prv(o);
    const oBC = O[hBC], oCA = O[hCA], oAD = O[hAD], oDB = O[hDB];
    const cBC = C[hBC], cCA = C[hCA], cAD = C[hAD], cDB = C[hDB];
    T[t0] = Cv; T[t0 + 1] = A; T[t0 + 2] = D; T[t1] = D; T[t1 + 1] = B; T[t1 + 2] = Cv;
    this.link(t0, oCA); this.link(t0 + 1, oAD); this.link(t0 + 2, t1 + 2); this.link(t1, oDB); this.link(t1 + 1, oBC);
    C[t0] = cCA; C[t0 + 1] = cAD; C[t1] = cDB; C[t1 + 1] = cBC; C[t0 + 2] = C[t1 + 2] = 0;
    this.vh[Cv] = t0; this.vh[A] = t0 + 1; this.vh[D] = t0 + 2; this.vh[B] = t1 + 1;
    return [Cv, D];
  }
  mark(p: number, q: number): void { const h = this.find(p, q), g = this.find(q, p); if (h >= 0) this.C[h] = 1; if (g >= 0) this.C[g] = 1; }
  hasEdge(p: number, q: number): boolean { return this.find(p, q) >= 0 || this.find(q, p) >= 0; }

  /** Zwangskante a–b erzwingen (Sloan): kreuzende Kanten tauschen, bis a–b eine Kante ist */
  constrain(a0: number, b0: number): void {
    const todo: [number, number][] = [[a0, b0]];
    for (let guard = 0; todo.length && guard < 1000; guard++) {
      const [a, b] = todo.pop()!;
      if (a === b) continue;
      if (this.hasEdge(a, b)) { this.mark(a, b); continue; }
      const w = this.walk(a, b);
      if (w === null) continue;
      if (typeof w === 'number') { todo.push([a, w], [w, b]); continue; }
      const q = w.slice();
      const L = Math.hypot(this.X[b] - this.X[a], this.Y[b] - this.Y[a]);
      const crosses = (p: number, r: number) => {
        if (p === a || p === b || r === a || r === b) return false;
        const s1 = this.orient(a, b, p), s2 = this.orient(a, b, r), tol = 1e-9 * L * L;
        return (s1 > tol && s2 < -tol) || (s1 < -tol && s2 > tol);
      };
      for (let g = 0; q.length && g < 20000; g++) {
        const [p, r] = q.shift()!;
        let h = this.find(p, r); if (h < 0) h = this.find(r, p); if (h < 0) continue;
        if (!this.convex(h) || this.C[h]) { q.push([p, r]); continue; }
        const [c, d] = this.flip(h);
        if (crosses(c, d)) q.push([c, d]);
      }
      if (this.hasEdge(a, b)) this.mark(a, b);
    }
  }
  /** Kanten, die die Strecke a–b kreuzen; Zahl: Punkt liegt auf der Strecke (Zwangskante dort teilen) */
  walk(a: number, b: number): [number, number][] | number | null {
    const { T, O, X, Y } = this; const L2 = (X[b] - X[a]) ** 2 + (Y[b] - Y[a]) ** 2; const tol = 1e-9 * L2;
    const on = (p: number) => Math.abs(this.orient(a, b, p)) <= tol && (X[p] - X[a]) * (X[b] - X[a]) + (Y[p] - Y[a]) * (Y[b] - Y[a]) > 0;
    let e = -1;
    for (const h of this.around(a)) {
      const c1 = T[nxt(h)], c2 = T[prv(h)];
      if (on(c1)) return c1; if (on(c2)) return c2;
      if (this.orient(a, b, c1) < 0 && this.orient(a, b, c2) > 0) { e = nxt(h); break; }
    }
    if (e < 0) return null;
    const out: [number, number][] = [];
    for (let g = 0; g < 100000; g++) {
      out.push([T[e], T[nxt(e)]]);
      const o = O[e]; if (o < 0) return null;
      const c3 = T[prv(o)];
      if (c3 === b) return out;
      if (Math.abs(this.orient(a, b, c3)) <= tol) return c3;
      e = this.orient(a, b, c3) > 0 ? nxt(o) : prv(o);
    }
    return null;
  }
  /** Delaunay-Bedingung herstellen (Zwangskanten bleiben) */
  lawson(): void {
    const { T, O, C, X, Y } = this;
    for (let pass = 0; pass < 60; pass++) {
      let flips = 0;
      for (let h = 0; h < T.length; h++) {
        const o = O[h]; if (o < h || C[h]) continue;
        const A = T[h], B = T[nxt(h)], Cv = T[prv(h)], D = T[prv(o)];
        const det = inCircleDet(X, Y, A, B, Cv, D); // gegen den Uhrzeigersinn: positiv = im Umkreis
        const s = ((X[A] - X[D]) ** 2 + (Y[A] - Y[D]) ** 2) * Math.sqrt(((X[B] - X[D]) ** 2 + (Y[B] - Y[D]) ** 2) * ((X[Cv] - X[D]) ** 2 + (Y[Cv] - Y[D]) ** 2));
        if (det > 1e-9 * s && this.convex(h)) { this.flip(h); flips++; }
      }
      if (!flips) break;
    }
  }
  /** flache Dreiecke (alle Ecken gleiche Höhe, z.B. in Bögen einer Höhenlinie) durch Kantentausch auflösen */
  unflat(): void {
    const { T, O, C, Z } = this;
    const flat = (t: number) => Math.abs(Z[T[t]] - Z[T[t + 1]]) < 0.5 && Math.abs(Z[T[t]] - Z[T[t + 2]]) < 0.5;
    for (let pass = 0; pass < 8; pass++) {
      let flips = 0;
      for (let t = 0; t < T.length; t += 3) {
        if (!flat(t)) continue;
        for (let k = 0; k < 3; k++) {
          const h = t + k, o = O[h]; if (o < 0 || C[h]) continue;
          const D = T[prv(o)];
          if (Math.abs(Z[D] - Z[T[h]]) < 0.5 || !this.convex(h)) continue;
          this.flip(h); flips++; break;
        }
      }
      if (!flips) break;
    }
  }
}

// ------------------------------------------------------------ Aufbau
export interface TinInput {
  pts: V3[];
  /** Höhenlinien (Zwangskanten) */
  contours?: { z: number; pts: V2[] }[];
  /** Bruchkanten (3D-Linienzüge, Zwangskanten) */
  breaklines?: V3[][];
}

/** TIN aus Messpunkten und Höhenlinien (Modell-mm) */
export function buildTin(inp: TinInput): Tin {
  const raw: V3[] = []; const chains: number[][] = [];
  const key = new Map<string, number>();
  let sx = 0, sy = 0, cnt = 0;
  const addPt = (p: V3): number => {
    if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return -1;
    const k = Math.round(p.x) + ',' + Math.round(p.y);
    const e = key.get(k); if (e !== undefined) return e;
    key.set(k, raw.length); raw.push(p); sx += p.x; sy += p.y; cnt++;
    return raw.length - 1;
  };
  for (const p of inp.pts ?? []) addPt(p);
  for (const c of inp.contours ?? []) { const ch = (c.pts ?? []).map((p) => addPt({ x: p.x, y: p.y, z: c.z })).filter((i) => i >= 0); if (ch.length > 1) chains.push(ch); }
  for (const l of inp.breaklines ?? []) { const ch = l.map(addPt).filter((i) => i >= 0); if (ch.length > 1) chains.push(ch); }
  const n = raw.length;
  // lokaler Ursprung: Schwerpunkt, auf ganze Meter gerundet
  const ox = cnt ? Math.round(sx / cnt / 1000) * 1000 : 0, oy = cnt ? Math.round(sy / cnt / 1000) * 1000 : 0;
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  let zMin = Infinity, zMax = -Infinity;
  raw.forEach((p, i) => { X[i] = p.x - ox; Y[i] = p.y - oy; Z[i] = p.z; if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z; });
  const d = delaunay(X, Y, n);
  // im Uhrzeigersinn → gegen den Uhrzeigersinn, Gegenkanten neu aufbauen
  const T = new Int32Array(d.nt * 3);
  for (let t = 0; t < d.nt; t++) { T[3 * t] = d.tri[3 * t]; T[3 * t + 1] = d.tri[3 * t + 2]; T[3 * t + 2] = d.tri[3 * t + 1]; }
  const O = new Int32Array(T.length).fill(-1);
  const em = new Map<number, number>();
  for (let h = 0; h < T.length; h++) em.set(T[h] * n + T[nxt(h)], h);
  for (let h = 0; h < T.length; h++) { const o = em.get(T[nxt(h)] * n + T[h]); if (o !== undefined) O[h] = o; }
  const m = new Mesh(X, Y, Z, T, O, new Uint8Array(T.length));
  if (d.nt) {
    for (const ch of chains) for (let i = 1; i < ch.length; i++) m.constrain(ch[i - 1], ch[i]);
    m.lawson();
    m.unflat();
  }
  const planes = new Float64Array(d.nt * 3);
  for (let t = 0; t < d.nt; t++) { const p = planeOf3(X, Y, Z, T[3 * t], T[3 * t + 1], T[3 * t + 2]); planes[3 * t] = p[0]; planes[3 * t + 1] = p[1]; planes[3 * t + 2] = p[2]; }
  // Hülle: Randkanten verketten
  const hull: number[] = [];
  const nextOf = new Map<number, number>();
  for (let h = 0; h < T.length; h++) if (O[h] < 0) nextOf.set(T[h], T[nxt(h)]);
  if (nextOf.size) {
    const s = nextOf.keys().next().value as number; let v = s;
    for (let g = 0; g <= nextOf.size; g++) { hull.push(v); const w = nextOf.get(v); if (w === undefined || w === s) break; v = w; }
  }
  const tin: Tin = { ox, oy, x: X, y: Y, z: Z, n, tri: T, opp: O, cons: m.C, nt: d.nt, planes, hull, zMin: isFinite(zMin) ? zMin : 0, zMax: isFinite(zMax) ? zMax : 0, grid: null as any };
  tin.grid = buildGrid(tin);
  return tin;
}

export function planeOf3(X: ArrayLike<number>, Y: ArrayLike<number>, Z: ArrayLike<number>, a: number, b: number, c: number): Plane {
  const ux = X[b] - X[a], uy = Y[b] - Y[a], uz = Z[b] - Z[a], vx = X[c] - X[a], vy = Y[c] - Y[a], vz = Z[c] - Z[a];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (Math.abs(nz) < 1e-12) return [0, 0, (Z[a] + Z[b] + Z[c]) / 3];
  const pa = -nx / nz, pb = -ny / nz; return [pa, pb, Z[a] - pa * X[a] - pb * Y[a]];
}

function buildGrid(t: Tin): TriGrid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < t.n; i++) { x0 = Math.min(x0, t.x[i]); y0 = Math.min(y0, t.y[i]); x1 = Math.max(x1, t.x[i]); y1 = Math.max(y1, t.y[i]); }
  if (!t.nt) return { x0: 0, y0: 0, cs: 1, nx: 0, ny: 0, cells: [] };
  const cs = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0) || 1) / Math.max(1, t.nt)) * 1.5);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / cs) + 1);
  const lists: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let k = 0; k < t.nt; k++) {
    const a = t.tri[3 * k], b = t.tri[3 * k + 1], c = t.tri[3 * k + 2];
    const i0 = Math.floor((Math.min(t.x[a], t.x[b], t.x[c]) - x0) / cs), i1 = Math.floor((Math.max(t.x[a], t.x[b], t.x[c]) - x0) / cs);
    const j0 = Math.floor((Math.min(t.y[a], t.y[b], t.y[c]) - y0) / cs), j1 = Math.floor((Math.max(t.y[a], t.y[b], t.y[c]) - y0) / cs);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * nx + i].push(k);
  }
  return { x0, y0, cs, nx, ny, cells: lists.map((l) => Int32Array.from(l)) };
}

/** Dreiecke, deren Rechteck den Bereich (lokal) berührt */
export function trisIn(t: Tin, x0: number, y0: number, x1: number, y1: number, out: Set<number> = new Set()): Set<number> {
  const g = t.grid; if (!g.nx) return out;
  const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.cs)), i1 = Math.min(g.nx - 1, Math.floor((x1 - g.x0) / g.cs));
  const j0 = Math.max(0, Math.floor((y0 - g.y0) / g.cs)), j1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / g.cs));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const k of g.cells[j * g.nx + i]) out.add(k);
  return out;
}

/** Dreieck unter dem Punkt (lokal), −1 ausserhalb */
export function triAt(t: Tin, x: number, y: number): number {
  const g = t.grid; if (!g.nx) return -1;
  const i = Math.floor((x - g.x0) / g.cs), j = Math.floor((y - g.y0) / g.cs);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
  for (const k of g.cells[j * g.nx + i]) if (inTri(t, k, x, y)) return k;
  return -1;
}
export function inTri(t: Tin, k: number, x: number, y: number, tol = 1e-6): boolean {
  const a = t.tri[3 * k], b = t.tri[3 * k + 1], c = t.tri[3 * k + 2]; const X = t.x, Y = t.y;
  const e = (p: number, q: number) => ((X[q] - X[p]) * (y - Y[p]) - (Y[q] - Y[p]) * (x - X[p])) / (Math.hypot(X[q] - X[p], Y[q] - Y[p]) || 1);
  return e(a, b) >= -tol && e(b, c) >= -tol && e(c, a) >= -tol;
}
/** Geländehöhe (lokale Koordinaten), NaN ausserhalb */
export function tinZ(t: Tin, x: number, y: number): number {
  const k = triAt(t, x, y); if (k < 0) return NaN;
  return t.planes[3 * k] * x + t.planes[3 * k + 1] * y + t.planes[3 * k + 2];
}
export const triPlane = (t: Tin, k: number): Plane => [t.planes[3 * k], t.planes[3 * k + 1], t.planes[3 * k + 2]];
export function triPoly(t: Tin, k: number): V2[] {
  const r: V2[] = []; for (let j = 0; j < 3; j++) { const v = t.tri[3 * k + j]; r.push({ x: t.x[v], y: t.y[v] }); } return r;
}
/** Hülle als Ring (lokal) */
export const hullRing = (t: Tin): V2[] => t.hull.map((v) => ({ x: t.x[v], y: t.y[v] }));
