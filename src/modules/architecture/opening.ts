// Öffnungen: rechteckige Wandöffnung (in Wand gehostet), Schachtöffnung (über Höhenbereich, schneidet
// Geschossdecken/Decken/Dächer) und vertikale Öffnung (nur im gewählten Bauteil).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, sub, dot, apply, bboxOf } from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, GROUPS, PropDef, PlanCtx, Grip } from '../../core/registry';
import { levelElev, levelAbove, levelOptions, isPlanLike } from '../../core/view';
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
import {
  Shaft, shaftRange, shaftArea, transformLoops, moveLoops, loopGrips, dragLoopGrip, loopsCenter, identityProps, levelName, registerSketchEditor, multiArea,
} from './common';

// ------------------------------------------------------------ Wandöffnung
export interface WallOpening extends El { cat: 'opening'; hostId: Id; t: number; width: number; height: number; sill: number }

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
  ctx.dl.fill([rect], { color: 'transparent' }, undefined, { ns: true });
  if (L.z0 > ctx.cutZ) {
    // über der Schnittebene: gestrichelt (Sturz/Öffnung oberhalb)
    ctx.dl.poly(rect, { w: 1, dash: 'hidden' }, true, { ns: true });
  }
}

function wallOpeningProps(): PropDef[] {
  const g = GROUPS;
  return [
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
  hostOpening: (el, doc) => { const L = local(doc, el); return L ? { u0: L.u0, u1: L.u1, z0: L.z0, z1: L.z1 } : null; },
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
  props: () => wallOpeningProps(),
  scheduleFields: () => [
    { key: 'width', label: 'Breite', unit: 'len', get: (el) => el.width ?? 1000 },
    { key: 'height', label: 'Höhe', unit: 'len', get: (el) => el.height ?? 2000 },
    { key: 'sill', label: 'Brüstungshöhe', unit: 'len', get: (el) => el.sill ?? 0 },
  ],
});

const WO = { width: 1000, height: 2000, sill: 0 };
class WallOpeningTool extends Tool {
  id = 'wallOpening'; label = 'Wandöffnung'; kinds = ['plan'];
  private host: Wall | null = null; private t = 0;
  prompt(): string { return 'Klicken Sie in eine Wand, um eine rechteckige Wandöffnung zu platzieren.'; }
  options(): OptionItem[] {
    return [
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
      const t = Math.max(WO.width / 2, Math.min(wi.L - WO.width / 2, dot(sub(e.p, wi.c0), wi.d)));
      this.t = Math.round(t / 5) * 5;
    }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.host) { app.status('Wandöffnungen müssen in eine Wand gesetzt werden.'); return; }
    const h = this.host;
    app.doc.transaction('Wandöffnung platzieren', () => {
      app.doc.add<WallOpening>({ id: newId('wo'), cat: 'opening', hostId: h.id, levelId: h.levelId, t: this.t, width: WO.width, height: WO.height, sill: WO.sill } as WallOpening);
    });
  }
  preview(dl: DisplayList): void {
    if (!this.host) return;
    const wi = wallInfo(app.doc, this.host);
    const P = (u: number, v: number) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
    const u0 = this.t - WO.width / 2, u1 = this.t + WO.width / 2;
    dl.poly([P(u0, -wi.T / 2), P(u1, -wi.T / 2), P(u1, wi.T / 2), P(u0, wi.T / 2)], PREVIEW, true);
  }
}
registerCommand({ id: 'wallOpening', label: 'Wandöffnung', icon: 'opening', tip: 'Rechteckige Öffnung in einer Wand (wird in Ansichten und 3D ausgespart)', run: () => startTool(new WallOpeningTool(), 'wallOpening') });
registerSimilar('opening', 'wallOpening');

// ------------------------------------------------------------ Schacht / vertikale Öffnung
function drawShaft(ctx: PlanCtx, s: El): void {
  const area = shaftArea(ctx.doc, s as Shaft); if (!area.length) return;
  const { dl } = ctx;
  if (s.hostId) {
    // vertikale Öffnung: Kanten zeigt der Host; unsichtbare Linien zum Wählen
    for (const p of area) for (const r of p) dl.poly(r, { w: 1 }, true, { inv: true });
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
  props: (el) => (el.hostId ? shaftProps().filter((p) => ['area', 'comments', 'mark'].includes(p.key)).concat([{ key: 'host', label: 'Host', group: GROUPS.constraints, type: 'readonly', get: (e, doc) => doc.get(e.hostId)?.cat ? (doc.get(e.hostId)!.cat === 'floor' ? 'Geschossdecke' : doc.get(e.hostId)!.cat === 'roof' ? 'Dach' : 'Decke') : '' }]) : shaftProps()),
  scheduleFields: () => [
    { key: 'base', label: 'Basisabhängigkeit', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'top', label: 'Abhängigkeit oben', get: (el, doc) => levelName(doc, el.topLevelId) },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => multiArea(shaftArea(doc, el as Shaft)) },
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
registerCommand({ id: 'verticalOpening', label: 'Öffnung vertikal', icon: 'opening', tip: 'Senkrechte Öffnung in einer gewählten Geschossdecke, Decke oder einem Dach skizzieren', run: () => startTool(new PickHostTool(), 'verticalOpening') });

