// Liftkabine im Schacht (Kategorie 'elevator'): Kabine B×T×H, Fahrkorbtür, Gegengewicht, Haltestellen von–bis.
// Grundriss auf jeder bedienten Ebene: Kabine mit Kreuz, Gegengewicht, Türlinie, Beschriftung «Lift 630 kg / 8 P.».
// 3D-Kabine auf der untersten Haltestelle, Liste (Nutzlast, Personen, Förderhöhe), IFC IfcTransportElement ELEVATOR.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, apply, angleOf, sub, Mat2, applyVec, fromAngle } from '../../core/geom';
import { registerCategory, registerCommand, registerPanel, GROUPS, PropDef, Solid } from '../../core/registry';
import { levelElev, isPlanLike, levels } from '../../core/view';
import { box3, catPen } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtNum } from '../../core/units';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import { identityProps, levelName } from './common';

export interface Elevator extends El {
  cat: 'elevator'; levelId: Id;
  /** oberste Haltestelle (fehlt = nur levelId) */
  topLevelId?: Id;
  /** Kabinenmitte und Drehung (Tür auf der lokalen −y-Seite) */
  p: V2; rot?: number;
  cabW?: number; cabD?: number; cabH?: number;
  doorW?: number;
  /** Gegengewicht seitlich bzw. hinten (Seilaufzug) oder keins (Hydraulik/Rucksack) */
  cw?: 'left' | 'right' | 'back' | 'none';
  /** Nutzlast kg, Personen */
  load?: number; persons?: number;
  label?: string;
}
const D = { cabW: 1100, cabD: 1400, cabH: 2200, doorW: 900, load: 630, persons: 8 };
const val = (e: El, k: keyof typeof D) => (typeof e[k] === 'number' && e[k] > 0 ? e[k] : D[k]);

function stops(doc: Doc, e: El): El[] {
  const z0 = levelElev(doc, e.levelId); const z1 = e.topLevelId ? levelElev(doc, e.topLevelId) : z0;
  return levels(doc).filter((l) => l.elev >= Math.min(z0, z1) - 1 && l.elev <= Math.max(z0, z1) + 1);
}
export const elevatorText = (e: El) => e.label || `Lift ${fmtNum(val(e, 'load'), 0)} kg / ${fmtNum(val(e, 'persons'), 0)} P.`;

export function drawElevator(dl: DisplayList, e: { p: V2; rot?: number } & Partial<Elevator>, pen: Pen, thin: Pen, scale = 100, label = true): void {
  const W = val(e as El, 'cabW'), Dd = val(e as El, 'cabD'), dw = val(e as El, 'doorW');
  const ex = fromAngle(e.rot ?? 0), ey = fromAngle((e.rot ?? 0) + Math.PI / 2);
  const Q = (x: number, y: number) => add(e.p, add(mul(ex, x), mul(ey, y)));
  const c = [Q(-W / 2, -Dd / 2), Q(W / 2, -Dd / 2), Q(W / 2, Dd / 2), Q(-W / 2, Dd / 2)];
  dl.poly(c, pen, true);
  dl.line(c[0], c[2], thin, { ns: true }); dl.line(c[1], c[3], thin, { ns: true });
  // Fahrkorbtür (Teleskop) vor der Kabine
  const y0 = -Dd / 2 - 40;
  dl.poly([Q(-dw / 2, y0), Q(dw / 2, y0), Q(dw / 2, y0 - 30), Q(-dw / 2, y0 - 30)], thin, true);
  // Gegengewicht
  const cw = e.cw ?? 'left';
  if (cw !== 'none') {
    const t = 120, l = Math.min(Dd, W) * 0.6;
    const r = cw === 'back' ? [Q(-l / 2, Dd / 2 + 80), Q(l / 2, Dd / 2 + 80), Q(l / 2, Dd / 2 + 80 + t), Q(-l / 2, Dd / 2 + 80 + t)]
      : cw === 'left' ? [Q(-W / 2 - 80 - t, -l / 2), Q(-W / 2 - 80, -l / 2), Q(-W / 2 - 80, l / 2), Q(-W / 2 - 80 - t, l / 2)]
        : [Q(W / 2 + 80, -l / 2), Q(W / 2 + 80 + t, -l / 2), Q(W / 2 + 80 + t, l / 2), Q(W / 2 + 80, l / 2)];
    dl.poly(r, thin, true);
    dl.line(r[0], r[2], thin, { ns: true });
  }
  if (label) dl.text(Q(0, 0), elevatorText(e as El), { size: 2, ha: 'center', va: 'middle', opaque: true, rot: (e.rot ?? 0) }, { ns: true });
  void scale;
}

registerCategory({
  cat: 'elevator', label: 'Lift', plural: 'Lifte', planOrder: 40,
  drawPlan: (ctx, el) => {
    // auf allen bedienten Ebenen
    if (ctx.level && !stops(ctx.doc, el).some((l) => l.id === ctx.level!.id)) return;
    drawElevator(ctx.dl, el as Elevator, catPen(ctx.doc, 'elevator', true), { w: 1 }, ctx.view.scale || 100);
  },
  solids: (el, doc): Solid[] => {
    const z = levelElev(doc, el.levelId);
    const W = val(el, 'cabW'), Dd = val(el, 'cabD'), H = val(el, 'cabH');
    const ex = fromAngle(el.rot ?? 0), ey = fromAngle((el.rot ?? 0) + Math.PI / 2);
    const o = add(el.p, add(mul(ex, -W / 2), mul(ey, -Dd / 2)));
    const out: Solid[] = [{ faces: box3({ x: o.x, y: o.y, z }, { x: ex.x * W, y: ex.y * W, z: 0 }, { x: ey.x * Dd, y: ey.y * Dd, z: 0 }, { x: 0, y: 0, z: H }), color: '#b8bfc6', mat: 'm_stahl' }];
    return out;
  },
  grips: (el, _doc, view) => (isPlanLike(view) ? [{ id: 'p', p: el.p, kind: 'end' as const }, { id: 'r', p: add(el.p, fromAngle((el.rot ?? 0) - Math.PI / 2, val(el, 'cabD') / 2 + 300)), kind: 'end' as const, tip: 'Drehen (Türseite)' }] : []),
  dragGrip: (el, id, p) => (id === 'p' ? { p } : id === 'r' ? { rot: angleOf(sub(p, el.p)) + Math.PI / 2 } : undefined),
  transform: (el, m: Mat2, _doc, view) => {
    if (!isPlanLike(view)) return;
    const d = applyVec(m, fromAngle(el.rot ?? 0));
    return { p: apply(m, el.p), rot: angleOf(d) };
  },
  translate3d: (el, d) => ({ p: { x: el.p.x + d.x, y: el.p.y + d.y } }),
  center: (el) => el.p,
  tagText: (el) => elevatorText(el),
  tagPoint: (el) => el.p,
  props: (): PropDef[] => {
    const g = GROUPS;
    return [
      { key: 'levelId', label: 'Unterste Haltestelle', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
      { key: 'topLevelId', label: 'Oberste Haltestelle', group: g.constraints, type: 'level', get: (e) => e.topLevelId ?? '', set: (_e, v) => ({ topLevelId: v || undefined }) },
      { key: 'cabW', label: 'Kabinenbreite', group: g.dims, type: 'length', get: (e) => val(e, 'cabW'), set: (_e, v) => ({ cabW: Math.max(600, v) }) },
      { key: 'cabD', label: 'Kabinentiefe', group: g.dims, type: 'length', get: (e) => val(e, 'cabD'), set: (_e, v) => ({ cabD: Math.max(600, v) }) },
      { key: 'cabH', label: 'Kabinenhöhe', group: g.dims, type: 'length', get: (e) => val(e, 'cabH'), set: (_e, v) => ({ cabH: Math.max(1800, v) }) },
      { key: 'doorW', label: 'Türbreite', group: g.dims, type: 'length', get: (e) => val(e, 'doorW'), set: (_e, v) => ({ doorW: Math.max(600, v) }) },
      { key: 'cw', label: 'Gegengewicht', group: g.construction, type: 'select', options: [['left', 'links'], ['right', 'rechts'], ['back', 'hinten'], ['none', 'keins (Hydraulik)']], get: (e) => e.cw ?? 'left', set: (_e, v) => ({ cw: v }) },
      { key: 'load', label: 'Nutzlast (kg)', group: g.construction, type: 'number', get: (e) => val(e, 'load'), set: (_e, v) => ({ load: Math.max(0, v) }) },
      { key: 'persons', label: 'Personen', group: g.construction, type: 'int', get: (e) => val(e, 'persons'), set: (_e, v) => ({ persons: Math.max(1, v) }) },
      { key: 'stops', label: 'Haltestellen', group: g.construction, type: 'readonly', get: (e, d) => stops(d, e).map((l) => l.name).join(', ') },
      { key: 'label', label: 'Beschriftung (leer = Lift Nutzlast / Personen)', group: g.text, type: 'text', get: (e) => e.label ?? '', set: (_e, v) => ({ label: v || undefined }) },
      ...identityProps(),
    ];
  },
  scheduleFields: () => [
    { key: 'load', label: 'Nutzlast (kg)', unit: 'num', get: (el) => val(el, 'load') },
    { key: 'persons', label: 'Personen', unit: 'num', get: (el) => val(el, 'persons') },
    { key: 'cabin', label: 'Kabine B × T × H', get: (el) => `${val(el, 'cabW')} × ${val(el, 'cabD')} × ${val(el, 'cabH')}` },
    { key: 'stops', label: 'Haltestellen', unit: 'num', get: (el, doc) => stops(doc, el).length },
    { key: 'travel', label: 'Förderhöhe', unit: 'len', get: (el, doc) => Math.abs((el.topLevelId ? levelElev(doc, el.topLevelId) : levelElev(doc, el.levelId)) - levelElev(doc, el.levelId)) },
    { key: 'level', label: 'Unterste Haltestelle', get: (el, doc) => levelName(doc, el.levelId) },
  ],
  ifc: (el, doc) => ({ entity: 'IfcTransportElement', predefined: 'ELEVATOR', name: elevatorText(el), psets: {
    Pset_TransportElementCommon: { CapacityPeople: val(el, 'persons'), CapacityWeight: val(el, 'load') },
    Pset_TransportElementElevator: { ClearWidth: val(el, 'cabW'), ClearDepth: val(el, 'cabD'), ClearHeight: val(el, 'cabH') },
    CH_Lift: { Nutzlast_kg: val(el, 'load'), Personen: val(el, 'persons'), Kabine: `${val(el, 'cabW')} x ${val(el, 'cabD')} x ${val(el, 'cabH')}`, Haltestellen: stops(doc, el).map((l) => l.name).join(', '), Gegengewicht: el.cw ?? 'left' },
  } }),
});

class ElevatorTool extends Tool {
  id = 'elevator'; label = 'Lift'; kinds = ['plan'];
  private cur: V2 | null = null; private rot = 0;
  prompt(): string { return 'Klicken Sie, um die Kabinenmitte zu platzieren (Tür unten). Leertaste dreht um 90°.'; }
  options(): OptionItem[] { return [{ kind: 'angle', key: 'rot', label: 'Drehung', value: this.rot, onChange: (v) => { this.rot = v; app.redrawOverlay(); } }]; }
  space(): boolean { this.rot = (this.rot + Math.PI / 2) % (2 * Math.PI); app.emit('tool'); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const lvl = activeLevelId(e.view); const ls = levels(app.doc);
    app.doc.transaction('Lift platzieren', () => {
      app.doc.add<Elevator>({ id: newId('lf'), cat: 'elevator', levelId: lvl, topLevelId: ls[ls.length - 1]?.id !== lvl ? ls[ls.length - 1]?.id : undefined, p: e.p, rot: this.rot } as Elevator);
    });
  }
  preview(dl: DisplayList): void { if (this.cur) drawElevator(dl, { p: this.cur, rot: this.rot }, PREVIEW, PREVIEW, 100, false); }
}
registerCommand({ id: 'elevator', label: 'Lift', icon: 'component', tip: 'Liftkabine im Schacht platzieren (Kabine, Tür, Gegengewicht; erscheint auf allen Haltestellen).', run: () => startTool(new ElevatorTool(), 'elevator') });
registerPanel('Architektur', 'Erschließung', ['elevator'], 20);
registerSimilar('elevator', 'elevator');
