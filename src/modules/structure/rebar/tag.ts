// Bewehrungsbeschriftung (ansichtsspezifisch, refId → Bewehrung; wird mit ihr gelöscht):
// „12 Ø10 - 15 ③“, „③ 12 Ø10 a=15 l=2,35“ … mit Positionsnummer im Kreis und Führungslinie zum Stab.
// Wahlweise parallel zum Stab (par): auf dem Stab bei Anteil `at` der Stablänge, `off` = Versatz der Mitte.
import { app } from '../../../app';
import type { Doc, El, Id } from '../../../core/doc';
import { newId } from '../../../core/doc';
import { V2, add, sub, mul, dot, dist, len, lerp, norm, perp, angleOf, fromAngle, closestOnSeg, apply } from '../../../core/geom';
import { registerCategory, GROUPS } from '../../../core/registry';
import type { View } from '../../../core/view';
import { DisplayList, textWidth } from '../../../render/displayList';
import { Tool, ToolEvent, OptionItem } from '../../../tools/tool';
import { normTextAngle } from '../../../elements/datums';
import { Rebar, rebarInView, rebarLabel, TagFmt, TAG_FORMATS } from './rebar';
import { vfOf } from './frame';

export interface RebarTag extends El {
  cat: 'rebarTag'; viewId: Id; refId: Id; off: V2; a0: V2; fmt: TagFmt; leader: boolean;
  /** parallel zum Stab; at = Lage entlang des Stabes (0…1, Vorgabe 0,5) */
  par?: boolean; at?: number;
}

/** Text/Anker je Kategorie (Flächen- und Mattenbewehrung registrieren sich selbst) */
export interface TagInfo { text: string; pos?: number; anchor: V2 | null }
type Provider = (doc: Doc, el: El, view: View, fmt: TagFmt) => TagInfo;
const providers = new Map<string, Provider>();
export function registerTagProvider(cat: string, p: Provider): void { providers.set(cat, p); }
export const taggableCats = () => [...providers.keys()];

registerTagProvider('rebar', (doc, el, view, fmt) => {
  const vf = vfOf(doc, view);
  return { text: rebarLabel(doc, el as Rebar, fmt), pos: fmt === 'count' ? undefined : (el as Rebar).pos, anchor: vf ? rebarInView(doc, el as Rebar, vf).anchor : null };
});

function info(doc: Doc, t: { refId: Id; fmt: TagFmt }, view: View): TagInfo | null {
  const ref = doc.get(t.refId); if (!ref) return null;
  const p = providers.get(ref.cat); if (!p) return null;
  try { return p(doc, ref, view, t.fmt); } catch { return null; }
}
export const tagInfo = info;

// ------------------------------------------------------------ Geometrie (Zeichnen, Griffe, Anordnung)
const TXT = 2.5;
/** gedrehtes Rechteck (Ansichts-mm): Mitte c, Richtung u (normiert), halbe Länge hw / Höhe hh */
export interface OBB { c: V2; u: V2; hw: number; hh: number }
export interface TagGeo {
  /** Punkt am Stab (Anfang der Führungslinie) */
  anchor: V2 | null;
  /** Griffpunkt der Beschriftung */
  head: V2;
  box: OBB;
  rot: number;
  text: { p: V2; ha: 'left' | 'right' };
  circle: V2 | null; R: number;
  leader: [V2, V2] | null;
  par: boolean;
}
export type TagPlace = Pick<RebarTag, 'off' | 'a0' | 'fmt' | 'leader' | 'par' | 'at'>;

/** Stab der Beschriftung in der Ansicht (erster sichtbarer Stab) – Bezug der parallelen Beschriftung */
export function tagPath(doc: Doc, ref: El | undefined, view: View): V2[] | null {
  if (ref?.cat !== 'rebar') return null;
  const vf = vfOf(doc, view); if (!vf) return null;
  const l = rebarInView(doc, ref as Rebar, vf).lines[0];
  return l && l.length > 1 ? l : null;
}
export function pathLen(path: V2[]): number { let L = 0; for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]); return L; }
/** Punkt und Richtung bei Anteil at (0…1) der Polylinienlänge */
export function pathPoint(path: V2[], at: number): { p: V2; d: V2 } {
  const L = pathLen(path); let s = Math.max(0, Math.min(1, at)) * L;
  for (let i = 1; i < path.length; i++) {
    const l = dist(path[i - 1], path[i]);
    if (l > 1e-9 && (s <= l || i === path.length - 1)) return { p: lerp(path[i - 1], path[i], Math.min(1, s / l)), d: norm(sub(path[i], path[i - 1])) };
    s -= l;
  }
  return { p: path[0], d: { x: 1, y: 0 } };
}
/** nächster Punkt auf der Polylinie: Anteil at und Abstand */
export function pathProject(path: V2[], p: V2): { at: number; d: number } {
  const L = Math.max(1e-9, pathLen(path)); let acc = 0; let best = { at: 0.5, d: Infinity };
  for (let i = 1; i < path.length; i++) {
    const q = closestOnSeg(p, path[i - 1], path[i]); const d = dist(p, q);
    if (d < best.d) best = { at: (acc + dist(path[i - 1], q)) / L, d };
    acc += dist(path[i - 1], path[i]);
  }
  return best;
}

/** Lage aller Teile einer Beschriftung (rein geometrisch, ohne Dokumentzugriff) */
export function tagGeoOf(inf: TagInfo, path: V2[] | null, t: TagPlace, s: number): TagGeo {
  const size = TXT * s; const R = size * 0.75; const gap = 0.8 * s;
  const lines = inf.text.split('\n');
  const tw = Math.max(...lines.map((l) => textWidth(l, size)));
  const th = size * (1.25 * lines.length - 0.25);
  const withCircle = inf.pos !== undefined && inf.pos > 0;
  const circFirst = t.fmt === 'long' || t.fmt === 'short' || (t.fmt as string) === 'ch';
  const hh = Math.max(th / 2, withCircle ? R : 0);
  if (t.par && path) {
    const { p: P, d } = pathPoint(path, t.at ?? 0.5);
    const rot = normTextAngle(angleOf(d)); const u = fromAngle(rot); const v = perp(u);
    const C = add(P, t.off);
    const W = tw + (withCircle ? 2 * R + gap : 0);
    const S = sub(C, mul(u, W / 2));
    const cOff = circFirst ? R : tw + gap + R; const tOff = withCircle && circFirst ? 2 * R + gap : 0;
    const box: OBB = { c: C, u, hw: W / 2 + 0.4 * s, hh: hh + 0.2 * s };
    let leader: [V2, V2] | null = null;
    if (t.leader !== false && len(t.off) > box.hh + 1.2 * s) {
      const q = sub(P, C); const qu = Math.abs(dot(q, u)), qv = Math.abs(dot(q, v));
      const k = Math.min(qu > 1e-9 ? box.hw / qu : Infinity, qv > 1e-9 ? box.hh / qv : Infinity);
      if (k < 1) leader = [P, add(C, mul(q, k))];
    }
    return { anchor: P, head: C, box, rot, text: { p: add(S, mul(u, tOff)), ha: 'left' }, circle: withCircle ? add(S, mul(u, cOff)) : null, R, leader, par: true };
  }
  const a = inf.anchor ?? t.a0;
  const head = add(a, t.off);
  const dir = t.off.x >= 0 ? 1 : -1;
  let seq: ('t' | 'c')[] = circFirst ? ['c', 't'] : ['t', 'c'];
  if (!withCircle) seq = ['t'];
  if (dir < 0) seq = seq.slice().reverse();
  let x = head.x + dir * gap; let tp = head; let cp: V2 | null = null;
  for (const it of seq) {
    if (it === 't') { tp = { x, y: head.y }; x += dir * (tw + gap); } else { cp = { x: x + dir * R, y: head.y }; x += dir * (2 * R + gap); }
  }
  const x0 = head.x + dir * gap, x1 = x - dir * gap;
  const box: OBB = { c: { x: (x0 + x1) / 2, y: head.y }, u: { x: 1, y: 0 }, hw: Math.abs(x1 - x0) / 2 + 0.4 * s, hh: hh + 0.2 * s };
  return { anchor: inf.anchor, head, box, rot: 0, text: { p: tp, ha: dir > 0 ? 'left' : 'right' }, circle: cp, R, leader: t.leader && inf.anchor ? [a, head] : null, par: false };
}

export function tagGeo(doc: Doc, t: RebarTag, view: View): { g: TagGeo; inf: TagInfo } | null {
  const inf = info(doc, t, view); if (!inf) return null;
  const path = t.par ? tagPath(doc, doc.get(t.refId), view) : null;
  return { g: tagGeoOf(inf, path, t, view.scale || 100), inf };
}

export function drawTag(dl: DisplayList, doc: Doc, t: RebarTag, view: View, color?: string): void {
  const r = tagGeo(doc, t, view); if (!r) return;
  const { g, inf } = r;
  const s = view.scale || 100;
  const col = color ?? '#000000'; const pen = { w: 1, color: col };
  const rot = g.rot || undefined;
  if (g.leader) {
    dl.line(g.leader[0], g.leader[1], pen);
    dl.circle(g.leader[0], 0.4 * s, undefined, { color: col }, { ns: true });
  }
  dl.text(g.text.p, inf.text, { size: TXT, ha: g.text.ha, va: 'middle', color: col, rot, opaque: g.par || undefined });
  if (g.circle) {
    dl.circle(g.circle, g.R, pen, { color: '#ffffff' });
    dl.text(g.circle, String(inf.pos), { size: TXT * 0.9, ha: 'center', va: 'middle', color: col, rot });
  }
}

/** neue Lage nach Ziehen/Verschieben: parallel nahe am Stab → entlang des Stabes gleiten, sonst mit Führungslinie */
function movedTo(doc: Doc, t: RebarTag, view: View, p: V2): Partial<RebarTag> {
  const path = t.par ? tagPath(doc, doc.get(t.refId), view) : null;
  if (path) {
    const pr = pathProject(path, p);
    if (pr.d < 2 * (view.scale || 100)) return { at: pr.at, off: { x: 0, y: 0 } };
    return { off: sub(p, pathPoint(path, t.at ?? 0.5).p) };
  }
  const a = info(doc, t, view)?.anchor ?? t.a0;
  return { off: sub(p, a) };
}

export function createRebarTag(doc: Doc, el: El, view: View, off?: V2, fmt: TagFmt = 'std', leader = true, extra: Partial<RebarTag> = {}): RebarTag | null {
  if (view.kind !== 'plan' && view.kind !== 'section') return null;
  const inf = info(doc, { refId: el.id, fmt }, view);
  if (!inf?.anchor) return null;
  const s = view.scale || 100;
  const t: RebarTag = { id: newId('rt'), cat: 'rebarTag', viewId: view.id, refId: el.id, off: off ?? (extra.par ? { x: 0, y: 0 } : { x: 8 * s, y: 6 * s }), a0: inf.anchor, fmt, leader, ...extra };
  doc.add(t);
  return t;
}

registerCategory({
  cat: 'rebarTag', label: 'Bewehrungsbeschriftung', plural: 'Bewehrungsbeschriftungen', annotation: true, planOrder: 92,
  drawAnnotation: (dl, el, doc, view) => drawTag(dl, doc, el as RebarTag, view),
  grips: (el, doc, view) => {
    const r = tagGeo(doc, el as RebarTag, view);
    return [{ id: 'head', p: r ? r.g.head : add(el.a0, el.off), kind: 'end', tip: 'Beschriftung verschieben (parallele Beschriftung: nahe am Stab gleitet sie entlang des Stabes)' }];
  },
  dragGrip: (el, id, p, doc, view) => (id === 'head' ? movedTo(doc, el as RebarTag, view, p) : undefined),
  transform: (el, m, doc, view) => {
    const r = tagGeo(doc, el as RebarTag, view); if (!r) return;
    return movedTo(doc, el as RebarTag, view, apply(m, r.g.head));
  },
  center: (el, doc, view) => tagGeo(doc, el as RebarTag, view)?.g.head ?? null,
  props: () => [
    { key: 'fmt', label: 'Beschriftungsformat', group: GROUPS.text, type: 'select', options: TAG_FORMATS, get: (e) => e.fmt ?? 'std', set: (_e, v) => ({ fmt: v }) },
    { key: 'par', label: 'Parallel zum Stab', group: GROUPS.text, type: 'bool', get: (e) => !!e.par, set: (e, v) => ({ par: v, off: v ? { x: 0, y: 0 } : e.off }) },
    { key: 'leader', label: 'Führungslinie', group: GROUPS.text, type: 'bool', get: (e) => e.leader !== false, set: (_e, v) => ({ leader: v }) },
    { key: 'text', label: 'Text', group: GROUPS.text, type: 'readonly', get: (e, doc) => info(doc, e as RebarTag, app.activeView()!)?.text ?? '' },
  ],
});

// ------------------------------------------------------------ Werkzeug
let lastFmt: TagFmt = 'std'; let lastLeader = true; let lastPar = false;
export class RebarTagTool extends Tool {
  id = 'rebarTag'; label = 'Bewehrungsbeschriftung'; kinds = ['plan', 'section'];
  snapping = false;
  private hover: El | null = null; private target: El | null = null; private cur: V2 | null = null;
  prompt(): string { return this.target ? 'Position der Beschriftung klicken.' : 'Bewehrung (Stab, Flächen- oder Mattenbewehrung) anklicken.'; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'fmt', label: 'Format', value: lastFmt, options: TAG_FORMATS, onChange: (v) => { lastFmt = v as TagFmt; app.redrawOverlay(); } },
      { kind: 'check', key: 'leader', label: 'Führungslinie', value: lastLeader, onChange: (v) => { lastLeader = v; app.redrawOverlay(); } },
      { kind: 'check', key: 'par', label: 'Parallel zum Stab', value: lastPar, onChange: (v) => { lastPar = v; app.redrawOverlay(); } },
    ];
  }
  move(e: ToolEvent): void {
    this.cur = e.raw;
    if (this.target) return;
    this.hover = null;
    const cats = taggableCats();
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el && cats.includes(el.cat)) { this.hover = el; break; } }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.target) {
      if (!this.hover) { app.status('Keine Bewehrung unter dem Cursor.'); return; }
      this.target = this.hover;
      return;
    }
    const inf = info(app.doc, { refId: this.target.id, fmt: lastFmt }, e.view);
    if (inf?.anchor) {
      const tgt = this.target; const t = this.proto(tgt, e.view, e.raw, inf.anchor);
      app.doc.transaction('Bewehrung beschriften', () => createRebarTag(app.doc, tgt, e.view, t.off, lastFmt, lastLeader, { par: t.par, at: t.at }));
    } else app.status('Die Bewehrung ist in dieser Ansicht nicht sichtbar.');
    this.target = null;
  }
  /** Beschriftung an Cursorposition (parallel: nahe am Stab auf dem Stab, sonst mit Führungslinie) */
  private proto(el: El, view: View, p: V2, anchor: V2): RebarTag {
    const t: RebarTag = { id: '__p', cat: 'rebarTag', viewId: view.id, refId: el.id, off: sub(p, anchor), a0: anchor, fmt: lastFmt, leader: lastLeader };
    const path = lastPar ? tagPath(app.doc, el, view) : null;
    if (path) { const pr = pathProject(path, p); t.par = true; t.at = pr.at; t.off = pr.d < 2 * (view.scale || 100) ? { x: 0, y: 0 } : sub(p, pathPoint(path, pr.at).p); }
    return t;
  }
  escape(): boolean { if (this.target) { this.target = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    const view = vp.view as View;
    const el = this.target ?? this.hover;
    if (!el || !this.cur) return;
    const inf = info(app.doc, { refId: el.id, fmt: lastFmt }, view);
    if (!inf?.anchor) return;
    if (!this.target) { dl.circle(inf.anchor, 1.2 * (view.scale || 100), { w: 2, color: '#1e6fd9' }); return; }
    drawTag(dl, app.doc, this.proto(el, view, this.cur, inf.anchor), view, '#1e6fd9');
  }
}
