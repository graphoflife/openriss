// Wände: Lage (Basislinie), Typ mit Schichten, automatische Eck-/T-Verbindungen,
// Öffnungen durch gehostete Türen/Fenster, Grundriss (Schnitt/Projektion) und 3D-Körper.
import type { Doc, El, Id } from '../core/doc';
import {
  V2, add, sub, mul, dot, norm, perp, dist, lerp, eq, lineLine, projectT, sideDist, cross,
  Ring, Poly, MultiPoly, difference, intersection, union, signedArea, ensureCCW, ensureCW, segRect, angleOf, pointInRing,
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

export interface WallLayer {
  mat: Id; t: number; fn: 'structure' | 'finish' | 'thermal' | 'substrate' | 'membrane' | 'air'; core?: boolean;
  /** Schicht über Deckenstirn bis OK der oberen Ebene durchziehen (undefiniert = Vorgabe des Typs für Außenschichten) */
  wrap?: boolean;
}
export interface WallType extends TypeEl {
  of: 'wall';
  layers: WallLayer[];      // von außen nach innen
  function?: 'exterior' | 'interior' | 'foundation' | 'retaining';
  coarsePattern?: string;
  coarseColor?: string;
  /** Außenschichten (außerhalb der Tragschicht) über die Deckenstirn bis OK nächste Ebene durchziehen */
  wrapExterior?: boolean;
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
  /** Oberkante fixiert an Dach/Geschossdecke (Unterseite) */
  attachTopId?: Id;
  /** Unterkante fixiert an Geschossdecke/Fundamentplatte (auch geneigt/Rampe) */
  attachBaseId?: Id;
  /** Unterkante an Oberseite (Standard) oder Unterseite der Platte */
  attachBaseTo?: 'top' | 'bottom';
  /** über die Wanddicke: 'min' (Standard) = tiefster Punkt, die Wand greift in die Platte ein; 'max' = höchster Punkt, kein Eingriff (Spalt) */
  attachBaseMode?: 'min' | 'max';
}

/** Höhenprofil entlang der Wandachse (u ab c0, z absolut), nach u sortiert */
export type WallProfile = { u: number; z: number }[];
/**
 * Erweiterungspunkt: Dach/Decke liefert das Oberkantenprofil («Oben fixieren», which = 'top') bzw. das
 * Unterkantenprofil («Unten fixieren», which = 'base'); zNom = Nennhöhe (wi.z1 bzw. wi.z0).
 */
export type WallTopProvider = (w: Wall, doc: Doc, c0: V2, c1: V2, zNom: number, which: 'top' | 'base') => WallProfile | null;
const topProviders: WallTopProvider[] = [];
export function registerWallTopProvider(p: WallTopProvider): void { topProviders.push(p); }

/** Höhe eines Profils an der Stelle u (ausserhalb: Endwerte; ohne Profil: fb) */
export function profAt(pr: WallProfile | null | undefined, u: number, fb: number): number {
  if (!pr || !pr.length) return fb;
  if (u <= pr[0].u) return pr[0].z;
  for (let i = 1; i < pr.length; i++) if (u <= pr[i].u) {
    const a = pr[i - 1], b = pr[i]; const f = (u - a.u) / Math.max(1e-9, b.u - a.u); return a.z + (b.z - a.z) * f;
  }
  return pr[pr.length - 1].z;
}
/** grösster Profilwert im Bereich u0..u1 */
export function profMax(pr: WallProfile, u0: number, u1: number): number {
  let z = Math.max(profAt(pr, u0, -Infinity), profAt(pr, u1, -Infinity));
  for (const q of pr) if (q.u > u0 && q.u < u1) z = Math.max(z, q.z);
  return z;
}

export interface WallBounds {
  /** Oberkanten-/Unterkantenprofil (fixiert), sonst null = waagrecht auf wi.z1 / wi.z0 */
  top: WallProfile | null; base: WallProfile | null;
  /** Hüllhöhen (absolut) – wi.z0/z1 bleiben die Nennhöhen der Abhängigkeiten */
  zMin: number; zMax: number;
}
/** Profile und Höhenbereich einer Wand (oben/unten fixiert) */
export function wallBounds(doc: Doc, w: Wall): WallBounds {
  return cached(doc, 'wallBounds', w.id, () => {
    const wi = wallInfo(doc, w);
    const get = (which: 'top' | 'base'): WallProfile | null => {
      for (const p of topProviders) { const r = p(w, doc, wi.c0, wi.c1, which === 'top' ? wi.z1 : wi.z0, which); if (r && r.length) return r; }
      return null;
    };
    const top = get('top'), base = get('base');
    const zMin = base ? Math.min(...base.map((q) => q.z)) : wi.z0;
    return { top, base, zMin, zMax: Math.max(top ? Math.max(...top.map((q) => q.z)) : wi.z1, zMin + 1) };
  });
}
/** Unter- und Oberkante der Wand an der Stelle u (entlang der Achse ab c0) */
export function wallZAt(doc: Doc, w: Wall, u: number): [number, number] {
  const wi = wallInfo(doc, w); const b = wallBounds(doc, w);
  const z0 = profAt(b.base, u, wi.z0);
  return [z0, Math.max(profAt(b.top, u, wi.z1), z0 + 1)];
}

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
  const cutWalls: { w: Wall; wi: WallInfo; shape: Poly; ring: Ring; clip?: MultiPoly }[] = [];
  const projPen = catPen(doc, 'wall', false), cutPen = catPen(doc, 'wall', true);
  for (const el of walls) {
    const w = el as Wall; const wi = wallInfo(doc, w);
    if (wi.L < 1) continue;
    const wb = wallBounds(doc, w);
    if (wb.top || wb.base) {
      // Ober-/Unterkante als Profil: nur die Bereiche schneiden, in denen die Schnittebene die Wand trifft
      const sh = wallShape(doc, w);
      const parts = profiledPlanParts(doc, w, wi, sh.ring, ctx.cutZ, ctx.depthZ);
      if (parts.cut.length) cutWalls.push({ w, wi, shape: [sh.ring], ring: sh.ring, clip: parts.all ? undefined : parts.cut });
      if (parts.below.length) { dl.begin(w.id); for (const p of parts.below) dl.poly(p[0], projPen, true); }
    } else if (wi.z0 <= ctx.cutZ && wi.z1 > ctx.cutZ) {
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
    const { w, wi, ring, clip } = cutWalls[i];
    dl.begin(w.id);
    // Basislinie (unsichtbar) für Fang an Wandenden/-achsen
    dl.line(w.a, w.b, { w: 1 }, { inv: true, sub: 'loc' });
    // Öffnungen abziehen
    const spans = wallOpenings(doc, w).filter((o) => o.cutsPlan !== false).map((o) => openingSpanAt(o, ctx.cutZ)).filter((x): x is [number, number] => !!x && x[1] - x[0] > 1);
    let body: MultiPoly = [[ring]];
    if (spans.length) body = difference([ring], ...spans.map(([a, b]) => [openingRect(wi, a, b)]));
    if (clip) body = intersection(body, clip);
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

/** Grundriss einer Wand mit Profil: geschnittene Teile (Unterkante ≤ Schnitt < Oberkante) und Teile unterhalb (Oberkante ≤ Schnitt) */
function profiledPlanParts(doc: Doc, w: Wall, wi: WallInfo, ring: Ring, cutZ: number, depthZ: number): { cut: MultiPoly; below: MultiPoly; all: boolean } {
  const b = wallBounds(doc, w);
  const us0 = ring.map((p) => dot(sub(p, wi.c0), wi.d));
  const lo = Math.min(...us0), hi = Math.max(...us0);
  const zb = (u: number) => profAt(b.base, u, wi.z0), zt = (u: number) => Math.max(profAt(b.top, u, wi.z1), zb(u) + 1);
  const cand = [...new Set([lo, hi, ...[...(b.base ?? []), ...(b.top ?? [])].map((q) => q.u).filter((u) => u > lo && u < hi)])].sort((x, y) => x - y);
  const us = new Set(cand);
  for (let i = 0; i + 1 < cand.length; i++) {
    const a = cand[i], c = cand[i + 1];
    for (const f of [zb, zt]) { const fa = f(a) - cutZ, fc = f(c) - cutZ; if (fa * fc < 0) us.add(a + (fa / (fa - fc)) * (c - a)); }
  }
  const ss = [...us].sort((x, y) => x - y);
  const cls = (u: number) => (zb(u) <= cutZ && zt(u) > cutZ ? 1 : zt(u) <= cutZ && zt(u) > depthZ - 1 ? 2 : 0);
  const iv: { a: number; b: number; k: number }[] = [];
  for (let i = 0; i + 1 < ss.length; i++) {
    if (ss[i + 1] - ss[i] < 0.01) continue;
    const k = cls((ss[i] + ss[i + 1]) / 2); const last = iv[iv.length - 1];
    if (last && last.k === k) last.b = ss[i + 1]; else iv.push({ a: ss[i], b: ss[i + 1], k });
  }
  const pick = (k: number): MultiPoly => {
    const bands = iv.filter((x) => x.k === k).map((x) => [uBand(wi, x.a === lo ? lo - wi.T * 10 : x.a, x.b === hi ? hi + wi.T * 10 : x.b)] as Poly);
    return bands.length ? intersection([ring], bands.length > 1 ? union(bands) : bands[0]) : [];
  };
  const all = iv.length === 1 && iv[0].k === 1;
  return { cut: all ? [[ring]] : pick(1), below: pick(2), all };
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
  const { top: profile, base } = wallBounds(doc, w);

  // Pro Schicht ein Körper (Schnitte zeigen Schichten); bei 1 Schicht nur einer
  const layers = t && t.layers.length > 1 ? layerOffsets(doc, w) : null;
  const zWrap = wrapTopZ(doc, w, z1);
  const wraps = t ? wrappedLayers(t) : [];
  const pieces: { ring: Ring; mat?: Id; z1: number }[] = [];
  if (layers) {
    layers.forEach(({ lay, o0, o1 }, i) => {
      if (lay.t < 0.5) return;
      // Schichtstreifen per Halbebenen-Clipping (robust auch bei schrägen Wänden)
      const p0 = add(wi.c0, mul(wi.n, o0)), p1 = add(wi.c0, mul(wi.n, o1));
      const r = clipRingHalfPlane(clipRingHalfPlane(ring, p0, wi.d), p1, mul(wi.d, -1));
      if (r.length >= 3 && Math.abs(signedArea(r)) > 1) pieces.push({ ring: r, mat: lay.mat, z1: wraps[i] && !profile ? zWrap : z1 });
    });
  } else pieces.push({ ring, mat: coreMat, z1 });

  return pieces.map((pc) => ({ faces: wallPieceFaces(wi, pc.ring, ops, z0, pc.z1, profile, base), mat: pc.mat }));
}

/** Welche Schichten über die Deckenstirn laufen (Schicht-Option oder Typvorgabe für Außenschichten) */
export function wrappedLayers(t: WallType): boolean[] {
  const coreIdx = t.layers.findIndex((l) => l.core);
  return t.layers.map((l, i) => (l.wrap !== undefined ? l.wrap : !!t.wrapExterior && !l.core && coreIdx >= 0 && i < coreIdx));
}

/** Oberkante durchgezogener Schichten: OK der oberen Ebene (negativer Versatz oben = Deckenstärke wird ignoriert) */
export function wrapTopZ(doc: Doc, w: Wall, z1: number): number {
  if (!w.topLevelId) return z1;
  return Math.max(z1, levelElev(doc, w.topLevelId));
}

const zHiBase = (pr: WallProfile) => Math.max(...pr.map((q) => q.z));
/** Streifen quer über die Wand zwischen u = ua und ub (für Profilflächen und Grundriss-Bereiche) */
function uBand(wi: WallInfo, ua: number, ub: number): Ring {
  const w = wi.T * 3 + 10;
  return [add(wi.c0, add(mul(wi.d, ua), mul(wi.n, -w))), add(wi.c0, add(mul(wi.d, ub), mul(wi.n, -w))), add(wi.c0, add(mul(wi.d, ub), mul(wi.n, w))), add(wi.c0, add(mul(wi.d, ua), mul(wi.n, w)))];
}

function wallPieceFaces(wi: WallInfo, ringIn: Ring, ops: HostOpening[], z0: number, z1: number, profile: WallProfile | null, base: WallProfile | null = null): Face[] {
  const ring = ensureCCW(ringIn);
  const faces: Face[] = [];
  if (profile && !profile.length) profile = null;
  if (base && !base.length) base = null;
  // Hüllhöhen (Öffnungen auf den Wandbereich begrenzen)
  const zLo = base ? Math.min(...base.map((q) => q.z)) : z0, zHi = profile ? Math.max(z1, ...profile.map((q) => q.z)) : z1;
  const opRects = ops.map((o) => ({ ...o, z0: Math.max(o.z0, base ? zLo : z0), z1: Math.min(o.z1, profile && base ? zHi : z1) })).filter((o) => o.z1 > o.z0 + 1 && o.u1 > o.u0 + 1);
  const uOf = (p: V2) => dot(sub(p, wi.c0), wi.d);
  const botAt = (u: number): number => profAt(base, u, z0);
  const topAt = (u: number): number => (base ? Math.max(profAt(profile, u, z1), botAt(u) + 1) : profAt(profile, u, z1));
  const at3 = (p: V2, z: number): V3 => ({ x: p.x, y: p.y, z });
  /** Draufsicht in Streifen zwischen den Profil- und Öffnungsstellen (Fläche je Streifen eben); cut: Öffnung durchstösst die Fläche */
  const strips = (pr: WallProfile, zf: (u: number) => number, up: boolean, cut: (o: HostOpening, ua: number, ub: number) => boolean) => {
    const us = [...new Set([...pr.map((p) => p.u), ...ring.map(uOf), ...opRects.flatMap((o) => (o.profile ? [] : [o.u0, o.u1]))])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < us.length; i++) {
      const ua = us[i], ub = us[i + 1]; if (ub - ua < 0.5) continue;
      let parts: MultiPoly = intersection([ring], [uBand(wi, ua, ub)]);
      const cuts = opRects.filter((o) => !o.profile && o.u0 <= ua + 0.5 && o.u1 >= ub - 0.5 && cut(o, ua, ub)).map((o) => [openingRect(wi, o.u0, o.u1)] as Poly);
      if (cuts.length && parts.length) parts = difference(parts, ...cuts);
      for (const p of parts) {
        const o = ensureCCW(p[0]); const hs = p.slice(1).map((h) => ensureCW(h));
        const L = (r: V2[]) => (up ? r : r.slice().reverse()).map((q) => at3(q, zf(uOf(q))));
        faces.push({ pts: L(o), holes: hs.length ? hs.map(L) : undefined });
      }
    }
  };

  // Boden (waagrecht oder Profil: unten fixiert, z.B. auf einer Rampe)
  if (!base) {
    const botCut = opRects.filter((o) => o.z0 <= z0 + 0.5).map((o) => [openingRect(wi, o.u0, o.u1)] as Poly);
    const bottom = botCut.length ? difference([ring], ...botCut) : [[ring]];
    for (const p of bottom) faces.push({ pts: p[0].slice().reverse().map((q) => at3(q, z0)), holes: p.slice(1).map((h) => h.slice().reverse().map((q) => at3(q, z0))) });
  } else strips(base, botAt, false, (o, ua, ub) => o.z0 <= Math.min(botAt(ua), botAt(ub)) + 0.5);

  // Decke (flach oder Profil)
  const flatTop = !profile && (!base || zHiBase(base) <= z1 - 1);
  if (flatTop) {
    const topCut = opRects.filter((o) => o.z1 >= z1 - 0.5).map((o) => [openingRect(wi, o.u0, o.u1)] as Poly);
    const top = topCut.length ? difference([ring], ...topCut) : [[ring]];
    for (const p of top) faces.push({ pts: p[0].map((q) => at3(q, z1)), holes: p.slice(1).map((h) => h.map((q) => at3(q, z1))) });
  } else strips(profile ?? [], topAt, true, (o, ua, ub) => o.z1 >= Math.max(topAt(ua), topAt(ub)) - 0.5);

  // Seitenflächen
  const prof = profile ?? [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const L = dist(p, q); if (L < 0.01) continue;
    const e = norm(sub(q, p));
    const parallel = Math.abs(cross(e, wi.d)) < 1e-3;
    // Fläche in (s, z)
    const s2p = (s: number) => add(p, mul(e, s));
    const stepsOf = (pr: WallProfile): number[] => {
      const st: number[] = [0, L];
      for (const pp of pr) { const s = dot(sub(add(wi.c0, mul(wi.d, pp.u)), p), e); if (s > 0 && s < L) st.push(s); }
      return st.sort((a, b) => a - b);
    };
    let outer: V2[];
    if (base) {
      outer = [...stepsOf(base).map((s) => ({ x: s, y: botAt(uOf(s2p(s))) })), ...stepsOf(prof).reverse().map((s) => ({ x: s, y: topAt(uOf(s2p(s))) }))];
    } else if (profile) {
      outer = [{ x: 0, y: z0 }, { x: L, y: z0 }, ...stepsOf(profile).reverse().map((s) => ({ x: s, y: topAt(uOf(s2p(s))) }))];
    } else outer = [{ x: 0, y: z0 }, { x: L, y: z0 }, { x: L, y: z1 }, { x: 0, y: z1 }];
    let polys: MultiPoly = [[outer]];
    if (parallel && opRects.length) {
      const sOf = (u: number) => dot(sub(add(wi.c0, mul(wi.d, u)), p), e);
      const zc = base ? (z: number) => Math.max(zLo, Math.min(zHi, z)) : (z: number) => Math.max(z0, Math.min(z1, z));
      const holes = opRects.map((o) => {
        if (o.profile && o.profile.length >= 3) return [o.profile.map((q) => ({ x: sOf(q.u), y: zc(q.z) }))] as Poly;
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
  /** Teilstücke u0..u1 an den Profilstellen (Brüstung/Sturz je Abschnitt) */
  const pieces = (pr: WallProfile | null, u0: number, u1: number): [number, number][] => {
    const us = [u0, ...(pr ?? []).map((q) => q.u).filter((u) => u > u0 + 0.5 && u < u1 - 0.5), u1];
    return us.slice(1).map((u, i) => [us[i], u] as [number, number]);
  };
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
    if (!base && !profile) {
      faces.push({ pts: [R(o.u0, o.z0), Lp(o.u0, o.z0), Lp(o.u0, o.z1), R(o.u0, o.z1)] });
      faces.push({ pts: [Lp(o.u1, o.z0), R(o.u1, o.z0), R(o.u1, o.z1), Lp(o.u1, o.z1)] });
    } else {
      // Ober-/Unterkante als Profil: Leibungen zwischen Unter- und Oberkante an dieser Stelle begrenzen
      const jamb = (u: number, rev: boolean) => {
        const zl = Math.max(o.z0, botAt(u)), zh = Math.min(o.z1, topAt(u)); if (zh - zl < 0.5) return;
        faces.push({ pts: rev ? [Lp(u, zl), R(u, zl), R(u, zh), Lp(u, zh)] : [R(u, zl), Lp(u, zl), Lp(u, zh), R(u, zh)] });
      };
      jamb(o.u0, false); jamb(o.u1, true);
    }
    // Brüstung (je Abschnitt der Unterkante)
    if (!base) { if (o.z0 > z0 + 0.5) faces.push({ pts: [R(o.u0, o.z0), R(o.u1, o.z0), Lp(o.u1, o.z0), Lp(o.u0, o.z0)] }); }
    else for (const [ua, ub] of pieces(base, o.u0, o.u1)) if (o.z0 > Math.min(botAt(ua), botAt(ub)) + 0.5) faces.push({ pts: [R(ua, o.z0), R(ub, o.z0), Lp(ub, o.z0), Lp(ua, o.z0)] });
    if (flatTop) { if (o.z1 < z1 - 0.5) faces.push({ pts: [Lp(o.u0, o.z1), Lp(o.u1, o.z1), R(o.u1, o.z1), R(o.u0, o.z1)] }); }
    else for (const [ua, ub] of pieces(profile, o.u0, o.u1)) if (o.z1 < Math.max(topAt(ua), topAt(ub)) - 0.5) faces.push({ pts: [Lp(ua, o.z1), Lp(ub, o.z1), R(ub, o.z1), R(ua, o.z1)] });
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
  const wb = wallBounds(doc, w);
  if (wb.top || wb.base) return profiledWallArea(doc, w, wi, wb);
  let a = wi.L * (wi.z1 - wi.z0);
  for (const o of wallOpenings(doc, w)) {
    if (o.profile && o.profile.length >= 3) a -= Math.abs(signedArea(o.profile.map((q) => ({ x: q.u, y: Math.max(wi.z0, Math.min(wi.z1, q.z)) }))));
    else a -= (o.u1 - o.u0) * (Math.min(o.z1, wi.z1) - Math.max(o.z0, wi.z0));
  }
  return Math.max(0, a);
}

/** Wandfläche mit Profil: ∫ (Oberkante − Unterkante) du über die Achslänge, abzüglich Öffnungen im Wandbereich */
function profiledWallArea(doc: Doc, w: Wall, wi: WallInfo, wb: WallBounds): number {
  const zb = (u: number) => profAt(wb.base, u, wi.z0), zt = (u: number) => Math.max(profAt(wb.top, u, wi.z1), zb(u));
  const ops = wallOpenings(doc, w);
  const us = [...new Set([0, wi.L, ...[...(wb.base ?? []), ...(wb.top ?? [])].map((q) => q.u), ...ops.flatMap((o) => [o.u0, o.u1])]
    .filter((u) => u >= 0 && u <= wi.L))].sort((x, y) => x - y);
  const integ = (f: (u: number) => number, u0: number, u1: number) => {
    let a = 0;
    for (let i = 0; i + 1 < us.length; i++) {
      const ua = Math.max(u0, us[i]), ub = Math.min(u1, us[i + 1]); if (ub - ua < 1e-6) continue;
      a += ((f(ua) + f(ub)) / 2) * (ub - ua);
    }
    return a;
  };
  let a = integ((u) => zt(u) - zb(u), 0, wi.L);
  for (const o of ops) {
    if (o.profile && o.profile.length >= 3) a -= Math.abs(signedArea(o.profile.map((q) => ({ x: q.u, y: Math.max(zb(q.u), Math.min(zt(q.u), q.z)) }))));
    else a -= integ((u) => Math.max(0, Math.min(o.z1, zt(u)) - Math.max(o.z0, zb(u))), o.u0, o.u1);
  }
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
    { key: 'wrapExterior', label: 'Außenschichten über Deckenstirn durchziehen', group: g.construction, type: 'bool', get: (t) => !!t.wrapExterior, set: (_t, v) => ({ wrapExterior: v }) },
    { key: 'function', label: 'Funktion', group: g.construction, type: 'select', options: [['exterior', 'Außen'], ['interior', 'Innen'], ['foundation', 'Fundament'], ['retaining', 'Stützmauer']], get: (t) => t.function ?? 'exterior', set: (_t, v) => ({ function: v }) },
    { key: 'coarsePattern', label: 'Füllmuster grobe Darstellung', group: g.graphics, type: 'select', options: () => [['', '<Material>'], ...patternOptions().slice(1)], get: (t) => t.coarsePattern ?? '', set: (_t, v) => ({ coarsePattern: v || undefined }) },
    { key: 'coarseColor', label: 'Füllfarbe grobe Darstellung', group: g.graphics, type: 'color', get: (t) => t.coarseColor ?? '#808080', set: (_t, v) => ({ coarseColor: v }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

export function isWall(e: El | undefined): e is Wall { return !!e && e.cat === 'wall'; }
export { levels };
export type { DisplayList };
