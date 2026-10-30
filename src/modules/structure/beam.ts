// Träger (Tragwerksrahmen): linienbasiert, Querschnittstyp (STB 30/50, IPE 300 …), Referenzebene +
// Versatz Start/Ende, z-Ausrichtung (Oberkante an Ebene). Grundriss: verdeckt gestrichelt, geschnitten mit Muster.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, sub, mul, norm, perp, dist, apply, mid, segRect, cross3, norm3, sub3 } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, TempDim } from '../../core/registry';
import { levelElev, levelOptions, isPlanLike, materialOf } from '../../core/view';
import { cached } from '../../core/cache';
import { extrudeProfile } from '../../views/sectionEngine';
import { LineDrawTool } from '../../tools/drawTool';
import type { OptionItem } from '../../tools/tool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import type { DisplayList } from '../../render/displayList';
import { PREVIEW } from '../../tools/drawTool';
import { fmtLen } from '../../core/units';
import { ProfType, profileRing, profileArea, profTypeProps, identityProps, drawStructPlan, ensureTypes, fmtM3, storyTop } from './common';

export type ZJust = 'top' | 'center' | 'bottom';
export interface Beam extends El {
  cat: 'beam';
  a: V2; b: V2;
  levelId: Id;
  offA: number; offB: number;
  zJust: ZJust;
  yOff?: number;
}

export interface BeamInfo { d: V2; n: V2; L: number; a: V2; b: V2; zA: number; zB: number; z0: number; z1: number; t?: ProfType; h: number; w: number; ring: V2[]; mat?: Id }
export function beamInfo(doc: Doc, bm: Beam): BeamInfo {
  const calc = (): BeamInfo => {
    const t = doc.get<ProfType>(bm.typeId);
    const h = t?.shape === 'round' ? t.b : t?.h ?? 500, w = t?.b ?? 300;
    const d = norm(sub(bm.b, bm.a)); const n = perp(d);
    const off = mul(n, bm.yOff ?? 0);
    const a = add(bm.a, off), b = add(bm.b, off);
    const lz = levelElev(doc, bm.levelId);
    const zA = lz + (bm.offA ?? 0), zB = lz + (bm.offB ?? 0);
    const j = bm.zJust ?? 'top';
    const top = j === 'top' ? 0 : j === 'center' ? h / 2 : h;
    const z1 = Math.max(zA, zB) + top, z0 = Math.min(zA, zB) + top - h;
    return { d, n, L: dist(bm.a, bm.b), a, b, zA, zB, z0, z1, t, h, w, ring: segRect(a, b, w / 2), mat: t?.mat };
  };
  return bm.id.startsWith('__') ? calc() : cached(doc, 'beamInfo', bm.id, calc);
}

function beamSolids(doc: Doc, bm: Beam) {
  const bi = beamInfo(doc, bm);
  if (bi.L < 1) return [];
  const j = bm.zJust ?? 'top';
  const dy = j === 'top' ? -bi.h / 2 : j === 'center' ? 0 : bi.h / 2;
  const prof = profileRing(bi.t).map((q) => ({ x: q.x, y: q.y + dy }));
  const A: V3 = { x: bi.a.x, y: bi.a.y, z: bi.zA }, B: V3 = { x: bi.b.x, y: bi.b.y, z: bi.zB };
  const dir = norm3(sub3(B, A));
  const u: V3 = { x: bi.n.x, y: bi.n.y, z: 0 };
  const v = norm3(cross3(dir, u));
  const L = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
  return [{ faces: extrudeProfile(prof, A, u, v, dir, L), mat: bi.mat }];
}

function beamProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Referenzebene', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offA', label: 'Versatz Startebene', group: g.constraints, type: 'length', get: (e) => e.offA ?? 0, set: (_e, v) => ({ offA: v }) },
    { key: 'offB', label: 'Versatz Endebene', group: g.constraints, type: 'length', get: (e) => e.offB ?? 0, set: (_e, v) => ({ offB: v }) },
    { key: 'zJust', label: 'z-Ausrichtung', group: g.constraints, type: 'select', options: [['top', 'Oben'], ['center', 'Mitte'], ['bottom', 'Unten']], get: (e) => e.zJust ?? 'top', set: (_e, v) => ({ zJust: v }) },
    { key: 'yOff', label: 'y-Versatz', group: g.constraints, type: 'length', get: (e) => e.yOff ?? 0, set: (_e, v) => ({ yOff: v }) },
    { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(beamInfo(doc, e as Beam).L) },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => { const bi = beamInfo(doc, e as Beam); return fmtM3(profileArea(bi.t) * bi.L); } },
    { key: 'material', label: 'Tragwerksmaterial', group: g.materials, type: 'readonly', get: (e, doc) => materialOf(doc, beamInfo(doc, e as Beam).mat)?.name ?? '' },
    { key: 'cover', label: 'Betondeckung', group: g.structural, type: 'length', get: (e) => e.rebarCover ?? 0, set: (_e, v) => ({ rebarCover: v > 0 ? v : undefined }) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'beam', label: 'Träger', plural: 'Tragwerksrahmen', hasTypes: true, planOrder: 12,
  drawPlan: (ctx, el) => {
    const bm = el as Beam; const bi = beamInfo(ctx.doc, bm);
    if (bi.L < 1) return;
    const shown = drawStructPlan(ctx, 'beam', [[bi.ring]], bi.z0, bi.z1, bi.mat, { below: 'hidden', belowLimit: ctx.depthZ - 1500, aboveLimit: storyTop(ctx) });
    if (shown) ctx.dl.line(bi.a, bi.b, { w: 1 }, { inv: true, sub: 'axis' });
  },
  solids: (el, doc) => beamSolids(doc, el as Beam),
  center: (el) => mid((el as Beam).a, (el as Beam).b),
  tagPoint: (el) => mid((el as Beam).a, (el as Beam).b),
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  curve: (el) => ({ a: (el as Beam).a, b: (el as Beam).b }),
  setCurve: (_el, a, b) => ({ a, b }),
  grips: (el, _doc, view) => (isPlanLike(view) ? [{ id: 'a', p: (el as Beam).a, kind: 'end', tip: 'Trägerende ziehen' }, { id: 'b', p: (el as Beam).b, kind: 'end', tip: 'Trägerende ziehen' }] : []),
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m, _doc, view) => (isPlanLike(view) ? { a: apply(m, (el as Beam).a), b: apply(m, (el as Beam).b) } : undefined),
  translate3d: (el, d) => {
    const bm = el as Beam;
    return { a: { x: bm.a.x + d.x, y: bm.a.y + d.y }, b: { x: bm.b.x + d.x, y: bm.b.y + d.y }, offA: (bm.offA ?? 0) + d.z, offB: (bm.offB ?? 0) + d.z };
  },
  tempDims: (el, doc, view): TempDim[] => {
    if (!isPlanLike(view)) return [];
    const bm = el as Beam; const bi = beamInfo(doc, bm);
    const o = mul(bi.n, bi.w / 2 + view.scale * 5);
    return [{ a: add(bm.a, o), b: add(bm.b, o), value: bi.L, label: 'Länge', apply: (v) => doc.update(bm.id, { b: add(bm.a, mul(bi.d, v)) }) }];
  },
  props: () => beamProps(),
  typeProps: () => profTypeProps(),
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => doc.get(el.typeId)?.name ?? '' },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => beamInfo(doc, el as Beam).L },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => { const bi = beamInfo(doc, el as Beam); return profileArea(bi.t) * bi.L; } },
    { key: 'level', label: 'Referenzebene', get: (el, doc) => doc.get(el.levelId)?.name ?? '' },
    { key: 'material', label: 'Tragwerksmaterial', get: (el, doc) => materialOf(doc, beamInfo(doc, el as Beam).mat)?.name ?? '' },
  ],
});

// ------------------------------------------------------------ Werkzeug
export class BeamTool extends LineDrawTool {
  id = 'beam'; label = 'Träger'; kinds = ['plan'];
  modes: any = ['line', 'pick'];
  activate(): void {
    ensureTypes(app.doc, 'beam');
    const lvl = activeLevelId();
    this.placement = placementFor('beam', { levelId: lvl, offA: 0, offB: 0, zJust: 'top' });
    this.placement.proto.levelId = lvl;
  }
  deactivate(): void { rememberProto(this.placement); }
  pickFilter(cat: string): boolean { return ['wall', 'line', 'grid', 'refplane', 'beam'].includes(cat); }
  extraOptions(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'select', key: 'lvl', label: 'Platzierungsebene', value: p.levelId ?? '', options: levelOptions(app.doc), onChange: (v) => { p.levelId = v; app.emit('tool'); } },
      { kind: 'select', key: 'zj', label: 'z-Ausrichtung', value: p.zJust ?? 'top', options: [['top', 'Oben'], ['center', 'Mitte'], ['bottom', 'Unten']], onChange: (v) => (p.zJust = v) },
    ];
  }
  createSegment(a: V2, b: V2): void {
    const p = this.placement!.proto;
    app.doc.add<Beam>({ ...p, id: newId('bm'), cat: 'beam', a, b, typeId: this.placement!.typeId } as Beam);
  }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void {
    const t = app.doc.get<ProfType>(this.placement!.typeId);
    dl.poly(segRect(a, b, (t?.b ?? 300) / 2), PREVIEW, true);
    dl.line(a, b, { w: 1, color: '#1e6fd9', dash: 'center' });
  }
}
