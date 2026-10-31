// Leitungen: Rohre (Heizung/Sanitär, Gefälle mit automatischer Höhe entlang des Strangs), Lüftungskanäle
// (rund/eckig) und Leerrohre/Kabeltrassen. Segmente wie Wände (a → b, Höhe je Ende); Bögen an verbundenen
// Knicken werden automatisch erzeugt (Grundriss zweilinig, 3D, Schnitt). Steigleitungen: a = b, Höhe unten/oben.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, sub, mul, norm, perp, dist, mid, dot, apply, projectT, offsetPolyline, fromAngle, to2, pointInPoly } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, PlanCtx, Solid, Grip } from '../../core/registry';
import { levelElev, levelAbove, isPlanLike, levelOptions } from '../../core/view';
import { cached } from '../../core/cache';
import { cutPolysOfElement } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtLen, fmtNum } from '../../core/units';
import { normTextAngle } from '../../elements/datums';
import { floorArea, floorTop, floorThick } from '../architecture/floor';
import { surfaceOf } from '../../views/surfaces';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool, PREVIEW, PREVIEW_THIN } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import {
  MepSystem, sysOf, sysPen, systemOptions, CAT_DISC, DEFAULT_SYS, planBand, discVisible, sweep, circleProfile, rectProfile,
  add3, sub3, mul3, dot3, norm3, len3, fmtMm,
} from './common';

export type RunCat = 'pipe' | 'duct' | 'conduit';
export const RUN_CATS: RunCat[] = ['pipe', 'duct', 'conduit'];
export const RUN_LABEL: Record<RunCat, [string, string]> = { pipe: ['Rohr', 'Rohre'], duct: ['Lüftungskanal', 'Lüftungskanäle'], conduit: ['Leerrohr / Trasse', 'Leerrohre / Kabeltrassen'] };
export const isRun = (el: El | undefined): el is MepRun => !!el && (RUN_CATS as string[]).includes(el.cat);

export interface MepRun extends El {
  cat: RunCat;
  levelId: Id;
  a: V2; b: V2;
  /** Höhe der Achse bei a über der Ebene */
  offset: number;
  /** Höhe der Achse bei b über der Ebene (Steigleitung / geneigt); ohne Angabe: aus Gefälle bzw. = offset */
  offsetB?: number;
  /** Gefälle in % (nur Rohre), positiv = fällt von a nach b */
  slope?: number;
  system?: Id;
  shape?: 'round' | 'rect';
  dia?: number;
  w?: number; h?: number;
  /** Dämmstärke */
  ins?: number;
}

/** Vorgabe-Typen und -Höhen je Kategorie */
export const DEFAULT_TYPE: Record<RunCat, Id> = { pipe: 'mpt_mvr', duct: 'mdt_wfr', conduit: 'mct_krf' };
export const DEFAULT_OFFSET: Record<RunCat, number> = { pipe: 2400, duct: 2500, conduit: 2550 };
export const INS_MAT = 'm_daemm';

// ------------------------------------------------------------ Geometrie
export function runShape(doc: Doc, el: El): 'round' | 'rect' {
  if (el.cat === 'pipe') return 'round';
  return el.shape ?? doc.get(el.typeId)?.shape ?? 'round';
}
export function runSize(doc: Doc, el: El): { round: boolean; W: number; H: number } {
  const t = doc.get(el.typeId);
  if (runShape(doc, el) === 'round') { const d = el.dia ?? t?.dia ?? 25; return { round: true, W: d, H: d }; }
  return { round: false, W: el.w ?? t?.w ?? 300, H: el.h ?? t?.h ?? 200 };
}
export function runZ(doc: Doc, el: El): [number, number] {
  const base = levelElev(doc, el.levelId);
  const zA = base + (el.offset ?? 0);
  const L2 = dist(el.a, el.b);
  if (el.slope && L2 > 0.5) return [zA, zA - (el.slope / 100) * L2];
  if (el.offsetB !== undefined && el.offsetB !== null) return [zA, base + el.offsetB];
  return [zA, zA];
}
export function sizeLabel(doc: Doc, el: El): string {
  const s = runSize(doc, el);
  if (!s.round) return `${fmtMm(s.W)}×${fmtMm(s.H)}`;
  const pre = doc.get(el.typeId)?.sizePrefix;
  return (typeof pre === 'string' ? pre : el.cat === 'conduit' ? 'M' : 'Ø') + fmtMm(s.W);
}

export interface RunInfo {
  el: MepRun; A: V3; B: V3; d: V3; L: number; L2: number; d2: V2;
  vertical: boolean; round: boolean; W: number; H: number; ins: number; sys: MepSystem;
}
export function runInfo(doc: Doc, el: El): RunInfo {
  const calc = (): RunInfo => {
    const [zA, zB] = runZ(doc, el);
    const A = { x: el.a.x, y: el.a.y, z: zA }, B = { x: el.b.x, y: el.b.y, z: zB };
    const v = sub3(B, A); const L = len3(v); const L2 = dist(el.a, el.b);
    const sz = runSize(doc, el);
    return {
      el: el as MepRun, A, B, d: L > 1e-6 ? mul3(v, 1 / L) : { x: 1, y: 0, z: 0 }, L, L2, d2: L2 > 1e-6 ? norm(sub(el.b, el.a)) : { x: 1, y: 0 },
      vertical: L2 < 1 && L > 1, round: sz.round, W: sz.W, H: sz.H, ins: Math.max(0, el.ins ?? 0), sys: sysOf(doc, el),
    };
  };
  return el.id ? cached(doc, 'mepRun', el.id, calc) : calc();
}
/** Höhe der Achse an Planpunkt p (Projektion auf die Leitung) */
export function runZAt(doc: Doc, el: El, p: V2): number {
  const [zA, zB] = runZ(doc, el);
  const t = dist(el.a, el.b) > 0.5 ? projectT(p, el.a, el.b) : 0;
  return zA + (zB - zA) * t;
}

/** Geschossdecke, in deren Stärke die (waagrechte) Leitung liegt – einbetoniert (Einlegerohr) */
export function slabOf(doc: Doc, el: El): El | null {
  const calc = (): El | null => {
    const ri = runInfo(doc, el); if (ri.vertical) return null;
    const zl = Math.min(ri.A.z, ri.B.z) - ri.H / 2, zh = Math.max(ri.A.z, ri.B.z) + ri.H / 2;
    const m = mid(el.a, el.b);
    for (const f of doc.all('floor')) {
      const sf = surfaceOf(doc, f); // geneigte Decke: Höhen in der Leitungsmitte
      const top = sf && !sf.flat ? sf.topAt(m) : floorTop(doc, f), bot = top - floorThick(doc, f);
      if (zl >= bot - 1 && zh <= top + 1 && floorArea(doc, f).some((poly) => pointInPoly(m, poly))) return f;
    }
    return null;
  };
  return el.id ? cached(doc, 'mepInSlab', el.id, calc) : calc();
}

// ------------------------------------------------------------ Verbindungen und Bögen
interface EndRef { id: Id; end: 'a' | 'b'; P: V3 }
export interface Bend { owner: Id; ids: [Id, Id]; P: V3; t: number; R: number; pts: V3[] }
interface Joins { partners: Map<string, EndRef[]>; bends: Map<string, Bend> }
const ek = (id: Id, end: 'a' | 'b') => id + '|' + end;

/** Bogen zwischen ankommender (dIn) und abgehender (dOut) Richtung am Knick P */
export function elbowPath(P: V3, dIn: V3, dOut: V3, R: number, maxT: number): { t: number; R: number; pts: V3[] } | null {
  const c = Math.max(-1, Math.min(1, dot3(dIn, dOut)));
  const phi = Math.acos(c);
  if (phi < 0.035 || phi > Math.PI - 0.035) return null;
  let t = R * Math.tan(phi / 2);
  if (t > maxT) { t = maxT; R = t / Math.tan(phi / 2); }
  if (t < 0.5) return null;
  const T0 = sub3(P, mul3(dIn, t)), T1 = add3(P, mul3(dOut, t));
  const C = add3(P, mul3(norm3(sub3(dOut, dIn)), R / Math.cos(phi / 2)));
  const e0 = norm3(sub3(T0, C)); const w = sub3(T1, C);
  const e1 = norm3(sub3(w, mul3(e0, dot3(w, e0))));
  const n = Math.max(3, Math.ceil(phi / (Math.PI / 16)));
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) { const s = (phi * i) / n; pts.push(add3(C, add3(mul3(e0, Math.cos(s) * R), mul3(e1, Math.sin(s) * R)))); }
  pts[0] = T0; pts[n] = T1;
  return { t, R, pts };
}

function bendRadius(cat: string, ri: RunInfo): number {
  if (cat === 'duct') return ri.round ? ri.W : ri.W * 0.75 + 50;
  return Math.max(ri.W * 1.5, 20);
}

export function joins(doc: Doc): Joins {
  return cached(doc, 'mepJoins', '', () => {
    const partners = new Map<string, EndRef[]>(); const bends = new Map<string, Bend>();
    for (const cat of RUN_CATS) {
      const grid = new Map<string, (EndRef & { cat: string })[]>();
      const ends: EndRef[] = [];
      for (const el of doc.all<MepRun>(cat)) {
        const ri = runInfo(doc, el);
        for (const [end, P] of [['a', ri.A], ['b', ri.B]] as ['a' | 'b', V3][]) {
          const e = { id: el.id, end, P, cat };
          ends.push(e);
          const k = Math.round(P.x / 4) + ',' + Math.round(P.y / 4);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
        }
      }
      for (const e of ends) {
        const list: EndRef[] = [];
        const gx = Math.round(e.P.x / 4), gy = Math.round(e.P.y / 4);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const f of grid.get((gx + i) + ',' + (gy + j)) ?? []) {
          if (f.id === e.id) continue;
          if (Math.hypot(f.P.x - e.P.x, f.P.y - e.P.y) <= 3 && Math.abs(f.P.z - e.P.z) <= 3) list.push(f);
        }
        partners.set(ek(e.id, e.end), list);
      }
      // Bögen: genau zwei Leitungen an einem Punkt
      for (const e of ends) {
        const ps = partners.get(ek(e.id, e.end))!;
        if (ps.length !== 1) continue;
        const f = ps[0];
        if (partners.get(ek(f.id, f.end))!.length !== 1) continue;
        // ankommend: Ende b (sonst kleinere ID)
        let inc = e, out = f;
        if (e.end === 'a' && f.end === 'b') { inc = f; out = e; }
        else if (e.end === f.end && f.id < e.id) { inc = f; out = e; }
        if (inc !== e) continue; // jedes Paar nur einmal
        const ri = runInfo(doc, doc.get(inc.id)!), ro = runInfo(doc, doc.get(out.id)!);
        if (ri.L < 1 || ro.L < 1) continue;
        const dIn = inc.end === 'b' ? ri.d : mul3(ri.d, -1);
        const dOut = out.end === 'a' ? ro.d : mul3(ro.d, -1);
        const R = Math.max(bendRadius(cat, ri), bendRadius(cat, ro));
        const el = elbowPath(inc.P, dIn, dOut, R, 0.45 * Math.min(ri.L, ro.L));
        if (!el) continue;
        const b: Bend = { owner: inc.id, ids: [inc.id, out.id], P: inc.P, t: el.t, R: el.R, pts: el.pts };
        bends.set(ek(inc.id, inc.end), b); bends.set(ek(out.id, out.end), b);
      }
    }
    return { partners, bends };
  });
}
export const partnersOf = (doc: Doc, id: Id, end: 'a' | 'b'): EndRef[] => joins(doc).partners.get(ek(id, end)) ?? [];
export const bendAt = (doc: Doc, id: Id, end: 'a' | 'b'): Bend | undefined => joins(doc).bends.get(ek(id, end));

/** Gerader Teil der Leitung (um Bögen gekürzt) */
export function trimmed(doc: Doc, ri: RunInfo): [V3, V3] {
  const id = ri.el.id;
  const ta = id ? bendAt(doc, id, 'a')?.t ?? 0 : 0, tb = id ? bendAt(doc, id, 'b')?.t ?? 0 : 0;
  return [add3(ri.A, mul3(ri.d, ta)), sub3(ri.B, mul3(ri.d, tb))];
}

// ------------------------------------------------------------ Grundriss
/** zweilinig darstellen? (grob: einlinig; mittel: Kanäle zweilinig; fein: alles zweilinig; zu klein → einlinig) */
export function isDouble(detail: string, cat: string, W: number, scale: number): boolean {
  if (W / scale < 0.6) return false;
  if (detail === 'fine') return true;
  if (detail === 'medium') return cat === 'duct' || (cat === 'conduit' && W >= 100);
  return false;
}

function arrowHead(dl: DisplayList, tip: V2, dir: V2, len: number, pen: Pen): void {
  const n = perp(dir);
  dl.fill([[tip, add(sub(tip, mul(dir, len)), mul(n, len * 0.35)), sub(sub(tip, mul(dir, len)), mul(n, len * 0.35))]], { color: pen.color ?? '#000000', pattern: 'solid', patColor: pen.color ?? '#000000' }, { ...pen, w: 1, dash: undefined }, { ns: true });
}
/** lesbare Textdrehung entlang Richtung d */
const textRot = (d: V2) => normTextAngle(Math.atan2(d.y, d.x));

export function drawRunPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; const s = ctx.view.scale || 100;
  const ri = runInfo(doc, el); const sys = ri.sys;
  const [lo, hi] = planBand(ctx);
  const zl = Math.min(ri.A.z, ri.B.z) - ri.H / 2, zh = Math.max(ri.A.z, ri.B.z) + ri.H / 2;
  if (zh < lo || zl > hi) return;
  // in der Decke einbetoniert (Einlegerohr): gestrichelt wie in Schweizer HLKSE-Plänen
  const emb = !ri.vertical && sys.dash === 'solid' && !!slabOf(doc, el);
  const pen = sysPen(sys, undefined, emb ? 'dash' : undefined);
  if (ri.vertical) { drawRiser(dl, ri, s, lo, hi, pen); return; }
  const [Ta, Tb] = trimmed(doc, ri);
  const A2 = to2(Ta), B2 = to2(Tb);
  const dbl = isDouble(ctx.detail, el.cat, ri.W, s);
  const n = perp(ri.d2); const hw = ri.W / 2;
  if (!dbl) {
    dl.line(el.a, el.b, pen);
  } else {
    const op: Pen = { w: 2, color: sys.color, dash: pen.dash };
    dl.fill([[add(A2, mul(n, hw)), add(B2, mul(n, hw)), sub(B2, mul(n, hw)), sub(A2, mul(n, hw))]], { color: 'transparent' }, undefined, { ns: true });
    dl.line(add(A2, mul(n, hw)), add(B2, mul(n, hw)), op);
    dl.line(sub(A2, mul(n, hw)), sub(B2, mul(n, hw)), op);
    dl.line(el.a, el.b, { w: 1, color: sys.color }, { inv: true });
    for (const [end, P] of [['a', A2], ['b', B2]] as ['a' | 'b', V2][]) {
      if (!partnersOf(doc, el.id, end).length) dl.line(add(P, mul(n, hw)), sub(P, mul(n, hw)), op);
    }
    if (ctx.detail === 'fine' && ri.ins > 0) {
      const ip: Pen = { w: 1, color: sys.color, dash: 'hidden' }; const iw = hw + ri.ins;
      dl.line(add(A2, mul(n, iw)), add(B2, mul(n, iw)), ip, { ns: true });
      dl.line(sub(A2, mul(n, iw)), sub(B2, mul(n, iw)), ip, { ns: true });
    }
    // Bögen (vom ankommenden Element gezeichnet)
    for (const end of ['a', 'b'] as const) {
      const bd = bendAt(doc, el.id, end);
      if (!bd || bd.owner !== el.id) continue;
      const pts = bd.pts.map(to2);
      if (Math.abs(bd.pts[0].z - bd.pts[bd.pts.length - 1].z) > hw && dist(pts[0], pts[pts.length - 1]) < hw) continue; // senkrechter Bogen
      dl.poly(offsetPolyline(pts, hw, false), op, false);
      dl.poly(offsetPolyline(pts, -hw, false), op, false);
      dl.poly(pts, { w: 1, color: sys.color }, false, { inv: true });
    }
  }
  // Fliessrichtung
  const L2 = dist(A2, B2);
  if (sys.flow && ctx.detail !== 'coarse' && L2 > 10 * s) {
    const m = mid(A2, B2); const al = 2.2 * s;
    arrowHead(dl, add(m, mul(ri.d2, al / 2)), ri.d2, al, pen);
  }
  // Gefälle: Pfeil mit Prozentangabe
  if (el.cat === 'pipe' && el.slope && L2 > 12 * s) {
    const fall = el.slope > 0 ? ri.d2 : mul(ri.d2, -1);
    const side = dbl ? hw + 2.2 * s : 2.2 * s;
    const m = add(mid(A2, B2), mul(n, side + 1.5 * s));
    const p0 = sub(m, mul(fall, 4 * s)), p1 = add(m, mul(fall, 4 * s));
    const ap: Pen = { w: 1, color: sys.color };
    dl.line(p0, sub(p1, mul(fall, 1.2 * s)), ap, { ns: true });
    arrowHead(dl, p1, fall, 1.6 * s, ap);
    dl.text(add(m, mul(n, 0.8 * s)), fmtNum(Math.abs(el.slope), 1).replace(/[.,]0$/, '') + ' %',{ size: 2, ha: 'center', va: 'bottom', rot: textRot(fall), color: sys.color });
  }
}

/** Steigleitung im Grundriss: Kreis + Pfeil (steigt: vom Kreis weg, fällt/kommt von oben: zum Kreis hin) */
function drawRiser(dl: DisplayList, ri: RunInfo, s: number, lo: number, hi: number, pen: Pen): void {
  const c = to2(ri.A); const r = Math.max(ri.W / 2, 1.2 * s);
  const p: Pen = { ...pen, dash: undefined, w: Math.max(2, pen.w - 1) };
  dl.circle(c, r, p, { color: '#ffffff' });
  dl.circle(c, Math.max(0.25 * s, 1), p, { color: pen.color ?? '#000000', pattern: 'solid', patColor: pen.color ?? '#000000' }, { ns: true });
  const zTop = Math.max(ri.A.z, ri.B.z), zBot = Math.min(ri.A.z, ri.B.z);
  const d = fromAngle(Math.PI / 4); const ap: Pen = { w: 1, color: pen.color };
  if (zTop > hi) { const q0 = add(c, mul(d, r)), q1 = add(c, mul(d, r + 3.5 * s)); dl.line(q0, sub(q1, mul(d, 1.2 * s)), ap, { ns: true }); arrowHead(dl, q1, d, 1.4 * s, ap); }
  if (zBot < lo) { const dd = mul(d, -1); const q0 = add(c, mul(dd, r + 3.5 * s)), q1 = add(c, mul(dd, r)); dl.line(q0, sub(q1, mul(d, -1.2 * s)), ap, { ns: true }); arrowHead(dl, q1, d, 1.4 * s, ap); }
}

// ------------------------------------------------------------ 3D-Körper
function profileOf(ri: RunInfo, extra = 0): V2[] {
  if (ri.round) return circleProfile(ri.W / 2 + extra, ri.W > 200 ? 20 : ri.W > 60 ? 16 : 12);
  return rectProfile(ri.W + 2 * extra, ri.H + 2 * extra);
}
export function runSolids(doc: Doc, el: El): Solid[] {
  const ri = runInfo(doc, el); if (ri.L < 1) return [];
  const [Ta, Tb] = trimmed(doc, ri);
  const paths: V3[][] = [[Ta, Tb]];
  for (const end of ['a', 'b'] as const) { const bd = el.id ? bendAt(doc, el.id, end) : undefined; if (bd && bd.owner === el.id) paths.push(bd.pts); }
  const out: Solid[] = [];
  for (const p of paths) out.push({ faces: sweep(p, profileOf(ri)), color: ri.sys.color, role: 'mep' });
  if (ri.ins > 0) for (const p of paths) out.push({ faces: sweep(p, profileOf(ri, ri.ins)), mat: doc.get(INS_MAT) ? INS_MAT : undefined, color: doc.get(INS_MAT) ? undefined : '#f2e8a0', role: 'insulation' });
  return out;
}

// ------------------------------------------------------------ Eigenschaften
const zRel = (doc: Doc, el: El, z: number) => z - levelElev(doc, el.levelId);
export function runProps(el: El, doc: Doc): PropDef[] {
  const g = GROUPS; const cat = el.cat as RunCat;
  const round = runShape(doc, el) === 'round';
  const M = cat === 'conduit' ? 'Elektro' : 'Mechanisch';
  const p: PropDef[] = [
    { key: 'levelId', label: 'Referenzebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (e, v, d) => {
      const dz = levelElev(d, e.levelId) - levelElev(d, v);
      return { levelId: v, offset: (e.offset ?? 0) + dz, ...(e.offsetB !== undefined ? { offsetB: e.offsetB + dz } : {}) };
    } },
    { key: 'offset', label: 'Höhe Anfang (Achse)', group: g.constraints, type: 'length', get: (e) => e.offset ?? 0, set: (_e, v) => ({ offset: v }) },
    { key: 'offsetB', label: 'Höhe Ende (Achse)', group: g.constraints, type: 'length', get: (e, d) => zRel(d, e, runZ(d, e)[1]),
      set: (e, v) => {
        const L2 = dist(e.a, e.b);
        if (e.slope && L2 > 1) return { slope: Math.round(((e.offset ?? 0) - v) / L2 * 100 * 1000) / 1000 };
        return { offsetB: v };
      } },
  ];
  if (cat === 'pipe') p.push({ key: 'slope', label: 'Gefälle (%)', group: g.constraints, type: 'number', get: (e) => e.slope ?? 0, set: (_e, v) => ({ slope: v || undefined, offsetB: undefined }) });
  p.push(
    { key: 'system', label: 'Systemtyp', group: M, type: 'select', options: (d) => systemOptions(d, CAT_DISC[cat]), get: (e, d) => sysOf(d, e).id, set: (_e, v) => ({ system: v }) },
    { key: 'sysAbbr', label: 'Systemkürzel', group: M, type: 'readonly', get: (e, d) => sysOf(d, e).abbr },
  );
  if (cat !== 'pipe') p.push({ key: 'shape', label: 'Form', group: g.dims, type: 'select', options: [['round', 'Rund'], ['rect', 'Rechteckig']], get: (e, d) => runShape(d, e), set: (_e, v) => ({ shape: v }) });
  if (round) p.push({ key: 'dia', label: cat === 'conduit' ? 'Nenngrösse (Aussen-Ø)' : 'Aussendurchmesser', group: g.dims, type: 'length', get: (e, d) => runSize(d, e).W, set: (_e, v) => ({ dia: Math.max(5, v) }) });
  else p.push(
    { key: 'w', label: 'Breite', group: g.dims, type: 'length', get: (e, d) => runSize(d, e).W, set: (_e, v) => ({ w: Math.max(10, v) }) },
    { key: 'h', label: 'Höhe', group: g.dims, type: 'length', get: (e, d) => runSize(d, e).H, set: (_e, v) => ({ h: Math.max(10, v) }) },
  );
  p.push(
    { key: 'ins', label: 'Dämmstärke', group: g.dims, type: 'length', get: (e) => e.ins ?? 0, set: (_e, v) => ({ ins: Math.max(0, v) || undefined }) },
    { key: 'size', label: 'Grösse', group: g.dims, type: 'readonly', get: (e, d) => sizeLabel(d, e) },
    { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e, d) => fmtLen(runInfo(d, e).L) },
    { key: 'inSlab', label: 'Einbetoniert in', group: g.constraints, type: 'readonly', get: (e, d) => { const f = e.id ? slabOf(d, e) : null; return f ? (f.mark || d.get(f.typeId)?.name || 'Decke') : '–'; } },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
  );
  return p;
}
function runTypeProps(cat: RunCat): PropDef[] {
  const g = GROUPS;
  const p: PropDef[] = [
    { key: 'werkstoff', label: 'Werkstoff', group: g.materials, type: 'text', get: (t) => t.werkstoff ?? '', set: (_t, v) => ({ werkstoff: v }) },
    { key: 'system', label: 'Vorgabe-System', group: 'Mechanisch', type: 'select', options: (d) => [['', '–'], ...systemOptions(d, CAT_DISC[cat])], get: (t) => t.system ?? '', set: (_t, v) => ({ system: v || undefined }) },
    { key: 'flexible', label: 'Flexibel', group: g.construction, type: 'bool', get: (t) => !!t.flexible, set: (_t, v) => ({ flexible: v }) },
    { key: 'sizePrefix', label: 'Grössenbezeichnung (Ø, DN, M)', group: g.identity, type: 'text', get: (t) => t.sizePrefix ?? (cat === 'conduit' ? 'M' : 'Ø'), set: (_t, v) => ({ sizePrefix: v }) },
  ];
  if (cat !== 'pipe') p.push({ key: 'shape', label: 'Form', group: g.dims, type: 'select', options: [['round', 'Rund'], ['rect', 'Rechteckig']], get: (t) => t.shape ?? 'round', set: (_t, v) => ({ shape: v }) });
  p.push(
    { key: 'dia', label: 'Vorgabe-Durchmesser', group: g.dims, type: 'length', get: (t) => t.dia ?? 25, set: (_t, v) => ({ dia: v }) },
    { key: 'w', label: 'Vorgabe-Breite', group: g.dims, type: 'length', get: (t) => t.w ?? 300, set: (_t, v) => ({ w: v }) },
    { key: 'h', label: 'Vorgabe-Höhe', group: g.dims, type: 'length', get: (t) => t.h ?? 200, set: (_t, v) => ({ h: v }) },
  );
  return p;
}

function tagText(el: El, doc: Doc): string {
  const sys = sysOf(doc, el);
  let s = `${sys.abbr} ${sizeLabel(doc, el)}`.trim();
  if (el.cat === 'pipe' && el.slope) s += ` ${fmtNum(Math.abs(el.slope), 1).replace(/[.,]0$/, '')} %`;
  return s;
}

const IFC_ENT: Record<RunCat, string> = { pipe: 'IfcPipeSegment', duct: 'IfcDuctSegment', conduit: 'IfcCableCarrierSegment' };

// ------------------------------------------------------------ Kategorien
for (const cat of RUN_CATS) {
  registerCategory({
    cat, label: RUN_LABEL[cat][0], plural: RUN_LABEL[cat][1], hasTypes: true, planOrder: 60,
    visibleIn: (el, doc, view) => discVisible(view, sysOf(doc, el).disc),
    drawPlan: drawRunPlan,
    solids: (el, doc) => runSolids(doc, el),
    drawSection: (ctx, el) => {
      const ri = runInfo(ctx.doc, el); const col = ri.sys.color;
      for (const c of cutPolysOfElement(ctx.doc, el, { toView: ctx.toView, depth: ctx.depth, dir: ctx.dir, origin: ctx.origin })) {
        const ins = c.mat === INS_MAT;
        for (const poly of c.polys) for (const r of poly) {
          ctx.dl.poly(r, ins ? { w: 1, color: col, dash: 'hidden' } : { w: 2, color: col }, true, { ns: ins });
          if (!ins && !ri.round && r.length === 4) { ctx.dl.line(r[0], r[2], { w: 1, color: col }, { ns: true }); ctx.dl.line(r[1], r[3], { w: 1, color: col }, { ns: true }); }
        }
      }
    },
    grips: (el, doc, view): Grip[] => {
      if (!isPlanLike(view) || runInfo(doc, el).vertical) return [];
      return [{ id: 'a', p: el.a, kind: 'end', tip: 'Anfang' }, { id: 'b', p: el.b, kind: 'end', tip: 'Ende' }];
    },
    dragGrip: (el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
    transform: (el, m, _doc, view) => (isPlanLike(view) ? { a: apply(m, el.a), b: apply(m, el.b) } : undefined),
    translate3d: (el, d) => ({ a: { x: el.a.x + d.x, y: el.a.y + d.y }, b: { x: el.b.x + d.x, y: el.b.y + d.y }, offset: (el.offset ?? 0) + d.z, ...(el.offsetB !== undefined ? { offsetB: el.offsetB + d.z } : {}) }),
    center: (el) => mid(el.a, el.b),
    curve: (el, doc, view) => (isPlanLike(view) && !runInfo(doc, el).vertical ? { a: el.a, b: el.b } : null),
    setCurve: (el, a, b, doc) => {
      const base = levelElev(doc, el.levelId);
      const patch: Partial<MepRun> = { a, b, offset: runZAt(doc, el, a) - base };
      if (!el.slope && el.offsetB !== undefined) patch.offsetB = runZAt(doc, el, b) - base;
      return patch;
    },
    tempDims: (el, doc, view) => {
      if (!isPlanLike(view)) return [];
      const ri = runInfo(doc, el); if (ri.vertical) return [];
      const off = mul(perp(ri.d2), ri.W / 2 + view.scale * 5);
      return [{ a: add(el.a, off), b: add(el.b, off), value: ri.L2, apply: (v) => doc.update(el.id, { b: add(el.a, mul(ri.d2, v)) }) }];
    },
    props: (el, doc) => runProps(el, doc),
    typeProps: () => runTypeProps(cat),
    tagText,
    tagPoint: (el) => mid(el.a, el.b),
    scheduleFields: () => [
      { key: 'system', label: 'System', get: (el, doc) => sysOf(doc, el).name },
      { key: 'abbr', label: 'Kürzel', get: (el, doc) => sysOf(doc, el).abbr },
      { key: 'disc', label: 'Gewerk', get: (el, doc) => ({ H: 'Heizung', L: 'Lüftung', S: 'Sanitär', E: 'Elektro' } as Record<string, string>)[sysOf(doc, el).disc] ?? '' },
      { key: 'size', label: 'Grösse', get: (el, doc) => sizeLabel(doc, el) },
      { key: 'dia', label: 'Durchmesser', unit: 'len', get: (el, doc) => (runSize(doc, el).round ? runSize(doc, el).W : '') },
      { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => runInfo(doc, el).L },
      { key: 'slope', label: 'Gefälle (%)', unit: 'num', get: (el) => el.slope ?? 0 },
      { key: 'zA', label: 'Höhe Anfang', unit: 'len', get: (el, doc) => runZ(doc, el)[0] - levelElev(doc, el.levelId) },
      { key: 'werkstoff', label: 'Werkstoff', get: (el, doc) => doc.get(el.typeId)?.werkstoff ?? '' },
    ],
    ifc: (el, doc) => {
      const ri = runInfo(doc, el); const t = doc.get(el.typeId);
      const earth = cat === 'conduit' && ri.sys.ifc === 'EARTHING';
      const predefined = earth ? 'CONDUCTORSEGMENT' : cat === 'conduit' ? (ri.round ? 'CONDUITSEGMENT' : 'CABLETRAYSEGMENT') : t?.flexible ? 'FLEXIBLESEGMENT' : 'RIGIDSEGMENT';
      const psets: Record<string, Record<string, string | number | boolean>> = {
        Pset_OpenRiss_HLKSE: { System: ri.sys.name, Kuerzel: ri.sys.abbr, Systemart: ri.sys.ifc ?? '', Groesse: sizeLabel(doc, el), Laenge: Math.round(ri.L), Gefaelle: el.slope ?? 0, Daemmstaerke: ri.ins, Werkstoff: t?.werkstoff ?? '' },
      };
      if (cat === 'pipe') psets.Pset_PipeSegmentTypeCommon = { OuterDiameter: ri.W, NominalDiameter: ri.W, Reference: t?.name ?? '' };
      if (cat === 'duct') psets.Pset_DuctSegmentTypeCommon = { Shape: ri.round ? 'ROUND' : 'RECTANGULAR', Reference: t?.name ?? '' };
      return { entity: earth ? 'IfcCableSegment' : IFC_ENT[cat], predefined, name: tagText(el, doc), psets };
    },
  });
}

// ------------------------------------------------------------ Erzeugen (auch für Skripte/API)
export interface RunInput { levelId: Id; pts: V2[]; offset?: number; slope?: number; system?: Id; typeId?: Id; dia?: number; w?: number; h?: number; shape?: 'round' | 'rect'; ins?: number; offsetEnd?: number }
/** Leitungszug aus Punkten erzeugen (innerhalb einer Transaktion). Höhen folgen dem Gefälle bzw. werden linear bis offsetEnd geführt. */
export function addRunChain(doc: Doc, cat: RunCat, o: RunInput): MepRun[] {
  const out: MepRun[] = [];
  const total = o.pts.reduce((s, p, i) => (i ? s + dist(o.pts[i - 1], p) : 0), 0);
  let off = o.offset ?? DEFAULT_OFFSET[cat]; let run = 0;
  for (let i = 0; i + 1 < o.pts.length; i++) {
    const a = o.pts[i], b = o.pts[i + 1]; const L = dist(a, b);
    if (L < 1) continue;
    const el: MepRun = { id: newId('mr'), cat, levelId: o.levelId, a: { ...a }, b: { ...b }, offset: off, system: o.system ?? doc.get(o.typeId)?.system ?? DEFAULT_SYS[cat], typeId: o.typeId ?? DEFAULT_TYPE[cat] } as MepRun;
    if (o.dia !== undefined) el.dia = o.dia;
    if (o.w !== undefined) el.w = o.w;
    if (o.h !== undefined) el.h = o.h;
    if (o.shape) el.shape = o.shape;
    if (o.ins) el.ins = o.ins;
    run += L;
    if (cat === 'pipe' && o.slope) el.slope = o.slope;
    else if (o.offsetEnd !== undefined && total > 0) el.offsetB = (o.offset ?? DEFAULT_OFFSET[cat]) + ((o.offsetEnd - (o.offset ?? DEFAULT_OFFSET[cat])) * run) / total;
    doc.add(el);
    off = zRel(doc, el, runZ(doc, el)[1]);
    out.push(el);
  }
  return out;
}
/** Steigleitung (senkrecht) zwischen zwei Höhen über der Ebene */
export function addRiser(doc: Doc, cat: RunCat, levelId: Id, p: V2, z0: number, z1: number, o: Partial<MepRun> = {}): MepRun {
  return doc.add<MepRun>({ system: DEFAULT_SYS[cat], typeId: DEFAULT_TYPE[cat], ...o, id: newId('mr'), cat, levelId, a: { ...p }, b: { ...p }, offset: z0, offsetB: z1 } as MepRun);
}

/** Gefälle auf verbundene Rohre anwenden: Höhen laufen vom Strang-Anfang (höchster Punkt) stromabwärts mit. */
export function applySlope(doc: Doc, ids: Id[], slope: number): number {
  const set = new Set(ids.filter((id) => doc.get(id)?.cat === 'pipe'));
  // Reihenfolge vor dem Ändern bestimmen (danach stimmen die Höhen an den Knoten nicht mehr überein)
  const succ = new Map<Id, Id[]>(); const hasPred = new Set<Id>();
  for (const id of set) {
    const n = partnersOf(doc, id, 'b').filter((p) => set.has(p.id) && p.end === 'a').map((p) => p.id);
    succ.set(id, n); for (const x of n) hasPred.add(x);
  }
  let n = 0; const done = new Set<Id>();
  const walk = (id: Id, off: number | null) => {
    if (done.has(id)) return; done.add(id);
    const patch: Partial<MepRun> = { slope: slope || undefined, offsetB: undefined };
    if (off !== null) patch.offset = off;
    doc.update(id, patch); n++;
    const cur = doc.get<MepRun>(id)!;
    const zEnd = runZ(doc, cur)[1];
    for (const s of succ.get(id) ?? []) walk(s, zEnd - levelElev(doc, doc.get(s)!.levelId));
  };
  for (const id of set) if (!hasPred.has(id)) walk(id, null);
  for (const id of set) walk(id, null);
  return n;
}

// ------------------------------------------------------------ Werkzeuge
function sizeFromType(t: El | undefined): Partial<MepRun> {
  if (!t) return {};
  const o: Partial<MepRun> = {};
  if (t.shape) o.shape = t.shape;
  if (t.dia) o.dia = t.dia;
  if (t.w) o.w = t.w;
  if (t.h) o.h = t.h;
  return o;
}

export class RunTool extends LineDrawTool {
  id: string; label: string; kinds = ['plan', 'ceiling'];
  modes: any = ['line', 'pick'];
  private lastEnd: { p: V2; off: number } | null = null;
  constructor(public cat: RunCat, id: string, label: string) { super(); this.id = id; this.label = label; }
  activate(): void {
    const lvl = activeLevelId();
    const t0 = app.doc.get(DEFAULT_TYPE[this.cat]);
    const pl = placementFor(this.cat, { levelId: lvl, offset: DEFAULT_OFFSET[this.cat], typeId: t0?.id, system: t0?.system ?? DEFAULT_SYS[this.cat], ...sizeFromType(t0) });
    pl.proto.levelId = lvl;
    const setType = pl.setType;
    pl.setType = (id) => { const t = app.doc.get(id); Object.assign(pl.proto, sizeFromType(t)); if (t?.system) pl.proto.system = t.system; setType(id); };
    this.placement = pl;
  }
  deactivate(): void { rememberProto(this.placement); }
  pickFilter(cat: string): boolean { return super.pickFilter(cat) || (RUN_CATS as string[]).includes(cat); }
  prompt(): string { return this.mode === 'pick' ? 'Wand oder Linie wählen (Versatz beachten).' : super.prompt() + ' Höhe/Gefälle in der Optionsleiste.'; }
  extraOptions(): OptionItem[] {
    const p = this.placement!.proto; const d = app.doc;
    const o: OptionItem[] = [{ kind: 'select', key: 'sys', label: 'System', value: sysOf(d, p).id, options: systemOptions(d, CAT_DISC[this.cat]), onChange: (v) => { p.system = v; app.emit('tool'); } }];
    if (runShape(d, p) === 'round') o.push({ kind: 'length', key: 'dia', label: this.cat === 'conduit' ? 'M' : 'Ø', value: runSize(d, p).W, width: 60, onChange: (v) => { p.dia = Math.max(5, v); } });
    else o.push(
      { kind: 'length', key: 'w', label: 'B', value: runSize(d, p).W, width: 60, onChange: (v) => { p.w = Math.max(10, v); } },
      { kind: 'length', key: 'h', label: 'H', value: runSize(d, p).H, width: 60, onChange: (v) => { p.h = Math.max(10, v); } },
    );
    o.push({ kind: 'length', key: 'off', label: 'Höhe', value: p.offset ?? 0, width: 70, onChange: (v) => { p.offset = v; this.lastEnd = null; } });
    if (this.cat === 'pipe') o.push({ kind: 'number', key: 'slope', label: 'Gefälle %', value: p.slope ?? 0, width: 50, onChange: (v) => { p.slope = v || undefined; } });
    return o;
  }
  createSegment(a: V2, b: V2): void {
    const p = this.placement!.proto; const doc = app.doc;
    const { id: _i, ...rest } = p;
    let off = p.offset ?? 0;
    if (this.lastEnd && dist(this.lastEnd.p, a) < 1) off = this.lastEnd.off;
    const el = { ...rest, id: newId('mr'), cat: this.cat, a, b, levelId: p.levelId || activeLevelId(), offset: off } as MepRun;
    if (!el.slope) delete el.slope;
    delete el.offsetB;
    doc.add(el);
    const zB = zRel(doc, el, runZ(doc, el)[1]);
    this.lastEnd = { p: b, off: zB };
    if (el.slope) p.offset = Math.round(zB * 10) / 10;
  }
  afterCreate(): void { if (!this.chain) this.lastEnd = null; app.emit('tool'); }
  escape(): boolean { this.lastEnd = null; return super.escape(); }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void {
    const W = runSize(app.doc, this.placement!.proto).W;
    dl.line(a, b, PREVIEW);
    if (W > 40) { const n = mul(perp(norm(sub(b, a))), W / 2); dl.line(add(a, n), add(b, n), PREVIEW_THIN); dl.line(sub(a, n), sub(b, n), PREVIEW_THIN); }
  }
}

/** Steigleitung / Fallstrang: senkrechte Leitung an einem Punkt */
export class RiserTool extends Tool {
  id = 'mepRiser'; label = 'Steigleitung'; kinds = ['plan'];
  static cat: RunCat = 'pipe'; static z0 = 0; static z1: number | null = null;
  private cur: V2 | null = null;
  activate(): void {
    const lvl = activeLevelId();
    const cat = RiserTool.cat; const t0 = app.doc.get(DEFAULT_TYPE[cat]);
    this.placement = placementFor(cat, { levelId: lvl, typeId: t0?.id, system: t0?.system ?? DEFAULT_SYS[cat], ...sizeFromType(t0) });
    this.placement.proto.levelId = lvl;
    if (RiserTool.z1 === null) { const ab = levelAbove(app.doc, lvl); RiserTool.z1 = ab ? ab.elev - levelElev(app.doc, lvl) : 3000; }
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Klicken Sie, um eine senkrechte Leitung (Steig-/Fallleitung) zu platzieren.'; }
  options(): OptionItem[] {
    const p = this.placement!.proto; const d = app.doc;
    return [
      { kind: 'select', key: 'cat', label: 'Art', value: RiserTool.cat, options: RUN_CATS.map((c) => [c, RUN_LABEL[c][0]] as [string, string]), onChange: (v) => { RiserTool.cat = v as RunCat; rememberProto(this.placement); this.activate(); app.emit('tool'); } },
      { kind: 'select', key: 'sys', label: 'System', value: sysOf(d, p).id, options: systemOptions(d, CAT_DISC[RiserTool.cat]), onChange: (v) => { p.system = v; } },
      { kind: 'length', key: 'dia', label: 'Ø', value: runSize(d, p).W, width: 60, onChange: (v) => { p.dia = Math.max(5, v); p.shape = 'round'; } },
      { kind: 'length', key: 'z0', label: 'Unten', value: RiserTool.z0, width: 70, onChange: (v) => { RiserTool.z0 = v; } },
      { kind: 'length', key: 'z1', label: 'Oben', value: RiserTool.z1 ?? 3000, width: 70, onChange: (v) => { RiserTool.z1 = v; } },
    ];
  }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const p = this.placement!.proto; const { id: _i, cat: _c, ...rest } = p;
    app.doc.transaction('Steigleitung', () => addRiser(app.doc, RiserTool.cat, p.levelId || activeLevelId(e.view), e.p, RiserTool.z0, RiserTool.z1 ?? 3000, rest as Partial<MepRun>));
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const r = Math.max(runSize(app.doc, this.placement!.proto).W / 2, 1.2 * vp.view.scale);
    dl.circle(this.cur, r, PREVIEW);
  }
}

export { levelOptions };
