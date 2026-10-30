// Gemeinsame Hilfen der Architektur-Elemente: Schichttypen, Skizzen-Umrisse (Schleifen),
// Platten-Körper je Schicht, Grundrissdarstellung von Platten, Schächte, Griffe/Transformation.
import type { Doc, El, Id } from '../../core/doc';
import {
  V2, Poly, MultiPoly, apply, Mat2, lineLine, lerp, pointInPoly, distToSeg, polyArea, perimeter,
  union, emptyBox, extendBox, BBox, mid,
} from '../../core/geom';
import { PlanCtx, Solid, Grip, PropDef, GROUPS, registerCommand, catDef } from '../../core/registry';
import { TypeEl, levelElev, materialOf, materialOptions, View, isPlanLike } from '../../core/view';
import { cached, hostedBy } from '../../core/cache';
import { prism, catPen, cutFill } from '../../views/sectionEngine';
import { fmtLen, fmtNum, parseLen } from '../../core/units';
import { Wall, wallInfo, wallShape } from '../../elements/wall';
import { orientRings, footprintOf, cleanMulti, cleanRing } from './roofGeom';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { h } from '../../ui/shell';
import { modal } from '../../ui/dialogs';

// ------------------------------------------------------------ Schichten
export interface Layer { mat: Id; t: number; fn: 'structure' | 'finish' | 'thermal' | 'substrate' | 'membrane' | 'air'; core?: boolean }
export interface LayeredType extends TypeEl { layers: Layer[]; description?: string; coarsePattern?: string; coarseColor?: string }

export const thickOf = (t: { layers?: Layer[] } | undefined, fb = 200): number => (t?.layers?.length ? t.layers.reduce((s, l) => s + l.t, 0) : fb);
export const coreLayer = (t: { layers?: Layer[] } | undefined): Layer | undefined => t?.layers?.find((l) => l.core) ?? t?.layers?.[0];

/** Schicht an Höhe z (Schichten von oben nach unten ab zTop) */
export function layerAt(layers: Layer[], zTop: number, z: number): Layer | undefined {
  let zt = zTop;
  for (const l of layers) { if (z <= zt && z >= zt - l.t) return l; zt -= l.t; }
  return layers[layers.length - 1];
}

const FN_LABELS: [Layer['fn'], string][] = [['structure', 'Tragende Schicht [1]'], ['substrate', 'Unterkonstruktion [2]'], ['thermal', 'Dämmung/Luftschicht [3]'], ['finish', 'Fertigteil [4]'], ['membrane', 'Abdichtung'], ['air', 'Luftschicht']];

/** Dialog "Struktur bearbeiten" für Geschossdecken, Dächer, Decken (Schichten von oben nach unten) */
export function editLayersDialog(type: LayeredType): void {
  const doc = app.doc;
  let layers: Layer[] = JSON.parse(JSON.stringify(type.layers ?? []));
  let sel = 0;
  const body = h('div', { style: 'min-width:560px' });
  const render = () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'form-row' }, h('label', {}, 'Typ:'), h('b', {}, type.name)),
      h('div', { class: 'form-row' }, h('label', {}, 'Gesamtdicke:'), h('b', {}, fmtLen(layers.reduce((s, l) => s + l.t, 0)))));
    const t = h('table', { class: 'grid' });
    t.append(h('tr', {}, h('th', {}, ''), h('th', {}, 'Funktion'), h('th', {}, 'Material'), h('th', { style: 'width:90px' }, 'Dicke'), h('th', { style: 'width:70px' }, 'Kern')));
    t.append(h('tr', {}, h('td', { colspan: '5', style: 'text-align:center;color:#666' }, '— OBERSEITE —')));
    layers.forEach((l, i) => {
      const fn = h('select', {}) as HTMLSelectElement; for (const [k, v] of FN_LABELS) fn.append(h('option', { value: k }, v)); fn.value = l.fn; fn.onchange = () => (l.fn = fn.value as Layer['fn']);
      const m = h('select', {}) as HTMLSelectElement; for (const [k, v] of materialOptions(doc)) m.append(h('option', { value: k }, v)); m.value = l.mat; m.onchange = () => (l.mat = m.value);
      const th = h('input', { type: 'text', value: fmtLen(l.t) }) as HTMLInputElement; th.onchange = () => { const v = parseLen(th.value); if (v !== null && v >= 0) l.t = v; render(); };
      const core = h('input', { type: 'checkbox' }) as HTMLInputElement; core.checked = !!l.core; core.onchange = () => (l.core = core.checked);
      const tr = h('tr', { class: i === sel ? 'sel' : '' }, h('td', {}, String(i + 1)), h('td', {}, fn), h('td', {}, m), h('td', {}, th), h('td', { style: 'text-align:center' }, core));
      tr.onclick = (e) => { if ((e.target as HTMLElement).tagName === 'TD') { sel = i; render(); } };
      t.append(tr);
    });
    t.append(h('tr', {}, h('td', { colspan: '5', style: 'text-align:center;color:#666' }, '— UNTERSEITE —')));
    body.append(t);
    const btn = (label: string, fn: () => void) => { const b = h('button', { class: 'btn small' }, label); b.onclick = () => { fn(); render(); }; return b; };
    body.append(h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
      btn('Einfügen', () => { layers.splice(sel, 0, { mat: layers[sel]?.mat ?? 'm_estrich', t: 10, fn: 'finish' }); }),
      btn('Löschen', () => { if (layers.length > 1) { layers.splice(sel, 1); sel = Math.max(0, sel - 1); } }),
      btn('Nach oben', () => { if (sel > 0) { [layers[sel - 1], layers[sel]] = [layers[sel], layers[sel - 1]]; sel--; } }),
      btn('Nach unten', () => { if (sel < layers.length - 1) { [layers[sel + 1], layers[sel]] = [layers[sel], layers[sel + 1]]; sel++; } }),
    ));
  };
  render();
  modal('Struktur bearbeiten', body, [
    { label: 'OK', primary: true, onClick: () => { doc.transaction('Struktur bearbeiten', () => doc.update(type.id, { layers })); } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 640);
}

/** Typeigenschaften für Schicht-Typen (Geschossdecke, Dach, Decke) */
export function layeredTypeProps(extra: PropDef[] = []): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'layers', label: 'Tragwerk', group: g.construction, type: 'button', get: () => 'Bearbeiten…', action: (t) => editLayersDialog(t as LayeredType) },
    { key: 'thick', label: 'Standarddicke', group: g.construction, type: 'readonly', get: (t) => fmtLen(thickOf(t as LayeredType)) },
    ...extra,
    { key: 'coarseColor', label: 'Füllfarbe grobe Darstellung', group: g.graphics, type: 'color', get: (t) => t.coarseColor ?? '#808080', set: (_t, v) => ({ coarseColor: v }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

// ------------------------------------------------------------ Umrisse (Skizzenschleifen)
/** Grundfläche aus Skizzenschleifen (verschachtelte Ringe: äußere/Löcher) */
export function loopsArea(loops: V2[][] | undefined): MultiPoly {
  if (!loops?.length) return [];
  const { rings } = orientRings(loops.filter((l) => l.length >= 3));
  return cleanMulti(footprintOf(rings.map(cleanRing)));
}
export const multiArea = (m: MultiPoly): number => m.reduce((s, p) => s + polyArea(p), 0);
export const multiPerimeter = (m: MultiPoly): number => m.reduce((s, p) => s + p.reduce((t, r) => t + perimeter(r), 0), 0);
export function multiBox(m: MultiPoly): BBox { const b = emptyBox(); for (const p of m) for (const r of p) for (const q of r) extendBox(b, q); return b; }

export const transformLoops = (loops: V2[][], m: Mat2): V2[][] => loops.map((r) => r.map((p) => apply(m, p)));
export const moveLoops = (loops: V2[][], d: V2): V2[][] => loops.map((r) => r.map((p) => ({ x: p.x + d.x, y: p.y + d.y })));

/** Vertikale Öffnungen (gehostete Schächte) mit ihrem Host mitbewegen – in der Transaktion aufrufen */
export function moveHostedCutouts(doc: Doc, hostId: Id, m: Mat2 | null, d?: V2): void {
  for (const h of hostedBy(doc, hostId)) {
    if (h.cat !== 'shaft' || !h.loops) continue;
    doc.update(h.id, { loops: m ? transformLoops(h.loops, m) : moveLoops(h.loops, d ?? { x: 0, y: 0 }) });
  }
}

/** Griffe an allen Eckpunkten der Skizze */
export function loopGrips(loops: V2[][] | undefined, view: View): Grip[] {
  if (!loops || !isPlanLike(view)) return [];
  const out: Grip[] = [];
  loops.forEach((r, k) => r.forEach((p, i) => out.push({ id: `v:${k}:${i}`, p, kind: 'end', tip: 'Eckpunkt verschieben' })));
  return out;
}
export function dragLoopGrip(loops: V2[][], id: string, p: V2): V2[][] | null {
  const m = id.match(/^v:(\d+):(\d+)$/); if (!m) return null;
  const k = +m[1], i = +m[2];
  return loops.map((r, kk) => (kk === k ? r.map((q, ii) => (ii === i ? p : q)) : r));
}
export function loopsCenter(loops: V2[][] | undefined): V2 | null {
  if (!loops?.length) return null;
  const b = emptyBox(); for (const r of loops) for (const p of r) extendBox(b, p);
  return mid(b.min, b.max);
}

// ------------------------------------------------------------ Schächte (Aussparungen in Platten)
export interface Shaft extends El { cat: 'shaft'; loops: V2[][]; levelId: Id; baseOffset: number; topLevelId: Id | null; topOffset: number; height: number; hostId?: Id }
export function shaftRange(doc: Doc, s: Shaft): [number, number] {
  const z0 = levelElev(doc, s.levelId) + (s.baseOffset ?? 0);
  const z1 = s.topLevelId && doc.get(s.topLevelId) ? levelElev(doc, s.topLevelId) + (s.topOffset ?? 0) : z0 + (s.height ?? 3000);
  return [z0, Math.max(z1, z0 + 1)];
}
export function shaftArea(doc: Doc, s: Shaft): MultiPoly { return cached(doc, 'archShaftArea', s.id, () => loopsArea(s.loops)); }
/** Aussparungen (Schächte, vertikale Öffnungen) für ein Element im Höhenbereich z0..z1 */
export function cutoutsFor(doc: Doc, hostId: Id, z0: number, z1: number): Poly[] {
  const out: Poly[] = [];
  for (const s of doc.all<Shaft>('shaft')) {
    if (s.hostId) { if (s.hostId !== hostId) continue; }
    else { const [a, b] = shaftRange(doc, s); if (!(a < z1 - 0.5 && b > z0 + 0.5)) continue; }
    out.push(...shaftArea(doc, s));
  }
  return out;
}

// ------------------------------------------------------------ Platten (Geschossdecke, Decke)
/** Körper je Schicht (von zTop nach unten) */
export function layerSolids(area: MultiPoly, zTop: number, layers: Layer[], fallbackMat?: Id): Solid[] {
  const out: Solid[] = [];
  const ls = layers.length ? layers : [{ mat: fallbackMat ?? 'm_beton', t: 200, fn: 'structure' as const }];
  let z = zTop;
  for (const l of ls) {
    if (l.t >= 0.5) {
      const faces = area.flatMap((p) => prism(p[0], z - l.t, z, p.slice(1)));
      if (faces.length) out.push({ faces, mat: l.mat });
    }
    z -= l.t;
  }
  return out;
}

/** Vereinigte Grundrissumrisse der in der Ansicht geschnittenen Wände (zum Ausblenden verdeckter Kanten) */
export function cutWallMask(ctx: PlanCtx): MultiPoly {
  if (ctx.view.hiddenCats?.includes('wall')) return [];
  return cached(ctx.doc, 'archWallMask', ctx.view.id + ':' + Math.round(ctx.cutZ), () => {
    const rings: Poly[] = [];
    for (const w of ctx.doc.all<Wall>('wall')) {
      const wi = wallInfo(ctx.doc, w);
      if (wi.L < 1 || !(wi.z0 <= ctx.cutZ && wi.z1 > ctx.cutZ)) continue;
      rings.push([wallShape(ctx.doc, w).ring]);
    }
    return rings.length ? union(rings) : [];
  });
}

/** Teilstücke eines Segments außerhalb einer Maske */
export function segOutside(a: V2, b: V2, mask: MultiPoly): [V2, V2][] {
  if (!mask.length) return [[a, b]];
  const ts = [0, 1];
  for (const p of mask) for (const r of p) for (let i = 0; i < r.length; i++) {
    const x = lineLine(a, b, r[i], r[(i + 1) % r.length]);
    if (x && x.t > 0 && x.t < 1 && x.u >= -1e-9 && x.u <= 1 + 1e-9) ts.push(x.t);
  }
  ts.sort((m, n) => m - n);
  const out: [V2, V2][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-6) continue;
    const m = lerp(a, b, (ts[i] + ts[i + 1]) / 2);
    let hidden = mask.some((p) => pointInPoly(m, p));
    if (!hidden) for (const p of mask) { for (const r of p) { for (let j = 0; j < r.length; j++) if (distToSeg(m, r[j], r[(j + 1) % r.length]) < 0.5) { hidden = true; break; } if (hidden) break; } if (hidden) break; }
    if (hidden) continue;
    const pa = lerp(a, b, ts[i]), pb = lerp(a, b, ts[i + 1]);
    const last = out[out.length - 1];
    if (last && Math.abs(last[1].x - pa.x) < 1e-6 && Math.abs(last[1].y - pa.y) < 1e-6) last[1] = pb; else out.push([pa, pb]);
  }
  return out;
}

/** Umrisslinien einer Fläche (ohne Teile unter geschnittenen Wänden) */
export function drawOutline(ctx: PlanCtx, area: MultiPoly, pen: Pen, extra: { sub?: string; sel?: boolean } = {}): void {
  const mask = cutWallMask(ctx);
  for (const p of area) for (const r of p) for (let i = 0; i < r.length; i++) {
    for (const [s, t] of segOutside(r[i], r[(i + 1) % r.length], mask)) ctx.dl.line(s, t, pen, extra);
  }
}

/**
 * Platte im Grundriss: Schnittfläche, wenn die Schnittebene die Platte trifft, sonst Kanten in
 * Projektion (Draufsicht) bzw. Untersicht im Deckenplan.
 */
export function drawSlabPlan(ctx: PlanCtx, cat: string, area: MultiPoly, zTop: number, layers: Layer[], coarseColor?: string): 'cut' | 'proj' | null {
  if (!area.length) return null;
  const T = layers.reduce((s, l) => s + l.t, 0) || 200;
  const zBot = zTop - T;
  const { dl, doc } = ctx;
  if (zBot < ctx.cutZ && zTop > ctx.cutZ) {
    const lay = layerAt(layers, zTop, ctx.cutZ);
    const m = materialOf(doc, lay?.mat);
    const fill = ctx.detail === 'coarse' && coarseColor ? { color: '#ffffff', pattern: 'solid', patColor: coarseColor } : cutFill(m?.cutPattern, m?.cutColor, ctx.detail);
    for (const p of area) dl.fill(p, fill, catPen(doc, cat, true));
    return 'cut';
  }
  const visible = ctx.ceiling ? zBot >= ctx.cutZ - 1 && zBot <= ctx.topZ + 1 : zTop <= ctx.cutZ + 1 && zTop >= ctx.depthZ - 1;
  if (!visible) return null;
  drawOutline(ctx, area, catPen(doc, cat, false));
  return 'proj';
}

// ------------------------------------------------------------ Eigenschaften
export const fmtM2 = (mm2: number) => fmtNum(mm2 / 1e6, 2) + ' m²';
export const fmtM3 = (mm3: number) => fmtNum(mm3 / 1e9, 3) + ' m³';
export const identityProps = (): PropDef[] => [
  { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  { key: 'mark', label: 'Kennzeichen', group: GROUPS.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
];
export const levelName = (doc: Doc, id: Id | undefined | null): string => (id ? doc.get(id)?.name ?? '' : '');
export const matColor = (doc: Doc, id: Id | undefined, fb = '#c8c8c8'): string => materialOf(doc, id)?.color ?? fb;

// ------------------------------------------------------------ "Begrenzung bearbeiten" (gemeinsamer Befehl)
const sketchEditors = new Map<string, (el: El) => void>();
export function registerSketchEditor(cat: string, fn: (el: El) => void): void { sketchEditors.set(cat, fn); }
export function editSketchOf(el: El | undefined): boolean {
  const fn = el && sketchEditors.get(el.cat);
  if (!fn || !el) return false;
  fn(el);
  return true;
}
const firstEditable = (): El | undefined => app.selected().find((e) => sketchEditors.has(e.cat));
registerCommand({
  id: 'floorEditBoundary', label: 'Begrenzung bearbeiten', icon: 'editsketch', tip: 'Skizze (Umriss) des gewählten Elements bearbeiten',
  enabled: () => !!firstEditable(), run: () => { if (!editSketchOf(firstEditable())) app.status('Bitte eine Geschossdecke, Decke, ein Dach oder einen Schacht wählen.'); },
});

export function catLabel(cat: string): string { return catDef(cat)?.label ?? cat; }
