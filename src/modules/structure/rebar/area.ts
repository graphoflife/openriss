// Flächenbewehrung (Platten, Grundriss): Bereich + Lagen unten/oben × Haupt-/Querrichtung (Ø/Abstand),
// Symbol mit Richtungslinien und „Ø10/15 u“. Mattenbewehrung: Lagermatten (B500A, 6,00 × 2,30 m) mit
// Übergreifung, Mattenverlegeplan (Rechtecke mit Diagonale), Anzahl und Gewicht.
import { app } from '../../../app';
import type { Doc, El, Id } from '../../../core/doc';
import { newId } from '../../../core/doc';
import {
  V2, add, sub, mul, dot, perp, fromAngle, angleOf, interiorPoint, Poly, MultiPoly, intersection, polyArea, signedArea,
  offsetPolyline, apply, applyVec, deg, rad, dist,
} from '../../../core/geom';
import { registerCategory, GROUPS, PropDef, onHook, PlanCtx, SectionCtx } from '../../../core/registry';
import { TypeEl, typesOf, isPlanLike, View } from '../../../core/view';
import { cached } from '../../../core/cache';
import { planRange } from '../../../views/viewBuilder';
import { SketchTool, loopsToSegs } from '../../../tools/sketchTool';
import type { OptionItem } from '../../../tools/tool';
import { startTool } from '../../../ui/commands';
import { clipSegToMulti } from '../../../elements/wall';
import type { DisplayList } from '../../../render/displayList';
import type { Pen } from '../../../render/styles';
import { fmtNum, fmtArea } from '../../../core/units';
import { DIAS, kgPerM, cleanRing, insetRing } from './math';
import { slabAt, slabOutline, sectionFrame, fView, Xf3, xfOfView, xfTranslate } from './frame';
import { coverFor } from './build';
import { maxPos, hostLabel } from './rebar';
import { planOf, currentPlan, diasFor } from './norm';
import { registerTagProvider } from './tag';
import { HOST_CATS, solidBox, ensureRebarMaterial } from '../common';

// ------------------------------------------------------------ Lagermatten
export interface FabricType extends TypeEl { of: 'fabricArea'; dL: number; sL: number; dQ: number; sQ: number; L: number; B: number; kg: number; description?: string }
/** Lagermattenprogramm (B500A): Längsstäbe Ø/Abstand, Querstäbe Ø/Abstand, Gewicht je Matte */
export const FABRICS: [string, number, number, number, number, number, number][] = [
  // Name, dL, sL, dQ, sQ, B, kg
  ['Q188A', 6, 150, 6, 150, 2300, 41.7], ['Q257A', 7, 150, 7, 150, 2300, 56.8], ['Q335A', 8, 150, 8, 150, 2300, 74.3],
  ['Q424A', 9, 150, 9, 150, 2300, 84.4], ['Q524A', 10, 150, 10, 150, 2300, 100.9], ['Q636A', 9, 100, 10, 125, 2350, 132.0],
  ['R188A', 6, 150, 6, 250, 2300, 33.6], ['R257A', 7, 150, 7, 250, 2300, 41.2], ['R335A', 8, 150, 8, 250, 2300, 50.2],
  ['R424A', 9, 150, 8, 250, 2300, 67.2], ['R524A', 10, 150, 8, 250, 2300, 75.7],
];
export function addFabricTypes(doc: Doc): void {
  ensureRebarMaterial(doc);
  if (typesOf(doc, 'fabricArea').length) return;
  for (const [name, dL, sL, dQ, sQ, B, kg] of FABRICS) {
    const id = 'fab_' + name.toLowerCase();
    if (!doc.get(id)) doc.add({ id, cat: 'type', of: 'fabricArea', name, dL, sL, dQ, sQ, L: 6000, B, kg } as FabricType);
  }
}
const asOf = (d: number, s: number) => (Math.PI * d * d / 4) / s * 10; // cm²/m

// ------------------------------------------------------------ Datenmodell
export type LayerKey = 'uH' | 'uQ' | 'oH' | 'oQ';
export interface AreaLayer { key: LayerKey; on: boolean; dia: number; s: number; pos: number }
export interface AreaRebar extends El { cat: 'areaRebar'; hostId: Id; loops: V2[][]; angle: number; layers: AreaLayer[]; cover?: number; showBars?: boolean }
export interface FabricArea extends El { cat: 'fabricArea'; hostId?: Id; loops: V2[][]; angle: number; layer: 'u' | 'o'; lapL: number; lapQ: number; cover?: number }
export const LAYER_LABELS: Record<LayerKey, string> = { uH: 'Unten Hauptrichtung', uQ: 'Unten Querrichtung', oH: 'Oben Hauptrichtung', oQ: 'Oben Querrichtung' };
const LAYER_ORDER: LayerKey[] = ['uH', 'uQ', 'oH', 'oQ'];
const cm = (mm: number) => fmtNum(mm / 10, mm % 10 ? 1 : 0);
export const layerText = (l: AreaLayer) => `Ø${l.dia}/${cm(l.s)} ${l.key[0]}`;

/** Bereich abzüglich Randdeckung */
function regionOf(loops: V2[][], c: number): MultiPoly {
  if (!loops?.length) return [];
  const outer = insetRing(cleanRing(loops[0]), c);
  if (!outer) return [];
  const holes = loops.slice(1).map((h) => { const r = cleanRing(h); return offsetPolyline(r, -c, true); }).filter((h) => Math.abs(signedArea(h)) > 1);
  return [[outer, ...holes]];
}
function hostZ(doc: Doc, hostId: Id | undefined, levelId?: Id): [number, number] {
  const h = doc.get(hostId); const b = h ? solidBox(doc, h) : null;
  if (b) return [b.min.z, b.max.z];
  const lz = doc.get<any>(levelId)?.elev ?? 0;
  return [lz - 250, lz];
}

interface BarLayer { key: string; label: string; dia: number; s: number; z: number; dir: V2; segs: [V2, V2][]; n: number; total: number; pos?: number }
function barsIn(region: MultiPoly, dir: V2, s: number): [V2, V2][] {
  if (!region.length || s < 10) return [];
  const w = perp(dir);
  let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
  for (const p of region) for (const r of p) for (const q of r) { const a = dot(q, w), b = dot(q, dir); smin = Math.min(smin, a); smax = Math.max(smax, a); tmin = Math.min(tmin, b); tmax = Math.max(tmax, b); }
  const span = smax - smin; const n = Math.floor(span / s + 1e-6);
  const margin = (span - n * s) / 2;
  const out: [V2, V2][] = [];
  for (let k = 0; k <= n && k < 2000; k++) {
    const sk = smin + margin + k * s;
    const a = add(mul(w, sk), mul(dir, tmin - 10)), b = add(mul(w, sk), mul(dir, tmax + 10));
    for (const sg of clipSegToMulti(a, b, region)) if (dist(sg[0], sg[1]) > 1) out.push(sg);
  }
  return out;
}
const mkLayer = (key: string, label: string, dia: number, s: number, z: number, dir: V2, segs: [V2, V2][], pos?: number): BarLayer =>
  ({ key, label, dia, s, z, dir, segs, n: segs.length, total: segs.reduce((t, g) => t + dist(g[0], g[1]), 0), pos });

export interface AreaGeo { region: MultiPoly; layers: BarLayer[] }
export function areaGeo(doc: Doc, el: AreaRebar): AreaGeo {
  return cached(doc, 'areaGeo', el.id, () => {
    const host = doc.get(el.hostId); const c = coverFor(doc, host, el.cover);
    const region = regionOf(el.loops, c);
    const [zmin, zmax] = hostZ(doc, el.hostId);
    const L = (k: LayerKey) => el.layers.find((l) => l.key === k && l.on);
    const dH = fromAngle(el.angle ?? 0), dQ = perp(dH);
    const layers: BarLayer[] = [];
    for (const k of LAYER_ORDER) {
      const l = L(k); if (!l) continue;
      const main = k[1] === 'H'; const bottom = k[0] === 'u';
      const other = main ? undefined : L((k[0] + 'H') as LayerKey);
      const off = c + (other ? other.dia : 0) + l.dia / 2;
      const z = bottom ? zmin + off : zmax - off;
      layers.push(mkLayer(k, LAYER_LABELS[k], l.dia, l.s, z, main ? dH : dQ, barsIn(region, main ? dH : dQ, l.s), l.pos));
    }
    return { region, layers };
  });
}

export interface FabricMat { rect: V2[]; clip: MultiPoly; c: V2 }
export interface FabricGeo { region: MultiPoly; mats: FabricMat[]; t?: FabricType; layers: BarLayer[] }
export function fabricGeo(doc: Doc, el: FabricArea): FabricGeo {
  return cached(doc, 'fabricGeo', el.id, () => {
    const t = doc.get<FabricType>(el.typeId);
    const host = doc.get(el.hostId); const c = coverFor(doc, host, el.cover);
    const region = regionOf(el.loops, c);
    const u = fromAngle(el.angle ?? 0), v = perp(u);
    const L = t?.L ?? 6000, B = t?.B ?? 2300;
    const pu = Math.max(500, L - (el.lapL ?? 0)), pv = Math.max(300, B - (el.lapQ ?? 0));
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of region) for (const r of p) for (const q of r) { u0 = Math.min(u0, dot(q, u)); u1 = Math.max(u1, dot(q, u)); v0 = Math.min(v0, dot(q, v)); v1 = Math.max(v1, dot(q, v)); }
    const mats: FabricMat[] = [];
    if (region.length) {
      for (let j = 0; v0 + j * pv < v1 - 1 && j < 200; j++) for (let i = 0; u0 + i * pu < u1 - 1 && i < 200; i++) {
        const a = u0 + i * pu, b = v0 + j * pv;
        const P = (x: number, y: number) => add(mul(u, x), mul(v, y));
        const rect = [P(a, b), P(a + L, b), P(a + L, b + B), P(a, b + B)];
        const clip = intersection(region, [rect]);
        const ar = clip.reduce((s, p) => s + polyArea(p), 0);
        if (ar < 1e4) continue;
        mats.push({ rect, clip, c: interiorPoint(clip.slice().sort((x, y) => polyArea(y) - polyArea(x))[0]) });
      }
    }
    const [zmin, zmax] = hostZ(doc, el.hostId, el.levelId);
    const dL = t?.dL ?? 6, dQ = t?.dQ ?? 6; const bottom = el.layer !== 'o';
    const zL = bottom ? zmin + c + dL / 2 : zmax - c - dL / 2;
    const zQ = bottom ? zmin + c + dL + dQ / 2 : zmax - c - dL - dQ / 2;
    const layers = [mkLayer('L', 'Längsstäbe', dL, t?.sL ?? 150, zL, u, barsIn(region, u, t?.sL ?? 150)), mkLayer('Q', 'Querstäbe', dQ, t?.sQ ?? 150, zQ, v, barsIn(region, v, t?.sQ ?? 150))];
    return { region, mats, t, layers };
  });
}
export const fabricWeight = (doc: Doc, el: FabricArea) => { const g = fabricGeo(doc, el); return g.mats.length * (g.t?.kg ?? 0); };
export const areaWeight = (doc: Doc, el: AreaRebar) => areaGeo(doc, el).layers.reduce((s, l) => s + (l.total / 1000) * kgPerM(l.dia), 0);

// ------------------------------------------------------------ Darstellung
const readable = (a: number) => { let r = a; while (r > Math.PI / 2) r -= Math.PI; while (r <= -Math.PI / 2) r += Math.PI; return r; };

function chordAt(region: MultiPoly, c: V2, d: V2): [V2, V2] | null {
  const segs = clipSegToMulti(add(c, mul(d, -1e6)), add(c, mul(d, 1e6)), region);
  let best: [V2, V2] | null = null; let bd = Infinity;
  for (const s of segs) { const m = { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 }; const dd = dist(m, c); if (dd < bd) { bd = dd; best = s; } }
  return best;
}

function symbolLine(dl: DisplayList, region: MultiPoly, c: V2, d: V2, text: string, s: number, pen: Pen): void {
  const ch = chordAt(region, c, d); if (!ch) return;
  const [a, b] = ch; const n = perp(d);
  dl.line(a, b, pen, { ns: true });
  for (const q of [a, b]) {
    dl.line(add(q, mul(n, -1.5 * s)), add(q, mul(n, 1.5 * s)), pen, { ns: true });
    dl.line(add(q, mul(add(d, n), -0.8 * s)), add(q, mul(add(d, n), 0.8 * s)), { ...pen, w: 2 }, { ns: true });
  }
  const rot = readable(angleOf(d));
  const nn = perp(fromAngle(rot));
  if (text) dl.text(add(c, mul(nn, 1.2 * s)), text, { size: 2.5, ha: 'center', va: 'bottom', rot });
}

function drawAreaPlan(ctx: PlanCtx, el: AreaRebar): void {
  const { dl, doc } = ctx; const s = ctx.view.scale || 100;
  const g = areaGeo(doc, el);
  const pen: Pen = { w: 1, color: '#000000' };
  for (const r of el.loops) dl.poly(r, { w: 2, color: '#000000', dash: 'dash' }, true);
  if (el.showBars) for (const l of g.layers) for (const sg of l.segs) dl.line(sg[0], sg[1], { w: 1, color: l.key[0] === 'u' ? '#000000' : '#555555', dash: l.key[0] === 'o' ? 'dash' : undefined }, { ns: true });
  if (!g.region.length) return;
  const c = interiorPoint(g.region[0]);
  const on = el.layers.filter((l) => l.on);
  const dH = fromAngle(el.angle ?? 0);
  const tH = on.filter((l) => l.key[1] === 'H').map(layerText).join(', ');
  const tQ = on.filter((l) => l.key[1] === 'Q').map(layerText).join(', ');
  if (tH) symbolLine(dl, g.region, c, dH, tH, s, pen);
  if (tQ) symbolLine(dl, g.region, c, perp(dH), tQ, s, pen);
}

function drawFabricPlan(ctx: PlanCtx, el: FabricArea): void {
  const { dl, doc } = ctx; const s = ctx.view.scale || 100;
  const g = fabricGeo(doc, el);
  for (const r of el.loops) dl.poly(r, { w: 2, color: '#000000', dash: 'dash' }, true);
  const pen: Pen = { w: 1, color: '#000000' };
  const rot = readable(el.angle ?? 0);
  g.mats.forEach((m, i) => {
    for (const p of m.clip) for (const r of p) dl.poly(r, pen, true, { ns: true });
    for (const sg of clipSegToMulti(m.rect[0], m.rect[2], m.clip)) dl.line(sg[0], sg[1], pen, { ns: true });
    dl.text(m.c, `${g.t?.name ?? '?'} ${el.layer}`, { size: 2.2, ha: 'center', va: 'bottom', rot, opaque: true });
    dl.text(m.c, `M${i + 1}`, { size: 1.8, ha: 'center', va: 'top', rot });
  });
  void s;
}

/** Schnitt: Stäbe ⟂ Schnitt als Punkte, parallel als Linie */
function drawLayersSection(ctx: SectionCtx, region: MultiPoly, layers: BarLayer[], o: El): void {
  if (ctx.view.kind !== 'section' || !region.length) return;
  const f = sectionFrame(ctx.view);
  const O = { x: f.origin.x, y: f.origin.y }, R = { x: f.right.x, y: f.right.y };
  const lineA = add(O, mul(R, -1e6)), lineB = add(O, mul(R, 1e6));
  const chords = clipSegToMulti(lineA, lineB, region);
  if (!chords.length) return;
  const s = ctx.view.scale || 100;
  const z0 = f.origin.z;
  for (const l of layers) {
    const y = l.z - z0; const w = perp(l.dir);
    const par = Math.abs(dot(l.dir, R)) > 0.7;
    if (par) {
      // Stab im Abstand hinter der Schnittebene sichtbar → Linie über die Sehne
      for (const c of chords) ctx.dl.line({ x: dot(sub(c[0], O), R), y }, { x: dot(sub(c[1], O), R), y }, { w: 6 });
      continue;
    }
    const r = Math.max(l.dia / 2, 0.3 * s);
    const rw = dot(R, w); if (Math.abs(rw) < 1e-6) continue;
    for (const sg of l.segs) {
      const sk = dot(sg[0], w);
      const t = (sk - dot(O, w)) / rw;
      const q = add(O, mul(R, t));
      const d1 = dot(sub(q, sg[0]), l.dir), L = dot(sub(sg[1], sg[0]), l.dir);
      if (d1 < 0 || d1 > L) continue;
      ctx.dl.circle({ x: t, y }, r, undefined, { color: '#000000' });
    }
  }
  void o; void fView;
}

// ------------------------------------------------------------ Transformation
export function xfArea(el: El, X: Xf3): Partial<El> {
  const P = (p: V2): V2 => { const q = X.p({ x: p.x, y: p.y, z: 0 }); return { x: q.x, y: q.y }; };
  const d = X.v({ ...fromAngle(el.angle ?? 0), z: 0 });
  return { loops: (el.loops as V2[][]).map((r) => r.map(P)), angle: Math.atan2(d.y, d.x) };
}

// ------------------------------------------------------------ Eigenschaften
const diaOpts = (doc: Doc = app.doc): [string, string][] => diasFor(doc).map((d) => [String(d), 'Ø ' + d]);
function areaProps(): PropDef[] {
  const g = GROUPS; const p: PropDef[] = [];
  p.push({ key: 'angle', label: 'Hauptrichtung (Winkel)', group: g.constraints, type: 'angle', get: (e) => e.angle ?? 0, set: (_e, v) => ({ angle: v }) });
  p.push({ key: 'cover', label: 'Überdeckung', group: g.constraints, type: 'length', get: (e, doc) => e.cover ?? coverFor(doc, doc.get(e.hostId)), set: (_e, v) => ({ cover: v > 0 ? v : undefined }) });
  p.push({ key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => hostLabel(doc, e.hostId) });
  for (const k of LAYER_ORDER) {
    const grp = 'Lage: ' + LAYER_LABELS[k];
    const upd = (e: El, patch: Partial<AreaLayer>, doc: Doc) => ({ layers: (e.layers as AreaLayer[]).map((l) => (l.key === k ? { ...l, ...patch, pos: patch.on && !l.pos ? maxPos(doc, planOf(e)) + 1 : patch.pos ?? l.pos } : l)) });
    const L = (e: El) => (e.layers as AreaLayer[]).find((l) => l.key === k)!;
    p.push(
      { key: k + 'on', label: 'Aktiv', group: grp, type: 'bool', get: (e) => !!L(e)?.on, set: (e, v, doc) => upd(e, { on: v }, doc) },
      { key: k + 'dia', label: 'Stabdurchmesser Ø', group: grp, type: 'select', options: (doc: Doc) => diaOpts(doc), get: (e) => String(L(e)?.dia ?? 10), set: (e, v, doc) => upd(e, { dia: Number(v) }, doc) },
      { key: k + 's', label: 'Abstand', group: grp, type: 'length', get: (e) => L(e)?.s ?? 150, set: (e, v, doc) => (v >= 30 ? upd(e, { s: v }, doc) : undefined) },
      { key: k + 'pos', label: 'Positionsnummer', group: grp, type: 'int', get: (e) => L(e)?.pos ?? 0, set: (e, v, doc) => (v > 0 ? upd(e, { pos: v }, doc) : undefined) },
    );
  }
  p.push(
    { key: 'showBars', label: 'Einzelstäbe anzeigen', group: g.graphics, type: 'bool', get: (e) => !!e.showBars, set: (_e, v) => ({ showBars: v }) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e) => (e.loops?.length ? polyArea(e.loops) : 0) },
    { key: 'weight', label: 'Gewicht', group: g.dims, type: 'readonly', get: (e, doc) => fmtNum(areaWeight(doc, e as AreaRebar), 1) + ' kg' },
    { key: 'edit', label: 'Begrenzung', group: g.constraints, type: 'button', get: () => 'Bearbeiten…', action: (e) => editBoundary(e) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  );
  return p;
}
function fabricProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'layer', label: 'Lage', group: g.constraints, type: 'select', options: [['u', 'Unten'], ['o', 'Oben']], get: (e) => e.layer ?? 'u', set: (_e, v) => ({ layer: v }) },
    { key: 'angle', label: 'Hauptrichtung (Mattenlänge)', group: g.constraints, type: 'angle', get: (e) => e.angle ?? 0, set: (_e, v) => ({ angle: v }) },
    { key: 'lapL', label: 'Übergreifung Längsrichtung', group: g.constraints, type: 'length', get: (e) => e.lapL ?? 0, set: (_e, v) => ({ lapL: Math.max(0, v) }) },
    { key: 'lapQ', label: 'Übergreifung Querrichtung', group: g.constraints, type: 'length', get: (e) => e.lapQ ?? 0, set: (_e, v) => ({ lapQ: Math.max(0, v) }) },
    { key: 'cover', label: 'Überdeckung', group: g.constraints, type: 'length', get: (e, doc) => e.cover ?? coverFor(doc, doc.get(e.hostId)), set: (_e, v) => ({ cover: v > 0 ? v : undefined }) },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => hostLabel(doc, e.hostId) },
    { key: 'count', label: 'Anzahl Matten', group: g.dims, type: 'readonly', get: (e, doc) => String(fabricGeo(doc, e as FabricArea).mats.length) },
    { key: 'weight', label: 'Gewicht', group: g.dims, type: 'readonly', get: (e, doc) => fmtNum(fabricWeight(doc, e as FabricArea), 1) + ' kg' },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e) => (e.loops?.length ? polyArea(e.loops) : 0) },
    { key: 'edit', label: 'Begrenzung', group: g.constraints, type: 'button', get: () => 'Bearbeiten…', action: (e) => editBoundary(e) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}
function fabricTypeProps(): PropDef[] {
  const g = GROUPS;
  const len = (k: string, label: string): PropDef => ({ key: k, label, group: g.dims, type: 'length', get: (t) => t[k], set: (_t, v) => (v > 0 ? { [k]: v } : undefined) });
  return [
    { key: 'dL', label: 'Ø Längsstäbe', group: g.construction, type: 'number', get: (t) => t.dL, set: (_t, v) => (v > 0 ? { dL: v } : undefined) },
    len('sL', 'Abstand Längsstäbe'),
    { key: 'dQ', label: 'Ø Querstäbe', group: g.construction, type: 'number', get: (t) => t.dQ, set: (_t, v) => (v > 0 ? { dQ: v } : undefined) },
    len('sQ', 'Abstand Querstäbe'),
    len('L', 'Mattenlänge'), len('B', 'Mattenbreite'),
    { key: 'kg', label: 'Gewicht je Matte (kg)', group: g.dims, type: 'number', get: (t) => t.kg, set: (_t, v) => (v > 0 ? { kg: v } : undefined) },
    { key: 'as', label: 'Querschnitt längs / quer', group: g.dims, type: 'readonly', get: (t) => `${fmtNum(asOf(t.dL, t.sL), 2)} / ${fmtNum(asOf(t.dQ, t.sQ), 2)} cm²/m` },
    { key: 'kgm2', label: 'Gewicht je m²', group: g.dims, type: 'readonly', get: (t) => fmtNum(t.kg / ((t.L * t.B) / 1e6), 2) + ' kg/m²' },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

// ------------------------------------------------------------ Kategorien
const loopCenter = (el: El): V2 | null => (el.loops?.length ? interiorPoint(el.loops) : null);
const areaTransform = (el: El, m: any, _doc: Doc, view: View) => { const X = xfOfView(m, view); return X && isPlanLike(view) ? xfArea(el, X) : undefined; };

registerCategory({
  cat: 'areaRebar', label: 'Flächenbewehrung', plural: 'Flächenbewehrungen', planOrder: 82,
  drawPlan: (ctx, el) => { if (ctx.view.kind === 'plan') drawAreaPlan(ctx, el as AreaRebar); },
  drawSection: (ctx, el) => { const g = areaGeo(ctx.doc, el as AreaRebar); drawLayersSection(ctx, g.region, g.layers, el); },
  visibleIn: (_el, _doc, view) => view.kind === 'plan' || view.kind === 'section',
  center: (el) => loopCenter(el),
  tagPoint: (el) => loopCenter(el),
  transform: areaTransform,
  translate3d: (el, d) => xfArea(el, xfTranslate(d)),
  props: () => areaProps(),
  scheduleFields: () => [
    { key: 'weight', label: 'Gewicht', unit: 'kg', get: (el, doc) => areaWeight(doc, el as AreaRebar) },
    { key: 'host', label: 'Host', get: (el, doc) => hostLabel(doc, el.hostId) },
  ],
});
registerCategory({
  cat: 'fabricArea', label: 'Mattenbewehrung', plural: 'Mattenbewehrungen', hasTypes: true, planOrder: 81,
  drawPlan: (ctx, el) => { if (ctx.view.kind === 'plan') drawFabricPlan(ctx, el as FabricArea); },
  drawSection: (ctx, el) => { const g = fabricGeo(ctx.doc, el as FabricArea); drawLayersSection(ctx, g.region, g.layers, el); },
  visibleIn: (_el, _doc, view) => view.kind === 'plan' || view.kind === 'section',
  center: (el) => loopCenter(el),
  tagPoint: (el) => loopCenter(el),
  tagText: (el, doc) => doc.get(el.typeId)?.name ?? '',
  transform: areaTransform,
  translate3d: (el, d) => xfArea(el, xfTranslate(d)),
  props: () => fabricProps(),
  typeProps: () => fabricTypeProps(),
  scheduleFields: () => [
    { key: 'type', label: 'Mattentyp', get: (el, doc) => doc.get(el.typeId)?.name ?? '' },
    { key: 'count', label: 'Anzahl Matten', unit: 'num', get: (el, doc) => fabricGeo(doc, el as FabricArea).mats.length },
    { key: 'weight', label: 'Gewicht', unit: 'kg', get: (el, doc) => fabricWeight(doc, el as FabricArea) },
  ],
});

registerTagProvider('areaRebar', (doc, el, view) => ({
  text: (el.layers as AreaLayer[]).filter((l) => l.on).map((l) => `${layerText(l)}  (Pos. ${l.pos})`).join('\n'),
  anchor: isPlanLike(view) ? loopCenter(el) : null,
}));
registerTagProvider('fabricArea', (doc, el, view) => {
  const g = fabricGeo(doc, el as FabricArea);
  return { text: `${g.t?.name ?? '?'} ${el.layer === 'o' ? 'oben' : 'unten'} – ${g.mats.length} Matten`, anchor: isPlanLike(view) ? loopCenter(el) : null };
});

// ------------------------------------------------------------ Werkzeuge
function editBoundary(el: El): void {
  if (!el.loops?.length || !app.doc.get(el.id)) return;
  startTool(new SketchTool('Begrenzung bearbeiten', (loops) => {
    app.doc.transaction('Begrenzung bearbeiten', () => app.doc.update(el.id, { loops }));
  }, { initial: loopsToSegs(el.loops) }), el.cat);
}
onHook('dblclick', (el: El) => { if (el.cat === 'areaRebar' || el.cat === 'fabricArea') editBoundary(el); });

const areaState = { angle: 0, diaH: 10, sH: 150, diaQ: 10, sQ: 150, layers: 'u' as 'u' | 'o' | 'uo' };
const fabState = { angle: 0, layer: 'u' as 'u' | 'o', lapL: 500, lapQ: 300, typeId: '' };

/** Host (liegendes Bauteil) aus Auswahl oder Skizze bestimmen */
function hostFor(loops: V2[][], pre: Id | null): El | null {
  if (pre) return app.doc.get(pre) ?? null;
  const v = app.activeView(); if (!v) return null;
  const cut = v.kind === 'plan' ? planRange(app.doc, v).cutZ : Infinity;
  return slabAt(app.doc, interiorPoint(loops), cut)?.host ?? null;
}
function preselectedSlab(): El | null {
  const s = app.selected().filter((e) => HOST_CATS.includes(e.cat) && e.cat !== 'wall' && e.cat !== 'column');
  return s.length === 1 ? s[0] : null;
}
function outlineSegs(host: El | null) {
  if (!host) return undefined;
  const polys = slabOutline(app.doc, host);
  return polys.length ? loopsToSegs(polys[0]) : undefined;
}

export function startAreaRebar(): void {
  const pre = preselectedSlab();
  const extra = (): OptionItem[] => [
    { kind: 'angle', key: 'ang', label: 'Hauptrichtung', value: Math.round(deg(areaState.angle)), onChange: (v) => (areaState.angle = rad(v)) },
    { kind: 'select', key: 'lay', label: 'Lagen', value: areaState.layers, options: [['u', 'unten'], ['o', 'oben'], ['uo', 'unten + oben']], onChange: (v) => (areaState.layers = v as any) },
    { kind: 'select', key: 'dH', label: 'Haupt Ø', value: String(areaState.diaH), options: diaOpts(), onChange: (v) => (areaState.diaH = Number(v)) },
    { kind: 'length', key: 'sH', label: '/', value: areaState.sH, onChange: (v) => (areaState.sH = Math.max(30, v)) },
    { kind: 'select', key: 'dQ', label: 'Quer Ø', value: String(areaState.diaQ), options: diaOpts(), onChange: (v) => (areaState.diaQ = Number(v)) },
    { kind: 'length', key: 'sQ', label: '/', value: areaState.sQ, onChange: (v) => (areaState.sQ = Math.max(30, v)) },
  ];
  const t = new SketchTool('Flächenbewehrung', (loops) => {
    const host = hostFor(loops, pre?.id ?? null);
    if (!host) { app.status('Kein Bauteil (Decke, Bodenplatte, Fundament) unter dem Bereich gefunden.'); return; }
    app.doc.transaction('Flächenbewehrung', () => {
      ensureRebarMaterial(app.doc);
      const plan = currentPlan(app.doc);
      let pos = maxPos(app.doc, plan);
      const lay = (key: LayerKey, on: boolean, dia: number, s: number): AreaLayer => ({ key, on, dia, s, pos: on ? ++pos : 0 });
      const u = areaState.layers.includes('u'), o = areaState.layers.includes('o');
      app.doc.add({
        id: newId('ar'), cat: 'areaRebar', hostId: host.id, loops, angle: areaState.angle, plan: plan || undefined,
        layers: [lay('uH', u, areaState.diaH, areaState.sH), lay('uQ', u, areaState.diaQ, areaState.sQ), lay('oH', o, areaState.diaH, areaState.sH), lay('oQ', o, areaState.diaQ, areaState.sQ)],
      } as AreaRebar);
    });
  }, { extra, initial: outlineSegs(pre) });
  startTool(t, 'areaRebar');
  if (pre) app.status('Umriss des gewählten Bauteils übernommen – Skizze anpassen und „Fertig stellen“.');
}

export function startFabricArea(): void {
  app.doc.transaction('Lagermatten', () => addFabricTypes(app.doc));
  const types = typesOf(app.doc, 'fabricArea');
  if (!fabState.typeId || !app.doc.get(fabState.typeId)) fabState.typeId = types.find((t) => t.name === 'Q188A')?.id ?? types[0]?.id ?? '';
  const pre = preselectedSlab();
  const extra = (): OptionItem[] => [
    { kind: 'select', key: 'type', label: 'Matte', value: fabState.typeId, options: typesOf(app.doc, 'fabricArea').map((t) => [t.id, t.name] as [string, string]), onChange: (v) => (fabState.typeId = v) },
    { kind: 'select', key: 'lay', label: 'Lage', value: fabState.layer, options: [['u', 'unten'], ['o', 'oben']], onChange: (v) => (fabState.layer = v as 'u' | 'o') },
    { kind: 'angle', key: 'ang', label: 'Mattenlänge in Richtung', value: Math.round(deg(fabState.angle)), onChange: (v) => (fabState.angle = rad(v)) },
    { kind: 'length', key: 'lapL', label: 'Übergreifung längs', value: fabState.lapL, onChange: (v) => (fabState.lapL = Math.max(0, v)) },
    { kind: 'length', key: 'lapQ', label: 'quer', value: fabState.lapQ, onChange: (v) => (fabState.lapQ = Math.max(0, v)) },
  ];
  const t = new SketchTool('Mattenbewehrung', (loops) => {
    const host = hostFor(loops, pre?.id ?? null);
    const v = app.activeView();
    app.doc.transaction('Mattenbewehrung', () => {
      app.doc.add({
        id: newId('fa'), cat: 'fabricArea', hostId: host?.id, levelId: v?.levelId, typeId: fabState.typeId, loops, angle: fabState.angle, plan: currentPlan(app.doc) || undefined,
        layer: fabState.layer, lapL: fabState.lapL, lapQ: fabState.lapQ,
      } as FabricArea);
    });
    if (!host) app.status('Hinweis: kein Bauteil gefunden – Höhenlage aus der Ebene angenommen.');
  }, { extra, initial: outlineSegs(pre) });
  startTool(t, 'fabricArea');
}

// ------------------------------------------------------------ Stahlliste
export interface AreaRow { pos: number; n: number; dia: number; lens: number[]; total: number; kg: number; label: string; hostId: Id; elId: Id }
export function areaRows(doc: Doc, els?: AreaRebar[]): AreaRow[] {
  const out: AreaRow[] = [];
  for (const el of els ?? doc.all<AreaRebar>('areaRebar')) for (const l of areaGeo(doc, el).layers) {
    if (!l.n) continue;
    out.push({ pos: l.pos ?? 0, n: l.n, dia: l.dia, lens: l.segs.map((s) => dist(s[0], s[1])), total: l.total, kg: (l.total / 1000) * kgPerM(l.dia), label: `${l.label} ${layerText({ key: l.key as LayerKey, on: true, dia: l.dia, s: l.s, pos: 0 })}`, hostId: el.hostId, elId: el.id });
  }
  return out;
}
export function fabricRows(doc: Doc, els?: FabricArea[]): { type: string; n: number; kgEach: number; kg: number; area: number }[] {
  const m = new Map<string, { type: string; n: number; kgEach: number; kg: number; area: number }>();
  for (const el of els ?? doc.all<FabricArea>('fabricArea')) {
    const g = fabricGeo(doc, el); const name = g.t?.name ?? '?';
    const r = m.get(name) ?? { type: name, n: 0, kgEach: g.t?.kg ?? 0, kg: 0, area: 0 };
    r.n += g.mats.length; r.kg += g.mats.length * (g.t?.kg ?? 0); r.area += el.loops?.length ? polyArea(el.loops) : 0;
    m.set(name, r);
  }
  return [...m.values()].sort((a, b) => a.type.localeCompare(b.type));
}

export { fmtArea, apply, applyVec, sub };
