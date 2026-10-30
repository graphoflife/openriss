// Tragwerksstützen: Punktbauteil mit Querschnittstyp (STB rechteckig/rund, Stahl-I-Profil),
// Basisebene + Versatz bis oberste Ebene + Versatz. Platzieren per Klick oder „Bei Rastern“.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, rotate, apply, applyVec, angleOf, fromAngle, lineLine, dist, rad, Mat2 } from '../../core/geom';
import { registerCategory, GROUPS, PropDef } from '../../core/registry';
import { View, levelElev, levelOptions, levelAbove, isPlanLike, materialOf } from '../../core/view';
import { cached } from '../../core/cache';
import { prism } from '../../views/sectionEngine';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW, PREVIEW_THIN } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import type { DisplayList } from '../../render/displayList';
import { fmtLen, fmtNum } from '../../core/units';
import { ProfType, profileRing, profileArea, profTypeProps, identityProps, drawStructPlan, ensureTypes, fmtM3, fmtKg, storyTop } from './common';

export interface Column extends El {
  cat: 'column';
  p: V2;
  rot: number;
  levelId: Id;
  baseOffset: number;
  topLevelId: Id | null;
  topOffset: number;
  height: number;
}

export interface ColInfo { z0: number; z1: number; ring: V2[]; t?: ProfType; mat?: Id }
export function colInfo(doc: Doc, c: Column): ColInfo {
  const calc = (): ColInfo => {
    const t = doc.get<ProfType>(c.typeId);
    const z0 = levelElev(doc, c.levelId) + (c.baseOffset ?? 0);
    let z1 = c.topLevelId && doc.get(c.topLevelId) ? levelElev(doc, c.topLevelId) + (c.topOffset ?? 0) : z0 + (c.height ?? 3000);
    if (z1 < z0 + 10) z1 = z0 + 10;
    const ring = profileRing(t).map((q) => add(c.p, rotate(q, c.rot ?? 0)));
    return { z0, z1, ring, t, mat: t?.mat };
  };
  return c.id.startsWith('__') ? calc() : cached(doc, 'colInfo', c.id, calc);
}

function colWeight(doc: Doc, c: Column): number {
  const ci = colInfo(doc, c); const m = materialOf(doc, ci.mat);
  return (profileArea(ci.t) * (ci.z1 - ci.z0) / 1e9) * (m?.density ?? 0);
}

function columnProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Basisebene', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'baseOffset', label: 'Basisversatz', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'topLevelId', label: 'Oberste Ebene', group: g.constraints, type: 'select', options: (doc) => [['', 'Nicht verbunden'], ...levelOptions(doc)], get: (e) => e.topLevelId ?? '', set: (_e, v) => ({ topLevelId: v || null }) },
    { key: 'topOffset', label: 'Versatz oben', group: g.constraints, type: 'length', get: (e) => e.topOffset ?? 0, set: (_e, v) => ({ topOffset: v }) },
    { key: 'height', label: 'Nicht verbundene Höhe', group: g.constraints, type: 'length', get: (e, doc) => { const ci = colInfo(doc, e as Column); return ci.z1 - ci.z0; }, set: (e, v) => (e.topLevelId ? undefined : { height: v }) },
    { key: 'rot', label: 'Drehwinkel', group: g.constraints, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) },
    { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e, doc) => { const ci = colInfo(doc, e as Column); return fmtLen(ci.z1 - ci.z0); } },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => { const ci = colInfo(doc, e as Column); return fmtM3(profileArea(ci.t) * (ci.z1 - ci.z0)); } },
    { key: 'material', label: 'Tragwerksmaterial', group: g.materials, type: 'readonly', get: (e, doc) => materialOf(doc, colInfo(doc, e as Column).mat)?.name ?? '' },
    { key: 'cover', label: 'Betondeckung', group: g.structural, type: 'length', get: (e) => e.rebarCover ?? 0, set: (_e, v) => ({ rebarCover: v > 0 ? v : undefined }) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'column', label: 'Tragwerksstütze', plural: 'Tragwerksstützen', hasTypes: true, planOrder: 15,
  drawPlan: (ctx, el) => {
    const c = el as Column; const ci = colInfo(ctx.doc, c);
    drawStructPlan(ctx, 'column', [[ci.ring]], ci.z0, ci.z1, ci.mat, { below: 'proj', aboveLimit: storyTop(ctx) });
    ctx.dl.circle(c.p, 1, undefined, undefined, { inv: true, sub: 'center' });
  },
  solids: (el, doc) => { const ci = colInfo(doc, el as Column); return [{ faces: prism(ci.ring, ci.z0, ci.z1), mat: ci.mat }]; },
  center: (el) => (el as Column).p,
  tagPoint: (el) => (el as Column).p,
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  transform: (el, m, _doc, view) => (isPlanLike(view) ? colTransform(el as Column, m) : undefined),
  translate3d: (el, d) => {
    const c = el as Column;
    return { p: { x: c.p.x + d.x, y: c.p.y + d.y }, baseOffset: (c.baseOffset ?? 0) + d.z, topOffset: c.topLevelId ? (c.topOffset ?? 0) + d.z : c.topOffset };
  },
  props: () => columnProps(),
  typeProps: () => profTypeProps(),
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => doc.get(el.typeId)?.name ?? '' },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => { const ci = colInfo(doc, el as Column); return ci.z1 - ci.z0; } },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => { const ci = colInfo(doc, el as Column); return profileArea(ci.t) * (ci.z1 - ci.z0); } },
    { key: 'weight', label: 'Gewicht', unit: 'kg', get: (el, doc) => colWeight(doc, el as Column) },
    { key: 'level', label: 'Basisebene', get: (el, doc) => doc.get(el.levelId)?.name ?? '' },
    { key: 'topLevel', label: 'Oberste Ebene', get: (el, doc) => doc.get(el.topLevelId)?.name ?? '' },
    { key: 'material', label: 'Tragwerksmaterial', get: (el, doc) => materialOf(doc, colInfo(doc, el as Column).mat)?.name ?? '' },
  ],
});

export function colTransform(c: Column, m: Mat2): Partial<Column> {
  return { p: apply(m, c.p), rot: angleOf(applyVec(m, fromAngle(c.rot ?? 0))) };
}

// ------------------------------------------------------------ Werkzeug
export class ColumnTool extends Tool {
  id = 'column'; label = 'Tragwerksstütze'; kinds = ['plan'];
  private cur: V2 | null = null; private rot = 0;
  private mode: 'point' | 'grid' = 'point';
  private gridA: V2 | null = null;
  activate(): void {
    ensureTypes(app.doc, 'column');
    const lvl = activeLevelId();
    const above = levelAbove(app.doc, lvl);
    this.placement = placementFor('column', { levelId: lvl, baseOffset: 0, topLevelId: above?.id ?? null, topOffset: 0, height: 3000 });
    const p = this.placement.proto;
    p.levelId = lvl;
    if (!p.topLevelId || !app.doc.get(p.topLevelId) || levelElev(app.doc, p.topLevelId) <= levelElev(app.doc, lvl)) p.topLevelId = above?.id ?? null;
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string {
    if (this.mode === 'grid') return this.gridA ? 'Zweite Ecke des Bereichs klicken – Stützen werden an allen Rasterschnittpunkten im Bereich platziert.' : 'Erste Ecke des Bereichs um die Rasterschnittpunkte klicken.';
    return 'Klicken Sie, um die Stütze zu platzieren. Leertaste dreht um 90°.';
  }
  options(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'buttons', key: 'mode', value: this.mode, options: [{ id: 'point', label: 'Vertikale Stütze', icon: 'column' }, { id: 'grid', label: 'Bei Rastern', icon: 'grid' }], onChange: (v) => { this.mode = v as 'point' | 'grid'; this.gridA = null; app.setPrompt(this.prompt()); app.emit('tool'); } },
      { kind: 'select', key: 'top', label: 'Höhe', value: p.topLevelId ?? '', options: [['', 'Nicht verbunden'], ...levelOptions(app.doc)], onChange: (v) => { p.topLevelId = v || null; app.emit('tool'); } },
      ...(p.topLevelId ? [] : [{ kind: 'length', key: 'height', label: '', value: p.height ?? 3000, onChange: (v: number) => (p.height = v) } as OptionItem]),
      { kind: 'angle', key: 'rot', label: 'Drehung', value: Math.round((this.rot * 180) / Math.PI), onChange: (v) => { this.rot = rad(v); app.redrawOverlay(); } },
    ];
  }
  space(): boolean { this.rot = (this.rot + Math.PI / 2) % (Math.PI * 2); app.emit('tool'); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  basePoint(): V2 | null { return this.mode === 'grid' ? this.gridA : null; }
  escape(): boolean { if (this.gridA) { this.gridA = null; return true; } return false; }
  private make(p: V2): Column {
    const pr = this.placement!.proto;
    return { ...pr, id: newId('cl'), cat: 'column', p, rot: this.rot, typeId: this.placement!.typeId } as Column;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.mode === 'point') {
      app.doc.transaction('Stütze platzieren', () => { app.doc.add(this.make(e.p)); });
      return;
    }
    if (!this.gridA) { this.gridA = e.p; return; }
    const pts = gridIntersections(app.doc, this.gridA, e.p);
    this.gridA = null;
    if (!pts.length) { app.status('Keine Rasterschnittpunkte im Bereich gefunden.'); return; }
    const existing = app.doc.all<Column>('column').filter((c) => c.levelId === this.placement!.proto.levelId);
    let n = 0;
    app.doc.transaction('Stützen bei Rastern', () => {
      for (const p of pts) {
        if (existing.some((c) => dist(c.p, p) < 1)) continue;
        app.doc.add(this.make(p)); n++;
      }
    });
    app.status(`${n} Stütze(n) an Rasterschnittpunkten platziert.`);
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const t = app.doc.get<ProfType>(this.placement!.typeId);
    const ring = (p: V2) => profileRing(t).map((q) => add(p, rotate(q, this.rot)));
    if (this.mode === 'point') { dl.poly(ring(this.cur), PREVIEW, true); return; }
    if (!this.gridA) return;
    const a = this.gridA, c = this.cur;
    dl.poly([a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }], PREVIEW_THIN, true);
    for (const p of gridIntersections(app.doc, a, c)) dl.poly(ring(p), PREVIEW, true);
    void vp;
  }
}

/** Schnittpunkte aller Rasterlinien innerhalb des Rechtecks a-c */
export function gridIntersections(doc: Doc, a: V2, c: V2): V2[] {
  const grids = doc.all('grid').filter((g) => g.a && g.b && !g.arc);
  const x0 = Math.min(a.x, c.x), x1 = Math.max(a.x, c.x), y0 = Math.min(a.y, c.y), y1 = Math.max(a.y, c.y);
  const out: V2[] = [];
  for (let i = 0; i < grids.length; i++) for (let j = i + 1; j < grids.length; j++) {
    const x = lineLine(grids[i].a, grids[i].b, grids[j].a, grids[j].b);
    if (!x || x.t < -0.02 || x.t > 1.02 || x.u < -0.02 || x.u > 1.02) continue;
    const p = x.p;
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    if (out.some((q) => dist(q, p) < 1)) continue;
    out.push(p);
  }
  return out;
}

export function columnsUnder(doc: Doc, ids: Iterable<Id>): Column[] {
  return [...ids].map((id) => doc.get<Column>(id)).filter((c): c is Column => !!c && c.cat === 'column');
}
export { fmtNum, fmtKg };
export type { View };
