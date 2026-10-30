// Fundamente: Einzelfundament (Punkt, unter Stützen), Streifenfundament (unter Wänden, von der Wand
// abgeleitet und gehostet), Fundamentplatte/Bodenplatte (Skizze). Grundriss: verdeckt gestrichelt / Schnitt.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, rotate, apply, applyVec, angleOf, fromAngle, polyArea, Poly, rad, perimeter } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, onHook } from '../../core/registry';
import { TypeEl, levelElev, levelOptions, isPlanLike, materialOf } from '../../core/view';
import { cached } from '../../core/cache';
import { prism } from '../../views/sectionEngine';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { Wall, wallInfo, wallShape } from '../../elements/wall';
import { segRect } from '../../core/geom';
import { fmtLen, fmtArea } from '../../core/units';
import { identityProps, drawStructPlan, ensureTypes, fmtM3 } from './common';
import { Column, colInfo } from './column';

export interface FoundType extends TypeEl { b?: number; l?: number; t: number; mat?: Id; description?: string }
export interface FoundIso extends El { cat: 'foundationIsolated'; p: V2; rot: number; levelId: Id; offset: number }
export interface FoundWall extends El { cat: 'foundationWall'; hostId: Id; ecc?: number }
export interface FoundSlab extends El { cat: 'foundationSlab'; loops: V2[][]; levelId: Id; offset: number }

interface FInfo { polys: Poly[]; z0: number; z1: number; mat?: Id; area: number }

function isoInfo(doc: Doc, f: FoundIso): FInfo {
  const t = doc.get<FoundType>(f.typeId);
  const b = t?.b ?? 1000, l = t?.l ?? 1000, h = t?.t ?? 500;
  const ring = [{ x: -b / 2, y: -l / 2 }, { x: b / 2, y: -l / 2 }, { x: b / 2, y: l / 2 }, { x: -b / 2, y: l / 2 }].map((q) => add(f.p, rotate(q, f.rot ?? 0)));
  const z1 = levelElev(doc, f.levelId) + (f.offset ?? 0);
  return { polys: [[ring]], z0: z1 - h, z1, mat: t?.mat, area: b * l };
}
function wallFInfo(doc: Doc, f: FoundWall): FInfo | null {
  const w = doc.get<Wall>(f.hostId); if (!w) return null;
  const t = doc.get<FoundType>(f.typeId);
  const b = t?.b ?? 600, h = t?.t ?? 400;
  const wi = wallInfo(doc, w); if (wi.L < 1) return null;
  const sh = wallShape(doc, w);
  const over = Math.max(0, (b - wi.T) / 2);
  const extA = sh.A.joined ? b / 2 : over, extB = sh.B.joined ? b / 2 : over;
  const o = mul(wi.n, f.ecc ?? 0);
  const ring = segRect(add(wi.c0, o), add(wi.c1, o), b / 2, b / 2, extA, extB);
  return { polys: [[ring]], z0: wi.z0 - h, z1: wi.z0, mat: t?.mat, area: b * (wi.L + extA + extB) };
}
function slabInfo(doc: Doc, f: FoundSlab): FInfo {
  const t = doc.get<FoundType>(f.typeId);
  const z1 = levelElev(doc, f.levelId) + (f.offset ?? 0);
  const poly: Poly = f.loops ?? [];
  return { polys: poly.length ? [poly] : [], z0: z1 - (t?.t ?? 300), z1, mat: t?.mat, area: poly.length ? polyArea(poly) : 0 };
}
export function foundInfo(doc: Doc, el: El): FInfo | null {
  const calc = () => (el.cat === 'foundationIsolated' ? isoInfo(doc, el as FoundIso) : el.cat === 'foundationWall' ? wallFInfo(doc, el as FoundWall) : slabInfo(doc, el as FoundSlab));
  return el.id.startsWith('__') ? calc() : cached(doc, 'foundInfo', el.id, calc);
}

function foundSolids(doc: Doc, el: El) {
  const fi = foundInfo(doc, el); if (!fi) return [];
  return fi.polys.map((p) => ({ faces: prism(p[0], fi.z0, fi.z1, p.slice(1)), mat: fi.mat }));
}
const volume = (doc: Doc, el: El) => { const fi = foundInfo(doc, el); return fi ? fi.area * (fi.z1 - fi.z0) : 0; };

function commonFoundProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => fmtM3(volume(doc, e)) },
    { key: 'elevTop', label: 'Höhe Oberkante', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(foundInfo(doc, e)?.z1 ?? 0) },
    { key: 'elevBot', label: 'Höhe Unterkante', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(foundInfo(doc, e)?.z0 ?? 0) },
    { key: 'cover', label: 'Betondeckung', group: g.structural, type: 'length', get: (e) => e.rebarCover ?? 0, set: (_e, v) => ({ rebarCover: v > 0 ? v : undefined }) },
    ...identityProps(),
  ];
}
const levelProps = (): PropDef[] => [
  { key: 'levelId', label: 'Ebene', group: GROUPS.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
  { key: 'offset', label: 'Höhenversatz von Ebene', group: GROUPS.constraints, type: 'length', get: (e) => e.offset ?? 0, set: (_e, v) => ({ offset: v }) },
];

function foundTypeProps(kind: 'iso' | 'wall' | 'slab'): PropDef[] {
  const g = GROUPS; const p: PropDef[] = [];
  if (kind !== 'slab') p.push({ key: 'b', label: 'Breite', group: g.dims, type: 'length', get: (t) => t.b ?? 0, set: (_t, v) => (v > 0 ? { b: v } : undefined) });
  if (kind === 'iso') p.push({ key: 'l', label: 'Länge', group: g.dims, type: 'length', get: (t) => t.l ?? 0, set: (_t, v) => (v > 0 ? { l: v } : undefined) });
  p.push(
    { key: 't', label: kind === 'slab' ? 'Dicke' : 'Fundamentdicke', group: g.dims, type: 'length', get: (t) => t.t ?? 0, set: (_t, v) => (v > 0 ? { t: v } : undefined) },
    { key: 'mat', label: 'Tragwerksmaterial', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  );
  return p;
}

const fieldsCommon = () => [
  { key: 'type', label: 'Typ', get: (el: El, doc: Doc) => doc.get(el.typeId)?.name ?? '' },
  { key: 'volume', label: 'Volumen', unit: 'vol' as const, get: (el: El, doc: Doc) => volume(doc, el) },
  { key: 'area', label: 'Fläche', unit: 'area' as const, get: (el: El, doc: Doc) => foundInfo(doc, el)?.area ?? 0 },
  { key: 'material', label: 'Tragwerksmaterial', get: (el: El, doc: Doc) => materialOf(doc, foundInfo(doc, el)?.mat)?.name ?? '' },
];

function drawFound(ctx: any, el: El): void {
  const fi = foundInfo(ctx.doc, el); if (!fi) return;
  drawStructPlan(ctx, 'foundation', fi.polys, fi.z0, fi.z1, fi.mat, { below: 'hidden', belowLimit: ctx.depthZ - 3000 });
}

registerCategory({
  cat: 'foundationIsolated', label: 'Einzelfundament', plural: 'Einzelfundamente', hasTypes: true, planOrder: 5,
  drawPlan: drawFound,
  solids: (el, doc) => foundSolids(doc, el),
  center: (el) => (el as FoundIso).p,
  tagPoint: (el) => (el as FoundIso).p,
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  transform: (el, m, _doc, view) => {
    if (!isPlanLike(view)) return;
    const f = el as FoundIso;
    return { p: apply(m, f.p), rot: angleOf(applyVec(m, fromAngle(f.rot ?? 0))) };
  },
  translate3d: (el, d) => { const f = el as FoundIso; return { p: { x: f.p.x + d.x, y: f.p.y + d.y }, offset: (f.offset ?? 0) + d.z }; },
  props: () => [...levelProps(), { key: 'rot', label: 'Drehwinkel', group: GROUPS.constraints, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) }, ...commonFoundProps()],
  typeProps: () => foundTypeProps('iso'),
  scheduleFields: () => [...fieldsCommon(), { key: 'level', label: 'Ebene', get: (el, doc) => doc.get(el.levelId)?.name ?? '' }],
});

registerCategory({
  cat: 'foundationWall', label: 'Streifenfundament', plural: 'Streifenfundamente', hasTypes: true, planOrder: 5,
  drawPlan: drawFound,
  solids: (el, doc) => foundSolids(doc, el),
  center: (el, doc) => { const w = doc.get<Wall>(el.hostId); if (!w) return null; const wi = wallInfo(doc, w); return { x: (wi.c0.x + wi.c1.x) / 2, y: (wi.c0.y + wi.c1.y) / 2 }; },
  tagPoint: (el, doc) => { const w = doc.get<Wall>(el.hostId); if (!w) return null; const wi = wallInfo(doc, w); return { x: (wi.c0.x + wi.c1.x) / 2, y: (wi.c0.y + wi.c1.y) / 2 }; },
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  props: () => [
    { key: 'ecc', label: 'Exzentrizität', group: GROUPS.constraints, type: 'length', get: (e) => e.ecc ?? 0, set: (_e, v) => ({ ecc: v }) },
    { key: 'host', label: 'Wand', group: GROUPS.constraints, type: 'readonly', get: (e, doc) => { const w = doc.get(e.hostId); return w ? doc.get(w.typeId)?.name ?? 'Wand' : '–'; } },
    { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e, doc) => { const w = doc.get<Wall>(e.hostId); return w ? fmtLen(wallInfo(doc, w).L) : ''; } },
    ...commonFoundProps(),
  ],
  typeProps: () => foundTypeProps('wall'),
  scheduleFields: () => [...fieldsCommon(), { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => { const w = doc.get<Wall>(el.hostId); return w ? wallInfo(doc, w).L : 0; } }],
});

registerCategory({
  cat: 'foundationSlab', label: 'Fundamentplatte', plural: 'Fundamentplatten', hasTypes: true, planOrder: 4,
  drawPlan: drawFound,
  solids: (el, doc) => foundSolids(doc, el),
  center: (el) => { const r = (el as FoundSlab).loops?.[0]; if (!r?.length) return null; let x = 0, y = 0; for (const p of r) { x += p.x; y += p.y; } return { x: x / r.length, y: y / r.length }; },
  transform: (el, m, _doc, view) => (isPlanLike(view) ? { loops: (el as FoundSlab).loops.map((r) => r.map((p) => apply(m, p))) } : undefined),
  translate3d: (el, d) => { const f = el as FoundSlab; return { loops: f.loops.map((r) => r.map((p) => ({ x: p.x + d.x, y: p.y + d.y }))), offset: (f.offset ?? 0) + d.z }; },
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  props: () => [
    ...levelProps(),
    { key: 'area', label: 'Fläche', group: GROUPS.dims, type: 'area', get: (e, doc) => foundInfo(doc, e)?.area ?? 0 },
    { key: 'perim', label: 'Umfang', group: GROUPS.dims, type: 'readonly', get: (e) => fmtLen((e as FoundSlab).loops?.reduce((s, r) => s + perimeter(r), 0) ?? 0) },
    { key: 'edit', label: 'Begrenzung', group: GROUPS.constraints, type: 'button', get: () => 'Bearbeiten…', action: (e) => editSlabSketch(e as FoundSlab) },
    ...commonFoundProps(),
  ],
  typeProps: () => foundTypeProps('slab'),
  scheduleFields: () => [...fieldsCommon(), { key: 'level', label: 'Ebene', get: (el, doc) => doc.get(el.levelId)?.name ?? '' }],
});

function editSlabSketch(f: FoundSlab): void {
  if (!f.loops?.length || !app.doc.get(f.id)) return;
  startTool(new SketchTool('Begrenzung bearbeiten', (loops) => {
    app.doc.transaction('Fundamentplatte bearbeiten', () => app.doc.update(f.id, { loops }));
  }, { initial: loopsToSegs(f.loops) }), 'foundationSlab');
}
onHook('dblclick', (el: El) => { if (el.cat === 'foundationSlab') editSlabSketch(el as FoundSlab); });

// ------------------------------------------------------------ Werkzeuge
export class FoundIsoTool extends Tool {
  id = 'foundationIsolated'; label = 'Einzelfundament'; kinds = ['plan'];
  private cur: V2 | null = null; private rot = 0;
  private mode: 'point' | 'column' = 'point';
  private hoverCol: Column | null = null;
  activate(): void {
    ensureTypes(app.doc, 'foundationIsolated');
    const lvl = activeLevelId();
    this.placement = placementFor('foundationIsolated', { levelId: lvl, offset: 0 });
    this.placement.proto.levelId = lvl;
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return this.mode === 'column' ? 'Stütze anklicken – das Fundament wird unter der Stütze platziert.' : 'Klicken Sie, um das Einzelfundament zu platzieren (Oberkante = Ebene + Versatz). Leertaste dreht um 90°.'; }
  options(): OptionItem[] {
    const sel = app.selected().filter((e) => e.cat === 'column') as Column[];
    const o: OptionItem[] = [
      { kind: 'buttons', key: 'mode', value: this.mode, options: [{ id: 'point', label: 'Punkt', icon: 'foundation' }, { id: 'column', label: 'Stütze wählen', icon: 'column' }], onChange: (v) => { this.mode = v as 'point' | 'column'; app.setPrompt(this.prompt()); app.emit('tool'); } },
    ];
    if (sel.length) o.push({ kind: 'button', label: `Unter ${sel.length} gewählten Stütze(n)`, icon: 'check', primary: true, onClick: () => this.underColumns(sel) });
    return o;
  }
  space(): boolean { this.rot = (this.rot + Math.PI / 2) % (Math.PI * 2); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void {
    this.cur = e.p; this.hoverCol = null;
    if (this.mode === 'column') {
      for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el?.cat === 'column') { this.hoverCol = el as Column; break; } }
    }
  }
  private make(p: V2, rot: number, extra: Partial<FoundIso> = {}): FoundIso {
    return { ...this.placement!.proto, id: newId('fi'), cat: 'foundationIsolated', p, rot, typeId: this.placement!.typeId, ...extra } as FoundIso;
  }
  private underColumns(cols: Column[]): void {
    const doc = app.doc; let n = 0;
    doc.transaction('Einzelfundamente unter Stützen', () => {
      for (const c of cols) {
        const ci = colInfo(doc, c);
        if (doc.all<FoundIso>('foundationIsolated').some((f) => Math.hypot(f.p.x - c.p.x, f.p.y - c.p.y) < 1)) continue;
        doc.add(this.make({ ...c.p }, c.rot ?? 0, { levelId: c.levelId, offset: ci.z0 - levelElev(doc, c.levelId) }));
        n++;
      }
    });
    app.status(`${n} Einzelfundament(e) platziert.`);
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.mode === 'column') {
      if (!this.hoverCol) { app.status('Keine Stütze unter dem Cursor.'); return; }
      this.underColumns([this.hoverCol]);
      return;
    }
    app.doc.transaction('Einzelfundament platzieren', () => { app.doc.add(this.make(e.p, this.rot)); });
  }
  preview(dl: DisplayList): void {
    const t = app.doc.get<FoundType>(this.placement!.typeId);
    const b = t?.b ?? 1000, l = t?.l ?? 1000;
    const at = this.mode === 'column' ? this.hoverCol?.p : this.cur;
    if (!at) return;
    const rot = this.mode === 'column' ? this.hoverCol?.rot ?? 0 : this.rot;
    dl.poly([{ x: -b / 2, y: -l / 2 }, { x: b / 2, y: -l / 2 }, { x: b / 2, y: l / 2 }, { x: -b / 2, y: l / 2 }].map((q) => add(at, rotate(q, rot))), PREVIEW, true);
  }
}

export class FoundWallTool extends Tool {
  id = 'foundationWall'; label = 'Streifenfundament'; kinds = ['plan'];
  private hover: Wall | null = null;
  activate(): void {
    ensureTypes(app.doc, 'foundationWall');
    this.placement = placementFor('foundationWall', { ecc: 0 });
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Wand wählen – das Streifenfundament wird unter der Wand erzeugt.'; }
  options(): OptionItem[] {
    const sel = app.selected().filter((e) => e.cat === 'wall') as Wall[];
    return sel.length ? [{ kind: 'button', label: `Unter ${sel.length} gewählten Wand/Wänden`, icon: 'check', primary: true, onClick: () => this.create(sel) }] : [];
  }
  move(e: ToolEvent): void {
    this.hover = null;
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el?.cat === 'wall') { this.hover = el as Wall; break; } }
  }
  private create(walls: Wall[]): void {
    const doc = app.doc; let n = 0;
    doc.transaction('Streifenfundament', () => {
      for (const w of walls) {
        if (doc.all('foundationWall').some((f) => f.hostId === w.id)) continue;
        doc.add({ ...this.placement!.proto, id: newId('fw'), cat: 'foundationWall', hostId: w.id, typeId: this.placement!.typeId } as FoundWall);
        n++;
      }
    });
    if (!n) app.status('Die Wand hat bereits ein Streifenfundament.');
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.hover) { app.status('Keine Wand unter dem Cursor.'); return; }
    this.create([this.hover]);
  }
  preview(dl: DisplayList): void {
    if (!this.hover) return;
    const fi = wallFInfo(app.doc, { id: '__p', cat: 'foundationWall', hostId: this.hover.id, typeId: this.placement!.typeId, ecc: this.placement!.proto.ecc ?? 0 } as FoundWall);
    if (fi) for (const p of fi.polys) dl.poly(p[0], PREVIEW, true);
  }
}

/** Fundamentplatte: Skizzenwerkzeug mit Typ aus der Palette */
export function startFoundationSlab(): void {
  ensureTypes(app.doc, 'foundationSlab');
  const lvl = activeLevelId();
  const placement = placementFor('foundationSlab', { levelId: lvl, offset: 0 });
  placement.proto.levelId = lvl;
  const t = new SketchTool('Fundamentplatte', (loops) => {
    rememberProto(placement);
    app.doc.transaction('Fundamentplatte', () => {
      app.doc.add({ ...placement.proto, id: newId('fs'), cat: 'foundationSlab', loops, typeId: placement.typeId } as FoundSlab);
    });
  });
  t.placement = placement;
  startTool(t, 'foundationSlab');
}

export { fmtArea, rad };
