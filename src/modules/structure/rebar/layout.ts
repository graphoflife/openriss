// Bewehrung – Darstellung der Verlegebereiche: Masskette des Verlegebereichs parallel zur Verteilungslinie
// (je Satz oder für alle Sätze einer Ansicht) und automatische, kollisionsfreie Anordnung der
// Bewehrungsbeschriftungen («Beschriftungen anordnen»): parallel zum Stab, zuerst entlang des Stabes
// verschoben, sonst daneben mit Führungslinie. Deterministisch (gleiche Eingabe → gleiche Lage).
import { app } from '../../../app';
import type { Doc, El, Id } from '../../../core/doc';
import { V2, add, sub, mul, dot, dist, len, norm, perp, angleOf, fromAngle, mid } from '../../../core/geom';
import { catDef, registerCommand, registerContextPanel, registerPanel } from '../../../core/registry';
import type { View } from '../../../core/view';
import type { DisplayList } from '../../../render/displayList';
import { textBox } from '../../../render/displayList';
import { isVisibleInView, buildViewDL } from '../../../views/viewBuilder';
import { normTextAngle } from '../../../elements/datums';
import { Rebar, RebarView, rebarInView } from './rebar';
import { vfOf } from './frame';
import { RebarTag, OBB, TagGeo, TagInfo, TagPlace, tagInfo, tagPath, tagGeoOf, pathLen } from './tag';
import { filterOf } from './filter';

// ------------------------------------------------------------ Masskette des Verlegebereichs
/** Bemaßungstyp: Schweizer Typ bei Landesvorlage CH, sonst Standard */
export function dimTypeOf(doc: Doc): string {
  if (doc.get<any>('project')?.locale === 'CH' && doc.get('dimt_ch')) return 'dimt_ch';
  if (doc.get('dimt_s25')) return 'dimt_s25';
  return doc.all('type').find((t) => t.of === 'dimension')?.id ?? '';
}
/** Masskette zwischen zwei Punkten (über die Kategorie 'dimension' gezeichnet, keine eigene Beschriftung) */
export function drawChain(dl: DisplayList, doc: Doc, view: View, pts: V2[], dir: V2, line: V2): void {
  const def = catDef('dimension'); if (!def?.drawAnnotation || pts.length < 2) return;
  const el = { id: '__chain', cat: 'dimension', viewId: view.id, kind: 'linear', aligned: true, refs: pts.map((p) => ({ p })), dir, line, typeId: dimTypeOf(doc) } as El;
  def.drawAnnotation(dl, el, doc, view);
}
const distDimOn = (el: El, view: View) => !!el.distDim || !!filterOf(view).dims;
/** Lage der Masskette: Maßlinie neben der Verteilungslinie, Text auf der Außenseite */
function distDimGeo(rv: RebarView, s: number): { a: V2; b: V2; d: V2; up: V2; line: V2 } | null {
  if (!rv.dist || dist(rv.dist.a, rv.dist.b) < 1) return null;
  const { a, b } = rv.dist; const d = norm(sub(b, a));
  const up = perp(fromAngle(normTextAngle(angleOf(d))));
  return { a, b, d, up, line: add(a, mul(up, 1.8 * s)) };
}
function drawDistDim(dl: DisplayList, doc: Doc, el: El, view: View): void {
  if (!distDimOn(el, view)) return;
  const vf = vfOf(doc, view); if (!vf) return;
  const g = distDimGeo(rebarInView(doc, el as Rebar, vf), vf.scale); if (!g) return;
  drawChain(dl, doc, view, [g.a, g.b], g.d, g.line);
}
{
  const def = catDef('rebar')!;
  const dp = def.drawPlan!, ds = def.drawSection!;
  def.drawPlan = (ctx, el) => { dp(ctx, el); if (ctx.view.kind === 'plan') drawDistDim(ctx.dl, ctx.doc, el, ctx.view); };
  def.drawSection = (ctx, el) => { ds(ctx, el); if (ctx.view.kind === 'section') drawDistDim(ctx.dl, ctx.doc, el, ctx.view); };
}

// ------------------------------------------------------------ Geometrie: Rechtecke, Strecken
function corners(b: OBB): V2[] {
  const v = perp(b.u); const U = mul(b.u, b.hw), W = mul(v, b.hh);
  return [sub(sub(b.c, U), W), sub(add(b.c, U), W), add(add(b.c, U), W), add(sub(b.c, U), W)];
}
/** Überlappen sich zwei gedrehte Rechtecke? (Trennachsen) */
export function obbOverlap(a: OBB, b: OBB, eps = 0): boolean {
  if (dist(a.c, b.c) > Math.hypot(a.hw, a.hh) + Math.hypot(b.hw, b.hh)) return false;
  const ca = corners(a), cb = corners(b);
  for (const ax of [a.u, perp(a.u), b.u, perp(b.u)]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of ca) { const t = dot(p, ax); a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
    for (const p of cb) { const t = dot(p, ax); b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
    if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
  }
  return true;
}
/** schneidet die Strecke p–q das Rechteck? (Liang-Barsky im lokalen System) */
export function segHitsObb(p: V2, q: V2, b: OBB): boolean {
  const v = perp(b.u);
  const P = { x: dot(sub(p, b.c), b.u), y: dot(sub(p, b.c), v) }, Q = { x: dot(sub(q, b.c), b.u), y: dot(sub(q, b.c), v) };
  let t0 = 0, t1 = 1; const dx = Q.x - P.x, dy = Q.y - P.y;
  const clip = (pp: number, qq: number): boolean => {
    if (Math.abs(pp) < 1e-12) return qq >= 0;
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, P.x + b.hw) && clip(dx, b.hw - P.x) && clip(-dy, P.y + b.hh) && clip(dy, b.hh - P.y) && t0 <= t1;
}

// ------------------------------------------------------------ Anordnung
interface Seg { a: V2; b: V2; o: Id; dist: boolean }
interface Item { t: RebarTag; inf: TagInfo; path: V2[] | null; refId: Id; slack: number; pos: number }
interface Cand { p: TagPlace; base: number }

/** Hindernisse der Ansicht: sichtbare Stäbe und Verteilungslinien (Strecken), alle übrigen Texte und
 *  Symbolkreise der Ansicht (Massketten, Rasterköpfe, Öffnungsmasse …) als Rechtecke */
function obstacles(doc: Doc, view: View): { segs: Seg[]; boxes: { b: OBB; o: Id }[] } {
  const segs: Seg[] = []; const boxes: { b: OBB; o: Id }[] = [];
  const vf = vfOf(doc, view); if (!vf) return { segs, boxes };
  const s = vf.scale;
  for (const r of doc.all<Rebar>('rebar')) {
    if (!isVisibleInView(doc, view, r, true)) continue;
    let rv: RebarView; try { rv = rebarInView(doc, r, vf); } catch { continue; }
    for (const l of rv.lines) for (let i = 1; i < l.length; i++) segs.push({ a: l[i - 1], b: l[i], o: r.id, dist: false });
    if (rv.dist) segs.push({ a: rv.dist.a, b: rv.dist.b, o: r.id, dist: true });
    if (distDimOn(r, view)) { const g = distDimGeo(rv, s); if (g) segs.push({ a: g.line, b: add(g.line, sub(g.b, g.a)), o: r.id, dist: true }); }
  }
  let dl: DisplayList | null = null;
  try { dl = buildViewDL(doc, view); } catch { dl = null; }
  for (const it of dl?.items ?? []) {
    if (it.sel || it.inv || (it.o && doc.get(it.o)?.cat === 'rebarTag')) continue;
    if (it.k === 'text') {
      const q = textBox(it, s); const u = sub(q[1], q[0]); const hw = len(u) / 2, hh = dist(q[0], q[3]) / 2;
      if (hw > 0) boxes.push({ b: { c: mid(q[0], q[2]), u: mul(u, 1 / (2 * hw)), hw, hh }, o: it.o ?? '' });
    } else if (it.k === 'circle' && it.r > 0.8 * s) boxes.push({ b: { c: it.c, u: { x: 1, y: 0 }, hw: it.r, hh: it.r }, o: it.o ?? '' });
    else if (it.k === 'line' && it.sub === 'dimline') segs.push({ a: it.a, b: it.b, o: '#dim' + (it.o ?? ''), dist: false });
  }
  return { segs, boxes };
}

function candidates(it: Item, s: number): Cand[] {
  const out: Cand[] = [];
  const t0: TagPlace = { off: it.t.off, a0: it.t.a0, fmt: it.t.fmt, leader: true, par: !!it.path, at: 0.5 };
  if (it.path) {
    const g0 = tagGeoOf(it.inf, it.path, { ...t0, off: { x: 0, y: 0 } }, s);
    const W = 2 * g0.box.hw, side = g0.box.hh + 0.5 * s;
    const L = pathLen(it.path); let acc = 0;
    const along: { at: number; short: boolean }[] = [];
    for (let i = 1; i < it.path.length; i++) {
      const l = dist(it.path[i - 1], it.path[i]);
      if (l >= W * 1.05) {
        const n = Math.max(1, Math.min(40, Math.floor((l - W) / Math.max(W / 6, 2 * s))));
        for (let k = 0; k <= n; k++) along.push({ at: (acc + W / 2 + ((l - W) * k) / n) / L, short: false });
      } else if (l > 0.3 * W || it.path.length === 2) along.push({ at: (acc + l / 2) / L, short: true });
      acc += l;
    }
    for (const a of along) {
      const base = Math.abs(a.at - 0.5) + (a.short ? 1.5 : 0);
      out.push({ p: { ...t0, at: a.at, off: { x: 0, y: 0 } }, base });
      for (const sg of [1, -1]) {
        const v = perp(fromAngle(g0.rot));
        out.push({ p: { ...t0, at: a.at, off: mul(v, sg * side) }, base: base + 0.35 + (sg < 0 ? 0.01 : 0) });
      }
    }
    // Führungslinie: senkrecht zum Stab abgesetzt
    const v = perp(fromAngle(g0.rot)); const step = 2 * g0.box.hh + 0.8 * s;
    for (const at of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      for (let k = 1; k <= 10; k++) for (const sg of [1, -1]) {
        out.push({ p: { ...t0, at, off: mul(v, sg * (side + k * step)) }, base: 3 + 0.35 * k + Math.abs(at - 0.5) + (sg < 0 ? 0.01 : 0) });
      }
    }
  } else {
    // ohne Stablinie (Punkte, Flächenbewehrung): waagrecht um den Ankerpunkt
    const dirs: V2[] = [{ x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0.3, y: 1 }, { x: 0.3, y: -1 }];
    for (const [k, r] of [5, 8, 11, 15, 20, 26, 33].entries()) dirs.forEach((d, j) => out.push({ p: { ...t0, par: false, off: mul(norm(d), r * s) }, base: 2 + k * 0.5 + j * 0.02 }));
  }
  return out.sort((a, b) => a.base - b.base);
}

/** Neue Lage aller (bzw. der gewählten) Bewehrungsbeschriftungen einer Ansicht; Ergebnis: Patch je Beschriftung */
export function arrangeTags(doc: Doc, view: View, only?: Set<Id>): Map<Id, Partial<RebarTag>> {
  const s = view.scale || 100;
  const res = new Map<Id, Partial<RebarTag>>();
  const tags = doc.all<RebarTag>('rebarTag').filter((t) => t.viewId === view.id && isVisibleInView(doc, view, t, true));
  const { segs, boxes: textBoxes } = obstacles(doc, view);
  const placed: { b: OBB; id: Id }[] = []; const leaders: [V2, V2][] = [];
  const items: Item[] = [];
  for (const t of tags) {
    const inf = tagInfo(doc, t, view); if (!inf) continue;
    const ref = doc.get(t.refId);
    if (only && !only.has(t.id)) {
      const g = tagGeoOf(inf, t.par ? tagPath(doc, ref, view) : null, t, s);
      placed.push({ b: g.box, id: t.id }); if (g.leader) leaders.push(g.leader);
      continue;
    }
    const path = tagPath(doc, ref, view);
    if (!path && !inf.anchor) continue;
    const w = 2 * tagGeoOf(inf, path, { ...t, par: !!path, off: { x: 0, y: 0 } }, s).box.hw;
    items.push({ t, inf, path, refId: t.refId, slack: path ? pathLen(path) - w : Infinity, pos: inf.pos ?? 0 });
  }
  // eng begrenzte zuerst (kurze Stäbe), dann nach Position und ID
  items.sort((a, b) => a.slack - b.slack || a.pos - b.pos || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0));
  for (const it of items) {
    let best: { g: TagGeo; p: TagPlace; cost: number } | null = null;
    for (const c of candidates(it, s)) {
      if (best && c.base >= best.cost) break;
      const g = tagGeoOf(it.inf, it.path, c.p, s);
      let hard = 0;
      for (const q of placed) if (obbOverlap(g.box, q.b)) hard++;
      let cost = c.base + hard * 100;
      if (best && cost >= best.cost) continue;
      const crossed = new Set<string>();
      for (const sg of segs) {
        if (sg.o === it.refId && !sg.dist) continue;
        const key = sg.o + (sg.dist ? 'd' : '');
        if (crossed.has(key)) continue;
        if (segHitsObb(sg.a, sg.b, g.box)) { crossed.add(key); cost += sg.o === it.refId ? 1.2 : sg.dist ? 0.6 : 1; }
      }
      for (const d of textBoxes) if (obbOverlap(g.box, d.b)) cost += 1.2;
      for (const l of leaders) if (segHitsObb(l[0], l[1], g.box)) cost += 1;
      if (g.leader) for (const q of placed) if (segHitsObb(g.leader[0], g.leader[1], q.b)) cost += 2;
      if (!best || cost < best.cost) best = { g, p: c.p, cost };
    }
    if (!best) continue;
    placed.push({ b: best.g.box, id: it.t.id }); if (best.g.leader) leaders.push(best.g.leader);
    res.set(it.t.id, { par: best.p.par, at: best.p.par ? round(best.p.at ?? 0.5, 4) : it.t.at, off: { x: round(best.p.off.x, 1), y: round(best.p.off.y, 1) }, leader: true });
  }
  return res;
}
const round = (v: number, d: number) => { const f = 10 ** d; return Math.round(v * f) / f; };

/** Prüfung anhand der gezeichneten Ansicht: Paare von Bewehrungsbeschriftungen, deren Texte/Kreise sich überdecken */
export function tagOverlaps(doc: Doc, view: View): [Id, Id][] {
  const dl = buildViewDL(doc, view); const s = dl.scale;
  const quads = new Map<Id, V2[][]>();
  for (const it of dl.items) {
    if (!it.o || doc.get(it.o)?.cat !== 'rebarTag') continue;
    const q = it.k === 'text' ? textBox(it, s) : it.k === 'circle' && it.r >= 0.5 * s
      ? [{ x: it.c.x - it.r, y: it.c.y - it.r }, { x: it.c.x + it.r, y: it.c.y - it.r }, { x: it.c.x + it.r, y: it.c.y + it.r }, { x: it.c.x - it.r, y: it.c.y + it.r }] : null;
    if (q) (quads.get(it.o) ?? quads.set(it.o, []).get(it.o)!).push(q);
  }
  const sep = (a: V2[], b: V2[]) => [a, b].some((P) => P.some((p, i) => {
    const q = P[(i + 1) % P.length]; const ax = { x: p.y - q.y, y: q.x - p.x };
    const pa = a.map((r) => dot(r, ax)), pb = b.map((r) => dot(r, ax));
    return Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa);
  }));
  const ids = [...quads.keys()]; const out: [Id, Id][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (quads.get(ids[i])!.some((a) => quads.get(ids[j])!.some((b) => !sep(a, b)))) out.push([ids[i], ids[j]]);
  }
  return out;
}

/** Anordnen und übernehmen (in eigener Transaktion). Liefert Anzahl geänderter Beschriftungen. */
export function arrangeRebarTags(doc: Doc, view: View, only?: Set<Id>): number {
  const m = arrangeTags(doc, view, only);
  if (m.size) doc.transaction('Beschriftungen anordnen', () => { for (const [id, p] of m) doc.update(id, p); });
  return m.size;
}

registerCommand({
  id: 'rebarTagsArrange', label: 'Beschriftungen anordnen', icon: 'rebartag',
  tip: 'Bewehrungsbeschriftungen der aktiven Ansicht (bzw. die gewählten) parallel zum Stab und kollisionsfrei anordnen: entlang des Stabes verschieben, sonst daneben mit Führungslinie.',
  enabled: () => { const v = app.activeView(); return !!v && (v.kind === 'plan' || v.kind === 'section' || v.kind === 'sheet'); },
  run: () => {
    const v = app.activeView(); if (!v) return;
    let n = 0, rest = 0;
    const run = (r: View, only?: Set<Id>) => { const k = arrangeRebarTags(app.doc, r, only); if (k) rest += tagOverlaps(app.doc, r).length; n += k; };
    if (v.kind === 'sheet') {
      // Plan: alle platzierten Grundrisse/Schnitte
      for (const vp of app.doc.all('viewport')) {
        const r = vp.viewId === v.id ? app.doc.get<View>(vp.refId) : undefined;
        if (r && (r.kind === 'plan' || r.kind === 'section')) run(r);
      }
    } else {
      const sel = app.selected().filter((e) => e.cat === 'rebarTag' && e.viewId === v.id).map((e) => e.id);
      run(v, sel.length ? new Set(sel) : undefined);
    }
    app.status(n ? `${n} Bewehrungsbeschriftung(en) angeordnet${rest ? ` – ${rest} Überdeckung(en) verbleiben` : ', keine Überdeckungen'}.` : 'Keine Bewehrungsbeschriftungen in dieser Ansicht.');
  },
});
registerContextPanel({ cats: ['rebarTag'], panel: 'Beschriftung', items: ['rebarTagsArrange'] });
registerPanel('Beschriften', 'Beschriftung', ['rebarTagsArrange']);

/** Beschriftungs-Rechteck einer vorhandenen Beschriftung (für Prüfungen) */
export function tagBox(doc: Doc, t: RebarTag, view: View): OBB | null {
  const inf = tagInfo(doc, t, view); if (!inf) return null;
  return tagGeoOf(inf, t.par ? tagPath(doc, doc.get(t.refId), view) : null, t, view.scale || 100).box;
}
