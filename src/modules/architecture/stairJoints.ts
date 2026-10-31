// Treppenlager: Anschlussdetails von Massivtreppen – Schalldämmlager am Antritt, Z-Lager (Konsole,
// Auflagernase, Elastomer-Z-Profil) und Querkraftdorne an Decke und Podest, Podest auf Wandkonsole
// oder mit Dornen an der Wand, Fugenplatten Lauf/Podest–Wand (Trittschall). Liefert die angepassten
// Laufprofile, Podeste und Konsolen für stairSolids() und die Lagerteile als gehostete Elemente
// 'stairBearing' (Grundriss, Schnitt, 3D, Bauteilliste, Beschriftung, IFC).
//
// Lokales System je Laufende: u entlang des Laufs, z absolut; w = ±(u − uJ) misst von der Auflagerfläche
// (uJ) in Richtung Treppe negativ. Z-Lager: Auflager mit Konsole w ∈ [−c, 0] unten, Treppe mit Nase oben,
// dazwischen Elastomer (Dicke tp) und Fugen (Breite g). Bei Podesten wird die Auflagerfläche um c ins
// Podest zurückgesetzt (Ausklinkung), bei Decken liegt sie an der Deckenstirn.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, V3, add, sub, mul, dot, cross, norm, perp, dist, bboxOf, centroid, signedArea, add3, mul3, sub3, cross3, len3, norm3,
  MultiPoly, union, difference, intersection, pointInPoly,
} from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, onHook, GROUPS, PropDef, PlanCtx, Solid, Face } from '../../core/registry';
import { levelElev, typeOf, Material } from '../../core/view';
import { cached, hostedBy } from '../../core/cache';
import { fmtLen, fmtNum } from '../../core/units';
import { extrudeProfile, prism, catPen } from '../../views/sectionEngine';
import { OBJECT_STYLES } from '../../render/styles';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { wallInfo, Wall } from '../../elements/wall';
import { stairGeom, stairType, runProfileBase, RP, StairGeom, Run } from './stair';
import { floorTop, floorThick } from './floor';
import { identityProps, levelName, loopsArea, thickOf, registerCutouts } from './common';

export type JointEnd = 'mono' | 'z' | 'dowel';
export type JointKind = 'zBearing' | 'pad' | 'dowel' | 'plate';
export interface BearingPart {
  key: string; kind: JointKind;
  /** Lage: Antritt, Austritt, Lauf/Podest, Podest/Lauf, Lauf/Wand, Podest/Wand */
  loc: string;
  solids: Solid[];
  /** Grundrissumriss (Welt) */
  ring: V2[];
  /** Dornachsen (Welt) */
  axes: [V2, V2][];
  /** Länge entlang der Fuge, Stückzahl, Dicke bzw. Durchmesser [mm] */
  len: number; count: number; thick: number;
  z0: number; z1: number;
  /** Feld der Treppe mit dem Produktnamen */
  prodKey: 'prodZ' | 'prodPad' | 'prodDowel' | 'prodPlate';
}
export interface StairJoints {
  /** Laufprofile (u, z) nach Ausklinkungen; null = unverändert */
  profiles: (V2[][] | null)[];
  /** Seiteneinzug je Lauf wegen Fugen zur Wand: [Seite v = −w/2, Seite v = +w/2] */
  insets: [number, number][];
  /** Podest-Grundriss (lokal) nach Fugen und Ausklinkungen; null = unverändert */
  landings: (MultiPoly | null)[];
  /** Konsolen (Beton) an Decken, Podesten und Wänden */
  concrete: Solid[];
  parts: BearingPart[];
  /** Ausklinkung der Decke am Austritt (Welt), ausgespart aus der Geschossdecke slabId */
  slabCuts: { slabId: Id; ring: V2[] }[];
  /** Austrittsstufe in der Decke (Grundriss, Welt) auf Höhe z */
  planExt: { ring: V2[]; z: number }[];
}

export const JOINT_DEFAULTS = {
  jBot: 'mono', jTop: 'mono', jLand: 'mono', jLandWall: 'mono', wallPlate: false,
  jGap: 10, padT: 15, consoleC: 120, dowelN: 2, dowelDia: 20,
  prodZ: 'Elastomer-Z-Lager', prodPad: 'Elastomerlager (Trittschall)', prodDowel: 'Querkraftdorn mit Gleithülse', prodPlate: 'Fugenplatte (Trittschall)',
};
export const KIND_LABEL: Record<JointKind, string> = { zBearing: 'Z-Lager', pad: 'Schalldämmlager', dowel: 'Querkraftdorne', plate: 'Fugenplatte' };
const MAT: Record<JointKind, Id> = { zBearing: 'm_elastomer', pad: 'm_elastomer', dowel: 'm_stahl', plate: 'm_fugenplatte' };
const PROD: Record<JointKind, BearingPart['prodKey']> = { zBearing: 'prodZ', pad: 'prodPad', dowel: 'prodDowel', plate: 'prodPlate' };

function jp(s: El) {
  const d = JOINT_DEFAULTS;
  return {
    jBot: (s.jBot ?? d.jBot) as 'mono' | 'pad', jTop: (s.jTop ?? d.jTop) as JointEnd, jLand: (s.jLand ?? d.jLand) as JointEnd,
    jLandWall: (s.jLandWall ?? d.jLandWall) as 'mono' | 'console' | 'dowel', wallPlate: !!(s.wallPlate ?? d.wallPlate),
    g: Math.max(2, s.jGap ?? d.jGap), tp: Math.max(3, s.padT ?? d.padT), c: Math.max(40, s.consoleC ?? d.consoleC),
    nD: Math.max(1, Math.round(s.dowelN ?? d.dowelN)), dD: Math.max(6, s.dowelDia ?? d.dowelDia),
  };
}
/** Hat die Treppe Lagerdetails (sonst monolithisch)? */
export function hasStairJoints(s: El): boolean {
  const p = jp(s);
  return p.jBot !== 'mono' || p.jTop !== 'mono' || p.jLand !== 'mono' || p.jLandWall !== 'mono' || p.wallPlate;
}

const BIG = 1e5;
const rect = (u0: number, u1: number, z0: number, z1: number): V2[] => {
  const a = Math.min(u0, u1), b = Math.max(u0, u1), c = Math.min(z0, z1), d = Math.max(z0, z1);
  return [{ x: a, y: c }, { x: b, y: c }, { x: b, y: d }, { x: a, y: d }];
};
const ringsOf = (mp: MultiPoly): V2[][] => mp.map((p) => p[0]).filter((r) => r && r.length >= 3 && Math.abs(signedArea(r)) > 1);
const zRange = (solids: Solid[]): [number, number] => {
  let a = Infinity, b = -Infinity;
  for (const s of solids) for (const f of s.faces) for (const p of f.pts) { if (p.z < a) a = p.z; if (p.z > b) b = p.z; }
  return [a, b];
};
/** Rundstab (Achteck) von a nach b */
function rod(a: V3, b: V3, r: number, n = 8): Face[] {
  const L = len3(sub3(b, a)); if (L < 1) return [];
  const d = mul3(sub3(b, a), 1 / L);
  const e1 = norm3(cross3(d, Math.abs(d.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 })); const e2 = cross3(d, e1);
  const ring = (o: V3) => Array.from({ length: n }, (_, k) => { const t = (2 * Math.PI * k) / n; return add3(o, add3(mul3(e1, r * Math.cos(t)), mul3(e2, r * Math.sin(t)))); });
  const A = ring(a), B = ring(b);
  const faces: Face[] = [{ pts: A.slice().reverse() }, { pts: B }];
  for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; faces.push({ pts: [A[k], A[k2], B[k2], B[k]] }); }
  return faces;
}

/** Wand, deren Fläche parallel vor der Kante a–b (Aussennormale o) liegt: Abstand dd (positiv = Luft) */
function wallNear(doc: Doc, a: V2, b: V2, o: V2, z0: number, z1: number): { dd: number } | null {
  const L = dist(a, b); if (L < 1) return null;
  const d = norm(sub(b, a)); const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let best: { dd: number } | null = null;
  for (const w of doc.all<Wall>('wall')) {
    const wi = wallInfo(doc, w);
    if (wi.L < 1 || !(wi.z0 < z1 - 1 && wi.z1 > z0 + 1) || Math.abs(cross(d, wi.d)) > 0.03) continue;
    for (const f of [1, -1]) {
      const fn = mul(wi.n, f);
      if (dot(fn, o) > -0.95) continue;
      const dd = dot(sub(add(wi.c0, mul(fn, wi.T / 2)), m), o);
      if (dd < -wi.T + 1 || dd > 60) continue;
      const t0 = dot(sub(a, wi.c0), wi.d), t1 = dot(sub(b, wi.c0), wi.d);
      if (Math.min(Math.max(t0, t1), wi.L) - Math.max(Math.min(t0, t1), 0) < 0.5 * L) continue;
      if (!best || Math.abs(dd) < Math.abs(best.dd)) best = { dd };
    }
  }
  return best;
}

/** Decke/Bodenplatte am Austritt: Oberkante ±400 mm um zTop, Stirn entlang der Lauflinie hinter der letzten Steigung.
 *  Umriss ohne Aussparungen (floorArea fragt seinerseits die Ausklinkungen der Treppen ab). */
function slabAtTop(doc: Doc, g: StairGeom, run: Run, zTop: number): { zB: number; uFace: number; slabId: Id | null } {
  const slabs: { id: Id | null; area: MultiPoly; top: number; t: number }[] = [];
  for (const f of doc.all('floor')) { const top = floorTop(doc, f); if (Math.abs(top - zTop) <= 400) slabs.push({ id: f.id, area: loopsArea(f.loops), top, t: floorThick(doc, f) }); }
  for (const f of doc.all('foundationSlab')) {
    const top = levelElev(doc, f.levelId) + (f.offset ?? 0); if (Math.abs(top - zTop) > 400) continue;
    const ty: any = typeOf(doc, f); slabs.push({ id: null, area: loopsArea(f.loops), top, t: ty?.t ?? thickOf(ty, 300) });
  }
  const inside = (u: number) => { const p = g.W(RP(run, u, 0)); return slabs.find((s) => s.area.some((poly) => pointInPoly(p, poly))); };
  const L = run.L;
  const s0 = inside(L - 60); if (s0) return { zB: s0.top - s0.t, uFace: L, slabId: s0.id };
  let prev = L - 60;
  for (const u of [L + 5, L + 60, L + 150, L + 300, L + 600]) {
    const s = inside(u);
    if (s) {
      let a = prev, b = u;
      for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (inside(m)) b = m; else a = m; }
      return { zB: s.top - s.t, uFace: Math.max(L, Math.round(b)), slabId: s.id };
    }
    prev = u;
  }
  return { zB: zTop - 240, uFace: L, slabId: null };
}

function calcJoints(doc: Doc, s: El): StairJoints {
  const g = stairGeom(doc, s); const t = stairType(doc, s);
  const out: StairJoints = {
    profiles: g.runs.map(() => null), insets: g.runs.map(() => [0, 0] as [number, number]), landings: g.landings.map(() => null),
    concrete: [], parts: [], slabCuts: [], planExt: [],
  };
  if ((t?.construction ?? 'massiv') !== 'massiv' || !hasStairJoints(s)) return out;
  const P = jp(s); const e = t?.waist ?? 160; const lt = t?.landingThick ?? 200; const mat = t?.mat ?? 'm_stb';
  const slope = g.r / g.t; const cc = Math.sqrt(1 + slope * slope);
  const nR = g.runs.length;
  const up: V3 = { x: 0, y: 0, z: 1 };
  const to3 = (v: V2, z = 0): V3 => ({ x: v.x, y: v.y, z });
  const rebates: V2[][][] = g.landings.map(() => []);
  const part = (key: string, kind: JointKind, loc: string, solids: Solid[], ring: V2[], len: number, thick: number, count = 1, axes: [V2, V2][] = []) => {
    const [z0, z1] = zRange(solids);
    out.parts.push({ key, kind, loc, solids, ring, axes, len, count, thick, z0, z1, prodKey: PROD[kind] });
  };
  /** Profil (u, z) eines Laufs über v ∈ [v0, v1] extrudieren */
  const extr = (run: Run, prof: V2[], v0: number, v1: number, m: Id): Solid => ({
    faces: extrudeProfile(prof, to3(g.W(RP(run, 0, v0))), to3(g.WV(run.d)), up, to3(g.WV(perp(run.d))), v1 - v0), mat: m,
  });
  const planRect = (run: Run, u0: number, u1: number, v0: number, v1: number): V2[] =>
    [RP(run, u0, v0), RP(run, u1, v0), RP(run, u1, v1), RP(run, u0, v1)].map(g.W);
  const uSpan = (rs: V2[][]): [number, number] => { const b = bboxOf(rs.flat()); return [b.min.x, b.max.x]; };

  // 1) Fugen Lauf–Wand: Lauf schmaler, Fugenplatte bis zur Wandfläche
  const sidePlates: { i: number; side: -1 | 1; e0: number; e1: number }[] = [];
  if (P.wallPlate) g.runs.forEach((run, i) => {
    if (run.m < 2 || run.L < 1) return;
    for (const side of [-1, 1] as const) {
      const v = (side * g.w) / 2;
      const hit = wallNear(doc, g.W(RP(run, 0, v)), g.W(RP(run, run.L, v)), norm(g.WV(mul(perp(run.d), side))), run.z, run.z + run.m * g.r);
      if (!hit) continue;
      const gp = Math.max(P.g, hit.dd);
      out.insets[i][side < 0 ? 0 : 1] = Math.max(0, P.g - hit.dd);
      sidePlates.push({ i, side, e0: g.w / 2 + hit.dd - gp, e1: g.w / 2 + hit.dd });
    }
  });

  // 2) Laufenden: Antritt, Austritt, Lauf/Podest
  g.runs.forEach((run, i) => {
    if (run.m < 2) return;
    const base = runProfileBase(doc, s, g, i); if (!base) return;
    const [ia, ib] = out.insets[i]; const vA = -g.w / 2 + ia, vB = g.w / 2 - ib;
    const adds: V2[][] = []; const cuts: V2[][] = [];
    const pend: { key: string; kind: JointKind; loc: string; poly: V2[] }[] = [];
    const dowels: { key: string; loc: string; u0: number; u1: number; z: number }[] = [];
    const zRun = run.z + run.m * g.r;
    const ends: { top: boolean; kind: JointEnd; zTop: number; zB: number; uFace: number; landing: number | null; loc: string }[] = [];
    // Der Lauf greift um die Konsolentiefe in Podest bzw. Decke (Stufe auf deren Höhe); beim Z-Lager folgt die Konsole.
    // Podeste werden dort ausgespart, die Decke über registerCutouts (Ausklinkung über die Laufbreite).
    const dE = (k: JointEnd) => (k === 'z' ? 2 * P.c : P.c);
    if (i === nR - 1 && P.jTop !== 'mono') {
      const sl = slabAtTop(doc, g, run, zRun); const uF = Math.max(sl.uFace, run.L + dE(P.jTop));
      ends.push({ top: true, kind: P.jTop, zTop: zRun, zB: sl.zB, uFace: uF, landing: null, loc: 'Austritt' });
      if (sl.slabId && uF > sl.uFace + 0.5) out.slabCuts.push({ slabId: sl.slabId, ring: planRect(run, sl.uFace, uF, -g.w / 2, g.w / 2) });
      out.planExt.push({ ring: planRect(run, run.L, uF - P.g, -g.w / 2 + ia, g.w / 2 - ib), z: zRun });
    }
    if (i < nR - 1 && P.jLand !== 'mono' && g.landings[i]) ends.push({ top: true, kind: P.jLand, zTop: zRun, zB: zRun - lt, uFace: run.L + dE(P.jLand), landing: i, loc: 'Lauf/Podest' });
    if (i > 0 && P.jLand !== 'mono' && g.landings[i - 1]) ends.push({ top: false, kind: P.jLand, zTop: run.z, zB: run.z - lt, uFace: -dE(P.jLand), landing: i - 1, loc: 'Podest/Lauf' });
    for (const E of ends) {
      const sg = E.top ? 1 : -1; const uEdge = E.top ? run.L : 0; const uJ = E.uFace;
      const U = (w: number) => uJ + sg * w;
      const R = (w0: number, w1: number, z0: number, z1: number) => rect(U(w0), U(w1), z0, z1);
      const ext = Math.max(0, sg * (uJ - uEdge));
      const { c, g: gp, tp } = P; const { zTop, zB } = E;
      const key = `r${i}${E.top ? 't' : 'b'}`;
      let zc = 0, zCb = zB;
      if (E.kind === 'z') {
        // Konsole in halber Auflagerhöhe; liegt die Nase unter der letzten Stufe (Decke ohne Ausklinkung),
        // braucht sie mindestens 80 mm – die Konsole (≥ 150 mm hoch) reicht dann unter die Decke
        const noseTop = !E.top || ext >= c + gp - 1 ? zTop : zTop - g.r;
        const mid = (zB + zTop) / 2, max = noseTop - 80 - tp;
        if (mid <= max) zc = Math.round(mid);
        else { zc = Math.round(max); zCb = Math.min(zB, zc - 150); }
      }
      // Verlängerung bis zur Auflagerfläche und Endverstärkung bis Unterkante Auflager
      if (ext > 0.5) adds.push(R(-ext, 0, zCb, zTop));
      const bl = Math.max(60, Math.min(E.kind === 'z' ? c + gp + 150 : 300, (0.95 * e * cc) / slope));
      const soff = (u: number) => run.z + slope * u - e * cc;
      const zs = E.top ? soff(uEdge) : soff(uEdge + bl);
      if (zs > zCb + 1) adds.push(rect(uEdge, uEdge - sg * bl, zCb, zs));
      cuts.push(R(-gp, BIG, -BIG, BIG));
      if (E.kind === 'z') {
        cuts.push(R(-c - gp, BIG, -BIG, zc + tp));
        out.concrete.push(extr(run, R(-c, 0, zCb, zc), -g.w / 2, g.w / 2, mat));
        pend.push({ key, kind: 'zBearing', loc: E.loc, poly: [
          { x: U(-gp), y: zTop }, { x: U(0), y: zTop }, { x: U(0), y: zc }, { x: U(-c), y: zc }, { x: U(-c), y: zCb },
          { x: U(-c - gp), y: zCb }, { x: U(-c - gp), y: zc + tp }, { x: U(-gp), y: zc + tp },
        ] });
      } else {
        pend.push({ key, kind: 'plate', loc: E.loc, poly: R(-gp, 0, -BIG, BIG) });
        const zHi = E.top && ext < 1 ? zTop - g.r : zTop;
        dowels.push({ key: key + 'd', loc: E.loc, u0: U(-gp - 200), u1: U(200), z: Math.round((zB + zHi) / 2) });
      }
      // Podest: Bereich des Laufendes (und der Konsole) aussparen
      if (E.landing !== null) rebates[E.landing].push([RP(run, uEdge, -g.w / 2), RP(run, uJ, -g.w / 2), RP(run, uJ, g.w / 2), RP(run, uEdge, g.w / 2)]);
    }
    if (i === 0 && P.jBot === 'pad') {
      cuts.push(rect(-BIG, BIG, -BIG, run.z + P.tp));
      pend.push({ key: 'bot', kind: 'pad', loc: 'Antritt', poly: rect(-BIG, BIG, run.z, run.z + P.tp) });
    }
    if (!adds.length && !cuts.length) return;
    const env = union([[base], ...adds.map((a) => [a])]);
    const prof = ringsOf(cuts.length ? difference(env, ...cuts.map((c) => [c])) : env);
    if (prof.length) out.profiles[i] = prof;
    for (const p of pend) {
      const rs = ringsOf(intersection(env, [p.poly])); if (!rs.length) continue;
      const [u0, u1] = uSpan(rs);
      part(p.key, p.kind, p.loc, rs.map((r) => extr(run, r, vA, vB, MAT[p.kind])), planRect(run, u0, u1, vA, vB), vB - vA, p.kind === 'plate' ? P.g : P.tp);
    }
    for (const d of dowels) {
      const faces: Face[] = []; const axes: [V2, V2][] = [];
      for (let k = 0; k < P.nD; k++) {
        const v = vA + ((vB - vA) * (k + 0.5)) / P.nD;
        const a = g.W(RP(run, d.u0, v)), b = g.W(RP(run, d.u1, v));
        faces.push(...rod(to3(a, d.z), to3(b, d.z), P.dD / 2)); axes.push([a, b]);
      }
      part(d.key, 'dowel', d.loc, [{ faces, mat: MAT.dowel }], planRect(run, d.u0, d.u1, vA, vB), Math.abs(d.u1 - d.u0), P.dD, P.nD, axes);
    }
  });

  // 3) Fugenplatten entlang der Läufe (nach den Ausklinkungen)
  for (const sp of sidePlates) {
    const run = g.runs[sp.i]; const rs = out.profiles[sp.i] ?? [runProfileBase(doc, s, g, sp.i)!];
    const v0 = sp.side * sp.e0, v1 = sp.side * sp.e1; const [u0, u1] = uSpan(rs);
    part(`r${sp.i}s${sp.side < 0 ? 'r' : 'l'}`, 'plate', 'Lauf/Wand', rs.map((r) => extr(run, r, Math.min(v0, v1), Math.max(v0, v1), MAT.plate)),
      planRect(run, u0, u1, Math.min(v0, v1), Math.max(v0, v1)), u1 - u0, sp.e1 - sp.e0);
  }

  // 4) Podeste: Fugen und Lager zur Wand, Ausklinkungen der Z-Lager
  g.landings.forEach((l, k) => {
    const bb = bboxOf(l.ring); const zL = l.z;
    const x0 = bb.min.x, x1 = bb.max.x, y0 = bb.min.y, y1 = bb.max.y;
    const edges = [
      { a: { x: x0, y: y0 }, b: { x: x1, y: y0 }, o: { x: 0, y: -1 } }, { a: { x: x1, y: y0 }, b: { x: x1, y: y1 }, o: { x: 1, y: 0 } },
      { a: { x: x1, y: y1 }, b: { x: x0, y: y1 }, o: { x: 0, y: 1 } }, { a: { x: x0, y: y1 }, b: { x: x0, y: y0 }, o: { x: -1, y: 0 } },
    ];
    const ins = [0, 0, 0, 0];
    if (P.wallPlate || P.jLandWall !== 'mono') edges.forEach((ed, j) => {
      const hit = wallNear(doc, g.W(ed.a), g.W(ed.b), norm(g.WV(ed.o)), zL - lt, zL); if (!hit) return;
      const Ln = dist(ed.a, ed.b); const td = norm(sub(ed.b, ed.a)); const hf = hit.dd;
      const gp = Math.max(P.g, hf); ins[j] = Math.max(0, P.g - hf);
      const E = (tt: number, h: number): V2 => add(add(ed.a, mul(td, tt)), mul(ed.o, h));
      const strip = (h0: number, h1: number, t0 = 0, t1 = Ln): V2[] => [E(t0, h0), E(t1, h0), E(t1, h1), E(t0, h1)].map(g.W);
      const key = `l${k}e${j}`;
      const cons = P.jLandWall === 'console';
      const zPl = cons ? zL - lt - P.tp : zL - lt;
      part(key, 'plate', 'Podest/Wand', [{ faces: prism(strip(hf - gp, hf), zPl, zL), mat: MAT.plate }], strip(hf - gp, hf), Ln, gp);
      if (cons) {
        const hc = Math.max(150, lt);
        out.concrete.push({ faces: prism(strip(hf - P.c, hf), zPl - hc, zPl), mat });
        part(key + 'p', 'pad', 'Podest/Wand', [{ faces: prism(strip(hf - P.c, hf - gp), zPl, zL - lt), mat: MAT.pad }], strip(hf - P.c, hf - gp), Ln, P.tp);
      } else if (P.jLandWall === 'dowel') {
        const faces: Face[] = []; const axes: [V2, V2][] = []; const zd = zL - lt / 2;
        for (let q = 0; q < P.nD; q++) {
          const tt = (Ln * (q + 0.5)) / P.nD; const a = g.W(E(tt, -ins[j] - 200)), b = g.W(E(tt, hf + 200));
          faces.push(...rod(to3(a, zd), to3(b, zd), P.dD / 2)); axes.push([a, b]);
        }
        part(key + 'd', 'dowel', 'Podest/Wand', [{ faces, mat: MAT.dowel }], strip(-ins[j] - 200, hf + 200, Ln * 0.5 / P.nD - 30, Ln * (1 - 0.5 / P.nD) + 30), hf + ins[j] + 400, P.dD, P.nD, axes);
      }
    });
    if (!ins.some((v) => v > 0) && !rebates[k].length) return;
    const r: V2[] = [{ x: x0 + ins[3], y: y0 + ins[0] }, { x: x1 - ins[1], y: y0 + ins[0] }, { x: x1 - ins[1], y: y1 - ins[2] }, { x: x0 + ins[3], y: y1 - ins[2] }];
    out.landings[k] = rebates[k].length ? difference([r], ...rebates[k].map((q) => [q])) : [[r]];
  });
  return out;
}

/** Lagerdetails einer Treppe (gecacht) */
export function stairJoints(doc: Doc, s: El): StairJoints {
  return s.id ? cached(doc, 'archStairJoints', s.id, () => calcJoints(doc, s)) : calcJoints(doc, s);
}

// ------------------------------------------------------------ Lager-Elemente (gehostet)
const bearingsOf = (doc: Doc, s: El) => hostedBy(doc, s.id).filter((e) => e.cat === 'stairBearing');

// Ausklinkung der Geschossdecke am Austritt (Lauf mit Austrittsstufe und Konsole übernimmt den Bereich)
registerCutouts((doc, hostId) => {
  const out: V2[][][] = [];
  for (const s of doc.all('stair')) {
    if ((s.jTop ?? 'mono') === 'mono') continue;
    for (const c of stairJoints(doc, s).slabCuts) if (c.slabId === hostId) out.push([c.ring]);
  }
  return out;
});

/** Stimmen die Lager-Elemente mit den Lagerdetails der Treppe überein? */
export function stairBearingsInSync(doc: Doc, s: El): boolean {
  const want = new Set(stairJoints(doc, s).parts.map((p) => p.key)); const have = bearingsOf(doc, s);
  return have.length === want.size && have.every((e) => want.has(e.key));
}
/** Lager-Elemente anlegen bzw. entfernen (in einer Transaktion aufrufen) */
export function syncStairBearings(doc: Doc, s: El): void {
  if (!s?.id || s.cat !== 'stair') return;
  const parts = stairJoints(doc, s).parts; const want = new Map(parts.map((p) => [p.key, p]));
  const seen = new Set<string>();
  for (const e of bearingsOf(doc, s)) {
    const p = want.get(e.key);
    if (!p || seen.has(e.key)) { doc.remove(e.id); continue; }
    seen.add(e.key);
    if (e.kind !== p.kind || e.levelId !== s.levelId) doc.update(e.id, { kind: p.kind, levelId: s.levelId });
  }
  for (const p of parts) if (!seen.has(p.key)) doc.add({ id: newId('sb'), cat: 'stairBearing', hostId: s.id, key: p.key, kind: p.kind, levelId: s.levelId } as El);
}
/** Eigenschaft der Treppe setzen und Lager nachführen (für Eigenschaften-Setter) */
export function withBearingSync(props: PropDef[]): PropDef[] {
  return props.map((p) => (!p.set ? p : {
    ...p,
    set: (el: El, v: any, doc: Doc) => {
      const patch = p.set!(el, v, doc);
      if (patch && el.id && doc.has(el.id)) { doc.update(el.id, patch); syncStairBearings(doc, doc.get(el.id)!); }
      return patch;
    },
  }));
}

const partOf = (doc: Doc, el: El): BearingPart | null => {
  const h = el.hostId ? doc.get(el.hostId) : undefined; if (!h || h.cat !== 'stair') return null;
  return stairJoints(doc, h).parts.find((p) => p.key === el.key) ?? null;
};
export const bearingProduct = (doc: Doc, el: El): string => {
  const p = partOf(doc, el); const h = doc.get(el.hostId);
  const k = p?.prodKey ?? PROD[(el.kind as JointKind) ?? 'pad'];
  return el.product || h?.[k] || (JOINT_DEFAULTS as any)[k] || '';
};
export function bearingText(doc: Doc, el: El): string {
  const p = partOf(doc, el); if (!p) return '';
  const prod = bearingProduct(doc, el);
  const mark = el.mark ? el.mark + ' ' : '';
  if (p.kind === 'dowel') return `${mark}${p.count} ${KIND_LABEL.dowel} Ø${fmtNum(p.thick, 0)} (${prod})`;
  const t = p.kind === 'plate' ? `d = ${fmtNum(p.thick, 0)} mm` : `t = ${fmtNum(p.thick, 0)} mm`;
  return `${mark}${KIND_LABEL[p.kind]} ${prod}, l = ${fmtLen(p.len)}, ${t}`;
}

function drawBearingPlan(ctx: PlanCtx, el: El): void {
  if (ctx.ceiling) return;
  const p = partOf(ctx.doc, el); if (!p) return;
  if (!(p.z0 < ctx.cutZ + 1 && p.z1 > ctx.depthZ - 1)) {
    // oberhalb der Schnittebene: nur in dem Grundriss, in dem die Treppe beginnt (wie ihr verdeckter oberer Teil)
    const g = stairGeom(ctx.doc, ctx.doc.get(el.hostId)!);
    if (!(g.z0 <= ctx.cutZ + 1 && g.z1 > ctx.cutZ && g.z0 >= ctx.depthZ - 1)) return;
  }
  const base = catPen(ctx.doc, 'stairBearing', false);
  const hid: Pen = { ...base, dash: 'hidden' };
  const { dl } = ctx;
  dl.fill([p.ring], { color: 'transparent' }, undefined, { ns: true });
  if (p.kind === 'dowel') { for (const [a, b] of p.axes) dl.line(a, b, { ...hid, w: Math.max(2, base.w) }); }
  else dl.poly(p.ring, p.kind === 'plate' ? base : hid, true);
  if (ctx.detail === 'fine' && p.kind !== 'plate') {
    const b = bboxOf(p.ring); const sc = ctx.view.scale;
    dl.text({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 + 1.2 * sc }, KIND_LABEL[p.kind], { size: 1.8, ha: 'center', va: 'middle', color: base.color });
  }
}

function bearingProps(): PropDef[] {
  const g = GROUPS;
  const P = (e: El, doc: Doc) => partOf(doc, e);
  return [
    { key: 'kind', label: 'Art', group: g.construction, type: 'readonly', get: (e, doc) => KIND_LABEL[(P(e, doc)?.kind ?? e.kind) as JointKind] ?? '' },
    { key: 'loc', label: 'Lage', group: g.construction, type: 'readonly', get: (e, doc) => P(e, doc)?.loc ?? '' },
    { key: 'product', label: 'Produkt', group: g.construction, type: 'text', get: (e, doc) => bearingProduct(doc, e), set: (_e, v) => ({ product: v || undefined }) },
    { key: 'len', label: 'Länge', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(P(e, doc)?.len ?? 0) },
    { key: 'thick', label: 'Dicke / Durchmesser', group: g.dims, type: 'readonly', get: (e, doc) => fmtNum(P(e, doc)?.thick ?? 0, 0) + ' mm' },
    { key: 'count', label: 'Anzahl', group: g.dims, type: 'readonly', get: (e, doc) => String(P(e, doc)?.count ?? 0) },
    { key: 'host', label: 'Treppe', group: g.constraints, type: 'readonly', get: (e, doc) => { const h = doc.get(e.hostId); return h ? h.mark || stairType(doc, h)?.name || h.id : ''; } },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'stairBearing', label: 'Treppenlager', plural: 'Treppenlager', planOrder: 26, hostCats: ['stair'],
  drawPlan: drawBearingPlan,
  solids: (el, doc) => partOf(doc, el)?.solids ?? [],
  center: (el, doc) => { const p = partOf(doc, el); return p ? centroid(p.ring) : null; },
  tagPoint: (el, doc) => { const p = partOf(doc, el); return p ? centroid(p.ring) : null; },
  tagText: (el, doc) => bearingText(doc, el),
  props: () => bearingProps(),
  scheduleFields: () => [
    { key: 'kind', label: 'Art', get: (el, doc) => KIND_LABEL[(partOf(doc, el)?.kind ?? el.kind) as JointKind] ?? '' },
    { key: 'product', label: 'Produkt', get: (el, doc) => bearingProduct(doc, el) },
    { key: 'loc', label: 'Lage', get: (el, doc) => partOf(doc, el)?.loc ?? '' },
    { key: 'stair', label: 'Treppe', get: (el, doc) => { const h = doc.get(el.hostId); return h ? h.mark || h.id : ''; } },
    { key: 'level', label: 'Basisebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'count', label: 'Anzahl', unit: 'num', get: (el, doc) => partOf(doc, el)?.count ?? 0 },
    { key: 'len', label: 'Länge', unit: 'len', get: (el, doc) => partOf(doc, el)?.len ?? 0 },
    { key: 'thick', label: 'Dicke / Ø', unit: 'len', get: (el, doc) => partOf(doc, el)?.thick ?? 0 },
    { key: 'area', label: 'Fläche (Grundriss)', unit: 'area', get: (el, doc) => { const p = partOf(doc, el); return p && p.kind !== 'dowel' ? Math.abs(signedArea(p.ring)) : 0; } },
    { key: 'text', label: 'Beschriftung', get: (el, doc) => bearingText(doc, el) },
  ],
  ifc: (el, doc) => {
    const p = partOf(doc, el); if (!p) return null;
    const h = doc.get(el.hostId); const name = bearingProduct(doc, el);
    const psets = { CH_Treppenlager: {
      Art: KIND_LABEL[p.kind], Produkt: name, Lage: p.loc, Treppe: h?.mark || h?.id || '',
      Laenge_mm: Math.round(p.len), Dicke_mm: Math.round(p.thick), Anzahl: p.count,
    } };
    if (p.kind === 'dowel') return { entity: 'IfcMechanicalFastener', predefined: 'DOWEL', name, psets };
    if (p.kind === 'plate') return { entity: 'IfcCovering', predefined: 'INSULATION', name, psets };
    // IFC4 kennt IfcBearing noch nicht: Elastomerlager als Zubehörteil
    return { entity: 'IfcDiscreteAccessory', predefined: 'USERDEFINED', name, psets };
  },
});
if (!OBJECT_STYLES.stairBearing) OBJECT_STYLES.stairBearing = { label: 'Treppenlager', proj: 1, cut: 2 } as any;

// ------------------------------------------------------------ Eigenschaften der Treppe
const JG = 'Trittschall / Lager';
export function stairJointProps(): PropDef[] {
  const d = JOINT_DEFAULTS as Record<string, any>;
  const sel = (key: string, label: string, options: [string, string][]): PropDef =>
    ({ key, label, group: JG, type: 'select', options, get: (e) => e[key] ?? d[key], set: (_e, v) => ({ [key]: v === d[key] ? undefined : v }) });
  const len = (key: string, label: string, min: number): PropDef =>
    ({ key, label, group: JG, type: 'length', get: (e) => e[key] ?? d[key], set: (_e, v) => ({ [key]: Math.max(min, v) }) });
  const txt = (key: string, label: string): PropDef =>
    ({ key, label, group: JG, type: 'text', get: (e) => e[key] ?? d[key], set: (_e, v) => ({ [key]: v && v !== d[key] ? v : undefined }) });
  const end: [string, string][] = [['mono', 'Monolithisch'], ['z', 'Z-Lager (Konsole + Elastomer)'], ['dowel', 'Querkraftdorne mit Fugenplatte']];
  return [
    sel('jBot', 'Antritt (auf Decke/Bodenplatte)', [['mono', 'Monolithisch'], ['pad', 'Schalldämmlager (Elastomer)']]),
    sel('jTop', 'Austritt (an Decke)', end),
    sel('jLand', 'Lauf – Podest', end),
    sel('jLandWall', 'Podest – Wand', [['mono', 'Monolithisch'], ['console', 'Wandkonsole mit Elastomerlager'], ['dowel', 'Querkraftdorne mit Fugenplatte']]),
    { key: 'wallPlate', label: 'Fugenplatten Lauf/Podest – Wand', group: JG, type: 'bool', get: (e) => !!e.wallPlate, set: (_e, v) => ({ wallPlate: v || undefined }) },
    len('jGap', 'Fugenbreite', 2), len('padT', 'Lagerdicke', 3), len('consoleC', 'Konsolentiefe', 40),
    { key: 'dowelN', label: 'Querkraftdorne je Fuge', group: JG, type: 'int', get: (e) => e.dowelN ?? d.dowelN, set: (_e, v) => ({ dowelN: Math.max(1, Math.round(v)) }) },
    len('dowelDia', 'Dorndurchmesser', 6),
    txt('prodZ', 'Produkt Z-Lager'), txt('prodPad', 'Produkt Schalldämmlager'), txt('prodDowel', 'Produkt Querkraftdorn'), txt('prodPlate', 'Produkt Fugenplatte'),
    { key: 'nBearings', label: 'Lagerteile', group: JG, type: 'readonly', get: (e, doc) => String(e.id && doc.has(e.id) ? stairJoints(doc, e).parts.length : 0) },
  ];
}

// ------------------------------------------------------------ Befehl, Vorlage
registerCommand({
  id: 'stairBearings', label: 'Lager aktualisieren', icon: 'stair',
  tip: 'Treppenlager (Z-Lager, Schalldämmlager, Querkraftdorne, Fugenplatten) der gewählten Treppen – ohne Auswahl aller Treppen – neu anlegen bzw. entfernen',
  run: () => {
    const doc = app.doc;
    const sel = [...app.selection].map((id) => doc.get(id)).filter((e): e is El => e?.cat === 'stair');
    const stairs = sel.length ? sel : doc.all('stair');
    let before = 0; for (const s of stairs) before += bearingsOf(doc, s).length;
    doc.transaction('Treppenlager aktualisieren', () => { addStairJointTemplate(doc); for (const s of stairs) syncStairBearings(doc, s); });
    let after = 0; for (const s of stairs) after += bearingsOf(doc, s).length;
    app.status(`${stairs.length} Treppe(n): ${after} Lagerteil(e)${after !== before ? ` (vorher ${before})` : ''}.`);
  },
});
registerContextPanel({ cats: ['stair'], panel: 'Lager', items: ['stairBearings'] });

export function addStairJointTemplate(doc: Doc): void {
  const m = (id: string, name: string, color: string, cutPattern: string, extra: Partial<Material>) => {
    if (!doc.get(id)) doc.add({ id, cat: 'material', name, color, cutPattern, ...extra } as Material);
  };
  m('m_elastomer', 'Elastomerlager (Trittschall)', '#2f2f2f', 'solid', { cutColor: '#1a1a1a', density: 1300 });
  m('m_fugenplatte', 'Fugenplatte (Trittschalldämmung)', '#e8d77a', 'solid', { cutColor: '#d6c157', density: 120 });
}
onHook('template', (doc: Doc) => addStairJointTemplate(doc));
// Geladene Projekte: Materialien ergänzen und Lager-Elemente nachführen (nur bei Treppen mit Lagerdetails)
onHook('loaded', (doc: Doc) => {
  const stairs = doc.all('stair').filter(hasStairJoints);
  if (!stairs.length) return;
  if (doc.get('m_elastomer') && doc.get('m_fugenplatte') && stairs.every((s) => stairBearingsInSync(doc, s))) return;
  doc.transaction('Treppenlager ergänzen', () => { addStairJointTemplate(doc); for (const s of stairs) syncStairBearings(doc, s); });
  doc.clearHistory();
});
