// Dach über Grundfläche: Skizze mit neigungsdefinierenden Kanten (Walm-, Sattel-, Pultdach) oder
// Flachdach. Körper je Schicht, lotrechter Traufschnitt. Grundriss über Schnitt/Projektion der Körper.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, Poly, add, sub, mul, norm, perp, mid, dist, distToSeg, distToLine, cross, polyArea, ensureCCW, ensureCW, rad, deg,
} from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, GROUPS, PropDef, Solid, Face } from '../../core/registry';
import { levelElev, typeOf } from '../../core/view';
import { cached } from '../../core/cache';
import { planRange } from '../../views/viewBuilder';
import { slopedPrism } from '../../views/sectionEngine';
import { fmtLen, fmtNum } from '../../core/units';
import { Wall, wallInfo } from '../../elements/wall';
import { app } from '../../app';
import { ToolEvent, OptionItem } from '../../tools/tool';
import { SketchTool, SketchSeg } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { roofGeom, RoofGeom, EdgeAttr, faceRise } from './roofGeom';
import {
  LayeredType, Layer, thickOf, cutoutsFor, layerSolids, multiArea, multiPerimeter, transformLoops, moveLoops, moveHostedCutouts, loopGrips, dragLoopGrip, loopsCenter, layeredTypeProps, identityProps, levelName, fmtM3, registerSketchEditor, fmtM2,
} from './common';

export interface Roof extends El {
  cat: 'roof';
  levelId: Id;
  /** Versatz von Basisebene (Unterseite an der Traufkante) */
  baseOffset: number;
  loops: V2[][];
  /** je Schleife je Kante: Neigung definieren + Winkel (Grad) */
  edges: EdgeAttr[][];
  roomBounding?: boolean;
}

export const roofType = (doc: Doc, r: El) => typeOf<LayeredType>(doc, r);
export const roofZ0 = (doc: Doc, r: El): number => levelElev(doc, r.levelId) + (r.baseOffset ?? 0);
export const roofThick = (doc: Doc, r: El): number => thickOf(roofType(doc, r), 300);
const roofLayers = (doc: Doc, r: El): Layer[] => { const l = roofType(doc, r)?.layers; return l?.length ? l : [{ mat: 'm_dach', t: 300, fn: 'structure', core: true }]; };

export function roofGeomOf(doc: Doc, r: El): RoofGeom {
  return cached(doc, 'archRoofGeom', r.id || '_', () => {
    const g0 = roofGeom(r.loops ?? [], r.edges ?? []);
    if (!r.id) return g0;
    const z0 = roofZ0(doc, r); const T = roofThick(doc, r);
    const cut = cutoutsFor(doc, r.id, z0, z0 + g0.rise + 2 * T);
    return cut.length ? roofGeom(r.loops, r.edges ?? [], cut) : g0;
  });
}

// Prisma mit geneigter Ober-/Unterseite: allgemeiner Körperbauer in der Schnittmaschine
export { slopedPrism } from '../../views/sectionEngine';

export function roofSolids(doc: Doc, r: El): Solid[] {
  const g = roofGeomOf(doc, r); const layers = roofLayers(doc, r);
  const z0 = roofZ0(doc, r); const T = layers.reduce((s, l) => s + l.t, 0);
  if (!g.faces) return layerSolids(g.footprint, z0 + T, layers);
  const out: Solid[] = [];
  let above = 0;
  for (const l of layers) {
    const faces: Face[] = [];
    if (l.t >= 0.5) for (const f of g.faces) {
      const c = Math.sqrt(1 + f.tan * f.tan);
      const zt = (p: V2) => z0 + faceRise(f, p) + (T - above) * c;
      const zb = (p: V2) => zt(p) - l.t * c;
      faces.push(...slopedPrism(f.poly, zb, zt));
    }
    if (faces.length) out.push({ faces, mat: l.mat });
    above += l.t;
  }
  return out;
}

/** Dachfläche (geneigt) */
export function roofSurface(doc: Doc, r: El): number {
  const g = roofGeomOf(doc, r);
  if (!g.faces) return multiArea(g.footprint);
  return g.faces.reduce((s, f) => s + polyArea(f.poly) * Math.sqrt(1 + f.tan * f.tan), 0);
}
export function roofVolume(doc: Doc, r: El): number {
  const g = roofGeomOf(doc, r); const T = roofThick(doc, r);
  if (!g.faces) return multiArea(g.footprint) * T;
  return g.faces.reduce((s, f) => s + polyArea(f.poly) * T * Math.sqrt(1 + f.tan * f.tan), 0);
}
const firstSlope = (r: El): number | null => { for (const l of r.edges ?? []) for (const e of l) if (e.slope) return e.angle ?? 35; return null; };

function roofProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Basisebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'baseOffset', label: 'Versatz von Basisebene', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'roomBounding', label: 'Raumbegrenzung', group: g.constraints, type: 'bool', get: (e) => e.roomBounding !== false, set: (_e, v) => ({ roomBounding: v }) },
    { key: 'slope', label: 'Neigung', group: g.dims, type: 'angle', get: (e) => { const a = firstSlope(e); return a === null ? undefined : rad(a); },
      set: (e, v) => ({ edges: (e.edges ?? []).map((l: EdgeAttr[]) => l.map((x) => (x.slope ? { ...x, angle: Math.max(0.5, Math.min(85, deg(v))) } : x))) }) },
    { key: 'thick', label: 'Dicke', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(roofThick(doc, e)) },
    { key: 'ridge', label: 'Höhe First (Oberkante)', group: g.dims, type: 'readonly', get: (e, doc) => {
      const gg = roofGeomOf(doc, e); const T = roofThick(doc, e);
      if (!gg.faces) return fmtLen(roofZ0(doc, e) + T);
      const c = Math.max(1, ...gg.faces.map((f) => Math.sqrt(1 + f.tan * f.tan)));
      return fmtLen(roofZ0(doc, e) + gg.rise + T * c);
    } },
    { key: 'footprint', label: 'Grundfläche', group: g.dims, type: 'area', get: (e, doc) => multiArea(roofGeomOf(doc, e).footprint) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'readonly', get: (e, doc) => fmtM2(roofSurface(doc, e)) },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => fmtM3(roofVolume(doc, e)) },
    ...identityProps(),
  ];
}

registerCategory({
  cat: 'roof', label: 'Dach', plural: 'Dächer', hasTypes: true, planOrder: 30,
  // Deckenplan: Dächer, die erst an der Oberkante des Ansichtsbereichs beginnen, nicht zeigen
  visibleIn: (el, doc, view) => view.kind !== 'ceiling' || roofZ0(doc, el) < planRange(doc, view).topZ - 1,
  solids: (el, doc) => roofSolids(doc, el),
  grips: (el, _doc, view) => loopGrips(el.loops, view),
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : undefined; },
  transform: (el, m, doc, view) => { if (view.kind !== 'plan' && view.kind !== 'ceiling') return; moveHostedCutouts(doc, el.id, m); return { loops: transformLoops(el.loops, m) }; },
  translate3d: (el, d, doc) => { moveHostedCutouts(doc, el.id, null, d); return { loops: moveLoops(el.loops, d), baseOffset: (el.baseOffset ?? 0) + d.z }; },
  center: (el) => loopsCenter(el.loops),
  curve: () => null,
  props: () => roofProps(),
  typeProps: () => layeredTypeProps(),
  tagText: (el, doc) => roofType(doc, el)?.name ?? '',
  tagPoint: (el) => loopsCenter(el.loops),
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => roofType(doc, el)?.name ?? '' },
    { key: 'level', label: 'Basisebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'slope', label: 'Neigung', get: (el) => { const a = firstSlope(el); return a === null ? '' : fmtNum(a, 2) + '°'; } },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => roofSurface(doc, el) },
    { key: 'footprint', label: 'Grundfläche', unit: 'area', get: (el, doc) => multiArea(roofGeomOf(doc, el).footprint) },
    { key: 'perimeter', label: 'Umfang', unit: 'len', get: (el, doc) => multiPerimeter(roofGeomOf(doc, el).footprint) },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => roofVolume(doc, el) },
  ],
});

// ------------------------------------------------------------ Skizze mit Neigungen
/** Einstellungen der Optionsleiste (bleiben zwischen Aufrufen erhalten) */
const RO = { defSlope: true, angle: 35, overhang: 500, assign: false };

/** Kanten der fertigen Schleifen den Skizzenlinien zuordnen (für Neigungsattribute) */
export function edgeAttrsFor(loops: V2[][], segs: SketchSeg[]): EdgeAttr[][] {
  return loops.map((r) => r.map((p, i) => {
    const q = r[(i + 1) % r.length]; const m = mid(p, q); const d = norm(sub(q, p));
    let best: SketchSeg | null = null; let bd = Infinity;
    for (const s of segs) {
      let dd: number;
      if (s.arc) dd = Math.abs(dist(m, s.arc.c) - s.arc.r);
      else {
        const sd = norm(sub(s.b, s.a));
        if (Math.abs(cross(sd, d)) > 0.05) continue;
        dd = distToLine(m, s.a, s.b) + 0.001 * distToSeg(m, s.a, s.b);
      }
      if (dd < bd) { bd = dd; best = s; }
    }
    const t = best?.tag as EdgeAttr | undefined;
    return { slope: t ? !!t.slope : false, angle: t?.angle ?? RO.angle };
  }));
}

function slopeMarks(dl: DisplayList, segs: SketchSeg[]): void {
  const s = app.activeView()?.scale ?? 100;
  for (const g of segs) {
    const t = g.tag as EdgeAttr | undefined;
    if (!t?.slope || g.arc) continue;
    const d = norm(sub(g.b, g.a)); const n = perp(d); const m = mid(g.a, g.b);
    const c = add(m, mul(n, 3 * s));
    const L = 3 * s;
    dl.poly([sub(c, mul(d, L / 2)), add(c, mul(d, L / 2)), add(add(c, mul(d, L / 2)), mul(n, L * 0.6))], { w: 1, color: '#d0208c' }, true, { ns: true });
    dl.text(add(c, mul(n, L * 0.9)), fmtNum(t.angle ?? 35, 2) + '°', { size: 2.2, ha: 'center', va: 'bottom', color: '#d0208c' }, { ns: true });
  }
}

class RoofSketchTool extends SketchTool {
  pickedWalls = new Set<Id>();
  constructor(label: string, done: (loops: V2[][], segs: SketchSeg[]) => void, initial?: SketchSeg[]) {
    super(label, done, {
      initial, wallRef: 'ext', kinds: ['plan'],
      onSegment: (s) => { if (!s.tag) s.tag = { slope: RO.defSlope, angle: RO.angle }; },
      preview: (dl, segs) => slopeMarks(dl, segs),
      extra: () => roofOptions(),
    });
    this.showOffset = false;
  }
  prompt(): string {
    if (RO.assign) return 'Skizzenlinie anklicken, um die aktuelle Neigungsdefinition zuzuweisen.';
    return this.mode === 'pick' ? 'Wand wählen – der Überstand wird zur Außenseite angesetzt. Danach „Fertig stellen“.' : super.prompt();
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (RO.assign) {
      const tol = e.vp.hitTol() * 2;
      let best: SketchSeg | null = null; let bd = tol;
      for (const s of this.segs) { const d = distToSeg(e.raw, s.a, s.b); if (d < bd) { bd = d; best = s; } }
      if (best) { best.tag = { slope: RO.defSlope, angle: RO.angle }; app.redrawOverlay(); }
      else app.status('Keine Skizzenlinie unter dem Cursor.');
      return;
    }
    if (this.mode === 'pick') {
      this.offset = RO.overhang;
      const hit = e.vp.hit(e.raw).map((x: { id: Id }) => app.doc.get(x.id)).find((x: El | undefined) => x?.cat === 'wall') as Wall | undefined;
      if (hit) {
        this.pickedWalls.add(hit.id);
        const wi = wallInfo(app.doc, hit);
        // Cursor auf die Außenseite legen → Überstand nach außen
        super.down({ ...e, raw: add(e.raw, mul(wi.n, wi.ext * 1e5)) });
        return;
      }
    } else this.offset = 0;
    super.down(e);
  }
}

function roofOptions(): OptionItem[] {
  return [
    { kind: 'check', key: 'defSlope', label: 'Neigung definieren', value: RO.defSlope, onChange: (v) => { RO.defSlope = v; } },
    { kind: 'number', key: 'angle', label: 'Neigung (°)', value: RO.angle, width: 50, onChange: (v) => { if (v > 0 && v < 85) RO.angle = v; } },
    { kind: 'length', key: 'overhang', label: 'Überstand', value: RO.overhang, onChange: (v) => { RO.overhang = v; } },
    { kind: 'check', key: 'assign', label: 'Neigung zuweisen (Linie anklicken)', value: RO.assign, onChange: (v) => { RO.assign = v; app.setPrompt(app.tool.prompt()); } },
  ];
}

function startRoof(): void {
  const lvl = activeLevelId();
  RO.assign = false;
  const t: RoofSketchTool = new RoofSketchTool('Dach über Grundfläche', (loops, segs) => {
    const p = t.placement?.proto ?? ({} as El);
    const { id: _i, ...rest } = p;
    const edges = edgeAttrsFor(loops, segs);
    let id = '';
    app.doc.transaction('Dach erstellen', () => {
      id = app.doc.add<Roof>({ ...rest, id: newId('ro'), cat: 'roof', loops, edges, levelId: p.levelId || lvl, baseOffset: p.baseOffset ?? 0 } as Roof).id;
    });
    app.select([id]);
    const walls = [...t.pickedWalls].filter((w) => app.doc.get(w));
    if (walls.length && confirm('Sollen die gewählten Wände oben am Dach fixiert werden?')) {
      app.doc.transaction('Wand oben fixieren', () => { for (const w of walls) app.doc.update(w, { attachTopId: id }); });
    }
  });
  t.placement = placementFor('roof', { levelId: lvl, baseOffset: 0, typeId: 'rft_ziegel' });
  t.placement.proto.levelId = lvl;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, 'roof');
}

registerCommand({ id: 'roof', label: 'Dach', icon: 'roof', keys: ['RF'], tip: 'Dach über Grundfläche: Umriss skizzieren oder Wände wählen; neigungsdefinierende Kanten erzeugen Walm-, Sattel- oder Pultdächer.', run: startRoof });
registerSimilar('roof', 'roof');
registerContextPanel({ cats: ['roof'], panel: 'Dach', items: ['floorEditBoundary'] });

registerSketchEditor('roof', (el) => {
  const r = el as Roof;
  RO.assign = false;
  const initial: SketchSeg[] = [];
  r.loops.forEach((loop, k) => loop.forEach((p, i) => initial.push({ a: p, b: loop[(i + 1) % loop.length], tag: { ...(r.edges?.[k]?.[i] ?? { slope: false, angle: 35 }) } })));
  const t = new RoofSketchTool('Grundfläche bearbeiten', (loops, segs) => {
    app.doc.transaction('Grundfläche bearbeiten', () => app.doc.update<Roof>(r.id, { loops, edges: edgeAttrsFor(loops, segs) }));
    app.select([r.id]);
  }, initial);
  startTool(t, 'floorEditBoundary');
});

