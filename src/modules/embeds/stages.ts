// Betonieretappen: Etappennummer je Bauteil (Eigenschaft «Etappe») und Unterteilung durch Arbeitsfugen
// (Wand: senkrechte Fugen / Fugen auf Höhe; Platte: Fugenverlauf). Volumen je Etappe, farbige Darstellung
// in Grundriss und Schnitt (Ansichtseigenschaft «Etappen einfärben»).
import type { Doc, El } from '../../core/doc';
import {
  V2, V3, Poly, MultiPoly, add, mul, dist, difference, intersection, segRect, polyArea, pointInPoly, distToSeg, closestOnSeg, sideDist,
  lineLine, interiorPoint, bboxOf, emptyBox, extendBox,
} from '../../core/geom';
import { catDef, GROUPS, PlanCtx, SectionCtx, onHook } from '../../core/registry';
import { isPlanLike, isSectionLike, View } from '../../core/view';
import { cached, hostedBy } from '../../core/cache';
import type { DisplayList, Prim } from '../../render/displayList';
import type { Fill } from '../../render/styles';
import { solidsOf } from '../../views/sectionEngine';
import { Wall, wallOpenings } from '../../elements/wall';
import { wallFrame, slabInfo, stageColor, extendProps, extendScheduleFields, fmtM3 } from './common';
import { Joint, wallJointZ, wallJointRange } from './joint';

/** Kategorien mit Etappen */
export const STAGE_CATS = ['wall', 'floor', 'foundationSlab', 'foundationWall', 'foundationIsolated', 'column', 'beam'];

export interface StagePiece { stage: number; vol: number; poly?: Poly; u0?: number; u1?: number; z0?: number; z1?: number }
export interface StageInfo { pieces: StagePiece[]; kind: 'wall' | 'slab' | 'whole' }

const jointsOf = (doc: Doc, el: El): Joint[] => hostedBy(doc, el.id).filter((e) => e.cat === 'joint') as Joint[];
const maxOf = (c: (number | undefined)[]): number => c.reduce<number>((m, x) => (x && x > m ? x : m), 0);

// ------------------------------------------------------------ Wand: Zellen zwischen Fugen
function wallStages(doc: Doc, w: Wall): StageInfo | null {
  const F = wallFrame(doc, w.id); if (!F) return null;
  const { wi } = F; const js = jointsOf(doc, w);
  const vs = js.filter((j) => j.kind === 'wallV').sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const hs = js.filter((j) => j.kind === 'wallH' && j.at === 'z').map((j) => ({ j, z: wallJointZ(doc, j)! })).filter((x) => x.z > wi.z0 + 1 && x.z < wi.z1 - 1).sort((a, b) => a.z - b.z);
  const base = js.filter((j) => j.kind === 'wallH' && (j.at ?? 'base') === 'base'), head = js.filter((j) => j.kind === 'wallH' && j.at === 'head');
  if (!w.stage && !js.some((j) => j.stageA || j.stageB)) return null;
  const us = [0, ...vs.map((j) => Math.max(0, Math.min(wi.L, j.t ?? 0))), wi.L];
  const zs = [wi.z0, ...hs.map((x) => x.z), wi.z1];
  const ops = wallOpenings(doc, w);
  const pieces: StagePiece[] = [];
  for (let i = 0; i + 1 < us.length; i++) for (let k = 0; k + 1 < zs.length; k++) {
    const u0 = us[i], u1 = us[i + 1], z0 = zs[k], z1 = zs[k + 1];
    if (u1 - u0 < 1 || z1 - z0 < 1) continue;
    const c: (number | undefined)[] = [w.stage];
    if (i > 0) c.push(vs[i - 1].stageB); if (i < vs.length) c.push(vs[i].stageA);
    if (k > 0) c.push(hs[k - 1].j.stageB); if (k < hs.length) c.push(hs[k].j.stageA);
    const ov = (j: Joint) => { const [a, b] = wallJointRange(doc, j); return a < u1 - 1 && b > u0 + 1; };
    if (k === 0) for (const j of base) if (ov(j)) c.push(j.stageB);
    if (k === zs.length - 2) for (const j of head) if (ov(j)) c.push(j.stageA);
    let area = (u1 - u0) * (z1 - z0);
    for (const o of ops) area -= Math.max(0, Math.min(o.u1, u1) - Math.max(o.u0, u0)) * Math.max(0, Math.min(o.z1, z1) - Math.max(o.z0, z0));
    pieces.push({ stage: maxOf(c), vol: Math.max(0, area) * wi.T, u0, u1, z0, z1 });
  }
  return { pieces, kind: 'wall' };
}

// ------------------------------------------------------------ Platte: Teilflächen zwischen Fugen
function slabStages(doc: Doc, el: El): StageInfo | null {
  const sl = slabInfo(doc, el); if (!sl) return null;
  const js = jointsOf(doc, el).filter((j) => j.kind === 'slab' && (j.pts?.length ?? 0) >= 2);
  if (!el.stage && !js.some((j) => j.stageA || j.stageB)) return null;
  let parts: MultiPoly = sl.area;
  if (js.length) {
    const strips: Poly[] = [];
    for (const j of js) { const p = j.pts!; for (let i = 0; i + 1 < p.length; i++) if (dist(p[i], p[i + 1]) > 1) strips.push([segRect(p[i], p[i + 1], 1, 1, i === 0 ? 30 : 1, i === p.length - 2 ? 30 : 1)]); }
    parts = difference(sl.area, ...strips);
  }
  const pieces: StagePiece[] = [];
  for (const poly of parts) {
    const c: (number | undefined)[] = [el.stage];
    for (const j of js) {
      const p = j.pts!; let best = Infinity; let side = 0;
      for (const q of poly[0]) for (let i = 0; i + 1 < p.length; i++) {
        const d = distToSeg(q, p[i], p[i + 1]);
        if (d < best) { best = d; side = sideDist(q, p[i], p[i + 1]); }
      }
      if (best < 4) c.push(side > 0 ? j.stageA : j.stageB);
    }
    pieces.push({ stage: maxOf(c), vol: polyArea(poly) * sl.thick, poly });
  }
  return { pieces, kind: 'slab' };
}

/** Volumen eines Bauteils (Bauteilliste 'volume' bzw. Körper) */
function elementVolume(doc: Doc, el: El): number {
  const f = catDef(el.cat)?.scheduleFields?.().find((x) => x.key === 'volume');
  if (f) { const v = Number(f.get(el, doc)); if (isFinite(v)) return v; }
  return 0;
}

export function stageInfo(doc: Doc, el: El): StageInfo | null {
  if (!STAGE_CATS.includes(el.cat)) return null;
  return cached(doc, 'stageInfo', el.id, () => {
    if (el.cat === 'wall') return wallStages(doc, el as Wall);
    if (el.cat === 'floor' || el.cat === 'foundationSlab') return slabStages(doc, el);
    return el.stage ? { pieces: [{ stage: el.stage, vol: elementVolume(doc, el) }], kind: 'whole' as const } : null;
  });
}

/** Volumen je Etappe eines Bauteils */
export function elementStageVolumes(doc: Doc, el: El): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of stageInfo(doc, el)?.pieces ?? []) if (p.stage) m.set(p.stage, (m.get(p.stage) ?? 0) + p.vol);
  return m;
}
/** Volumen je Etappe im ganzen Projekt (mm³) */
export function stageVolumes(doc: Doc): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of STAGE_CATS) for (const el of doc.all(c)) for (const [s, v] of elementStageVolumes(doc, el)) m.set(s, (m.get(s) ?? 0) + v);
  return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
}
const stagesText = (doc: Doc, el: El): string => [...elementStageVolumes(doc, el).keys()].sort((a, b) => a - b).join(' | ');
const volText = (doc: Doc, el: El): string => [...elementStageVolumes(doc, el).entries()].sort((a, b) => a[0] - b[0]).map(([s, v]) => `E${s}: ${fmtM3(v)}`).join('; ');

// ------------------------------------------------------------ Einfärben
export const stageOn = (v: View): boolean => !!v.stageColors;
const colorFill = (f: Fill, c: string): Fill => (f.pattern === 'solid' ? { ...f, patColor: c, color: c } : { ...f, color: c });

/** Grundriss: Teilflächen (Welt) eines Bauteils auf Höhe z */
function planPieces(doc: Doc, el: El, si: StageInfo, z: number): { poly: Poly; stage: number }[] {
  if (si.kind === 'slab') return si.pieces.filter((p) => p.stage && p.poly).map((p) => ({ poly: p.poly!, stage: p.stage }));
  if (si.kind === 'wall') {
    const F = wallFrame(doc, el.id); if (!F) return [];
    const rows = si.pieces.filter((p) => p.z0! <= z && p.z1! >= z);
    const use = rows.length ? rows : si.pieces.filter((p) => p.z1! >= F.wi.z1 - 1);
    const T = F.wi.T / 2 + 20;
    // Randzellen über die Wandenden hinaus (Eckverbindungen)
    const ext = (u: number) => (u <= 0.5 ? -3 * T : u >= F.wi.L - 0.5 ? F.wi.L + 3 * T : u);
    return use.filter((p) => p.stage).map((p) => ({ poly: [segRect(F.P(ext(p.u0!), 0), F.P(ext(p.u1!), 0), T, T)], stage: p.stage }));
  }
  return [];
}

function recolor(dl: DisplayList, el: El, i0: number, region: (fillRings: Poly) => { rings: Poly; stage: number }[], insertIfNone?: () => { rings: Poly; stage: number }[]): boolean {
  const out: Prim[] = []; let found = false;
  for (let i = i0; i < dl.items.length; i++) {
    const it = dl.items[i];
    out.push(it);
    if (it.o !== el.id || it.k !== 'fill') continue;
    found = true;
    const parts = region(it.rings);
    for (const p of parts) out.push({ ...it, rings: p.rings, fill: colorFill(it.fill, stageColor(p.stage)), pen: undefined });
    if (parts.length && it.pen) out.push({ ...it, fill: { color: 'transparent' } });
  }
  dl.items.length = i0;
  for (const it of out) dl.items.push(it);
  if (!found && insertIfNone && out.some((it) => it.o === el.id)) {
    // nur in Ansicht (nicht geschnitten): aufgehellt als Hintergrund unter allem anderen
    const add: Prim[] = insertIfNone().map((p) => ({ k: 'fill', rings: p.rings, fill: { color: tint(stageColor(p.stage), 0.5) }, o: el.id, ns: true } as Prim));
    dl.items.splice(dl.items[0]?.k === 'clip' ? 1 : 0, 0, ...add);
  }
  (dl as any).boxes = null;
  return found;
}
function tint(hex: string, f: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); if (!m) return hex;
  return '#' + [m[1], m[2], m[3]].map((h) => Math.round(255 - (255 - parseInt(h, 16)) * f).toString(16).padStart(2, '0')).join('');
}

function recolorPlan(ctx: PlanCtx, el: El, i0: number): void {
  const si = stageInfo(ctx.doc, el); if (!si) return;
  if (si.kind === 'whole') { const st = si.pieces[0].stage; recolor(ctx.dl, el, i0, (r) => [{ rings: r, stage: st }]); return; }
  const pcs = planPieces(ctx.doc, el, si, ctx.cutZ); if (!pcs.length) return;
  const clip = (rings: Poly) => pcs.flatMap((p) => intersection(rings, p.poly).map((q) => ({ rings: q, stage: p.stage })));
  const cut = recolor(ctx.dl, el, i0, clip, si.kind === 'slab' ? () => pcs.map((p) => ({ rings: p.poly, stage: p.stage })) : undefined);
  // Etappennummer in geschnittenen Plattenteilen
  if (si.kind === 'slab' && cut) for (const p of pcs) {
    const b = bboxOf(p.poly[0]); if (Math.min(b.max.x - b.min.x, b.max.y - b.min.y) < 25 * ctx.dl.scale) continue;
    ctx.dl.text(interiorPoint(p.poly), 'Etappe ' + p.stage, { size: 3.5, bold: true, color: '#303030', ha: 'center', va: 'middle' }, { o: el.id });
  }
}

/** Schnitt: Schnittflächen (mit Muster) des Bauteils in Bänder zwischen Fugen zerlegen */
function recolorSection(ctx: SectionCtx, el: El): void {
  const { doc, dl } = ctx;
  const si = stageInfo(doc, el); if (!si) return;
  const right2 = { x: ctx.right.x, y: ctx.right.y }; const o2 = { x: ctx.origin.x, y: ctx.origin.y };
  const xOf = (p: V2) => (p.x - o2.x) * right2.x + (p.y - o2.y) * right2.y;
  const xs: number[] = []; const ys: number[] = [];
  let stageAt: (p: V3) => number;
  if (si.kind === 'whole') stageAt = () => si.pieces[0].stage;
  else if (si.kind === 'wall') {
    const F = wallFrame(doc, el.id)!;
    for (const j of jointsOf(doc, el)) {
      if (j.kind === 'wallV') { const x = lineLine(F.P(j.t ?? 0, 0), add(F.P(j.t ?? 0, 0), F.wi.n), o2, add(o2, right2)); if (x) xs.push(xOf(x.p)); }
      if (j.kind === 'wallH' && j.at === 'z') ys.push(wallJointZ(doc, j)! - ctx.origin.z);
    }
    stageAt = (p) => { const u = F.uOf(p); const c = si.pieces.find((q) => u >= q.u0! - 0.5 && u <= q.u1! + 0.5 && p.z >= q.z0! - 0.5 && p.z <= q.z1! + 0.5); return c?.stage ?? 0; };
  } else {
    for (const j of jointsOf(doc, el)) {
      const p = j.pts ?? [];
      for (let i = 0; i + 1 < p.length; i++) { const x = lineLine(p[i], p[i + 1], o2, add(o2, right2)); if (x && x.t >= -0.01 && x.t <= 1.01) xs.push(xOf(x.p)); }
    }
    stageAt = (p) => si.pieces.find((q) => q.poly && pointInPoly({ x: p.x, y: p.y }, q.poly))?.stage ?? 0;
  }
  const out: Prim[] = [];
  for (const it of dl.items) {
    out.push(it);
    if (it.o !== el.id || it.k !== 'fill' || !it.fill.pattern) continue;
    const b = emptyBox(); for (const r of it.rings) for (const q of r) extendBox(b, q);
    const bx = [b.min.x - 1, ...xs.filter((x) => x > b.min.x && x < b.max.x).sort((m, n) => m - n), b.max.x + 1];
    const by = [b.min.y - 1, ...ys.filter((y) => y > b.min.y && y < b.max.y).sort((m, n) => m - n), b.max.y + 1];
    let any = false;
    for (let i = 0; i + 1 < bx.length; i++) for (let k = 0; k + 1 < by.length; k++) {
      const cx = (bx[i] + bx[i + 1]) / 2, cy = (by[k] + by[k + 1]) / 2;
      const st = stageAt(ctx.toWorld({ x: cx, y: cy }));
      if (!st) continue;
      const rect: Poly = [[{ x: bx[i], y: by[k] }, { x: bx[i + 1], y: by[k] }, { x: bx[i + 1], y: by[k + 1] }, { x: bx[i], y: by[k + 1] }]];
      for (const q of intersection(it.rings, rect)) { out.push({ ...it, rings: q, fill: colorFill(it.fill, stageColor(st)), pen: undefined }); any = true; }
    }
    if (any && it.pen) out.push({ ...it, fill: { color: 'transparent' } });
  }
  dl.items = out;
  (dl as any).boxes = null;
}

// ------------------------------------------------------------ Kategorien erweitern (additiv, zur Laufzeit)
function wrapStageDraw(cat: string): void {
  const def = catDef(cat) as any; if (!def || def.__stageWrapped) return;
  def.__stageWrapped = true;
  if (def.drawPlanBatch) {
    const orig = def.drawPlanBatch;
    def.drawPlanBatch = (ctx: PlanCtx, els: El[]) => { const i0 = ctx.dl.items.length; orig(ctx, els); if (stageOn(ctx.view)) for (const el of els) recolorPlan(ctx, el, i0); };
  } else if (def.drawPlan) {
    const orig = def.drawPlan;
    def.drawPlan = (ctx: PlanCtx, el: El) => { const i0 = ctx.dl.items.length; orig(ctx, el); if (stageOn(ctx.view)) recolorPlan(ctx, el, i0); };
  }
  const os = def.drawSection;
  def.drawSection = (ctx: SectionCtx, el: El) => { os?.(ctx, el); if (stageOn(ctx.view)) recolorSection(ctx, el); };
}

export function installStages(): void {
  for (const c of STAGE_CATS) {
    wrapStageDraw(c);
    const def = catDef(c) as any; if (!def || def.__stageProps) continue;
    def.__stageProps = true;
    extendProps(c, () => [
      { key: 'stage', label: 'Etappe', group: 'Etappen', type: 'int', get: (e) => e.stage ?? 0, set: (_e, v) => ({ stage: v > 0 ? Math.round(v) : undefined }) },
      { key: 'stageVol', label: 'Volumen je Etappe', group: 'Etappen', type: 'readonly', get: (e, doc) => (e.id ? volText(doc, e) : '') },
    ]);
    extendScheduleFields(c, () => [
      { key: 'stage', label: 'Etappe', get: (el, doc) => stagesText(doc, el) },
      { key: 'stageVol', label: 'Volumen je Etappe', get: (el, doc) => volText(doc, el) },
    ]);
  }
  const vdef = catDef('view') as any;
  if (vdef && !vdef.__stageProps) {
    vdef.__stageProps = true;
    extendProps('view', (v) => (isPlanLike(v as View) || isSectionLike(v as View)
      ? [{ key: 'stageColors', label: 'Etappen einfärben', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.stageColors, set: (_e, x) => ({ stageColors: !!x || undefined }) }]
      : []));
  }
}
installStages();
onHook('started', installStages);

export { solidsOf, closestOnSeg, mul };
