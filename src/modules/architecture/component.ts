// Bauteile (Möbel, Sanitär, Küche, Bepflanzung): parametrische Bibliothek als Typen. Jeder Typ hat
// Breite/Tiefe/Höhe, ein Grundrisssymbol (lokale Koordinaten, DIN-ähnlich) und einfache Körper.
// Lokales System: x ∈ [0, B] (Breite), y ∈ [0, T] (Tiefe), y = T ist die Rückseite (Wandseite).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, apply, angleOf, cross, arcPoints, dist, Mat2, applyVec } from '../../core/geom';
import { registerCategory, registerCommand, GROUPS, PropDef, Solid } from '../../core/registry';
import { levelElev, typeOf, TypeEl, isPlanLike } from '../../core/view';
import { prism, catPen } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import { identityProps, levelName } from './common';

export type SymKey = 'table' | 'chair' | 'bed' | 'bed2' | 'wardrobe' | 'sofa' | 'wc' | 'basin' | 'shower' | 'bathtub' | 'kitchen' | 'stove' | 'sink' | 'fridge' | 'plant' | 'tree';
export interface CompType extends TypeEl { of: 'component'; family: string; sym: SymKey; width: number; depth: number; height: number; mat?: Id; color?: string; description?: string }
export interface Component extends El { cat: 'component'; levelId: Id; offset: number; p: V2; rot: number; flip?: boolean }

export const compType = (doc: Doc, c: El) => typeOf<CompType>(doc, c);

/** Zeichenschnittstelle in lokalen Koordinaten */
interface SymPen { pen: Pen; thin: Pen; hid: Pen }
interface SymCtx { W: number; D: number; H: number; line(a: V2, b: V2, p?: Pen): void; poly(pts: V2[], closed?: boolean, p?: Pen): void; rect(x0: number, y0: number, x1: number, y1: number, p?: Pen): void; ell(cx: number, cy: number, rx: number, ry: number, p?: Pen): void; circ(cx: number, cy: number, r: number, p?: Pen): void; text(p: V2, s: string, size: number): void; pens: SymPen }
interface SolCtx { W: number; D: number; H: number; box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: string): void; cyl(cx: number, cy: number, r: number, z0: number, z1: number, color?: string): void }

interface SymDef { label: string; centered?: boolean; plan(s: SymCtx): void; solids(s: SolCtx): void }

const V = (x: number, y: number): V2 => ({ x, y });
const WOOD = '#c8a878', WHITE = '#f4f4f4', FABRIC = '#8a9bb0', METAL = '#b8bec4', GREEN = '#6a9a4a';

export const SYMBOLS: Record<SymKey, SymDef> = {
  table: {
    label: 'Tisch', centered: true,
    plan: (s) => s.rect(0, 0, s.W, s.D),
    solids: (s) => {
      s.box(0, 0, s.H - 30, s.W, s.D, s.H, WOOD);
      const l = 50, i = 40;
      for (const [x, y] of [[i, i], [s.W - i - l, i], [i, s.D - i - l], [s.W - i - l, s.D - i - l]]) s.box(x, y, 0, x + l, y + l, s.H - 30, WOOD);
    },
  },
  chair: {
    label: 'Stuhl', centered: true,
    plan: (s) => { s.rect(0, 0, s.W, s.D * 0.85); s.rect(0, s.D * 0.85, s.W, s.D); },
    solids: (s) => {
      s.box(0, 0, 420, s.W, s.D * 0.85, 460, WOOD);
      s.box(0, s.D * 0.85, 0, s.W, s.D, s.H, WOOD);
      for (const [x, y] of [[20, 20], [s.W - 50, 20]]) s.box(x, y, 0, x + 30, y + 30, 420, WOOD);
    },
  },
  bed: {
    label: 'Bett',
    plan: (s) => {
      s.rect(0, 0, s.W, s.D);
      const n = s.W >= 1400 ? 2 : 1; const pw = (s.W - 120 * (n + 1)) / n;
      for (let k = 0; k < n; k++) { const x = 120 + k * (pw + 120); s.rect(x, s.D - 450, x + pw, s.D - 100, s.pens.thin); }
      const yf = s.D - 600;
      s.line(V(0, yf), V(s.W, yf), s.pens.thin);
      s.line(V(s.W * 0.55, yf), V(s.W, yf - s.W * 0.45), s.pens.thin);
    },
    solids: (s) => {
      s.box(0, 0, 100, s.W, s.D, 300, WOOD);
      s.box(20, 20, 300, s.W - 20, s.D - 20, 480, WHITE);
      s.box(0, s.D - 40, 0, s.W, s.D, Math.max(s.H, 800), WOOD);
    },
  },
  bed2: { label: 'Doppelbett', plan: (s) => SYMBOLS.bed.plan(s), solids: (s) => SYMBOLS.bed.solids(s) },
  wardrobe: {
    label: 'Schrank',
    plan: (s) => { s.rect(0, 0, s.W, s.D); s.line(V(0, 0), V(s.W, s.D), s.pens.thin); s.line(V(0, s.D), V(s.W, 0), s.pens.thin); s.line(V(0, 30), V(s.W, 30), s.pens.thin); },
    solids: (s) => s.box(0, 0, 0, s.W, s.D, s.H, WOOD),
  },
  sofa: {
    label: 'Sofa',
    plan: (s) => {
      const a = Math.min(200, s.W * 0.1), b = Math.min(220, s.D * 0.3);
      s.rect(0, 0, s.W, s.D);
      s.rect(a, s.D - b, s.W - a, s.D, s.pens.thin);
      s.rect(0, 0, a, s.D, s.pens.thin); s.rect(s.W - a, 0, s.W, s.D, s.pens.thin);
      const n = Math.max(1, Math.round((s.W - 2 * a) / 650));
      for (let k = 1; k < n; k++) { const x = a + ((s.W - 2 * a) * k) / n; s.line(V(x, 0), V(x, s.D - b), s.pens.thin); }
    },
    solids: (s) => {
      const a = Math.min(200, s.W * 0.1), b = Math.min(220, s.D * 0.3);
      s.box(0, 0, 0, s.W, s.D, 420, FABRIC);
      s.box(0, s.D - b, 420, s.W, s.D, s.H, FABRIC);
      s.box(0, 0, 420, a, s.D - b, 620, FABRIC); s.box(s.W - a, 0, 420, s.W, s.D - b, 620, FABRIC);
    },
  },
  wc: {
    label: 'WC',
    plan: (s) => {
      const tk = Math.min(180, s.D * 0.3);
      s.rect(0, s.D - tk, s.W, s.D);
      const by = s.D - tk, ry = by / 2;
      s.ell(s.W / 2, ry, s.W / 2 - 10, ry);
      s.ell(s.W / 2, ry * 0.85, s.W * 0.28, ry * 0.6, s.pens.thin);
    },
    solids: (s) => {
      const tk = Math.min(180, s.D * 0.3);
      s.box(0, s.D - tk, 0, s.W, s.D, s.H, WHITE);
      s.cyl(s.W / 2, (s.D - tk) / 2, Math.min(s.W / 2 - 10, (s.D - tk) / 2), 0, 400, WHITE);
    },
  },
  basin: {
    label: 'Waschtisch',
    plan: (s) => { s.rect(0, 0, s.W, s.D); s.ell(s.W / 2, s.D * 0.45, s.W * 0.36, s.D * 0.3, s.pens.thin); s.circ(s.W / 2, s.D - 60, 22, s.pens.thin); },
    solids: (s) => s.box(0, 0, s.H - 160, s.W, s.D, s.H, WHITE),
  },
  shower: {
    label: 'Dusche',
    plan: (s) => { s.rect(0, 0, s.W, s.D); s.line(V(0, 0), V(s.W, s.D), s.pens.thin); s.line(V(0, s.D), V(s.W, 0), s.pens.thin); s.circ(s.W / 2, s.D / 2, 45, s.pens.thin); },
    solids: (s) => s.box(0, 0, 0, s.W, s.D, Math.max(20, s.H), WHITE),
  },
  bathtub: {
    label: 'Badewanne',
    plan: (s) => {
      s.rect(0, 0, s.W, s.D);
      const o = 70, r = Math.min(200, (s.D - 2 * o) / 2);
      const x0 = o, y0 = o, x1 = s.W - o, y1 = s.D - o;
      const pts = [
        ...arcPoints(V(x1 - r, y0 + r), r, -Math.PI / 2, 0, 8), ...arcPoints(V(x1 - r, y1 - r), r, 0, Math.PI / 2, 8),
        ...arcPoints(V(x0 + r, y1 - r), r, Math.PI / 2, Math.PI, 8), ...arcPoints(V(x0 + r, y0 + r), r, Math.PI, Math.PI * 1.5, 8),
      ];
      s.poly(pts, true, s.pens.thin);
      s.circ(s.W - o - 130, s.D / 2, 25, s.pens.thin);
    },
    solids: (s) => s.box(0, 0, 0, s.W, s.D, s.H, WHITE),
  },
  kitchen: {
    label: 'Küchenzeile',
    plan: (s) => {
      s.rect(0, 0, s.W, s.D);
      s.line(V(0, 40), V(s.W, 40), s.pens.thin);
      const n = Math.max(1, Math.round(s.W / 600));
      for (let k = 1; k < n; k++) { const x = (s.W * k) / n; s.line(V(x, 40), V(x, s.D), s.pens.thin); }
      // Oberschränke (über Schnitthöhe) gestrichelt
      s.rect(0, s.D - 350, s.W, s.D, s.pens.hid);
    },
    solids: (s) => {
      s.box(0, 50, 100, s.W, s.D, 870, WHITE);
      s.box(0, 0, 870, s.W, s.D, 910, '#9a8a70');
      if (s.H > 1500) s.box(0, s.D - 350, 1450, s.W, s.D, Math.min(s.H, 2200), WHITE);
    },
  },
  stove: {
    label: 'Herd',
    plan: (s) => {
      s.rect(0, 0, s.W, s.D);
      const r1 = Math.min(s.W, s.D) * 0.14, r2 = Math.min(s.W, s.D) * 0.1;
      s.circ(s.W * 0.28, s.D * 0.3, r1, s.pens.thin); s.circ(s.W * 0.72, s.D * 0.3, r2, s.pens.thin);
      s.circ(s.W * 0.28, s.D * 0.7, r2, s.pens.thin); s.circ(s.W * 0.72, s.D * 0.7, r1, s.pens.thin);
    },
    solids: (s) => { s.box(0, 0, 0, s.W, s.D, s.H - 10, METAL); s.box(0, 0, s.H - 10, s.W, s.D, s.H, '#202020'); },
  },
  sink: {
    label: 'Spüle',
    plan: (s) => {
      s.rect(0, 0, s.W, s.D);
      const bx1 = s.W * 0.5;
      s.rect(s.W * 0.06, s.D * 0.15, bx1, s.D * 0.78, s.pens.thin);
      for (let k = 1; k <= 4; k++) { const y = s.D * 0.15 + (s.D * 0.63 * k) / 5; s.line(V(bx1 + 60, y), V(s.W * 0.94, y), s.pens.thin); }
      s.circ(s.W * 0.28, s.D * 0.88, 22, s.pens.thin);
    },
    solids: (s) => { s.box(0, 50, 100, s.W, s.D, s.H - 40, WHITE); s.box(0, 0, s.H - 40, s.W, s.D, s.H, METAL); },
  },
  fridge: {
    label: 'Kühlschrank',
    plan: (s) => { s.rect(0, 0, s.W, s.D); s.rect(30, 30, s.W - 30, s.D - 30, s.pens.thin); s.line(V(30, 30), V(s.W - 30, s.D - 30), s.pens.thin); s.text(V(s.W / 2, s.D * 0.3), 'KS', 1.8); },
    solids: (s) => s.box(0, 0, 0, s.W, s.D, s.H, WHITE),
  },
  plant: {
    label: 'Pflanze', centered: true,
    plan: (s) => {
      const r = Math.min(s.W, s.D) / 2; const c = V(s.W / 2, s.D / 2);
      s.circ(c.x, c.y, r); s.circ(c.x, c.y, r * 0.18, s.pens.thin);
      for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; s.line(add(c, mul(V(Math.cos(a), Math.sin(a)), r * 0.3)), add(c, mul(V(Math.cos(a + 0.25), Math.sin(a + 0.25)), r * 0.85)), s.pens.thin); }
    },
    solids: (s) => { const r = Math.min(s.W, s.D) / 2; s.cyl(s.W / 2, s.D / 2, r * 0.45, 0, s.H * 0.3, '#a06040'); s.cyl(s.W / 2, s.D / 2, r, s.H * 0.3, s.H, GREEN); },
  },
  tree: {
    label: 'Baum', centered: true,
    plan: (s) => {
      const r = Math.min(s.W, s.D) / 2; const c = V(s.W / 2, s.D / 2);
      const pts: V2[] = [];
      for (let k = 0; k < 72; k++) { const a = (k * Math.PI * 2) / 72; const rr = r * (0.9 + 0.1 * Math.cos(a * 12)); pts.push(add(c, V(Math.cos(a) * rr, Math.sin(a) * rr))); }
      s.poly(pts, true);
      s.circ(c.x, c.y, Math.min(200, r * 0.08), s.pens.thin);
      s.line(add(c, V(-r * 0.25, 0)), add(c, V(r * 0.25, 0)), s.pens.thin); s.line(add(c, V(0, -r * 0.25)), add(c, V(0, r * 0.25)), s.pens.thin);
    },
    solids: (s) => { const r = Math.min(s.W, s.D) / 2; s.cyl(s.W / 2, s.D / 2, Math.min(200, r * 0.08), 0, s.H * 0.4, '#7a5a3a'); s.cyl(s.W / 2, s.D / 2, r, s.H * 0.35, s.H, GREEN); },
  },
};
export const symOptions = (): [string, string][] => Object.entries(SYMBOLS).map(([k, v]) => [k, v.label]);

// ------------------------------------------------------------ Lokal ↔ Welt
function frame(c: { p: V2; rot: number; flip?: boolean }, t: CompType | undefined) {
  const W = t?.width ?? 1000, D = t?.depth ?? 600;
  const centered = SYMBOLS[t?.sym ?? 'table']?.centered;
  const ins = centered ? V(W / 2, D / 2) : V(W / 2, D);
  const co = Math.cos(c.rot ?? 0), si = Math.sin(c.rot ?? 0); const f = c.flip ? -1 : 1;
  const L2W = (q: V2): V2 => { const x = (q.x - ins.x) * f, y = q.y - ins.y; return { x: c.p.x + x * co - y * si, y: c.p.y + x * si + y * co }; };
  return { W, D, L2W };
}

export function drawComponent(dl: DisplayList, c: { p: V2; rot: number; flip?: boolean }, t: CompType | undefined, pen: Pen, fill = true): void {
  if (!t) return;
  const { W, D, L2W } = frame(c, t);
  const sym = SYMBOLS[t.sym] ?? SYMBOLS.table;
  const pens: SymPen = { pen, thin: { w: 1, color: pen.color }, hid: { w: 1, color: pen.color, dash: 'hidden' } };
  const sc = app.activeView()?.scale ?? 100;
  const ctx: SymCtx = {
    W, D, H: t.height ?? 750, pens,
    line: (a, b, p = pen) => dl.line(L2W(a), L2W(b), p),
    poly: (pts, closed = false, p = pen) => dl.poly(pts.map(L2W), p, closed),
    rect: (x0, y0, x1, y1, p = pen) => dl.poly([V(x0, y0), V(x1, y0), V(x1, y1), V(x0, y1)].map(L2W), p, true),
    ell: (cx, cy, rx, ry, p = pen) => { const pts: V2[] = []; for (let k = 0; k < 32; k++) { const a = (k * Math.PI * 2) / 32; pts.push(L2W(V(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry))); } dl.poly(pts, p, true); },
    circ: (cx, cy, r, p = pen) => dl.circle(L2W(V(cx, cy)), r, p),
    text: (p, s, size) => { if (Math.min(W, D) > size * sc * 2) dl.text(L2W(p), s, { size, ha: 'center', va: 'middle', color: pen.color, rot: (c.rot ?? 0) }); },
  };
  if (fill) dl.fill([[V(0, 0), V(W, 0), V(W, D), V(0, D)].map(L2W)], { color: 'transparent' }, undefined, { ns: true });
  sym.plan(ctx);
}

function compSolids(doc: Doc, c: El): Solid[] {
  const t = compType(doc, c); if (!t) return [];
  const { W, D, L2W } = frame(c as Component, t);
  const z0 = levelElev(doc, c.levelId) + (c.offset ?? 0);
  const out: Solid[] = [];
  const base = t.color;
  const sym = SYMBOLS[t.sym] ?? SYMBOLS.table;
  const s: SolCtx = {
    W, D, H: t.height ?? 750,
    box: (x0, y0, za, x1, y1, zb, color) => {
      if (x1 - x0 < 0.5 || y1 - y0 < 0.5 || zb - za < 0.5) return;
      const ring = [V(x0, y0), V(x1, y0), V(x1, y1), V(x0, y1)].map(L2W);
      out.push({ faces: prism(ring, z0 + za, z0 + zb), mat: t.mat, color: base ?? color, noCut: true });
    },
    cyl: (cx, cy, r, za, zb, color) => {
      if (r < 1 || zb - za < 0.5) return;
      const ring = arcPoints(V(cx, cy), r, 0, Math.PI * 2 - 1e-6, 12).slice(0, -1).map(L2W);
      out.push({ faces: prism(ring, z0 + za, z0 + zb), mat: t.mat, color: base ?? color, noCut: true });
    },
  };
  sym.solids(s);
  return out;
}

function compProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Versatz', group: g.constraints, type: 'length', get: (e) => e.offset ?? 0, set: (_e, v) => ({ offset: v }) },
    { key: 'rot', label: 'Drehung', group: g.constraints, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) },
    { key: 'flip', label: 'Gespiegelt', group: g.constraints, type: 'bool', get: (e) => !!e.flip, set: (_e, v) => ({ flip: v }) },
    ...identityProps(),
  ];
}
function compTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'family', label: 'Familie', group: g.identity, type: 'select', options: [['Möbel', 'Möbel'], ['Sanitär', 'Sanitär'], ['Küche', 'Küche'], ['Bepflanzung', 'Bepflanzung']], get: (t) => t.family ?? 'Möbel', set: (_t, v) => ({ family: v }) },
    { key: 'sym', label: 'Symbol', group: g.graphics, type: 'select', options: symOptions(), get: (t) => t.sym ?? 'table', set: (_t, v) => ({ sym: v }) },
    { key: 'width', label: 'Breite', group: g.dims, type: 'length', get: (t) => t.width, set: (_t, v) => ({ width: Math.max(10, v) }) },
    { key: 'depth', label: 'Tiefe', group: g.dims, type: 'length', get: (t) => t.depth, set: (_t, v) => ({ depth: Math.max(10, v) }) },
    { key: 'height', label: 'Höhe', group: g.dims, type: 'length', get: (t) => t.height, set: (_t, v) => ({ height: Math.max(10, v) }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'color', label: 'Farbe (3D)', group: g.materials, type: 'color', get: (t) => t.color ?? '#c8a878', set: (_t, v) => ({ color: v }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

/** Drehung/Spiegelung eines lokalen Rahmens nach Transformation */
function transformFrame(c: El, m: Mat2): Partial<Component> {
  const co = Math.cos(c.rot ?? 0), si = Math.sin(c.rot ?? 0); const f = c.flip ? -1 : 1;
  const wx = applyVec(m, { x: co * f, y: si * f }); const wy = applyVec(m, { x: -si, y: co });
  return { p: apply(m, c.p), rot: angleOf(wy) - Math.PI / 2, flip: cross(wx, wy) < 0 };
}

registerCategory({
  cat: 'component', label: 'Bauteil', plural: 'Bauteile', hasTypes: true, planOrder: 35,
  drawPlan: (ctx, el) => {
    if (ctx.ceiling) return;
    const t = compType(ctx.doc, el); if (!t) return;
    const z0 = levelElev(ctx.doc, el.levelId) + (el.offset ?? 0);
    if (!(z0 <= ctx.cutZ + 1 && z0 + (t.height ?? 750) >= ctx.depthZ - 1)) return;
    drawComponent(ctx.dl, el as Component, t, catPen(ctx.doc, 'component', false));
  },
  solids: (el, doc) => compSolids(doc, el),
  grips: (el, doc, view) => {
    if (!isPlanLike(view)) return [];
    const t = compType(doc, el); const { L2W, W, D } = frame(el as Component, t);
    return [{ id: 'rot', p: L2W(V(W / 2, SYMBOLS[t?.sym ?? 'table']?.centered ? D + view.scale * 4 : D + view.scale * 4)), kind: 'end', tip: 'Drehen' }];
  },
  dragGrip: (el, id, p) => { if (id === 'rot' && dist(p, el.p) > 10) return { rot: angleOf(sub(p, el.p)) - Math.PI / 2 }; },
  transform: (el, m, _doc, view) => (isPlanLike(view) ? transformFrame(el, m) : undefined),
  translate3d: (el, d) => ({ p: { x: el.p.x + d.x, y: el.p.y + d.y }, offset: (el.offset ?? 0) + d.z }),
  center: (el) => el.p,
  props: () => compProps(),
  typeProps: () => compTypeProps(),
  tagText: (el, doc) => compType(doc, el)?.name ?? '',
  tagPoint: (el) => el.p,
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => compType(doc, el)?.name ?? '' },
    { key: 'family', label: 'Familie', get: (el, doc) => compType(doc, el)?.family ?? '' },
    { key: 'level', label: 'Ebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'width', label: 'Breite', unit: 'len', get: (el, doc) => compType(doc, el)?.width ?? 0 },
    { key: 'depth', label: 'Tiefe', unit: 'len', get: (el, doc) => compType(doc, el)?.depth ?? 0 },
    { key: 'height', label: 'Höhe', unit: 'len', get: (el, doc) => compType(doc, el)?.height ?? 0 },
  ],
});

// ------------------------------------------------------------ Platzieren
const CO = { rotateAfter: false };
class ComponentTool extends Tool {
  id = 'component'; label = 'Bauteil'; kinds = ['plan'];
  private cur: V2 | null = null; private placed: V2 | null = null;
  activate(): void {
    const lvl = activeLevelId();
    this.placement = placementFor('component', { levelId: lvl, offset: 0, rot: 0, typeId: 'cpt_tisch160' });
    this.placement.proto.levelId = lvl;
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return this.placed ? 'Klicken Sie, um die Drehung festzulegen.' : 'Klicken Sie, um das Bauteil zu platzieren. Leertaste dreht um 90°.'; }
  basePoint(): V2 | null { return this.placed; }
  options(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'check', key: 'rotAfter', label: 'Nach Platzierung drehen', value: CO.rotateAfter, onChange: (v) => { CO.rotateAfter = v; } },
      { kind: 'angle', key: 'rot', label: 'Drehung', value: p.rot ?? 0, onChange: (v) => { p.rot = v; app.redrawOverlay(); } },
    ];
  }
  space(): boolean { const p = this.placement!.proto; p.rot = ((p.rot ?? 0) + Math.PI / 2) % (Math.PI * 2); app.emit('tool'); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const p = this.placement!.proto;
    if (CO.rotateAfter && !this.placed) { this.placed = e.p; return; }
    const pos = this.placed ?? e.p;
    const rot = this.placed && dist(this.placed, e.p) > 10 ? angleOf(sub(e.p, this.placed)) : p.rot ?? 0;
    const { id: _i, ...rest } = p;
    let id = '';
    app.doc.transaction('Bauteil platzieren', () => {
      id = app.doc.add<Component>({ ...rest, id: newId('cp'), cat: 'component', p: pos, rot, levelId: p.levelId || activeLevelId(e.view), offset: p.offset ?? 0 } as Component).id;
    });
    this.placed = null;
    void id;
  }
  escape(): boolean { if (this.placed) { this.placed = null; return true; } return false; }
  preview(dl: DisplayList): void {
    const p = this.placement?.proto; if (!p || !this.cur) return;
    const t = app.doc.get<CompType>(p.typeId);
    const pos = this.placed ?? this.cur;
    const rot = this.placed && dist(this.placed, this.cur) > 10 ? angleOf(sub(this.cur, this.placed)) : p.rot ?? 0;
    drawComponent(dl, { p: pos, rot, flip: p.flip }, t, PREVIEW, false);
    if (this.placed) dl.line(this.placed, this.cur, { w: 1, color: '#1e6fd9', dash: 'dash' });
  }
}

registerCommand({ id: 'component', label: 'Bauteil', icon: 'component', keys: ['CM'], tip: 'Bauteil platzieren (Möbel, Sanitär, Küche, Bepflanzung). Leertaste dreht um 90°.', run: () => startTool(new ComponentTool(), 'component') });
registerSimilar('component', 'component');

