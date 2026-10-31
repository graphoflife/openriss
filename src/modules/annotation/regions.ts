// Füllbereiche (inkl. Maskierungsbereich) und Revisionswolken – beide über den Skizzenmodus.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, perp, norm, dist, mid, angleOf, apply, polyArea, ensureCCW, ensureCW, signedArea } from '../../core/geom';
import { registerCategory, PropDef, GROUPS, Grip } from '../../core/registry';
import type { View } from '../../core/view';
import { DisplayList } from '../../render/displayList';
import { patternOptions } from '../../render/styles';
import type { Pen, Fill } from '../../render/styles';
import { fmtArea } from '../../core/units';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import type { OptionItem } from '../../tools/tool';
import { linePen, lineStyleOptions } from '../../elements/datums';
import { startTool } from '../../ui/commands';
import { ANNO_KINDS, myPlacement, ensureTypes, solid } from './common';

export interface Region extends El { cat: 'region'; viewId: Id; loops: V2[][]; lineStyle?: string }
export interface Cloud extends El { cat: 'cloud'; viewId: Id; loops: V2[][]; arcLen?: number; inward?: boolean; color?: string; rev?: string; date?: string }

const mapLoops = (loops: V2[][], m: any) => loops.map((r) => r.map((p) => apply(m, p)));

function loopGrips(loops: V2[][]): Grip[] {
  const g: Grip[] = [];
  loops.forEach((r, li) => r.forEach((p, vi) => g.push({ id: `v${li}_${vi}`, p, kind: 'end', tip: 'Eckpunkt verschieben' })));
  return g;
}
function dragVertex(loops: V2[][], id: string, p: V2): V2[][] | undefined {
  const m = id.match(/^v(\d+)_(\d+)$/); if (!m) return;
  const li = +m[1], vi = +m[2];
  return loops.map((r, i) => (i === li ? r.map((q, j) => (j === vi ? p : q)) : r));
}
function loopsCenter(loops: V2[][]): V2 | null {
  const r = loops[0]; if (!r?.length) return null;
  let x = 0, y = 0; for (const p of r) { x += p.x; y += p.y; } return { x: x / r.length, y: y / r.length };
}

// ------------------------------------------------------------ Füllbereich
function drawRegion(dl: DisplayList, el: Region, doc: Doc): void {
  if (!el.loops?.length) return;
  const t: any = doc.get(el.typeId) ?? {};
  const pattern: string = t.pattern ?? '';
  const patColor: string = t.patColor || '#000000';
  const bg: string = t.masking ? '#ffffff' : t.bg || '';
  const fill: Fill = pattern === 'solid' ? solid(patColor) : { color: bg || 'transparent', pattern: pattern || undefined, patColor };
  dl.fill(el.loops, fill, undefined, { sub: 'region' });
  const style = el.lineStyle ?? (t.masking ? 'invisible' : 'thin');
  const pen: Pen = linePen(doc, style);
  const invisible = style === 'invisible';
  for (const r of el.loops) for (let i = 0; i < r.length; i++) dl.line(r[i], r[(i + 1) % r.length], pen, { sub: 'edge', sel: invisible || undefined });
}

registerCategory({
  cat: 'region', label: 'Füllbereich', plural: 'Füllbereiche', annotation: true, hasTypes: true, planOrder: 2,
  drawAnnotation: (dl, el, doc) => drawRegion(dl, el as Region, doc),
  grips: (el) => loopGrips(el.loops ?? []),
  dragGrip: (el, id, p) => { const l = dragVertex(el.loops ?? [], id, p); return l ? { loops: l } : undefined; },
  transform: (el, m) => ({ loops: mapLoops(el.loops ?? [], m) }),
  center: (el) => loopsCenter(el.loops ?? []),
  props: () => [
    { key: 'lineStyle', label: 'Begrenzungslinienstil', group: GROUPS.graphics, type: 'select', options: lineStyleOptions, get: (e, doc) => e.lineStyle ?? (doc.get(e.typeId)?.masking ? 'invisible' : 'thin'), set: (_e, v) => ({ lineStyle: v }) },
    { key: 'area', label: 'Fläche', group: GROUPS.dims, type: 'readonly', get: (e) => (e.loops?.length ? fmtArea(Math.abs(polyArea(e.loops))) : '') },
    { key: 'edit', label: 'Begrenzung', group: GROUPS.graphics, type: 'button', get: () => 'Bearbeiten…', action: (e) => { if (e.id) editSketch(e); } },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ],
  typeProps: () => regionTypeProps(),
});

function regionTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'pattern', label: 'Füllmuster Vordergrund', group: g.graphics, type: 'select', options: patternOptions, get: (t) => t.pattern ?? '', set: (_t, v) => ({ pattern: v }) },
    { key: 'patColor', label: 'Farbe Vordergrundmuster', group: g.graphics, type: 'color', get: (t) => t.patColor ?? '#000000', set: (_t, v) => ({ patColor: v }) },
    { key: 'bgOn', label: 'Hintergrund undurchsichtig', group: g.graphics, type: 'bool', get: (t) => !!t.bg, set: (t, v) => ({ bg: v ? (t.bgColor ?? '#ffffff') : '' }) },
    { key: 'bgColor', label: 'Hintergrundfarbe', group: g.graphics, type: 'color', get: (t) => t.bg || t.bgColor || '#ffffff', set: (t, v) => ({ bgColor: v, bg: t.bg ? v : '' }) },
    { key: 'masking', label: 'Maskierung (verdeckt darunterliegende Elemente)', group: g.graphics, type: 'bool', get: (t) => !!t.masking, set: (_t, v) => ({ masking: v }) },
  ];
}

// ------------------------------------------------------------ Revisionswolke
function drawCloud(dl: DisplayList, el: Cloud): void {
  const s = dl.scale; const chord = Math.max(1, (el.arcLen ?? 6) * s);
  const pen: Pen = { w: 3, color: el.color || '#d01010' };
  const sweep = (140 * Math.PI) / 180;
  for (const r0 of el.loops ?? []) {
    if (r0.length < 2) continue;
    const r = el.inward ? ensureCW(r0) : ensureCCW(r0);
    for (let i = 0; i < r.length; i++) {
      const P = r[i], Q = r[(i + 1) % r.length]; const L = dist(P, Q); if (L < 1e-6) continue;
      const n = Math.max(1, Math.round(L / chord)); const d = norm(sub(Q, P)); const nl = perp(d);
      for (let k = 0; k < n; k++) {
        const A = add(P, mul(d, (L * k) / n)), B = add(P, mul(d, (L * (k + 1)) / n));
        const c = L / n; const rad = c / 2 / Math.sin(sweep / 2); const hgt = rad * Math.cos(sweep / 2);
        const C = add(mid(A, B), mul(nl, hgt));
        dl.arc(C, rad, angleOf(sub(A, C)), angleOf(sub(B, C)), pen, { sub: 'cloud' });
      }
    }
  }
}

registerCategory({
  cat: 'cloud', label: 'Revisionswolke', plural: 'Revisionswolken', annotation: true, planOrder: 85,
  drawAnnotation: (dl, el) => drawCloud(dl, el as Cloud),
  grips: (el) => loopGrips(el.loops ?? []),
  dragGrip: (el, id, p) => { const l = dragVertex(el.loops ?? [], id, p); return l ? { loops: l } : undefined; },
  transform: (el, m) => ({ loops: mapLoops(el.loops ?? [], m) }),
  center: (el) => loopsCenter(el.loops ?? []),
  props: () => [
    { key: 'rev', label: 'Revision', group: GROUPS.identity, type: 'text', get: (e) => e.rev ?? '', set: (_e, v) => ({ rev: v }) },
    { key: 'date', label: 'Revisionsdatum', group: GROUPS.identity, type: 'text', get: (e) => e.date ?? '', set: (_e, v) => ({ date: v }) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'arcLen', label: 'Bogenlänge (Papier-mm)', group: GROUPS.graphics, type: 'number', get: (e) => e.arcLen ?? 6, set: (_e, v) => ({ arcLen: Math.max(1, v) }) },
    { key: 'inward', label: 'Bögen nach innen', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.inward, set: (_e, v) => ({ inward: v || undefined }) },
    { key: 'color', label: 'Farbe', group: GROUPS.graphics, type: 'color', get: (e) => e.color ?? '#d01010', set: (_e, v) => ({ color: v }) },
    { key: 'edit', label: 'Skizze', group: GROUPS.graphics, type: 'button', get: () => 'Bearbeiten…', action: (e) => { if (e.id) editSketch(e); } },
  ],
});

// ------------------------------------------------------------ Werkzeuge (Skizzenmodus)
function sketchKinds(view?: View | null): string[] { return view ? [view.kind] : ANNO_KINDS; }

export function startRegionTool(): void {
  ensureTypes('region');
  let viewId: Id = '';
  const pl = myPlacement('filledRegion', 'region', 'rgt_beton', { lineStyle: 'thin' });
  const extra = (): OptionItem[] => [
    { kind: 'select', key: 'ls', label: 'Linienstil', value: pl.proto.lineStyle ?? 'thin', options: lineStyleOptions(app.doc), onChange: (v) => { pl.proto.lineStyle = v; app.emit('tool'); } },
  ];
  const t = new SketchTool('Füllbereich', (loops) => {
    if (!viewId) return;
    const el: Region = { id: newId('rg'), cat: 'region', viewId, typeId: pl.proto.typeId, loops: normalizeLoops(loops) } as Region;
    const masking = !!app.doc.get(pl.proto.typeId)?.masking;
    el.lineStyle = masking && (pl.proto.lineStyle ?? 'thin') === 'thin' ? 'invisible' : pl.proto.lineStyle ?? 'thin';
    app.doc.transaction('Füllbereich erstellen', () => app.doc.add(el));
    app.select([el.id]);
  }, { kinds: ANNO_KINDS, extra });
  t.id = 'filledRegion';
  t.placement = pl;
  viewId = app.activeView()?.id ?? '';
  startTool(t, 'filledRegion');
}

export function startCloudTool(): void {
  let viewId: Id = '';
  const t = new SketchTool('Revisionswolke', (loops) => {
    if (!viewId) return;
    const el: Cloud = { id: newId('rc'), cat: 'cloud', viewId, loops } as Cloud;
    app.doc.transaction('Revisionswolke erstellen', () => app.doc.add(el));
    app.select([el.id]);
  }, { kinds: ANNO_KINDS, open: false });
  t.id = 'revisionCloud';
  viewId = app.activeView()?.id ?? '';
  startTool(t, 'revisionCloud');
}

/** Außenring gegen, Löcher im Uhrzeigersinn */
function normalizeLoops(loops: V2[][]): V2[][] {
  return loops.map((r, i) => (i === 0 ? ensureCCW(r) : ensureCW(r))).filter((r) => Math.abs(signedArea(r)) > 1);
}

/** Begrenzung eines Füllbereichs / einer Revisionswolke bearbeiten */
export function editSketch(el0: El): void {
  const doc = app.doc; const el = doc.get(el0.id); if (!el?.loops) return;
  const view = app.activeView();
  if (!view || view.id !== el.viewId) { if (el.viewId && doc.get(el.viewId)) app.openView(el.viewId); }
  const t = new SketchTool(el.cat === 'cloud' ? 'Revisionswolke bearbeiten' : 'Begrenzung bearbeiten', (loops) => {
    if (!doc.get(el.id)) return;
    doc.transaction('Skizze bearbeiten', () => doc.update(el.id, { loops: el.cat === 'region' ? normalizeLoops(loops) : loops }));
    app.select([el.id]);
  }, { initial: loopsToSegs(el.loops), kinds: sketchKinds(app.activeView()) });
  t.id = el.cat === 'cloud' ? 'revisionCloud' : 'filledRegion';
  app.select([]);
  startTool(t, t.id);
}

export { perp };
