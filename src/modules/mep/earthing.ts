// Fundamenterder (Kategorie 'earthing'): Ring- und Maschenerder in der Fundamentplatte (V4A Ø10 bzw. Band),
// Anschlussfahnen. Lage: Plattenunterseite + Überdeckung (oder Höhe über Ebene). Befehl «Fundamenterder entlang
// Plattenrand» erzeugt Ring + Maschen (Maschenweite ≤ 20 m). Liste (Länge), IFC IfcCableSegment CONDUCTORSEGMENT.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, dist, apply, Mat2, ensureCCW, signedArea, offsetPolyline, bboxOf, polylineLength } from '../../core/geom';
import { registerCategory, registerCommand, GROUPS, PropDef, Grip } from '../../core/registry';
import { levelElev, isPlanLike } from '../../core/view';
import { fmtNum } from '../../core/units';
import { surfaceOf } from '../../views/surfaces';
import { app } from '../../app';
import { SketchTool } from '../../tools/sketchTool';
import { activeLevelId } from '../../tools/elementTools';
import { startTool } from '../../ui/commands';
import { sysPen, discVisible, sweep, circleProfile, fillTag, tagFormatOf, MepSystem } from './common';

export interface Earthing extends El {
  cat: 'earthing'; levelId: Id;
  /** Fundamentplatte (Lage: Unterseite + Überdeckung) */
  hostId?: Id;
  /** Erderverlauf: Linienzüge (geschlossene Ringe: erster = letzter Punkt) */
  paths: V2[][];
  /** Überdeckung ab Plattenunterseite bzw. Höhe über Ebene ohne Platte */
  cover?: number; offset?: number;
  /** Werkstoff und Querschnitt */
  werkstoff?: string; dia?: number;
  /** Anschlussfahnen (z.B. bei HAK/PAS, Blitzschutz) */
  lugs?: { p: V2; label?: string; h?: number }[];
  tagFmt?: string;
}
export const EARTH_TAG = 'Fundamenterder {werkstoff} Ø{dia}';
const SYS: MepSystem = { id: 'sys_erd', cat: 'type', of: 'mepSystem', name: 'Elektro Erdung / Fundamenterder', abbr: 'ERD', disc: 'E', color: '#2e7d32', dash: 'dashdot', pen: 3 } as any;
const sysE = (doc: Doc) => (doc.get<MepSystem>('sys_erd') ?? SYS);

/** Höhe der Erderachse */
export function earthZ(doc: Doc, e: El, p: V2): number {
  const host = doc.get(e.hostId); const sf = surfaceOf(doc, host);
  if (sf) return sf.botAt(p) + (e.cover ?? 50) + (e.dia ?? 10) / 2;
  return levelElev(doc, e.levelId) + (e.offset ?? -150);
}
export const earthLength = (e: El) => (e.paths ?? []).reduce((s: number, p: V2[]) => s + polylineLength(p), 0);

/** Ring (Plattenrand nach innen versetzt) und Maschen (≤ mesh) für eine Fundamentplatte */
export function earthPathsForSlab(doc: Doc, slab: El, edge = 300, mesh = 20000): V2[][] {
  const outer = ensureCCW((slab.loops?.[0] ?? []) as V2[]);
  if (outer.length < 3) return [];
  // nach innen versetzen (CCW: links = innen)
  const ring = offsetPolyline(outer, edge, true);
  if (signedArea(ring) <= 0) return [];
  const out: V2[][] = [[...ring, ring[0]]];
  const bb = bboxOf(ring);
  const lines = (axis: 'x' | 'y') => {
    const lo = axis === 'x' ? bb.min.x : bb.min.y, hi = axis === 'x' ? bb.max.x : bb.max.y;
    const n = Math.ceil((hi - lo) / mesh);
    for (let i = 1; i < n; i++) {
      const c = lo + ((hi - lo) * i) / n;
      // Schnitte der Geraden mit dem Ring → Innenabschnitte
      const ts: number[] = [];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        const va = axis === 'x' ? a.x : a.y, vb = axis === 'x' ? b.x : b.y;
        if ((va - c) * (vb - c) < 0) { const t = (c - va) / (vb - va); ts.push(axis === 'x' ? a.y + (b.y - a.y) * t : a.x + (b.x - a.x) * t); }
      }
      ts.sort((u, v) => u - v);
      for (let k = 0; k + 1 < ts.length; k += 2) out.push(axis === 'x' ? [{ x: c, y: ts[k] }, { x: c, y: ts[k + 1] }] : [{ x: ts[k], y: c }, { x: ts[k + 1], y: c }]);
    }
  };
  lines('x'); lines('y');
  return out;
}
/** Fundamenterder entlang des Plattenrands erzeugen (in Transaktion) */
export function addEarthing(doc: Doc, slabId: Id, o: { edge?: number; mesh?: number } & Partial<Earthing> = {}): Earthing | null {
  const slab = doc.get(slabId); if (!slab?.loops) return null;
  const { edge, mesh, ...rest } = o;
  const paths = earthPathsForSlab(doc, slab, edge ?? 300, mesh ?? 20000);
  if (!paths.length) return null;
  return doc.add<Earthing>({ werkstoff: 'V4A', dia: 10, cover: 50, ...rest, id: newId('fe'), cat: 'earthing', levelId: slab.levelId, hostId: slab.id, paths } as Earthing);
}

function tagText(doc: Doc, e: El): string {
  return fillTag(tagFormatOf(doc, e, EARTH_TAG), { werkstoff: e.werkstoff ?? 'V4A', dia: fmtNum(e.dia ?? 10, 0), len: fmtNum(earthLength(e) / 1000, 1) + ' m', lugs: (e.lugs ?? []).length || '' });
}

registerCategory({
  cat: 'earthing', label: 'Fundamenterder', plural: 'Fundamenterder', planOrder: 35, hostCats: ['foundationSlab', 'floor'],
  discipline: 'mep',
  visibleIn: (_el, _doc, view) => discVisible(view, 'E'),
  drawPlan: (ctx, el) => {
    if (ctx.level && el.levelId !== ctx.level.id) return;
    const pen = sysPen(sysE(ctx.doc), 3);
    for (const p of el.paths ?? []) if (p.length >= 2) ctx.dl.poly(p, pen);
    const s = ctx.view.scale || 100;
    for (const l of el.lugs ?? []) {
      ctx.dl.circle(l.p, 1.6 * s, { ...pen, dash: undefined });
      ctx.dl.line(add(l.p, { x: -1.6 * s, y: -1.6 * s }), add(l.p, { x: 1.6 * s, y: 1.6 * s }), { ...pen, dash: undefined });
      if (l.label) ctx.dl.text(add(l.p, { x: 2.2 * s, y: 0 }), l.label, { size: 2, va: 'middle', color: pen.color });
    }
  },
  solids: (el, doc) => {
    const r = (el.dia ?? 10) / 2; const out = [];
    for (const p of el.paths ?? []) {
      if (p.length < 2) continue;
      const P: V3[] = p.map((q: V2) => ({ x: q.x, y: q.y, z: earthZ(doc, el, q) }));
      const f = sweep(P, circleProfile(r, 8));
      if (f.length) out.push({ faces: f, color: '#2e7d32' });
    }
    for (const l of el.lugs ?? []) {
      const z = earthZ(doc, el, l.p);
      const f = sweep([{ x: l.p.x, y: l.p.y, z }, { x: l.p.x, y: l.p.y, z: z + (l.h ?? 1000) }], circleProfile(r, 8));
      if (f.length) out.push({ faces: f, color: '#2e7d32' });
    }
    return out;
  },
  grips: (el, _doc, view): Grip[] => {
    if (!isPlanLike(view)) return [];
    const g: Grip[] = [];
    (el.paths ?? []).forEach((p: V2[], i: number) => p.forEach((q, j) => { if (!(j === p.length - 1 && p.length > 2 && dist(q, p[0]) < 1)) g.push({ id: `p:${i}:${j}`, p: q, kind: 'end' }); }));
    (el.lugs ?? []).forEach((l: { p: V2 }, i: number) => g.push({ id: 'lug:' + i, p: l.p, kind: 'end', tip: 'Anschlussfahne verschieben' }));
    return g;
  },
  dragGrip: (el, id, p) => {
    let m = id.match(/^p:(\d+):(\d+)$/);
    if (m) {
      const i = +m[1], j = +m[2];
      return { paths: el.paths.map((path: V2[], k: number) => {
        if (k !== i) return path;
        const closed = path.length > 2 && dist(path[0], path[path.length - 1]) < 1;
        return path.map((q, n) => (n === j || (closed && j === 0 && n === path.length - 1) ? p : q));
      }) };
    }
    m = id.match(/^lug:(\d+)$/);
    if (m) return { lugs: el.lugs.map((l: any, k: number) => (k === +m![1] ? { ...l, p } : l)) };
  },
  transform: (el, mm: Mat2, _doc, view) => (isPlanLike(view) ? { paths: el.paths.map((p: V2[]) => p.map((q) => apply(mm, q))), lugs: el.lugs?.map((l: any) => ({ ...l, p: apply(mm, l.p) })) } : undefined),
  translate3d: (el, d) => ({ paths: el.paths.map((p: V2[]) => p.map((q) => ({ x: q.x + d.x, y: q.y + d.y }))), lugs: el.lugs?.map((l: any) => ({ ...l, p: { x: l.p.x + d.x, y: l.p.y + d.y } })), ...(el.hostId ? { cover: (el.cover ?? 50) + d.z } : { offset: (el.offset ?? -150) + d.z }) }),
  center: (el) => { const p = el.paths?.[0]; return p?.length ? p[0] : null; },
  tagText: (el, doc) => tagText(doc, el),
  tagPoint: (el) => { const p = el.paths?.[0]; return p?.length >= 2 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : null; },
  props: (): PropDef[] => {
    const g = GROUPS;
    return [
      { key: 'hostId', label: 'Fundamentplatte', group: g.constraints, type: 'select', options: (d) => [['', '– (Höhe über Ebene)'], ...d.all('foundationSlab').concat(d.all('floor')).map((s) => [s.id, (s.mark || s.id) + ' – ' + (d.get(s.typeId)?.name ?? '')] as [string, string])], get: (e) => e.hostId ?? '', set: (_e, v) => ({ hostId: v || undefined }) },
      { key: 'cover', label: 'Abstand ab Plattenunterseite', group: g.constraints, type: 'length', get: (e) => e.cover ?? 50, set: (_e, v) => ({ cover: Math.max(0, v) }) },
      { key: 'offset', label: 'Höhe über Ebene (ohne Platte)', group: g.constraints, type: 'length', get: (e) => e.offset ?? -150, set: (_e, v) => ({ offset: v }) },
      { key: 'werkstoff', label: 'Werkstoff', group: g.materials, type: 'text', get: (e) => e.werkstoff ?? 'V4A', set: (_e, v) => ({ werkstoff: v }) },
      { key: 'dia', label: 'Durchmesser', group: g.dims, type: 'length', get: (e) => e.dia ?? 10, set: (_e, v) => ({ dia: Math.max(4, v) }) },
      { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e) => fmtNum(earthLength(e) / 1000, 1) + ' m' },
      { key: 'lugs', label: 'Anschlussfahnen', group: g.dims, type: 'readonly', get: (e) => String((e.lugs ?? []).length) },
      { key: 'tagFmt', label: 'Beschriftung {werkstoff} {dia} {len} {lugs}', group: g.text, type: 'text', get: (e) => e.tagFmt ?? '', set: (_e, v) => ({ tagFmt: v || undefined }) },
      { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    ];
  },
  scheduleFields: () => [
    { key: 'werkstoff', label: 'Werkstoff', get: (el) => el.werkstoff ?? 'V4A' },
    { key: 'dia', label: 'Ø', unit: 'len', get: (el) => el.dia ?? 10 },
    { key: 'length', label: 'Länge', unit: 'len', get: (el) => earthLength(el) },
    { key: 'lugs', label: 'Anschlussfahnen', unit: 'num', get: (el) => (el.lugs ?? []).length },
    { key: 'host', label: 'Platte', get: (el, doc) => { const h = doc.get(el.hostId); return h ? h.mark || h.id : ''; } },
  ],
  ifc: (el) => ({ entity: 'IfcCableSegment', predefined: 'CONDUCTORSEGMENT', name: 'Fundamenterder', psets: { Pset_OpenRiss_HLKSE: { System: 'Fundamenterder', Werkstoff: el.werkstoff ?? 'V4A', Durchmesser: el.dia ?? 10, Laenge: Math.round(earthLength(el)), Anschlussfahnen: (el.lugs ?? []).length } } }),
});

// ------------------------------------------------------------ Befehle
registerCommand({
  id: 'earthing', label: 'Fundament- erder', icon: 'mepEarth', tip: 'Fundamenterder als Ring skizzieren (V4A Ø10, in der Fundamentplatte). Mit gewählter Fundamentplatte: Ring entlang des Plattenrands mit Maschen ≤ 20 m.',
  run: () => {
    const doc = app.doc;
    const slab = app.selected().find((e) => e.cat === 'foundationSlab' || e.cat === 'floor');
    if (slab) {
      let r: Earthing | null = null;
      doc.transaction('Fundamenterder', () => { r = addEarthing(doc, slab.id); });
      app.status(r ? `Fundamenterder: ${fmtNum(earthLength(r) / 1000, 1)} m (Ring + Maschen)` : 'Kein Fundamenterder möglich (Plattenumriss zu klein)');
      return;
    }
    const lvl = activeLevelId();
    const t: SketchTool = new SketchTool('Fundamenterder', (loops) => {
      doc.transaction('Fundamenterder', () => {
        const host = doc.all('foundationSlab').find((s) => s.levelId === lvl && s.loops?.length);
        const paths = loops.map((l) => [...l, l[0]]);
        doc.add<Earthing>({ id: newId('fe'), cat: 'earthing', levelId: lvl, hostId: host?.id, paths, werkstoff: 'V4A', dia: 10, cover: 50 } as Earthing);
      });
    });
    startTool(t, 'earthing');
  },
});
