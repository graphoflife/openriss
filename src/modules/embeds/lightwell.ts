// Bauteilfamilie «Lichtschacht (Fertigteil)»: an eine Wand gesetzt (Aussenseite), Breite/Tiefe/Höhe, Wand-
// und Bodenstärke, Gitterrost, Ankerschienen (als gehostete Einlagen, Geometrie vom Lichtschacht abgeleitet).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, sub, apply, dot } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, PlanCtx, Grip } from '../../core/registry';
import { TypeEl, levelElev, levelOptions, isPlanLike, View } from '../../core/view';
import { hostedBy } from '../../core/cache';
import { prism, catPen, cutFill } from '../../views/sectionEngine';
import { materialOf } from '../../core/view';
import { wallFrame, WallFrame, fmtM, fmtKote, addObjStyle } from './common';
import { registerEmbedHost, Embed, typesOfFamily, P as embP } from './embed';

export interface LightwellType extends TypeEl {
  of: 'lightwell'; W?: number; D?: number; H?: number; tw?: number; tb?: number; mat?: Id;
  grating?: string; gratingH?: number; rails?: number; railEdge?: number; product?: string; maker?: string; description?: string;
}
export interface Lightwell extends El { cat: 'lightwell'; hostId: Id; t: number; levelId: Id; zTop: number; flip?: boolean }

const lt = (doc: Doc, el: El) => doc.get<LightwellType>(el.typeId);
const num = (doc: Doc, el: El, k: keyof LightwellType & string, fb: number): number => { const v = el[k] ?? (lt(doc, el) as any)?.[k]; return typeof v === 'number' ? v : fb; };
export const lwDims = (doc: Doc, el: El) => ({
  W: num(doc, el, 'W', 1500), D: num(doc, el, 'D', 1000), H: num(doc, el, 'H', 1450), tw: num(doc, el, 'tw', 60), tb: num(doc, el, 'tb', 80),
  gH: num(doc, el, 'gratingH', 30), rails: num(doc, el, 'rails', 2), edge: num(doc, el, 'railEdge', 150),
});

/** Lage: Wandsystem, Aussenseite s (+1 links, −1 rechts), Oberkante absolut */
export function lwFrame(doc: Doc, el: El): { F: WallFrame; s: number; face: number; top: number; bot: number; L(x: number, y: number): V2 } | null {
  const F = wallFrame(doc, el.hostId); if (!F) return null;
  const s = (el.flip ? -1 : 1) * F.wi.ext;
  const face = s * F.wi.T / 2;
  const top = levelElev(doc, el.levelId) + (el.zTop ?? 0); const { H } = lwDims(doc, el);
  // lokale Koordinaten: x entlang Wand (ab Schachtmitte), y von der Wandfläche nach aussen
  return { F, s, face, top, bot: top - H, L: (x: number, y: number) => F.P((el.t ?? 0) + x, face + s * y) };
}
/** Grundriss: U-Form der Schachtwände (offene Seite an der Wand) und Innenfläche */
export function lwRings(doc: Doc, el: El): { u: V2[]; inner: V2[]; outer: V2[] } | null {
  const fr = lwFrame(doc, el); if (!fr) return null;
  const { W, D, tw } = lwDims(doc, el); const w = W / 2; const L = fr.L;
  const u = [L(-w, 0), L(-w, D), L(w, D), L(w, 0), L(w - tw, 0), L(w - tw, D - tw), L(-w + tw, D - tw), L(-w + tw, 0)];
  return { u, inner: [L(-w + tw, 0), L(w - tw, 0), L(w - tw, D - tw), L(-w + tw, D - tw)], outer: [L(-w, 0), L(w, 0), L(w, D), L(-w, D)] };
}

function drawLwPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; const fr = lwFrame(doc, el); const R = lwRings(doc, el); if (!fr || !R || ctx.ceiling) return;
  if (fr.top < ctx.depthZ - 1 || fr.bot > ctx.cutZ) return;
  const t = lt(doc, el); const m = materialOf(doc, t?.mat);
  const cut = fr.bot <= ctx.cutZ && fr.top > ctx.cutZ;
  const proj = catPen(doc, 'lightwell', false);
  if (cut) dl.fill([R.u], cutFill(m?.cutPattern, m?.cutColor, ctx.detail), catPen(doc, 'lightwell', true));
  else dl.poly(R.u, proj, true);
  // Gitterrost (sichtbar von oben, wenn unter der Schnittebene)
  if (fr.top <= ctx.cutZ + 1) {
    dl.fill([R.inner], { color: '#ffffff', pattern: ctx.detail === 'coarse' ? undefined : 'grid', patColor: '#707070' }, { w: 1 });
    dl.line(R.inner[0], R.inner[2], { w: 1, color: '#707070' }, { ns: true });
  }
}

registerCategory({
  cat: 'lightwell', label: 'Lichtschacht (Fertigteil)', plural: 'Lichtschächte', hasTypes: true, planOrder: 30, hostCats: ['wall'],
  drawPlan: drawLwPlan,
  solids: (el, doc) => {
    const fr = lwFrame(doc, el); const R = lwRings(doc, el); if (!fr || !R) return [];
    const { tb, gH } = lwDims(doc, el); const mat = lt(doc, el)?.mat;
    return [
      { faces: prism(R.u, fr.bot, fr.top), mat },
      { faces: prism(R.inner, fr.bot, fr.bot + tb), mat },
      { faces: prism(R.inner, fr.top - gH, fr.top), color: '#8a9096', mat: 'm_stahl', noCut: true },
    ];
  },
  center: (el, doc) => { const fr = lwFrame(doc, el); if (!fr) return null; return fr.L(0, lwDims(doc, el).D / 2); },
  tagPoint: (el, doc) => { const fr = lwFrame(doc, el); if (!fr) return null; return fr.L(0, lwDims(doc, el).D + 400); },
  tagText: (el, doc) => { const t = lt(doc, el); const d = lwDims(doc, el); return `${el.mark ? el.mark + ' ' : ''}Lichtschacht Fertigteil ${fmtM(d.W)}/${fmtM(d.D)}/${fmtM(d.H)}${t?.rails ? `, Ankerschienen ${2 * d.rails} × ${railProduct(doc, el)}` : ''}`; },
  grips: (el, doc, view): Grip[] => {
    if (!isPlanLike(view)) return [];
    const fr = lwFrame(doc, el); if (!fr) return [];
    const D = lwDims(doc, el).D;
    return [{ id: 'flip', p: fr.L(0, D + view.scale * 4), kind: 'flip', dir: mul(fr.F.wi.n, fr.s), tip: 'Wandseite wechseln' }, { id: 'c', p: fr.L(0, D), kind: 'end', tip: 'Verschieben' }];
  },
  clickGrip: (el, id) => (id === 'flip' ? { flip: !el.flip } : undefined),
  dragGrip: (el, id, p, doc) => { if (id !== 'c') return; const F = wallFrame(doc, el.hostId); return F ? { t: Math.max(0, Math.min(F.wi.L, F.uOf(p))) } : undefined; },
  transform: (el, m, doc, view: View) => {
    if (!isPlanLike(view)) return; const F = wallFrame(doc, el.hostId); if (!F) return;
    return { t: Math.max(0, Math.min(F.wi.L, F.uOf(apply(m, F.P(el.t ?? 0, 0))))) };
  },
  translate3d: (el, d, doc) => { const F = wallFrame(doc, el.hostId); return F ? { t: (el.t ?? 0) + dot(d, F.wi.d), zTop: (el.zTop ?? 0) + d.z } : undefined; },
  props: () => lwProps(),
  typeProps: () => lwTypeProps(),
  ifc: (el, doc) => {
    const t = lt(doc, el); const d = lwDims(doc, el);
    return { entity: 'IfcBuildingElementProxy', predefined: 'ELEMENT', name: catDef_tag(el, doc), psets: { CH_Fertigteil: {
      Produkt: t?.product ?? t?.name ?? '', Hersteller: t?.maker ?? '', Breite_mm: d.W, Tiefe_mm: d.D, Hoehe_mm: d.H, Gitterrost: t?.grating ?? '', Ankerschienen: `${2 * d.rails} × ${railProduct(doc, el)}`,
      OK_m: Math.round(lwFrame(doc, el)?.top ?? 0) / 1000 } } };
  },
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => lt(doc, el)?.name ?? '' },
    { key: 'W', label: 'Breite', unit: 'len', get: (el, doc) => lwDims(doc, el).W },
    { key: 'D', label: 'Tiefe', unit: 'len', get: (el, doc) => lwDims(doc, el).D },
    { key: 'H', label: 'Höhe', unit: 'len', get: (el, doc) => lwDims(doc, el).H },
    { key: 'top', label: 'OK (Kote)', get: (el, doc) => { const fr = lwFrame(doc, el); return fr ? fmtKote(fr.top) : ''; } },
    { key: 'bot', label: 'UK (Kote)', get: (el, doc) => { const fr = lwFrame(doc, el); return fr ? fmtKote(fr.bot) : ''; } },
    { key: 'grating', label: 'Gitterrost', get: (el, doc) => lt(doc, el)?.grating ?? '' },
    { key: 'rails', label: 'Ankerschienen', unit: 'num', get: (el, doc) => hostedBy(doc, el.id).filter((e) => e.cat === 'embed').length },
  ],
});
function catDef_tag(el: El, doc: Doc): string { const d = lwDims(doc, el); return `${el.mark ? el.mark + ' ' : ''}Lichtschacht Fertigteil ${fmtM(d.W)}/${fmtM(d.D)}/${fmtM(d.H)}`; }
const railProduct = (doc: Doc, el: El): string => { const r = hostedBy(doc, el.id).find((e) => e.cat === 'embed'); const t = r ? doc.get(r.typeId) : typesOfFamily(doc, 'anchorChannel')[0]; return t?.product ?? t?.name ?? 'Ankerschiene'; };

function lwProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (e, v, doc) => ({ levelId: v, zTop: (e.zTop ?? 0) + levelElev(doc, e.levelId) - levelElev(doc, v) }) },
    { key: 'zTop', label: 'Oberkante über Ebene', group: g.constraints, type: 'length', get: (e) => e.zTop ?? 0, set: (_e, v) => ({ zTop: v }) },
    { key: 'ok', label: 'OK / UK (Kote)', group: g.constraints, type: 'readonly', get: (e, doc) => { const fr = lwFrame(doc, e); return fr ? `${fmtKote(fr.top)} / ${fmtKote(fr.bot)}` : ''; } },
    { key: 't', label: 'Lage (Mitte ab Wandanfang)', group: g.constraints, type: 'length', get: (e) => e.t ?? 0, set: (_e, v) => ({ t: v }) },
    { key: 'flip', label: 'Andere Wandseite', group: g.constraints, type: 'bool', get: (e) => !!e.flip, set: (_e, v) => ({ flip: !!v }) },
    { key: 'H', label: 'Höhe (Instanz)', group: g.dims, type: 'length', get: (e, doc) => lwDims(doc, e).H, set: (_e, v) => ({ H: v > 0 ? v : undefined }) },
    { key: 'rails', label: 'Ankerschienen', group: g.construction, type: 'button', get: (e, doc) => `${hostedBy(doc, e.id).filter((x) => x.cat === 'embed').length} – neu erzeugen`, action: (e, doc) => doc.transaction('Ankerschienen erzeugen', () => createRails(doc, e)) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}
function lwTypeProps(): PropDef[] {
  const g = GROUPS;
  const L = (k: string, label: string): PropDef => ({ key: k, label, group: g.dims, type: 'length', get: (t) => t[k] ?? 0, set: (_t, v) => (v > 0 ? { [k]: v } : undefined) });
  return [
    L('W', 'Breite (lichte Breite + Wände)'), L('D', 'Tiefe'), L('H', 'Höhe'), L('tw', 'Wandstärke'), L('tb', 'Bodenstärke'), L('gratingH', 'Rosthöhe'),
    { key: 'grating', label: 'Gitterrost', group: g.construction, type: 'text', get: (t) => t.grating ?? '', set: (_t, v) => ({ grating: v }) },
    { key: 'rails', label: 'Ankerschienen je Seite', group: g.construction, type: 'int', get: (t) => t.rails ?? 2, set: (_t, v) => (v >= 0 ? { rails: Math.round(v) } : undefined) },
    L('railEdge', 'Randabstand Ankerschienen'),
    { key: 'product', label: 'Produkt', group: g.identity, type: 'text', get: (t) => t.product ?? '', set: (_t, v) => ({ product: v || undefined }) },
    { key: 'maker', label: 'Hersteller', group: g.identity, type: 'text', get: (t) => t.maker ?? '', set: (_t, v) => ({ maker: v || undefined }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
  ];
}

// ------------------------------------------------------------ Ankerschienen (Einlagen am Lichtschacht)
/** Lage der Ankerschiene Nr. slot: je Schachtseite (links/rechts) `rails` Schienen über die Höhe, waagrecht in der Wandfläche */
registerEmbedHost('lightwell', (doc, e, host) => {
  const fr = lwFrame(doc, host); if (!fr) return null;
  const d = lwDims(doc, host); const n = Math.max(0, d.rails); const k = e.slot ?? 0;
  if (k >= 2 * n || n === 0) return null;
  const sideX = k < n ? -1 : 1; const i = k % n;
  const x = sideX * (d.W / 2 - d.tw / 2);
  const z = n === 1 ? (fr.top + fr.bot) / 2 : fr.top - d.edge - (i * (d.H - 2 * d.edge)) / (n - 1);
  const len = embP(doc, e, 'L');
  const a = fr.F.P((host.t ?? 0) + x - len / 2, fr.face), b = fr.F.P((host.t ?? 0) + x + len / 2, fr.face);
  // Betonseite: zur Wandachse (in Zeichenrichtung a→b liegt die Wand links, wenn s > 0 und Wandrichtung d)
  const side = (fr.s > 0 ? -1 : 1) as 1 | -1;
  return { pts: [a, b], z: z - levelElev(doc, e.levelId), face: 'v', side };
});

export function createRails(doc: Doc, lw: El, typeId?: Id): void {
  for (const e of hostedBy(doc, lw.id)) if (e.cat === 'embed') doc.remove(e.id);
  const n = lwDims(doc, lw).rails;
  const t = typeId ?? typesOfFamily(doc, 'anchorChannel')[0]?.id;
  for (let k = 0; k < 2 * n; k++) doc.add<Embed>({ id: newId('em'), cat: 'embed', family: 'anchorChannel', typeId: t, hostId: lw.id, levelId: lw.levelId, z: 0, slot: k } as Embed);
}

// ------------------------------------------------------------ Vorlage
export function lightwellTemplate(): El[] {
  return [
    { id: 'm_polymerbeton', cat: 'material', name: 'Polymerbeton (Fertigteil)', color: '#9aa0a6', cutPattern: 'concrete', density: 2200 } as El,
    { id: 'lwt_150100', cat: 'type', of: 'lightwell', name: 'Lichtschacht 150/100', W: 1500, D: 1000, H: 1450, tw: 60, tb: 80, gratingH: 30, rails: 2, railEdge: 150, mat: 'm_polymerbeton', grating: 'Gitterrost 30/30 begehbar, gesichert', product: 'Fertigteil-Lichtschacht 150/100' } as El,
    { id: 'lwt_200100', cat: 'type', of: 'lightwell', name: 'Lichtschacht 200/100', W: 2000, D: 1000, H: 1450, tw: 60, tb: 80, gratingH: 30, rails: 2, railEdge: 150, mat: 'm_polymerbeton', grating: 'Gitterrost 30/30 begehbar, gesichert', product: 'Fertigteil-Lichtschacht 200/100' } as El,
    { id: 'lwt_10060', cat: 'type', of: 'lightwell', name: 'Lichtschacht 100/60', W: 1000, D: 600, H: 1000, tw: 50, tb: 70, gratingH: 30, rails: 1, railEdge: 150, mat: 'm_polymerbeton', grating: 'Gitterrost 30/10', product: 'Fertigteil-Lichtschacht 100/60' } as El,
  ];
}
addObjStyle('lightwell', 'Lichtschächte (Fertigteil)', 2, 4);
export { add, sub };
