// Baugrube (Aushub) und Geländeüberlagerung – exakt, ohne Abtastung:
// Je konvexem Teil der Aushubsohle ist die Grubenfläche z = Sohle(p) + max_i g_i(d_i(p)) mit dem nach aussen
// gerichteten Abstand d_i zur Kante i und einer stückweise linearen Böschungsfunktion g_i (1:n, Bermen = flach,
// Verbau = senkrecht). Die Zellen, in denen eine Ebene massgebend ist, entstehen durch Halbebenen-Schnitte;
// mehrere Teile und Baugruben werden mit dem Minimum kombiniert und mit den Geländedreiecken überlagert.
// Ergebnis: Endfläche min(Gelände, Gruben), Böschungskrone, Verbauflächen, Körper (Erdreich, Aushub), Volumen.
import type { El, Id } from '../../core/doc';
import type { V2, V3 } from '../../core/geom';
import { offsetPolyline, signedArea, union } from '../../core/geom';
import type { Face } from '../../core/registry';
import { faceNormal } from '../../views/sectionEngine';
import { Tin, Plane, trisIn, triPlane, triPoly, triAt } from './tin';
import { Conv, splitHP, clipHP, clipConv, splitLower, leftOf, bboxC, boxHit, evalP, addP, sArea, centroidOf, integral, trueArea, convexParts } from './convex';

// ------------------------------------------------------------ Datenmodell
export interface Berm { dz: number; width: number }
export interface ExcEdge { slope?: number; vertical?: boolean; berm?: Berm | Berm[] | null }
/** Sohle nach Längsprofil: Höhe z (absolut) über der Station s = dir·(p − o) */
export interface BottomProfile { o?: V2; dir: V2; pts: { s: number; z: number }[] }
export interface Excavation extends El {
  cat: 'excavation';
  /** Umriss der Aushubsohle (inkl. Arbeitsraum) bzw. Gebäudeumriss + work */
  pts: V2[];
  /** Sohlenkote (absolut, mm) */
  bottom: number;
  /** geneigte Sohle: Gefälle pct % in Richtung dir (z = bottom bei o, Standard erster Punkt) */
  bottomSlope?: { dir: V2; pct: number; o?: V2 };
  /** Sohle folgt Längsprofil (z.B. Rampentrog) */
  bottomProfile?: BottomProfile;
  /** Arbeitsraum: Umriss nach aussen versetzen */
  work?: number;
  /** Böschung 1:n (n horizontal je 1 vertikal), Standard 1 */
  slope?: number;
  /** Berme(n) für alle Böschungen (dz über Sohle, Breite) */
  berm?: Berm | Berm[] | null;
  /** je Kante (pts[i] → pts[i+1]): Neigung, Verbau senkrecht, Bermen (null = keine) */
  edges?: ExcEdge[];
  topoId?: Id;
  /** Hinterfüllung im Schnitt schraffieren */
  backfill?: boolean;
  /** Geländehöhe ohne Geländemodell (mm) */
  top?: number;
}

interface GPiece { d0: number; d1: number; g0: number; k: number; kind: 1 | 2 }
export interface PEdge { a: V2; nx: number; ny: number; c: number; ci: number; vertical: boolean; n: number; pieces: GPiece[]; dmax: number }
export interface PitCell { p: Conv; f: Plane; tag: number; box: number[] }
export interface PitPiece { D: Conv; box: number[]; cells: PitCell[]; vert: { a: V2; b: V2; ci: number }[]; edges: PEdge[] }
export interface Pit {
  el: Excavation; pieces: PitPiece[]; box: number[];
  /** senkrechte Kanten (Verbau), Innenseite links */
  vert: { a: V2; b: V2; ci: number }[];
  /** Sohlenumriss (lokal, gegen den Uhrzeigersinn) mit Kantenzuordnung ci (Index in pts) */
  contour: V2[]; ci: number[];
  /** Kanten je Umrisskante ci (für Böschungsstriche und Beschriftung) */
  edgeOf: Map<number, PEdge>;
  zbMin: number; zbMax: number;
  bottomAt(x: number, y: number): number;
}
/** Zell-Kennung: 0 Sohle, sonst (Umrisskante + 1)·64 + Stück + 1 */
export const tagOf = (ci: number, j: number) => (ci + 1) * 64 + j + 1;
export const tagEdge = (tag: number) => (tag ? Math.floor(tag / 64) - 1 : -2);
export const tagPiece = (tag: number) => (tag ? (tag % 64) - 1 : -1);

const bermsOf = (b: Berm | Berm[] | null | undefined): Berm[] => (!b ? [] : Array.isArray(b) ? b : [b]).filter((x) => x && x.dz > 0 && x.width >= 0);
function gPieces(n: number, berms: Berm[]): GPiece[] {
  const out: GPiece[] = []; let d = 0, g = 0;
  for (const b of berms.slice().sort((p, q) => p.dz - q.dz)) {
    if (b.dz <= g + 1e-9) continue;
    const L = n * (b.dz - g); out.push({ d0: d, d1: d + L, g0: g, k: 1 / n, kind: 1 }); d += L; g = b.dz;
    if (b.width > 0) { out.push({ d0: d, d1: d + b.width, g0: g, k: 0, kind: 2 }); d += b.width; }
  }
  out.push({ d0: d, d1: Infinity, g0: g, k: 1 / n, kind: 1 });
  return out;
}
function dmaxOf(pc: GPiece[], H: number): number {
  for (const p of pc) if (p.k > 0 && p.g0 + p.k * (p.d1 - p.d0) >= H) return p.d0 + (H - p.g0) / p.k;
  return pc[pc.length - 1].d0 + 1;
}
const piecePlane = (e: PEdge, p: GPiece): Plane => [p.k * e.nx, p.k * e.ny, p.g0 - p.k * (e.c + p.d0)];

/** Umriss der Sohle (Modell, gegen den Uhrzeigersinn) mit Zuordnung zur Kante in pts */
export function excContour(e: Excavation): { pts: V2[]; ci: number[] } {
  const src = (e.pts ?? []).filter((p) => p && isFinite(p.x) && isFinite(p.y));
  const n = src.length; if (n < 3) return { pts: [], ci: [] };
  let pts = src.slice(); let ci = pts.map((_, i) => i);
  if (signedArea(pts) < 0) { pts = pts.slice().reverse(); ci = pts.map((_, k) => (2 * n - 2 - k) % n); }
  if ((e.work ?? 0) > 0) pts = offsetPolyline(pts, -(e.work ?? 0), true);
  // doppelte Punkte entfernen
  const P: V2[] = [], C: number[] = [];
  for (let i = 0; i < pts.length; i++) { const l = P[P.length - 1]; if (l && Math.hypot(l.x - pts[i].x, l.y - pts[i].y) < 0.5) { C[C.length - 1] = ci[i]; continue; } P.push(pts[i]); C.push(ci[i]); }
  if (P.length > 2 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) < 0.5) { P.pop(); C.pop(); }
  return { pts: P, ci: C };
}

/** Sohle als Streifen mit je einer Ebene (lokale Koordinaten) */
function bottomStrips(e: Excavation, ox: number, oy: number): { dir: V2 | null; o: number; strips: { lo: number; hi: number; f: Plane }[]; zMin: number; zMax: number } {
  const z0 = e.bottom ?? 0;
  const bp = e.bottomProfile;
  if (bp && bp.pts?.length && bp.dir) {
    const L = Math.hypot(bp.dir.x, bp.dir.y) || 1; const d = { x: bp.dir.x / L, y: bp.dir.y / L };
    const o = bp.o ?? e.pts?.[0] ?? { x: 0, y: 0 };
    const so = d.x * (o.x - ox) + d.y * (o.y - oy); // s = d·p_lokal − so
    const pts = bp.pts.filter((q) => isFinite(q.s) && isFinite(q.z)).slice().sort((a, b) => a.s - b.s);
    const strips: { lo: number; hi: number; f: Plane }[] = [];
    const lin = (a: { s: number; z: number }, b: { s: number; z: number }): Plane => { const k = (b.z - a.z) / (b.s - a.s || 1); return [k * d.x, k * d.y, a.z - k * (a.s + so)]; };
    strips.push({ lo: -Infinity, hi: pts[0].s, f: [0, 0, pts[0].z] });
    for (let i = 1; i < pts.length; i++) if (pts[i].s - pts[i - 1].s > 1e-6) strips.push({ lo: pts[i - 1].s, hi: pts[i].s, f: lin(pts[i - 1], pts[i]) });
    strips.push({ lo: pts[pts.length - 1].s, hi: Infinity, f: [0, 0, pts[pts.length - 1].z] });
    return { dir: d, o: so, strips, zMin: Math.min(...pts.map((q) => q.z)), zMax: Math.max(...pts.map((q) => q.z)) };
  }
  const bs = e.bottomSlope;
  if (bs && bs.dir && bs.pct) {
    const L = Math.hypot(bs.dir.x, bs.dir.y) || 1; const k = -bs.pct / 100; const d = { x: bs.dir.x / L, y: bs.dir.y / L };
    const o = bs.o ?? e.pts?.[0] ?? { x: 0, y: 0 };
    const f: Plane = [k * d.x, k * d.y, z0 - k * (d.x * (o.x - ox) + d.y * (o.y - oy))];
    // Höhenbereich über den Umriss
    const zs = (e.pts ?? []).map((p) => evalP(f, p.x - ox, p.y - oy));
    return { dir: null, o: 0, strips: [{ lo: -Infinity, hi: Infinity, f }], zMin: Math.min(z0, ...zs), zMax: Math.max(z0, ...zs) };
  }
  return { dir: null, o: 0, strips: [{ lo: -Infinity, hi: Infinity, f: [0, 0, z0] }], zMin: z0, zMax: z0 };
}

/** Grube aufbauen (lokale Koordinaten des Geländes; zTop = höchster Geländepunkt) */
export function buildPit(e: Excavation, ox: number, oy: number, zTop: number): Pit | null {
  const C = excContour(e); if (C.pts.length < 3) return null;
  const loc = C.pts.map((p) => ({ x: p.x - ox, y: p.y - oy }));
  const bs = bottomStrips(e, ox, oy);
  const H = Math.max(zTop - bs.zMin, 0) + 1000;
  const nDef = e.slope ?? 1;
  const edgeOf = new Map<number, PEdge>();
  const mkEdge = (a: V2, b: V2, ci: number): PEdge => {
    const spec = ci >= 0 ? e.edges?.[ci] ?? {} : {};
    const n = spec.slope ?? nDef;
    const vertical = ci >= 0 && (!!spec.vertical || !(n > 0));
    const [nx, ny, c] = leftOf(a, b); // n zeigt nach aussen (rechts der Kante)
    const berms = ci < 0 ? [] : spec.berm === null ? [] : bermsOf(spec.berm ?? e.berm);
    const nn = n > 0 ? n : 1;
    const pieces = vertical ? [] : gPieces(nn, berms);
    return { a, nx, ny, c, ci, vertical, n: vertical ? 0 : nn, pieces, dmax: vertical ? 0 : dmaxOf(pieces, H) };
  };
  const parts = convexParts(loc, C.ci);
  const pieces: PitPiece[] = [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const m = part.pts.length;
    const edges: PEdge[] = part.pts.map((a, k) => {
      const ci = part.ci[k]; const ed = mkEdge(a, part.pts[(k + 1) % m], ci);
      if (ci >= 0 && !edgeOf.has(ci)) edgeOf.set(ci, ed);
      return ed;
    });
    const pp = buildPiece(part.pts, edges, bs);
    if (!pp) continue;
    pieces.push(pp);
    box[0] = Math.min(box[0], pp.box[0]); box[1] = Math.min(box[1], pp.box[1]); box[2] = Math.max(box[2], pp.box[2]); box[3] = Math.max(box[3], pp.box[3]);
  }
  // Verbau je Umrisskante: Abschnitte aller Teile auf derselben Geraden zusammenfassen
  const vert: { a: V2; b: V2; ci: number }[] = [];
  for (const ci of new Set(pieces.flatMap((pc) => pc.vert.map((v) => v.ci)))) {
    const vs = pieces.flatMap((pc) => pc.vert.filter((v) => v.ci === ci));
    const u = { x: vs[0].b.x - vs[0].a.x, y: vs[0].b.y - vs[0].a.y }; const L = Math.hypot(u.x, u.y) || 1; u.x /= L; u.y /= L;
    const o = vs[0].a; const ts = vs.flatMap((v) => [v.a, v.b]).map((q) => (q.x - o.x) * u.x + (q.y - o.y) * u.y);
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    vert.push({ a: { x: o.x + u.x * t0, y: o.y + u.y * t0 }, b: { x: o.x + u.x * t1, y: o.y + u.y * t1 }, ci });
  }
  if (!pieces.length) return null;
  const bottomAt = (x: number, y: number): number => {
    if (!bs.dir) return evalP(bs.strips[0].f, x, y);
    const s = bs.dir.x * x + bs.dir.y * y - bs.o;
    const st = bs.strips.find((q) => s >= q.lo && s <= q.hi) ?? bs.strips[bs.strips.length - 1];
    return evalP(st.f, x, y);
  };
  return { el: e, pieces, vert, box, contour: loc, ci: C.ci, edgeOf, zbMin: bs.zMin, zbMax: bs.zMax, bottomAt };
}

function buildPiece(K: Conv, edges: PEdge[], bs: ReturnType<typeof bottomStrips>): PitPiece | null {
  const [x0, y0, x1, y1] = bboxC(K);
  const R = Math.max(1000, ...edges.map((e) => e.dmax)) + 1000;
  let D: Conv | null = [{ x: x0 - R, y: y0 - R }, { x: x1 + R, y: y0 - R }, { x: x1 + R, y: y1 + R }, { x: x0 - R, y: y1 + R }];
  for (const e of edges) { if (!D) break; D = clipHP(D, e.nx, e.ny, e.c + e.dmax); }
  if (!D) return null;
  // Sohle (Streifen je Profilabschnitt)
  type W = { p: Conv; zb: Plane; g: Plane; tag: number };
  let cells: W[] = [];
  for (const s of bs.strips) {
    let p: Conv | null = D;
    if (bs.dir && isFinite(s.lo)) p = p && clipHP(p, -bs.dir.x, -bs.dir.y, -(s.lo + bs.o));
    if (bs.dir && isFinite(s.hi)) p = p && clipHP(p, bs.dir.x, bs.dir.y, s.hi + bs.o);
    if (p) cells.push({ p, zb: s.f, g: [0, 0, 0], tag: 0 });
  }
  // Böschungen: Maximum über die Kanten (inkrementell)
  for (const e of edges) {
    if (e.vertical) continue;
    const next: W[] = [];
    for (const c of cells) {
      const [inn, out] = splitHP(c.p, e.nx, e.ny, e.c);
      if (inn) next.push({ ...c, p: inn });
      if (!out) continue;
      e.pieces.forEach((pc, j) => {
        let s: Conv | null = out;
        if (pc.d0 > 0) s = s && clipHP(s, -e.nx, -e.ny, -(e.c + pc.d0));
        if (isFinite(pc.d1)) s = s && clipHP(s, e.nx, e.ny, e.c + pc.d1);
        if (!s) return;
        const L = piecePlane(e, pc);
        const [hi, rest] = splitLower(s, c.g, L);
        if (hi) next.push({ p: hi, zb: c.zb, g: L, tag: tagOf(e.ci, j) });
        if (rest) next.push({ ...c, p: rest });
      });
    }
    cells = next;
  }
  // senkrechte Kanten (Verbau): Abschnitt der Kantengeraden auf dem Rand von D
  const vert: PitPiece['vert'] = [];
  for (const e of edges) {
    if (!e.vertical) continue;
    const ux = -e.ny, uy = e.nx; // Kantenrichtung (Innenseite links)
    const on = D.filter((q) => Math.abs(e.nx * q.x + e.ny * q.y - e.c) < 1e-5);
    if (on.length < 2) continue;
    const ts = on.map((q) => ux * q.x + uy * q.y); const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const P = (t: number): V2 => ({ x: e.nx * e.c + ux * t, y: e.ny * e.c + uy * t });
    if (t1 - t0 > 1e-3) vert.push({ a: P(t0), b: P(t1), ci: e.ci });
  }
  return { D, box: bboxC(D), cells: cells.map((c) => ({ p: c.p, f: addP(c.zb, c.g), tag: c.tag, box: bboxC(c.p) })), vert, edges };
}

// ------------------------------------------------------------ Gelände (Definitionsbereich) und Überlagerung
export interface Cell { p: Conv; f: Plane; t: Plane; src: number; tag: number }
export interface Domain {
  tin: Tin;
  /** je Dreieck: Teile innerhalb der Begrenzung (null = ganzes Dreieck) */
  base: (Conv[] | null)[];
  /** Ränder (lokal; aussen gegen, Löcher im Uhrzeigersinn – Gelände links) */
  outline: V2[][];
}
export interface Overlay { dom: Domain; pits: Pit[]; cells: (Cell[] | null)[] }

/** Zellen eines Dreiecks (unverändert: Gelände) */
export function cellsOf(dom: Domain, ov: Overlay | null, k: number): Cell[] {
  const c = ov?.cells[k]; if (c) return c;
  const T = triPlane(dom.tin, k);
  return (dom.base[k] ?? [triPoly(dom.tin, k)]).map((p) => ({ p, f: T, t: T, src: -1, tag: 0 }));
}

export function overlay(dom: Domain, pits: Pit[]): Overlay {
  const tin = dom.tin; const cells: (Cell[] | null)[] = new Array(tin.nt).fill(null);
  const touched = new Set<number>();
  for (const p of pits) for (const pc of p.pieces) trisIn(tin, pc.box[0], pc.box[1], pc.box[2], pc.box[3], touched);
  for (const k of touched) {
    const tb = bboxC(triPoly(tin, k));
    let cs = cellsOf(dom, null, k);
    pits.forEach((pit, pi) => {
      if (!boxHit(pit.box, tb)) return;
      for (const pc of pit.pieces) if (boxHit(pc.box, tb)) cs = applyPiece(cs, pc, pi);
    });
    cells[k] = cs;
  }
  return { dom, pits, cells };
}

function applyPiece(cs: Cell[], pc: PitPiece, pi: number): Cell[] {
  const out: Cell[] = []; const D = pc.D;
  for (const c of cs) {
    if (!boxHit(bboxC(c.p), pc.box)) { out.push(c); continue; }
    let rem: Conv | null = c.p;
    for (let i = 0; i < D.length && rem; i++) {
      const [nx, ny, cc] = leftOf(D[i], D[(i + 1) % D.length]);
      const [inn, o] = splitHP(rem, nx, ny, cc);
      if (o) out.push({ ...c, p: o });
      rem = inn;
    }
    if (!rem) continue;
    const rb = bboxC(rem);
    for (const q of pc.cells) {
      if (!boxHit(q.box, rb)) continue;
      const x = clipConv(rem, q.p); if (!x) continue;
      const [low, rest] = splitLower(x, q.f, c.f);
      if (low) out.push({ p: low, f: q.f, t: c.t, src: pi, tag: q.tag });
      if (rest) out.push({ ...c, p: rest });
    }
  }
  return out;
}

/** Endfläche (lokal) */
export function finalZ(ov: Overlay, x: number, y: number): number {
  const k = triAt(ov.dom.tin, x, y); if (k < 0) return NaN;
  const cs = ov.cells[k]; const T = triPlane(ov.dom.tin, k);
  if (!cs) return evalP(T, x, y);
  for (const c of cs) if (inConv(c.p, x, y)) return evalP(c.f, x, y);
  let z = evalP(T, x, y); for (const c of cs) if (inConv(c.p, x, y, 1e-3)) z = Math.min(z, evalP(c.f, x, y));
  return z;
}
function inConv(p: Conv, x: number, y: number, tol = 1e-7): boolean {
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -tol * Math.hypot(b.x - a.x, b.y - a.y)) return false; }
  return true;
}

// ------------------------------------------------------------ Profile entlang einer Strecke (für Wände)
interface Prof { t0: number; t1: number; z0: number; z1: number }
/** Verlauf der Ebene f bzw. t der Zellen auf einer Seite der Strecke a→b (side +1 links, −1 rechts) */
function profileAlong(dom: Domain, ov: Overlay | null, a: V2, b: V2, side: 1 | -1, which: 'f' | 't', filter?: (c: Cell) => boolean): Prof[] {
  const L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1e-6) return [];
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L; const tol = 2e-3;
  const out: Prof[] = [];
  const ks = trisIn(dom.tin, Math.min(a.x, b.x) - 1, Math.min(a.y, b.y) - 1, Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1);
  for (const k of ks) for (const c of cellsOf(dom, ov, k)) {
    if (filter && !filter(c)) continue;
    const P = c.p; let hit = false;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const dp = ux * (p.y - a.y) - uy * (p.x - a.x), dq = ux * (q.y - a.y) - uy * (q.x - a.x);
      if (Math.abs(dp) > tol || Math.abs(dq) > tol) continue;
      if (!hit) { const cn = centroidOf(P); const sd = ux * (cn.y - a.y) - uy * (cn.x - a.x); if (side > 0 ? sd <= 0 : sd >= 0) break; hit = true; }
      const tp = ux * (p.x - a.x) + uy * (p.y - a.y), tq = ux * (q.x - a.x) + uy * (q.y - a.y);
      const t0 = Math.max(0, Math.min(tp, tq)), t1 = Math.min(L, Math.max(tp, tq)); if (t1 - t0 < 1e-6) continue;
      const F = which === 'f' ? c.f : c.t;
      out.push({ t0, t1, z0: evalP(F, a.x + ux * t0, a.y + uy * t0), z1: evalP(F, a.x + ux * t1, a.y + uy * t1) });
    }
  }
  return out.sort((p, q) => p.t0 - q.t0);
}
const profAt = (pr: Prof[], t: number): Prof | undefined => pr.find((p) => p.t0 <= t + 1e-9 && p.t1 >= t - 1e-9);
const zOf = (p: Prof, t: number) => p.z0 + ((p.z1 - p.z0) * (t - p.t0)) / (p.t1 - p.t0 || 1);

/** senkrechte Wandflächen zwischen unterem (null = konstant zBase) und oberem Verlauf; Fläche (mm²) im Ergebnis */
function walls(a: V2, b: V2, lower: Prof[] | null, upper: Prof[], zBase: number, outLeft: boolean, ox: number, oy: number): { faces: Face[]; area: number; runs: [number, number][] } {
  const L = Math.hypot(b.x - a.x, b.y - a.y); const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const ts = new Set<number>([0, L]);
  for (const p of upper) { ts.add(p.t0); ts.add(p.t1); }
  for (const p of lower ?? []) { ts.add(p.t0); ts.add(p.t1); }
  const T = [...ts].filter((t) => t >= 0 && t <= L).sort((p, q) => p - q);
  const faces: Face[] = []; const runs: [number, number][] = []; let area = 0;
  let lo: [number, number][] = [], up: [number, number][] = [];
  const W = (t: number, z: number): V3 => ({ x: a.x + ux * t + ox, y: a.y + uy * t + oy, z });
  const want = outLeft ? { x: -uy, y: ux, z: 0 } : { x: uy, y: -ux, z: 0 };
  const flush = () => {
    if (lo.length >= 2) {
      const ring = [...lo, ...up.slice().reverse()];
      const pts: V3[] = [];
      for (const [t, z] of ring) { const p = W(t, z); const l = pts[pts.length - 1]; if (!l || Math.abs(l.x - p.x) + Math.abs(l.y - p.y) + Math.abs(l.z - p.z) > 1e-6) pts.push(p); }
      if (pts.length >= 3) {
        const n = faceNormal(pts);
        if (n.x * want.x + n.y * want.y < 0) pts.reverse();
        faces.push({ pts });
        runs.push([lo[0][0], lo[lo.length - 1][0]]);
      }
    }
    lo = []; up = [];
  };
  for (let i = 0; i + 1 < T.length; i++) {
    let t0 = T[i], t1 = T[i + 1]; if (t1 - t0 < 1e-6) continue;
    const m = (t0 + t1) / 2;
    const pu = profAt(upper, m); const pl = lower ? profAt(lower, m) : null;
    if (!pu || (lower && !pl)) { flush(); continue; }
    const zl = (t: number) => (pl ? zOf(pl, t) : zBase);
    let h0 = zOf(pu, t0) - zl(t0), h1 = zOf(pu, t1) - zl(t1);
    if (h0 <= 1e-3 && h1 <= 1e-3) { flush(); continue; }
    if (h0 < 0) { t0 = t0 + ((t1 - t0) * -h0) / (h1 - h0); h0 = 0; flush(); }
    let end = false;
    if (h1 < 0) { t1 = t0 + ((t1 - t0) * h0) / (h0 - h1); h1 = 0; end = true; }
    area += ((h0 + h1) / 2) * (t1 - t0);
    const l = lo[lo.length - 1];
    if (!l || Math.abs(l[0] - t0) > 1e-6 || Math.abs(l[1] - zl(t0)) > 1e-6) lo.push([t0, zl(t0)]);
    const u = up[up.length - 1];
    if (!u || Math.abs(u[0] - t0) > 1e-6 || Math.abs(u[1] - zOf(pu, t0)) > 1e-6) up.push([t0, zOf(pu, t0)]);
    lo.push([t1, zl(t1)]); up.push([t1, zOf(pu, t1)]);
    if (end) flush();
  }
  flush();
  return { faces, area, runs };
}

// ------------------------------------------------------------ Körper
const W3 = (p: V2, z: number, ox: number, oy: number): V3 => ({ x: p.x + ox, y: p.y + oy, z });

/**
 * Flächen eines Dreiecks: Zellen mit gleicher Ebene zu einer Fläche (mit Löchern) vereinigen – weniger Flächen und
 * keine T-Stösse innerhalb ebener Bereiche (sonst zeichnet die 3D-Ansicht dort Kanten). down: Normale nach unten.
 */
function planarFaces(cells: Cell[], plane: (c: Cell) => Plane, down: boolean, ox: number, oy: number): Face[] {
  const groups = new Map<string, { f: Plane; polys: Conv[] }>();
  for (const c of cells) {
    const f = plane(c); const k = f[0].toFixed(9) + '|' + f[1].toFixed(9) + '|' + f[2].toFixed(4);
    const g = groups.get(k); if (g) g.polys.push(c.p); else groups.set(k, { f, polys: [c.p] });
  }
  const out: Face[] = [];
  const L = (r: V2[], f: Plane) => (down ? r.slice().reverse() : r).map((q) => W3(q, evalP(f, q.x, q.y), ox, oy));
  for (const { f, polys } of groups.values()) {
    // auf 0.001 mm runden: polygon-clipping scheitert sonst an fast gleichen Punkten gemeinsamer Kanten
    const snap = (p: Conv) => p.map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 }));
    const merged = polys.length > 1 ? union(polys.map((p) => [snap(p)])) : [[polys[0]]];
    if (polys.length > 1 && !merged.length) { for (const p of polys) out.push({ pts: L(p, f) }); continue; }
    for (const poly of merged) {
      const outer = signedArea(poly[0]) > 0 ? poly[0] : poly[0].slice().reverse();
      const holes = poly.slice(1).map((h) => (signedArea(h) < 0 ? h : h.slice().reverse()));
      if (outer.length >= 3) out.push({ pts: L(outer, f), holes: holes.filter((h) => h.length >= 3).map((h) => L(h, f)) });
    }
  }
  return out;
}

/** Erdkörper: Endfläche oben, Rand senkrecht, Boden auf zBase; Verbauflächen je Grube */
export function earthFaces(ov: Overlay, zBase: number): { faces: Face[]; wallArea: number[]; wallRuns: { pit: number; a: V2; b: V2; runs: [number, number][] }[] } {
  const { dom } = ov; const { tin } = dom; const ox = tin.ox, oy = tin.oy;
  const faces: Face[] = [];
  for (let k = 0; k < tin.nt; k++) faces.push(...planarFaces(cellsOf(dom, ov, k), (c) => c.f, false, ox, oy));
  for (const r of dom.outline) {
    if (signedArea(r) > 0) {
      const holes = dom.outline.filter((h) => signedArea(h) < 0);
      faces.push({ pts: r.slice().reverse().map((q) => W3(q, zBase, ox, oy)), holes: holes.map((h) => h.slice().reverse().map((q) => W3(q, zBase, ox, oy))) });
    }
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      faces.push(...walls(a, b, null, profileAlong(dom, ov, a, b, 1, 'f'), zBase, false, ox, oy).faces);
    }
  }
  const wallArea = ov.pits.map(() => 0); const wallRuns: { pit: number; a: V2; b: V2; runs: [number, number][] }[] = [];
  ov.pits.forEach((pit, pi) => {
    for (const v of pit.vert) {
      const inner = profileAlong(dom, ov, v.a, v.b, 1, 'f'), outer = profileAlong(dom, ov, v.a, v.b, -1, 'f');
      const w = walls(v.a, v.b, inner, outer, zBase, true, ox, oy);
      faces.push(...w.faces); wallArea[pi] += w.area;
      if (w.runs.length) wallRuns.push({ pit: pi, a: v.a, b: v.b, runs: w.runs });
    }
  });
  return { faces, wallArea, wallRuns };
}

/** Aushubkörper einer einzelnen Grube (Überlagerung nur mit dieser Grube): Gelände oben, Grubenfläche unten */
export function cutFaces(ov: Overlay): Face[] {
  const { dom } = ov; const { tin } = dom; const ox = tin.ox, oy = tin.oy;
  const faces: Face[] = [];
  const isCut = (c: Cell) => c.src >= 0;
  for (let k = 0; k < tin.nt; k++) {
    const cs = ov.cells[k]; if (!cs) continue;
    const cut = cs.filter(isCut);
    faces.push(...planarFaces(cut, (c) => c.t, false, ox, oy), ...planarFaces(cut, (c) => c.f, true, ox, oy));
  }
  const segs: { a: V2; b: V2 }[] = [];
  for (const r of dom.outline) for (let i = 0; i < r.length; i++) segs.push({ a: r[i], b: r[(i + 1) % r.length] });
  for (const pit of ov.pits) segs.push(...pit.vert);
  for (const s of segs) {
    const lo = profileAlong(dom, ov, s.a, s.b, 1, 'f', isCut), up = profileAlong(dom, ov, s.a, s.b, 1, 't', isCut);
    if (lo.length) faces.push(...walls(s.a, s.b, lo, up, 0, false, ox, oy).faces);
  }
  return faces;
}

// ------------------------------------------------------------ Kennwerte je Grube (zugeordnet nach massgebender Grube)
export interface PitStats { cut: number; bottomArea: number; slopeArea: number; bermArea: number; crown: [V2, V2][]; zCrownMin: number; zCrownMax: number }
export function pitStats(ov: Overlay): PitStats[] {
  const st: PitStats[] = ov.pits.map(() => ({ cut: 0, bottomArea: 0, slopeArea: 0, bermArea: 0, crown: [], zCrownMin: Infinity, zCrownMax: -Infinity }));
  for (const cs of ov.cells) {
    if (!cs) continue;
    for (const c of cs) {
      if (c.src < 0) continue;
      const s = st[c.src]; const pit = ov.pits[c.src];
      s.cut += integral(c.p, [c.t[0] - c.f[0], c.t[1] - c.f[1], c.t[2] - c.f[2]]);
      const A = trueArea(c.p, c.f);
      if (!c.tag) s.bottomArea += A;
      else { const ed = edgeByTag(pit, c.tag); const pc = ed?.pieces[tagPiece(c.tag)]; if (pc?.kind === 2) s.bermArea += A; else s.slopeArea += A; }
      // Böschungskrone: Zellkanten, auf denen Gelände = Grube
      const P = c.p;
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length];
        const dp = evalP(c.t, p.x, p.y) - evalP(c.f, p.x, p.y), dq = evalP(c.t, q.x, q.y) - evalP(c.f, q.x, q.y);
        if (Math.abs(dp) < 0.5 && Math.abs(dq) < 0.5 && Math.hypot(q.x - p.x, q.y - p.y) > 1e-3) {
          s.crown.push([p, q]);
          const z0 = evalP(c.t, p.x, p.y), z1 = evalP(c.t, q.x, q.y);
          s.zCrownMin = Math.min(s.zCrownMin, z0, z1); s.zCrownMax = Math.max(s.zCrownMax, z0, z1);
        }
      }
    }
  }
  return st;
}
export function edgeByTag(pit: Pit, tag: number): PEdge | undefined {
  const ci = tagEdge(tag);
  if (ci >= 0) return pit.edgeOf.get(ci);
  return undefined;
}

// ------------------------------------------------------------ Schnitt mit einer lotrechten Ebene
export interface SecSeg { u0: number; z0: number; u1: number; z1: number }
/**
 * Verlauf der Fläche (Endfläche bzw. Gelände ohne Gruben) in einer lotrechten Ebene durch o (Modell) mit Normale n
 * (horizontal) und Achse r: Abschnitte (u, z). surf: 'f' Endfläche, 't' gewachsenes Terrain.
 */
export function sectionSegs(dom: Domain, ov: Overlay | null, o: V2, n: V2, r: V2, surf: 'f' | 't', filter?: (c: Cell) => boolean): SecSeg[] {
  const tin = dom.tin; const ox = tin.ox, oy = tin.oy;
  const oL = { x: o.x - ox, y: o.y - oy };
  const sd = (x: number, y: number) => n.x * (x - oL.x) + n.y * (y - oL.y);
  const uu = (x: number, y: number) => r.x * (x - oL.x) + r.y * (y - oL.y);
  const out: SecSeg[] = [];
  for (let k = 0; k < tin.nt; k++) {
    const a = tin.tri[3 * k], b = tin.tri[3 * k + 1], c = tin.tri[3 * k + 2];
    const sa = sd(tin.x[a], tin.y[a]), sb = sd(tin.x[b], tin.y[b]), sc = sd(tin.x[c], tin.y[c]);
    if ((sa > 0 && sb > 0 && sc > 0) || (sa < 0 && sb < 0 && sc < 0)) continue;
    for (const cell of cellsOf(dom, ov, k)) {
      if (filter && !filter(cell)) continue;
      const P = cell.p; const F = surf === 'f' ? cell.f : cell.t;
      const xs: V2[] = [];
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length]; const s0 = sd(p.x, p.y), s1 = sd(q.x, q.y);
        if ((s0 < 0) !== (s1 < 0)) { const t = s0 / (s0 - s1); xs.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
      }
      if (xs.length < 2) continue;
      let p0 = xs[0], p1 = xs[1];
      if (uu(p0.x, p0.y) > uu(p1.x, p1.y)) { const t = p0; p0 = p1; p1 = t; }
      const u0 = uu(p0.x, p0.y), u1 = uu(p1.x, p1.y); if (u1 - u0 < 1e-6) continue;
      out.push({ u0, z0: evalP(F, p0.x, p0.y), u1, z1: evalP(F, p1.x, p1.y) });
    }
  }
  return out.sort((p, q) => p.u0 - q.u0);
}
/** Abschnitte zu zusammenhängenden Linienzügen (u, z); Sprünge (Verbau) als senkrechte Teilstücke */
export function segRuns(segs: SecSeg[]): V2[][] {
  const runs: V2[][] = []; let cur: V2[] = []; let uEnd = -Infinity;
  for (const s of segs) {
    if (!cur.length || s.u0 > uEnd + 1e-3) { if (cur.length > 1) runs.push(cur); cur = [{ x: s.u0, y: s.z0 }]; }
    else { const l = cur[cur.length - 1]; if (Math.abs(l.y - s.z0) > 1e-3 || Math.abs(l.x - s.u0) > 1e-3) cur.push({ x: s.u0, y: s.z0 }); }
    cur.push({ x: s.u1, y: s.z1 }); uEnd = Math.max(uEnd, s.u1);
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}
/** Wert eines Verlaufs bei u (NaN ausserhalb) */
export function segZ(segs: SecSeg[], u: number): number {
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].u1 < u - 1e-9) lo = m + 1; else if (segs[m].u0 > u + 1e-9) hi = m - 1; else { const s = segs[m]; return s.z0 + ((s.z1 - s.z0) * (u - s.u0)) / (s.u1 - s.u0 || 1); } }
  return NaN;
}

// ------------------------------------------------------------ Höhenlinien
/** Höhenlinien-Abschnitte (Modellkoordinaten) für die Höhen zs (aufsteigend) */
export function contourSegs(dom: Domain, ov: Overlay | null, zs: number[]): Map<number, [V2, V2][]> {
  const tin = dom.tin; const ox = tin.ox, oy = tin.oy; const out = new Map<number, [V2, V2][]>();
  if (!zs.length) return out;
  for (let k = 0; k < tin.nt; k++) for (const c of cellsOf(dom, ov, k)) {
    const P = c.p; const z = P.map((q) => evalP(c.f, q.x, q.y));
    const lo = Math.min(...z), hi = Math.max(...z); if (hi - lo < 1e-6) continue;
    let i0 = lowerBound(zs, lo);
    for (let li = i0; li < zs.length && zs[li] <= hi; li++) {
      const L = zs[li]; const xs: V2[] = [];
      for (let i = 0; i < P.length; i++) {
        const a = z[i] - L, b = z[(i + 1) % P.length] - L;
        if ((a < 0) !== (b < 0)) { const t = a / (a - b); const p = P[i], q = P[(i + 1) % P.length]; xs.push({ x: p.x + (q.x - p.x) * t + ox, y: p.y + (q.y - p.y) * t + oy }); }
      }
      if (xs.length >= 2) { let l = out.get(L); if (!l) out.set(L, (l = [])); l.push([xs[0], xs[1]]); }
    }
  }
  return out;
}
function lowerBound(a: number[], v: number): number { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }

/** Abschnitte zu Linienzügen verketten */
export function chainSegs(segs: [V2, V2][], tol = 0.05): V2[][] {
  const k = (p: V2) => Math.round(p.x / tol) + ',' + Math.round(p.y / tol);
  const adj = new Map<string, number[]>();
  segs.forEach((s, i) => { for (const p of s) { const kk = k(p); const l = adj.get(kk); if (l) l.push(i); else adj.set(kk, [i]); } });
  const used = new Uint8Array(segs.length); const out: V2[][] = [];
  const extend = (line: V2[], fromEnd: boolean) => {
    for (;;) {
      const p = fromEnd ? line[line.length - 1] : line[0];
      const c = (adj.get(k(p)) ?? []).find((i) => !used[i]); if (c === undefined) return;
      used[c] = 1; const s = segs[c]; const q = k(s[0]) === k(p) ? s[1] : s[0];
      if (fromEnd) line.push(q); else line.unshift(q);
    }
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue; used[i] = 1;
    const line = [segs[i][0], segs[i][1]]; extend(line, true); extend(line, false); out.push(line);
  }
  return out;
}

export { sArea, integral, trueArea };
