// Türen und Fenster: in Wände eingesetzte (gehostete) Bauteile.
import type { Doc, El, Id } from '../core/doc';
import { V2, add, sub, mul, dot, norm, perp, mid, apply, Mat2, isMirror, projectT, sideDist, cross, lineLine, V3, closestOnLine } from '../core/geom';
import { registerCategory, CategoryDef, PlanCtx, SectionCtx, Solid, PropDef, GROUPS, TempDim, Grip } from '../core/registry';
import { TypeEl, levelElev, View, isPlanLike } from '../core/view';
import { Wall, wallInfo, WallInfo, wallAt, wallBounds, profMax } from './wall';
import { box3, catPen } from '../views/sectionEngine';
import { fmtLen } from '../core/units';
import { DisplayList } from '../render/displayList';

export interface DoorType extends TypeEl {
  of: 'door';
  width: number; height: number;
  kind: 'single' | 'double' | 'sliding' | 'opening';
  frame: number;          // Zargenbreite
  leafT: number;          // Blattdicke
  mat?: Id;
  description?: string;
}
export interface WindowType extends TypeEl {
  of: 'window';
  width: number; height: number; sill: number;
  kind: 'single' | 'double' | 'fixed' | 'triple';
  frame: number; frameDepth: number;
  sillDepth: number;      // Fensterbank innen
  mat?: Id; glassMat?: Id;
  description?: string;
}
export interface Opening extends El {
  cat: 'door' | 'window';
  hostId: Id;
  t: number;              // Mitte entlang Basislinie der Wand ab Startpunkt
  sill: number;           // Brüstungshöhe über Basis der Wand-Ebene
  flipFacing?: boolean;
  flipHand?: boolean;
}

export function openingType(doc: Doc, o: Opening): (DoorType | WindowType) | undefined { return doc.get(o.typeId) as any; }
export function openingWidth(doc: Doc, o: Opening): number { return openingType(doc, o)?.width ?? 1000; }
export function openingHeight(doc: Doc, o: Opening): number { return openingType(doc, o)?.height ?? 2000; }
export function hostOf(doc: Doc, o: Opening): Wall | undefined { return doc.get<Wall>(o.hostId); }
/** absolute Unterkante (Tür in Wand mit Unterkantenprofil, z.B. auf einer Rampe: höchster Punkt der Wandunterkante im Türbereich + Brüstung) */
export function openingZ0(doc: Doc, o: Opening): number {
  const w = hostOf(doc, o);
  const base = w && o.cat === 'door' ? wallBounds(doc, w).base : null;
  if (base) { const W = openingWidth(doc, o); return profMax(base, o.t - W / 2, o.t + W / 2) + (o.sill ?? 0); }
  return levelElev(doc, w?.levelId) + (o.sill ?? 0);
}

interface Local { wi: WallInfo; u0: number; u1: number; um: number; T: number; P: (u: number, v: number) => V2; side: 1 | -1; hand: 1 | -1; }
function local(doc: Doc, o: Opening): Local | null {
  const w = hostOf(doc, o); if (!w) return null;
  const wi = wallInfo(doc, w); const W = openingWidth(doc, o);
  const P = (u: number, v: number) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
  // Aufschlagseite: standardmäßig Innenseite (gegenüber der Außenseite)
  const side = ((o.flipFacing ? 1 : -1) * wi.ext) as 1 | -1;
  return { wi, u0: o.t - W / 2, u1: o.t + W / 2, um: o.t, T: wi.T, P, side, hand: o.flipHand ? -1 : 1 };
}

// ------------------------------------------------------------ Grundriss
function drawDoorPlan(ctx: PlanCtx, o: Opening): void {
  const { doc, dl } = ctx; const L = local(doc, o); if (!L) return;
  const t = openingType(doc, o) as DoorType | undefined;
  const z0 = openingZ0(doc, o), z1 = z0 + openingHeight(doc, o);
  if (!(L.wi.z0 <= ctx.cutZ && L.wi.z1 > ctx.cutZ)) return;
  if (!(z0 <= ctx.cutZ && z1 >= ctx.cutZ)) return;
  const pen = catPen(doc, 'door', false); const thin = { w: 1 };
  const fr = t?.frame ?? 50; const kind = t?.kind ?? 'single';
  const { P, side, T } = L;
  const vFace = (side * T) / 2;
  // Zarge
  if (ctx.detail !== 'coarse') {
    for (const [ua, ub] of [[L.u0, L.u0 + fr], [L.u1 - fr, L.u1]]) dl.poly([P(ua, -T / 2), P(ub, -T / 2), P(ub, T / 2), P(ua, T / 2)], thin, true);
  }
  const lw = L.u1 - L.u0 - 2 * fr; const lt = t?.leafT ?? 40;
  const leaf = (hu: number, dirU: number, width: number) => {
    // geöffnetes Blatt (90°) und Schwenkbogen
    const H = P(hu, vFace); const tip = P(hu, vFace + side * width);
    if (ctx.detail === 'coarse') dl.line(H, tip, pen);
    else {
      const off = -dirU * lt;
      dl.poly([H, tip, P(hu + off, vFace + side * width), P(hu + off, vFace)], pen, true);
    }
    const end = P(hu + dirU * width, vFace);
    // Bogen von tip nach end um H
    const a0 = Math.atan2(tip.y - H.y, tip.x - H.x), a1 = Math.atan2(end.y - H.y, end.x - H.x);
    let s = a1 - a0; while (s > Math.PI) s -= 2 * Math.PI; while (s < -Math.PI) s += 2 * Math.PI;
    if (s >= 0) dl.arc(H, width, a0, a1, thin, { ns: true }); else dl.arc(H, width, a1, a0, thin, { ns: true });
  };
  if (kind === 'single') {
    const hu = L.hand > 0 ? L.u0 + fr : L.u1 - fr;
    leaf(hu, L.hand > 0 ? 1 : -1, lw);
  } else if (kind === 'double') {
    leaf(L.u0 + fr, 1, lw / 2); leaf(L.u1 - fr, -1, lw / 2);
  } else if (kind === 'sliding') {
    const v = vFace + side * (lt + 10);
    const du = L.hand > 0 ? 0 : 0;
    dl.poly([P(L.u0 + fr + du, v), P(L.u1 - fr, v), P(L.u1 - fr, v + side * lt), P(L.u0 + fr, v + side * lt)], pen, true);
    const ay = v + side * (lt + 60);
    dl.line(P(L.um - 150, ay), P(L.um + 150, ay), thin, { ns: true });
    dl.line(P(L.um + 150, ay), P(L.um + 100, ay + 30), thin, { ns: true });
    dl.line(P(L.um + 150, ay), P(L.um + 100, ay - 30), thin, { ns: true });
  }
  // unsichtbare Auswahlfläche über der Öffnung
  dl.fill([[P(L.u0, -T / 2), P(L.u1, -T / 2), P(L.u1, T / 2), P(L.u0, T / 2)]], { color: 'transparent' }, undefined, { ns: true });
}

function drawWindowPlan(ctx: PlanCtx, o: Opening): void {
  const { doc, dl } = ctx; const L = local(doc, o); if (!L) return;
  const t = openingType(doc, o) as WindowType | undefined;
  if (!(L.wi.z0 <= ctx.cutZ && L.wi.z1 > ctx.cutZ)) return;
  const z0 = openingZ0(doc, o), z1 = z0 + openingHeight(doc, o);
  const above = z0 > ctx.cutZ;
  const pen = above ? { w: 1, dash: 'hidden' as const } : catPen(doc, 'window', true);
  const thin = above ? { w: 1, dash: 'hidden' as const } : { w: 1 };
  const { P, T } = L; const fd = Math.min(t?.frameDepth ?? 70, T);
  const vc = 0;
  if (!above) {
    // Wandflächen durchziehen (Fensterbank-/Laibungslinien)
    dl.line(P(L.u0, T / 2), P(L.u1, T / 2), thin);
    dl.line(P(L.u0, -T / 2), P(L.u1, -T / 2), thin);
  }
  // Rahmen
  dl.poly([P(L.u0, vc - fd / 2), P(L.u1, vc - fd / 2), P(L.u1, vc + fd / 2), P(L.u0, vc + fd / 2)], pen, true);
  dl.line(P(L.u0, vc), P(L.u1, vc), thin, { ns: true });
  if (ctx.detail !== 'coarse' && !above) {
    const fr = t?.frame ?? 60;
    dl.line(P(L.u0 + fr, vc - fd / 2), P(L.u0 + fr, vc + fd / 2), thin, { ns: true });
    dl.line(P(L.u1 - fr, vc - fd / 2), P(L.u1 - fr, vc + fd / 2), thin, { ns: true });
    if (t?.kind === 'double' || t?.kind === 'triple') {
      const n = t.kind === 'double' ? 2 : 3;
      for (let i = 1; i < n; i++) { const u = L.u0 + ((L.u1 - L.u0) * i) / n; dl.line(P(u, vc - fd / 2), P(u, vc + fd / 2), thin, { ns: true }); }
    }
    // Fensterbank innen
    const sd = t?.sillDepth ?? 0;
    if (sd > 0) {
      const inner = -L.wi.ext as 1 | -1; const v0 = (inner * T) / 2;
      dl.poly([P(L.u0 - 20, v0), P(L.u0 - 20, v0 + inner * sd * 0.25), P(L.u1 + 20, v0 + inner * sd * 0.25), P(L.u1 + 20, v0)], thin, false, { ns: true });
    }
  }
  dl.fill([[P(L.u0, -T / 2), P(L.u1, -T / 2), P(L.u1, T / 2), P(L.u0, T / 2)]], { color: 'transparent' }, undefined, { ns: true });
}

// ------------------------------------------------------------ 3D
function openingSolids(doc: Doc, o: Opening): Solid[] {
  const L = local(doc, o); if (!L) return [];
  const t = openingType(doc, o) as any;
  const z0 = openingZ0(doc, o), H = openingHeight(doc, o);
  const isDoor = o.cat === 'door';
  const fr = t?.frame ?? (isDoor ? 50 : 60);
  const fd = Math.min(isDoor ? L.T : t?.frameDepth ?? 70, L.T);
  const d3: V3 = { x: L.wi.d.x, y: L.wi.d.y, z: 0 }; const n3: V3 = { x: L.wi.n.x, y: L.wi.n.y, z: 0 }; const up: V3 = { x: 0, y: 0, z: 1 };
  const at = (u: number, v: number, z: number): V3 => { const p = L.P(u, v); return { x: p.x, y: p.y, z }; };
  const W = L.u1 - L.u0;
  const frameMat = t?.mat;
  const vc = isDoor ? 0 : 0;
  const v0 = vc - fd / 2;
  const B = (u: number, v: number, z: number, du: number, dv: number, dz: number) => box3(at(u, v, z), { x: d3.x * du, y: d3.y * du, z: 0 }, { x: n3.x * dv, y: n3.y * dv, z: 0 }, { x: 0, y: 0, z: dz });
  const out: Solid[] = [];
  const frame: Solid = { faces: [], mat: frameMat, color: isDoor ? '#c8a878' : '#f2f2f2', role: 'frame' };
  frame.faces.push(...B(L.u0, v0, z0, fr, fd, H), ...B(L.u1 - fr, v0, z0, fr, fd, H), ...B(L.u0 + fr, v0, z0 + H - fr, W - 2 * fr, fd, fr));
  if (!isDoor) frame.faces.push(...B(L.u0 + fr, v0, z0, W - 2 * fr, fd, fr));
  out.push(frame);
  if (isDoor) {
    const lt = t?.leafT ?? 40; const vF = (L.side * L.T) / 2 - (L.side > 0 ? lt : 0);
    if ((t?.kind ?? 'single') !== 'opening') out.push({ faces: B(L.u0 + fr, vF, z0, W - 2 * fr, lt, H - fr), mat: frameMat, color: '#b08850', role: 'leaf' });
  } else {
    out.push({ faces: B(L.u0 + fr, vc - 10, z0 + fr, W - 2 * fr, 20, H - 2 * fr), mat: t?.glassMat, color: '#a8d0e8', role: 'glass', noCut: true });
    const sd = t?.sillDepth ?? 0;
    if (sd > 0) {
      // Fensterbank innen: von Rahmeninnenkante bis 30 mm vor die Innenfläche
      const inner = -L.wi.ext;
      const va = (inner * fd) / 2, vb = inner * (L.T / 2 + 30);
      out.push({ faces: B(L.u0 - 20, Math.min(va, vb), z0 - 30, W + 40, Math.abs(vb - va), 30), color: '#e8e8e8', role: 'sill' });
    }
  }
  return out;
}

// Öffnungsrichtung in Ansichten (Dreh-Kipp-Symbol)
/** Symbol nur zeichnen, wenn die Außenseite der Wand zum Betrachter zeigt (einfache Verdeckungsregel) */
function facesViewer(ctx: SectionCtx, L: Local): boolean {
  const ext = { x: L.wi.n.x * L.wi.ext, y: L.wi.n.y * L.wi.ext };
  return ext.x * ctx.dir.x + ext.y * ctx.dir.y < -0.9;
}

function drawWindowSection(ctx: SectionCtx, o: Opening): void {
  const L = local(ctx.doc, o); if (!L) return;
  if (!facesViewer(ctx, L)) return;
  const t = openingType(ctx.doc, o) as WindowType | undefined;
  if (!t || t.kind === 'fixed') return;
  const z0 = openingZ0(ctx.doc, o), H = t.height; const fr = t.frame ?? 60;
  const dep = ctx.depth({ ...L.P(L.um, 0), z: z0 });
  if (dep < 0 || dep > ctx.far) return;
  const pen = { w: 1, dash: 'dash' as const };
  const n = t.kind === 'double' ? 2 : t.kind === 'triple' ? 3 : 1;
  const W = (L.u1 - L.u0 - 2 * fr) / n;
  for (let i = 0; i < n; i++) {
    const ua = L.u0 + fr + i * W, ub = ua + W;
    const q = (u: number, z: number) => ctx.toView({ ...L.P(u, 0), z });
    const za = z0 + fr, zb = z0 + H - fr;
    // Drehflügel: Spitze zur Bandseite
    const hingeLeft = (i % 2 === 0) !== !!o.flipHand;
    const hu = hingeLeft ? ua : ub, fu = hingeLeft ? ub : ua;
    ctx.dl.poly([q(fu, za), q(hu, (za + zb) / 2), q(fu, zb)], pen, false, { ns: true });
    if (n === 1 || i === 0) ctx.dl.poly([q(ua, zb), q((ua + ub) / 2, za), q(ub, zb)], pen, false, { ns: true });
  }
}

function drawDoorSection(ctx: SectionCtx, o: Opening): void {
  const L = local(ctx.doc, o); if (!L) return;
  if (!facesViewer(ctx, L)) return;
  const t = openingType(ctx.doc, o) as DoorType | undefined;
  if (!t || t.kind === 'opening' || t.kind === 'sliding') return;
  const z0 = openingZ0(ctx.doc, o); const fr = t.frame ?? 50;
  const dep = ctx.depth({ ...L.P(L.um, 0), z: z0 });
  if (dep < 0 || dep > ctx.far) return;
  const pen = { w: 1, dash: 'dash' as const };
  const q = (u: number, z: number) => ctx.toView({ ...L.P(u, 0), z });
  const ua = L.u0 + fr, ub = L.u1 - fr; const zb = z0 + t.height - fr;
  if (t.kind === 'double') {
    const um = (ua + ub) / 2;
    ctx.dl.poly([q(um, z0), q(ua, (z0 + zb) / 2), q(um, zb)], pen, false, { ns: true });
    ctx.dl.poly([q(um, z0), q(ub, (z0 + zb) / 2), q(um, zb)], pen, false, { ns: true });
  } else {
    const hu = L.hand > 0 ? ua : ub, fu = L.hand > 0 ? ub : ua;
    ctx.dl.poly([q(fu, z0), q(hu, (z0 + zb) / 2), q(fu, zb)], pen, false, { ns: true });
  }
}

// ------------------------------------------------------------ Bearbeitung
function openingTempDims(doc: Doc, o: Opening, view: View): TempDim[] {
  if (!isPlanLike(view)) return [];
  const L = local(doc, o); if (!L) return [];
  const wi = L.wi;
  // Bezugskanten entlang der Wand: Endflächen der Wand und Flächen kreuzender Wände
  const refs: number[] = [];
  for (const w of doc.all<Wall>('wall')) {
    const oi = wallInfo(doc, w);
    if (oi.w.id === wi.w.id) {
      refs.push(dot(sub(oi.c0, wi.c0), wi.d), dot(sub(oi.c1, wi.c0), wi.d));
      continue;
    }
    if (Math.abs(cross(oi.d, wi.d)) < 0.2) continue;
    if (!(oi.z0 < wi.z1 && wi.z0 < oi.z1)) continue;
    const x = lineLine(wi.c0, wi.c1, oi.c0, oi.c1);
    if (!x || x.u < -0.02 || x.u > 1.02 || x.t < -0.05 || x.t > 1.05) continue;
    const u = dot(sub(x.p, wi.c0), wi.d);
    const s = Math.abs(cross(oi.d, wi.d));
    refs.push(u - oi.T / 2 / s, u + oi.T / 2 / s);
  }
  const left = refs.filter((u) => u <= L.u0 + 0.5).sort((a, b) => b - a)[0];
  const right = refs.filter((u) => u >= L.u1 - 0.5).sort((a, b) => a - b)[0];
  const dims: TempDim[] = [];
  const v = wi.ext * (wi.T / 2 + view.scale * 5);
  if (left !== undefined) dims.push({ a: L.P(left, v), b: L.P(L.u0, v), value: L.u0 - left, apply: (val) => doc.update(o.id, { t: o.t + (left + val - L.u0) }) });
  if (right !== undefined) dims.push({ a: L.P(L.u1, v), b: L.P(right, v), value: right - L.u1, apply: (val) => doc.update(o.id, { t: o.t - (right - val - L.u1) }) });
  return dims;
}

function openingGrips(doc: Doc, o: Opening, view: View): Grip[] {
  if (!isPlanLike(view)) return [];
  const L = local(doc, o); if (!L) return [];
  const s = view.scale;
  return [
    { id: 'facing', p: L.P(L.um, L.side * (L.T / 2 + s * 5)), kind: 'flip', dir: L.wi.n, tip: 'Aufschlagrichtung umkehren' },
    { id: 'hand', p: L.P(L.um + s * 5, -L.side * (L.T / 2 + s * 4)), kind: 'flip', dir: L.wi.d, tip: 'Anschlagseite umkehren' },
  ];
}

/** Position aus Punkt im Grundriss bestimmen (ggf. neuen Host suchen) */
export function placeOnWall(doc: Doc, o: Opening, p: V2): Partial<Opening> | void {
  let w = hostOf(doc, o);
  if (w) {
    const wi = wallInfo(doc, w);
    const t = projectT(p, wi.c0, wi.c1);
    if (t >= 0 && t <= 1 && Math.abs(sideDist(p, wi.c0, wi.c1)) <= wi.T / 2 + 50) return { t: dot(sub(p, wi.c0), wi.d) };
  }
  const nw = wallAt(doc, p, null, 50);
  if (nw) { const wi = wallInfo(doc, nw); return { hostId: nw.id, levelId: nw.levelId, t: dot(sub(p, wi.c0), wi.d) }; }
  if (w) { const wi = wallInfo(doc, w); return { t: Math.max(0, Math.min(wi.L, dot(sub(p, wi.c0), wi.d))) }; }
}

function openingProps(isDoor: boolean): PropDef[] {
  const g = GROUPS;
  const props: PropDef[] = [
    { key: 'level', label: 'Ebene', group: g.constraints, type: 'readonly', get: (e, doc) => doc.get(hostOf(doc, e as Opening)?.levelId)?.name ?? '' },
    { key: 'sill', label: 'Brüstungshöhe', group: g.constraints, type: 'length', get: (e) => e.sill ?? 0, set: (_e, v) => ({ sill: v }) },
    { key: 'head', label: 'Sturzhöhe', group: g.constraints, type: 'length', get: (e, doc) => (e.sill ?? 0) + openingHeight(doc, e as Opening), set: (e, v, doc) => ({ sill: v - openingHeight(doc, e as Opening) }) },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => doc.get(e.hostId)?.typeId ? (doc.get(doc.get(e.hostId)!.typeId)?.name ?? '') : '' },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
  if (isDoor) props.splice(2, 1);
  return props;
}

function openingTypeProps(isDoor: boolean): PropDef[] {
  const g = GROUPS;
  const p: PropDef[] = [
    { key: 'width', label: 'Breite', group: g.dims, type: 'length', get: (t) => t.width, set: (_t, v) => ({ width: v }) },
    { key: 'height', label: 'Höhe', group: g.dims, type: 'length', get: (t) => t.height, set: (_t, v) => ({ height: v }) },
    { key: 'frame', label: isDoor ? 'Zargenbreite' : 'Rahmenbreite', group: g.construction, type: 'length', get: (t) => t.frame, set: (_t, v) => ({ frame: v }) },
    { key: 'kind', label: 'Bauart', group: g.construction, type: 'select',
      options: isDoor ? [['single', 'Einflügelig'], ['double', 'Zweiflügelig'], ['sliding', 'Schiebetür'], ['opening', 'Durchgang (ohne Blatt)']] : [['single', 'Einflügelig (Dreh-Kipp)'], ['double', 'Zweiflügelig'], ['triple', 'Dreiflügelig'], ['fixed', 'Festverglasung']],
      get: (t) => t.kind, set: (_t, v) => ({ kind: v }) },
    { key: 'mat', label: isDoor ? 'Material Tür' : 'Material Rahmen', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
  if (isDoor) p.push({ key: 'leafT', label: 'Blattdicke', group: g.construction, type: 'length', get: (t) => t.leafT ?? 40, set: (_t, v) => ({ leafT: v }) });
  else p.push(
    { key: 'sill', label: 'Standard-Brüstungshöhe', group: g.dims, type: 'length', get: (t) => t.sill, set: (_t, v) => ({ sill: v }) },
    { key: 'frameDepth', label: 'Rahmentiefe', group: g.construction, type: 'length', get: (t) => t.frameDepth, set: (_t, v) => ({ frameDepth: v }) },
    { key: 'sillDepth', label: 'Fensterbanktiefe', group: g.construction, type: 'length', get: (t) => t.sillDepth ?? 0, set: (_t, v) => ({ sillDepth: v }) },
  );
  return p;
}

function makeDef(cat: 'door' | 'window'): CategoryDef {
  const isDoor = cat === 'door';
  return {
    cat, label: isDoor ? 'Tür' : 'Fenster', plural: isDoor ? 'Türen' : 'Fenster', hasTypes: true, planOrder: 20,
    drawPlan: (ctx, el) => (isDoor ? drawDoorPlan(ctx, el as Opening) : drawWindowPlan(ctx, el as Opening)),
    drawSection: (ctx, el) => (isDoor ? drawDoorSection(ctx, el as Opening) : drawWindowSection(ctx, el as Opening)),
    solids: (el, doc) => openingSolids(doc, el as Opening),
    hostOpening: (el, doc) => {
      const o = el as Opening; const w = hostOf(doc, o); if (!w) return null;
      const W = openingWidth(doc, o); const z0 = openingZ0(doc, o);
      return { u0: o.t - W / 2, u1: o.t + W / 2, z0, z1: z0 + openingHeight(doc, o) };
    },
    center: (el, doc) => { const L = local(doc, el as Opening); return L ? L.P(L.um, 0) : null; },
    grips: (el, doc, view) => openingGrips(doc, el as Opening, view),
    clickGrip: (el, id) => (id === 'facing' ? { flipFacing: !el.flipFacing } : id === 'hand' ? { flipHand: !el.flipHand } : undefined),
    transform: (el, m, doc, view) => {
      if (!isPlanLike(view)) return;
      const o = el as Opening; const L = local(doc, o); if (!L) return;
      const np = apply(m, L.P(L.um, 0));
      const patch = placeOnWall(doc, o, np) ?? {};
      if (isMirror(m)) { (patch as any).flipHand = !o.flipHand; }
      return patch;
    },
    translate3d: (el, d, doc) => {
      const o = el as Opening; const L = local(doc, o); if (!L) return;
      return { t: o.t + d.x * L.wi.d.x + d.y * L.wi.d.y, sill: (o.sill ?? 0) + d.z };
    },
    tempDims: (el, doc, view) => openingTempDims(doc, el as Opening, view),
    props: () => openingProps(isDoor),
    typeProps: () => openingTypeProps(isDoor),
    tagText: (el, doc) => (isDoor ? (el.mark || '?') : (openingType(doc, el as Opening)?.name ?? '')),
    tagPoint: (el, doc) => { const L = local(doc, el as Opening); return L ? L.P(L.um, 0) : null; },
    scheduleFields: () => [
      { key: 'type', label: 'Typ', get: (el, doc) => openingType(doc, el as Opening)?.name ?? '' },
      { key: 'width', label: 'Breite', unit: 'len', get: (el, doc) => openingWidth(doc, el as Opening) },
      { key: 'height', label: 'Höhe', unit: 'len', get: (el, doc) => openingHeight(doc, el as Opening) },
      { key: 'sill', label: 'Brüstungshöhe', unit: 'len', get: (el) => el.sill ?? 0 },
      { key: 'level', label: 'Ebene', get: (el, doc) => doc.get(hostOf(doc, el as Opening)?.levelId)?.name ?? '' },
      { key: 'host', label: 'Wandtyp', get: (el, doc) => { const w = doc.get(el.hostId); return w ? doc.get(w.typeId)?.name ?? '' : ''; } },
    ],
  };
}
registerCategory(makeDef('door'));
registerCategory(makeDef('window'));

/** Nächstes freies Kennzeichen für Türen */
export function nextMark(doc: Doc, cat: string): string {
  let max = 0;
  for (const e of doc.all(cat)) { const n = parseInt(e.mark ?? '', 10); if (!isNaN(n) && n > max) max = n; }
  return String(max + 1);
}
export { mid, perp, norm, closestOnLine, fmtLen, DisplayList };
