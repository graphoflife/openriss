// Geschossdecke: Skizze (Außenumriss + Innenumrisse = Öffnungen), Typ mit Schichten (oben → unten),
// Oberkante = Ebene + Höhenversatz (+ Gefälle: Neigungspfeil oder Rampenprofil, siehe slope.ts).
// Grundriss: Kante in Projektion bzw. Schnittfläche.
import { flatSurface, surfaceOf } from '../../views/surfaces';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import type { V2, MultiPoly } from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, onHook, GROUPS, PropDef } from '../../core/registry';
import { levelElev, typeOf } from '../../core/view';
import { cached } from '../../core/cache';
import { fmtLen } from '../../core/units';
import { app } from '../../app';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import {
  LayeredType, thickOf, loopsArea, cutoutsFor, layerSolids, drawSlabPlan, multiArea, multiPerimeter, transformLoops, moveLoops, moveHostedCutouts,
  loopGrips, dragLoopGrip, loopsCenter, layeredTypeProps, identityProps, levelName, fmtM3, registerSketchEditor, editSketchOf,
} from './common';
import { difference } from '../../core/geom';
import {
  SlopeDef, SlopeArrow, slopeOf, slopeDz, slopeRange, slopedSurface, slopedLayerSolids, slopedArea, slopeGrips, dragSlopeGrip,
  transformSlope, moveSlope, slopeProps, drawSlopedSlabPlan, slopeText, slopePset, maxGrade,
} from './slope';

export interface Floor extends El {
  cat: 'floor';
  levelId: Id;
  /** Höhenversatz von Ebene (Oberkante) */
  offset: number;
  loops: V2[][];
  structural?: boolean;
  roomBounding?: boolean;
  /** Gefälle (Neigungspfeil / Rampenprofil); Eingabe auch als { a, b, pct } */
  slope?: SlopeDef | SlopeArrow;
  /** Rampe (IFC: IfcRamp) */
  ramp?: boolean;
}

export const floorType = (doc: Doc, f: El) => typeOf<LayeredType>(doc, f);
export const floorTop = (doc: Doc, f: El): number => levelElev(doc, f.levelId) + (f.offset ?? 0);
export const floorThick = (doc: Doc, f: El): number => thickOf(floorType(doc, f));
/** Oberkante im Grundrisspunkt p (geneigte Decken: inkl. Gefälle) */
export const floorTopAt = (doc: Doc, f: El, p: V2): number => { const sl = slopeOf(f); return floorTop(doc, f) + (sl ? slopeDz(sl, p) : 0); };
/** Höhenbereich [UK min., OK max.] (geneigte Decken über die ganze Skizze) */
export function floorRange(doc: Doc, f: El): [number, number] {
  const top = floorTop(doc, f), T = floorThick(doc, f); const sl = slopeOf(f);
  if (!sl) return [top - T, top];
  const [d0, d1] = slopeRange(sl, loopsArea(f.loops));
  return [top + d0 - T, top + d1];
}

/** Grundfläche abzüglich Schächte/Öffnungen */
export function floorArea(doc: Doc, f: El): MultiPoly {
  if (!f.id || !f.loops) return [];
  return cached(doc, 'archFloorArea', f.id, () => {
    const a = loopsArea(f.loops);
    const [z0, z1] = floorRange(doc, f);
    const cut = cutoutsFor(doc, f.id, z0, z1);
    return cut.length && a.length ? difference(a, ...cut) : a;
  });
}

function floorProps(el?: El): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Höhenversatz von Ebene', group: g.constraints, type: 'length', get: (e) => e.offset ?? 0, set: (_e, v) => ({ offset: v }) },
    { key: 'roomBounding', label: 'Raumbegrenzung', group: g.constraints, type: 'bool', get: (e) => e.roomBounding !== false, set: (_e, v) => ({ roomBounding: v }) },
    { key: 'structural', label: 'Tragwerk', group: g.structural, type: 'bool', get: (e) => !!e.structural, set: (_e, v) => ({ structural: v }) },
    { key: 'elevTop', label: 'Höhe Oberkante', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(floorTop(doc, e)) },
    { key: 'elevBot', label: 'Höhe Unterkante', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(floorTop(doc, e) - floorThick(doc, e)) },
    { key: 'perimeter', label: 'Umfang', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(multiPerimeter(floorArea(doc, e))) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => multiArea(floorArea(doc, e)) },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => fmtM3(multiArea(floorArea(doc, e)) * floorThick(doc, e)) },
    { key: 'thick', label: 'Dicke', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(floorThick(doc, e)) },
    ...slopeProps(el, (e, doc) => floorArea(doc, e), (e, doc) => floorTop(doc, e)),
    { key: 'ramp', label: 'Rampe', group: g.constraints, type: 'bool', get: (e) => !!e.ramp, set: (_e, v) => ({ ramp: v || undefined }) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'floor', label: 'Geschossdecke', plural: 'Geschossdecken', hasTypes: true, planOrder: -20,
  drawPlan: (ctx, el) => {
    const t = floorType(ctx.doc, el); const sl = slopeOf(el); const surf = sl && surfaceOf(ctx.doc, el);
    if (sl && surf) { drawSlopedSlabPlan(ctx, el, floorArea(ctx.doc, el), sl, surf, { styleCat: 'floor' }); return; }
    drawSlabPlan(ctx, 'floor', floorArea(ctx.doc, el), floorTop(ctx.doc, el), t?.layers ?? [], t?.coarseColor);
  },
  solids: (el, doc) => {
    const sl = slopeOf(el); const layers = floorType(doc, el)?.layers ?? [];
    if (!sl) return layerSolids(floorArea(doc, el), floorTop(doc, el), layers, 'm_stb');
    const top = floorTop(doc, el);
    return slopedLayerSolids(floorArea(doc, el), (p) => top + slopeDz(sl, p), layers, sl, 'm_stb');
  },
  surface: (el, doc) => {
    const t = floorTop(doc, el); const sl = slopeOf(el);
    return sl ? slopedSurface(sl, t, floorThick(doc, el), loopsArea(el.loops)) : flatSurface(t, t - floorThick(doc, el));
  },
  grips: (el, _doc, view) => [...loopGrips(el.loops, view), ...slopeGrips(el, view)],
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : dragSlopeGrip(el, id, p); },
  transform: (el, m, doc, view) => {
    if (view.kind !== 'plan' && view.kind !== 'ceiling') return;
    moveHostedCutouts(doc, el.id, m); const sl = slopeOf(el);
    return { loops: transformLoops(el.loops, m), ...(sl ? { slope: transformSlope(sl, m) } : {}) };
  },
  translate3d: (el, d, doc) => {
    moveHostedCutouts(doc, el.id, null, d); const sl = slopeOf(el);
    return { loops: moveLoops(el.loops, d), offset: (el.offset ?? 0) + d.z, ...(sl ? { slope: moveSlope(sl, d) } : {}) };
  },
  ifc: (el, doc) => {
    const sl = slopeOf(el); if (!sl && !el.ramp) return null;
    const ps = slopePset(sl, floorArea(doc, el));
    // Werte mit Messart ({ v, k }) werden vom IFC-Export als solche geschrieben
    const psets: Record<string, any> = ps ? { CH_Gefaelle: ps } : {};
    return el.ramp ? { entity: 'IFCRAMP', predefined: 'STRAIGHT_RUN_RAMP', psets } : { entity: 'IFCSLAB', predefined: 'FLOOR', psets };
  },
  center: (el) => loopsCenter(el.loops),
  props: (el) => floorProps(el),
  typeProps: () => layeredTypeProps([
    { key: 'function', label: 'Funktion', group: GROUPS.construction, type: 'select', options: [['interior', 'Innen'], ['exterior', 'Außen']], get: (t) => t.function ?? 'interior', set: (_t, v) => ({ function: v }) },
  ]),
  tagText: (el, doc) => floorType(doc, el)?.name ?? '',
  tagPoint: (el) => loopsCenter(el.loops),
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => floorType(doc, el)?.name ?? '' },
    { key: 'level', label: 'Ebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'offset', label: 'Höhenversatz von Ebene', unit: 'len', get: (el) => el.offset ?? 0 },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => multiArea(floorArea(doc, el)) },
    { key: 'perimeter', label: 'Umfang', unit: 'len', get: (el, doc) => multiPerimeter(floorArea(doc, el)) },
    { key: 'thick', label: 'Dicke', unit: 'len', get: (el, doc) => floorThick(doc, el) },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => multiArea(floorArea(doc, el)) * floorThick(doc, el) },
    { key: 'slopedArea', label: 'Geneigte Fläche', unit: 'area', get: (el, doc) => slopedArea(floorArea(doc, el), slopeOf(el)) },
    { key: 'slope', label: 'Gefälle', get: (el) => slopeText(slopeOf(el)) },
    { key: 'slopeMax', label: 'Gefälle max. (%)', unit: 'num', get: (el) => Math.round(maxGrade(slopeOf(el)) * 1e5) / 1e3 },
    { key: 'structural', label: 'Tragwerk', get: (el) => (el.structural ? 'Ja' : 'Nein') },
  ],
});

// ------------------------------------------------------------ Werkzeug
function startFloorSketch(structural: boolean, cmdId: string): void {
  const lvl = activeLevelId();
  const t: SketchTool = new SketchTool(structural ? 'Geschossdecke: Tragwerk' : 'Geschossdecke', (loops) => {
    const p = t.placement?.proto ?? ({} as El);
    let id = '';
    app.doc.transaction(structural ? 'Tragwerksdecke erstellen' : 'Geschossdecke erstellen', () => {
      const { id: _i, ...rest } = p;
      id = app.doc.add<Floor>({ ...rest, id: newId('fl'), cat: 'floor', loops, levelId: p.levelId || lvl, offset: p.offset ?? 0, structural: structural || !!p.structural } as Floor).id;
    });
    app.select([id]);
  }, { wallRef: 'coreInt', kinds: ['plan'] });
  t.placement = placementFor('floor', { levelId: lvl, offset: 0, structural, typeId: structural ? 'flt_stb20' : 'flt_aufbau' });
  t.placement.proto.levelId = lvl;
  t.placement.proto.structural = structural;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, cmdId);
}

registerCommand({ id: 'floor', label: 'Geschossdecke', icon: 'floor', keys: ['SB'], tip: 'Geschossdecke skizzieren (Umriss zeichnen oder Wände wählen). Innere Umrisse werden zu Öffnungen.', run: () => startFloorSketch(false, 'floor') });
registerCommand({ id: 'floorStruct', label: 'Geschossdecke: Tragwerk', icon: 'floor', tip: 'Tragende Geschossdecke skizzieren', run: () => startFloorSketch(true, 'floorStruct') });
registerSimilar('floor', 'floor');
registerContextPanel({ cats: ['floor'], panel: 'Geschossdecke', items: ['floorEditBoundary'] });

registerSketchEditor('floor', (el) => {
  const f = el as Floor;
  const t = new SketchTool('Begrenzung bearbeiten', (loops) => {
    app.doc.transaction('Begrenzung bearbeiten', () => app.doc.update<Floor>(f.id, { loops }));
    app.select([f.id]);
  }, { initial: loopsToSegs(f.loops), wallRef: 'coreInt', kinds: ['plan', 'ceiling'] });
  startTool(t, 'floorEditBoundary');
});

// Doppelklick auf Skizzenelement → Begrenzung bearbeiten (wie Revit)
onHook('dblclick', (el: El) => { editSketchOf(el); });
