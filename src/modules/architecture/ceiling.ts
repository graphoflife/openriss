// Decke (abgehängt): "Automatische Decke" (Klick in einen von Wänden umschlossenen Bereich) oder
// Skizze. Unterseite = Ebene + Höhenversatz (Standard 2500). Darstellung im Deckenplan mit Raster.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import type { V2, MultiPoly } from '../../core/geom';
import { difference, bboxOf, mid } from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, GROUPS, PropDef, PlanCtx } from '../../core/registry';
import { levelElev, typeOf } from '../../core/view';
import { cached } from '../../core/cache';
import { fmtLen } from '../../core/units';
import { clipSegToMulti } from '../../elements/wall';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem, PlacementTarget } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import {
  LayeredType, thickOf, loopsArea, cutoutsFor, layerSolids, drawSlabPlan, multiArea, multiPerimeter, transformLoops, moveLoops, moveHostedCutouts,
  loopGrips, dragLoopGrip, loopsCenter, layeredTypeProps, identityProps, levelName, registerSketchEditor, multiBox,
} from './common';
import { regionAt, Region } from './room';

export interface Ceiling extends El { cat: 'ceiling'; levelId: Id; /** Höhenversatz der Unterseite */ offset: number; loops: V2[][]; roomBounding?: boolean }
export interface CeilingType extends LayeredType { gridX?: number; gridY?: number }

export const ceilingType = (doc: Doc, c: El) => typeOf<CeilingType>(doc, c);
export const ceilingBottom = (doc: Doc, c: El): number => levelElev(doc, c.levelId) + (c.offset ?? 2500);
export const ceilingThick = (doc: Doc, c: El): number => thickOf(ceilingType(doc, c), 15);
export function ceilingArea(doc: Doc, c: El): MultiPoly {
  if (!c.id || !c.loops) return [];
  return cached(doc, 'archCeilingArea', c.id, () => {
    const a = loopsArea(c.loops); const z0 = ceilingBottom(doc, c);
    const cut = cutoutsFor(doc, c.id, z0, z0 + ceilingThick(doc, c));
    return cut.length && a.length ? difference(a, ...cut) : a;
  });
}

/** Deckenraster (Modellmuster) – im Deckenplan */
function drawGrid(ctx: PlanCtx, area: MultiPoly, gx: number, gy: number): void {
  if (!(gx > 50) && !(gy > 50)) return;
  const b = multiBox(area); const c = mid(b.min, b.max);
  const pen = { w: 1 };
  const lines: [V2, V2][] = [];
  if (gx > 50) { const k0 = Math.floor((b.min.x - c.x) / gx), k1 = Math.ceil((b.max.x - c.x) / gx); if (k1 - k0 < 400) for (let k = k0; k <= k1; k++) { const x = c.x + k * gx; lines.push([{ x, y: b.min.y - 1 }, { x, y: b.max.y + 1 }]); } }
  if (gy > 50) { const k0 = Math.floor((b.min.y - c.y) / gy), k1 = Math.ceil((b.max.y - c.y) / gy); if (k1 - k0 < 400) for (let k = k0; k <= k1; k++) { const y = c.y + k * gy; lines.push([{ x: b.min.x - 1, y }, { x: b.max.x + 1, y }]); } }
  for (const [a, e] of lines) for (const [s, t] of clipSegToMulti(a, e, area)) ctx.dl.line(s, t, pen, { sub: 'grid' });
}

function ceilingProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Höhenversatz von Ebene', group: g.constraints, type: 'length', get: (e) => e.offset ?? 2500, set: (_e, v) => ({ offset: v }) },
    { key: 'roomBounding', label: 'Raumbegrenzung', group: g.constraints, type: 'bool', get: (e) => e.roomBounding !== false, set: (_e, v) => ({ roomBounding: v }) },
    { key: 'perimeter', label: 'Umfang', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(multiPerimeter(ceilingArea(doc, e))) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => multiArea(ceilingArea(doc, e)) },
    { key: 'thick', label: 'Dicke', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(ceilingThick(doc, e)) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'ceiling', label: 'Decke', plural: 'Decken', hasTypes: true, planOrder: -15,
  drawPlan: (ctx, el) => {
    const t = ceilingType(ctx.doc, el); const area = ceilingArea(ctx.doc, el);
    const z0 = ceilingBottom(ctx.doc, el);
    const res = drawSlabPlan(ctx, 'ceiling', area, z0 + ceilingThick(ctx.doc, el), t?.layers ?? [], t?.coarseColor);
    if (res === 'proj' && ctx.ceiling) drawGrid(ctx, area, t?.gridX ?? 0, t?.gridY ?? 0);
  },
  solids: (el, doc) => layerSolids(ceilingArea(doc, el), ceilingBottom(doc, el) + ceilingThick(doc, el), ceilingType(doc, el)?.layers ?? [], 'm_gk'),
  grips: (el, _doc, view) => loopGrips(el.loops, view),
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : undefined; },
  transform: (el, m, doc, view) => { if (view.kind !== 'plan' && view.kind !== 'ceiling') return; moveHostedCutouts(doc, el.id, m); return { loops: transformLoops(el.loops, m) }; },
  translate3d: (el, d, doc) => { moveHostedCutouts(doc, el.id, null, d); return { loops: moveLoops(el.loops, d), offset: (el.offset ?? 2500) + d.z }; },
  center: (el) => loopsCenter(el.loops),
  props: () => ceilingProps(),
  typeProps: () => layeredTypeProps([
    { key: 'gridX', label: 'Rasterweite X', group: GROUPS.graphics, type: 'length', get: (t) => t.gridX ?? 0, set: (_t, v) => ({ gridX: Math.max(0, v) }) },
    { key: 'gridY', label: 'Rasterweite Y', group: GROUPS.graphics, type: 'length', get: (t) => t.gridY ?? 0, set: (_t, v) => ({ gridY: Math.max(0, v) }) },
  ]),
  tagText: (el, doc) => ceilingType(doc, el)?.name ?? '',
  tagPoint: (el) => loopsCenter(el.loops),
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => ceilingType(doc, el)?.name ?? '' },
    { key: 'level', label: 'Ebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'offset', label: 'Höhenversatz von Ebene', unit: 'len', get: (el) => el.offset ?? 2500 },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => multiArea(ceilingArea(doc, el)) },
    { key: 'perimeter', label: 'Umfang', unit: 'len', get: (el, doc) => multiPerimeter(ceilingArea(doc, el)) },
  ],
});

// ------------------------------------------------------------ Werkzeuge
function createCeiling(pl: PlacementTarget, loops: V2[][], lvl: Id): void {
  const p = pl.proto; const { id: _i, ...rest } = p;
  let id = '';
  app.doc.transaction('Decke erstellen', () => {
    id = app.doc.add<Ceiling>({ ...rest, id: newId('ce'), cat: 'ceiling', loops, levelId: p.levelId || lvl, offset: p.offset ?? 2500 } as Ceiling).id;
  });
  app.status('Decke erstellt.');
  void id;
}

function startCeilingSketch(pl: PlacementTarget, lvl: Id): void {
  const t = new SketchTool('Decke skizzieren', (loops) => createCeiling(pl, loops, lvl), { wallRef: 'int', kinds: ['ceiling', 'plan'] });
  t.placement = pl;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, 'ceiling');
}

class CeilingTool extends Tool {
  id = 'ceiling'; label = 'Decke'; kinds = ['ceiling', 'plan'];
  private hover: Region | null = null;
  private lvl = '';
  activate(): void {
    this.lvl = activeLevelId();
    this.placement = placementFor('ceiling', { levelId: this.lvl, offset: 2500, typeId: 'clt_gk' });
    this.placement.proto.levelId = this.lvl;
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Automatische Decke: Klicken Sie in einen von Wänden umschlossenen Bereich.'; }
  options(): OptionItem[] {
    return [{
      kind: 'buttons', key: 'mode', value: 'auto',
      options: [{ id: 'auto', label: 'Automatische Decke', icon: 'ceiling' }, { id: 'sketch', label: 'Decke skizzieren', icon: 'editsketch' }],
      onChange: (v) => { if (v === 'sketch' && this.placement) startCeilingSketch(this.placement, this.lvl); },
    }];
  }
  move(e: ToolEvent): void { const r = regionAt(app.doc, e.view.levelId ?? this.lvl, e.raw); this.hover = r && !r.open ? r : null; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const r = regionAt(app.doc, e.view.levelId ?? this.lvl, e.raw);
    if (!r || r.open) { app.status('Kein umschlossener Bereich unter dem Cursor (Wände müssen den Raum vollständig umschließen).'); return; }
    createCeiling(this.placement!, r.poly.map((ring) => ring.map((q) => ({ x: q.x, y: q.y }))), e.view.levelId ?? this.lvl);
  }
  preview(dl: DisplayList): void {
    if (!this.hover) return;
    dl.fill(this.hover.poly, { color: '#1e6fd9', alpha: 0.12 }, PREVIEW, { ns: true });
    const b = bboxOf(this.hover.poly[0]); void b;
  }
}

registerCommand({ id: 'ceiling', label: 'Decke', icon: 'ceiling', tip: 'Abgehängte Decke: automatisch in einem umschlossenen Bereich oder skizziert', run: () => startTool(new CeilingTool(), 'ceiling') });
registerSimilar('ceiling', 'ceiling');
registerContextPanel({ cats: ['ceiling'], panel: 'Decke', items: ['floorEditBoundary'] });

registerSketchEditor('ceiling', (el) => {
  const t = new SketchTool('Begrenzung bearbeiten', (loops) => {
    app.doc.transaction('Begrenzung bearbeiten', () => app.doc.update(el.id, { loops }));
    app.select([el.id]);
  }, { initial: loopsToSegs(el.loops), wallRef: 'int', kinds: ['ceiling', 'plan'] });
  startTool(t, 'floorEditBoundary');
});
