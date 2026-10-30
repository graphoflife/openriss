// Wände: Lage (Basislinie), Typ mit Schichten, automatische Eck-/T-Verbindungen,
// Öffnungen durch gehostete Türen/Fenster, Grundriss (Schnitt/Projektion) und 3D-Körper.
import type { Doc, El, Id } from '../core/doc';
import {
  V2, add, sub, mul, dot, norm, perp, dist, lerp, eq, lineLine, projectT, sideDist, cross,
  Ring, Poly, MultiPoly, difference, intersection, signedArea, ensureCCW, segRect, angleOf, pointInRing,
  distToSeg, apply, Mat2, isMirror, mid, closestOnLine, V3, bboxOf, boxInflate, boxOverlap, clipRingHalfPlane,
} from '../core/geom';
import { registerCategory, catDef, CategoryDef, PlanCtx, Solid, Face, PropDef, GROUPS, TempDim, Grip, emitHook } from '../core/registry';
import { TypeEl, levelElev, levelOptions, Material, materialOf, View, isPlanLike, levels } from '../core/view';
import { cached, hostedBy } from '../core/cache';
import { catPen, cutFill } from '../views/sectionEngine';
import { fmtLen } from '../core/units';
import type { DisplayList } from '../render/displayList';
import { patternOptions } from '../render/styles';

export type LocLine = 'center' | 'coreCenter' | 'finishExt' | 'finishInt' | 'coreExt' | 'coreInt';
export const LOC_LINE_LABELS: [LocLine, string][] = [
  ['center', 'Wandachse'], ['coreCenter', 'Tragende Schicht: Achse'], ['finishExt', 'Fertigteil: Außen'],
  ['finishInt', 'Fertigteil: Innen'], ['coreExt', 'Tragende Schicht: Außen'], ['coreInt', 'Tragende Schicht: Innen'],
];

export interface WallLayer { mat: Id; t: number; fn: 'structure' | 'finish' | 'thermal' | 'substrate' | 'membrane' | 'air'; core?: boolean }
export interface WallType extends TypeEl {
  of: 'wall';
  layers: WallLayer[];      // von außen nach innen
  function?: 'exterior' | 'interior' | 'foundation' | 'retaining';
  coarsePattern?: string;
  coarseColor?: string;
  description?: string;
}

export interface Wall extends El {
  cat: 'wall';
  a: V2; b: V2;            // Basislinie (Lage gemäß locLine)
  levelId: Id;
  baseOffset: number;
  topLevelId: Id | null;   // null = nicht verbunden
  topOffset: number;
  height: number;          // nicht verbundene Höhe
  locLine: LocLine;
  flip: boolean;           // Außenseite rechts statt links
  structural?: boolean;
  roomBounding?: boolean;
  noJoinA?: boolean; noJoinB?: boolean;
}

/** Erweiterungspunkt: Dach/Decke liefert Oberkantenprofil für "Oben fixieren". */
export type WallTopProvider = (w: Wall, doc: Doc, c0: V2, c1: V2, zTop: number) => { u: number; z: number }[] | null;
const topProviders: WallTopProvider[] = [];
export function registerWallTopProvider(p: WallTopProvider): void { topProviders.push(p); }

/** Erweiterungspunkt: Öffnung (Tür, Fenster, Wandöffnung) im Host – Bereich entlang der Wandachse. */
export interface HostOpening {
  u0: number; u1: number; z0: number; z1: number;
  /** im Grundriss schneiden */ cutsPlan?: boolean;
  /** beliebige Öffnungsform (z.B. Kernbohrung): geschlossenes Polygon in (u entlang Wandachse, z absolut); u0..z1 = Umgebungsrechteck */
  profile?: { u: number; z: number }[];
}

/** Ausdehnung einer Öffnung entlang der Wand auf Höhe z (null = nicht geschnitten) */
export function openingSpanAt(o: HostOpening, z: number): [number, number] | null {
  if (!o.profile || o.profile.length < 3) return o.z0 <= z && o.z1 >= z ? [o.u0, o.u1] : null;
  const us: number[] = [];
  const P = o.profile;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if ((a.z - z) * (b.z - z) <= 0 && a.z !== b.z) us.push(a.u + ((z - a.z) / (b.z - a.z)) * (b.u - a.u));
  }
  if (us.length < 2) return null;
  return [Math.min(us[0], ...us.slice(1)), Math.max(us[0], ...us.slice(1))];
}

// ------------------------------------------------------------ Geometrie
export function wallType(doc: Doc, w: Wall): WallType | undefined { return doc.get<WallType>(w.typeId); }
export function wallThickness(doc: Doc, w: Wall): number {
  const t = wallType(doc, w);
  return t ? t.layers.reduce((s, l) => s + l.t, 0) : 200;
}
export function typeThickness(t: WallType): number { return t.layers.reduce((s, l) => s + l.t, 0); }

/** Abstand der Basislinie von der Wandachse (positiv = links der Zeichenrichtung) */
export function locOffset(t: WallType | undefined, loc: LocLine, flip: boolean): number {
  if (!t) return 0;
  const T = typeThickness(t);
  // Position (von außen gemessen) der Basislinie
  let fromExt = T / 2;
  let acc = 0; let coreS = -1, coreE = -1;
  t.layers.forEach((l) => { if (l.core && coreS < 0) coreS = acc; acc += l.t; if (l.core) coreE = acc; });
  if (coreS < 0) { coreS = 0; coreE = T; }
  switch (loc) {
    case 'center': fromExt = T / 2; break;
    case 'finishExt': fromExt = 0; break;
    case 'finishInt': fromExt = T; break;
    case 'coreExt': fromExt = coreS; break;
    case 'coreInt': fromExt = coreE; break;
    case 'coreCenter': fromExt = (coreS + coreE) / 2; break;
  }
  // Außenseite ist links (flip=false). Achse liegt bei T/2 von außen.
  const off = T / 2 - fromExt; // >0: Basislinie liegt außen von der Achse → Achse liegt rechts davon
  return flip ? off : -off;
}

export interface WallInfo {
  w: Wall; c0: V2; c1: V2; d: V2; n: V2; T: number; L: number; z0: number; z1: number;
  /** Außenseite links (+1) oder rechts (-1) */
  ext: 1 | -1;
}
export function wallInfo(doc: Doc, w: Wall): WallInfo {
  return cached(doc, 'wallInfo', w.id, () => {
    const t = wallType(doc, w);
    const T = t ? typeThickness(t) : 200;
    const d = norm(sub(w.b, w.a)); const n = perp(d);
    const off = locOffset(t, w.locLine, w.flip);
    const c0 = add(w.a, mul(n, off)), c1 = add(w.b, mul(n, off));
    const z0 = levelElev(doc, w.levelId) + (w.baseOffset ?? 0);
    const z1 = w.topLevelId ? levelElev(doc, w.topLevelId) + (w.topOffset ?? 0) : z0 + (w.height ?? 3000);
    return { w, c0, c1, d, n, T, L: dist(w.a, w.b), z0, z1: Math.max(z1, z0 + 1), ext: w.flip ? -1 : 1 };
  });
}

const JOIN_TOL = 2;
interface EndC { L: V2; R: V2; C?: V2; joined: boolean }

function allWallInfos(doc: Doc): WallInfo[] { return cached(doc, 'wallInfos', '', () => doc.all<Wall>('wall').map((w) => wallInfo(doc, w))); }
const zOverlap = (a: WallInfo, b: WallInfo) => a.z0 < b.z1 - 1 && b.z0 < a.z1 - 1;

function sideLine(cPt: V2, out: V2, T: number, left: boolean): [V2, V2] {
  const nn = perp(out); const p = add(cPt, mul(nn, left ? T / 2 : -T / 2));
  return [p, add(p, out)];
}

function endCorners(doc: Doc, wi: WallInfo, atStart: boolean): EndC {
  const P = atStart ? wi.w.a : wi.w.b;
  const out = atStart ? wi.d : mul(wi.d, -1);
  const cPt = atStart ? wi.c0 : wi.c1;
  const myL = sideLine(cPt, out, wi.T, true), myR = sideLine(cPt, out, wi.T, false);
  const square: EndC = { L: myL[0], R: myR[0], joined: false };
  if (atStart ? wi.w.noJoinA : wi.w.noJoinB) return square;
  const all = allWallInfos(doc);
  const others = all.filter((o) => o !== wi && o.w.id !== wi.w.id && zOverlap(o, wi) && o.L > 1 &&
    ((eq(o.w.a, P, JOIN_TOL) && !o.w.noJoinA) || (eq(o.w.b, P, JOIN_TOL) && !o.w.noJoinB)));
  const clampP = (x: V2 | undefined, fb: V2) => (x && dist(x, fb) < Math.max(wi.T, 50) * 6 ? x : fb);
  if (!others.length) {
    // T-Stoß: Endpunkt liegt im Körper einer anderen Wand
    for (const o of all) {
      if (o === wi || !zOverlap(o, wi) || o.L < 1) continue;
      const t = projectT(P, o.c0, o.c1);
      if (t <= 0.0001 || t >= 0.9999) continue;
      const sd = sideDist(P, o.c0, o.c1);
      if (Math.abs(sd) > o.T / 2 + JOIN_TOL) continue;
      if (Math.abs(cross(o.d, out)) < 0.05) continue; // parallel
      const side = cross(o.d, out) > 0 ? 1 : -1; // unser Körper liegt links (+) / rechts (-) von o
      const fp = add(o.c0, mul(o.n, side * o.T / 2)); const fq = add(fp, o.d);
      const L = lineLine(myL[0], myL[1], fp, fq)?.p; const R = lineLine(myR[0], myR[1], fp, fq)?.p;
      return { L: clampP(L, myL[0]), R: clampP(R, myR[0]), joined: true };
    }
    return square;
  }
  const items = [{ wi, out, cPt }, ...others.map((o) => {
    const st = eq(o.w.a, P, JOIN_TOL);
    return { wi: o, out: st ? o.d : mul(o.d, -1), cPt: st ? o.c0 : o.c1 };
  })].map((x) => ({ ...x, ang: angleOf(x.out) })).sort((a, b) => a.ang - b.ang);
  const n = items.length; const k = items.findIndex((x) => x.wi === wi);
  const corner = (i: number): V2 => { // Ecke zwischen items[i] (links) und items[i+1] (rechts)
    const A = items[i], B = items[(i + 1) % n];
    const al = sideLine(A.cPt, A.out, A.wi.T, true), br = sideLine(B.cPt, B.out, B.wi.T, false);
    const x = lineLine(al[0], al[1], br[0], br[1]);
    const fb = mid(al[0], br[0]);
    if (!x) return fb;
    if (dist(x.p, A.cPt) > Math.max(A.wi.T, B.wi.T) * 6) return fb;
    return x.p;
  };
  let L = corner(k); let R = corner((k - 1 + n) % n);
  if (n === 2) {
    const other = items[(k + 1) % n];
    if (Math.abs(cross(out, other.out)) < 0.02) { L = myL[0]; R = myR[0]; } // gerade Fortsetzung
  }
  let C: V2 | undefined;
  if (n >= 3) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { const c = corner(i); cx += c.x; cy += c.y; }
    C = { x: cx / n, y: cy / n };
  }
  return { L, R, C, joined: true };
}

export interface WallShape { ring: Ring; A: EndC; B: EndC; }
/** Grundrissumriss der Wand inkl. Verbindungen (gegen den Uhrzeigersinn) */
export function wallShape(doc: Doc, w: Wall): WallShape {
  return cached(doc, 'wallShape', w.id, () => {
    const wi = wallInfo(doc, w);
    const A = endCorners(doc, wi, true), B = endCorners(doc, wi, false);
    const ring: V2[] = [A.R, B.L];
    if (B.C) ring.push(B.C);
    ring.push(B.R, A.L);
    if (A.C) ring.push(A.C);
    return { ring: ensureCCW(ring), A, B };
  });
}

/** Öffnungen aller gehosteten Elemente */
export function wallOpenings(doc: Doc, w: Wall): (HostOpening & { el: El })[] {
  const out: (HostOpening & { el: El })[] = [];
  for (const h of hostedBy(doc, w.id)) {
    const def = catDef(h.cat) as any;
    if (def?.hostOpening) { const o = def.hostOpening(h, doc); if (o) out.push({ ...o, el: h }); }
  }
  return out;
}

/** Rechteck einer Öffnung im Grundriss (über die ganze Wanddicke) */
function openingRect(wi: WallInfo, u0: number, u1: number): Ring {
  const p0 = add(wi.c0, mul(wi.d, u0)), p1 = add(wi.c0, mul(wi.d, u1));
  return segRect(p0, p1, wi.T / 2 + 2, wi.T / 2 + 2);
}

/** Schichtgrenzen als Versätze von der Achse (positiv links), von außen nach innen */
export function layerOffsets(doc: Doc, w: Wall): { lay: WallLayer; o0: number; o1: number }[] {
  const t = wallType(doc, w); if (!t) return [];
  const T = typeThickness(t); const s = w.flip ? -1 : 1;
  let acc = 0; const out: { lay: WallLayer; o0: number; o1: number }[] = [];
  for (const l of t.layers) {
    const a = s * (T / 2 - acc), b = s * (T / 2 - acc - l.t);
    out.push({ lay: l, o0: Math.min(a, b), o1: Math.max(a, b) });
    acc += l.t;
  }
  return out;
}

// ------------------------------------------------------------ Grundriss
function edgesOf(mp: MultiPoly): [V2, V2][] {
  const out: [V2, V2][] = [];
  for (const p of mp) for (const r of p) for (let i = 0; i < r.length; i++) out.push([r[i], r[(i + 1) % r.length]]);
  return out;
}

/** Teile eines Segments, die nicht in/auf anderen Ringen liegen */
function visibleParts(a: V2, b: V2, others: Ring[]): [V2, V2][] {
  const ts = [0, 1];
  for (const r of others) for (let i = 0; i < r.length; i++) {
    const x = lineLine(a, b, r[i], r[(i + 1) % r.length]);
    if (x && x.t > 0 && x.t < 1 && x.u >= -1e-9 && x.u <= 1 + 1e-9) ts.push(x.t);
  }
  ts.sort((m, n) => m - n);
  const out: [V2, V2][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-6) continue;
    const pa = lerp(a, b, ts[i]), pb = lerp(a, b, ts[i + 1]); const m = lerp(a, b, (ts[i] + ts[i + 1]) / 2);
    let hidden = false;
    for (const r of others) {
      if (pointInRing(m, r)) { hidden = true; break; }
      for (let j = 0; j < r.length; j++) if (distToSeg(m, r[j], r[(j + 1) % r.length]) < 0.5) { hidden = true; break; }
      if (hidden) break;
    }
    if (!hidden) {
      const last = out[out.length - 1];
      if (last && eq(last[1], pa, 1e-6)) last[1] = pb; else out.push([pa, pb]);
    }
  }
  return out;
}

function drawWallsPlan(ctx: PlanCtx, walls: El[]): void {
  const { doc, dl } = ctx;
  const cutWalls: { w: Wall; wi: WallInfo; shape: Poly; ring: Ring }[] = [];
  const projPen = catPen(doc, 'wall', false), cutPen = catPen(doc, 'wall', true);
  for (const el of walls) {
    const w = el as Wall; const wi = wallInfo(doc, w);
    if (wi.L < 1) continue;
    if (wi.z0 <= ctx.cutZ && wi.z1 > ctx.cutZ) {
      const sh = wallShape(doc, w);
      cutWalls.push({ w, wi, shape: [sh.ring], ring: sh.ring });
    } else if (wi.z1 <= ctx.cutZ && wi.z1 > ctx.depthZ - 1) {
      // unterhalb der Schnittebene: nur Umriss
      dl.begin(w.id);
      dl.poly(wallShape(doc, w).ring, projPen, true);
    }
  }
  const rings = cutWalls.map((c) => c.ring);
  const boxes = rings.map((r) => boxInflate(bboxOf(r), 2));
  for (let i = 0; i < cutWalls.length; i++) {
    const { w, wi, ring } = cutWalls[i];
    dl.begin(w.id);
    // Basislinie (unsichtbar) für Fang an Wandenden/-achsen
    dl.line(w.a, w.b, { w: 1 }, { inv: true, sub: 'loc' });
    // Öffnungen abziehen
    const spans = wallOpenings(doc, w).filter((o) => o.cutsPlan !== false).map((o) => openingSpanAt(o, ctx.cutZ)).filter((x): x is [number, number] => !!x && x[1] - x[0] > 1);
    let body: MultiPoly = [[ring]];
    if (spans.length) body = difference([ring], ...spans.map(([a, b]) => [openingRect(wi, a, b)]));
    const t = wallType(doc, w);
    if (ctx.detail === 'coarse' || !t || t.layers.length <= 1) {
      const core = t?.layers.find((l) => l.core) ?? t?.layers[0];
      const m = materialOf(doc, core?.mat);
      const pat = t?.coarsePattern ?? m?.cutPattern;
      const fill = cutFill(pat, t?.coarsePattern ? t?.coarseColor : m?.cutColor, ctx.detail);
      for (const p of body) dl.fill(p, fill, undefined);
    } else {
      // Schichten
      const L = layerOffsets(doc, w);
      const far = wi.L + wi.T * 20 + 10000;
      for (const { lay, o0, o1 } of L) {
        // Schichtstreifen: Körper an den beiden Schichtgrenzen (Halbebenen) clippen
        const p0 = add(wi.c0, mul(wi.n, o0)), p1 = add(wi.c0, mul(wi.n, o1));
        const m = materialOf(doc, lay.mat);
        const fill = cutFill(m?.cutPattern, m?.cutColor, ctx.detail);
        for (const p of body) {
          const rings = p.map((r) => clipRingHalfPlane(clipRingHalfPlane(r, p0, wi.d), p1, mul(wi.d, -1))).filter((r) => r.length >= 3);
          if (rings.length) dl.fill(rings, fill, undefined);
        }
      }
      // innere Schichtgrenzen (dünn)
      for (let j = 1; j < L.length; j++) {
        const o = L[j].o0 === L[j - 1].o1 || Math.abs(L[j].o0 - L[j - 1].o1) < 0.01 ? L[j].o0 : L[j].o1;
        const pa = add(sub(wi.c0, mul(wi.d, far)), mul(wi.n, o)), pb = add(add(wi.c1, mul(wi.d, far)), mul(wi.n, o));
        for (const [s0, s1] of clipSegToMulti(pa, pb, body)) dl.line(s0, s1, { w: 1 }, { ns: false, sub: 'layer' });
      }
    }
    // Umriss (ohne Kanten, die in verbundenen Wänden liegen)
    const others = rings.filter((_, j) => j !== i && boxOverlap(boxes[i], boxes[j]));
    for (const [a, b] of edgesOf(body)) {
      for (const [p, q] of visibleParts(a, b, others)) dl.line(p, q, cutPen, { sub: faceSub(wi, p, q) });
    }
  }
}

function faceSub(wi: WallInfo, p: V2, q: V2): string | undefined {
  const m = mid(p, q); const s = sideDist(m, wi.c0, wi.c1);
  if (Math.abs(Math.abs(s) - wi.T / 2) < 0.5) return s > 0 ? 'faceL' : 'faceR';
  return undefined;
}

/** Segment auf Mehrfachpolygon zuschneiden */
export function clipSegToMulti(a: V2, b: V2, mp: MultiPoly): [V2, V2][] {
  const ts = [0, 1];
  for (const p of mp) for (const r of p) for (let i = 0; i < r.length; i++) {
    const x = lineLine(a, b, r[i], r[(i + 1) % r.length]);
    if (x && x.t > 0 && x.t < 1 && x.u >= 0 && x.u <= 1) ts.push(x.t);
  }
  ts.sort((m, n) => m - n);
  const out: [V2, V2][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const m = lerp(a, b, (ts[i] + ts[i + 1]) / 2);
    const inside = mp.some((p) => pointInRing(m, p[0]) && !p.slice(1).some((h) => pointInRing(m, h)));
    if (inside) out.push([lerp(a, b, ts[i]), lerp(a, b, ts[i + 1])]);
  }
  return out;
}

// ------------------------------------------------------------ 3D
export function wallSolids(doc: Doc, w: Wall): Solid[] {
  const wi = wallInfo(doc, w);
  if (wi.L < 1) return [];
  const sh = wallShape(doc, w);
  const ring = sh.ring;
  const ops = wallOpenings(doc, w);
  const t = wallType(doc, w);
  const coreMat = (t?.layers.find((l) => l.core) ?? t?.layers[0])?.mat;
  const z0 = wi.z0, z1 = wi.z1;
  let profile: { u: number; z: number }[] | null = null;
  for (const p of topProviders) { profile = p(w, doc, wi.c0, wi.c1, z1); if (profile) break; }

  // Pro Schicht ein Körper (Schnitte zeigen Schichten); bei 1 Schicht nur einer
  const layers = t && t.layers.length > 1 ? layerOffsets(doc, w) : null;
  const pieces: { ring: Ring; mat?: Id }[] = [];
  if (layers) {
    const far = wi.L + wi.T * 20 + 10000;
    for (const { lay, o0, o1 } of layers) {
      if (lay.t < 0.5) continue;
      const a0 = sub(wi.c0, mul(wi.d, far)), b0 = add(wi.c1, mul(wi.d, far));
      const band: Ring = [add(a0, mul(wi.n, o0)), add(b0, mul(wi.n, o0)), add(b0, mul(wi.n, o1)), add(a0, mul(wi.n, o1))];
      for (const p of intersection([ring], [band])) pieces.push({ ring: p[0], mat: lay.mat });
    }
  } else pieces.push({ ring, mat: coreMat });

  return pieces.map((pc) => ({ faces: wallPieceFaces(wi, pc.ring, ops, z0, z1, profile), mat: pc.mat }));
}

function wallPieceFaces(wi: WallInfo, ringIn: Ring, ops: HostOpening[], z0: number, z1: number, profile: { u: number; z: number }[] | null): Face[] {
  const ring = ensureCCW(ringIn);
  const faces: Face[] = [];
  const opRects = ops.map((o) => ({ ...o, z0: Math.max(o.z0, z0), z1: Math.min(o.z1, z1) })).filter((o) => o.z1 > o.z0 + 1 && o.u1 > o.u0 + 1);
  const uOf = (p: V2) => dot(sub(p, wi.c0), wi.d);
  const topAt = (u: number): number => {
    if (!profile || !profile.length) return z1;
    if (u <= profile[0].u) return profile[0].z;
    for (let i = 1; i < profile.length; i++) if (u <= profile[i].u) {
      const a = profile[i - 1], b = profile[i]; const f = (u - a.u) / Math.max(1e-9, b.u - a.u); return a.z + (b.z - a.z) * f;
    }
    return profile[profile.length - 1].z;
  };
  const at3 = (p: V2, z: number): V3 => ({ x: p.x, y: p.y, z });

  // Boden
  const botCut = opRects.filter((o) => o.z0 <= z0 + 0.5).map((o) => [openingRect(wi, o.u0, o.u1)] as Poly);
  const bottom = botCut.length ? difference([ring], ...botCut) : [[ring]];
  for (const p of bottom) faces.push({ pts: p[0].slice().reverse().map((q) => at3(q, z0)), holes: p.slice(1).map((h) => h.slice().reverse().map((q) => at3(q, z0))) });

  // Decke (flach oder Profil)
  if (!profile) {
    const topCut = opRects.filter((o) => o.z1 >= z1 - 0.5).map((o) => [openingRect(wi, o.u0, o.u1)] as Poly);
    const top = topCut.length ? difference([ring], ...topCut) : [[ring]];
    for (const p of top) faces.push({ pts: p[0].map((q) => at3(q, z1)), holes: p.slice(1).map((h) => h.map((q) => at3(q, z1))) });
  } else {
    // Profil: Draufsicht in Streifen zerlegen
    const us = [...new Set([...profile.map((p) => p.u), ...ring.map(uOf)])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < us.length; i++) {
      const ua = us[i], ub = us[i + 1]; if (ub - ua < 0.5) continue;
      const band: Ring = [add(wi.c0, add(mul(wi.d, ua), mul(wi.n, -wi.T * 3))), add(wi.c0, add(mul(wi.d, ub), mul(wi.n, -wi.T * 3))), add(wi.c0, add(mul(wi.d, ub), mul(wi.n, wi.T * 3))), add(wi.c0, add(mul(wi.d, ua), mul(wi.n, wi.T * 3)))];
      for (const p of intersection([ring], [band])) faces.push({ pts: ensureCCW(p[0]).map((q) => at3(q, topAt(uOf(q)))) });
    }
  }

  // Seitenflächen
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const L = dist(p, q); if (L < 0.01) continue;
    const e = norm(sub(q, p));
    const parallel = Math.abs(cross(e, wi.d)) < 1e-3;
    // Fläche in (s, z)
    const s2p = (s: number) => add(p, mul(e, s));
    let outer: V2[];
    if (profile) {
      const steps: number[] = [0, L];
      for (const pp of profile) { const s = dot(sub(add(wi.c0, mul(wi.d, pp.u)), p), e); if (s > 0 && s < L) steps.push(s); }
      steps.sort((a, b) => a - b);
      outer = [{ x: 0, y: z0 }, { x: L, y: z0 }, ...steps.slice().reverse().map((s) => ({ x: s, y: topAt(uOf(s2p(s))) }))];
    } else outer = [{ x: 0, y: z0 }, { x: L, y: z0 }, { x: L, y: z1 }, { x: 0, y: z1 }];
    let polys: MultiPoly = [[outer]];
    if (parallel && opRects.length) {
      const sOf = (u: number) => dot(sub(add(wi.c0, mul(wi.d, u)), p), e);
      const holes = opRects.map((o) => {
        if (o.profile && o.profile.length >= 3) return [o.profile.map((q) => ({ x: sOf(q.u), y: Math.max(z0, Math.min(z1, q.z)) }))] as Poly;
        const sa = sOf(o.u0), sb = sOf(o.u1);
        const s0 = Math.min(sa, sb), s1 = Math.max(sa, sb);
        return [[{ x: s0, y: o.z0 }, { x: s1, y: o.z0 }, { x: s1, y: o.z1 }, { x: s0, y: o.z1 }]] as Poly;
      }).filter((h) => Math.max(...h[0].map((q) => q.x)) > 0 && Math.min(...h[0].map((q) => q.x)) < L);
      if (holes.length) polys = difference([outer], ...holes);
    }
    for (const pl of polys) {
      const o = ensureCCW(pl[0]);
      faces.push({ pts: o.map((v) => at3(s2p(v.x), v.y)), holes: pl.slice(1).map((h) => h.map((v) => at3(s2p(v.x), v.y))) });
    }
  }
  // Leibungen
  const sideOffs = ring.map((p) => sideDist(p, wi.c0, wi.c1));
  const oMin = Math.min(...sideOffs), oMax = Math.max(...sideOffs);
  for (const o of opRects) {
    const R = (u: number, z: number) => at3(add(add(wi.c0, mul(wi.d, u)), mul(wi.n, oMin)), z);
    const Lp = (u: number, z: number) => at3(add(add(wi.c0, mul(wi.d, u)), mul(wi.n, oMax)), z);
    if (o.profile && o.profile.length >= 3) {
      // Leibung je Profilkante (Profil gegen den Uhrzeigersinn in u/z)
      const pr = signedArea(o.profile.map((q) => ({ x: q.u, y: q.z }))) > 0 ? o.profile : o.profile.slice().reverse();
      for (let i = 0; i < pr.length; i++) {
        const A = pr[i], B = pr[(i + 1) % pr.length];
        faces.push({ pts: [R(A.u, A.z), R(B.u, B.z), Lp(B.u, B.z), Lp(A.u, A.z)] });
      }
      continue;
    }
    faces.push({ pts: [R(o.u0, o.z0), Lp(o.u0, o.z0), Lp(o.u0, o.z1), R(o.u0, o.z1)] });
    faces.push({ pts: [Lp(o.u1, o.z0), R(o.u1, o.z0), R(o.u1, o.z1), Lp(o.u1, o.z1)] });
    if (o.z0 > z0 + 0.5) faces.push({ pts: [R(o.u0, o.z0), R(o.u1, o.z0), Lp(o.u1, o.z0), Lp(o.u0, o.z0)] });
    if (o.z1 < z1 - 0.5) faces.push({ pts: [Lp(o.u0, o.z1), Lp(o.u1, o.z1), R(o.u1, o.z1), R(o.u0, o.z1)] });
  }
  return faces;
}

// ------------------------------------------------------------ Hilfen für Werkzeuge
/** Wand unter einem Punkt (Grundriss) – für Türen/Fenster */
export function wallAt(doc: Doc, p: V2, levelZ: number | null, tol = 0): Wall | null {
  let best: Wall | null = null; let bd = Infinity;
  for (const w of doc.all<Wall>('wall')) {
    const wi = wallInfo(doc, w);
    if (levelZ !== null && !(wi.z0 <= levelZ + 1 && wi.z1 > levelZ + 1)) continue;
    const t = projectT(p, wi.c0, wi.c1);
    if (t < 0 || t > 1) continue;
    const d = Math.abs(sideDist(p, wi.c0, wi.c1)) - wi.T / 2;
    if (d <= tol && d < bd) { bd = d; best = w; }
  }
  return best;
}

/** Wände an einer Ebene (Basisebene) */
export function wallsOnLevel(doc: Doc, levelId: Id): Wall[] { return doc.all<Wall>('wall').filter((w) => w.levelId === levelId); }

/** Gehostete Elemente bei Endpunktänderung so verschieben, dass sie absolut stehen bleiben. */
export function keepHostedAbsolute(doc: Doc, w: Wall, newA: V2, newB: V2): void {
  const oldD = norm(sub(w.b, w.a)); const newD = norm(sub(newB, newA));
  for (const h of hostedBy(doc, w.id)) {
    if (typeof h.t !== 'number') continue;
    const abs = add(w.a, mul(oldD, h.t));
    const nt = dot(sub(abs, newA), newD);
    doc.update(h.id, { t: nt });
  }
}

// ------------------------------------------------------------ Kategorie
const wallDef: CategoryDef = {
  cat: 'wall', label: 'Wand', plural: 'Wände', hasTypes: true, planOrder: 10,
  drawPlanBatch: drawWallsPlan,
  solids: (el, doc) => wallSolids(doc, el as Wall),
  center: (el, doc) => { const wi = wallInfo(doc, el as Wall); return mid(wi.c0, wi.c1); },
  curve: (el) => ({ a: (el as Wall).a, b: (el as Wall).b }),
  setCurve: (el, a, b, doc) => { keepHostedAbsolute(doc, el as Wall, a, b); return { a, b }; },
  grips: (el, doc, view) => {
    if (!isPlanLike(view)) return [];
    const w = el as Wall; const wi = wallInfo(doc, w);
    const m = mid(wi.c0, wi.c1);
    const extSide = mul(wi.n, wi.ext * (wi.T / 2 + view.scale * 4));
    return [
      { id: 'a', p: w.a, kind: 'end', tip: 'Wandende ziehen' },
      { id: 'b', p: w.b, kind: 'end', tip: 'Wandende ziehen' },
      { id: 'flip', p: add(m, extSide), kind: 'flip', dir: wi.n, tip: 'Wandausrichtung umkehren (Leertaste)' },
    ];
  },
  dragGrip: (el, id, p, doc) => {
    const w = el as Wall;
    if (id === 'a') { keepHostedAbsolute(doc, w, p, w.b); return { a: p }; }
    if (id === 'b') { keepHostedAbsolute(doc, w, w.a, p); return { b: p }; }
  },
  clickGrip: (el, id) => (id === 'flip' ? flipWall(el as Wall) : undefined),
  transform: (el, m, doc, view) => {
    const w = el as Wall;
    if (!isPlanLike(view)) return;
    const patch: Partial<Wall> = { a: apply(m, w.a), b: apply(m, w.b) };
    if (isMirror(m)) {
      patch.flip = !w.flip;
      for (const h of hostedBy(doc, w.id)) if (h.cat === 'door' || h.cat === 'window') doc.update(h.id, { flipFacing: !h.flipFacing, flipHand: !h.flipHand });
    }
    return patch;
  },
  translate3d: (el, d) => { const w = el as Wall; return { a: { x: w.a.x + d.x, y: w.a.y + d.y }, b: { x: w.b.x + d.x, y: w.b.y + d.y }, baseOffset: (w.baseOffset ?? 0) + d.z, topOffset: w.topLevelId ? (w.topOffset ?? 0) + d.z : w.topOffset }; },
  tempDims: (el, doc, view) => wallTempDims(doc, el as Wall, view),
  props: (el, doc) => wallProps(),
  typeProps: () => wallTypeProps(),
  tagText: (el, doc) => (wallType(doc, el as Wall)?.name ?? ''),
  tagPoint: (el, doc) => { const wi = wallInfo(doc, el as Wall); return mid(wi.c0, wi.c1); },
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => wallType(doc, el as Wall)?.name ?? '' },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => wallInfo(doc, el as Wall).L },
    { key: 'thickness', label: 'Breite', unit: 'len', get: (el, doc) => wallInfo(doc, el as Wall).T },
    { key: 'height', label: 'Höhe', unit: 'len', get: (el, doc) => { const wi = wallInfo(doc, el as Wall); return wi.z1 - wi.z0; } },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => wallArea(doc, el as Wall) },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => wallArea(doc, el as Wall) * wallInfo(doc, el as Wall).T },
    { key: 'level', label: 'Basisebene', get: (el, doc) => doc.get(el.levelId)?.name ?? '' },
  ],
};
registerCategory(wallDef);

export function flipWall(w: Wall): Partial<Wall> {
  // Spiegeln um die Basislinie: Außenseite wechselt
  return { flip: !w.flip };
}

export function wallArea(doc: Doc, w: Wall): number {
  const wi = wallInfo(doc, w);
  let a = wi.L * (wi.z1 - wi.z0);
  for (const o of wallOpenings(doc, w)) a -= (o.u1 - o.u0) * (Math.min(o.z1, wi.z1) - Math.max(o.z0, wi.z0));
  return Math.max(0, a);
}

function wallTempDims(doc: Doc, w: Wall, view: View): TempDim[] {
  if (!isPlanLike(view)) return [];
  const wi = wallInfo(doc, w);
  const dims: TempDim[] = [];
  // Länge (entlang der Außenseite)
  const off = mul(wi.n, wi.ext * (wi.T / 2 + view.scale * 6));
  dims.push({
    a: add(w.a, off), b: add(w.b, off), value: wi.L, label: 'Länge',
    apply: (v) => { const nb = add(w.a, mul(wi.d, v)); doc.update(w.id, { b: nb }); },
  });
  // Abstand zu nächsten parallelen Wänden beidseitig (Achse–Achse)
  const m = mid(wi.c0, wi.c1);
  for (const side of [1, -1]) {
    let best: { o: WallInfo; d: number } | null = null;
    for (const o of doc.all<Wall>('wall')) {
      if (o.id === w.id) continue;
      const oi = wallInfo(doc, o);
      if (Math.abs(cross(oi.d, wi.d)) > 0.01) continue;
      if (!(oi.z0 < wi.z1 && wi.z0 < oi.z1)) continue;
      const foot = closestOnLine(m, oi.c0, oi.c1);
      const t = projectT(foot, oi.c0, oi.c1);
      if (t < -0.05 || t > 1.05) continue;
      const sd = sideDist(foot, wi.c0, wi.c1) * side;
      if (sd <= 1) continue;
      if (!best || sd < best.d) best = { o: oi, d: sd };
    }
    if (best) {
      const target = closestOnLine(m, best.o.c0, best.o.c1);
      const dir = norm(sub(m, target));
      dims.push({
        a: target, b: m, value: best.d,
        apply: (v) => {
          const delta = mul(dir, v - best!.d);
          doc.update(w.id, { a: add(w.a, delta), b: add(w.b, delta) });
        },
      });
    }
  }
  return dims;
}

export const LEVEL_TOP_NONE = '';
export function wallProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'locLine', label: 'Basislinie', group: g.constraints, type: 'select', options: LOC_LINE_LABELS, get: (e) => e.locLine,
      set: (e, v, doc) => {
        // Basislinie wechseln ohne die Wand zu verschieben
        const w = e as Wall; const t = wallType(doc, w);
        const o0 = locOffset(t, w.locLine, w.flip), o1 = locOffset(t, v, w.flip);
        const n = perp(norm(sub(w.b, w.a))); const d = mul(n, o0 - o1);
        return { locLine: v, a: add(w.a, d), b: add(w.b, d) };
      } },
    { key: 'levelId', label: 'Basisabhängigkeit', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'baseOffset', label: 'Versatz unten', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'topLevelId', label: 'Abhängigkeit oben', group: g.constraints, type: 'select',
      options: (doc) => [[LEVEL_TOP_NONE, 'Nicht verbunden'], ...levelOptions(doc).map(([id, n]) => [id, 'Bis Ebene: ' + n] as [string, string])],
      get: (e) => e.topLevelId ?? LEVEL_TOP_NONE, set: (_e, v) => ({ topLevelId: v || null }) },
    { key: 'height', label: 'Nicht verbundene Höhe', group: g.constraints, type: 'length', get: (e, doc) => { const wi = wallInfo(doc, e as Wall); return wi.z1 - wi.z0; },
      set: (e, v) => (e.topLevelId ? undefined : { height: v }) },
    { key: 'topOffset', label: 'Versatz oben', group: g.constraints, type: 'length', get: (e) => e.topOffset ?? 0, set: (_e, v) => ({ topOffset: v }) },
    { key: 'roomBounding', label: 'Raumbegrenzung', group: g.constraints, type: 'bool', get: (e) => e.roomBounding !== false, set: (_e, v) => ({ roomBounding: v }) },
    { key: 'structural', label: 'Tragwerk', group: g.structural, type: 'bool', get: (e) => !!e.structural, set: (_e, v) => ({ structural: v }) },
    { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(wallInfo(doc, e as Wall).L) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => wallArea(doc, e as Wall) },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => ((wallArea(doc, e as Wall) * wallInfo(doc, e as Wall).T) / 1e9).toFixed(3).replace('.', ',') + ' m³' },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
  ];
}

export function wallTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'layers', label: 'Tragwerk (Schichten)', group: g.construction, type: 'button', get: () => 'Bearbeiten…', action: (t) => emitHook('editWallLayers', t) },
    { key: 'width', label: 'Breite', group: g.construction, type: 'readonly', get: (t) => fmtLen(typeThickness(t as WallType)) },
    { key: 'function', label: 'Funktion', group: g.construction, type: 'select', options: [['exterior', 'Außen'], ['interior', 'Innen'], ['foundation', 'Fundament'], ['retaining', 'Stützmauer']], get: (t) => t.function ?? 'exterior', set: (_t, v) => ({ function: v }) },
    { key: 'coarsePattern', label: 'Füllmuster grobe Darstellung', group: g.graphics, type: 'select', options: () => [['', '<Material>'], ...patternOptions().slice(1)], get: (t) => t.coarsePattern ?? '', set: (_t, v) => ({ coarsePattern: v || undefined }) },
    { key: 'coarseColor', label: 'Füllfarbe grobe Darstellung', group: g.graphics, type: 'color', get: (t) => t.coarseColor ?? '#808080', set: (_t, v) => ({ coarseColor: v }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

export function isWall(e: El | undefined): e is Wall { return !!e && e.cat === 'wall'; }
export { levels };
export type { DisplayList };
