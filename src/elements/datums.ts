// Bezugselemente: Ebenen, Raster, Referenzebenen; Modell-/Detaillinien; Schnitt- und Ansichtssymbole.
import type { Doc, El, Id } from '../core/doc';
import { V2, add, sub, mul, norm, perp, dist, apply, isMirror, lineLine, mid, fromAngle, angleOf, rotate, Mat2, matAngle, distToSeg, BBox } from '../core/geom';
import { registerCategory, CategoryDef, SectionCtx, PropDef, GROUPS, Grip } from '../core/registry';
import { Level, View, isPlanLike, isSectionLike, levels, makeProjector, cropBox } from '../core/view';
import { fmtElev, fmtLen } from '../core/units';
import { DisplayList } from '../render/displayList';
import { catPen } from '../views/sectionEngine';
import type { DashName, Pen } from '../render/styles';

const TXT = 2.5; // Standard-Texthöhe Papier-mm

// ------------------------------------------------------------ Ebenen
/** zuletzt gezeichnete rechte Enden der Ebenenlinien je Ansicht (für Griffe) */
const levelHeadX = new Map<string, number>();
function levelExtents(ctx: SectionCtx): [number, number] {
  const b = ctx.modelBox;
  if (b && isFinite(b.min.x)) return [b.min.x - ctx.view.scale * 8, b.max.x + ctx.view.scale * 8];
  return [-2000, 20000];
}

registerCategory({
  cat: 'level', label: 'Ebene', plural: 'Ebenen', datum: true, planOrder: 40,
  drawSection: (ctx, el) => {
    const l = el as Level; const dl = ctx.dl; const s = ctx.view.scale;
    const [x0, x1] = l.ext ?? levelExtents(ctx);
    levelHeadX.set(ctx.view.id + '|' + l.id, x1);
    const y = l.elev - ctx.origin.z;
    const pen: Pen = { ...catPen(ctx.doc, 'level', false), dash: 'center' };
    dl.line({ x: x0, y }, { x: x1, y }, pen, { sub: 'line' });
    // Kopf rechts: Höhenkote ▽ mit Text
    const h = 2.2 * s; const ex = x1;
    dl.fill([[{ x: ex, y }, { x: ex - h * 0.6, y: y + h }, { x: ex + h * 0.6, y: y + h }]], { color: '#ffffff' }, { w: 2 }, { ns: true });
    dl.fill([[{ x: ex, y }, { x: ex, y: y + h }, { x: ex + h * 0.6, y: y + h }]], { color: '#000000', pattern: 'solid', patColor: '#000000' }, undefined, { ns: true });
    dl.text({ x: ex + h, y: y + h * 0.3 }, fmtElev(l.elev), { size: TXT, va: 'bottom' });
    dl.text({ x: ex + h, y: y - h * 0.3 }, l.name, { size: TXT, va: 'top' });
    if (l.headLeft) {
      const lx = x0;
      dl.fill([[{ x: lx, y }, { x: lx - h * 0.6, y: y + h }, { x: lx + h * 0.6, y: y + h }]], { color: '#ffffff' }, { w: 2 }, { ns: true });
      dl.text({ x: lx - h, y: y + h * 0.3 }, fmtElev(l.elev), { size: TXT, va: 'bottom', ha: 'right' });
      dl.text({ x: lx - h, y: y - h * 0.3 }, l.name, { size: TXT, va: 'top', ha: 'right' });
    }
  },
  grips: (el, doc, view) => {
    if (!isSectionLike(view)) return [];
    const l = el as Level; const pr = makeProjector(view);
    const x = l.ext?.[1] ?? levelHeadX.get(view.id + '|' + l.id) ?? 0;
    return [{ id: 'elev', p: { x, y: l.elev - pr.origin.z }, kind: 'end', tip: 'Höhe ändern' }];
  },
  dragGrip: (el, id, p, doc, view) => {
    const l = el as Level;
    if (id === 'elev') return { elev: Math.round(p.y + makeProjector(view).origin.z) };
  },
  transform: (el, m, doc, view) => {
    if (!isSectionLike(view)) return;
    const l = el as Level; const p = apply(m, { x: 0, y: l.elev });
    return { elev: Math.round(p.y) };
  },
  translate3d: (el, d) => ({ elev: (el as Level).elev + d.z }),
  props: () => [
    { key: 'elev', label: 'Höhe', group: GROUPS.constraints, type: 'length', get: (e) => e.elev, set: (_e, v) => ({ elev: v }) },
    { key: 'name', label: 'Name', group: GROUPS.identity, type: 'text', get: (e) => e.name, set: (_e, v) => ({ name: v }) },
    { key: 'story', label: 'Geschoss', group: GROUPS.identity, type: 'bool', get: (e) => e.story !== false, set: (_e, v) => ({ story: v }) },
    { key: 'headLeft', label: 'Symbol links', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.headLeft, set: (_e, v) => ({ headLeft: v }) },
  ],
  tagText: (el) => el.name,
});

// ------------------------------------------------------------ Raster
export interface Grid extends El { cat: 'grid'; name: string; a: V2; b: V2; bubbleA?: boolean; bubbleB?: boolean }

function bubble(dl: DisplayList, c: V2, label: string, s: number): void {
  const r = 4 * s;
  dl.circle(c, r, { w: 2 }, { color: '#ffffff' }, { ns: true });
  dl.text(c, label, { size: 3.5, ha: 'center', va: 'middle' });
}

registerCategory({
  cat: 'grid', label: 'Raster', plural: 'Raster', datum: true, planOrder: 41,
  drawPlan: (ctx, el) => {
    const g = el as Grid; const s = ctx.view.scale; const dl = ctx.dl;
    const d = norm(sub(g.b, g.a)); const r = 4 * s;
    dl.line(g.a, g.b, { ...catPen(ctx.doc, 'grid', false), dash: 'center' }, { sub: 'line' });
    if (g.bubbleA !== false) bubble(dl, sub(g.a, mul(d, r)), g.name, s);
    if (g.bubbleB !== false) bubble(dl, add(g.b, mul(d, r)), g.name, s);
  },
  drawSection: (ctx, el) => {
    const g = el as Grid; const s = ctx.view.scale;
    const gd = norm(sub(g.b, g.a));
    const right = { x: ctx.right.x, y: ctx.right.y };
    if (Math.abs(gd.x * right.y - gd.y * right.x) < 0.5) return; // annähernd parallel zur Ansichtsebene
    const o = { x: ctx.origin.x, y: ctx.origin.y };
    const x = lineLine(g.a, g.b, o, add(o, right)); if (!x) return;
    const vx = ctx.toView({ x: x.p.x, y: x.p.y, z: 0 }).x;
    const ls = levels(ctx.doc);
    const y0 = (ls[0]?.elev ?? 0) - 1500, y1 = (ls[ls.length - 1]?.elev ?? 3000) + 2500;
    const b = ctx.modelBox;
    const top = Math.max(y1, b && isFinite(b.max.y) ? b.max.y + 1000 : y1);
    ctx.dl.line({ x: vx, y: Math.min(y0, b && isFinite(b.min.y) ? b.min.y - 500 : y0) }, { x: vx, y: top }, { ...catPen(ctx.doc, 'grid', false), dash: 'center' }, { sub: 'line' });
    bubble(ctx.dl, { x: vx, y: top + 4 * s }, g.name, s);
  },
  grips: (el, doc, view) => (isPlanLike(view) ? [{ id: 'a', p: (el as Grid).a, kind: 'end' }, { id: 'b', p: (el as Grid).b, kind: 'end' }] : []),
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m, doc, view) => (isPlanLike(view) ? { a: apply(m, (el as Grid).a), b: apply(m, (el as Grid).b) } : undefined),
  translate3d: (el, d) => ({ a: { x: el.a.x + d.x, y: el.a.y + d.y }, b: { x: el.b.x + d.x, y: el.b.y + d.y } }),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: () => [
    { key: 'name', label: 'Name', group: GROUPS.identity, type: 'text', get: (e) => e.name, set: (_e, v) => ({ name: v }) },
    { key: 'bubbleA', label: 'Kopf am Anfang', group: GROUPS.graphics, type: 'bool', get: (e) => e.bubbleA !== false, set: (_e, v) => ({ bubbleA: v }) },
    { key: 'bubbleB', label: 'Kopf am Ende', group: GROUPS.graphics, type: 'bool', get: (e) => e.bubbleB !== false, set: (_e, v) => ({ bubbleB: v }) },
    { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e) => fmtLen(dist(e.a, e.b)) },
  ],
  tagText: (el) => el.name,
});

/** Nächste Rasterbezeichnung: 1,2,3… oder A,B,C… je nach letzter */
export function nextGridName(doc: Doc, last?: string): string {
  const names = doc.all<Grid>('grid').map((g) => g.name);
  const base = last ?? names[names.length - 1];
  const inc = (s: string): string => {
    if (/^\d+$/.test(s)) return String(parseInt(s, 10) + 1);
    const m = s.match(/^(.*?)([A-Z])$/);
    if (m) return m[2] === 'Z' ? m[1] + 'AA' : m[1] + String.fromCharCode(m[2].charCodeAt(0) + 1);
    const n = s.match(/^(.*?)(\d+)$/);
    if (n) return n[1] + (parseInt(n[2], 10) + 1);
    return s + "'";
  };
  if (!base) return '1';
  let cand = inc(base);
  while (names.includes(cand)) cand = inc(cand);
  return cand;
}

// ------------------------------------------------------------ Referenzebenen
registerCategory({
  cat: 'refplane', label: 'Referenzebene', plural: 'Referenzebenen', datum: true, planOrder: 42,
  drawPlan: (ctx, el) => {
    const pen = catPen(ctx.doc, 'refplane', false);
    ctx.dl.line(el.a, el.b, { ...pen, dash: 'dash', color: '#2f8f2f' }, { sub: 'line' });
    if (el.name) ctx.dl.text(add(el.b, mul(norm(sub(el.b, el.a)), ctx.view.scale * 2)), el.name, { size: TXT, color: '#2f8f2f', va: 'middle', rot: normTextAngle(angleOf(sub(el.b, el.a))) });
  },
  grips: (el, doc, view) => (isPlanLike(view) ? [{ id: 'a', p: el.a, kind: 'end' }, { id: 'b', p: el.b, kind: 'end' }] : []),
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m, doc, view) => (isPlanLike(view) ? { a: apply(m, el.a), b: apply(m, el.b) } : undefined),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: () => [{ key: 'name', label: 'Name', group: GROUPS.identity, type: 'text', get: (e) => e.name ?? '', set: (_e, v) => ({ name: v }) }],
});

export function normTextAngle(a: number): number {
  let r = a;
  while (r > Math.PI / 2 + 1e-6) r -= Math.PI;
  while (r <= -Math.PI / 2 + 1e-6) r += Math.PI;
  return r;
}

// ------------------------------------------------------------ Linien (Modell- und Detaillinien)
export const LINE_STYLES: Record<string, { label: string; pen: Pen }> = {
  thin: { label: 'Dünne Linien', pen: { w: 1 } },
  medium: { label: 'Mittlere Linien', pen: { w: 3 } },
  wide: { label: 'Breite Linien', pen: { w: 5 } },
  extrawide: { label: 'Sehr breite Linien', pen: { w: 7 } },
  hidden: { label: 'Verdeckte Linien', pen: { w: 2, dash: 'hidden' } },
  dash: { label: 'Strichlinien', pen: { w: 2, dash: 'dash' } },
  center: { label: 'Strichpunktlinien (Achse)', pen: { w: 1, dash: 'center' } },
  dot: { label: 'Punktlinien', pen: { w: 2, dash: 'dot' } },
  overhead: { label: 'Darüber (Strich)', pen: { w: 1, dash: 'longdash' } },
  red: { label: 'Rot', pen: { w: 2, color: '#d01010' } },
  blue: { label: 'Blau', pen: { w: 2, color: '#1040d0' } },
  green: { label: 'Grün', pen: { w: 2, color: '#108010' } },
  invisible: { label: '<Unsichtbare Linien>', pen: { w: 1, color: '#c0c0c0', dash: 'dot' } },
};
export const lineStyleOptions = (): [string, string][] => Object.entries(LINE_STYLES).map(([k, v]) => [k, v.label]);

export interface LineEl extends El {
  cat: 'line';
  a: V2; b: V2;
  /** Bogen: Mittelpunkt + Winkel (gegen Uhrzeigersinn a0→a1). a/b sind dann die Bogenenden. */
  arc?: { c: V2; r: number; a0: number; a1: number } | null;
  style: string;
  /** Modelllinie: Ebene; Detaillinie: viewId */
}
function drawLine(dl: DisplayList, el: El): void {
  const l = el as LineEl; const pen = LINE_STYLES[l.style]?.pen ?? { w: 1 };
  if (l.arc) dl.arc(l.arc.c, l.arc.r, l.arc.a0, l.arc.a1, pen, { sub: 'line' });
  else dl.line(l.a, l.b, pen, { sub: 'line' });
}
export function arcFrom3(a: V2, m: V2, b: V2): { c: V2; r: number; a0: number; a1: number } | null {
  const m1 = mid(a, m), m2 = mid(m, b);
  const x = lineLine(m1, add(m1, perp(sub(m, a))), m2, add(m2, perp(sub(b, m))));
  if (!x) return null;
  const c = x.p; const r = dist(c, a);
  let a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
  const am = Math.atan2(m.y - c.y, m.x - c.x);
  const ccwOK = (() => { const n = (v: number) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return n(am - a0) < n(a1 - a0); })();
  if (!ccwOK) [a0, a1] = [a1, a0];
  return { c, r, a0, a1 };
}
function transformArc(l: LineEl, m: Mat2): Partial<LineEl> {
  const a = apply(m, l.a), b = apply(m, l.b);
  if (!l.arc) return { a, b };
  const c = apply(m, l.arc.c); const s = Math.hypot(m.a, m.b); const rot = matAngle(m);
  let a0 = l.arc.a0 + rot, a1 = l.arc.a1 + rot;
  if (isMirror(m)) { const r0 = rot - l.arc.a1, r1 = rot - l.arc.a0; a0 = r0; a1 = r1; }
  return { a, b, arc: { c, r: l.arc.r * s, a0, a1 } };
}
registerCategory({
  cat: 'line', label: 'Linie', plural: 'Linien', planOrder: 60,
  drawPlan: (ctx, el) => { if (!el.viewId && el.levelId === ctx.view.levelId) drawLine(ctx.dl, el); },
  drawAnnotation: (dl, el) => drawLine(dl, el),
  grips: (el) => [{ id: 'a', p: el.a, kind: 'end' }, { id: 'b', p: el.b, kind: 'end' }],
  dragGrip: (el, id, p) => {
    const l = el as LineEl;
    if (l.arc) {
      // Bogen: Radius beibehalten nicht möglich – neu über Mittelpunkt bestimmen
      const c = l.arc.c; const r = dist(c, p);
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      return id === 'a' ? { a: p, arc: { ...l.arc, r, a0: ang } } : { b: p, arc: { ...l.arc, r, a1: ang } };
    }
    return id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined;
  },
  transform: (el, m) => transformArc(el as LineEl, m),
  curve: (el) => (el.arc ? null : { a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: () => [
    { key: 'style', label: 'Linienstil', group: GROUPS.graphics, type: 'select', options: lineStyleOptions, get: (e) => e.style, set: (_e, v) => ({ style: v }) },
    { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e) => fmtLen(e.arc ? e.arc.r * (((e.arc.a1 - e.arc.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) : dist(e.a, e.b)) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ],
});

// ------------------------------------------------------------ Schnitt- und Ansichtssymbole im Grundriss
export function sectionLabel(doc: Doc, v: View): string {
  return v.data?.marker ?? v.name.replace(/^Schnitt\s*/i, '').slice(0, 4) ?? '?';
}
export function sheetRefOf(doc: Doc, v: View): { detail: string; sheet: string } | null {
  for (const s of doc.all<View>('view')) {
    if (s.kind !== 'sheet') continue;
    const vp = (s.data?.viewports ?? []).find((x: any) => x.viewId === v.id);
    if (vp) return { detail: String(vp.detail ?? '1'), sheet: s.sheetNo ?? '' };
  }
  return null;
}

function drawSectionMarker(dl: DisplayList, doc: Doc, v: View, s: number): void {
  if (!v.lineA || !v.lineB) return;
  const A = v.lineA, B = v.lineB; const d = norm(sub(B, A)); const dir = v.dir ?? perp(d);
  const pen: Pen = { w: 5 };
  const seg = Math.min(dist(A, B) / 3, 12 * s);
  // Schnittlinie: Enden kräftig, Mitte Strichpunkt
  dl.line(A, add(A, mul(d, seg)), pen, { sub: 'line' });
  dl.line(sub(B, mul(d, seg)), B, pen, { sub: 'line' });
  dl.line(add(A, mul(d, seg)), sub(B, mul(d, seg)), { w: 1, dash: 'dashdot' }, { sub: 'line', ns: true });
  const ref = sheetRefOf(doc, v); const lbl = sectionLabel(doc, v);
  for (const [P, pd] of [[A, -1], [B, 1]] as [V2, number][]) {
    const r = 4 * s; const c = add(P, mul(d, pd * r * 1.2));
    // Kopf: Kreis mit Pfeil in Blickrichtung
    dl.circle(c, r, { w: 2 }, { color: '#ffffff' }, { ns: true });
    const tip = add(c, mul(dir, r * 1.9));
    const base1 = add(c, mul(perp(dir), r)), base2 = sub(c, mul(perp(dir), r));
    dl.fill([[base1, tip, base2]], { color: '#000000', pattern: 'solid', patColor: '#000000' }, undefined, { ns: true });
    dl.circle(c, r, { w: 2 }, { color: '#ffffff' }, { ns: true });
    if (ref) {
      dl.line(sub(c, { x: r, y: 0 }), add(c, { x: r, y: 0 }), { w: 1 }, { ns: true });
      dl.text(add(c, { x: 0, y: r * 0.45 }), ref.detail, { size: 2.5, ha: 'center', va: 'middle' });
      dl.text(sub(c, { x: 0, y: r * 0.45 }), ref.sheet, { size: 2, ha: 'center', va: 'middle' });
    } else dl.text(c, lbl, { size: 3.5, ha: 'center', va: 'middle', bold: true });
  }
  // Tiefe (nur bei Auswahl)
  const far = v.far ?? 5000;
  const A2 = add(A, mul(dir, far)), B2 = add(B, mul(dir, far));
  dl.poly([A, A2, B2, B], { w: 1, dash: 'dash', color: '#1e6fd9' }, false, { sel: true, ns: true });
}

function drawElevationMarker(dl: DisplayList, doc: Doc, v: View, s: number): void {
  const o = v.origin; if (!o) return;
  const P = { x: o.x, y: o.y }; const dir = v.dir ?? { x: 0, y: 1 };
  // Symbol steht vor der Ansichtsebene (entgegen Blickrichtung)
  const r = 4.5 * s; const c = sub(P, mul(dir, r * 1.6));
  dl.circle(c, r, { w: 2 }, { color: '#ffffff' }, { ns: true });
  const tip = add(c, mul(dir, r * 1.7));
  const n = perp(dir);
  dl.fill([[add(c, mul(n, r * 0.95)), tip, sub(c, mul(n, r * 0.95)), c]], { color: '#000000', pattern: 'solid', patColor: '#000000' }, undefined, { ns: true });
  dl.circle(c, r * 0.55, { w: 1 }, { color: '#ffffff' }, { ns: true });
  const ref = sheetRefOf(doc, v);
  dl.text(c, ref ? ref.detail : (v.data?.marker ?? ''), { size: 2.2, ha: 'center', va: 'middle' });
  // Ansichtsebene (nur bei Auswahl)
  const w = v.crop?.on ? (v.crop.max.x - v.crop.min.x) / 2 : 8000;
  dl.line(add(P, mul(n, -w)), add(P, mul(n, w)), { w: 1, dash: 'dash', color: '#1e6fd9' }, { sel: true, ns: true });
}

export function sectionGeomPatch(A: V2, B: V2, v: View): Partial<View> {
  const d = norm(sub(B, A)); const dir = perp(d);
  const len = dist(A, B);
  const crop = v.crop ? { ...v.crop, min: { x: 0, y: v.crop.min.y }, max: { x: len, y: v.crop.max.y } } : v.crop;
  return { lineA: A, lineB: B, dir, origin: { x: A.x, y: A.y, z: 0 }, crop };
}

registerCategory({
  cat: 'view', label: 'Ansicht', plural: 'Ansichten', planOrder: 45,
  visibleIn: (el, doc, view) => {
    const v = el as View;
    if (v.kind === 'section') return !view.hiddenCats?.includes('section') && v.id !== view.id;
    if (v.kind === 'elevation') return !view.hiddenCats?.includes('elevation') && v.id !== view.id;
    return false;
  },
  drawPlan: (ctx, el) => {
    const v = el as View;
    if (v.kind === 'section') drawSectionMarker(ctx.dl, ctx.doc, v, ctx.view.scale);
    else if (v.kind === 'elevation') drawElevationMarker(ctx.dl, ctx.doc, v, ctx.view.scale);
  },
  grips: (el, doc, view) => {
    const v = el as View;
    // eigener Zuschneidebereich (Rahmen in der Ansicht selbst gewählt)
    if (v.id === view.id) {
      if (!v.crop) return [];
      const b = cropBox({ ...v, crop: { ...v.crop, on: true } })!;
      const mx = (b.min.x + b.max.x) / 2, my = (b.min.y + b.max.y) / 2;
      const g: Grip[] = [
        { id: 'cropT', p: { x: mx, y: b.max.y }, kind: 'arrow', dir: { x: 0, y: 1 }, tip: 'Zuschneidebereich' },
        { id: 'cropB', p: { x: mx, y: b.min.y }, kind: 'arrow', dir: { x: 0, y: -1 }, tip: 'Zuschneidebereich' },
      ];
      if (v.kind !== 'section') g.push(
        { id: 'cropL', p: { x: b.min.x, y: my }, kind: 'arrow', dir: { x: -1, y: 0 }, tip: 'Zuschneidebereich' },
        { id: 'cropR', p: { x: b.max.x, y: my }, kind: 'arrow', dir: { x: 1, y: 0 }, tip: 'Zuschneidebereich' },
      );
      return g;
    }
    if (!isPlanLike(view)) return [];
    if (v.kind === 'section' && v.lineA && v.lineB) {
      const dir = v.dir ?? perp(norm(sub(v.lineB, v.lineA)));
      const m = mid(v.lineA, v.lineB);
      return [
        { id: 'a', p: v.lineA, kind: 'end' }, { id: 'b', p: v.lineB, kind: 'end' },
        { id: 'far', p: add(m, mul(dir, v.far ?? 5000)), kind: 'arrow', dir, tip: 'Ansichtstiefe' },
        { id: 'flip', p: sub(m, mul(dir, view.scale * 6)), kind: 'flip', dir, tip: 'Schnittrichtung umkehren' },
      ];
    }
    if (v.kind === 'elevation' && v.origin) {
      const dir = v.dir ?? { x: 0, y: 1 };
      return [{ id: 'far', p: add({ x: v.origin.x, y: v.origin.y }, mul(dir, v.far ?? 30000)), kind: 'arrow', dir, tip: 'Ansichtstiefe' }];
    }
    return [];
  },
  dragGrip: (el, id, p) => {
    const v = el as View;
    if (id.startsWith('crop') && v.crop) {
      const c = { ...v.crop, min: { ...v.crop.min }, max: { ...v.crop.max } };
      if (id === 'cropT') c.max.y = Math.max(p.y, c.min.y + 100);
      if (id === 'cropB') c.min.y = Math.min(p.y, c.max.y - 100);
      if (id === 'cropL') c.min.x = Math.min(p.x, c.max.x - 100);
      if (id === 'cropR') c.max.x = Math.max(p.x, c.min.x + 100);
      return { crop: c };
    }
    if (v.kind === 'section' && v.lineA && v.lineB) {
      if (id === 'a') return sectionGeomPatch(p, v.lineB, v);
      if (id === 'b') return sectionGeomPatch(v.lineA, p, v);
      if (id === 'far') { const dir = v.dir!; return { far: Math.max(100, (p.x - v.lineA.x) * dir.x + (p.y - v.lineA.y) * dir.y) }; }
    }
    if (v.kind === 'elevation' && v.origin && id === 'far') {
      const dir = v.dir!; return { far: Math.max(100, (p.x - v.origin.x) * dir.x + (p.y - v.origin.y) * dir.y) };
    }
  },
  clickGrip: (el, id) => {
    const v = el as View;
    if (id === 'flip' && v.lineA && v.lineB) return sectionGeomPatch(v.lineB, v.lineA, v);
  },
  transform: (el, m, doc, view) => {
    const v = el as View;
    if (!isPlanLike(view)) return;
    if (v.kind === 'section' && v.lineA && v.lineB) {
      let A = apply(m, v.lineA), B = apply(m, v.lineB);
      if (isMirror(m)) [A, B] = [B, A];
      return sectionGeomPatch(A, B, v);
    }
    if (v.kind === 'elevation' && v.origin) {
      const o = apply(m, { x: v.origin.x, y: v.origin.y });
      const d = v.dir ?? { x: 0, y: 1 };
      const nd = norm(sub(apply(m, add({ x: v.origin.x, y: v.origin.y }, d)), o));
      return { origin: { x: o.x, y: o.y, z: 0 }, dir: nd };
    }
  },
  center: (el) => {
    const v = el as View;
    if (v.lineA && v.lineB) return mid(v.lineA, v.lineB);
    if (v.origin) return { x: v.origin.x, y: v.origin.y };
    return null;
  },
});

export { distToSeg, rotate, fromAngle };
export type { DashName, BBox, Id };
