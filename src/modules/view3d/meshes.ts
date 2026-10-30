// 3D-Geometrie aus Solids: Triangulierung planarer Flächen (mit Löchern), Körperkanten,
// Farben aus Materialien. Ergebnis sind reine Arrays (relativ zu einem Szenen-Ursprung,
// damit Float32 auch bei großen Koordinaten genau bleibt).
import * as THREE from 'three';
import type { Doc, El, Id } from '../../core/doc';
import type { Face, Solid } from '../../core/registry';
import type { View, Material } from '../../core/view';
import type { V3 } from '../../core/geom';
import { solidsOf, faceNormal } from '../../views/sectionEngine';
import { viewElements } from '../../views/viewBuilder';

/** Ersatzfarben je Kategorie (falls weder Material noch Solid-Farbe) */
export const CAT_COLORS: Record<string, string> = {
  wall: '#d9d4c7', floor: '#c8c8c8', roof: '#a0522d', ceiling: '#eeeeee', door: '#c8a878', window: '#f2f2f2',
  column: '#b5b5b5', beam: '#b5b5b5', stair: '#d0d0d0', railing: '#8a8a8a', foundation: '#a9a9a9', rebar: '#8b2a2a',
  component: '#c8b090', room: '#9ec5ff',
};
/** Kategorien, die in 3D standardmäßig nicht dargestellt werden (wie in Revit) */
export const HIDDEN_3D = new Set(['room', 'area', 'space']);

/** Winkel, unter dem eine Kante zwischen zwei Flächen als „glatt“ gilt und nicht gezeichnet wird */
const COS_SMOOTH = Math.cos((20 * Math.PI) / 180);

export interface ElPart { g: number; start: number; count: number }
export interface ElGeom {
  id: Id; cat: string;
  /** Dreiecke (x,y,z je Ecke, relativ zum Ursprung) */
  tris: Float32Array;
  /** Kanten als Segmentpaare (relativ zum Ursprung) */
  edges: Float32Array;
  /** Bereiche in den Materialgruppen (für Export je Element) */
  parts: ElPart[];
  /** Bounding Box (Welt) */
  min: V3; max: V3;
}
export interface MatGroup { key: string; color: string; opacity: number; glass: boolean; name: string; pos: number[]; nrm: number[]; owners: number[] }
export interface SceneData {
  origin: V3;
  groups: MatGroup[];
  els: Map<Id, ElGeom>;
  ids: Id[];
  edges: Float32Array;
  min: V3; max: V3;
  empty: boolean;
}

// ------------------------------------------------------------ Hilfen
const d3 = (a: V3, b: V3) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const nrmz = (a: V3): V3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

/** Doppelte Punkte (aufeinanderfolgend und Schlusspunkt) entfernen */
export function cleanRing(r: V3[]): V3[] {
  const out: V3[] = [];
  for (const p of r) {
    if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue;
    const q = out[out.length - 1];
    if (!q || d3(p, q) > 1e-6) out.push(p);
  }
  while (out.length > 1 && d3(out[0], out[out.length - 1]) <= 1e-6) out.pop();
  return out;
}

/**
 * Planare Fläche (Außenring + Löcher) triangulieren: in die Flächenebene projizieren,
 * mit THREE.ShapeUtils triangulieren, Orientierung an der Flächennormalen ausrichten.
 * Schreibt Positionen (relativ zu o) und Normalen; liefert die Anzahl der Dreiecke.
 */
export function triangulateFace(f: Face, o: V3, pos: number[], nrm: number[]): number {
  const outer = cleanRing(f.pts);
  if (outer.length < 3) return 0;
  const n = faceNormal(outer);
  if (Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) < 0.5) return 0;
  const holes = (f.holes ?? []).map(cleanRing).filter((h) => h.length >= 3);
  const push = (a: V3, b: V3, c: V3) => {
    pos.push(a.x - o.x, a.y - o.y, a.z - o.z, b.x - o.x, b.y - o.y, b.z - o.z, c.x - o.x, c.y - o.y, c.z - o.z);
    nrm.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
  };
  // Schnellweg: Dreieck
  if (outer.length === 3 && !holes.length) {
    const cr = cross({ x: outer[1].x - outer[0].x, y: outer[1].y - outer[0].y, z: outer[1].z - outer[0].z }, { x: outer[2].x - outer[0].x, y: outer[2].y - outer[0].y, z: outer[2].z - outer[0].z });
    if (dot(cr, n) >= 0) push(outer[0], outer[1], outer[2]); else push(outer[0], outer[2], outer[1]);
    return 1;
  }
  // Basis in der Ebene (u × v = n)
  const ax = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = nrmz(cross(ax, n));
  const v = cross(n, u);
  const P = outer[0];
  const to2 = (p: V3) => {
    const dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z;
    return new THREE.Vector2(dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z);
  };
  const verts: V3[] = outer.slice();
  for (const h of holes) verts.push(...h);
  let tris: number[][];
  try { tris = THREE.ShapeUtils.triangulateShape(outer.map(to2), holes.map((h) => h.map(to2))); } catch { return 0; }
  let cnt = 0;
  for (const [ia, ib, ic] of tris) {
    const a = verts[ia], b = verts[ib], c = verts[ic];
    if (!a || !b || !c) continue;
    const cr = cross({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z });
    const dd = dot(cr, n);
    if (Math.abs(dd) < 1e-9) continue;
    if (dd > 0) push(a, b, c); else push(a, c, b);
    cnt++;
  }
  return cnt;
}

/** Körperkanten: Randringe aller Flächen; Kanten zwischen (nahezu) koplanaren Flächen entfallen */
export function solidEdges(faces: Face[], o: V3, out: number[]): void {
  const m = new Map<string, { a: V3; b: V3; n: V3; cnt: number; smooth: boolean }>();
  const k = (p: V3) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10) + ',' + Math.round(p.z * 10);
  for (const f of faces) {
    const outer = cleanRing(f.pts);
    if (outer.length < 3) continue;
    const n = faceNormal(outer);
    for (const r of [outer, ...(f.holes ?? []).map(cleanRing)]) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const ka = k(a), kb = k(b);
        if (ka === kb) continue;
        const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const e = m.get(key);
        if (!e) m.set(key, { a, b, n, cnt: 1, smooth: false });
        else { e.cnt++; e.smooth = e.cnt === 2 && dot(e.n, n) > COS_SMOOTH; }
      }
    }
  }
  for (const e of m.values()) {
    if (e.smooth) continue;
    out.push(e.a.x - o.x, e.a.y - o.y, e.a.z - o.z, e.b.x - o.x, e.b.y - o.y, e.b.z - o.z);
  }
}

/** Darstellungsfarbe eines Solids */
export function solidLook(doc: Doc, el: El, s: Solid): { color: string; opacity: number; glass: boolean; name: string } {
  const m = s.mat ? doc.get<Material>(s.mat) : undefined;
  const mat = m && m.cat === 'material' ? m : undefined;
  const glass = s.role === 'glass';
  const color = normColor(mat?.color ?? s.color ?? CAT_COLORS[el.cat] ?? CAT_COLORS[catFamily(el.cat)] ?? '#cccccc');
  const tr = mat?.transparency ?? (glass ? 0.6 : 0);
  const opacity = Math.max(0.08, Math.min(1, 1 - tr));
  return { color, opacity: Math.round(opacity * 100) / 100, glass: glass || opacity < 0.99, name: mat?.name ?? s.role ?? el.cat };
}
/** z.B. 'foundationStrip' → 'foundation' */
export function catFamily(cat: string): string {
  for (const k of ['foundation', 'rebar', 'stair', 'railing', 'roof', 'floor', 'column', 'beam']) if (cat.startsWith(k)) return k;
  return cat;
}
function normColor(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('').toLowerCase();
  try { return '#' + new THREE.Color(c).getHexString(); } catch { return '#cccccc'; }
}

/** Darstellbare Modellelemente der 3D-Ansicht */
export function elements3d(doc: Doc, view: View): El[] {
  return viewElements(doc, view).model.filter((el) => el.cat !== 'view' && !HIDDEN_3D.has(el.cat));
}

/** Szene einer 3D-Ansicht aufbauen */
export function buildSceneData(doc: Doc, view: View, els: El[] = elements3d(doc, view)): SceneData {
  const items: { el: El; solids: Solid[]; min: V3; max: V3 }[] = [];
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const el of els) {
    const solids = solidsOf(doc, el);
    if (!solids.length) continue;
    const emin = { x: Infinity, y: Infinity, z: Infinity }, emax = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const s of solids) for (const f of s.faces) for (const p of f.pts) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue;
      if (p.x < emin.x) emin.x = p.x; if (p.y < emin.y) emin.y = p.y; if (p.z < emin.z) emin.z = p.z;
      if (p.x > emax.x) emax.x = p.x; if (p.y > emax.y) emax.y = p.y; if (p.z > emax.z) emax.z = p.z;
    }
    if (emin.x > emax.x) continue;
    items.push({ el, solids, min: emin, max: emax });
    min.x = Math.min(min.x, emin.x); min.y = Math.min(min.y, emin.y); min.z = Math.min(min.z, emin.z);
    max.x = Math.max(max.x, emax.x); max.y = Math.max(max.y, emax.y); max.z = Math.max(max.z, emax.z);
  }
  const empty = !items.length;
  const origin = empty ? { x: 0, y: 0, z: 0 } : { x: Math.round((min.x + max.x) / 2), y: Math.round((min.y + max.y) / 2), z: Math.round((min.z + max.z) / 2) };
  const groups: MatGroup[] = [];
  const gIndex = new Map<string, number>();
  const els3 = new Map<Id, ElGeom>();
  const ids: Id[] = [];
  const allEdges: number[] = [];
  for (const it of items) {
    const idx = ids.push(it.el.id) - 1;
    const tris: number[] = [];
    const edges: number[] = [];
    const parts: ElPart[] = [];
    for (const s of it.solids) {
      const look = solidLook(doc, it.el, s);
      const key = look.color + '|' + look.opacity;
      let gi = gIndex.get(key);
      if (gi === undefined) { gi = groups.push({ key, color: look.color, opacity: look.opacity, glass: look.glass, name: look.name, pos: [], nrm: [], owners: [] }) - 1; gIndex.set(key, gi); }
      const g = groups[gi];
      const start = g.pos.length;
      let n = 0;
      for (const f of s.faces) n += triangulateFace(f, origin, g.pos, g.nrm);
      for (let i = 0; i < n; i++) g.owners.push(idx);
      for (let i = start; i < g.pos.length; i++) tris.push(g.pos[i]);
      if (n) parts.push({ g: gi, start, count: n * 9 });
      solidEdges(s.faces, origin, edges);
    }
    for (let i = 0; i < edges.length; i++) allEdges.push(edges[i]);
    els3.set(it.el.id, { id: it.el.id, cat: it.el.cat, tris: new Float32Array(tris), edges: new Float32Array(edges), parts, min: it.min, max: it.max });
  }
  return {
    origin, groups, els: els3, ids, edges: new Float32Array(allEdges),
    min: empty ? { x: -5000, y: -5000, z: 0 } : min, max: empty ? { x: 15000, y: 10000, z: 3000 } : max, empty,
  };
}
