// Detailwerkzeuge: Dämmung (Schlaufen/Zickzack), Detailbauteile (Bruchlinie, Abdichtung, Holzlatte)
// und Symbole (Nordpfeil, Gefällepfeil).
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, norm, perp, dist, mid, fromAngle, angleOf, apply, applyVec, isMirror, matAngle, sideDist, deg, rad, clamp } from '../../core/geom';
import { registerCategory, PropDef, GROUPS, Grip } from '../../core/registry';
import type { View } from '../../core/view';
import { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtNum, fmtLen } from '../../core/units';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool } from '../../tools/drawTool';
import { ANNO_KINDS, myPlacement, previewEl, solid, rectPts, readable, drawTick } from './common';

const snapAngle = (a: number): number => { const d = deg(a); const r = Math.round(d / 15) * 15; return rad(Math.abs(d - r) < 3 ? r : Math.round(d)); };

// ------------------------------------------------------------ Dämmung
export interface Insul extends El { cat: 'insulation'; viewId: Id; a: V2; b: V2; width: number; style?: 'loops' | 'zigzag'; ratio?: number; bounds?: boolean }

export function insulPts(el: Insul): V2[] {
  const L = dist(el.a, el.b); if (L < 1) return [];
  const d = norm(sub(el.b, el.a)); const n = perp(d); const W = Math.max(1, el.width ?? 100); const half = W / 2;
  const ratio = el.ratio ?? 1;
  const P = (x: number, y: number) => add(el.a, add(mul(d, clamp(x, 0, L)), mul(n, y)));
  const pts: V2[] = [];
  if (el.style === 'zigzag') {
    const cnt = Math.max(1, Math.round(L / (W * 0.5 * ratio))); const st = L / cnt;
    for (let i = 0; i <= cnt; i++) pts.push(P(i * st, i % 2 ? half : -half));
    return pts;
  }
  // Schlaufen: Schleifen an beiden Begrenzungen (x = vθ − A/2·sin 2θ, y = −W/2·cos θ)
  const turns = Math.max(1, Math.round(L / (W * 0.6 * ratio)));
  const v = L / (2 * Math.PI * turns); const A = 2.2 * v; const N = turns * 36;
  for (let i = 0; i <= N; i++) {
    const t = (2 * Math.PI * turns * i) / N;
    pts.push(P(v * t - (A / 2) * Math.sin(2 * t), -half * Math.cos(t)));
  }
  return pts;
}

function drawInsul(dl: DisplayList, el: Insul): void {
  const pen: Pen = { w: 1 };
  dl.poly(insulPts(el), pen, false, { ns: true });
  const d = norm(sub(el.b, el.a)); const n = mul(perp(d), (el.width ?? 100) / 2);
  // Achse unsichtbar (Fang, Treffer) und optional Begrenzungslinien
  dl.line(el.a, el.b, pen, { inv: true, sub: 'line' });
  if (el.bounds) { dl.line(add(el.a, n), add(el.b, n), pen, { sub: 'edge' }); dl.line(sub(el.a, n), sub(el.b, n), pen, { sub: 'edge' }); }
}

registerCategory({
  cat: 'insulation', label: 'Dämmung', plural: 'Dämmungen', annotation: true, planOrder: 4,
  drawAnnotation: (dl, el) => drawInsul(dl, el as Insul),
  grips: (el) => {
    const i = el as Insul; const m = mid(i.a, i.b); const n = perp(norm(sub(i.b, i.a)));
    return [{ id: 'a', p: i.a, kind: 'end' }, { id: 'b', p: i.b, kind: 'end' }, { id: 'w', p: add(m, mul(n, (i.width ?? 100) / 2)), kind: 'arrow', dir: n, tip: 'Dämmungsbreite' }];
  },
  dragGrip: (el, id, p) => {
    if (id === 'a') return { a: p };
    if (id === 'b') return { b: p };
    if (id === 'w') return { width: Math.max(5, Math.round(2 * Math.abs(sideDist(p, el.a, el.b)))) };
  },
  transform: (el, m) => ({ a: apply(m, el.a), b: apply(m, el.b) }),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: () => [
    { key: 'width', label: 'Breite', group: GROUPS.dims, type: 'length', get: (e) => e.width ?? 100, set: (_e, v) => (v > 0 ? { width: v } : undefined) },
    { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e) => (e.a && e.b ? fmtLen(dist(e.a, e.b)) : '') },
    { key: 'style', label: 'Darstellung', group: GROUPS.graphics, type: 'select', options: [['loops', 'Schlaufen (weiche Dämmung)'], ['zigzag', 'Zickzack (Hartschaum)']], get: (e) => e.style ?? 'loops', set: (_e, v) => ({ style: v }) },
    { key: 'ratio', label: 'Teilungsverhältnis', group: GROUPS.graphics, type: 'number', get: (e) => e.ratio ?? 1, set: (_e, v) => ({ ratio: clamp(v, 0.2, 5) }) },
    { key: 'bounds', label: 'Begrenzungslinien', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.bounds, set: (_e, v) => ({ bounds: v || undefined }) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ],
});

export class InsulationTool extends LineDrawTool {
  id = 'insulation'; label = 'Dämmung';
  kinds = ANNO_KINDS;
  modes: any = ['line', 'pick'];
  static width = 100;
  static style: 'loops' | 'zigzag' = 'loops';
  extraOptions(): OptionItem[] {
    return [
      { kind: 'length', key: 'w', label: 'Breite', value: InsulationTool.width, width: 60, onChange: (v) => { if (v > 0) InsulationTool.width = v; } },
      { kind: 'select', key: 'st', label: 'Darstellung', value: InsulationTool.style, options: [['loops', 'Schlaufen'], ['zigzag', 'Zickzack']], onChange: (v) => { InsulationTool.style = v as any; } },
    ];
  }
  private viewId: Id = '';
  prompt(): string { return this.mode === 'pick' ? 'Linie wählen (Mittellinie der Dämmung).' : !this.start ? 'Startpunkt der Dämmung (Mittellinie).' : 'Endpunkt der Dämmung. Zahl eingeben für exakte Länge.'; }
  move(e: ToolEvent): void { this.viewId = e.view.id; super.move(e); }
  down(e: ToolEvent): void { this.viewId = e.view.id; super.down(e); }
  private make(a: V2, b: V2): Insul {
    const el: Insul = { id: newId('in'), cat: 'insulation', viewId: this.viewId || app.activeView()?.id || '', a, b, width: InsulationTool.width } as Insul;
    if (InsulationTool.style !== 'loops') el.style = InsulationTool.style;
    return el;
  }
  createSegment(a: V2, b: V2): void { app.doc.add(this.make(a, b)); }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void { const v = app.doc.get<View>(this.viewId) ?? app.activeView(); if (v) previewEl(dl, this.make(a, b), v); }
}

// ------------------------------------------------------------ Detailbauteile
export interface DetailEl extends El { cat: 'detail'; viewId: Id; p: V2; rot?: number; len?: number; flip?: boolean; mask?: number }

const detailKind = (doc: Doc, el: El): string => doc.get(el.typeId)?.kind ?? 'batten';
const isLinear = (k: string) => k === 'break' || k === 'seal';

function drawDetail(dl: DisplayList, el: DetailEl, doc: Doc): void {
  const t: any = doc.get(el.typeId) ?? {}; const k = detailKind(doc, el); const s = dl.scale;
  const ex = fromAngle(el.rot ?? 0); const ey = perp(ex);
  const P = (x: number, y: number) => add(el.p, add(mul(ex, x), mul(ey, y)));
  if (k === 'break') {
    const L = el.len ?? 1000; const z = (t.zig ?? 3) * s; const m = L / 2;
    const mask = el.mask ?? t.mask ?? 0;
    if (mask > 0) { const sd = el.flip ? -1 : 1; dl.fill([[P(0, 0), P(L, 0), P(L, sd * mask), P(0, sd * mask)]], solid('#ffffff'), undefined, { ns: true }); }
    dl.poly([P(0, 0), P(m - z * 0.45, 0), P(m - z * 0.15, z), P(m + z * 0.15, -z), P(m + z * 0.45, 0), P(L, 0)], { w: 1 }, false, { sub: 'line' });
  } else if (k === 'seal') {
    const L = el.len ?? 1000; const th = Math.max(t.thick ?? 5, 0.5 * s);
    dl.fill([[P(0, -th / 2), P(L, -th / 2), P(L, th / 2), P(0, th / 2)]], solid('#000000'), { w: 1 }, { sub: 'line' });
  } else {
    const w = t.width ?? 40, hgt = t.height ?? 60;
    const r = rectPts(el.p, ex, ey, -w / 2, -hgt / 2, w / 2, hgt / 2);
    dl.fill([r], { color: '#ffffff' }, { w: 2 });
    dl.line(r[0], r[2], { w: 1 }, { ns: true }); dl.line(r[1], r[3], { w: 1 }, { ns: true });
  }
}

registerCategory({
  cat: 'detail', label: 'Detailbauteil', plural: 'Detailbauteile', annotation: true, hasTypes: true, planOrder: 3,
  drawAnnotation: (dl, el, doc) => drawDetail(dl, el as DetailEl, doc),
  grips: (el, doc) => {
    const d = el as DetailEl;
    if (!isLinear(detailKind(doc, d))) return [{ id: 'c', p: d.p, kind: 'end', tip: 'Einfügepunkt' }];
    return [{ id: 's', p: d.p, kind: 'end' }, { id: 'e', p: add(d.p, fromAngle(d.rot ?? 0, d.len ?? 1000)), kind: 'end' }];
  },
  dragGrip: (el, id, p) => {
    const d = el as DetailEl;
    if (id === 'c') return { p };
    const E = add(d.p, fromAngle(d.rot ?? 0, d.len ?? 1000));
    if (id === 's') return { p, rot: angleOf(sub(E, p)), len: Math.max(1, dist(E, p)) };
    if (id === 'e') return { rot: angleOf(sub(p, d.p)), len: Math.max(1, dist(p, d.p)) };
  },
  clickGrip: () => undefined,
  transform: (el, m, doc) => {
    const d = el as DetailEl;
    if (isLinear(detailKind(doc, d))) {
      const a = apply(m, d.p), b = apply(m, add(d.p, fromAngle(d.rot ?? 0, d.len ?? 1000)));
      return { p: a, rot: angleOf(sub(b, a)), len: dist(a, b), flip: isMirror(m) ? !d.flip : d.flip };
    }
    return { p: apply(m, d.p), rot: angleOf(applyVec(m, fromAngle(d.rot ?? 0))) };
  },
  curve: (el, doc) => (isLinear(detailKind(doc, el)) ? { a: el.p, b: add(el.p, fromAngle(el.rot ?? 0, el.len ?? 1000)) } : null),
  center: (el, doc) => (isLinear(detailKind(doc, el)) ? add(el.p, fromAngle(el.rot ?? 0, (el.len ?? 1000) / 2)) : el.p),
  props: () => [
    { key: 'rot', label: 'Drehung', group: GROUPS.graphics, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) },
    { key: 'len', label: 'Länge', group: GROUPS.dims, type: 'length', get: (e) => e.len ?? 0, set: (_e, v) => (v > 0 ? { len: v } : undefined) },
    { key: 'mask', label: 'Maskierungstiefe (Bruchlinie)', group: GROUPS.graphics, type: 'length', get: (e, doc) => e.mask ?? doc.get(e.typeId)?.mask ?? 0, set: (_e, v) => ({ mask: Math.max(0, v) }) },
    { key: 'flip', label: 'Spiegeln (Maskierungsseite)', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.flip, set: (_e, v) => ({ flip: v || undefined }) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ],
  typeProps: () => detailTypeProps(),
});

function detailTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'kind', label: 'Bauteil', group: g.construction, type: 'select', options: [['break', 'Bruchlinie'], ['seal', 'Abdichtung'], ['batten', 'Holzlatte / Kantholz (Schnitt)']], get: (t) => t.kind ?? 'batten', set: (_t, v) => ({ kind: v }) },
    { key: 'width', label: 'Breite (Holz)', group: g.dims, type: 'length', get: (t) => t.width ?? 40, set: (_t, v) => (v > 0 ? { width: v } : undefined) },
    { key: 'height', label: 'Höhe (Holz)', group: g.dims, type: 'length', get: (t) => t.height ?? 60, set: (_t, v) => (v > 0 ? { height: v } : undefined) },
    { key: 'thick', label: 'Dicke (Abdichtung)', group: g.dims, type: 'length', get: (t) => t.thick ?? 5, set: (_t, v) => (v > 0 ? { thick: v } : undefined) },
    { key: 'zig', label: 'Zackengröße Bruchlinie (Papier-mm)', group: g.graphics, type: 'number', get: (t) => t.zig ?? 3, set: (_t, v) => ({ zig: Math.max(0.5, v) }) },
    { key: 'mask', label: 'Maskierungstiefe (Bruchlinie)', group: g.graphics, type: 'length', get: (t) => t.mask ?? 0, set: (_t, v) => ({ mask: Math.max(0, v) }) },
  ];
}

export class DetailTool extends Tool {
  id = 'detailComponent'; label = 'Detailbauteil'; kinds = ANNO_KINDS;
  private start: V2 | null = null; private cur: V2 | null = null; private rot = 0;
  activate(): void { this.placement = myPlacement('detailComponent', 'detail', 'dct_break'); }
  private kind(): string { return app.doc.get(this.placement?.proto.typeId)?.kind ?? 'batten'; }
  prompt(): string {
    if (isLinear(this.kind())) return this.start ? 'Endpunkt klicken (Zahl für exakte Länge).' : 'Startpunkt klicken.';
    return 'Klicken Sie, um das Bauteil zu platzieren. Leertaste dreht um 90°.';
  }
  basePoint(): V2 | null { return this.start; }
  space(): boolean { this.rot += Math.PI / 2; app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  private make(a: V2, b: V2 | null, view: View): DetailEl {
    const el: DetailEl = { id: newId('dc'), cat: 'detail', viewId: view.id, typeId: this.placement!.proto.typeId, p: a, rot: this.rot } as DetailEl;
    if (b) { el.rot = angleOf(sub(b, a)); el.len = Math.max(1, dist(a, b)); }
    return el;
  }
  private commit(el: DetailEl): void { app.doc.transaction(this.label, () => app.doc.add(el)); }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (isLinear(this.kind())) {
      if (!this.start) { this.start = e.p; return; }
      if (dist(this.start, e.p) > 1) this.commit(this.make(this.start, e.p, e.view));
      this.start = null; return;
    }
    this.commit(this.make(e.p, null, e.view));
  }
  typedLength(L: number): void {
    const v = app.activeView();
    if (!this.start || !this.cur || !v || dist(this.start, this.cur) < 1e-6) return;
    this.commit(this.make(this.start, add(this.start, mul(norm(sub(this.cur, this.start)), L)), v)); this.start = null;
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const view: View = vp.view;
    if (isLinear(this.kind())) { if (this.start && dist(this.start, this.cur) > 1) previewEl(dl, this.make(this.start, this.cur, view), view); return; }
    previewEl(dl, this.make(this.cur, null, view), view);
  }
}

// ------------------------------------------------------------ Symbole
export interface SymEl extends El { cat: 'symbol'; viewId: Id; kind: 'north' | 'slope'; p: V2; rot?: number; size?: number; b?: V2; slope?: number; label?: string }

function slopeText(el: SymEl): string { return el.label || fmtNum(el.slope ?? 2, 1) + ' %'; }

function drawSymbol(dl: DisplayList, el: SymEl): void {
  const s = dl.scale; const pen: Pen = { w: 2 };
  if (el.kind === 'slope') {
    const b = el.b ?? add(el.p, { x: 15 * s, y: 0 }); const d = sub(b, el.p); if (Math.hypot(d.x, d.y) < 1e-6) return;
    dl.line(el.p, b, { w: 2 }, { sub: 'line' });
    drawTick(dl, b, d, 'arrow', 3, { w: 2 });
    const td = readable(d);
    dl.text(add(mid(el.p, b), mul(td.up, 0.8 * s)), slopeText(el), { size: 2.5, rot: td.ang, ha: 'center', va: 'bottom' });
    return;
  }
  const R = ((el.size ?? 12) * s) / 2; const rot = el.rot ?? 0;
  const up = fromAngle(rot + Math.PI / 2); const ex = fromAngle(rot);
  const Q = (x: number, y: number) => add(el.p, add(mul(ex, x * R), mul(up, y * R)));
  dl.circle(el.p, R, { w: 1 }, { color: '#ffffff' });
  const tip = Q(0, 1.25), base = Q(0, -0.55);
  dl.fill([[tip, Q(-0.5, -0.85), base]], solid('#000000'), pen, { ns: true });
  dl.fill([[tip, base, Q(0.5, -0.85)]], { color: '#ffffff' }, pen, { ns: true });
  dl.text(add(tip, mul(up, 1.2 * s)), 'N', { size: Math.max(2.5, (el.size ?? 12) * 0.3), rot, ha: 'center', va: 'bottom', bold: true });
}

registerCategory({
  cat: 'symbol', label: 'Symbol', plural: 'Symbole', annotation: true, planOrder: 87,
  drawAnnotation: (dl, el) => drawSymbol(dl, el as SymEl),
  grips: (el, _doc, view) => {
    const sy = el as SymEl;
    if (sy.kind === 'slope') return [{ id: 'a', p: sy.p, kind: 'end' }, { id: 'b', p: sy.b ?? sy.p, kind: 'end' }];
    const R = ((sy.size ?? 12) * view.scale) / 2;
    return [{ id: 'r', p: add(sy.p, fromAngle((sy.rot ?? 0) + Math.PI / 2, R * 1.25)), kind: 'end', tip: 'Drehen (Nordrichtung)' }];
  },
  dragGrip: (el, id, p) => {
    if (id === 'a') return { p };
    if (id === 'b') return { b: p };
    if (id === 'r') return { rot: snapAngle(angleOf(sub(p, el.p)) - Math.PI / 2) };
  },
  transform: (el, m) => {
    const sy = el as SymEl;
    if (sy.kind === 'slope') return { p: apply(m, sy.p), b: sy.b ? apply(m, sy.b) : undefined };
    const up = applyVec(m, fromAngle((sy.rot ?? 0) + Math.PI / 2));
    return { p: apply(m, sy.p), rot: isMirror(m) || matAngle(m) ? angleOf(up) - Math.PI / 2 : sy.rot };
  },
  center: (el) => (el.kind === 'slope' && el.b ? mid(el.p, el.b) : el.p),
  props: (el) => (el.kind === 'slope' ? [
    { key: 'slope', label: 'Gefälle (%)', group: GROUPS.dims, type: 'number', get: (e) => e.slope ?? 2, set: (_e, v) => ({ slope: v }) },
    { key: 'label', label: 'Text (leer = Gefälle)', group: GROUPS.text, type: 'text', get: (e) => e.label ?? '', set: (_e, v) => ({ label: v || undefined }) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ] : [
    { key: 'size', label: 'Größe (Papier-mm)', group: GROUPS.graphics, type: 'number', get: (e) => e.size ?? 12, set: (_e, v) => ({ size: Math.max(2, v) }) },
    { key: 'rot', label: 'Drehung (Nordrichtung)', group: GROUPS.graphics, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ]),
});

export class SymbolTool extends Tool {
  id = 'symbol'; label = 'Symbol'; kinds = ANNO_KINDS;
  static kind: 'north' | 'slope' = 'north';
  static slope = 2;
  private start: V2 | null = null; private cur: V2 | null = null; private rot = 0;
  prompt(): string {
    if (SymbolTool.kind === 'slope') return this.start ? 'Endpunkt (Pfeilspitze, Richtung des Gefälles).' : 'Startpunkt des Gefällepfeils.';
    return 'Klicken Sie, um den Nordpfeil zu platzieren. Leertaste dreht um 45°.';
  }
  options(): OptionItem[] {
    const o: OptionItem[] = [{ kind: 'select', key: 'kind', label: 'Symbol', value: SymbolTool.kind, options: [['north', 'Nordpfeil'], ['slope', 'Gefällepfeil']], onChange: (v) => { SymbolTool.kind = v as any; this.start = null; app.emit('tool'); app.setPrompt(this.prompt()); } }];
    if (SymbolTool.kind === 'slope') o.push({ kind: 'number', key: 'slope', label: 'Gefälle (%)', value: SymbolTool.slope, width: 50, onChange: (v) => { SymbolTool.slope = v; } });
    return o;
  }
  basePoint(): V2 | null { return this.start; }
  space(): boolean { this.rot += Math.PI / 4; app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  private make(a: V2, b: V2 | null, view: View): SymEl {
    if (SymbolTool.kind === 'slope') return { id: newId('sy'), cat: 'symbol', viewId: view.id, kind: 'slope', p: a, b: b ?? a, slope: SymbolTool.slope } as SymEl;
    return { id: newId('sy'), cat: 'symbol', viewId: view.id, kind: 'north', p: a, rot: this.rot || undefined } as SymEl;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (SymbolTool.kind === 'slope') {
      if (!this.start) { this.start = e.p; return; }
      if (dist(this.start, e.p) > 1) { const el = this.make(this.start, e.p, e.view); app.doc.transaction('Gefällepfeil', () => app.doc.add(el)); }
      this.start = null; return;
    }
    const el = this.make(e.p, null, e.view);
    app.doc.transaction('Nordpfeil', () => app.doc.add(el));
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const view: View = vp.view;
    if (SymbolTool.kind === 'slope') { if (this.start && dist(this.start, this.cur) > 1) previewEl(dl, this.make(this.start, this.cur, view), view); return; }
    previewEl(dl, this.make(this.cur, null, view), view);
  }
}
