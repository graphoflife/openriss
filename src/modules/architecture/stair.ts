// Treppe nach Bauteil: gerade, L-förmig (Viertelpodest) oder U-förmig (Halbpodest).
// Steigungsanzahl aus Geschosshöhe und max. Steigungshöhe; Grundriss nach DIN (Lauflinie mit Kreis
// und Pfeil, Schnittlinie, Teile über der Schnittebene gestrichelt); Körper für Schnitt/3D.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, V3, add, sub, mul, norm, perp, dist, apply, applyVec, isMirror, Mat2, angleOf, distToSeg, lerp,
} from '../../core/geom';
import { registerCategory, registerCommand, GROUPS, PropDef, PlanCtx, Solid, Face, Grip } from '../../core/registry';
import { levelElev, levelAbove, levelOptions, typeOf, TypeEl, View, isPlanLike } from '../../core/view';
import { cached } from '../../core/cache';
import { fmtLen, fmtNum } from '../../core/units';
import { prism, extrudeProfile, catPen, box3 } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import { normTextAngle } from '../../elements/datums';
import { identityProps, levelName } from './common';
import { stairJoints, stairJointProps, withBearingSync, syncStairBearings, hasStairJoints } from './stairJoints';

export type StairShape = 'straight' | 'L' | 'U';
export interface Stair extends El {
  cat: 'stair';
  levelId: Id; baseOffset: number;
  topLevelId: Id | null; topOffset: number; height: number;
  /** Antritt (Mitte des ersten Laufs, erste Steigung) */
  p0: V2;
  /** Laufrichtung des ersten Laufs (normiert) */
  dir: V2;
  shape: StairShape;
  /** 1 = nach links abbiegen, -1 = nach rechts */
  turn: 1 | -1;
  width: number; maxRiser: number; tread: number;
  /** Podesttiefe (0 = Laufbreite) */
  landing: number;
  /** Treppenauge (U-Form) */
  gap: number;
  /** gewünschte Anzahl Steigungen (0 = automatisch) */
  risers: number;
  /** Steigungen im 1. Lauf (0 = automatisch) */
  split: number;
}
export interface StairType extends TypeEl { of: 'stair'; mat?: Id; waist: number; landingThick: number; construction: 'massiv' | 'wange'; treadThick?: number; description?: string }

export const stairType = (doc: Doc, s: El) => typeOf<StairType>(doc, s);

export interface Run { s: V2; d: V2; m: number; k0: number; z: number; L: number }
export interface StairGeom {
  z0: number; z1: number; H: number; n: number; r: number; t: number; w: number;
  runs: Run[];
  landings: { ring: V2[]; z: number }[];
  walk: V2[];
  /** lokal → Welt */
  W: (p: V2) => V2;
  /** lokaler Vektor → Welt */
  WV: (v: V2) => V2;
}

export function stairZ(doc: Doc, s: El): [number, number] {
  const z0 = levelElev(doc, s.levelId) + (s.baseOffset ?? 0);
  const z1 = s.topLevelId && doc.get(s.topLevelId) ? levelElev(doc, s.topLevelId) + (s.topOffset ?? 0) : z0 + (s.height ?? 3000);
  return [z0, z1];
}

export function stairGeom(doc: Doc, s: El): StairGeom {
  const calc = (): StairGeom => {
    const [z0, z1r] = stairZ(doc, s);
    const H = Math.max(100, z1r - z0); const z1 = z0 + H;
    const maxR = Math.max(50, s.maxRiser ?? 180);
    const n = s.risers > 0 ? Math.max(2, Math.round(s.risers)) : Math.max(2, Math.ceil(H / maxR - 1e-6));
    const r = H / n; const t = Math.max(100, s.tread ?? 280); const w = Math.max(300, s.width ?? 1000);
    const D = norm(s.dir ?? { x: 1, y: 0 }); const N = mul(perp(D), s.turn === -1 ? -1 : 1);
    const W = (p: V2) => add(add(s.p0, mul(D, p.x)), mul(N, p.y));
    const WV = (v: V2) => add(mul(D, v.x), mul(N, v.y));
    const runs: Run[] = []; const landings: { ring: V2[]; z: number }[] = [];
    let walk: V2[];
    const shape: StairShape = s.shape ?? 'straight';
    if (shape === 'straight') {
      runs.push({ s: { x: 0, y: 0 }, d: { x: 1, y: 0 }, m: n, k0: 1, z: z0, L: (n - 1) * t });
      walk = [{ x: 0, y: 0 }, { x: (n - 1) * t, y: 0 }];
    } else {
      const n1 = s.split > 0 ? Math.max(1, Math.min(n - 1, Math.round(s.split))) : Math.ceil(n / 2);
      const n2 = n - n1; const L1 = (n1 - 1) * t, L2 = (n2 - 1) * t; const zL = z0 + n1 * r;
      runs.push({ s: { x: 0, y: 0 }, d: { x: 1, y: 0 }, m: n1, k0: 1, z: z0, L: L1 });
      if (shape === 'L') {
        landings.push({ ring: [{ x: L1, y: -w / 2 }, { x: L1 + w, y: -w / 2 }, { x: L1 + w, y: w / 2 }, { x: L1, y: w / 2 }], z: zL });
        runs.push({ s: { x: L1 + w / 2, y: w / 2 }, d: { x: 0, y: 1 }, m: n2, k0: n1 + 1, z: zL, L: L2 });
        walk = [{ x: 0, y: 0 }, { x: L1 + w / 2, y: 0 }, { x: L1 + w / 2, y: w / 2 + L2 }];
      } else {
        const dl = s.landing > 0 ? s.landing : w; const g = Math.max(0, s.gap ?? 100);
        landings.push({ ring: [{ x: L1, y: -w / 2 }, { x: L1 + dl, y: -w / 2 }, { x: L1 + dl, y: w * 1.5 + g }, { x: L1, y: w * 1.5 + g }], z: zL });
        runs.push({ s: { x: L1, y: w + g }, d: { x: -1, y: 0 }, m: n2, k0: n1 + 1, z: zL, L: L2 });
        walk = [{ x: 0, y: 0 }, { x: L1 + dl / 2, y: 0 }, { x: L1 + dl / 2, y: w + g }, { x: L1 - L2, y: w + g }];
      }
    }
    return { z0, z1, H, n, r, t, w, runs, landings, walk, W, WV };
  };
  return s.id ? cached(doc, 'archStairGeom', s.id, calc) : calc();
}
export const stairLabel = (g: StairGeom): string => `${g.n} Stg. ${fmtNum(g.r / 10, 1)}/${fmtNum(g.t / 10, 1)}`;

/** Ränder eines Laufs (lokal): Punkt bei u (entlang) und v (quer) */
export const RP = (run: Run, u: number, v: number): V2 => add(add(run.s, mul(run.d, u)), mul(perp(run.d), v));

/** Geländerpfad (Welt, 3D) an einer Seite (+1 links / -1 rechts im lokalen System), 50 mm eingerückt */
export function stairSidePath(doc: Doc, s: El, side: 1 | -1, inset = 50): V3[] {
  const g = stairGeom(doc, s); const v = side * (g.w / 2 - inset);
  const pts: { p: V2; z: number }[] = [];
  g.runs.forEach((run, i) => {
    if (i > 0) {
      const prev = g.runs[i - 1];
      const a = RP(prev, prev.L, v), da = prev.d; const b = RP(run, 0, v), db = run.d;
      const zl = run.z;
      const crs = da.x * db.y - da.y * db.x;
      if (Math.abs(crs) > 1e-6) {
        // Schnittpunkt der beiden Randlinien (L-Form)
        const tt = ((b.x - a.x) * db.y - (b.y - a.y) * db.x) / crs;
        pts.push({ p: add(a, mul(da, tt)), z: zl });
      } else {
        // U-Form: über das Podest (außen an der Podestkante, innen um das Treppenauge)
        const lnd = g.landings[0];
        const xFar = side < 0 ? Math.max(...lnd.ring.map((q) => q.x)) - inset : Math.min(...lnd.ring.map((q) => q.x)) + inset;
        pts.push({ p: { x: xFar, y: a.y }, z: zl }, { p: { x: xFar, y: b.y }, z: zl });
      }
    }
    if (run.m >= 1) {
      pts.push({ p: RP(run, 0, v), z: run.z + g.r });
      if (run.L > 1) pts.push({ p: RP(run, run.L, v), z: run.z + run.m * g.r });
    }
  });
  return pts.map((q) => { const w = g.W(q.p); return { x: w.x, y: w.y, z: q.z }; });
}

// ------------------------------------------------------------ Grundriss
function zigLine(dl: DisplayList, a: V2, b: V2, z: number, pen: Pen): void {
  const d = norm(sub(b, a)); const n = perp(d); const m = lerp(a, b, 0.5);
  dl.poly([a, sub(m, mul(d, z)), add(m, mul(n, z)), sub(m, mul(n, z)), add(m, mul(d, z)), b], pen, false, { ns: true });
}

function drawStair(ctx: { dl: DisplayList; doc: Doc; view: View }, s: El, g: StairGeom, cutAbs: number, upper: boolean, penVis: Pen, penHid: Pen | null, label = true): void {
  const { dl } = ctx; const sc = ctx.view.scale; const W = g.W;
  const thin: Pen = { w: 1, color: penVis.color };
  // Auswahlflächen
  for (const run of g.runs) if (run.L > 1) dl.fill([[RP(run, 0, -g.w / 2), RP(run, run.L, -g.w / 2), RP(run, run.L, g.w / 2), RP(run, 0, g.w / 2)].map(W)], { color: 'transparent' }, undefined, { ns: true });
  for (const l of g.landings) dl.fill([l.ring.map(W)], { color: 'transparent' }, undefined, { ns: true });
  // Schnittstelle: Lauf und Position u, an der die Vorderkantenlinie die Schnitthöhe erreicht
  let cut: { run: number; u: number } | null = null;
  for (let i = 0; i < g.runs.length; i++) {
    const run = g.runs[i];
    if (cutAbs < run.z + run.m * g.r) {
      const u = Math.max(0, Math.min(run.L, ((cutAbs - run.z - g.r) * g.t) / g.r));
      cut = { run: i, u: cutAbs < run.z ? 0 : u };
      break;
    }
  }
  const isBelow = (z: number) => z <= cutAbs + 0.5;
  const line = (a: V2, b: V2, below: boolean, extra: { sub?: string } = {}) => {
    if (upper) { if (!below) dl.line(W(a), W(b), penVis, extra); }
    else if (below) dl.line(W(a), W(b), penVis, extra);
    else if (penHid) dl.line(W(a), W(b), penHid, extra);
  };
  // Stufenvorderkanten
  for (const run of g.runs) for (let j = 1; j <= run.m; j++) {
    const u = (j - 1) * g.t; const zk = run.z + j * g.r;
    line(RP(run, u, -g.w / 2), RP(run, u, g.w / 2), isBelow(zk));
  }
  // Laufränder (an der Schnittstelle geteilt)
  g.runs.forEach((run, i) => {
    if (run.L < 1) return;
    for (const v of [-g.w / 2, g.w / 2]) {
      if (cut && cut.run === i) {
        if (cut.u > 0) line(RP(run, 0, v), RP(run, cut.u, v), true);
        if (cut.u < run.L) line(RP(run, cut.u, v), RP(run, run.L, v), false);
      } else line(RP(run, 0, v), RP(run, run.L, v), !cut || i < cut.run);
    }
  });
  // Podeste
  for (const l of g.landings) {
    const b = isBelow(l.z);
    for (let i = 0; i < l.ring.length; i++) line(l.ring[i], l.ring[(i + 1) % l.ring.length], b);
  }
  // Schnittlinie (Bruchlinie)
  let walkCut: V2 | null = null;
  if (cut) {
    const run = g.runs[cut.run];
    const k = g.w * 0.3;
    const a = RP(run, cut.u - k, -g.w / 2 - 80), b = RP(run, cut.u + k, g.w / 2 + 80);
    zigLine(dl, W(a), W(b), 1.6 * sc, thin);
    walkCut = RP(run, cut.u, 0);
  }
  // Lauflinie
  const walk = g.walk.slice();
  let ic = walk.length - 1;
  if (walkCut) {
    for (let i = 0; i + 1 < walk.length; i++) if (distToSeg(walkCut, walk[i], walk[i + 1]) < 1) { walk.splice(i + 1, 0, walkCut); ic = i + 1; break; }
  }
  const wl = walk.map(W);
  const solidPart = upper ? wl.slice(ic) : wl.slice(0, ic + 1);
  const hidPart = upper ? [] : wl.slice(ic);
  if (solidPart.length > 1) dl.poly(solidPart, thin, false, { ns: true });
  if (hidPart.length > 1 && walkCut && penHid) dl.poly(hidPart, { ...thin, dash: 'hidden' }, false, { ns: true });
  if (!upper) dl.circle(wl[0], 1.2 * sc, thin, undefined, { ns: true });
  // Pfeil am Austritt
  const e = wl[wl.length - 1], ePrev = wl[wl.length - 2];
  if (e && ePrev && (upper || walkCut === null || penHid)) {
    const d = norm(sub(e, ePrev)); const n = perp(d); const L = 2.8 * sc;
    dl.fill([[e, add(sub(e, mul(d, L)), mul(n, L * 0.35)), sub(sub(e, mul(d, L)), mul(n, L * 0.35))]], { color: '#ffffff', pattern: 'solid', patColor: thin.color ?? '#000000' }, undefined, { ns: true });
  }
  // Beschriftung "17 Stg. 17,6/28,0"
  if (label && !upper) {
    const run = g.runs[0];
    const u = Math.min(run.L * 0.5, 2.5 * g.t);
    const p = W(RP(run, u, g.w * 0.22)); const ang = angleOf(g.WV(run.d));
    dl.text(p, stairLabel(g), { size: 2.2, rot: normTextAngle(ang), ha: 'center', va: 'middle', color: penVis.color });
  }
}

function drawStairPlan(ctx: PlanCtx, s: El): void {
  if (ctx.ceiling) return;
  const g = stairGeom(ctx.doc, s);
  const vis = catPen(ctx.doc, 'stair', false);
  const hid: Pen = { w: 1, dash: 'hidden' };
  if (g.z0 <= ctx.cutZ + 1 && g.z1 > ctx.cutZ && g.z0 >= ctx.depthZ - 1) drawStair(ctx, s, g, ctx.cutZ, false, vis, hid);
  else if (g.z1 <= ctx.cutZ + 1 && g.z1 >= ctx.depthZ - 1) {
    if (g.z0 >= ctx.depthZ - 1) drawStair(ctx, s, g, ctx.cutZ, false, vis, hid);
    else {
      // Treppe aus dem darunterliegenden Geschoss: Teil oberhalb der dortigen Schnitthöhe
      const rel = ctx.cutZ - (ctx.level?.elev ?? ctx.depthZ);
      drawStair(ctx, s, g, g.z0 + rel, true, vis, null);
    }
  }
  // Austrittsstufe in der ausgeklinkten Decke (Z-Lager/Querkraftdorne am Austritt)
  for (const x of stairJoints(ctx.doc, s).planExt) if (x.z <= ctx.cutZ + 1 && x.z >= ctx.depthZ - 1) ctx.dl.poly(x.ring, vis, true);
}

// ------------------------------------------------------------ 3D
/** Laufprofil (u entlang des Laufs, z absolut) einer Massivtreppe ohne Lagerdetails */
export function runProfileBase(doc: Doc, s: El, g: StairGeom, i: number): V2[] | null {
  const run = g.runs[i]; if (!run || run.m < 2) return null;
  const t = stairType(doc, s); const e = t?.waist ?? 160;
  const slope = g.r / g.t; const c = Math.sqrt(1 + slope * slope);
  const uEnd = run.L; const zr = run.z;
  const prof: V2[] = [{ x: 0, y: zr }];
  for (let j = 1; j < run.m; j++) prof.push({ x: (j - 1) * g.t, y: zr + j * g.r }, { x: j * g.t, y: zr + j * g.r });
  prof.push({ x: uEnd, y: zr + run.m * g.r });
  const zu = (u: number) => zr + slope * u - e * c;
  if (i === 0) {
    const us = (e * c) / slope;
    if (us < uEnd) prof.push({ x: uEnd, y: zu(uEnd) }, { x: us, y: zr });
    else prof.push({ x: uEnd, y: zr });
  } else prof.push({ x: uEnd, y: zu(uEnd) }, { x: 0, y: zu(0) });
  return prof;
}

function stairSolids(doc: Doc, s: El): Solid[] {
  const g = stairGeom(doc, s); const t = stairType(doc, s);
  const mat = t?.mat ?? 'm_stb'; const lt = t?.landingThick ?? 200;
  const jg = stairJoints(doc, s);
  const out: Solid[] = [...jg.concrete];
  const up: V3 = { x: 0, y: 0, z: 1 };
  const to3 = (v: V2, z = 0): V3 => ({ x: v.x, y: v.y, z });
  const slope = g.r / g.t;
  g.runs.forEach((run, i) => {
    if (run.m < 2) return;
    const uEnd = run.L; const zr = run.z;
    const dW = g.WV(run.d); const nW = g.WV(perp(run.d));
    if ((t?.construction ?? 'massiv') === 'massiv') {
      // Laufprofil inkl. Lager-Ausklinkungen (Z-Lager, Schalldämmlager, Querkraftdorne), schmaler bei Fugen zur Wand
      const [ia, ib] = jg.insets[i];
      const org = to3(g.W(RP(run, 0, -g.w / 2 + ia)));
      for (const prof of jg.profiles[i] ?? [runProfileBase(doc, s, g, i)]) {
        if (prof && prof.length >= 3) out.push({ faces: extrudeProfile(prof, org, to3(dW), up, to3(nW), g.w - ia - ib), mat });
      }
    } else {
      // Wangentreppe: Trittstufen + zwei Wangen
      const tt = t?.treadThick ?? 40; const faces: Face[] = [];
      for (let j = 1; j < run.m; j++) {
        const o = to3(g.W(RP(run, (j - 1) * g.t - 30, -g.w / 2 + 50)), zr + j * g.r - tt);
        faces.push(...box3(o, to3(mul(dW, g.t + 30)), to3(mul(nW, g.w - 100)), { x: 0, y: 0, z: tt }));
      }
      out.push({ faces, mat });
      for (const v of [-g.w / 2, g.w / 2 - 50]) {
        const o2 = to3(g.W(RP(run, 0, v)));
        const prof: V2[] = [{ x: -g.t * 0.5, y: zr + g.r * 0.5 - 250 }, { x: uEnd + g.t * 0.5, y: zr + slope * (uEnd + g.t * 0.5) + g.r * 0.5 - 250 }];
        prof.push({ x: uEnd + g.t * 0.5, y: prof[1].y + 300 }, { x: -g.t * 0.5, y: prof[0].y + 300 });
        out.push({ faces: extrudeProfile(prof.map((p) => ({ x: p.x, y: Math.max(zr - 50, p.y) })), o2, to3(dW), up, to3(nW), 50), mat });
      }
    }
  });
  g.landings.forEach((l, k) => {
    const lp = jg.landings[k];
    if (!lp) out.push({ faces: prism(l.ring.map(g.W), l.z - lt, l.z), mat });
    else for (const poly of lp) out.push({ faces: prism(poly[0].map(g.W), l.z - lt, l.z, poly.slice(1).map((h) => h.map(g.W))), mat });
  });
  return out;
}

// ------------------------------------------------------------ Eigenschaften
function stairProps(): PropDef[] {
  const g = GROUPS;
  const geo = (e: El, doc: Doc) => stairGeom(doc, e);
  return [
    { key: 'levelId', label: 'Basisebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'baseOffset', label: 'Versatz unten', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'topLevelId', label: 'Oberste Ebene', group: g.constraints, type: 'select', options: (doc) => [['', 'Keine'], ...levelOptions(doc)], get: (e) => e.topLevelId ?? '', set: (_e, v) => ({ topLevelId: v || null }) },
    { key: 'topOffset', label: 'Versatz oben', group: g.constraints, type: 'length', get: (e) => e.topOffset ?? 0, set: (_e, v) => ({ topOffset: v }) },
    { key: 'height', label: 'Gewünschte Treppenhöhe', group: g.constraints, type: 'length', get: (e, doc) => geo(e, doc).H, set: (e, v) => (e.topLevelId ? undefined : { height: v }) },
    { key: 'shape', label: 'Form', group: g.construction, type: 'select', options: [['straight', 'Gerade'], ['L', 'L-förmig (Viertelpodest)'], ['U', 'U-förmig (Halbpodest)']], get: (e) => e.shape ?? 'straight', set: (_e, v) => ({ shape: v }) },
    { key: 'turn', label: 'Drehrichtung', group: g.construction, type: 'select', options: [['1', 'Links'], ['-1', 'Rechts']], get: (e) => String(e.turn ?? 1), set: (_e, v) => ({ turn: v === '-1' ? -1 : 1 }) },
    { key: 'risers', label: 'Gewünschte Anzahl Steigungen', group: g.dims, type: 'int', get: (e) => e.risers ?? 0, set: (_e, v) => ({ risers: Math.max(0, v) }) },
    { key: 'nAct', label: 'Tatsächliche Anzahl Steigungen', group: g.dims, type: 'readonly', get: (e, doc) => String(geo(e, doc).n) },
    { key: 'rAct', label: 'Tatsächliche Steigungshöhe', group: g.dims, type: 'readonly', get: (e, doc) => fmtNum(geo(e, doc).r, 1) },
    { key: 'maxRiser', label: 'Maximale Steigungshöhe', group: g.dims, type: 'length', get: (e) => e.maxRiser ?? 180, set: (_e, v) => ({ maxRiser: Math.max(50, v) }) },
    { key: 'tread', label: 'Tatsächliche Auftrittsbreite', group: g.dims, type: 'length', get: (e) => e.tread ?? 280, set: (_e, v) => ({ tread: Math.max(100, v) }) },
    { key: 'width', label: 'Laufbreite', group: g.dims, type: 'length', get: (e) => e.width ?? 1000, set: (_e, v) => ({ width: Math.max(300, v) }) },
    { key: 'split', label: 'Steigungen im 1. Lauf', group: g.dims, type: 'int', get: (e) => e.split ?? 0, set: (_e, v) => ({ split: Math.max(0, v) }) },
    { key: 'landing', label: 'Podesttiefe', group: g.dims, type: 'length', get: (e) => e.landing || e.width || 1000, set: (_e, v) => ({ landing: Math.max(0, v) }) },
    { key: 'gap', label: 'Treppenauge', group: g.dims, type: 'length', get: (e) => e.gap ?? 100, set: (_e, v) => ({ gap: Math.max(0, v) }) },
    { key: 'rule', label: 'Schrittmaß (2s + a)', group: g.dims, type: 'readonly', get: (e, doc) => { const q = geo(e, doc); return fmtNum((2 * q.r + q.t) / 10, 1) + ' cm'; } },
    { key: 'label', label: 'Beschriftung', group: g.text, type: 'readonly', get: (e, doc) => stairLabel(geo(e, doc)) },
    ...identityProps(),
  ];
}
function stairTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'construction', label: 'Konstruktion', group: g.construction, type: 'select', options: [['massiv', 'Massivtreppe (Laufplatte)'], ['wange', 'Wangentreppe']], get: (t) => t.construction ?? 'massiv', set: (_t, v) => ({ construction: v }) },
    { key: 'waist', label: 'Laufplattendicke', group: g.construction, type: 'length', get: (t) => t.waist ?? 160, set: (_t, v) => ({ waist: Math.max(20, v) }) },
    { key: 'landingThick', label: 'Podestdicke', group: g.construction, type: 'length', get: (t) => t.landingThick ?? 200, set: (_t, v) => ({ landingThick: Math.max(20, v) }) },
    { key: 'treadThick', label: 'Trittstufendicke', group: g.construction, type: 'length', get: (t) => t.treadThick ?? 40, set: (_t, v) => ({ treadThick: Math.max(10, v) }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

function stairGrips(doc: Doc, s: El, view: View): Grip[] {
  if (!isPlanLike(view)) return [];
  const g = stairGeom(doc, s);
  const out: Grip[] = [{ id: 'start', p: s.p0, kind: 'end', tip: 'Antritt verschieben' }];
  const end = g.W(g.walk[g.walk.length - 1]);
  if ((s.shape ?? 'straight') === 'straight') out.push({ id: 'dir', p: end, kind: 'end', tip: 'Laufrichtung drehen' });
  else out.push({ id: 'turn', p: g.W({ x: g.runs[0].L * 0.5, y: -g.w / 2 - view.scale * 5 }), kind: 'flip', dir: g.WV({ x: 0, y: 1 }), tip: 'Drehrichtung umkehren' });
  return out;
}

registerCategory({
  cat: 'stair', label: 'Treppe', plural: 'Treppen', hasTypes: true, planOrder: 25,
  drawPlan: drawStairPlan,
  solids: (el, doc) => stairSolids(doc, el),
  grips: (el, doc, view) => stairGrips(doc, el, view),
  dragGrip: (el, id, p) => {
    if (id === 'start') return { p0: p };
    if (id === 'dir' && dist(p, el.p0) > 10) return { dir: norm(sub(p, el.p0)) };
  },
  clickGrip: (el, id) => (id === 'turn' ? { turn: el.turn === -1 ? 1 : -1 } : undefined),
  transform: (el, m: Mat2, _doc, view) => {
    if (!isPlanLike(view)) return;
    const patch: Partial<Stair> = { p0: apply(m, el.p0), dir: norm(applyVec(m, el.dir)) };
    if (isMirror(m)) patch.turn = el.turn === -1 ? 1 : -1;
    return patch;
  },
  translate3d: (el, d) => ({ p0: { x: el.p0.x + d.x, y: el.p0.y + d.y }, baseOffset: (el.baseOffset ?? 0) + d.z, topOffset: el.topLevelId ? (el.topOffset ?? 0) + d.z : el.topOffset }),
  center: (el, doc) => { const g = stairGeom(doc, el); return g.W(g.walk[Math.floor(g.walk.length / 2)]); },
  props: () => withBearingSync([...stairProps(), ...stairJointProps()]),
  typeProps: () => stairTypeProps(),
  tagText: (el, doc) => stairLabel(stairGeom(doc, el)),
  tagPoint: (el, doc) => { const g = stairGeom(doc, el); return g.W(g.walk[0]); },
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => stairType(doc, el)?.name ?? '' },
    { key: 'level', label: 'Basisebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'top', label: 'Oberste Ebene', get: (el, doc) => levelName(doc, el.topLevelId) },
    { key: 'n', label: 'Anzahl Steigungen', unit: 'num', get: (el, doc) => stairGeom(doc, el).n },
    { key: 'riser', label: 'Steigungshöhe', unit: 'len', get: (el, doc) => stairGeom(doc, el).r },
    { key: 'tread', label: 'Auftrittsbreite', unit: 'len', get: (el, doc) => stairGeom(doc, el).t },
    { key: 'width', label: 'Laufbreite', unit: 'len', get: (el) => el.width ?? 1000 },
    { key: 'label', label: 'Beschriftung', get: (el, doc) => stairLabel(stairGeom(doc, el)) },
  ],
});

// ------------------------------------------------------------ Werkzeug
const SO = { railing: true };

class StairTool extends Tool {
  id = 'stair'; label = 'Treppe'; kinds = ['plan'];
  private start: V2 | null = null; private cur: V2 | null = null;
  activate(): void {
    const lvl = activeLevelId(); const above = levelAbove(app.doc, lvl);
    this.placement = placementFor('stair', {
      levelId: lvl, baseOffset: 0, topLevelId: above?.id ?? null, topOffset: 0, height: 3000, shape: 'straight', turn: 1,
      width: 1000, maxRiser: 180, tread: 280, landing: 0, gap: 100, risers: 0, split: 0, typeId: 'stt_stb',
    });
    const p = this.placement.proto; p.levelId = lvl;
    if (!p.topLevelId || !app.doc.get(p.topLevelId) || levelElev(app.doc, p.topLevelId) <= levelElev(app.doc, lvl)) p.topLevelId = above?.id ?? null;
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return this.start ? 'Klicken Sie, um die Laufrichtung festzulegen (Leertaste: Drehrichtung).' : 'Klicken Sie auf den Antritt (Mitte der Lauflinie, erste Steigung).'; }
  basePoint(): V2 | null { return this.start; }
  options(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'buttons', key: 'shape', value: p.shape ?? 'straight', options: [{ id: 'straight', label: 'Gerade', icon: 'stair' }, { id: 'L', label: 'L-förmig', icon: 'stairL' }, { id: 'U', label: 'U-förmig', icon: 'stairU' }], onChange: (v) => { p.shape = v; app.emit('tool'); app.redrawOverlay(); } },
      { kind: 'length', key: 'width', label: 'Laufbreite', value: p.width ?? 1000, onChange: (v) => { p.width = Math.max(300, v); app.redrawOverlay(); } },
      { kind: 'select', key: 'turn', label: 'Drehrichtung', value: String(p.turn ?? 1), options: [['1', 'Links'], ['-1', 'Rechts']], onChange: (v) => { p.turn = v === '-1' ? -1 : 1; app.redrawOverlay(); } },
      { kind: 'select', key: 'top', label: 'Oberste Ebene', value: p.topLevelId ?? '', options: [['', 'Keine (Höhe)'], ...levelOptions(app.doc)], onChange: (v) => { p.topLevelId = v || null; app.emit('tool'); } },
      { kind: 'check', key: 'railing', label: 'Geländer', value: SO.railing, onChange: (v) => { SO.railing = v; } },
    ];
  }
  space(): boolean { const p = this.placement!.proto; p.turn = p.turn === -1 ? 1 : -1; app.emit('tool'); app.redrawOverlay(); return true; }
  private proto(dir: V2): El {
    const p = this.placement!.proto;
    return { ...p, id: '', cat: 'stair', p0: this.start!, dir } as El;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.start) { this.start = e.p; this.cur = e.p; return; }
    if (dist(this.start, e.p) < 10) return;
    this.create(norm(sub(e.p, this.start)));
  }
  typedLength(_L: number, e: ToolEvent | null): void { if (this.start && this.cur) { void e; this.create(norm(sub(this.cur, this.start))); } }
  private create(dir: V2): void {
    const pr = this.proto(dir); const { id: _i, ...rest } = pr;
    let id = '';
    app.doc.transaction('Treppe erstellen', () => {
      const s = app.doc.add<Stair>({ ...rest, id: newId('st'), cat: 'stair' } as Stair);
      id = s.id;
      if (SO.railing) {
        const rt = app.doc.get('rlt_1000') ? 'rlt_1000' : app.doc.all<TypeEl>('type').find((t) => t.of === 'railing')?.id;
        for (const side of [1, -1] as const) app.doc.add({ id: newId('rl'), cat: 'railing', typeId: rt, levelId: s.levelId, baseOffset: 0, path: [], hostId: s.id, side } as El);
      }
      if (hasStairJoints(s)) syncStairBearings(app.doc, s);
    });
    app.select([id]);
    this.start = null; this.cur = null;
  }
  move(e: ToolEvent): void { this.cur = e.p; }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.start || !this.cur || dist(this.start, this.cur) < 10) {
      if (this.cur) dl.circle(this.cur, 1.2 * vp.view.scale, PREVIEW, undefined, { ns: true });
      return;
    }
    const el = this.proto(norm(sub(this.cur, this.start)));
    const g = stairGeom(app.doc, el);
    const view = vp.view as View;
    drawStair({ dl, doc: app.doc, view }, el, g, Infinity, false, PREVIEW, null);
    const sc = view.scale;
    const txt = `${g.n} Steigungen à ${fmtNum(g.r, 1)} mm, Auftritt ${fmtLen(g.t)}`;
    dl.text(add(this.cur, { x: 3 * sc, y: -3 * sc }), txt, { size: 2.4, color: '#1b3f66', opaque: true });
  }
}

registerCommand({ id: 'stair', label: 'Treppe', icon: 'stair', tip: 'Treppe nach Bauteil: Antritt und Laufrichtung klicken. Form gerade, L- oder U-förmig; Steigungen werden aus der Geschosshöhe berechnet.', run: () => startTool(new StairTool(), 'stair') });
registerSimilar('stair', 'stair');

