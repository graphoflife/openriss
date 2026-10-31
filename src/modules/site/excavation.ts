// Kategorie «Aushub / Baugrube» (excavation): Sohle (eben, geneigt oder nach Längsprofil), Arbeitsraum, Böschungen
// 1:n mit Bermen, Verbau (senkrecht) je Kante. Grundriss nach Schweizer Usanz: Sohle breit, Böschungskrone
// gestrichelt, Böschungsstriche lang/kurz, Bermen, «Böschung 1:n», Sohlenkote; Kennwerte Aushub/Hinterfüllung.
import type { Doc, El } from '../../core/doc';
import type { V2 } from '../../core/geom';
import { apply, applyVec, interiorPoint, centroid } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, PlanCtx, Grip } from '../../core/registry';
import { isPlanLike, projectInfo, View } from '../../core/view';
import { phaseProps } from '../../core/phases';
import { cached } from '../../core/cache';
import type { DisplayList } from '../../render/displayList';
import { catPen } from '../../views/sectionEngine';
import type { Pen } from '../../render/styles';
import { fmtM3 } from '../embeds/common';
import { excSite, statsOf, earthOf, cutSolid, buildingVolume, Excavation, siteGeom, topoOf } from './site';
import { Pit, PEdge, Cell, tagOf, chainSegs } from './pit';
import { evalP } from './convex';
import { fmtHeight } from './topo';

// ------------------------------------------------------------ Kennwerte
export interface ExcVolumes {
  /** Aushubvolumen (mm³): zwischen Gelände und Grubenfläche */
  cut: number;
  /** Hinterfüllung (mm³) = Aushub − Bauwerk im Aushub unter Terrain */
  backfill: number;
  /** Bauwerksvolumen im Aushub (mm³) */
  building: number;
  /** wahre Flächen (mm²): Sohle, Böschungen, Bermen, Verbau */
  bottomArea: number; slopeArea: number; bermArea: number; wallArea: number;
  zBottomMin: number; zBottomMax: number; zCrownMin: number; zCrownMax: number;
}
/** Aushub, Hinterfüllung und Flächen einer Baugrube (null ohne Geometrie) */
export function excavationVolumes(doc: Doc, el: El): ExcVolumes | null {
  return el.id ? cached(doc, 'excVolumes', el.id, () => volumesOf(doc, el)) : volumesOf(doc, el);
}
function volumesOf(doc: Doc, el: El): ExcVolumes | null {
  const s = excSite(doc, el); if (!s) return null;
  const { sg, pi } = s; const st = statsOf(sg)[pi]; const pit = sg.pits[pi];
  const building = buildingVolume(doc, sg, pi);
  return {
    cut: st.cut, backfill: Math.max(0, st.cut - building), building,
    bottomArea: st.bottomArea, slopeArea: st.slopeArea, bermArea: st.bermArea, wallArea: earthOf(sg).wallArea[pi] ?? 0,
    zBottomMin: pit.zbMin, zBottomMax: pit.zbMax, zCrownMin: isFinite(st.zCrownMin) ? st.zCrownMin : NaN, zCrownMax: isFinite(st.zCrownMax) ? st.zCrownMax : NaN,
  };
}
const fmtN = (n: number) => (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));
export const slopeText = (el: El): string => {
  const ns = new Set<string>(); const n0 = el.slope ?? 1;
  (el.pts ?? []).forEach((_: V2, i: number) => { const e = el.edges?.[i]; ns.add(e?.vertical ? 'Verbau' : '1:' + fmtN(e?.slope ?? n0)); });
  return [...ns].join(', ');
};

// ------------------------------------------------------------ Grundriss
const L = (_pit: Pit, sgx: { ox: number; oy: number }) => (p: V2): V2 => ({ x: p.x + sgx.ox, y: p.y + sgx.oy });

function drawExcPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; if (ctx.ceiling) return;
  const s = excSite(doc, el);
  const cut = catPen(doc, 'excavation', true), thin: Pen = { w: 1, color: '#000000' };
  if (!s) { if ((el.pts?.length ?? 0) > 1) dl.poly(el.pts, cut, true); return; }
  const { sg, pi } = s; const pit = sg.pits[pi]; const st = statsOf(sg)[pi];
  const zTop = isFinite(st.zCrownMax) ? st.zCrownMax : sg.dom.tin.zMax;
  if (pit.zbMin > Math.max(ctx.topZ, ctx.cutZ) + 1 || zTop < ctx.depthZ - 1) return;
  const W = L(pit, sg.dom.tin); const sc = dl.scale;
  // Sohle (Umriss inkl. Arbeitsraum), Gebäudeumriss bei Arbeitsraum
  dl.poly(pit.contour.map(W), cut, true);
  if ((el.work ?? 0) > 0) dl.poly(el.pts, { w: 1, color: '#000000', dash: 'hidden' }, true, { ns: true });
  // Böschungskrone
  for (const l of chainSegs(st.crown.map(([a, b]) => [W(a), W(b)] as [V2, V2]))) dl.poly(l, { w: 2, color: '#000000', dash: 'dash' }, false);
  // Verbau (senkrecht)
  for (const wr of earthOf(sg).wallRuns) {
    if (wr.pit !== pi) continue;
    const len = Math.hypot(wr.b.x - wr.a.x, wr.b.y - wr.a.y); const u = { x: (wr.b.x - wr.a.x) / len, y: (wr.b.y - wr.a.y) / len };
    for (const [t0, t1] of wr.runs) dl.line(W({ x: wr.a.x + u.x * t0, y: wr.a.y + u.y * t0 }), W({ x: wr.a.x + u.x * t1, y: wr.a.y + u.y * t1 }), { w: 8, color: '#000000' });
  }
  // Böschungen: Striche, Bermen, Beschriftung
  const mine: Cell[] = []; for (const cs of sg.ov.cells) if (cs) for (const c of cs) if (c.src === pi && c.tag) mine.push(c);
  for (const [ci, ed] of pit.edgeOf) if (!ed.vertical) drawSlope(dl, pit, ci, ed, mine.filter((c) => Math.floor(c.tag / 64) - 1 === ci), W, sc, thin, el);
  // Sohlenkote
  const ip = interiorPoint([pit.contour.map(W)]);
  const zb = pit.bottomAt(ip.x - sg.dom.tin.ox, ip.y - sg.dom.tin.oy);
  const e00 = projectInfo(doc)?.elev00;
  dl.text(ip, `Sohle ${fmtHeightRel(zb)}`, { size: 2.5, ha: 'center', va: 'bottom', opaque: true });
  if (typeof e00 === 'number') dl.text({ x: ip.x, y: ip.y - 0.8 * sc }, `UK Aushub ${(e00 + zb / 1000).toFixed(2)} m ü. M.`, { size: 2, ha: 'center', va: 'top', opaque: true });
  if (pit.zbMax - pit.zbMin > 1) dl.text({ x: ip.x, y: ip.y - 4 * sc }, `Sohle ${fmtHeightRel(pit.zbMin)} … ${fmtHeightRel(pit.zbMax)}`, { size: 1.8, ha: 'center', va: 'top', opaque: true });
  if (el.mark) dl.text({ x: ip.x, y: ip.y + 4 * sc }, el.mark, { size: 2.5, bold: true, ha: 'center', va: 'bottom' });
}
const fmtHeightRel = (z: number) => { const v = z / 1000; return (v >= 0.005 ? '+' : v <= -0.005 ? '−' : '±') + Math.abs(v).toFixed(2); };

/** Böschungsstriche (lang/kurz, von der Krone abwärts), Bermenlinien und «Böschung 1:n» einer Umrisskante */
function drawSlope(dl: DisplayList, pit: Pit, ci: number, ed: PEdge, cells: Cell[], W: (p: V2) => V2, sc: number, thin: Pen, el: El): void {
  const k = pit.ci.indexOf(ci); if (k < 0) return;
  const a = pit.contour[k], b = pit.contour[(k + 1) % pit.contour.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1) return;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: ed.nx, y: ed.ny };
  const reach = ed.dmax + 1;
  const sp = 3 * sc; const ext = Math.min(reach, 4 * len);
  const pieceCells = (j: number) => cells.filter((c) => c.tag === tagOf(ci, j));
  const slopeJ = ed.pieces.map((p, j) => (p.kind === 1 ? j : -1)).filter((j) => j >= 0);
  let mid: { p: V2; L: number } | null = null;
  const i0 = Math.ceil(-ext / sp), i1 = Math.floor((len + ext) / sp);
  for (let i = i0; i <= i1; i++) {
    const t = i * sp; const p0 = { x: a.x + u.x * t, y: a.y + u.y * t };
    for (const j of slopeJ) {
      const iv = rayCells(p0, n, reach, pieceCells(j)); if (!iv) continue;
      const [s0, s1] = iv; const full = s1 - s0; if (full < 0.3 * sc) continue;
      const s2 = i % 2 ? s1 - full / 2 : s0;
      dl.line(W({ x: p0.x + n.x * s1, y: p0.y + n.y * s1 }), W({ x: p0.x + n.x * s2, y: p0.y + n.y * s2 }), thin, { ns: true });
      if (j === slopeJ[0] && Math.abs(t - len / 2) <= sp / 2 + 1e-6) mid = { p: { x: p0.x + n.x * (s0 + full / 2), y: p0.y + n.y * (s0 + full / 2) }, L: full };
    }
  }
  // Bermen: Ränder der Bermenzellen
  ed.pieces.forEach((pc, j) => {
    if (pc.kind !== 2) return;
    for (const c of pieceCells(j)) for (let q = 0; q < c.p.length; q++) {
      const p1 = c.p[q], p2 = c.p[(q + 1) % c.p.length];
      for (const d of [pc.d0, pc.d1]) {
        const e1 = n.x * p1.x + n.y * p1.y - ed.c - d, e2 = n.x * p2.x + n.y * p2.y - ed.c - d;
        if (Math.abs(e1) < 1e-3 && Math.abs(e2) < 1e-3) dl.line(W(p1), W(p2), thin);
      }
    }
  });
  if (mid) {
    let rot = Math.atan2(u.y, u.x); if (rot > Math.PI / 2) rot -= Math.PI; if (rot <= -Math.PI / 2) rot += Math.PI;
    const nn = el.edges?.[ci]?.slope ?? el.slope ?? 1;
    dl.text(W(mid.p), `Böschung 1:${fmtN(nn)}`, { size: 2.2, rot, ha: 'center', va: 'middle', opaque: true });
  }
}
/** Strahl p0 + s·n (0 ≤ s ≤ reach) mit konvexen Zellen schneiden: vereinigtes Intervall */
function rayCells(p0: V2, n: V2, reach: number, cells: Cell[]): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const c of cells) {
    let a = 0, b = reach; const P = c.p;
    for (let i = 0; i < P.length && a <= b; i++) {
      const q = P[i], r = P[(i + 1) % P.length];
      const ex = r.x - q.x, ey = r.y - q.y; // Innen links: cross(e, x − q) ≥ 0
      const num = ex * (p0.y - q.y) - ey * (p0.x - q.x), den = ex * n.y - ey * n.x;
      if (Math.abs(den) < 1e-12) { if (num < -1e-9) { a = 1; b = 0; } continue; }
      const s = -num / den;
      if (den > 0) a = Math.max(a, s); else b = Math.min(b, s);
    }
    if (b - a > 1e-6) { lo = Math.min(lo, a); hi = Math.max(hi, b); }
  }
  return hi > lo ? [lo, hi] : null;
}

// ------------------------------------------------------------ Eigenschaften
function excProps(el: El): PropDef[] {
  const g = GROUPS; const R = 'Kennwerte';
  const vol = (k: keyof ExcVolumes) => (e: El, doc: Doc) => { const v = excavationVolumes(doc, e); return v ? fmtM3(v[k] as number) : '–'; };
  const ar = (k: keyof ExcVolumes) => (e: El, doc: Doc) => excavationVolumes(doc, e)?.[k] ?? 0;
  const p: PropDef[] = [
    { key: 'topoId', label: 'Gelände', group: g.constraints, type: 'select', options: (doc) => [['', 'automatisch'], ...doc.all('topo').map((t) => [t.id, t.name || t.mark || t.id] as [string, string])], get: (e) => e.topoId ?? '', set: (_e, v) => ({ topoId: v || undefined }) },
    { key: 'bottom', label: 'Sohlenkote (Höhe)', group: g.constraints, type: 'length', get: (e) => e.bottom ?? 0, set: (_e, v) => ({ bottom: v }) },
    { key: 'bottomAbs', label: 'Sohle (Kote)', group: g.constraints, type: 'readonly', get: (e, doc) => fmtHeight(doc, e.bottom ?? 0) },
    { key: 'bsPct', label: 'Sohlengefälle [%]', group: g.constraints, type: 'number', get: (e) => e.bottomSlope?.pct ?? 0, set: (e, v) => ({ bottomSlope: v ? { dir: e.bottomSlope?.dir ?? { x: 1, y: 0 }, o: e.bottomSlope?.o, pct: v } : undefined }) },
    { key: 'bsDir', label: 'Gefällerichtung', group: g.constraints, type: 'angle', get: (e) => Math.atan2(e.bottomSlope?.dir?.y ?? 0, e.bottomSlope?.dir?.x ?? 1), set: (e, v) => (e.bottomSlope ? { bottomSlope: { ...e.bottomSlope, dir: { x: Math.cos(v), y: Math.sin(v) } } } : undefined) },
    { key: 'top', label: 'Geländehöhe (ohne Geländemodell)', group: g.constraints, type: 'length', get: (e) => e.top ?? 0, set: (_e, v) => ({ top: v }) },
    { key: 'slope', label: 'Böschung 1:n (n)', group: g.construction, type: 'number', get: (e) => e.slope ?? 1, set: (_e, v) => (v > 0 ? { slope: v } : undefined) },
    { key: 'work', label: 'Arbeitsraum', group: g.construction, type: 'length', get: (e) => e.work ?? 0, set: (_e, v) => ({ work: v > 0 ? v : undefined }) },
    { key: 'bermDz', label: 'Berme: Höhe über Sohle', group: g.construction, type: 'length', get: (e) => firstBerm(e)?.dz ?? 0, set: (e, v) => ({ berm: v > 0 ? { dz: v, width: firstBerm(e)?.width ?? 1500 } : undefined }) },
    { key: 'bermW', label: 'Berme: Breite', group: g.construction, type: 'length', get: (e) => firstBerm(e)?.width ?? 0, set: (e, v) => (firstBerm(e) ? { berm: { dz: firstBerm(e)!.dz, width: Math.max(0, v) } } : undefined) },
    { key: 'backfill', label: 'Hinterfüllung im Schnitt', group: g.graphics, type: 'bool', get: (e) => !!e.backfill, set: (_e, v) => ({ backfill: !!v || undefined }) },
  ];
  (el.pts ?? []).forEach((_: V2, i: number) => {
    const grp = 'Kanten (Böschung / Verbau)';
    p.push(
      { key: 'eS' + i, label: `Kante ${i + 1}: Böschung 1:n (0 = Standard)`, group: grp, type: 'number', get: (e) => e.edges?.[i]?.slope ?? 0, set: (e, v) => ({ edges: setEdge(e, i, { slope: v > 0 ? v : undefined }) }) },
      { key: 'eV' + i, label: `Kante ${i + 1}: Verbau (senkrecht)`, group: grp, type: 'bool', get: (e) => !!e.edges?.[i]?.vertical, set: (e, v) => ({ edges: setEdge(e, i, { vertical: !!v || undefined }) }) },
    );
  });
  p.push(
    { key: 'vCut', label: 'Aushub', group: R, type: 'readonly', get: vol('cut') },
    { key: 'vBack', label: 'Hinterfüllung', group: R, type: 'readonly', get: vol('backfill') },
    { key: 'vBuild', label: 'Bauwerk im Aushub', group: R, type: 'readonly', get: vol('building') },
    { key: 'aBottom', label: 'Sohlenfläche', group: R, type: 'area', get: ar('bottomArea') },
    { key: 'aSlope', label: 'Böschungsfläche', group: R, type: 'area', get: ar('slopeArea') },
    { key: 'aBerm', label: 'Bermenfläche', group: R, type: 'area', get: ar('bermArea') },
    { key: 'aWall', label: 'Verbaufläche', group: R, type: 'area', get: ar('wallArea') },
    { key: 'crown', label: 'Böschungskrone (Kote)', group: R, type: 'readonly', get: (e, doc) => { const v = excavationVolumes(doc, e); return v && isFinite(v.zCrownMin) ? `${fmtHeight(doc, v.zCrownMin)} … ${fmtHeight(doc, v.zCrownMax)}` : '–'; } },
    ...phaseProps(),
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  );
  return p;
}
const firstBerm = (e: El) => (Array.isArray(e.berm) ? e.berm[0] : e.berm) as { dz: number; width: number } | undefined;
function setEdge(e: El, i: number, patch: Record<string, any>): any[] {
  const n = e.pts?.length ?? 0; const out = Array.from({ length: n }, (_, k) => ({ ...(e.edges?.[k] ?? {}) }));
  out[i] = { ...out[i], ...patch }; for (const k of Object.keys(out[i])) if (out[i][k] === undefined) delete out[i][k];
  return out.every((x) => !Object.keys(x).length) ? (undefined as any) : out;
}

// ------------------------------------------------------------ Kategorie
registerCategory({
  cat: 'excavation', label: 'Aushub', plural: 'Aushub / Baugruben', planOrder: -55, ifcSite: true, discipline: 'site',
  drawPlan: drawExcPlan,
  ifcSolids: (el, doc) => { const s = excSite(doc, el); return s ? [cutSolid(s.sg, s.pi)] : []; },
  center: (el) => (el.pts?.length >= 3 ? centroid(el.pts) : null),
  tagPoint: (el) => (el.pts?.length >= 3 ? interiorPoint([el.pts]) : null),
  tagText: (el, doc) => { const v = excavationVolumes(doc, el); return `${el.mark ? el.mark + ' ' : ''}Aushub${v ? ' ' + (v.cut / 1e9).toFixed(0) + ' m³' : ''}`; },
  grips: (el, _doc, view): Grip[] => (isPlanLike(view) ? (el.pts ?? []).map((p: V2, i: number) => ({ id: 'p:' + i, p, kind: 'end', tip: 'Eckpunkt der Sohle verschieben' })) : []),
  dragGrip: (el, id, p) => { const m = id.match(/^p:(\d+)$/); if (!m) return; return { pts: el.pts.map((q: V2, k: number) => (k === +m[1] ? p : q)) }; },
  transform: (el, m, _doc, view: View) => {
    if (!isPlanLike(view)) return;
    const patch: Partial<El> = { pts: el.pts.map((q: V2) => apply(m, q)) };
    if (el.bottomSlope) patch.bottomSlope = { ...el.bottomSlope, dir: applyVec(m, el.bottomSlope.dir), o: el.bottomSlope.o ? apply(m, el.bottomSlope.o) : undefined };
    if (el.bottomProfile) patch.bottomProfile = { ...el.bottomProfile, dir: applyVec(m, el.bottomProfile.dir), o: apply(m, el.bottomProfile.o ?? el.pts[0]) };
    return patch;
  },
  translate3d: (el, d) => ({
    pts: el.pts.map((q: V2) => ({ x: q.x + d.x, y: q.y + d.y })), bottom: (el.bottom ?? 0) + d.z,
    bottomSlope: el.bottomSlope ? { ...el.bottomSlope, o: el.bottomSlope.o ? { x: el.bottomSlope.o.x + d.x, y: el.bottomSlope.o.y + d.y } : undefined } : undefined,
    bottomProfile: el.bottomProfile ? { ...el.bottomProfile, o: { x: (el.bottomProfile.o ?? el.pts[0]).x + d.x, y: (el.bottomProfile.o ?? el.pts[0]).y + d.y }, pts: el.bottomProfile.pts.map((q: any) => ({ s: q.s, z: q.z + d.z })) } : undefined,
  }),
  props: (el) => excProps(el),
  ifc: (el, doc) => {
    const v = excavationVolumes(doc, el); const e00 = projectInfo(doc)?.elev00;
    const ps: Record<string, string | number | boolean> = { Boeschung: slopeText(el) };
    if (v) {
      ps.Volumen_Aushub = Math.round(v.cut / 1e6) / 1000; ps.Volumen_Hinterfuellung = Math.round(v.backfill / 1e6) / 1000;
      ps.Flaeche_Sohle = Math.round(v.bottomArea / 1e4) / 100; ps.Flaeche_Boeschung = Math.round(v.slopeArea / 1e4) / 100;
      if (v.wallArea > 0) ps.Flaeche_Verbau = Math.round(v.wallArea / 1e4) / 100;
    }
    ps.Sohlenkote = typeof e00 === 'number' ? Math.round(e00 * 1000 + (el.bottom ?? 0)) / 1000 : Math.round(el.bottom ?? 0) / 1000;
    if ((el.work ?? 0) > 0) ps.Arbeitsraum = Math.round(el.work) / 1000;
    return { entity: 'IfcGeographicElement', predefined: 'USERDEFINED', name: `${el.mark ? el.mark + ' ' : ''}Aushub`, psets: { CH_Aushub: ps } };
  },
  scheduleFields: () => [
    { key: 'cut', label: 'Aushub', unit: 'vol', get: (el, doc) => excavationVolumes(doc, el)?.cut ?? 0 },
    { key: 'backfill', label: 'Hinterfüllung', unit: 'vol', get: (el, doc) => excavationVolumes(doc, el)?.backfill ?? 0 },
    { key: 'building', label: 'Bauwerk im Aushub', unit: 'vol', get: (el, doc) => excavationVolumes(doc, el)?.building ?? 0 },
    { key: 'bottomArea', label: 'Sohlenfläche', unit: 'area', get: (el, doc) => excavationVolumes(doc, el)?.bottomArea ?? 0 },
    { key: 'slopeArea', label: 'Böschungsfläche', unit: 'area', get: (el, doc) => excavationVolumes(doc, el)?.slopeArea ?? 0 },
    { key: 'wallArea', label: 'Verbaufläche', unit: 'area', get: (el, doc) => excavationVolumes(doc, el)?.wallArea ?? 0 },
    { key: 'bottomZ', label: 'Sohlenkote', get: (el, doc) => fmtHeight(doc, el.bottom ?? 0) },
    { key: 'slope', label: 'Böschung', get: (el) => slopeText(el) },
  ],
});

export { siteGeom, topoOf, evalP };
export type { Excavation };
