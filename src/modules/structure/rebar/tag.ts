// Bewehrungsbeschriftung (ansichtsspezifisch, refId → Bewehrung; wird mit ihr gelöscht):
// „12 Ø10 - 15 ③“, „③ 12 Ø10 a=15 l=2,35“ … mit Positionsnummer im Kreis und Führungslinie zum Stab.
import { app } from '../../../app';
import type { Doc, El, Id } from '../../../core/doc';
import { newId } from '../../../core/doc';
import { V2, add, sub, apply } from '../../../core/geom';
import { registerCategory, GROUPS } from '../../../core/registry';
import type { View } from '../../../core/view';
import { DisplayList, textWidth } from '../../../render/displayList';
import { Tool, ToolEvent, OptionItem } from '../../../tools/tool';
import { Rebar, rebarInView, rebarLabel, TagFmt, TAG_FORMATS } from './rebar';
import { vfOf } from './frame';

export interface RebarTag extends El { cat: 'rebarTag'; viewId: Id; refId: Id; off: V2; a0: V2; fmt: TagFmt; leader: boolean }

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

const TXT = 2.5;
export function drawTag(dl: DisplayList, doc: Doc, t: RebarTag, view: View, color?: string): void {
  const inf = info(doc, t, view); if (!inf) return;
  const a = inf.anchor ?? t.a0;
  const head = add(a, t.off);
  const s = view.scale || 100;
  const col = color ?? '#000000'; const pen = { w: 1, color: col };
  const size = TXT * s; const R = size * 0.75; const gap = 0.8 * s;
  const dir = t.off.x >= 0 ? 1 : -1;
  const lines = inf.text.split('\n');
  const tw = Math.max(...lines.map((l) => textWidth(l, size)));
  const withCircle = inf.pos !== undefined && inf.pos > 0;
  let seq: ('t' | 'c')[] = t.fmt === 'long' || t.fmt === 'short' ? ['c', 't'] : ['t', 'c'];
  if (!withCircle) seq = ['t'];
  if (dir < 0) seq = seq.slice().reverse();
  let x = head.x + dir * gap;
  for (const it of seq) {
    if (it === 't') {
      dl.text({ x, y: head.y }, inf.text, { size: TXT, ha: dir > 0 ? 'left' : 'right', va: 'middle', color: col });
      x += dir * (tw + gap);
    } else {
      const c = { x: x + dir * R, y: head.y };
      dl.circle(c, R, pen, { color: '#ffffff' });
      dl.text(c, String(inf.pos), { size: TXT * 0.9, ha: 'center', va: 'middle', color: col });
      x += dir * (2 * R + gap);
    }
  }
  if (t.leader && inf.anchor) {
    dl.line(a, head, pen);
    dl.circle(a, 0.4 * s, undefined, { color: col }, { ns: true });
  }
}

export function createRebarTag(doc: Doc, el: El, view: View, off?: V2, fmt: TagFmt = 'std', leader = true): RebarTag | null {
  if (view.kind !== 'plan' && view.kind !== 'section') return null;
  const inf = info(doc, { refId: el.id, fmt }, view);
  if (!inf?.anchor) return null;
  const s = view.scale || 100;
  const t: RebarTag = { id: newId('rt'), cat: 'rebarTag', viewId: view.id, refId: el.id, off: off ?? { x: 8 * s, y: 6 * s }, a0: inf.anchor, fmt, leader };
  doc.add(t);
  return t;
}

registerCategory({
  cat: 'rebarTag', label: 'Bewehrungsbeschriftung', plural: 'Bewehrungsbeschriftungen', annotation: true, planOrder: 92,
  drawAnnotation: (dl, el, doc, view) => drawTag(dl, doc, el as RebarTag, view),
  grips: (el, doc, view) => {
    const t = el as RebarTag; const a = info(doc, t, view)?.anchor ?? t.a0;
    return [{ id: 'head', p: add(a, t.off), kind: 'end', tip: 'Beschriftung verschieben' }];
  },
  dragGrip: (el, id, p, doc, view) => {
    if (id !== 'head') return;
    const t = el as RebarTag; const a = info(doc, t, view)?.anchor ?? t.a0;
    return { off: sub(p, a) };
  },
  transform: (el, m, doc, view) => {
    const t = el as RebarTag; const a = info(doc, t, view)?.anchor ?? t.a0;
    return { off: sub(apply(m, add(a, t.off)), a) };
  },
  center: (el, doc, view) => { const t = el as RebarTag; const a = info(doc, t, view)?.anchor ?? t.a0; return add(a, t.off); },
  props: () => [
    { key: 'fmt', label: 'Beschriftungsformat', group: GROUPS.text, type: 'select', options: TAG_FORMATS, get: (e) => e.fmt ?? 'std', set: (_e, v) => ({ fmt: v }) },
    { key: 'leader', label: 'Führungslinie', group: GROUPS.text, type: 'bool', get: (e) => e.leader !== false, set: (_e, v) => ({ leader: v }) },
    { key: 'text', label: 'Text', group: GROUPS.text, type: 'readonly', get: (e, doc) => info(doc, e as RebarTag, app.activeView()!)?.text ?? '' },
  ],
});

// ------------------------------------------------------------ Werkzeug
let lastFmt: TagFmt = 'std'; let lastLeader = true;
export class RebarTagTool extends Tool {
  id = 'rebarTag'; label = 'Bewehrungsbeschriftung'; kinds = ['plan', 'section'];
  snapping = false;
  private hover: El | null = null; private target: El | null = null; private cur: V2 | null = null;
  prompt(): string { return this.target ? 'Position der Beschriftung klicken.' : 'Bewehrung (Stab, Flächen- oder Mattenbewehrung) anklicken.'; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'fmt', label: 'Format', value: lastFmt, options: TAG_FORMATS, onChange: (v) => { lastFmt = v as TagFmt; app.redrawOverlay(); } },
      { kind: 'check', key: 'leader', label: 'Führungslinie', value: lastLeader, onChange: (v) => { lastLeader = v; app.redrawOverlay(); } },
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
      const tgt = this.target;
      app.doc.transaction('Bewehrung beschriften', () => createRebarTag(app.doc, tgt, e.view, sub(e.raw, inf.anchor!), lastFmt, lastLeader));
    } else app.status('Die Bewehrung ist in dieser Ansicht nicht sichtbar.');
    this.target = null;
  }
  escape(): boolean { if (this.target) { this.target = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    const view = vp.view as View;
    const el = this.target ?? this.hover;
    if (!el || !this.cur) return;
    const inf = info(app.doc, { refId: el.id, fmt: lastFmt }, view);
    if (!inf?.anchor) return;
    if (!this.target) { dl.circle(inf.anchor, 1.2 * (view.scale || 100), { w: 2, color: '#1e6fd9' }); return; }
    const t: RebarTag = { id: '__p', cat: 'rebarTag', viewId: view.id, refId: el.id, off: sub(this.cur, inf.anchor), a0: inf.anchor, fmt: lastFmt, leader: lastLeader };
    drawTag(dl, app.doc, t, view, '#1e6fd9');
  }
}
