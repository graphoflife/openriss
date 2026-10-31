// Geländegeometrie mit Zwischenspeicher: Das Netz (TIN), die Gruben und die Überlagerung werden nicht bei jeder
// Dokumentänderung neu gebaut, sondern über die Elementobjekte selbst (WeakMap) wiederverwendet – Doc.update ersetzt
// nur geänderte Elemente. Varianten (z.B. Phase «Bestand» ohne Aushub) werden je Grubenauswahl gehalten.
import * as THREE from 'three';
import type { Doc, El, Id } from '../../core/doc';
import type { V2, V3 } from '../../core/geom';
import { intersection, union, signedArea, ensureCCW, ensureCW, boxValid, emptyBox, extendBox } from '../../core/geom';
import type { Solid } from '../../core/registry';
import { catDef } from '../../core/registry';
import type { View } from '../../core/view';
import { phaseVisible } from '../../core/phases';
import { solidsOf, cutPolysOfElement } from '../../views/sectionEngine';
import { disciplineOf } from '../view3d/ifc';
import { buildTin, Tin, triPoly, hullRing } from './tin';
import { Conv, clipConv, sArea, convexParts, bboxC, boxHit, evalP, clipHP } from './convex';
import { Excavation, Pit, buildPit, Domain, Overlay, overlay, earthFaces, cutFaces, pitStats, PitStats, finalZ, excContour } from './pit';

export interface Topo extends El {
  cat: 'topo';
  /** Messpunkte (Modell-mm) */
  pts: V3[];
  /** Höhenlinien (Zwangskanten) */
  contours?: { z: number; pts: V2[] }[];
  /** Bruchkanten (3D-Linienzüge) */
  breaklines?: V3[][];
  /** Begrenzung (Grundriss) */
  boundary?: V2[];
  /** Unterkante des Erdkörpers (absolut); Standard: tiefster Punkt − 2 m bzw. tiefste Sohle − 1 m */
  base?: number;
  name?: string;
  /** Höhenlinien: Abstand, Hauptlinien, Beschriftung */
  contourStep?: number; contourMajor?: number; labels?: boolean;
  /** Schnittmuster Erdreich im Grundriss */
  planCut?: 'none' | 'full';
  showPoints?: boolean;
}

// ------------------------------------------------------------ Definitionsbereich je Geländeelement
const domCache = new WeakMap<object, Domain>();
export function domainOf(topo: El): Domain {
  const hit = domCache.get(topo); if (hit) return hit;
  const tin = buildTin({ pts: topo.pts ?? [], contours: topo.contours, breaklines: topo.breaklines });
  const dom = makeDomain(tin, topo.boundary);
  domCache.set(topo, dom);
  return dom;
}
function makeDomain(tin: Tin, boundary?: V2[]): Domain {
  const base: (Conv[] | null)[] = new Array(tin.nt).fill(null);
  const hull = hullRing(tin);
  let outline: V2[][] = hull.length >= 3 ? [hull] : [];
  if (boundary && boundary.length >= 3 && tin.nt) {
    const loc = ensureCCW(boundary.map((p) => ({ x: p.x - tin.ox, y: p.y - tin.oy })));
    const parts = convexParts(loc).map((q) => q.pts);
    const pb = parts.map(bboxC);
    for (let k = 0; k < tin.nt; k++) {
      const t = triPoly(tin, k); const tb = bboxC(t); const A = sArea(t);
      const list: Conv[] = [];
      parts.forEach((q, i) => { if (!boxHit(pb[i], tb)) return; const x = clipConv(t, q); if (x) list.push(x); });
      base[k] = list.length === 1 && Math.abs(sArea(list[0]) - A) < 1e-6 * (A + 1) ? null : list;
    }
    outline = [];
    for (const poly of intersection([hull], [loc])) poly.forEach((r, i) => outline.push(i === 0 ? ensureCCW(r) : ensureCW(r)));
  }
  return { tin, base, outline };
}

// ------------------------------------------------------------ Gruben
const pitCache = new WeakMap<object, { dom: Domain; pit: Pit | null }>();
export function pitFor(e: El, dom: Domain): Pit | null {
  const c = pitCache.get(e); if (c && c.dom === dom) return c.pit;
  const pit = buildPit(e as Excavation, dom.tin.ox, dom.tin.oy, dom.tin.zMax);
  pitCache.set(e, { dom, pit });
  return pit;
}

/** Geländeelement einer Baugrube (topoId, sonst das Gelände unter dem ersten Punkt) */
export function topoOf(doc: Doc, e: El): El | null {
  if (e.topoId) { const t = doc.get(e.topoId); if (t?.cat === 'topo') return t; }
  const ts = doc.all('topo'); if (!ts.length) return null;
  if (ts.length === 1) return ts[0];
  const p = e.pts?.[0];
  if (p) for (const t of ts) { const d = domainOf(t); const x = p.x - d.tin.ox, y = p.y - d.tin.oy; if (isFinite(finalZBare(d, x, y))) return t; }
  return ts[0];
}
const finalZBare = (d: Domain, x: number, y: number) => finalZ({ dom: d, pits: [], cells: [] }, x, y);
export function excsOf(doc: Doc, topo: El, view?: View | null): El[] {
  return doc.all('excavation').filter((e) => topoOf(doc, e) === topo && (!view?.phaseMode || view.phaseMode === 'all' || phaseVisible(e, view)));
}

// ------------------------------------------------------------ Überlagerung (Gelände + Gruben)
export interface SiteGeom {
  topo: El | null; dom: Domain;
  /** angefragte Gruben (Schlüssel) und davon gültige (Index = Quelle der Zellen) */
  req: El[]; excs: El[]; pits: Pit[]; ov: Overlay; zBase: number;
  earth?: ReturnType<typeof earthFaces>; solid?: Solid; stats?: PitStats[];
  cut?: Map<number, Solid>; memo: Map<string, any>;
}
const siteCache = new WeakMap<object, SiteGeom[]>();
const sameList = (a: El[], b: El[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Geometrie eines Geländes mit seinen Baugruben (Standard: alle; sonst die angegebene Auswahl) */
export function siteGeom(doc: Doc, topo: El, excs: El[] = excsOf(doc, topo)): SiteGeom {
  const list = siteCache.get(topo) ?? [];
  const hit = list.find((g) => sameList(g.req, excs));
  if (hit) return hit;
  const dom = domainOf(topo);
  // Unterkante aus allen Gruben des Geländes (gleich in allen Varianten, z.B. Phase «Bestand»)
  const all = excsOf(doc, topo).map((e) => pitFor(e, dom)).filter((p): p is Pit => !!p);
  const sg = makeSite(topo, dom, excs, topo.base, all);
  list.unshift(sg); if (list.length > 4) list.pop();
  siteCache.set(topo, list);
  return sg;
}
function makeSite(topo: El | null, dom: Domain, excs: El[], base?: number, allPits?: Pit[]): SiteGeom {
  const valid: El[] = []; const pits: Pit[] = [];
  for (const e of excs) { const p = pitFor(e, dom); if (p) { valid.push(e); pits.push(p); } }
  const ov = overlay(dom, pits);
  const ap = allPits ?? pits;
  const zMin = Math.min(dom.tin.zMin - 2000, ...ap.map((p) => p.zbMin - 1000));
  // Vorgabe der Unterkante: höchstens 0.1 m unter dem tiefsten Gelände- bzw. Sohlenpunkt
  const lim = Math.min(dom.tin.zMin, ...ap.map((p) => p.zbMin)) - 100;
  return { topo, dom, req: excs, excs: valid, pits, ov, zBase: typeof base === 'number' && isFinite(base) ? Math.min(base, lim) : zMin, memo: new Map() };
}

/** Baugrube ohne Geländemodell: ebenes Gelände auf Höhe top */
const virtCache = new WeakMap<object, SiteGeom>();
function virtualSite(e: El): SiteGeom | null {
  const hit = virtCache.get(e); if (hit) return hit;
  const top = typeof e.top === 'number' ? e.top : 0;
  const C = excContour(e as Excavation); if (C.pts.length < 3) return null;
  const pit0 = buildPit(e as Excavation, 0, 0, top); if (!pit0) return null;
  const [x0, y0, x1, y1] = pit0.box; const m = 1000;
  const pts: V3[] = [{ x: x0 - m, y: y0 - m, z: top }, { x: x1 + m, y: y0 - m, z: top }, { x: x1 + m, y: y1 + m, z: top }, { x: x0 - m, y: y1 + m, z: top }];
  const dom = makeDomain(buildTin({ pts }));
  const sg = makeSite(null, dom, [e]);
  virtCache.set(e, sg);
  return sg;
}

/** Geometrie zur Baugrube: Gelände (oder ebenes Ersatzgelände) und Index der Grube */
export function excSite(doc: Doc, e: El): { sg: SiteGeom; pi: number } | null {
  const t = topoOf(doc, e);
  const sg = t ? siteGeom(doc, t) : virtualSite(e);
  if (!sg) return null;
  const pi = sg.excs.indexOf(e);
  return pi >= 0 ? { sg, pi } : null;
}

// ------------------------------------------------------------ Körper und Kennwerte (je Variante zwischengespeichert)
export function earthOf(sg: SiteGeom): NonNullable<SiteGeom['earth']> { return (sg.earth ??= earthFaces(sg.ov, sg.zBase)); }
export function earthSolid(sg: SiteGeom): Solid {
  return (sg.solid ??= { faces: earthOf(sg).faces, mat: 'm_erde', noOutline: true, noProject: true });
}
export function statsOf(sg: SiteGeom): PitStats[] { return (sg.stats ??= pitStats(sg.ov)); }
/** Aushubkörper einer Grube (Gelände oben, Grubenfläche unten) */
export function cutSolid(sg: SiteGeom, pi: number): Solid {
  sg.cut ??= new Map();
  let s = sg.cut.get(pi);
  if (!s) {
    const ov = sg.pits.length === 1 ? sg.ov : overlay(sg.dom, [sg.pits[pi]]);
    s = { faces: cutFaces(ov), mat: 'm_erde', color: '#c8a46e' };
    sg.cut.set(pi, s);
  }
  return s;
}
/** Endfläche im Modellpunkt */
export const siteZ = (sg: SiteGeom, p: V2): number => finalZ(sg.ov, p.x - sg.dom.tin.ox, p.y - sg.dom.tin.oy);
/** gewachsenes Terrain im Modellpunkt */
export const terrainZ = (sg: SiteGeom, p: V2): number => finalZBare(sg.dom, p.x - sg.dom.tin.ox, p.y - sg.dom.tin.oy);

// ------------------------------------------------------------ Bauwerk in der Grube (für Hinterfüllung)
const NO_BUILD = new Set(['topo', 'excavation', 'room', 'area', 'space', 'rebar', 'areaRebar', 'fabricArea', 'rebarset', 'opening', 'shaft', 'line', 'view', 'grid', 'level', 'refplane', 'cadimport', 'pressureMap']);
interface BEl { el: El; z0: number; z1: number }
const bvCache = new WeakMap<SiteGeom, Map<number, { els: El[]; v: number }>>();

/** Volumen des Bauwerks innerhalb des Aushubs der Grube pi (waagrechte Schnitte, Vereinigung ohne Doppelzählung) */
export function buildingVolume(doc: Doc, sg: SiteGeom, pi: number): number {
  const { tin } = sg.dom; const ox = tin.ox, oy = tin.oy;
  const cells: { p: Conv; f: number[]; t: number[]; box: number[] }[] = [];
  let zLo = Infinity, zHi = -Infinity; const pb = emptyBox();
  for (const cs of sg.ov.cells) if (cs) for (const c of cs) if (c.src === pi) {
    cells.push({ p: c.p, f: c.f, t: c.t, box: bboxC(c.p) });
    for (const q of c.p) { zLo = Math.min(zLo, evalP(c.f, q.x, q.y)); zHi = Math.max(zHi, evalP(c.t, q.x, q.y)); extendBox(pb, { x: q.x + ox, y: q.y + oy }); }
  }
  if (!cells.length || !boxValid(pb)) return 0;
  // Bauteile im Bereich
  const els: BEl[] = [];
  for (const e of doc.all()) {
    if (e.viewId || NO_BUILD.has(e.cat)) continue;
    const def = catDef(e.cat); if (!def?.solids || def.annotation || def.datum) continue;
    if (disciplineOf(e, doc) === 'mep') continue;
    const ss = solidsOf(doc, e); if (!ss.length) continue;
    let z0 = Infinity, z1 = -Infinity, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of ss) for (const f of s.faces) for (const p of f.pts) { if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    if (z1 <= zLo || z0 >= zHi || x1 < pb.min.x || x0 > pb.max.x || y1 < pb.min.y || y0 > pb.max.y) continue;
    els.push({ el: e, z0, z1 });
  }
  let m = bvCache.get(sg); if (!m) bvCache.set(sg, (m = new Map()));
  const c0 = m.get(pi); const ids = els.map((b) => b.el);
  if (c0 && sameList(c0.els, ids)) return c0.v;
  const zs = new Set<number>([zLo, zHi]);
  for (const b of els) { if (b.z0 > zLo && b.z0 < zHi) zs.add(b.z0); if (b.z1 > zLo && b.z1 < zHi) zs.add(b.z1); }
  const Z = [...zs].sort((a, b) => a - b);
  let vol = 0;
  for (let i = 0; i + 1 < Z.length; i++) {
    const za = Z[i], zb = Z[i + 1]; if (zb - za < 1) continue;
    const zm = (za + zb) / 2;
    const act = els.filter((b) => b.z0 < zm && b.z1 > zm); if (!act.length) continue;
    const pr = { origin: { x: 0, y: 0, z: zm }, dir: { x: 0, y: 0, z: -1 }, toView: (p: V3) => ({ x: p.x, y: p.y }), depth: (p: V3) => zm - p.z };
    const polys = act.flatMap((b) => cutPolysOfElement(doc, b.el, pr).flatMap((c) => c.polys));
    if (!polys.length) continue;
    // Bauwerk mit Innenräumen: umschlossene Löcher (Räume, Schächte) füllen – dort wird nicht hinterfüllt
    const U = union(union(polys).map((p) => [p[0]]));
    const tris = triangulate(U, ox, oy); if (!tris.length) continue;
    const ub = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of tris) { ub[0] = Math.min(ub[0], t.box[0]); ub[1] = Math.min(ub[1], t.box[1]); ub[2] = Math.max(ub[2], t.box[2]); ub[3] = Math.max(ub[3], t.box[3]); }
    const near = cells.filter((c) => boxHit(c.box, ub));
    const n = Math.max(1, Math.ceil((zb - za) / 100)); const dz = (zb - za) / n;
    for (let s = 0; s < n; s++) {
      const z = za + (s + 0.5) * dz; let A = 0;
      for (const c of near) {
        let q = clipBelow(c.p, c.f, z); q = q && clipAbove(q, c.t, z); if (!q) continue;
        const qb = bboxC(q);
        for (const t of tris) { if (!boxHit(qb, t.box)) continue; const x = clipConv(q, t.p); if (x) A += sArea(x); }
      }
      vol += A * dz;
    }
  }
  m.set(pi, { els: ids, v: vol });
  return vol;
}
function clipBelow(p: Conv, f: number[], z: number): Conv | null {
  const L = Math.hypot(f[0], f[1]); if (L < 1e-12) return f[2] <= z ? p : null;
  return clipHP(p, f[0] / L, f[1] / L, (z - f[2]) / L);
}
function clipAbove(p: Conv, f: number[], z: number): Conv | null {
  const L = Math.hypot(f[0], f[1]); if (L < 1e-12) return f[2] >= z ? p : null;
  return clipHP(p, -f[0] / L, -f[1] / L, (f[2] - z) / L);
}
function triangulate(m: V2[][][], ox: number, oy: number): { p: Conv; box: number[] }[] {
  const out: { p: Conv; box: number[] }[] = [];
  for (const poly of m) {
    if (!poly.length || poly[0].length < 3) continue;
    const outer = poly[0].map((p) => new THREE.Vector2(p.x - ox, p.y - oy));
    const holes = poly.slice(1).filter((h) => h.length >= 3).map((h) => h.map((p) => new THREE.Vector2(p.x - ox, p.y - oy)));
    const verts = [...outer, ...holes.flat()];
    let tr: number[][] = [];
    try { tr = THREE.ShapeUtils.triangulateShape(outer, holes); } catch { continue; }
    for (const [a, b, c] of tr) {
      let p: Conv = [verts[a], verts[b], verts[c]].map((v) => ({ x: v.x, y: v.y }));
      if (signedArea(p) < 0) p = p.reverse();
      if (Math.abs(signedArea(p)) > 1e-6) out.push({ p, box: bboxC(p) });
    }
  }
  return out;
}

export type { Excavation, Id };
