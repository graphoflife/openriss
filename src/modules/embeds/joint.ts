// Arbeitsfugen (Kategorie 'joint'): senkrecht in Wänden, waagrecht am Wandfuss/-kopf (oder auf Höhe),
// in Platten (Fugenverlauf als Polylinie). Symbol «AF» in Grundriss, Schnitt und Abwicklung,
// Etappen links/unten | rechts/oben, optional automatisches Fugenblech (gehostete Einlage).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, sub, mul, perp, norm, dist, lerp, apply, Mat2, lineLine } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, PlanCtx, SectionCtx, Grip, catDef } from '../../core/registry';
import { isPlanLike, levelElev, View } from '../../core/view';
import { hostedBy } from '../../core/cache';
import type { DisplayList } from '../../render/displayList';
import { wallFrame, slabInfo, zigzag, polyMid, plen, fmtM, fmtKote, RED, AF_PEN } from './common';
import { registerEmbedHost, Embed, typesOfFamily } from './embed';

export type JointKind = 'wallV' | 'wallH' | 'slab';
export interface Joint extends El {
  cat: 'joint'; kind: JointKind; hostId: Id;
  /** wallV: Lage entlang Wandachse */
  t?: number;
  /** wallH: Wandfuss, Wandkopf oder Höhe dz über Wandunterkante */
  at?: 'base' | 'head' | 'z'; dz?: number;
  /** wallH: Bereich entlang der Wand (fehlt = ganze Wand) */
  u0?: number; u1?: number;
  /** slab: Fugenverlauf */
  pts?: V2[];
  /** Etappen: links/unten/Wandanfang (A) | rechts/oben/Wandende (B) */
  stageA?: number; stageB?: number;
}
export const KIND_LABELS: [JointKind, string][] = [['wallV', 'senkrecht in Wand'], ['wallH', 'waagrecht in Wand (Fuss/Kopf)'], ['slab', 'in Platte']];

// ------------------------------------------------------------ Geometrie
export function wallJointZ(doc: Doc, j: Joint): number | null {
  const F = wallFrame(doc, j.hostId); if (!F) return null;
  return j.at === 'head' ? F.wi.z1 : j.at === 'z' ? F.wi.z0 + (j.dz ?? 0) : F.wi.z0;
}
export function wallJointRange(doc: Doc, j: Joint): [number, number] {
  const F = wallFrame(doc, j.hostId); const L = F?.wi.L ?? 0;
  return [Math.max(0, j.u0 ?? 0), Math.min(L, j.u1 ?? L)];
}
/** Fugenlinie im Grundriss (wallV: quer durch die Wand; wallH: entlang Wandachse; slab: Verlauf) */
export function jointPlanLine(doc: Doc, j: Joint): V2[] {
  if (j.kind === 'slab') return j.pts ?? [];
  const F = wallFrame(doc, j.hostId); if (!F) return [];
  if (j.kind === 'wallV') return [F.P(j.t ?? 0, -F.wi.T / 2), F.P(j.t ?? 0, F.wi.T / 2)];
  const [u0, u1] = wallJointRange(doc, j); return [F.P(u0, 0), F.P(u1, 0)];
}
const stageTxt = (j: Joint) => (j.stageA || j.stageB ? `${j.stageA ?? '–'} | ${j.stageB ?? '–'}` : '');
export function jointTagText(doc: Doc, j: Joint): string {
  const ws = hostedBy(doc, j.id).some((e) => e.cat === 'embed');
  const st = stageTxt(j);
  let pos = '';
  if (j.kind === 'wallH') { const z = wallJointZ(doc, j); pos = j.at === 'base' ? ' Wandfuss' : j.at === 'head' ? ' Wandkopf' : z !== null ? ' ' + fmtKote(z) : ''; }
  return `AF${st ? ' Etappe ' + st : ''}${pos}${ws ? ' (Fugenblech' + (j.kind === 'wallV' ? ' vertikal)' : ')') : ''}`;
}

// ------------------------------------------------------------ Fugenblech am Host ableiten
registerEmbedHost('joint', (doc, e, host) => {
  const j = host as Joint; const L = levelElev(doc, e.levelId);
  if (j.kind === 'slab') {
    const sl = slabInfo(doc, doc.get(j.hostId)); if (!sl || !j.pts || j.pts.length < 2) return null;
    return { mode: 'lying', pts: j.pts, z: (sl.top + sl.bot) / 2 - L };
  }
  const F = wallFrame(doc, j.hostId); if (!F) return null;
  const vc = (F.core[0] + F.core[1]) / 2;
  if (j.kind === 'wallV') return { mode: 'vertical', p: F.P(j.t ?? 0, vc), rot: Math.atan2(F.wi.d.y, F.wi.d.x), z: F.wi.z0 - L, h2: F.wi.z1 - F.wi.z0 };
  const z = wallJointZ(doc, j)!; const [u0, u1] = wallJointRange(doc, j);
  return { mode: 'standing', pts: [F.P(u0, vc), F.P(u1, vc)], z: z - L };
});

/** Fugenblech zur Fuge anlegen bzw. entfernen (in Transaktion) */
export function setJointWaterstop(doc: Doc, j: El, on: boolean, typeId?: Id): void {
  const have = hostedBy(doc, j.id).filter((e) => e.cat === 'embed');
  if (!on) { for (const e of have) doc.remove(e.id); return; }
  if (have.length) return;
  const host = doc.get(j.hostId);
  const t = typeId ?? typesOfFamily(doc, 'waterstop')[0]?.id;
  doc.add<Embed>({ id: newId('em'), cat: 'embed', family: 'waterstop', typeId: t, hostId: j.id, levelId: host?.levelId ?? j.levelId, z: 0 } as Embed);
}

// ------------------------------------------------------------ Grundriss
function drawJointPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; const j = el as Joint; const s = dl.scale;
  const lbl = (p: V2, txt: string) => dl.text(p, txt, { size: 2, color: RED, ha: 'center', va: 'middle', bold: true, opaque: true });
  if (j.kind === 'wallV') {
    const F = wallFrame(doc, j.hostId); if (!F || ctx.ceiling) return;
    const { wi } = F;
    const cut = wi.z0 <= ctx.cutZ && wi.z1 > ctx.cutZ; const below = wi.z1 <= ctx.cutZ && wi.z1 >= ctx.depthZ - 1;
    if (!cut && !below) return;
    const ext = 0.8 * s; const u = j.t ?? 0;
    const a = F.P(u, -wi.T / 2 - ext), b = F.P(u, wi.T / 2 + ext);
    dl.poly(zigzag(a, b, 0.9 * s, 3), AF_PEN);
    dl.line(a, b, { w: 1 }, { inv: true });
    const side = wi.ext; const lp = F.P(u, side * (wi.T / 2 + 3 * s));
    lbl(lp, 'AF');
    const st = stageTxt(j); if (st) dl.text(F.P(u, side * (wi.T / 2 + 6 * s)), st, { size: 1.8, color: RED, ha: 'center', va: 'middle', opaque: true });
    return;
  }
  if (j.kind === 'slab') {
    const sl = slabInfo(doc, doc.get(j.hostId)); const pts = j.pts ?? [];
    if (!sl || pts.length < 2) return;
    const vis = ctx.ceiling ? sl.bot >= ctx.cutZ - 1 && sl.bot <= ctx.topZ + 1 : sl.bot <= ctx.topZ + 1 && sl.top >= ctx.depthZ - 1;
    if (!vis) return;
    dl.poly(pts, { w: 4, color: RED, dash: 'dashdot' });
    const { p, d } = polyMid(pts); const n = perp(d);
    // Zickzack quer in der Mitte, Etappennummern beidseitig
    dl.poly(zigzag(add(p, mul(n, -2 * s)), add(p, mul(n, 2 * s)), 0.8 * s, 2), AF_PEN, false, { ns: true });
    lbl(add(add(p, mul(d, 4 * s)), mul(n, 2.5 * s)), 'AF');
    if (j.stageA) stageBubble(dl, add(p, mul(n, 5 * s)), j.stageA, s);
    if (j.stageB) stageBubble(dl, add(p, mul(n, -5 * s)), j.stageB, s);
  }
}
function stageBubble(dl: DisplayList, p: V2, n: number, s: number): void {
  dl.circle(p, 1.8 * s, { w: 1, color: RED }, { color: '#ffffff' }, { ns: true });
  dl.text(p, String(n), { size: 2, color: RED, ha: 'center', va: 'middle' });
}

// ------------------------------------------------------------ Schnitt / Abwicklung
function drawJointSection(ctx: SectionCtx, el: El): void {
  const { doc, dl } = ctx; const j = el as Joint; const s = dl.scale;
  const lbl = (p: V2, txt: string) => dl.text(p, txt, { size: 2, color: RED, ha: 'center', va: 'bottom', bold: true, opaque: true });
  const right2 = { x: ctx.right.x, y: ctx.right.y };
  const v3 = (p: V2, z: number): V3 => ({ x: p.x, y: p.y, z });
  if (j.kind === 'wallV' || j.kind === 'wallH') {
    const F = wallFrame(doc, j.hostId); if (!F) return;
    const { wi } = F;
    const along = Math.abs(wi.d.x * right2.x + wi.d.y * right2.y) > 0.7;
    if (j.kind === 'wallV') {
      const u = j.t ?? 0; const c = v3(F.P(u, 0), wi.z0); const dep = ctx.depth(c);
      if (!along || dep < -wi.T || dep > ctx.far) return;
      const a = ctx.toView(c), b = ctx.toView(v3(F.P(u, 0), wi.z1));
      dl.line(a, b, AF_PEN);
      lbl({ x: b.x, y: b.y + 1 * s }, 'AF');
      const st = stageTxt(j);
      if (st) { const m = (a.y + b.y) / 2; const dx = (ctx.toView(v3(F.P(u + 100, 0), wi.z0)).x - a.x) > 0 ? 1 : -1;
        if (j.stageA) stageBubble(dl, { x: a.x - dx * 4 * s, y: m }, j.stageA, s); if (j.stageB) stageBubble(dl, { x: a.x + dx * 4 * s, y: m }, j.stageB, s); }
      return;
    }
    const z = wallJointZ(doc, j); if (z === null) return;
    const [u0, u1] = wallJointRange(doc, j);
    if (along) {
      const dep = ctx.depth(v3(F.P((u0 + u1) / 2, 0), z)); if (dep < -wi.T || dep > ctx.far) return;
      const a = ctx.toView(v3(F.P(u0, 0), z)), b = ctx.toView(v3(F.P(u1, 0), z));
      dl.line(a, b, { ...AF_PEN, dash: 'dash' });
      lbl({ x: Math.min(a.x, b.x) + 3 * s, y: a.y + 0.6 * s }, 'AF');
      return;
    }
    // Querschnitt durch die Wand: Zickzack über die Wanddicke
    const A = v3(F.P(u0, 0), z), B = v3(F.P(u1, 0), z); const da = ctx.depth(A), db = ctx.depth(B);
    if ((da < 0) === (db < 0)) return;
    const X = lerp(F.P(u0, 0), F.P(u1, 0), da / (da - db));
    const p0 = ctx.toView(v3(add(X, mul(wi.n, -wi.T / 2 - 0.8 * s)), z)), p1 = ctx.toView(v3(add(X, mul(wi.n, wi.T / 2 + 0.8 * s)), z));
    dl.poly(zigzag(p0, p1, 0.8 * s, 3), AF_PEN);
    lbl({ x: Math.max(p0.x, p1.x) + 2.5 * s, y: p0.y - 1 * s }, 'AF');
    return;
  }
  // Platte: Durchstosspunkte des Fugenverlaufs durch die Schnittebene
  const sl = slabInfo(doc, doc.get(j.hostId)); const pts = j.pts ?? []; if (!sl) return;
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = v3(pts[i], sl.top), B = v3(pts[i + 1], sl.top); const da = ctx.depth(A), db = ctx.depth(B);
    if ((da < 0) === (db < 0)) continue;
    const X = lerp(pts[i], pts[i + 1], da / (da - db));
    const p0 = ctx.toView(v3(X, sl.bot - 0.8 * s)), p1 = ctx.toView(v3(X, sl.top + 0.8 * s));
    dl.poly(zigzag(p0, p1, 0.8 * s, 3), AF_PEN);
    lbl({ x: p1.x, y: p1.y + 1 * s }, 'AF');
  }
}

// ------------------------------------------------------------ Eigenschaften
function jointProps(el: El, doc: Doc): PropDef[] {
  const g = GROUPS; const j = el as Joint;
  const p: PropDef[] = [
    { key: 'kindRo', label: 'Art', group: g.constraints, type: 'readonly', get: (e) => KIND_LABELS.find((k) => k[0] === e.kind)?.[1] ?? '' },
    { key: 'host', label: 'Bauteil', group: g.constraints, type: 'readonly', get: (e, d) => { const h = d.get(e.hostId); return h ? (h.mark || catDef(h.cat)?.label || h.cat) : '–'; } },
  ];
  if (j.kind === 'wallV') p.push({ key: 't', label: 'Lage ab Wandanfang', group: g.constraints, type: 'length', get: (e) => e.t ?? 0, set: (_e, v) => ({ t: Math.max(0, v) }) });
  if (j.kind === 'wallH') {
    p.push({ key: 'at', label: 'Höhe', group: g.constraints, type: 'select', options: [['base', 'Wandfuss'], ['head', 'Wandkopf'], ['z', 'über Wandunterkante']], get: (e) => e.at ?? 'base', set: (_e, v) => ({ at: v }) });
    if (j.at === 'z') p.push({ key: 'dz', label: 'Höhe über Wandunterkante', group: g.constraints, type: 'length', get: (e) => e.dz ?? 0, set: (_e, v) => ({ dz: v }) });
    p.push({ key: 'zAbs', label: 'Kote', group: g.constraints, type: 'readonly', get: (e, d) => { const z = wallJointZ(d, e as Joint); return z === null ? '' : fmtKote(z); } });
  }
  p.push(
    { key: 'stageA', label: j.kind === 'wallH' ? 'Etappe unten' : 'Etappe links / Anfang', group: 'Etappen', type: 'int', get: (e) => e.stageA ?? 0, set: (_e, v) => ({ stageA: v > 0 ? Math.round(v) : undefined }) },
    { key: 'stageB', label: j.kind === 'wallH' ? 'Etappe oben' : 'Etappe rechts / Ende', group: 'Etappen', type: 'int', get: (e) => e.stageB ?? 0, set: (_e, v) => ({ stageB: v > 0 ? Math.round(v) : undefined }) },
    { key: 'waterstop', label: 'Fugenblech', group: g.construction, type: 'bool', get: (e, d) => hostedBy(d, e.id).some((x) => x.cat === 'embed'), set: (e, v, d) => { setJointWaterstop(d, e, !!v); return undefined; } },
    { key: 'len', label: 'Länge', group: g.dims, type: 'readonly', get: (e, d) => fmtM(jointLength(d, e as Joint)) + ' m' },
    { key: 'text', label: 'Beschriftung', group: g.text, type: 'readonly', get: (e, d) => jointTagText(d, e as Joint) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  );
  return p;
}
/** Länge der Fuge (wallV: Wandhöhe, wallH: Bereich, slab: Verlauf) */
export function jointLength(doc: Doc, j: Joint): number {
  if (j.kind === 'slab') return plen(j.pts);
  const F = wallFrame(doc, j.hostId); if (!F) return 0;
  if (j.kind === 'wallV') return F.wi.z1 - F.wi.z0;
  const [u0, u1] = wallJointRange(doc, j); return Math.max(0, u1 - u0);
}
/** Fugenfläche (Länge × Bauteildicke) */
export function jointArea(doc: Doc, j: Joint): number {
  if (j.kind === 'slab') { const sl = slabInfo(doc, doc.get(j.hostId)); return sl ? plen(j.pts) * sl.thick : 0; }
  const F = wallFrame(doc, j.hostId); return F ? jointLength(doc, j) * F.wi.T : 0;
}

// ------------------------------------------------------------ Kategorie
registerCategory({
  cat: 'joint', label: 'Arbeitsfuge', plural: 'Arbeitsfugen', planOrder: 70, hostCats: ['wall', 'floor', 'foundationSlab'],
  drawPlan: drawJointPlan,
  drawSection: drawJointSection,
  center: (el, doc) => { const l = jointPlanLine(doc, el as Joint); return l.length ? polyMid(l).p : null; },
  tagPoint: (el, doc) => { const l = jointPlanLine(doc, el as Joint); return l.length ? polyMid(l).p : null; },
  tagText: (el, doc) => jointTagText(doc, el as Joint),
  ifc: (el, doc) => {
    const j = el as Joint;
    const ps: Record<string, string | number | boolean> = { Art: KIND_LABELS.find((k) => k[0] === j.kind)?.[1] ?? '', Laenge_mm: Math.round(jointLength(doc, j)), Fugenblech: hostedBy(doc, j.id).some((e) => e.cat === 'embed') };
    if (j.stageA) ps.EtappeA = j.stageA; if (j.stageB) ps.EtappeB = j.stageB;
    return { entity: 'IfcBuildingElementProxy', predefined: 'USERDEFINED', name: jointTagText(doc, j), psets: { CH_Arbeitsfuge: ps } };
  },
  grips: (el, doc, view): Grip[] => {
    if (!isPlanLike(view)) return [];
    const j = el as Joint;
    if (j.kind === 'slab') return (j.pts ?? []).map((p, i) => ({ id: 'p:' + i, p, kind: 'end' as const }));
    if (j.kind === 'wallV') { const F = wallFrame(doc, j.hostId); return F ? [{ id: 't', p: F.P(j.t ?? 0, 0), kind: 'end', tip: 'Fuge verschieben' }] : []; }
    return [];
  },
  dragGrip: (el, id, p, doc) => {
    const j = el as Joint;
    if (id === 't') { const F = wallFrame(doc, j.hostId); return F ? { t: Math.max(0, Math.min(F.wi.L, F.uOf(p))) } : undefined; }
    const m = id.match(/^p:(\d+)$/); if (m && j.pts) return { pts: j.pts.map((q, k) => (k === +m[1] ? p : q)) };
  },
  transform: (el, m: Mat2, doc, view: View) => {
    if (!isPlanLike(view)) return;
    const j = el as Joint;
    if (j.kind === 'slab' && j.pts) return { pts: j.pts.map((p) => apply(m, p)) };
    if (j.kind === 'wallV') { const F = wallFrame(doc, j.hostId); if (F) return { t: Math.max(0, Math.min(F.wi.L, F.uOf(apply(m, F.P(j.t ?? 0, 0))))) }; }
  },
  translate3d: (el, d, doc) => {
    const j = el as Joint;
    if (j.kind === 'wallH' && j.at === 'z') return { dz: (j.dz ?? 0) + d.z };
    if (j.kind === 'wallV') { const F = wallFrame(doc, j.hostId); if (F) return { t: (j.t ?? 0) + d.x * F.wi.d.x + d.y * F.wi.d.y }; }
    if (j.kind === 'slab' && j.pts) return { pts: j.pts.map((p) => ({ x: p.x + d.x, y: p.y + d.y })) };
  },
  curve: (el, _doc, view) => (isPlanLike(view) && el.kind === 'slab' && el.pts?.length === 2 ? { a: el.pts[0], b: el.pts[1] } : null),
  setCurve: (el, a, b) => (el.kind === 'slab' && el.pts?.length === 2 ? { pts: [a, b] } : undefined),
  props: (el, doc) => jointProps(el, doc),
  scheduleFields: () => [
    { key: 'kind', label: 'Art', get: (el) => KIND_LABELS.find((k) => k[0] === el.kind)?.[1] ?? '' },
    { key: 'host', label: 'Bauteil', get: (el, doc) => { const h = doc.get(el.hostId); return h ? (h.mark || catDef(h.cat)?.label || '') : ''; } },
    { key: 'stageA', label: 'Etappe A', unit: 'num', get: (el) => el.stageA ?? '' },
    { key: 'stageB', label: 'Etappe B', unit: 'num', get: (el) => el.stageB ?? '' },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => jointLength(doc, el as Joint) },
    { key: 'area', label: 'Fugenfläche', unit: 'area', get: (el, doc) => jointArea(doc, el as Joint) },
    { key: 'waterstop', label: 'Fugenblech', get: (el, doc) => (hostedBy(doc, el.id).some((e) => e.cat === 'embed') ? 'Ja' : 'Nein') },
  ],
});

export { dist, norm, sub, lineLine };
