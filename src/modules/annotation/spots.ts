// Höhenkoten (Schnitt/Ansicht: z des Punktes; Grundriss: Ebenenhöhe + Versatz) und Koordinaten.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, apply, applyVec, isMirror, fromAngle } from '../../core/geom';
import { registerCategory, PropDef, GROUPS, Grip } from '../../core/registry';
import { View, isPlanLike, isSectionLike, makeProjector, levelElev } from '../../core/view';
import { DisplayList, textWidth } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtNum } from '../../core/units';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { fontFamily, solid, myPlacement, previewEl, FONTS } from './common';

export interface Spot extends El {
  cat: 'spot'; viewId: Id;
  kind: 'elev' | 'coord';
  p: V2;
  /** Symbolposition relativ zu p (mit Führungslinie) */
  off?: V2;
  leader?: boolean;
  /** Versatz zur Ebenenhöhe (Grundriss) */
  zOff?: number;
  prefix?: string;
  flipX?: boolean; flipY?: boolean;
}

interface SpotStyle { symbol: string; symSize: number; size: number; prefix: string; dec: number; color: string; font: string }
function spotStyle(doc: Doc, el: El): SpotStyle {
  const t: any = doc.get(el.typeId) ?? {};
  return {
    symbol: t.symbol ?? (el.kind === 'coord' ? 'cross' : 'half'), symSize: t.symSize ?? 2.5, size: t.size ?? 2.5,
    prefix: t.prefix ?? '', dec: t.dec ?? (el.kind === 'coord' ? 3 : 2), color: t.color || '#000000', font: t.font ?? 'Arial',
  };
}

/** Höhe in m mit Vorzeichen (±0,00 / +3,00 / -0,45) */
export function fmtElevDec(mm: number, dec: number): string {
  const v = mm / 1000; const lim = 0.5 * Math.pow(10, -dec);
  return (v >= lim ? '+' : v <= -lim ? '-' : '±') + fmtNum(Math.abs(v), dec);
}

export function spotZ(doc: Doc, view: View, el: Spot): number {
  if (isSectionLike(view)) return el.p.y + makeProjector(view).origin.z;
  if (isPlanLike(view)) return levelElev(doc, view.levelId) + (el.zOff ?? 0);
  return el.p.y + (el.zOff ?? 0);
}

export function spotText(doc: Doc, view: View, el: Spot): string {
  const st = spotStyle(doc, el);
  if (el.kind === 'coord') return `O ${fmtNum(el.p.x / 1000, st.dec)}\nN ${fmtNum(el.p.y / 1000, st.dec)}`;
  return (el.prefix ?? st.prefix) + fmtElevDec(spotZ(doc, view, el), st.dec);
}

function symPos(el: Spot, s: number): V2 {
  if (el.kind === 'coord') return add(el.p, el.off ?? { x: 4 * s, y: 4 * s });
  return el.leader && el.off ? add(el.p, el.off) : el.p;
}

function drawSpot(dl: DisplayList, el: Spot, doc: Doc, view: View): void {
  const st = spotStyle(doc, el); const s = dl.scale; const h = st.symSize * s;
  const pen: Pen = { w: 1, color: st.color }; const pen2: Pen = { w: 2, color: st.color };
  const sx = el.flipX ? -1 : 1, sy = el.flipY ? -1 : 1;
  const tip = symPos(el, s);
  const txt = spotText(doc, view, el); const size = st.size * s; const gap = 0.8 * s;
  const lines = txt.split('\n'); const tw = Math.max(...lines.map((l) => textWidth(l, size)));
  const font = { size: st.size, color: st.color, family: fontFamily(st.font) };
  if (el.kind === 'coord') {
    const r = 0.8 * s;
    dl.circle(el.p, r, pen); dl.line(add(el.p, { x: -r * 1.6, y: 0 }), add(el.p, { x: r * 1.6, y: 0 }), pen, { ns: true }); dl.line(add(el.p, { x: 0, y: -r * 1.6 }), add(el.p, { x: 0, y: r * 1.6 }), pen, { ns: true });
    dl.line(el.p, tip, pen, { ns: true });
    const end = add(tip, { x: sx * (tw + gap * 2), y: 0 });
    dl.line(tip, end, pen, { ns: true });
    dl.text(add(tip, { x: sx * gap, y: gap * 0.6 }), txt, { ...font, ha: sx > 0 ? 'left' : 'right', va: 'bottom' });
    return;
  }
  if (el.leader && el.off) dl.line(el.p, tip, pen, { ns: true });
  if (st.symbol === 'circle') {
    const r = h * 0.5;
    dl.circle(tip, r, pen2, { color: '#ffffff' });
    for (const q of [0, 2]) {
      const a0 = (q * Math.PI) / 2; const pts: V2[] = [tip];
      for (let i = 0; i <= 8; i++) pts.push(add(tip, fromAngle(a0 + (Math.PI / 2) * (i / 8), r)));
      dl.fill([pts], solid(st.color), undefined, { ns: true });
    }
    dl.text(add(tip, { x: sx * (r + gap), y: 0 }), txt, { ...font, ha: sx > 0 ? 'left' : 'right', va: 'middle' });
    return;
  }
  const L = add(tip, { x: -0.6 * h, y: sy * h }), R = add(tip, { x: 0.6 * h, y: sy * h }), T = add(tip, { x: 0, y: sy * h });
  if (st.symbol === 'filled') dl.fill([[tip, L, R]], solid(st.color), pen2, { ns: true });
  else {
    dl.fill([[tip, L, R]], { color: '#ffffff' }, pen2, { ns: true });
    if (st.symbol === 'half') dl.fill([[tip, T, sx > 0 ? R : L]], solid(st.color), undefined, { ns: true });
  }
  // Schulterlinie mit Text darüber
  const near = sx > 0 ? L : R; const far = add(sx > 0 ? R : L, { x: sx * (gap * 2 + tw), y: 0 });
  dl.line(near, far, pen, { sub: 'line' });
  dl.text(add(sx > 0 ? R : L, { x: sx * gap, y: sy * gap * 0.6 }), txt, { ...font, ha: sx > 0 ? 'left' : 'right', va: sy > 0 ? 'bottom' : 'top' });
}

registerCategory({
  cat: 'spot', label: 'Höhenkote', plural: 'Höhenkoten', annotation: true, hasTypes: true, planOrder: 86,
  drawAnnotation: (dl, el, doc, view) => drawSpot(dl, el as Spot, doc, view),
  grips: (el, doc, view) => {
    const sp = el as Spot; const s = view.scale;
    const g: Grip[] = [{ id: 'p', p: sp.p, kind: 'end', tip: 'Bezugspunkt' }];
    if (sp.leader || sp.kind === 'coord') g.push({ id: 'sym', p: symPos(sp, s), kind: 'text', tip: 'Symbol verschieben' });
    g.push({ id: 'flip', p: add(symPos(sp, s), { x: (sp.flipX ? 1 : -1) * 4 * s, y: (sp.flipY ? -1 : 1) * 1.2 * s }), kind: 'flip', dir: { x: 1, y: 0 }, tip: 'Seite wechseln' });
    return g;
  },
  dragGrip: (el, id, p, _doc, view) => {
    const sp = el as Spot;
    if (id === 'p') return sp.leader || sp.kind === 'coord' ? { p, off: sub(symPos(sp, view.scale), p) } : { p };
    if (id === 'sym') return { off: sub(p, sp.p) };
  },
  clickGrip: (el, id) => (id === 'flip' ? { flipX: !el.flipX } : undefined),
  transform: (el, m) => {
    const sp = el as Spot; const patch: Partial<Spot> = { p: apply(m, sp.p) };
    if (sp.off) patch.off = applyVec(m, sp.off);
    if (isMirror(m)) patch.flipX = !sp.flipX;
    return patch;
  },
  center: (el) => el.p,
  props: () => spotProps(),
  typeProps: () => spotTypeProps(),
});

function spotProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'value', label: 'Wert', group: g.dims, type: 'readonly', get: (e, doc) => { const v = doc.get<View>(e.viewId); return v && e.p ? spotText(doc, v, e as Spot).replace('\n', ' / ') : ''; } },
    { key: 'zOff', label: 'Versatz (Grundriss)', group: g.constraints, type: 'length', get: (e) => e.zOff ?? 0, set: (_e, v) => ({ zOff: v || undefined }) },
    { key: 'prefix', label: 'Präfix (z. B. OKFF, OKRD, UK)', group: g.text, type: 'text', get: (e, doc) => e.prefix ?? (doc.get(e.typeId)?.prefix ?? ''), set: (_e, v) => ({ prefix: v }) },
    { key: 'leader', label: 'Führungslinie', group: g.graphics, type: 'bool', get: (e) => !!e.leader, set: (e, v) => ({ leader: v, off: v ? e.off ?? { x: 600, y: 600 } : e.off }) },
    { key: 'flipX', label: 'Text links', group: g.graphics, type: 'bool', get: (e) => !!e.flipX, set: (_e, v) => ({ flipX: v }) },
    { key: 'flipY', label: 'Symbol unterhalb (Spitze nach oben)', group: g.graphics, type: 'bool', get: (e) => !!e.flipY, set: (_e, v) => ({ flipY: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

function spotTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'symbol', label: 'Symbol', group: g.graphics, type: 'select', options: [['half', 'Dreieck halb gefüllt'], ['filled', 'Dreieck gefüllt (Fertigmaß)'], ['open', 'Dreieck offen (Rohbaumaß)'], ['circle', 'Kreis (Grundriss)'], ['cross', 'Kreuz (Koordinate)']], get: (t) => t.symbol ?? 'half', set: (_t, v) => ({ symbol: v }) },
    { key: 'symSize', label: 'Symbolgröße (mm)', group: g.graphics, type: 'number', get: (t) => t.symSize ?? 2.5, set: (_t, v) => ({ symSize: Math.max(0.5, v) }) },
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    { key: 'size', label: 'Textgröße (mm)', group: g.text, type: 'number', get: (t) => t.size ?? 2.5, set: (_t, v) => ({ size: Math.max(0.5, v) }) },
    { key: 'font', label: 'Schriftart', group: g.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    { key: 'prefix', label: 'Präfix', group: g.text, type: 'text', get: (t) => t.prefix ?? '', set: (_t, v) => ({ prefix: v }) },
    { key: 'dec', label: 'Nachkommastellen (m)', group: g.text, type: 'int', get: (t) => t.dec ?? 2, set: (_t, v) => ({ dec: Math.max(0, Math.min(4, Math.round(v))) }) },
  ];
}

// ------------------------------------------------------------ Werkzeug
export class SpotTool extends Tool {
  id: string; label: string; kinds: string[];
  leader: boolean;
  private start: V2 | null = null; private cur: V2 | null = null;
  constructor(public kind: 'elev' | 'coord') {
    super();
    this.id = kind === 'elev' ? 'spotElevation' : 'spotCoordinate';
    this.label = kind === 'elev' ? 'Höhenkote' : 'Koordinate';
    this.kinds = kind === 'elev' ? ['plan', 'ceiling', 'section', 'elevation', 'drafting'] : ['plan', 'ceiling'];
    this.leader = kind === 'coord';
  }
  activate(): void { this.placement = myPlacement(this.id, 'spot', this.kind === 'elev' ? 'spt_std' : 'spt_coord'); }
  prompt(): string { return this.start ? 'Klicken Sie, um das Symbol zu platzieren.' : this.kind === 'elev' ? 'Punkt wählen (in Schnitten/Ansichten wird die Höhe des Punktes angezeigt).' : 'Punkt wählen.'; }
  options(): OptionItem[] { return [{ kind: 'check', key: 'leader', label: 'Führungslinie', value: this.leader, onChange: (v) => { this.leader = v; this.start = null; } }]; }
  basePoint(): V2 | null { return this.start; }
  move(e: ToolEvent): void { this.cur = e.p; }
  private make(p: V2, off: V2 | undefined, view: View): Spot {
    const pr = this.placement!.proto;
    const sp: Spot = { id: '__spot', cat: 'spot', viewId: view.id, typeId: pr.typeId, kind: this.kind, p } as Spot;
    if (this.leader && off) { sp.leader = true; sp.off = off; }
    if (pr.prefix !== undefined) sp.prefix = pr.prefix;
    if (pr.zOff) sp.zOff = pr.zOff;
    return sp;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.leader && !this.start) { this.start = e.p; return; }
    const sp = this.start ? this.make(this.start, sub(e.p, this.start), e.view) : this.make(e.p, undefined, e.view);
    app.doc.transaction(this.label, () => app.doc.add({ ...sp, id: newId('sp') }));
    this.start = null;
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const view: View = vp.view;
    const sp = this.start ? this.make(this.start, sub(this.cur, this.start), view) : this.make(this.cur, this.kind === 'coord' ? { x: 4 * view.scale, y: 4 * view.scale } : undefined, view);
    previewEl(dl, sp, view);
  }
}

export { mul };
