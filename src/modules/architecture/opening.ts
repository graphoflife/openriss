// Öffnungen: rechteckige oder runde Wandöffnung (in Wand gehostet, rund = Kernbohrung mit Durchmesser und
// Achshöhe), Schachtöffnung (über Höhenbereich, schneidet Geschossdecken/Decken/Dächer) und vertikale Öffnung
// (nur im gewählten Bauteil, auch rund).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, sub, dot, apply, bboxOf, fromAngle, pointInPoly } from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, registerPanel, GROUPS, PropDef, PlanCtx, Grip } from '../../core/registry';
import { levelElev, levelAbove, levelOptions, isPlanLike, isSectionLike, makeProjector } from '../../core/view';
import { catPen } from '../../views/sectionEngine';
import { Wall, wallInfo, wallAt, clipSegToMulti } from '../../elements/wall';
import { placeOnWall } from '../../elements/openings';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import {
  Shaft, shaftRange, shaftArea, transformLoops, moveLoops, loopGrips, dragLoopGrip, loopsCenter, identityProps, levelName, registerSketchEditor, multiArea,
} from './common';

// ------------------------------------------------------------ Wandöffnung
/** shape 'round': Kernbohrung – Durchmesser = width = height, Achse = sill + width/2 */
export interface WallOpening extends El { cat: 'opening'; hostId: Id; t: number; width: number; height: number; sill: number; shape?: 'rect' | 'round' }

// ------------------------------------------------------------ Runde Öffnungen (Kernbohrungen)
const isRound = (o: El) => o.shape === 'round';
/** Schweizer Kote «+1.20», «−1.20», «±0.00» */
export function fmtKoteCH(mm: number): string { const v = mm / 1000; return (v >= 0.005 ? '+' : v <= -0.005 ? '\u2212' : '±') + Math.abs(v).toFixed(2); }
const fmtMm = (mm: number) => String(Math.round(mm));
/** Kreis als Profil (u entlang Wand, z absolut) */
export function roundProfile(u: number, z: number, r: number, n = 32): { u: number; z: number }[] {
  const out: { u: number; z: number }[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push({ u: u + Math.cos(a) * r, z: z + Math.sin(a) * r }); }
  return out;
}
export function circleLoop(c: V2, r: number, n = 32): V2[] { const out: V2[] = []; for (let i = 0; i < n; i++) out.push(add(c, fromAngle((i / n) * Math.PI * 2, r))); return out; }
/** Symbol Kernbohrung: Kreis mit Schrägstrich (Ø) */
export function coreDrillSymbol(dl: DisplayList, c: V2, r: number, pen: Pen): void {
  dl.circle(c, r, pen, { color: '#ffffff' });
  const d = fromAngle(Math.PI / 4, r * 1.45);
  dl.line(sub(c, d), add(c, d), pen, { ns: true });
}
/** Beschriftung «KB Ø200, Achse −1.20» */
export function coreDrillText(doc: Doc, o: El): string {
  const L = local(doc, o); const d = o.width ?? 200;
  return `KB Ø${fmtMm(d)}` + (L ? `, Achse ${fmtKoteCH((L.z0 + L.z1) / 2)}` : '');
}

function local(doc: Doc, o: El) {
  const w = doc.get<Wall>(o.hostId); if (!w) return null;
  const wi = wallInfo(doc, w);
  const P = (u: number, v: number) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
  const W = o.width ?? 1000;
  const z0 = levelElev(doc, w.levelId) + (o.sill ?? 0);
  return { w, wi, P, u0: o.t - W / 2, u1: o.t + W / 2, z0, z1: z0 + (o.height ?? 2000) };
}

function drawWallOpening(ctx: PlanCtx, o: El): void {
  if (ctx.ceiling) return;
  const L = local(ctx.doc, o); if (!L) return;
  if (!(L.wi.z0 <= ctx.cutZ && L.wi.z1 > ctx.cutZ)) return;
  const T = L.wi.T; const rect = [L.P(L.u0, -T / 2), L.P(L.u1, -T / 2), L.P(L.u1, T / 2), L.P(L.u0, T / 2)];
  if (isRound(o)) {
    // Kernbohrung: Symbol Ø in der Wand; nicht geschnitten → Umriss gestrichelt
    ctx.dl.fill([rect], { color: 'transparent' }, undefined, { ns: true });
    const cut = L.z0 <= ctx.cutZ && L.z1 >= ctx.cutZ;
    if (!cut) ctx.dl.poly(rect, { w: 1, dash: 'hidden' }, true, { ns: true });
    const r = Math.max(Math.min((L.u1 - L.u0) / 2, T * 0.45), 1.2 * ctx.dl.scale);
    coreDrillSymbol(ctx.dl, L.P(o.t, 0), r, catPen(ctx.doc, 'opening', false));
    return;
  }
  ctx.dl.fill([rect], { color: 'transparent' }, undefined, { ns: true });
  if (L.z0 > ctx.cutZ) {
    // über der Schnittebene: gestrichelt (Sturz/Öffnung oberhalb)
    ctx.dl.poly(rect, { w: 1, dash: 'hidden' }, true, { ns: true });
  }
}

function wallOpeningProps(el?: El): PropDef[] {
  const g = GROUPS;
  if (el && isRound(el)) return [
    { key: 'shape', label: 'Form', group: g.constraints, type: 'select', options: [['rect', 'Rechteck'], ['round', 'Rund (Kernbohrung)']], get: (e) => e.shape ?? 'rect', set: (_e, v) => ({ shape: v === 'round' ? 'round' : undefined }) },
    { key: 'axis', label: 'Achshöhe über Ebene', group: g.constraints, type: 'length', get: (e) => (e.sill ?? 0) + (e.width ?? 200) / 2, set: (e, v) => ({ sill: v - (e.width ?? 200) / 2 }) },
    { key: 'axisKote', label: 'Achse (Kote)', group: g.constraints, type: 'readonly', get: (e, doc) => { const L = local(doc, e); return L ? fmtKoteCH((L.z0 + L.z1) / 2) : ''; } },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => { const w = doc.get(e.hostId); return w ? 'Wand: ' + (doc.get(w.typeId)?.name ?? '') : ''; } },
    { key: 'dia', label: 'Durchmesser', group: g.dims, type: 'length', get: (e) => e.width ?? 200, set: (e, v) => { const d = Math.max(10, v); const ax = (e.sill ?? 0) + (e.width ?? 200) / 2; return { width: d, height: d, sill: ax - d / 2 }; } },
    { key: 'text', label: 'Beschriftung', group: g.text, type: 'readonly', get: (e, doc) => coreDrillText(doc, e) },
    ...identityProps(),
  ];
  return [
    { key: 'shape', label: 'Form', group: g.constraints, type: 'select', options: [['rect', 'Rechteck'], ['round', 'Rund (Kernbohrung)']], get: (e) => e.shape ?? 'rect',
      set: (e, v) => { if (v !== 'round') return { shape: undefined }; const d = Math.min(e.width ?? 1000, e.height ?? 2000); const ax = (e.sill ?? 0) + (e.height ?? 2000) / 2; return { shape: 'round', width: d, height: d, sill: ax - d / 2 }; } },
    { key: 'sill', label: 'Brüstungshöhe', group: g.constraints, type: 'length', get: (e) => e.sill ?? 0, set: (_e, v) => ({ sill: v }) },
    { key: 'head', label: 'Sturzhöhe', group: g.constraints, type: 'length', get: (e) => (e.sill ?? 0) + (e.height ?? 2000), set: (e, v) => ({ height: Math.max(10, v - (e.sill ?? 0)) }) },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => { const w = doc.get(e.hostId); return w ? 'Wand: ' + (doc.get(w.typeId)?.name ?? '') : ''; } },
    { key: 'width', label: 'Breite', group: g.dims, type: 'length', get: (e) => e.width ?? 1000, set: (_e, v) => ({ width: Math.max(10, v) }) },
    { key: 'height', label: 'Höhe', group: g.dims, type: 'length', get: (e) => e.height ?? 2000, set: (_e, v) => ({ height: Math.max(10, v) }) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'opening', label: 'Wandöffnung', plural: 'Öffnungen', planOrder: 21, hostCats: ['wall'],
  drawPlan: drawWallOpening,
  hostOpening: (el, doc) => {
    const L = local(doc, el); if (!L) return null;
    if (isRound(el)) return { u0: L.u0, u1: L.u1, z0: L.z0, z1: L.z1, profile: roundProfile(el.t, (L.z0 + L.z1) / 2, (L.u1 - L.u0) / 2) };
    return { u0: L.u0, u1: L.u1, z0: L.z0, z1: L.z1 };
  },
  tagText: (el, doc) => {
    if (isRound(el)) return coreDrillText(doc, el);
    const L = local(doc, el); return `${fmtMm(el.width ?? 1000)}/${fmtMm(el.height ?? 2000)}` + (L ? `, UK ${fmtKoteCH(L.z0)}` : '');
  },
  tagPoint: (el, doc) => { const L = local(doc, el); return L ? L.P(el.t, 0) : null; },
  center: (el, doc) => { const L = local(doc, el); return L ? L.P(el.t, 0) : null; },
  grips: (el, doc, view): Grip[] => {
    if (!isPlanLike(view)) return [];
    const L = local(doc, el); if (!L) return [];
    const v = L.wi.T / 2 + view.scale * 3;
    return [{ id: 'l', p: L.P(L.u0, v), kind: 'arrow', dir: mul(L.wi.d, -1), tip: 'Breite ändern' }, { id: 'r', p: L.P(L.u1, v), kind: 'arrow', dir: L.wi.d, tip: 'Breite ändern' }];
  },
  dragGrip: (el, id, p, doc) => {
    const L = local(doc, el); if (!L) return;
    const u = dot(sub(p, L.wi.c0), L.wi.d);
    if (id === 'l' && u < L.u1 - 10) return { t: (u + L.u1) / 2, width: L.u1 - u };
    if (id === 'r' && u > L.u0 + 10) return { t: (L.u0 + u) / 2, width: u - L.u0 };
  },
  transform: (el, m, doc, view) => {
    if (!isPlanLike(view)) return;
    const L = local(doc, el); if (!L) return;
    return placeOnWall(doc, el as any, apply(m, L.P(el.t, 0))) ?? undefined;
  },
  translate3d: (el, d, doc) => { const L = local(doc, el); if (!L) return; return { t: el.t + d.x * L.wi.d.x + d.y * L.wi.d.y, sill: (el.sill ?? 0) + d.z }; },
  tempDims: (el, doc, view) => {
    if (!isPlanLike(view)) return [];
    const L = local(doc, el); if (!L) return [];
    const v = L.wi.ext * (L.wi.T / 2 + view.scale * 5);
    return [
      { a: L.P(0, v), b: L.P(L.u0, v), value: L.u0, apply: (val) => doc.update(el.id, { t: el.t + (val - L.u0) }) },
      { a: L.P(L.u1, v), b: L.P(L.wi.L, v), value: L.wi.L - L.u1, apply: (val) => doc.update(el.id, { t: el.t - (val - (L.wi.L - L.u1)) }) },
    ];
  },
  props: (el) => wallOpeningProps(el),
  scheduleFields: () => [
    { key: 'width', label: 'Breite', unit: 'len', get: (el) => el.width ?? 1000 },
    { key: 'height', label: 'Höhe', unit: 'len', get: (el) => el.height ?? 2000 },
    { key: 'sill', label: 'Brüstungshöhe', unit: 'len', get: (el) => el.sill ?? 0 },
    { key: 'shape', label: 'Form', get: (el) => (isRound(el) ? 'rund' : 'Rechteck') },
    { key: 'dia', label: 'Durchmesser', unit: 'len', get: (el) => (isRound(el) ? el.width ?? 200 : '') },
    { key: 'axis', label: 'Achse (Kote)', get: (el, doc) => { if (!isRound(el)) return ''; const L = local(doc, el); return L ? fmtKoteCH((L.z0 + L.z1) / 2) : ''; } },
    { key: 'text', label: 'Beschriftung', get: (el, doc) => (isRound(el) ? coreDrillText(doc, el) : '') },
  ],
});

const WO = { width: 1000, height: 2000, sill: 0, round: false, dia: 200, axis: 1500 };
class WallOpeningTool extends Tool {
  id = 'wallOpening'; label = 'Wandöffnung'; kinds = ['plan'];
  private host: Wall | null = null; private t = 0;
  prompt(): string { return WO.round ? 'Klicken Sie in eine Wand, um eine Kernbohrung (rund) zu platzieren.' : 'Klicken Sie in eine Wand, um eine rechteckige Wandöffnung zu platzieren.'; }
  options(): OptionItem[] {
    const shape: OptionItem = { kind: 'select', key: 'shape', label: 'Form', value: WO.round ? 'round' : 'rect', options: [['rect', 'Rechteck'], ['round', 'Rund']], onChange: (v) => { WO.round = v === 'round'; app.emit('tool'); app.setPrompt(this.prompt()); } };
    if (WO.round) return [shape,
      { kind: 'length', key: 'd', label: 'Durchmesser', value: WO.dia, onChange: (v) => { WO.dia = Math.max(10, v); } },
      { kind: 'length', key: 'ax', label: 'Achshöhe', value: WO.axis, onChange: (v) => { WO.axis = v; } },
    ];
    return [shape,
      { kind: 'length', key: 'w', label: 'Breite', value: WO.width, onChange: (v) => { WO.width = Math.max(10, v); } },
      { kind: 'length', key: 'h', label: 'Höhe', value: WO.height, onChange: (v) => { WO.height = Math.max(10, v); } },
      { kind: 'length', key: 's', label: 'Brüstungshöhe', value: WO.sill, onChange: (v) => { WO.sill = v; } },
    ];
  }
  move(e: ToolEvent): void {
    const z = levelElev(app.doc, e.view.levelId) + 1000;
    this.host = wallAt(app.doc, e.raw, z, 300);
    if (this.host) {
      const wi = wallInfo(app.doc, this.host);
      const W = WO.round ? WO.dia : WO.width;
      const t = Math.max(W / 2, Math.min(wi.L - W / 2, dot(sub(e.p, wi.c0), wi.d)));
      this.t = Math.round(t / 5) * 5;
    }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.host) { app.status('Wandöffnungen müssen in eine Wand gesetzt werden.'); return; }
    const h = this.host;
    app.doc.transaction('Wandöffnung platzieren', () => {
      if (WO.round) app.doc.add<WallOpening>({ id: newId('kb'), cat: 'opening', shape: 'round', hostId: h.id, levelId: h.levelId, t: this.t, width: WO.dia, height: WO.dia, sill: WO.axis - WO.dia / 2 } as WallOpening);
      else app.doc.add<WallOpening>({ id: newId('wo'), cat: 'opening', hostId: h.id, levelId: h.levelId, t: this.t, width: WO.width, height: WO.height, sill: WO.sill } as WallOpening);
    });
  }
  preview(dl: DisplayList): void {
    if (!this.host) return;
    const wi = wallInfo(app.doc, this.host);
    const P = (u: number, v: number) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
    const W = WO.round ? WO.dia : WO.width;
    const u0 = this.t - W / 2, u1 = this.t + W / 2;
    dl.poly([P(u0, -wi.T / 2), P(u1, -wi.T / 2), P(u1, wi.T / 2), P(u0, wi.T / 2)], PREVIEW, true);
    if (WO.round) dl.circle(P(this.t, 0), Math.min(W / 2, wi.T / 2), PREVIEW);
  }
}
registerCommand({ id: 'wallOpening', label: 'Wandöffnung', icon: 'opening', tip: 'Rechteckige Öffnung in einer Wand (wird in Ansichten und 3D ausgespart)', run: () => startTool(new WallOpeningTool(), 'wallOpening') });
registerSimilar('opening', 'wallOpening');

// ------------------------------------------------------------ Schacht / vertikale Öffnung
/** Mittelpunkt einer runden Öffnung (aus der Skizze) */
export function roundCenter(s: El): V2 | null {
  const r: V2[] | undefined = s.loops?.[0]; if (!r?.length) return null;
  let x = 0, y = 0; for (const p of r) { x += p.x; y += p.y; } return { x: x / r.length, y: y / r.length };
}
function drawRoundCross(ctx: PlanCtx, s: El): void {
  const c = roundCenter(s); if (!c) return;
  const r = (s.dia ?? 200) / 2; const d = fromAngle(Math.PI / 4, r), e = fromAngle(-Math.PI / 4, r);
  const pen = { w: 1 };
  ctx.dl.line(sub(c, d), add(c, d), pen, { ns: true }); ctx.dl.line(sub(c, e), add(c, e), pen, { ns: true });
}
function drawShaft(ctx: PlanCtx, s: El): void {
  const area = shaftArea(ctx.doc, s as Shaft); if (!area.length) return;
  const { dl } = ctx;
  if (s.hostId) {
    // vertikale Öffnung: Kanten zeigt der Host; unsichtbare Linien zum Wählen
    for (const p of area) for (const r of p) dl.poly(r, { w: 1 }, true, { inv: true });
    if (isRound(s)) {
      const host = ctx.doc.get(s.hostId);
      // nur, wenn das Bauteil in dieser Ansicht gezeichnet wurde
      if (host && ctx.dl.items.some((it) => it.o === host.id)) drawRoundCross(ctx, s);
    }
    return;
  }
  if (isRound(s)) {
    const [z0, z1] = shaftRange(ctx.doc, s as Shaft);
    const inRange = ctx.ceiling ? z1 >= ctx.cutZ && z0 <= ctx.topZ : z0 <= ctx.cutZ && z1 >= ctx.depthZ;
    if (!inRange) return;
    for (const p of area) for (const r of p) dl.poly(r, catPen(ctx.doc, 'opening', false), true);
    drawRoundCross(ctx, s);
    return;
  }
  const [z0, z1] = shaftRange(ctx.doc, s as Shaft);
  const inRange = ctx.ceiling ? z1 >= ctx.cutZ && z0 <= ctx.topZ : z0 <= ctx.cutZ && z1 >= ctx.depthZ;
  if (!inRange) return;
  const pen = catPen(ctx.doc, 'opening', false);
  for (const p of area) {
    for (const r of p) dl.poly(r, pen, true);
    const b = bboxOf(p[0]);
    for (const [a, c] of [[b.min, b.max], [{ x: b.min.x, y: b.max.y }, { x: b.max.x, y: b.min.y }]] as [V2, V2][]) {
      for (const [q0, q1] of clipSegToMulti(a, c, [p])) dl.line(q0, q1, { w: 1 }, { ns: true });
    }
  }
}

/** Runde Öffnung: Durchmesser ändern (Skizze um den Mittelpunkt neu bilden) */
function roundProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'dia', label: 'Durchmesser', group: g.dims, type: 'length', get: (e) => e.dia ?? 200,
      set: (e, v) => { const c = roundCenter(e); const d = Math.max(10, v); return c ? { dia: d, loops: [circleLoop(c, d / 2)] } : { dia: d }; } },
    { key: 'text', label: 'Beschriftung', group: g.text, type: 'readonly', get: (e) => shaftTagText(e) },
  ];
}
export function shaftTagText(s: El): string {
  if (isRound(s)) return `KB Ø${fmtMm(s.dia ?? 200)}`;
  const r: V2[] | undefined = s.loops?.[0]; if (!r?.length) return '';
  const b = bboxOf(r); return `${fmtMm((b.max.x - b.min.x) / 10)}/${fmtMm((b.max.y - b.min.y) / 10)}`;
}
function shaftProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Basisabhängigkeit', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'baseOffset', label: 'Versatz unten', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'topLevelId', label: 'Abhängigkeit oben', group: g.constraints, type: 'select', options: (doc) => [['', 'Nicht verbunden'], ...levelOptions(doc).map(([id, n]) => [id, 'Bis Ebene: ' + n] as [string, string])], get: (e) => e.topLevelId ?? '', set: (_e, v) => ({ topLevelId: v || null }) },
    { key: 'topOffset', label: 'Versatz oben', group: g.constraints, type: 'length', get: (e) => e.topOffset ?? 0, set: (_e, v) => ({ topOffset: v }) },
    { key: 'height', label: 'Nicht verbundene Höhe', group: g.constraints, type: 'length', get: (e, doc) => { const [a, b] = shaftRange(doc, e as Shaft); return b - a; }, set: (e, v) => (e.topLevelId ? undefined : { height: Math.max(10, v) }) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => (e.id ? multiArea(shaftArea(doc, e as Shaft)) : 0) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'shaft', label: 'Schachtöffnung', plural: 'Schachtöffnungen', planOrder: 22,
  visibleIn: (el, _doc, view) => isPlanLike(view) || !el.hostId,
  drawPlan: drawShaft,
  grips: (el, _doc, view) => loopGrips(el.loops, view),
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : undefined; },
  transform: (el, m, _doc, view) => (isPlanLike(view) ? { loops: transformLoops(el.loops, m) } : undefined),
  translate3d: (el, d) => ({ loops: moveLoops(el.loops, d), baseOffset: (el.baseOffset ?? 0) + d.z, topOffset: el.topLevelId ? (el.topOffset ?? 0) + d.z : el.topOffset }),
  center: (el) => loopsCenter(el.loops),
  props: (el) => (el.hostId ? shaftProps().filter((p) => ['area', 'comments', 'mark'].includes(p.key)).concat([{ key: 'host', label: 'Host', group: GROUPS.constraints, type: 'readonly', get: (e, doc) => doc.get(e.hostId)?.cat ? (doc.get(e.hostId)!.cat === 'floor' ? 'Geschossdecke' : doc.get(e.hostId)!.cat === 'roof' ? 'Dach' : 'Decke') : '' }]) : shaftProps()).concat(isRound(el) ? roundProps() : []),
  tagText: (el) => shaftTagText(el),
  tagPoint: (el) => loopsCenter(el.loops),
  scheduleFields: () => [
    { key: 'base', label: 'Basisabhängigkeit', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'top', label: 'Abhängigkeit oben', get: (el, doc) => levelName(doc, el.topLevelId) },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => multiArea(shaftArea(doc, el as Shaft)) },
    { key: 'shape', label: 'Form', get: (el) => (isRound(el) ? 'rund' : 'Skizze') },
    { key: 'dia', label: 'Durchmesser', unit: 'len', get: (el) => (isRound(el) ? el.dia ?? 200 : '') },
    { key: 'text', label: 'Beschriftung', get: (el) => shaftTagText(el) },
  ],
});

function startShaft(): void {
  const lvl = activeLevelId(); const above = levelAbove(app.doc, lvl);
  const t: SketchTool = new SketchTool('Schachtöffnung', (loops) => {
    const p = t.placement?.proto ?? ({} as El); const { id: _i, ...rest } = p;
    app.doc.transaction('Schachtöffnung erstellen', () => {
      app.doc.add<Shaft>({ ...rest, id: newId('sh'), cat: 'shaft', loops, levelId: p.levelId || lvl, baseOffset: p.baseOffset ?? 0, topLevelId: p.topLevelId ?? null, topOffset: p.topOffset ?? 0, height: p.height ?? 3000 } as Shaft);
    });
  }, { wallRef: 'int', kinds: ['plan'] });
  t.placement = placementFor('shaft', { levelId: lvl, baseOffset: 0, topLevelId: above?.id ?? null, topOffset: 0, height: 3000 });
  t.placement.proto.levelId = lvl;
  if (!t.placement.proto.topLevelId || !app.doc.get(t.placement.proto.topLevelId)) t.placement.proto.topLevelId = above?.id ?? null;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, 'shaft');
}
registerCommand({ id: 'shaft', label: 'Schacht', icon: 'shaft', tip: 'Schachtöffnung skizzieren: schneidet Geschossdecken, Decken und Dächer im Höhenbereich', run: startShaft });
registerSimilar('shaft', 'shaft');
registerContextPanel({ cats: ['shaft'], panel: 'Schacht', items: ['floorEditBoundary'] });
registerSketchEditor('shaft', (el) => {
  const t = new SketchTool('Begrenzung bearbeiten', (loops) => {
    app.doc.transaction('Begrenzung bearbeiten', () => app.doc.update(el.id, { loops }));
    app.select([el.id]);
  }, { initial: loopsToSegs(el.loops), kinds: ['plan', 'ceiling'] });
  startTool(t, 'floorEditBoundary');
});

/** Vertikale Öffnung: Bauteil (Geschossdecke/Dach/Decke) wählen, dann Umriss skizzieren */
class PickHostTool extends Tool {
  id = 'verticalOpening'; label = 'Öffnung vertikal'; kinds = ['plan', 'ceiling'];
  private hover: Id | null = null;
  prompt(): string { return 'Geschossdecke, Decke oder Dach wählen, in das die Öffnung geschnitten wird.'; }
  move(e: ToolEvent): void {
    this.hover = null;
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el && ['floor', 'roof', 'ceiling'].includes(el.cat)) { this.hover = el.id; break; } }
    e.vp.hover = this.hover;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const host = this.hover ? app.doc.get(this.hover) : null;
    if (!host) { app.status('Bitte eine Geschossdecke, eine Decke oder ein Dach wählen.'); return; }
    const t = new SketchTool('Öffnung skizzieren', (loops) => {
      app.doc.transaction('Vertikale Öffnung erstellen', () => {
        app.doc.add<Shaft>({ id: newId('vo'), cat: 'shaft', loops, hostId: host.id, levelId: host.levelId, baseOffset: 0, topLevelId: null, topOffset: 0, height: 0 } as Shaft);
      });
    }, { kinds: ['plan', 'ceiling'] });
    startTool(t, 'verticalOpening');
  }
}
// ------------------------------------------------------------ Kernbohrung (rund): Wand oder Platte
const KB = { dia: 150, axis: 1500 };
const SLAB_HOSTS = ['floor', 'roof', 'ceiling'];
class CoreDrillTool extends Tool {
  id = 'coreDrill'; label = 'Kernbohrung'; kinds = ['plan', 'ceiling', 'section', 'elevation'];
  private wall: Wall | null = null; private slab: El | null = null; private u = 0; private z = 0; private p: V2 | null = null;
  prompt(): string { return 'In eine Wand (Grundriss oder Abwicklung) oder eine Decke/Platte klicken, um eine runde Öffnung zu platzieren.'; }
  options(): OptionItem[] {
    return [
      { kind: 'length', key: 'd', label: 'Durchmesser', value: KB.dia, onChange: (v) => { KB.dia = Math.max(10, v); } },
      { kind: 'length', key: 'ax', label: 'Achshöhe (Wand, Grundriss)', value: KB.axis, onChange: (v) => { KB.axis = v; } },
    ];
  }
  move(e: ToolEvent): void {
    const doc = app.doc; this.wall = null; this.slab = null; this.p = e.p;
    if (isSectionLike(e.view)) {
      for (const h of e.vp.hit(e.raw)) { const el = doc.get(h.id); if (el?.cat === 'wall') { this.wall = el as Wall; break; } }
      if (this.wall) { const wi = wallInfo(doc, this.wall); const w3 = makeProjector(e.view).toWorld(e.p); this.u = Math.round(dot(sub(w3, wi.c0), wi.d) / 5) * 5; this.z = Math.round(w3.z / 5) * 5; }
      return;
    }
    const lz = levelElev(doc, e.view.levelId);
    if (e.view.kind === 'plan') this.wall = wallAt(doc, e.raw, lz + 1000, 0);
    if (this.wall) { const wi = wallInfo(doc, this.wall); this.u = Math.round(dot(sub(e.p, wi.c0), wi.d) / 5) * 5; this.z = levelElev(doc, this.wall.levelId) + KB.axis; return; }
    for (const h of e.vp.hit(e.raw)) { const el = doc.get(h.id); if (el && SLAB_HOSTS.includes(el.cat) && (el.loops as V2[][] | undefined)?.some((l) => pointInPoly(e.p, [l]))) { this.slab = el; break; } }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const doc = app.doc;
    if (this.wall) {
      const w = this.wall; const ax = this.z - levelElev(doc, w.levelId);
      doc.transaction('Kernbohrung platzieren', () => doc.add<WallOpening>({ id: newId('kb'), cat: 'opening', shape: 'round', hostId: w.id, levelId: w.levelId, t: this.u, width: KB.dia, height: KB.dia, sill: ax - KB.dia / 2 } as WallOpening));
      return;
    }
    if (this.slab && this.p) {
      const host = this.slab; const c = this.p;
      doc.transaction('Kernbohrung platzieren', () => doc.add<Shaft>({ id: newId('kb'), cat: 'shaft', shape: 'round', dia: KB.dia, loops: [circleLoop(c, KB.dia / 2)], hostId: host.id, levelId: host.levelId, baseOffset: 0, topLevelId: null, topOffset: 0, height: 0 } as Shaft));
      return;
    }
    app.status('Kernbohrungen werden in eine Wand oder eine Decke/Platte gesetzt.');
  }
  preview(dl: DisplayList, vp: any): void {
    const doc = app.doc; const r = KB.dia / 2;
    if (this.wall) {
      const wi = wallInfo(doc, this.wall);
      if (isPlanLike(vp.view)) dl.circle(add(wi.c0, mul(wi.d, this.u)), Math.min(r, wi.T / 2), PREVIEW);
      else { const pr = makeProjector(vp.view); const c = pr.toView({ ...add(wi.c0, mul(wi.d, this.u)), z: this.z }); dl.circle(c, r, PREVIEW); dl.text(add(c, { x: r * 1.3, y: r }), `KB Ø${fmtMm(KB.dia)}, Achse ${fmtKoteCH(this.z)}`, { size: 2.2, color: '#1e6fd9' }); }
    } else if (this.slab && this.p) dl.circle(this.p, r, PREVIEW);
  }
}
registerCommand({ id: 'coreDrill', label: 'Kern- bohrung', icon: 'coredrill', tip: 'Runde Öffnung (Kernbohrung) in einer Wand – im Grundriss oder in der Wandabwicklung – oder in einer Decke/Platte', run: () => startTool(new CoreDrillTool(), 'coreDrill') });

registerCommand({ id: 'verticalOpening', label: 'Öffnung vertikal', icon: 'opening', tip: 'Senkrechte Öffnung in einer gewählten Geschossdecke, Decke oder einem Dach skizzieren', run: () => startTool(new PickHostTool(), 'verticalOpening') });

registerPanel('Architektur', 'Öffnung', ['coreDrill']);
