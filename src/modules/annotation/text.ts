// Textnotizen: mehrzeilig, Umbruchbreite, Ausrichtung, Drehung, Fett/Kursiv/Unterstrichen,
// Hintergrund undurchsichtig, Rahmen, Führungslinien mit Pfeil. Bearbeiten im Overlay (Doppelklick).
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, dot, perp, dist, fromAngle, angleOf, apply, applyVec, isMirror, matAngle, deg, rad } from '../../core/geom';
import { registerCategory, PropDef, GROUPS, Grip } from '../../core/registry';
import type { View } from '../../core/view';
import { DisplayList, textWidth, fontWf } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { modal } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import {
  ANNO_KINDS, fontFamily, wrapText, rectPts, drawLeader, TickKind, TICK_OPTIONS, FONTS, myPlacement, tint, PREV_COL, normTextAngle, typeWf, widthFactorProp } from './common';

export type HAlign = 'left' | 'center' | 'right';
export interface TextEl extends El {
  cat: 'text'; viewId: Id;
  /** linke obere Ecke des Textrahmens */
  p: V2;
  s: string;
  rot?: number;
  /** Umbruchbreite in Papier-mm (leer = automatisch) */
  w?: number;
  ha?: HAlign;
  bold?: boolean; italic?: boolean; underline?: boolean;
  /** Pfeilspitzen der Führungslinien */
  leaders?: V2[];
}

interface TextStyle { size: number; font: string; wf?: number; bold: boolean; italic: boolean; underline: boolean; color: string; opaque: boolean; box: boolean; leaderArrow: TickKind; arrowSize: number }
function textStyle(doc: Doc, el: El): TextStyle {
  const t: any = doc.get(el.typeId) ?? {};
  return {
    size: t.size ?? 2.5, font: t.font ?? 'Arial', wf: typeWf(t), bold: el.bold ?? !!t.bold, italic: el.italic ?? !!t.italic, underline: el.underline ?? !!t.underline,
    color: t.color || '#000000', opaque: !!t.opaque, box: !!t.box, leaderArrow: t.leaderArrow ?? 'arrow', arrowSize: t.arrowSize ?? 2.5,
  };
}

export function textLayout(doc: Doc, el: TextEl, scale: number) {
  const st = textStyle(doc, el); const size = st.size * scale;
  const lines = wrapText(el.s ?? '', el.w ? el.w * scale : null, size);
  const f = st.bold ? 1.06 : 1;
  const wf = fontWf({ wf: st.wf, family: fontFamily(st.font) });
  const W = el.w ? el.w * scale : Math.max(size * 0.6, ...lines.map((l) => textWidth(l, size, wf) * f));
  const lh = size * 1.25; const H = lh * (lines.length - 1) + size;
  const ex = fromAngle(el.rot ?? 0); const ey = perp(ex);
  return { st, size, lines, W, H, lh, ex, ey, pad: size * 0.35 };
}

function drawText(dl: DisplayList, el: TextEl, doc: Doc): void {
  if (!el.s) return;
  const L = textLayout(doc, el, dl.scale); const st = L.st; const s = dl.scale;
  const ha = el.ha ?? 'left';
  const xA = ha === 'center' ? L.W / 2 : ha === 'right' ? L.W : 0;
  const anchor = add(el.p, mul(L.ex, xA));
  const font = { size: st.size, rot: el.rot ?? 0, ha, va: 'top' as const, bold: st.bold, italic: st.italic, color: st.color, family: fontFamily(st.font), wf: st.wf, opaque: st.opaque };
  if (st.underline) L.lines.forEach((l, i) => dl.text(add(anchor, mul(L.ey, -i * L.lh)), l, { ...font, underline: true }));
  else dl.text(anchor, L.lines.join('\n'), font);
  const pen: Pen = { w: 1, color: st.color };
  if (st.box) dl.poly(rectPts(el.p, L.ex, L.ey, -L.pad, L.pad, L.W + L.pad, -(L.H + L.pad)), pen, true, { ns: true });
  for (const T of el.leaders ?? []) {
    const c = add(el.p, add(mul(L.ex, L.W / 2), mul(L.ey, -L.H / 2)));
    const left = dot(sub(T, c), L.ex) < 0;
    const A = add(el.p, add(mul(L.ex, left ? -L.pad : L.W + L.pad), mul(L.ey, -L.size * 0.5)));
    const A2 = add(A, mul(L.ex, (left ? -1 : 1) * 2 * s));
    drawLeader(dl, dist(A2, T) > 2 * s ? [A, A2, T] : [A, T], st.leaderArrow, st.arrowSize, pen);
  }
}

// ------------------------------------------------------------ Kategorie
function textGrips(el: TextEl, doc: Doc, view: View): Grip[] {
  const L = textLayout(doc, el, view.scale); const s = view.scale;
  const g: Grip[] = [
    { id: 'pos', p: el.p, kind: 'text', tip: 'Text verschieben' },
    { id: 'w', p: add(el.p, add(mul(L.ex, L.W + L.pad), mul(L.ey, -L.H / 2))), kind: 'arrow', dir: L.ex, tip: 'Umbruchbreite' },
    { id: 'rot', p: add(el.p, mul(L.ey, L.pad + 4 * s)), kind: 'end', tip: 'Drehen' },
  ];
  (el.leaders ?? []).forEach((q, i) => g.push({ id: 'l' + i, p: q, kind: 'end', tip: 'Führungslinienende' }));
  return g;
}

function textDrag(el: TextEl, id: string, p: V2, doc: Doc, view: View): Partial<TextEl> | void {
  if (id === 'pos') return { p };
  if (id === 'w') {
    const L = textLayout(doc, el, view.scale);
    return { w: Math.max(L.st.size * 2, (dot(sub(p, el.p), L.ex) - L.pad) / view.scale) };
  }
  if (id === 'rot') {
    let a = deg(angleOf(sub(p, el.p)) - Math.PI / 2);
    const r15 = Math.round(a / 15) * 15; a = Math.abs(a - r15) < 3 ? r15 : Math.round(a);
    return { rot: rad(a) };
  }
  if (id.startsWith('l')) {
    const i = parseInt(id.slice(1), 10); const ls = (el.leaders ?? []).slice(); ls[i] = p;
    return { leaders: ls };
  }
}

function textTransform(el: TextEl, m: any, doc: Doc, view: View): Partial<TextEl> {
  const ex1 = applyVec(m, fromAngle(el.rot ?? 0));
  const patch: Partial<TextEl> = {};
  if (el.leaders) patch.leaders = el.leaders.map((q) => apply(m, q));
  if (isMirror(m)) {
    // gespiegelt: Lage spiegeln, Schrift lesbar halten
    const L = textLayout(doc, el, view.scale);
    const c2 = apply(m, add(el.p, add(mul(L.ex, L.W / 2), mul(L.ey, -L.H / 2))));
    const rot = normTextAngle(angleOf(ex1)); const ex = fromAngle(rot), ey = perp(ex);
    patch.rot = rot || undefined;
    patch.p = add(c2, add(mul(ex, -L.W / 2), mul(ey, L.H / 2)));
  } else {
    patch.p = apply(m, el.p);
    const r = (el.rot ?? 0) + matAngle(m);
    patch.rot = Math.abs(r) < 1e-9 ? undefined : r;
  }
  return patch;
}

registerCategory({
  cat: 'text', label: 'Text', plural: 'Texte', annotation: true, hasTypes: true, planOrder: 92,
  drawAnnotation: (dl, el, doc) => drawText(dl, el as TextEl, doc),
  grips: (el, doc, view) => textGrips(el as TextEl, doc, view),
  dragGrip: (el, id, p, doc, view) => textDrag(el as TextEl, id, p, doc, view),
  transform: (el, m, doc, view) => textTransform(el as TextEl, m, doc, view),
  center: (el, doc, view) => { const L = textLayout(doc, el as TextEl, view.scale); return add(el.p, add(mul(L.ex, L.W / 2), mul(L.ey, -L.H / 2))); },
  props: () => textProps(),
  typeProps: () => textTypeProps(),
});

function textProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 's', label: 'Text', group: g.text, type: 'button', get: (e) => { const s = String(e.s ?? '').split('\n')[0]; return (s.length > 24 ? s.slice(0, 24) + '…' : s) || 'Bearbeiten…'; }, action: (e) => { if (e.id) editTextEl(e as TextEl); } },
    { key: 'ha', label: 'Horizontale Ausrichtung', group: g.text, type: 'select', options: [['left', 'Links'], ['center', 'Zentriert'], ['right', 'Rechts']], get: (e) => e.ha ?? 'left', set: (_e, v) => ({ ha: v }) },
    { key: 'bold', label: 'Fett', group: g.text, type: 'bool', get: (e, doc) => textStyle(doc, e).bold, set: (_e, v) => ({ bold: v }) },
    { key: 'italic', label: 'Kursiv', group: g.text, type: 'bool', get: (e, doc) => textStyle(doc, e).italic, set: (_e, v) => ({ italic: v }) },
    { key: 'underline', label: 'Unterstrichen', group: g.text, type: 'bool', get: (e, doc) => textStyle(doc, e).underline, set: (_e, v) => ({ underline: v }) },
    { key: 'w', label: 'Umbruchbreite (Papier-mm, 0 = auto)', group: g.graphics, type: 'number', get: (e) => e.w ?? 0, set: (_e, v) => ({ w: v > 0 ? v : undefined }) },
    { key: 'rot', label: 'Drehung', group: g.graphics, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v || undefined }) },
    { key: 'leaders', label: 'Führungslinien', group: g.graphics, type: 'button', get: (e) => `${(e.leaders ?? []).length} – entfernen`,
      action: (e, doc) => { if (e.id && doc.get(e.id)) doc.transaction('Führungslinien entfernen', () => doc.update(e.id, { leaders: undefined })); } },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

function textTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'size', label: 'Textgröße (mm)', group: g.text, type: 'number', get: (t) => t.size ?? 2.5, set: (_t, v) => ({ size: Math.max(0.5, v) }) },
    { key: 'font', label: 'Schriftart', group: g.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    widthFactorProp(g.text),
    { key: 'bold', label: 'Fett', group: g.text, type: 'bool', get: (t) => !!t.bold, set: (_t, v) => ({ bold: v }) },
    { key: 'italic', label: 'Kursiv', group: g.text, type: 'bool', get: (t) => !!t.italic, set: (_t, v) => ({ italic: v }) },
    { key: 'underline', label: 'Unterstrichen', group: g.text, type: 'bool', get: (t) => !!t.underline, set: (_t, v) => ({ underline: v }) },
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    { key: 'opaque', label: 'Hintergrund undurchsichtig', group: g.graphics, type: 'bool', get: (t) => !!t.opaque, set: (_t, v) => ({ opaque: v }) },
    { key: 'box', label: 'Rahmen anzeigen', group: g.graphics, type: 'bool', get: (t) => !!t.box, set: (_t, v) => ({ box: v }) },
    { key: 'leaderArrow', label: 'Führungslinie: Pfeilspitze', group: g.graphics, type: 'select', options: TICK_OPTIONS, get: (t) => t.leaderArrow ?? 'arrow', set: (_t, v) => ({ leaderArrow: v }) },
    { key: 'arrowSize', label: 'Pfeilgröße (mm)', group: g.graphics, type: 'number', get: (t) => t.arrowSize ?? 2.5, set: (_t, v) => ({ arrowSize: Math.max(0.5, v) }) },
  ];
}

// ------------------------------------------------------------ Bearbeiten (Overlay)
let activeEditor: { commit: () => void } | null = null;

/** Textfeld über der Ansicht. done(null) = abgebrochen. */
export function openTextEditor(vp: any, o: { p: V2; rot?: number; sizePaper: number; widthPaper?: number; ha?: HAlign; bold?: boolean; italic?: boolean }, initial: string, done: (s: string | null) => void): void {
  activeEditor?.commit();
  const stack = vp.el.querySelector('.vp-stack') as HTMLElement | null;
  if (!stack) { done(null); return; }
  const k: number = vp.pxPerPaperMm();
  const px = Math.max(11, Math.min(48, o.sizePaper * k));
  const sp = vp.toScreen(o.p);
  const ta = document.createElement('textarea');
  ta.value = initial;
  ta.spellcheck = true;
  Object.assign(ta.style, {
    position: 'absolute', left: sp.x - 3 + 'px', top: sp.y - 3 + 'px', zIndex: '30', font: `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px Arial, Helvetica, sans-serif`,
    lineHeight: '1.25', padding: '2px', border: '1px dashed #1e6fd9', background: 'rgba(255,255,255,0.96)', color: '#000', resize: 'both',
    textAlign: o.ha ?? 'left', transformOrigin: 'top left', transform: o.rot ? `rotate(${-(o.rot)}rad)` : '', minWidth: '60px', outline: 'none', overflow: 'hidden', whiteSpace: o.widthPaper ? 'pre-wrap' : 'pre',
  } as Partial<CSSStyleDeclaration>);
  const hint = document.createElement('div');
  hint.textContent = 'Strg+Eingabe oder Klick daneben: Fertig · Esc: Abbrechen';
  Object.assign(hint.style, { position: 'absolute', left: sp.x - 3 + 'px', top: sp.y - 22 + 'px', zIndex: '30', font: '11px Arial, sans-serif', background: '#fffbe6', border: '1px solid #a08040', padding: '1px 4px', pointerEvents: 'none' } as Partial<CSSStyleDeclaration>);
  const fit = () => {
    const lines = ta.value.split('\n');
    if (o.widthPaper) ta.style.width = Math.max(60, o.widthPaper * k + 8) + 'px';
    else ta.style.width = Math.max(4, Math.max(...lines.map((l) => l.length)) + 2) * px * 0.6 + 'px';
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 4 + 'px';
  };
  let closed = false;
  const close = (v: string | null) => {
    if (closed) return; closed = true;
    ta.remove(); hint.remove();
    if (activeEditor === ed) activeEditor = null;
    done(v);
  };
  const ed = { commit: () => close(ta.value) };
  activeEditor = ed;
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); close(ta.value); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (!closed && document.activeElement !== ta) close(ta.value); }, 120));
  stack.append(ta, hint);
  fit();
  setTimeout(() => { ta.focus(); if (initial) ta.select(); }, 0);
}

/** Vorhandenen Text bearbeiten (Overlay in passender Ansicht, sonst Dialog) */
export function editTextEl(el0: TextEl, vpIn?: any): void {
  const doc = app.doc; const el = doc.get<TextEl>(el0.id); if (!el) return;
  const vp: any = vpIn ?? app.active;
  const save = (s: string | null) => {
    if (s === null || s === el.s) return;
    if (!s.trim()) { doc.transaction('Text löschen', () => doc.remove(el.id)); return; }
    doc.transaction('Text bearbeiten', () => doc.update(el.id, { s }));
  };
  if (vp && vp.view?.id === el.viewId && vp.toScreen) {
    const st = textStyle(doc, el);
    openTextEditor(vp, { p: el.p, rot: el.rot, sizePaper: st.size, widthPaper: el.w, ha: el.ha, bold: st.bold, italic: st.italic }, el.s, save);
    return;
  }
  const ta = h('textarea', { rows: '6', style: 'width:100%;min-width:360px;font-family:Arial' }) as HTMLTextAreaElement;
  ta.value = el.s;
  modal('Text bearbeiten', h('div', {}, ta), [{ label: 'OK', primary: true, onClick: () => save(ta.value) }, { label: 'Abbrechen', onClick: () => {} }]);
}

// ------------------------------------------------------------ Werkzeug
export class TextTool extends Tool {
  id = 'text'; label = 'Text'; kinds = ANNO_KINDS;
  static leader: 'none' | 'one' = 'none';
  static ha: HAlign = 'left';
  private tip: V2 | null = null; private start: V2 | null = null; private cur: V2 | null = null;
  private editing = false; private closedAt = 0;
  activate(): void { this.placement = myPlacement('text', 'text', 'txt_25'); }
  deactivate(): void { activeEditor?.commit(); }
  prompt(): string {
    if (this.editing) return 'Text eingeben. Strg+Eingabe oder Klick daneben beendet die Eingabe.';
    if (TextTool.leader === 'one' && !this.tip) return 'Klicken Sie, um die Pfeilspitze der Führungslinie zu setzen.';
    return 'Klicken Sie, um den Text zu platzieren, oder ziehen Sie ein Rechteck für die Umbruchbreite.';
  }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'leader', label: 'Führungslinie', value: TextTool.leader, options: [['none', 'Keine'], ['one', 'Eine Führungslinie']], onChange: (v) => { TextTool.leader = v as any; this.tip = null; app.setPrompt(this.prompt()); } },
      { kind: 'select', key: 'ha', label: 'Ausrichtung', value: TextTool.ha, options: [['left', 'Links'], ['center', 'Zentriert'], ['right', 'Rechts']], onChange: (v) => { TextTool.ha = v as HAlign; } },
    ];
  }
  basePoint(): V2 | null { return this.tip; }
  move(e: ToolEvent): void { this.cur = e.raw; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.editing || performance.now() - this.closedAt < 250) return;
    if (TextTool.leader === 'one' && !this.tip) { this.tip = e.p; return; }
    this.start = e.raw;
  }
  up(e: ToolEvent): void {
    const a = this.start; this.start = null;
    if (!a || this.editing) return;
    const view = e.view; const s = view.scale;
    const drag = dist(e.vp.toScreen(a), e.screen) > 8;
    const p = drag ? { x: Math.min(a.x, e.raw.x), y: Math.max(a.y, e.raw.y) } : a;
    const w = drag ? Math.abs(e.raw.x - a.x) / s : undefined;
    const pr = this.placement!.proto; const st = textStyle(app.doc, pr);
    const tip = this.tip; this.tip = null;
    this.editing = true; app.setPrompt(this.prompt());
    openTextEditor(e.vp, { p, sizePaper: st.size, widthPaper: w, ha: TextTool.ha, bold: st.bold, italic: st.italic }, '', (txt) => {
      this.editing = false; this.closedAt = performance.now();
      if (txt && txt.trim()) {
        const el: TextEl = { id: newId('tx'), cat: 'text', viewId: view.id, typeId: pr.typeId, p, s: txt.replace(/\s+$/, '') } as TextEl;
        if (w) el.w = w;
        if (TextTool.ha !== 'left') el.ha = TextTool.ha;
        if (tip) el.leaders = [tip];
        for (const k of ['bold', 'italic', 'underline']) if (pr[k] !== undefined) (el as any)[k] = pr[k];
        app.doc.transaction('Text', () => app.doc.add(el));
      }
      app.setPrompt(this.prompt());
    });
  }
  escape(): boolean {
    if (this.tip || this.start) { this.tip = null; this.start = null; return true; }
    return false;
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur || this.editing) return;
    const s = vp.view.scale as number; const pen: Pen = { w: 1, color: PREV_COL, dash: 'dash' };
    const st = textStyle(app.doc, this.placement!.proto);
    if (this.start) {
      const a = this.start, c = this.cur;
      dl.poly([a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }], pen, true, { ns: true });
      return;
    }
    if (this.tip) {
      const i0 = dl.items.length;
      drawLeader(dl, [this.cur, this.tip], st.leaderArrow, st.arrowSize, { w: 1 });
      tint(dl, i0);
    }
    const hgt = st.size * s;
    dl.poly(rectPts(this.cur, { x: 1, y: 0 }, { x: 0, y: 1 }, 0, 0, hgt * 3, -hgt), pen, true, { ns: true });
    dl.text(this.cur, 'Text', { size: st.size, va: 'top', color: PREV_COL });
  }
}

/** Führungslinie an vorhandenen Text anhängen */
export class AddLeaderTool extends Tool {
  id = 'textLeader'; label = 'Führungslinie hinzufügen'; kinds = ANNO_KINDS;
  private cur: V2 | null = null;
  constructor(private textId: Id) { super(); }
  prompt(): string { return 'Klicken Sie, um die Pfeilspitze der neuen Führungslinie zu setzen.'; }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void {
    const t = app.doc.get<TextEl>(this.textId);
    if (t) app.doc.transaction('Führungslinie hinzufügen', () => app.doc.update(t.id, { leaders: [...(t.leaders ?? []), e.p] }));
    app.setTool(null); app.select([this.textId]);
  }
  preview(dl: DisplayList, vp: any): void {
    const t = app.doc.get<TextEl>(this.textId); if (!t || !this.cur) return;
    const i0 = dl.items.length; drawText(dl, { ...t, leaders: [this.cur] }, app.doc); tint(dl, i0);
    void vp;
  }
}

export { sub };
