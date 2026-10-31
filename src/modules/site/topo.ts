// Kategorie «Geländeoberfläche» (topo): TIN aus Messpunkten/Höhenlinien, Erdkörper bis zur Unterkante (Erdreich,
// im Schnitt ohne Umriss, vor den Bauteilen gezeichnet), Geländelinie in Schnitten und Ansichten (gewachsenes Terrain
// gestrichelt, wo ausgehoben; Hinterfüllung), Höhenlinien im Grundriss mit Koten (m ü. M.), Phase «Bestand» ohne Aushub.
import type { Doc, El } from '../../core/doc';
import type { V2 } from '../../core/geom';
import { apply, boxCorners, union, difference, emptyBox, extendBox, boxValid } from '../../core/geom';
import { registerCategory, catDef, cmd, GROUPS, PropDef, PlanCtx, SectionCtx, Grip } from '../../core/registry';
import { isPlanLike, projectInfo, cropBox, materialOf, View } from '../../core/view';
import { cached } from '../../core/cache';
import { phaseProps } from '../../core/phases';
import { catPen, cutFill, drawSolids, solidsOf, cutPolysOfElement, Projector } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { disciplineOf } from '../view3d/ifc';
import { fmtKote } from '../embeds/common';
import { Topo, siteGeom, excsOf, earthSolid, domainOf, siteZ, SiteGeom } from './site';
import { contourSegs, chainSegs, sectionSegs, segRuns, segZ, SecSeg, cellsOf } from './pit';
import { evalP, sArea, integral } from './convex';

// ------------------------------------------------------------ Hilfen
/** Höhe als Kote: mit Höhenbezug in m ü. M. («452.50»), sonst relativ («−6.10») */
export function fmtHeight(doc: Doc, z: number): string {
  const e = projectInfo(doc)?.elev00;
  return typeof e === 'number' && isFinite(e) ? (e + z / 1000).toFixed(2) : fmtKote(z);
}
const elevOff = (doc: Doc): number => { const e = projectInfo(doc)?.elev00; return typeof e === 'number' && isFinite(e) ? e * 1000 : 0; };
const sameList = (a: El[], b: El[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const BROWN = '#6b5a45';

/** Höhenlinien (Linienzüge je Höhe) für das Intervall step, gecacht je Variante */
function contourLines(doc: Doc, sg: SiteGeom, step: number, inPit: boolean): Map<number, V2[][]> {
  const off = elevOff(doc); const key = `c:${step}:${off}:${inPit}`;
  const hit = sg.memo.get(key); if (hit) return hit;
  const tin = sg.dom.tin; const lo = Math.min(tin.zMin, ...sg.pits.map((p) => p.zbMin)), hi = tin.zMax;
  const zs: number[] = [];
  for (let z = Math.ceil((lo + off) / step) * step - off; z <= hi + 1e-6 && zs.length < 5000; z += step) zs.push(z);
  const ov = inPit ? sg.ov : { ...sg.ov, cells: sg.ov.cells.map((cs) => (cs ? cs.filter((c) => c.src < 0) : cs)) };
  const segs = contourSegs(sg.dom, ov, zs);
  const out = new Map<number, V2[][]>();
  for (const [z, s] of segs) out.set(z, chainSegs(s));
  sg.memo.set(key, out);
  return out;
}

// ------------------------------------------------------------ Grundriss
function drawTopoPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl, view } = ctx; if (ctx.ceiling) return;
  const sg = siteGeom(doc, el, excsOf(doc, el, view));
  const tin = sg.dom.tin; const s = dl.scale;
  const crop = cropBox(view);
  // Erdreich im Schnitt (optional)
  if (el.planCut === 'full' && tin.nt) {
    const pr: Projector = { origin: { x: 0, y: 0, z: ctx.cutZ }, dir: { x: 0, y: 0, z: -1 }, toView: (p) => ({ x: p.x, y: p.y }), depth: (p) => ctx.cutZ - p.z };
    drawSolids(doc, [el], pr, dl, { cut: true, cutOnly: true, far: 1, detail: ctx.detail, crop });
    dl.begin(el.id);
  }
  // Höhenlinien im Ansichtsbereich
  const step = el.contourStep > 0 ? el.contourStep : 500, major = el.contourMajor > 0 ? el.contourMajor : 2500;
  const off = elevOff(doc); const zLo = ctx.depthZ, zHi = Math.max(ctx.topZ, ctx.cutZ);
  const minor: Pen = { w: 1, color: '#8c7a62' }, maj: Pen = { w: 2, color: BROWN };
  for (const [z, lines] of contourLines(doc, sg, step, !!el.contoursInPit)) {
    if (z < zLo - 1e-6 || z > zHi + 1e-6) continue;
    const isMaj = Math.abs((z + off) / major - Math.round((z + off) / major)) < 1e-6;
    for (const l of lines) {
      dl.poly(l, isMaj ? maj : minor, false);
      if (isMaj && el.labels !== false) labelLine(dl, l, fmtHeight(doc, z), s);
    }
  }
  // Begrenzung
  const pen: Pen = { w: 1, color: BROWN, dash: 'dashdot' };
  for (const r of sg.dom.outline) dl.poly(r.map((q) => ({ x: q.x + tin.ox, y: q.y + tin.oy })), pen, true);
  // Messpunkte
  if (el.showPoints) for (const p of el.pts ?? []) {
    const h = 0.7 * s;
    dl.line({ x: p.x - h, y: p.y - h }, { x: p.x + h, y: p.y + h }, { w: 1, color: '#303030' }, { ns: true });
    dl.line({ x: p.x - h, y: p.y + h }, { x: p.x + h, y: p.y - h }, { w: 1, color: '#303030' }, { ns: true });
    dl.text({ x: p.x + 1.1 * s, y: p.y }, fmtHeight(doc, p.z), { size: 1.6, va: 'middle', color: '#303030' });
  }
}
/** Beschriftung entlang eines Linienzugs (aufrecht, mit Hintergrund) */
function labelLine(dl: DisplayList, l: V2[], txt: string, s: number): void {
  const cum = [0]; for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y));
  const L = cum[cum.length - 1]; if (L < 40 * s) return;
  const gap = 140 * s;
  for (let at = Math.min(L / 2, gap / 2); at < L - 10 * s; at += gap) {
    let i = 1; while (i < l.length - 1 && cum[i] < at) i++;
    const a = l[i - 1], b = l[i]; const t = (at - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    let rot = Math.atan2(b.y - a.y, b.x - a.x); if (rot > Math.PI / 2) rot -= Math.PI; if (rot <= -Math.PI / 2) rot += Math.PI;
    dl.text({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, txt, { size: 1.8, rot, ha: 'center', va: 'middle', color: BROWN, opaque: true });
  }
}

// ------------------------------------------------------------ Schnitt / Ansicht
const NO_BUILD = new Set(['topo', 'excavation', 'room', 'area', 'space', 'rebar', 'areaRebar', 'fabricArea', 'rebarset', 'opening', 'shaft', 'line', 'view', 'grid', 'level', 'refplane']);
function buildingEls(doc: Doc): El[] {
  return doc.all().filter((e) => { if (e.viewId || NO_BUILD.has(e.cat)) return false; const d = catDef(e.cat); return !!d?.solids && !d.annotation && !d.datum && disciplineOf(e, doc) !== 'mep'; });
}
/** Ansicht: Lage der Gebäudefront (kleinste Tiefe der Bauteile vor dem Gelände) */
function frontDepth(doc: Doc, ctx: SectionCtx): number {
  return cached(doc, 'siteFront', ctx.view.id, () => {
    let d = Infinity;
    for (const e of buildingEls(doc)) for (const s of solidsOf(doc, e)) for (const f of s.faces) for (const p of f.pts) { const q = ctx.depth(p); if (q >= 0 && q < d) d = q; }
    return isFinite(d) ? d : 0;
  });
}

function drawTopoSection(ctx: SectionCtx, el: El): void {
  const { doc, view, dl } = ctx;
  const all = excsOf(doc, el); const vis = excsOf(doc, el, view);
  const sg = siteGeom(doc, el, vis); const tin = sg.dom.tin; if (!tin.nt) return;
  const elevation = view.kind === 'elevation';
  const nrm = { x: ctx.dir.x, y: ctx.dir.y }; const nl = Math.hypot(nrm.x, nrm.y) || 1; nrm.x /= nl; nrm.y /= nl;
  const r = { x: ctx.right.x, y: ctx.right.y };
  const d = elevation ? frontDepth(doc, ctx) : 0;
  const o = { x: ctx.origin.x + nrm.x * d, y: ctx.origin.y + nrm.y * d }; const oz = ctx.origin.z;
  const segF = sectionSegs(sg.dom, sg.ov, o, nrm, r, 'f');
  const runs = segRuns(segF);
  const V = (p: V2): V2 => ({ x: p.x, y: p.y - oz });
  const crop = cropBox(view);
  // Erdreich: in Ansichten weglassen, bei anderer Grubenauswahl (Phase) ersetzen
  if (elevation || !sameList(all, vis)) {
    const at = dl.items.findIndex((it) => it.o === el.id && it.k === 'fill');
    dl.items = dl.items.filter((it) => !(it.o === el.id && it.k === 'fill'));
    if (!elevation && at >= 0) {
      const m = materialOf(doc, 'm_erde'); const fill = cutFill(m?.cutPattern ?? 'earth', m?.cutColor, ctx.detail);
      const polys = runs.map((ru) => [[...ru.map(V), { x: ru[ru.length - 1].x, y: sg.zBase - oz }, { x: ru[0].x, y: sg.zBase - oz }]]);
      dl.items.splice(at, 0, ...polys.map((p) => ({ k: 'fill' as const, rings: p, fill, o: el.id })));
    }
    (dl as any).boxes = null;
  }
  dl.begin(el.id);
  if (crop) dl.clip([boxCorners(crop)]);
  // Hinterfüllung (Bauwerk ausgespart)
  const bf = new Set(sg.pits.map((p, i) => (p.el.backfill ? i : -1)).filter((i) => i >= 0));
  if (bf.size && !elevation) {
    const f = sectionSegs(sg.dom, sg.ov, o, nrm, r, 'f', (c) => bf.has(c.src)), t = sectionSegs(sg.dom, sg.ov, o, nrm, r, 't', (c) => bf.has(c.src));
    const quads = f.map((s, i) => [[V({ x: s.u0, y: s.z0 }), V({ x: s.u1, y: s.z1 }), V({ x: t[i].u1, y: t[i].z1 }), V({ x: t[i].u0, y: t[i].z0 })]]).filter((q) => Math.abs(sArea(q[0])) > 1);
    if (quads.length) {
      const pr: Projector = { origin: ctx.origin, dir: ctx.dir, toView: ctx.toView, depth: ctx.depth };
      // Bauwerk samt Innenräumen aussparen (umschlossene Löcher der Schnittfläche füllen)
      const cuts = buildingEls(doc).flatMap((e) => cutPolysOfElement(doc, e, pr).flatMap((c) => c.polys));
      const solid = cuts.length ? union(union(cuts).map((p) => [p[0]])) : [];
      const reg = solid.length ? difference(union(quads), solid) : union(quads);
      const m = materialOf(doc, 'm_hinterfuellung'); const fill = cutFill(m?.cutPattern ?? 'gravel', m?.cutColor, ctx.detail);
      for (const p of reg) dl.fill(p, fill, { w: 1, color: '#7a6a55' });
    }
  }
  // Geländelinie (Endfläche, Verbau senkrecht)
  const pen = catPen(doc, 'topo', true);
  for (const ru of runs) dl.poly(ru.map(V), pen, false);
  // gewachsenes Terrain gestrichelt, wo es von der Endfläche abweicht
  if (sg.pits.length) {
    const segT = sectionSegs(sg.dom, null, o, nrm, r, 't');
    const dash: Pen = { w: 1, color: '#000000', dash: 'dash' };
    for (const s of segT) for (const [a, b] of differing(s, segF)) dl.line(V(a), V(b), dash);
  }
  if (crop) dl.clip(null);
}
/** Teile des Abschnitts s (gewachsen), die über der Endfläche liegen */
function differing(s: SecSeg, segF: SecSeg[]): [V2, V2][] {
  const us = [s.u0, s.u1];
  for (const g of segF) { if (g.u0 > s.u0 && g.u0 < s.u1) us.push(g.u0); if (g.u1 > s.u0 && g.u1 < s.u1) us.push(g.u1); }
  us.sort((a, b) => a - b);
  const zT = (u: number) => s.z0 + ((s.z1 - s.z0) * (u - s.u0)) / (s.u1 - s.u0 || 1);
  const out: [V2, V2][] = [];
  for (let i = 0; i + 1 < us.length; i++) {
    const u0 = us[i], u1 = us[i + 1]; if (u1 - u0 < 1e-3) continue;
    const e = 1e-4 * (u1 - u0);
    const d0 = zT(u0) - segZ(segF, u0 + e), d1 = zT(u1) - segZ(segF, u1 - e);
    if (!isFinite(d0) || !isFinite(d1)) continue;
    const tol = 5;
    if (d0 <= tol && d1 <= tol) continue;
    let a = u0, b = u1;
    if (d0 < tol) a = u0 + ((u1 - u0) * (tol - d0)) / (d1 - d0);
    if (d1 < tol) b = u0 + ((u1 - u0) * (d0 - tol)) / (d0 - d1);
    const l = out[out.length - 1];
    if (l && Math.abs(l[1].x - a) < 1e-3) l[1] = { x: b, y: zT(b) }; else out.push([{ x: a, y: zT(a) }, { x: b, y: zT(b) }]);
  }
  return out;
}

// ------------------------------------------------------------ Kennwerte
export function topoInfo(doc: Doc, el: El): { points: number; area: number; zMin: number; zMax: number; volume: number; zBase: number } {
  return cached(doc, 'topoInfo', el.id, () => {
    const sg = siteGeom(doc, el); const d = sg.dom; let area = 0, vol = 0, zMin = Infinity;
    for (let k = 0; k < d.tin.nt; k++) for (const c of cellsOf(d, sg.ov, k)) {
      area += sArea(c.p); vol += integral(c.p, [c.f[0], c.f[1], c.f[2] - sg.zBase]);
      for (const q of c.p) zMin = Math.min(zMin, evalP(c.f, q.x, q.y));
    }
    return { points: d.tin.n, area, zMin: isFinite(zMin) ? zMin : d.tin.zMin, zMax: d.tin.zMax, volume: vol, zBase: sg.zBase };
  });
}

// ------------------------------------------------------------ Kategorie
function topoProps(el: El): PropDef[] {
  const g = GROUPS;
  const p: PropDef[] = [
    { key: 'name', label: 'Name', group: g.identity, type: 'text', get: (e) => e.name ?? '', set: (_e, v) => ({ name: v }) },
    { key: 'base', label: 'Unterkante Erdkörper (leer = automatisch)', group: g.constraints, type: 'length', get: (e, doc) => e.base ?? siteGeom(doc, e).zBase, set: (_e, v) => ({ base: isFinite(v) ? v : undefined }) },
    { key: 'zr', label: 'Höhe min / max', group: g.dims, type: 'readonly', get: (e, doc) => { const i = topoInfo(doc, e); return `${fmtHeight(doc, i.zMin)} / ${fmtHeight(doc, i.zMax)}`; } },
    { key: 'npts', label: 'Punkte', group: g.dims, type: 'readonly', get: (e, doc) => String(topoInfo(doc, e).points) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => topoInfo(doc, e).area },
    { key: 'vol', label: 'Volumen Erdkörper', group: g.dims, type: 'readonly', get: (e, doc) => (topoInfo(doc, e).volume / 1e9).toFixed(1) + ' m³' },
    { key: 'contourStep', label: 'Höhenlinien Abstand', group: g.graphics, type: 'length', get: (e) => e.contourStep ?? 500, set: (_e, v) => (v > 0 ? { contourStep: v } : undefined) },
    { key: 'contourMajor', label: 'Hauptlinien Abstand', group: g.graphics, type: 'length', get: (e) => e.contourMajor ?? 2500, set: (_e, v) => (v > 0 ? { contourMajor: v } : undefined) },
    { key: 'labels', label: 'Hauptlinien beschriften', group: g.graphics, type: 'bool', get: (e) => e.labels !== false, set: (_e, v) => ({ labels: !!v }) },
    { key: 'contoursInPit', label: 'Höhenlinien im Aushub', group: g.graphics, type: 'bool', get: (e) => !!e.contoursInPit, set: (_e, v) => ({ contoursInPit: !!v || undefined }) },
    { key: 'planCut', label: 'Erdreich im Grundriss', group: g.graphics, type: 'select', options: [['none', 'nicht schraffieren'], ['full', 'geschnitten schraffieren']], get: (e) => e.planCut ?? 'none', set: (_e, v) => ({ planCut: v === 'none' ? undefined : v }) },
    { key: 'showPoints', label: 'Messpunkte zeigen', group: g.graphics, type: 'bool', get: (e) => !!e.showPoints, set: (_e, v) => ({ showPoints: !!v || undefined }) },
    { key: 'import', label: 'Punkte', group: g.other, type: 'button', get: () => 'Punkte importieren…', action: () => cmd('topoImport')?.run() },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    ...phaseProps(),
  ];
  void el;
  return p;
}

registerCategory({
  cat: 'topo', label: 'Geländeoberfläche', plural: 'Geländeoberflächen', planOrder: -60, sectionOrder: 0, ifcSite: true, discipline: 'site',
  drawPlan: drawTopoPlan,
  drawSection: drawTopoSection,
  solids: (el, doc) => { const sg = siteGeom(doc, el); return sg.dom.tin.nt ? [earthSolid(sg)] : []; },
  surface: (el, doc) => {
    const sg = siteGeom(doc, el); const t = sg.dom.tin; if (!t.nt) return null;
    const near = (p: V2) => { let best = t.zMin, bd = Infinity; for (const v of t.hull) { const dd = (t.x[v] + t.ox - p.x) ** 2 + (t.y[v] + t.oy - p.y) ** 2; if (dd < bd) { bd = dd; best = t.z[v]; } } return best; };
    return { topAt: (p) => { const z = siteZ(sg, p); return isFinite(z) ? z : near(p); }, botAt: () => sg.zBase, zMin: sg.zBase, zMax: t.zMax, flat: false };
  },
  center: (el) => ptsCenter(el.pts),
  tagPoint: (el) => ptsCenter(el.pts),
  tagText: (el) => el.name || 'Gelände',
  grips: (el, _doc, view): Grip[] => (!isPlanLike(view) || (el.pts?.length ?? 0) > 300 ? [] : (el.pts as V2[]).map((p, i) => ({ id: 'p:' + i, p, kind: 'end', tip: 'Messpunkt verschieben' }))),
  dragGrip: (el, id, p) => { const m = id.match(/^p:(\d+)$/); if (!m) return; const i = +m[1]; return { pts: el.pts.map((q: any, k: number) => (k === i ? { ...q, x: p.x, y: p.y } : q)) }; },
  transform: (el, m, _doc, view: View) => {
    if (!isPlanLike(view)) return;
    return {
      pts: el.pts.map((q: any) => ({ ...apply(m, q), z: q.z })),
      contours: el.contours?.map((c: any) => ({ ...c, pts: c.pts.map((q: V2) => apply(m, q)) })),
      breaklines: el.breaklines?.map((l: any[]) => l.map((q) => ({ ...apply(m, q), z: q.z }))),
      boundary: el.boundary?.map((q: V2) => apply(m, q)),
    };
  },
  translate3d: (el, d) => ({
    pts: el.pts.map((q: any) => ({ x: q.x + d.x, y: q.y + d.y, z: q.z + d.z })),
    contours: el.contours?.map((c: any) => ({ z: c.z + d.z, pts: c.pts.map((q: V2) => ({ x: q.x + d.x, y: q.y + d.y })) })),
    breaklines: el.breaklines?.map((l: any[]) => l.map((q) => ({ x: q.x + d.x, y: q.y + d.y, z: q.z + d.z }))),
    boundary: el.boundary?.map((q: V2) => ({ x: q.x + d.x, y: q.y + d.y })),
    base: typeof el.base === 'number' ? el.base + d.z : undefined,
  }),
  props: (el) => topoProps(el),
  ifc: (el, doc) => {
    const i = topoInfo(doc, el); const e00 = projectInfo(doc)?.elev00;
    const ps: Record<string, string | number | boolean> = { Punkte: i.points, Flaeche_m2: Math.round(i.area / 1e4) / 100, Hoehe_min: Math.round(i.zMin) / 1000, Hoehe_max: Math.round(i.zMax) / 1000 };
    if (typeof e00 === 'number') { ps.Hoehe_min_mueM = Math.round(e00 * 1000 + i.zMin) / 1000; ps.Hoehe_max_mueM = Math.round(e00 * 1000 + i.zMax) / 1000; }
    return { entity: 'IfcGeographicElement', predefined: 'TERRAIN', name: el.name || 'Gelände', psets: { CH_Gelaende: ps } };
  },
  scheduleFields: () => [
    { key: 'name', label: 'Name', get: (el) => el.name ?? '' },
    { key: 'points', label: 'Punkte', unit: 'num', get: (el, doc) => topoInfo(doc, el).points },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => topoInfo(doc, el).area },
    { key: 'zMin', label: 'Höhe min', get: (el, doc) => fmtHeight(doc, topoInfo(doc, el).zMin) },
    { key: 'zMax', label: 'Höhe max', get: (el, doc) => fmtHeight(doc, topoInfo(doc, el).zMax) },
    { key: 'volume', label: 'Volumen Erdkörper', unit: 'vol', get: (el, doc) => topoInfo(doc, el).volume },
  ],
});
function ptsCenter(pts: V2[] | undefined): V2 | null {
  if (!pts?.length) return null; const b = emptyBox(); for (const p of pts) extendBox(b, p);
  return boxValid(b) ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 } : null;
}

export { domainOf };
export type { Topo };
