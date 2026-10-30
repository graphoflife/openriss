// IFC-Export – Bauteilkörper der Tragwerks- und Rohbauteile ungeschnitten als IfcExtrudedAreaSolid
// (Wand, Geschossdecke, Fundamentplatte, Fundamente, Stütze, Träger) mit Öffnungen als eigene Körper
// (→ IfcOpeningElement/IfcRelVoidsElement) und Schichtaufbau (IfcMaterialLayerSetUsage).
import type { Doc, El, Id } from '../../core/doc';
import { V2, V3, sub, dot, norm3, cross3, sub3, len3, Poly } from '../../core/geom';
import { catDef, CategoryDef } from '../../core/registry';
import type { Material } from '../../core/view';
import { solidsOf } from '../../views/sectionEngine';
import { Wall, wallInfo, wallShape, wallOpenings, wallType, typeThickness } from '../../elements/wall';
import { floorType, floorTop, floorThick } from '../architecture/floor';
import { loopsArea, shaftArea, shaftRange, Shaft } from '../architecture/common';
import { foundInfo } from '../structure/foundation';
import { colInfo, Column } from '../structure/column';
import { beamInfo, Beam } from '../structure/beam';
import type { ProfType } from '../structure/common';
import { solidLook } from './meshes';
import { IfcOut, Frame, R, S, SS, ref, refs, ptIn, X3, Y3, Z3 } from './ifcStep';

/** Öffnung im Bauteil (Körper in lokalen Koordinaten des Bauteils) */
export interface OpeningSpec {
  key: string; name: string; desc?: string; items: number[];
  /** auslösendes Element (Wandöffnung, Tür, Schacht …) */
  el?: El;
  /** füllendes Bauteil (Tür/Fenster/Einlage) → IfcRelFillsElement */
  filler?: El;
}
export interface BodyPlan {
  frame: Frame;
  reps: number[];
  openings: OpeningSpec[];
  /** Materialzuordnung (Schichtsatznutzung oder Material) und Schlüssel zum Bündeln */
  mat?: { key: string; id: number };
  ent?: string;
  predefined?: string;
  /** Unter-/Oberkante Rohbau (absolut) */
  z?: [number, number];
}

/** Zusatz-Abstand, um den Öffnungskörper beidseitig über das Bauteil hinausragen */
const EPS = 10;

export type IfcMapping = NonNullable<ReturnType<NonNullable<CategoryDef['ifc']>>>;
/** IFC-Zuordnung der Kategorie (Hook), Fehler abfangen */
export function ifcHook(el: El, doc: Doc): IfcMapping | null {
  const fn = catDef(el.cat)?.ifc;
  if (!fn) return null;
  try { return fn(el, doc) ?? null; } catch (e) { console.warn('IFC-Hook', el.cat, e); return null; }
}
/** reine Öffnung (kein eigener Körper, oder Hook liefert Öffnungsentität) */
export function isPureOpening(el: El, doc: Doc): boolean {
  const hk = ifcHook(el, doc);
  if (hk) return /OPENINGELEMENT|VOIDINGFEATURE/i.test(hk.entity);
  return !catDef(el.cat)?.solids;
}

const colorOf = (o: IfcOut, el: El, mat: Id | undefined) => solidLook(o.doc, el, { faces: [], mat });
function styledSolid(o: IfcOut, el: El, item: number, mat: Id | undefined): number {
  const lk = colorOf(o, el, mat); o.styled(item, lk.color, lk.opacity, lk.name); return item;
}

// ------------------------------------------------------------ Schichtaufbau
interface LayerLike { mat: Id; t: number; fn?: string; core?: boolean }
const LAYER_CAT: Record<string, string> = { structure: 'LoadBearing', thermal: 'Insulation', finish: 'Finish', substrate: 'Substrate', membrane: 'Membrane', air: 'AirLayer' };
function layerSet(o: IfcOut, t: { id: Id; name: string; layers: LayerLike[] }): number {
  return o.once('mls:' + t.id, () => {
    const ls = t.layers.filter((l) => l.t > 0).map((l) => {
      const m = o.material(l.mat);
      const nm = o.doc.get<Material>(l.mat)?.name;
      return o.add(`IFCMATERIALLAYER(${m ? ref(m) : '$'},${R(l.t)},${l.fn === 'air' ? '.T.' : '$'},${S(nm)},$,${S(l.core ? 'LoadBearing' : LAYER_CAT[l.fn ?? ''] ?? '')},$)`);
    });
    return o.add(`IFCMATERIALLAYERSET(${refs(ls)},${SS(t.name)},$)`);
  });
}
function layerUsage(o: IfcOut, t: { id: Id; name: string; layers: LayerLike[] }, dir: 'AXIS2' | 'AXIS3', sense: 'POSITIVE' | 'NEGATIVE', offset: number): { key: string; id: number } {
  const key = `mlsu:${t.id}:${dir}:${sense}:${R(offset)}`;
  return { key, id: o.once(key, () => o.add(`IFCMATERIALLAYERSETUSAGE(${ref(layerSet(o, t))},.${dir}.,.${sense}.,${R(offset)},$)`)) };
}
const singleMat = (o: IfcOut, id: Id | undefined) => { const m = o.material(id); return m ? { key: 'mat:' + id, id: m } : undefined; };

// ------------------------------------------------------------ Wand
function wallPlan(o: IfcOut, doc: Doc, w: Wall): BodyPlan | null {
  const wi = wallInfo(doc, w);
  if (wi.L < 1) return null;
  const t = wallType(doc, w);
  const T = t ? typeThickness(t) : wi.T;
  const frame: Frame = { o: { x: wi.c0.x, y: wi.c0.y, z: wi.z0 }, x: { x: wi.d.x, y: wi.d.y, z: 0 }, z: Z3 };
  const loc = (p: V2): V2 => ({ x: dot(sub(p, wi.c0), wi.d), y: dot(sub(p, wi.c0), wi.n) });
  const coreMat = (t?.layers.find((l) => l.core) ?? t?.layers[0])?.mat;
  const reps: number[] = [];
  reps.push(o.shapeRep(o.axis, 'Axis', 'Curve2D', [o.add(`IFCPOLYLINE((${ref(o.pt2({ x: 0, y: 0 }))},${ref(o.pt2({ x: wi.L, y: 0 }))}))`)]));
  let predefined = '.STANDARD.';
  if (!w.attachTopId) {
    // ungeschnittener Grundrissumriss (inkl. Eckverbindungen) senkrecht extrudiert
    const ring = wallShape(doc, w).ring.map(loc);
    const solid = styledSolid(o, w, o.extrusion(o.profile(ring), null, wi.z1 - wi.z0), coreMat);
    reps.push(o.shapeRep(o.body, 'Body', 'SweptSolid', [solid]));
  } else {
    // oben an Dach/Decke fixiert: Körper als Brep (bereits ausgeschnitten), Öffnungen trotzdem als Elemente
    const items: number[] = [];
    for (const s of solidsOf(doc, w)) {
      const b = o.brep(s.faces, (p) => ptIn(frame, p));
      if (b) { const lk = solidLook(doc, w, s); o.styled(b, lk.color, lk.opacity, lk.name); items.push(b); }
    }
    if (!items.length) return null;
    reps.push(o.shapeRep(o.body, 'Body', 'Brep', items));
    predefined = '.NOTDEFINED.';
  }
  // Öffnungen: Profil in der Wandebene (u entlang Achse, z relativ zur Wandunterkante), quer durch die Wand
  const openings: OpeningSpec[] = [];
  const half = Math.max(T, wi.T) / 2 + EPS;
  for (const op of wallOpenings(doc, w)) {
    const prof: V2[] = op.profile && op.profile.length >= 3
      ? op.profile.map((q) => ({ x: q.u, y: q.z - wi.z0 }))
      : [{ x: op.u0, y: op.z0 - wi.z0 }, { x: op.u1, y: op.z0 - wi.z0 }, { x: op.u1, y: op.z1 - wi.z0 }, { x: op.u0, y: op.z1 - wi.z0 }];
    if (op.u1 - op.u0 < 1 || op.z1 - op.z0 < 1) continue;
    // Lage: Ursprung auf der Wandseite +y, Extrusion in −y; Profil-x = Wandachse, Profil-y = oben
    const pos = o.a2p3({ x: 0, y: half, z: 0 }, { x: 0, y: -1, z: 0 }, X3);
    const item = o.extrusion(o.profile(prof), pos, 2 * half);
    const pure = isPureOpening(op.el, doc);
    const nm = op.el.mark || (pure ? op.el.comments : '') || doc.get(op.el.typeId)?.name || catDef(op.el.cat)?.label || 'Öffnung';
    openings.push({ key: op.el.id, name: pure ? nm : 'Öffnung ' + nm, desc: op.el.comments, items: [item], el: op.el, filler: pure ? undefined : op.el });
  }
  // Schichtaufbau: Achse = Wandmitte; Außenseite links (+y) ohne Spiegelung
  const mat = t?.layers.some((l) => l.t > 0) ? (w.flip ? layerUsage(o, t, 'AXIS2', 'POSITIVE', -T / 2) : layerUsage(o, t, 'AXIS2', 'NEGATIVE', T / 2)) : singleMat(o, coreMat);
  return { frame, reps, openings, mat, predefined, z: [wi.z0, wi.z1] };
}

// ------------------------------------------------------------ Platten (Decke, Fundamentplatte, Fundamente)
/** Extrusion der Flächen nach unten ab zTop; Aussparungen der Skizze als Öffnungen, wenn eindeutig */
function slabBody(o: IfcOut, el: El, polys: Poly[], zTop: number, T: number, mat: Id | undefined, holesAsOpenings: boolean): { frame: Frame; reps: number[]; openings: OpeningSpec[] } | null {
  const ps = polys.filter((p) => p.length && p[0].length >= 3);
  if (!ps.length || T < 0.5) return null;
  const frame: Frame = { o: { x: 0, y: 0, z: zTop }, x: X3, z: Z3 };
  const pos = o.a2p3({ x: 0, y: 0, z: -T });
  const asOpen = holesAsOpenings && ps.length === 1;
  const items = ps.map((p) => styledSolid(o, el, o.extrusion(o.profile(p[0], asOpen ? [] : p.slice(1)), pos, T), mat));
  const openings: OpeningSpec[] = [];
  if (asOpen) {
    ps[0].slice(1).forEach((h, i) => {
      if (h.length < 3) return;
      openings.push({ key: `${el.id}:a${i}`, name: 'Aussparung ' + (i + 1), items: [openBody(o, h, [], T)] });
    });
  }
  return { frame, reps: [o.shapeRep(o.body, 'Body', 'SweptSolid', items)], openings };
}
/** Öffnungskörper in einer Platte der Dicke T (Systemursprung auf Oberkante) */
function openBody(o: IfcOut, outer: V2[], holes: V2[][], T: number): number {
  return o.extrusion(o.profile(outer, holes), o.a2p3({ x: 0, y: 0, z: -T - EPS }), T + 2 * EPS);
}

function floorPlan(o: IfcOut, doc: Doc, f: El): BodyPlan | null {
  const t = floorType(doc, f);
  const T = floorThick(doc, f), top = floorTop(doc, f);
  const area = loopsArea(f.loops);
  const core = (t?.layers?.find((l) => l.core) ?? t?.layers?.[0])?.mat ?? 'm_stb';
  const b = slabBody(o, f, area, top, T, core, true);
  if (!b) return null;
  // Schächte / vertikale Öffnungen (wie cutoutsFor: gehostet oder im Höhenbereich)
  for (const s of doc.all<Shaft>('shaft')) {
    if (s.viewId) continue;
    if (s.hostId) { if (s.hostId !== f.id) continue; }
    else { const [a, c] = shaftRange(doc, s); if (!(a < top - 0.5 && c > top - T + 0.5)) continue; }
    shaftArea(doc, s).forEach((p, i) => {
      if (!p.length || p[0].length < 3) return;
      const nm = s.mark || s.comments || catDef('shaft')?.label || 'Schachtöffnung';
      b.openings.push({ key: `${s.id}:${f.id}:${i}`, name: nm, desc: s.comments, items: [openBody(o, p[0], p.slice(1), T)], el: s });
    });
  }
  const mat = t?.layers?.some((l) => l.t > 0) ? layerUsage(o, t, 'AXIS3', 'NEGATIVE', 0) : singleMat(o, core);
  return { ...b, mat, z: [top - T, top] };
}

function foundPlan(o: IfcOut, doc: Doc, el: El): BodyPlan | null {
  const fi = foundInfo(doc, el);
  if (!fi) return null;
  const b = slabBody(o, el, fi.polys, fi.z1, fi.z1 - fi.z0, fi.mat, el.cat === 'foundationSlab');
  if (!b) return null;
  const t = doc.get(el.typeId);
  const kind = (el.cat + ' ' + (el.kind ?? '') + ' ' + (t?.kind ?? '')).toLowerCase();
  const predefined = el.cat === 'foundationSlab' ? '.BASESLAB.' : el.cat === 'foundationWall' || /strip|streifen/.test(kind) ? '.STRIP_FOOTING.' : '.PAD_FOOTING.';
  return { ...b, mat: singleMat(o, fi.mat), ent: el.cat === 'foundationSlab' ? 'IFCSLAB' : 'IFCFOOTING', predefined, z: [fi.z0, fi.z1] };
}

// ------------------------------------------------------------ Stütze, Träger (Profil-Extrusion)
function profDef(o: IfcOut, t: Partial<ProfType> | undefined, dy = 0): number {
  const shape = t?.shape ?? 'rect';
  const b = t?.b ?? 300, h = shape === 'round' ? b : t?.h ?? 300;
  const pos = Math.abs(dy) > 1e-6 ? ref(o.add(`IFCAXIS2PLACEMENT2D(${ref(o.pt2({ x: 0, y: dy }))},$)`)) : '$';
  const nm = S(t?.name);
  if (shape === 'round') return o.add(`IFCCIRCLEPROFILEDEF(.AREA.,${nm},${pos},${R(b / 2)})`);
  if (shape === 'I') {
    const tw = Math.min(t?.tw || b * 0.05, b * 0.9), tf = Math.min(t?.tf || h * 0.07, h * 0.45);
    return o.add(`IFCISHAPEPROFILEDEF(.AREA.,${nm},${pos},${R(b)},${R(h)},${R(tw)},${R(tf)},$,$,$)`);
  }
  return o.add(`IFCRECTANGLEPROFILEDEF(.AREA.,${nm},${pos},${R(b)},${R(h)})`);
}

function columnPlan(o: IfcOut, doc: Doc, c: Column): BodyPlan | null {
  const ci = colInfo(doc, c);
  const a = c.rot ?? 0;
  const frame: Frame = { o: { x: c.p.x, y: c.p.y, z: ci.z0 }, x: { x: Math.cos(a), y: Math.sin(a), z: 0 }, z: Z3 };
  const solid = styledSolid(o, c, o.extrusion(profDef(o, ci.t), null, ci.z1 - ci.z0), ci.mat);
  return { frame, reps: [o.shapeRep(o.body, 'Body', 'SweptSolid', [solid])], openings: [], mat: singleMat(o, ci.mat), predefined: '.COLUMN.', z: [ci.z0, ci.z1] };
}

function beamPlan(o: IfcOut, doc: Doc, bm: Beam): BodyPlan | null {
  const bi = beamInfo(doc, bm);
  if (bi.L < 1) return null;
  const A: V3 = { x: bi.a.x, y: bi.a.y, z: bi.zA }, B: V3 = { x: bi.b.x, y: bi.b.y, z: bi.zB };
  const L = len3(sub3(B, A));
  const dir = norm3(sub3(B, A));
  const u: V3 = { x: bi.n.x, y: bi.n.y, z: 0 };
  const v = norm3(cross3(dir, u));
  const j = bm.zJust ?? 'top';
  const dy = j === 'top' ? -bi.h / 2 : j === 'center' ? 0 : bi.h / 2;
  // System: x = Trägerachse, z = Profilhöhe (oben), y = Profilbreite
  const frame: Frame = { o: A, x: dir, z: v };
  const pos = o.a2p3({ x: 0, y: 0, z: 0 }, X3, Y3);
  const solid = styledSolid(o, bm, o.extrusion(profDef(o, bi.t, dy), pos, L), bi.mat);
  const axis = o.shapeRep(o.axis, 'Axis', 'Curve3D', [o.add(`IFCPOLYLINE((${ref(o.pt3({ x: 0, y: 0, z: 0 }))},${ref(o.pt3({ x: L, y: 0, z: 0 }))}))`)]);
  return { frame, reps: [axis, o.shapeRep(o.body, 'Body', 'SweptSolid', [solid])], openings: [], mat: singleMat(o, bi.mat), predefined: '.BEAM.', z: [bi.z0, bi.z1] };
}

/** Körper als Extrusion (ungeschnitten, mit Öffnungen) für bekannte Kategorien; sonst null (→ Brep) */
export function bodyPlan(o: IfcOut, doc: Doc, el: El): BodyPlan | null {
  switch (el.cat) {
    case 'wall': return wallPlan(o, doc, el as Wall);
    case 'floor': return floorPlan(o, doc, el);
    case 'foundationSlab': case 'foundationIsolated': case 'foundationWall': return foundPlan(o, doc, el);
    case 'column': return columnPlan(o, doc, el as Column);
    case 'beam': return beamPlan(o, doc, el as Beam);
  }
  return null;
}
