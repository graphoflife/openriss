// Grossformat-Pläne (lange Gebäude): abhängige Ansichten (Teilpläne, Revit «Abhängige Ansicht duplizieren»),
// «Ansicht teilen» in n Teile mit Überlappung und Anschlusslinien, Rahmen der Teilpläne mit Plannummern in der
// Übersicht und Schlüsselplan (Gebäudeumriss mit den Teilen, Teil dieses Plans schraffiert) auf Plänen.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, registerPanel, onHook, GROUPS, PropDef } from '../../core/registry';
import { View, isPlanLike, rootView, dependentsOf, cropBox, annoViewId } from '../../core/view';
import { DisplayList, textWidth } from '../../render/displayList';
import { V2, BBox, add, sub, mul, norm, perp, mid, apply, sideDist, emptyBox, extendBox, boxValid, boxOverlap, boxCorners, dist } from '../../core/geom';
import { buildViewDL, registerPlanOverlay } from '../../views/viewBuilder';
import { sheetRefOf } from '../../elements/datums';
import { readable } from '../annotation/common';
import { LineDrawTool } from '../../tools/drawTool';
import type { ToolEvent } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { registerIcon } from '../../ui/icons';
import { extendViewProps, isSheet, sheetSize } from './common';
import { revisionsOf, titleBlockOf } from './sheets';

const B = '#2a6fd6';
registerIcon('splitview', `<rect x="2" y="5" width="20" height="14" fill="#fff" stroke="currentColor"/><path d="M9 3 V21 M15 3 V21" stroke="${B}" stroke-width="1.6" stroke-dasharray="4 1.5 1 1.5"/>`);
registerIcon('dependent', `<rect x="2" y="3" width="13" height="11" fill="#fff" stroke="currentColor"/><rect x="9" y="10" width="13" height="11" fill="#dbe8f8" stroke="${B}"/>`);
registerIcon('matchline', `<path d="M12 2 V22" stroke="currentColor" stroke-width="2.4" stroke-dasharray="5 2 1 2"/><path d="M4 8 H9 M15 16 H20" stroke="${B}" stroke-width="1.5"/>`);
registerIcon('keyplan', `<rect x="2" y="6" width="20" height="12" fill="#fff" stroke="currentColor"/><rect x="2" y="6" width="7" height="12" fill="#b8c8e0" stroke="${B}"/><path d="M9 6 V18 M15 6 V18" stroke="currentColor"/>`);

// ------------------------------------------------------------ Abhängige Ansichten
/** Modellausdehnung eines Grundrisses (ohne Schnitt-/Ansichtssymbole, Raster, Ebenen) */
export function planModelBox(doc: Doc, view: View): BBox {
  const dl = buildViewDL(doc, { ...view, crop: null, underlayLevelId: null } as View, { noAnnotations: true, noCrop: true });
  const b = emptyBox();
  const skip = new Set(['view', 'grid', 'level', 'refplane']);
  dl.items.forEach((it, i) => {
    if (it.sel || it.inv || it.k === 'clip') return;
    const o = it.o ? doc.get(it.o) : undefined;
    if (o && skip.has(o.cat)) return;
    const bb = dl.boxOf(i); if (bb) { extendBox(b, bb.min); extendBox(b, bb.max); }
  });
  return b;
}
const inflate = (b: BBox, d: number): BBox => ({ min: { x: b.min.x - d, y: b.min.y - d }, max: { x: b.max.x + d, y: b.max.y + d } });
function uniqueName(doc: Doc, base: string): string {
  const names = new Set(doc.all<View>('view').map((v) => v.name));
  let n = base, i = 2; while (names.has(n)) n = `${base} (${i++})`;
  return n;
}

/** Abhängige Ansicht anlegen (eigene Transaktion): Zuschnitt crop (Standard: Zuschnitt bzw. Modellausdehnung der Primäransicht) */
export function addDependentView(doc: Doc, parentId: Id, o: { name?: string; crop?: BBox; marker?: string; show?: boolean } = {}): View {
  const p0 = doc.get<View>(parentId);
  if (!p0 || !isPlanLike(p0)) throw new Error('Abhängige Ansichten gibt es für Grundrisse und Deckenpläne: ' + parentId);
  const p = rootView(doc, p0);
  const n = dependentsOf(doc, p.id).length + 1;
  const box = o.crop ?? cropBox(p) ?? inflate(planModelBox(doc, p), 1000);
  const v: View = JSON.parse(JSON.stringify(p));
  v.id = newId('vw');
  v.name = uniqueName(doc, o.name ?? `${p.name} - Teil ${n}`);
  v.parentId = p.id; v.hostId = p.id; // Löschen der Primäransicht löscht die abhängigen Ansichten
  v.crop = { on: true, show: o.show ?? p.crop?.show ?? false, min: { ...box.min }, max: { ...box.max } };
  delete v.titleOnSheet; delete v.depFrames; delete v.pinned;
  v.data = { ...(p.data ?? {}), marker: o.marker ?? String(n) };
  return doc.transaction('Abhängige Ansicht', () => doc.add(v));
}

export interface SplitOpts {
  /** Anzahl Teile (≥ 2) */
  n: number;
  /** Teilung entlang x (nebeneinander) oder y (übereinander); Standard: längere Seite */
  dir?: 'x' | 'y';
  /** Überlappung der Teile (Modell-mm), Standard 2000 */
  overlap?: number;
  /** zu teilender Bereich (Standard: Zuschnitt bzw. Modellausdehnung + margin) */
  box?: BBox;
  margin?: number;
  /** Anschlusslinien in der Mitte der Überlappungen (Standard: ja) */
  matchLines?: boolean;
  names?: string[];
}
/** Grundriss in n abhängige Ansichten mit Überlappung teilen, Anschlusslinien dazwischen (ein Rückgängig-Schritt) */
export function splitView(doc: Doc, viewId: Id, o: SplitOpts): View[] {
  const v0 = doc.get<View>(viewId);
  if (!v0 || !isPlanLike(v0)) throw new Error('Nur Grundrisse und Deckenpläne können geteilt werden: ' + viewId);
  const p = rootView(doc, v0);
  const n = Math.max(2, Math.min(20, Math.round(o.n)));
  const box = o.box ?? cropBox(p) ?? inflate(planModelBox(doc, p), o.margin ?? 1000);
  if (!boxValid(box)) throw new Error('Ansicht ohne Modellinhalt: ' + p.name);
  const W = box.max.x - box.min.x, H = box.max.y - box.min.y;
  const dir = o.dir ?? (W >= H ? 'x' : 'y');
  const L = dir === 'x' ? W : H; const lo = dir === 'x' ? box.min.x : box.min.y;
  const ov = Math.max(0, Math.min(o.overlap ?? 2000, L / n));
  const part = (L + (n - 1) * ov) / n;
  const out: View[] = [];
  doc.transaction('Ansicht teilen', () => {
    const k0 = dependentsOf(doc, p.id).length;
    for (let i = 0; i < n; i++) {
      const s = lo + i * (part - ov), e = s + part;
      const crop: BBox = dir === 'x' ? { min: { x: s, y: box.min.y }, max: { x: e, y: box.max.y } } : { min: { x: box.min.x, y: s }, max: { x: box.max.x, y: e } };
      out.push(addDependentView(doc, p.id, { crop, name: o.names?.[i] ?? `${p.name} - Teil ${k0 + i + 1}`, marker: String(k0 + i + 1) }));
    }
    if (o.matchLines !== false) for (let i = 0; i + 1 < n; i++) {
      const m = lo + (i + 1) * (part - ov) + ov / 2;
      // a → b so, dass Teil i links und Teil i+1 rechts liegt (sideDist > 0 = links)
      const [a, b] = dir === 'x' ? [{ x: m, y: box.min.y }, { x: m, y: box.max.y }] : [{ x: box.max.x, y: m }, { x: box.min.x, y: m }];
      addMatchLine(doc, p.id, a, b, [out[i].id, out[i + 1].id]);
    }
  });
  return out;
}

// ------------------------------------------------------------ Anschlusslinie
export interface MatchLine extends El {
  cat: 'matchline';
  /** Primäransicht (erscheint in allen abhängigen Ansichten) */
  viewId: Id;
  a: V2; b: V2;
  /** angrenzende Teilansichten [links, rechts] bezogen auf a → b (fehlt: nach Zuschnitt bestimmt) */
  views?: Id[];
  /** Text vor der Plannummer (Standard «Anschluss Plan») */
  prefix?: string;
}
/** Anschlusslinie (Beschriftung der Primäransicht) anlegen */
export function addMatchLine(doc: Doc, viewId: Id, a: V2, b: V2, views?: Id[]): MatchLine {
  const vid = annoViewId(doc, doc.get<View>(viewId)) || viewId;
  const el: MatchLine = { id: newId('ml'), cat: 'matchline', viewId: vid, a: { ...a }, b: { ...b }, ...(views ? { views } : {}) };
  return doc.transaction('Anschlusslinie', () => doc.add(el));
}

const boxCenter = (b: BBox): V2 => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 });
/** Teilansichten links/rechts der Anschlusslinie */
export function matchSides(doc: Doc, ml: MatchLine): { left?: View; right?: View } {
  if (ml.views?.length === 2) return { left: doc.get<View>(ml.views[0]), right: doc.get<View>(ml.views[1]) };
  const lb: BBox = { min: { x: Math.min(ml.a.x, ml.b.x), y: Math.min(ml.a.y, ml.b.y) }, max: { x: Math.max(ml.a.x, ml.b.x), y: Math.max(ml.a.y, ml.b.y) } };
  let left: [View, number] | undefined, right: [View, number] | undefined;
  for (const d of dependentsOf(doc, ml.viewId)) {
    const c = cropBox(d); if (!c || !boxOverlap(c, lb)) continue;
    const s = sideDist(boxCenter(c), ml.a, ml.b);
    if (s > 0 && (!left || s < left[1])) left = [d, s];
    if (s < 0 && (!right || -s < right[1])) right = [d, -s];
  }
  return { left: left?.[0], right: right?.[0] };
}
/** Verweistext auf den Plan einer Teilansicht («Plan A-102.2», sonst Ansichtsname) */
export function partRef(doc: Doc, v: View | undefined): string {
  if (!v) return '?';
  const r = sheetRefOf(doc, v);
  return r ? `Plan ${r.sheet}` : v.name;
}
/** Beschriftung(en) der Anschlusslinie in einer Ansicht: in einer Teilansicht der Verweis auf den Nachbarteil */
export function matchLabels(doc: Doc, ml: MatchLine, view: View): { side: number; text: string }[] {
  const { left, right } = matchSides(doc, ml);
  const pre = ml.prefix ?? 'Anschluss';
  const c = view.parentId ? cropBox(view) : null;
  if (c) {
    const own = sideDist(boxCenter(c), ml.a, ml.b) >= 0 ? 1 : -1;
    const other = own > 0 ? right : left;
    if (other?.id === view.id) return [];
    return [{ side: own, text: `${pre} ${partRef(doc, other)}` }];
  }
  return [{ side: 1, text: partRef(doc, left) }, { side: -1, text: partRef(doc, right) }].filter((x) => x.text !== '?');
}
/** Strecke a–b auf ein Rechteck beschränken (Liang-Barsky) */
function clipSeg(a: V2, b: V2, r: BBox): [V2, V2] | null {
  let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - r.min.x], [dx, r.max.x - a.x], [-dy, a.y - r.min.y], [dy, r.max.y - a.y]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}
function drawMatchLine(dl: DisplayList, el: MatchLine, doc: Doc, view: View): void {
  if (dist(el.a, el.b) < 1) return;
  const s = view.scale || 100;
  dl.line(el.a, el.b, { w: 6, dash: 'dashdot' }, { sub: 'line' });
  const c = cropBox(view);
  const seg = c ? clipSeg(el.a, el.b, c) : [el.a, el.b];
  if (!seg) return;
  const d = norm(sub(el.b, el.a)); const n = perp(d);
  const rd = readable(d); const vis = dist(seg[0], seg[1]);
  for (const lb of matchLabels(doc, el, view)) {
    const t = lb.text.toUpperCase();
    // nahe am Ende b des sichtbaren Teils (meist ausserhalb des Gebäudes, keine Kollision mit Raumstempeln)
    const off = Math.min(vis / 2, (textWidth(t, 3 * 1.08) / 2 + 4) * s);
    dl.text(add(sub(seg[1], mul(d, off)), mul(n, lb.side * 3 * s)), t, { size: 3, bold: true, ha: 'center', va: 'middle', rot: rd.ang });
  }
}

registerCategory({
  cat: 'matchline', label: 'Anschlusslinie', plural: 'Anschlusslinien', annotation: true, planOrder: 72,
  drawAnnotation: (dl, el, doc, view) => drawMatchLine(dl, el as MatchLine, doc, view),
  grips: (el) => [{ id: 'a', p: el.a, kind: 'end' }, { id: 'b', p: el.b, kind: 'end' }],
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m) => ({ a: apply(m, el.a), b: apply(m, el.b) }),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: (el, doc) => {
    const sd = matchSides(doc, el as MatchLine);
    return [
      { key: 'prefix', label: 'Text', group: GROUPS.text, type: 'text', get: (e) => e.prefix ?? 'Anschluss', set: (_e, v) => ({ prefix: v && v !== 'Anschluss' ? v : undefined }) },
      { key: 'left', label: 'Teil links', group: GROUPS.identity, type: 'readonly', get: () => (sd.left ? `${sd.left.name} (${partRef(doc, sd.left)})` : '–') },
      { key: 'right', label: 'Teil rechts', group: GROUPS.identity, type: 'readonly', get: () => (sd.right ? `${sd.right.name} (${partRef(doc, sd.right)})` : '–') },
      { key: 'auto', label: 'Teile automatisch (nach Zuschnitt)', group: GROUPS.identity, type: 'bool', get: (e) => !e.views, set: (e, v) => (v ? { views: undefined } : { views: [sd.left?.id ?? '', sd.right?.id ?? ''] }) },
    ] as PropDef[];
  },
});

class MatchLineTool extends LineDrawTool {
  id = 'matchline'; label = 'Anschlusslinie';
  kinds = ['plan', 'ceiling'];
  modes: any = ['line', 'pick'];
  showOffset = false; chain = false;
  private viewId: Id = '';
  move(e: ToolEvent): void { this.viewId = e.view.id; super.move(e); }
  down(e: ToolEvent): void { this.viewId = e.view.id; super.down(e); }
  createSegment(a: V2, b: V2): void {
    const vid = annoViewId(app.doc, app.doc.get<View>(this.viewId) ?? app.activeView());
    if (vid) app.doc.add<MatchLine>({ id: newId('ml'), cat: 'matchline', viewId: vid, a, b });
  }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void { dl.line(a, b, { w: 6, dash: 'dashdot', color: '#1e6fd9' }); }
}

// ------------------------------------------------------------ Übersicht: Rahmen der Teilpläne
/** Teilansichten, deren Rahmen in der Ansicht gezeigt werden: die eigenen abhängigen Ansichten, sonst (z.B. Übersicht 1:500) alle derselben Ebene und Art */
export function framesFor(doc: Doc, view: View): View[] {
  const own = view.parentId ? [] : dependentsOf(doc, view.id);
  const cand = own.length ? own : doc.all<View>('view').filter((d) => d.parentId && d.id !== view.id && d.kind === view.kind && d.levelId === view.levelId);
  return cand.filter((d) => !!cropBox(d))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}
registerPlanOverlay((doc, view, dl) => {
  const s = view.scale || 100;
  for (const d of framesFor(doc, view)) {
    const c = cropBox(d)!;
    dl.begin(d.id);
    dl.poly(boxCorners(c), { w: 4, dash: 'dash' }, true, { ns: true, sub: 'depFrame' });
    const ref = sheetRefOf(doc, d);
    const p = { x: c.min.x + 2 * s, y: c.max.y - 2 * s };
    dl.text(p, ref ? ref.sheet : (d.data?.marker ? `Teil ${d.data.marker}` : d.name), { size: 5, bold: true, va: 'top' });
    dl.text({ x: p.x, y: p.y - 6.5 * s }, ref ? d.titleOnSheet || d.name : 'nicht platziert', { size: 2.5, va: 'top' });
  }
  dl.begin(null);
});

// ------------------------------------------------------------ Schlüsselplan (auf Plänen)
export interface KeyPlan extends El {
  cat: 'keyplan';
  /** Plan */
  viewId: Id;
  /** Primäransicht der Teilpläne (fehlt: aus den Ansichtsfenstern dieses Plans) */
  refId?: Id;
  /** linke untere Ecke (Papier-mm) */
  p: V2;
  /** Breite (Papier-mm) */
  size: number;
  title?: string;
}
/** Primäransicht, deren Teile auf diesem Plan platziert sind */
export function keyPlanRoot(doc: Doc, sheetId: Id): View | undefined {
  for (const vp of doc.all('viewport')) {
    if (vp.viewId !== sheetId) continue;
    const v = doc.get<View>(vp.refId);
    if (v?.parentId) return rootView(doc, v);
    if (v && isPlanLike(v) && dependentsOf(doc, v.id).length) return v;
  }
  return undefined;
}
/** Gebäudeumriss für den Schlüsselplan: Decken (Umrisse) und Wände der Ebene, sonst Modellausdehnung */
export function keyPlanOutline(doc: Doc, root: View): { loops: V2[][]; lines: [V2, V2][]; box: BBox } {
  const loops: V2[][] = []; const lines: [V2, V2][] = []; const box = emptyBox();
  for (const f of doc.all('floor')) if (f.levelId === root.levelId && Array.isArray(f.loops)) for (const l of f.loops as V2[][]) { if (l.length >= 3) { loops.push(l); for (const p of l) extendBox(box, p); } }
  for (const w of doc.all('wall')) if (w.levelId === root.levelId && w.a && w.b) { lines.push([w.a, w.b]); extendBox(box, w.a); extendBox(box, w.b); }
  if (!boxValid(box)) { const b = planModelBox(doc, root); if (boxValid(b)) { loops.push(boxCorners(b)); extendBox(box, b.min); extendBox(box, b.max); } }
  return { loops, lines, box };
}
/** Teile, die auf dem Plan platziert sind */
const partsOnSheet = (doc: Doc, sheetId: Id, parts: View[]): Set<Id> => {
  const ids = new Set(parts.map((v) => v.id)); const on = new Set<Id>();
  for (const vp of doc.all('viewport')) if (vp.viewId === sheetId && ids.has(vp.refId)) on.add(vp.refId);
  return on;
};
function keyPlanGeo(doc: Doc, kp: KeyPlan): { root: View; parts: View[]; k: number; o: V2; w: number; hgt: number; M: (p: V2) => V2; outline: ReturnType<typeof keyPlanOutline> } | null {
  const root = doc.get<View>(kp.refId) ?? keyPlanRoot(doc, kp.viewId);
  if (!root) return null;
  const parts = dependentsOf(doc, root.id).filter((d) => cropBox(d)).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  const outline = keyPlanOutline(doc, root);
  const b = emptyBox();
  if (boxValid(outline.box)) { extendBox(b, outline.box.min); extendBox(b, outline.box.max); }
  for (const d of parts) { const c = cropBox(d)!; extendBox(b, c.min); extendBox(b, c.max); }
  if (!boxValid(b)) return null;
  const size = Math.max(20, kp.size || 80);
  const bw = Math.max(1, b.max.x - b.min.x), bh = Math.max(1, b.max.y - b.min.y);
  const k = Math.min(size / bw, size / bh);
  const w = bw * k, hgt = bh * k;
  const o = kp.p;
  const M = (p: V2): V2 => ({ x: o.x + (p.x - b.min.x) * k, y: o.y + (p.y - b.min.y) * k });
  return { root, parts, k, o, w, hgt, M, outline };
}
function drawKeyPlan(dl: DisplayList, kp: KeyPlan, doc: Doc): void {
  const g = keyPlanGeo(doc, kp);
  if (!g) { dl.text(kp.p, 'Schlüsselplan: keine Teilpläne', { size: 2.5, color: '#c03030' }); return; }
  const on = partsOnSheet(doc, kp.viewId, g.parts);
  const pad = 3;
  // Rahmen mit Titel
  const fr = { min: { x: g.o.x - pad, y: g.o.y - pad }, max: { x: g.o.x + g.w + pad, y: g.o.y + g.hgt + pad + 5 } };
  dl.fill([boxCorners(fr)], { color: '#ffffff' }, { w: 2 }, { ns: true });
  dl.text({ x: fr.min.x + 1.5, y: fr.max.y - 1.2 }, kp.title ?? 'Schlüsselplan', { size: 2.5, bold: true, va: 'top' });
  // Teile (dieser Plan schraffiert)
  for (const d of g.parts) {
    const c = cropBox(d)!; const r = boxCorners({ min: g.M(c.min), max: g.M(c.max) });
    if (on.has(d.id)) dl.fill([r], { color: '#e4e4e4', pattern: 'diag', patColor: '#505050' }, undefined, { ns: true, sub: 'keyPart' });
  }
  // Gebäudeumriss
  for (const l of g.outline.loops) dl.poly(l.map(g.M), { w: 3 }, true, { ns: true });
  for (const [a, b] of g.outline.lines) dl.line(g.M(a), g.M(b), { w: 3 }, { ns: true });
  for (const d of g.parts) {
    const c = cropBox(d)!; const r = boxCorners({ min: g.M(c.min), max: g.M(c.max) });
    dl.poly(r, { w: on.has(d.id) ? 4 : 1, dash: on.has(d.id) ? undefined : 'dash' }, true, { ns: true });
    const ref = sheetRefOf(doc, d);
    const ctr = g.M(boxCenter(c));
    const lbl = ref ? ref.sheet : d.data?.marker ?? '';
    if (!lbl) continue;
    const tw = textWidth(lbl, 2.2 * (on.has(d.id) ? 1.08 : 1)) / 2 + 0.6;
    dl.fill([boxCorners({ min: { x: ctr.x - tw, y: ctr.y - 1.6 }, max: { x: ctr.x + tw, y: ctr.y + 1.6 } })], { color: '#ffffff' }, undefined, { ns: true });
    dl.text(ctr, lbl, { size: 2.2, bold: on.has(d.id), ha: 'center', va: 'middle' });
  }
}
/** Standardlage: rechts über dem Plankopf (inkl. Revisionstabelle) */
export function defaultKeyPlanPos(doc: Doc, sheet: View, size: number): V2 {
  const { w } = sheetSize(sheet);
  const n = revisionsOf(sheet).length;
  const tb = titleBlockOf(doc, sheet) === 'ch' ? 62 + 4.2 * (n + 1) : 74 + (n ? 4.2 * (n + 1) : 0);
  return { x: w - 5 - 8 - size, y: 5 + tb + 8 };
}
/** Schlüsselplan auf einem Plan anlegen (refId: Primäransicht, Standard aus den Ansichtsfenstern) */
export function addKeyPlan(doc: Doc, sheetId: Id, o: { refId?: Id; p?: V2; size?: number; title?: string } = {}): KeyPlan {
  const sheet = doc.get<View>(sheetId);
  if (!sheet || sheet.kind !== 'sheet') throw new Error('Schlüsselplan nur auf Plänen: ' + sheetId);
  const root = o.refId ? rootView(doc, doc.get<View>(o.refId)) : keyPlanRoot(doc, sheetId);
  const size = o.size ?? 80;
  const el: KeyPlan = { id: newId('kp'), cat: 'keyplan', viewId: sheetId, p: o.p ?? defaultKeyPlanPos(doc, sheet, size), size, ...(root ? { refId: root.id } : {}), ...(o.title ? { title: o.title } : {}) };
  return doc.transaction('Schlüsselplan', () => doc.add(el));
}

registerCategory({
  cat: 'keyplan', label: 'Schlüsselplan', plural: 'Schlüsselpläne', annotation: true, planOrder: 20,
  drawAnnotation: (dl, el, doc) => drawKeyPlan(dl, el as KeyPlan, doc),
  grips: (el, doc) => {
    const g = keyPlanGeo(doc, el as KeyPlan);
    return [{ id: 'p', p: el.p, kind: 'end', tip: 'Schlüsselplan verschieben' }, ...(g ? [{ id: 'size', p: { x: g.o.x + g.w, y: g.o.y }, kind: 'end' as const, tip: 'Grösse' }] : [])];
  },
  dragGrip: (el, id, p) => (id === 'p' ? { p } : id === 'size' ? { size: Math.max(20, Math.round(p.x - el.p.x)) } : undefined),
  transform: (el, m) => ({ p: apply(m, el.p) }),
  center: (el) => el.p,
  props: (_el, doc) => [
    { key: 'size', label: 'Breite (mm)', group: GROUPS.dims, type: 'number', get: (e) => e.size ?? 80, set: (_e, v) => (v >= 20 ? { size: v } : undefined) },
    { key: 'title', label: 'Titel', group: GROUPS.text, type: 'text', get: (e) => e.title ?? 'Schlüsselplan', set: (_e, v) => ({ title: v && v !== 'Schlüsselplan' ? v : undefined }) },
    { key: 'refId', label: 'Teilpläne von', group: GROUPS.identity, type: 'select',
      options: () => [['', '(automatisch)'], ...doc.all<View>('view').filter((v) => !v.parentId && dependentsOf(doc, v.id).length).map((v) => [v.id, v.name] as [string, string])],
      get: (e) => e.refId ?? '', set: (_e, v) => ({ refId: v || undefined }) },
  ] as PropDef[],
});

// ------------------------------------------------------------ Eigenschaften, Befehle, Projektbrowser
for (const kind of ['plan', 'ceiling']) extendViewProps(kind, (v, doc, base) => {
  const g = GROUPS; const p = [...base];
  if (v.parentId) {
    const r = doc.get<View>(v.parentId);
    p.push({ key: 'parentView', label: 'Primäransicht', group: g.identity, type: 'readonly', get: () => r?.name ?? '' });
    p.push({ key: 'detachDep', label: 'Abhängigkeit', group: g.identity, type: 'button', get: () => 'Lösen', action: (e) => {
      app.doc.transaction('Abhängigkeit lösen', () => app.doc.update<View>(e.id, { parentId: undefined, hostId: undefined }));
      app.emit('views');
    } });
  } else {
    const n = dependentsOf(doc, v.id).length;
    if (n) p.push({ key: 'depCount', label: 'Abhängige Ansichten', group: g.identity, type: 'readonly', get: () => String(n) });
  }
  p.push({ key: 'depFrames', label: 'Teilpläne anzeigen (Übersicht)', group: g.graphics, type: 'bool', get: (e) => !!e.depFrames, set: (_e, x) => ({ depFrames: x ? true : undefined }) });
  return p;
});

function splitDialog(v0: View): void {
  const v = rootView(app.doc, v0);
  const sel = (opts: [string, string][], val: string) => { const s = h('select', {}) as HTMLSelectElement; for (const [k, l] of opts) s.append(h('option', { value: k }, l)); s.value = val; return s; };
  const n = sel([2, 3, 4, 5, 6, 8].map((x) => [String(x), String(x)] as [string, string]), '3');
  const dir = sel([['', 'Längere Seite'], ['x', 'nebeneinander (x)'], ['y', 'übereinander (y)']], '');
  const ov = h('input', { type: 'number', value: '2000', step: '100', min: '0' }) as HTMLInputElement;
  const ml = h('input', { type: 'checkbox' }) as HTMLInputElement; ml.checked = true;
  const row = (l: string, e: HTMLElement) => h('div', { class: 'form-row' }, h('label', {}, l), e);
  const body = h('div', {}, h('div', { class: 'hint' }, `«${v.name}» in abhängige Ansichten (Teilpläne) teilen. Die Teile erhalten je einen Zuschnitt; Massstab, Sichtbarkeit und Beschriftungen bleiben mit der Primäransicht verbunden.`),
    row('Anzahl Teile', n), row('Teilung', dir), row('Überlappung (mm)', ov), h('div', { class: 'form-row' }, h('label', {}, ml, ' Anschlusslinien in der Mitte der Überlappung')));
  modal('Ansicht teilen', body, [
    { label: 'OK', primary: true, onClick: () => {
      try {
        const parts = splitView(app.doc, v.id, { n: parseInt(n.value, 10), dir: (dir.value || undefined) as any, overlap: Math.max(0, parseFloat(ov.value) || 0), matchLines: ml.checked });
        app.emit('views');
        toast(`${parts.length} Teilpläne erstellt. Auf Pläne ziehen; Anschlusslinien verweisen auf die Plannummer des Nachbarteils.`, 4000);
      } catch (e) { alert(String((e as Error).message ?? e)); return false; }
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 440);
}

const activePlan = () => { const v = app.activeView(); return v && isPlanLike(v) ? v : null; };
registerCommand({ id: 'splitView', label: 'Ansicht teilen', icon: 'splitview', tip: 'Grundriss in Teilpläne (abhängige Ansichten) mit Überlappung und Anschlusslinien teilen – für lange Gebäude auf mehreren Plänen', enabled: () => !!activePlan(), run: () => { const v = activePlan(); if (v) splitDialog(v); } });
registerCommand({ id: 'duplicateDependent', label: 'Abhängige Ansicht', icon: 'dependent', tip: 'Abhängige Ansicht duplizieren: eigener Zuschnitt, alle übrigen Eigenschaften und Beschriftungen folgen der Primäransicht', enabled: () => !!activePlan(), run: () => {
  const v = activePlan(); if (!v) return;
  const d = addDependentView(app.doc, v.id); app.emit('views'); app.openView(d.id);
} });
registerCommand({ id: 'matchline', label: 'Anschlusslinie', icon: 'matchline', tip: 'Anschlusslinie zwischen Teilplänen zeichnen (erscheint in allen abhängigen Ansichten mit Verweis auf den Nachbarplan)', enabled: () => !!activePlan(), run: () => startTool(new MatchLineTool(), 'matchline') });
registerCommand({ id: 'keyplan', label: 'Schlüsselplan', icon: 'keyplan', tip: 'Schlüsselplan auf dem aktiven Plan: Gebäudeumriss mit den Teilplänen, Teil dieses Plans schraffiert', enabled: () => isSheet(app.activeView()), run: () => {
  const s = app.activeView(); if (!s || !isSheet(s)) return;
  if (!keyPlanRoot(app.doc, s.id)) { alert('Auf diesem Plan ist kein Teilplan (abhängige Ansicht) platziert.'); return; }
  const kp = addKeyPlan(app.doc, s.id); app.select([kp.id]);
} });
registerPanel('Ansicht', 'Grossformat', ['splitView', 'duplicateDependent', 'matchline', 'keyplan'], 22);

onHook('viewMenu', (v: View, items: ([string, () => void] | '-')[]) => {
  if (!isPlanLike(v)) return;
  items.push(['Abhängige Ansicht duplizieren', () => { addDependentView(app.doc, v.id); app.emit('views'); }]);
  if (!v.parentId) items.push(['Ansicht teilen…', () => splitDialog(v)]);
});
