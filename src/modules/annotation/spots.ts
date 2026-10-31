// Höhenkoten (Schnitt/Ansicht: z des Punktes; Grundriss: Ebenenhöhe + Versatz), Koordinaten und
// Koten-Kästchen der Decke (OK/UK/d der Decke/Platte unter dem Punkt). Darstellung nach Typ:
// DIN (Schulterlinie, Text darüber) oder Schweiz (Bezugslinie auf Höhe der Spitze, «OK +2.75»).
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, apply, applyVec, isMirror, fromAngle, pointInPoly } from '../../core/geom';
import { registerCategory, PropDef, GROUPS, Grip } from '../../core/registry';
import { View, isPlanLike, isSectionLike, makeProjector, levelElev, projectInfo, DEFAULT_RANGE, annoViewId } from '../../core/view';
import { DisplayList, textWidth } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { fontFamily, solid, myPlacement, previewEl, FONTS, PREV_COL } from './common';
import { fmtDec, fmtElevMode, fmtElevSigned, DecSep, ElevMode } from './numfmt';
import { defaultSpotType } from './types';

export type SpotKind = 'elev' | 'coord' | 'slab';
export interface Spot extends El {
  cat: 'spot'; viewId: Id;
  kind: SpotKind;
  p: V2;
  /** Symbolposition relativ zu p (mit Führungslinie) */
  off?: V2;
  leader?: boolean;
  /** Versatz zur Ebenenhöhe (Grundriss) */
  zOff?: number;
  prefix?: string;
  flipX?: boolean; flipY?: boolean;
  /** Koten-Kästchen: gewählte Decke/Platte (fehlt = automatisch am Punkt p) */
  refId?: Id;
  /** Höhenangabe abweichend vom Typ */
  elevMode?: ElevMode;
}

interface SpotStyle {
  symbol: string; symSize: number; size: number; prefix: string; dec: number; color: string; font: string;
  layout: 'din' | 'ch'; sep: DecSep; elevMode: ElevMode; slabRef: 'core' | 'all'; boxUK: boolean; boxD: boolean;
}
function spotStyle(doc: Doc, el: El): SpotStyle {
  const t: any = doc.get(el.typeId) ?? {};
  return {
    symbol: t.symbol ?? (el.kind === 'coord' ? 'cross' : 'half'), symSize: t.symSize ?? 2.5, size: t.size ?? 2.5,
    prefix: t.prefix ?? '', dec: t.dec ?? (el.kind === 'coord' ? 3 : 2), color: t.color || '#000000', font: t.font ?? 'Arial',
    layout: t.layout === 'ch' ? 'ch' : 'din', sep: t.sep === '.' ? '.' : ',', elevMode: el.elevMode ?? t.elevMode ?? 'rel',
    slabRef: t.slabRef === 'all' ? 'all' : 'core', boxUK: t.boxUK !== false, boxD: t.boxD !== false,
  };
}

/** Höhe in m mit Vorzeichen (±0,00 / +3,00 / -0,45); sep '.' für Schweizer Pläne */
export function fmtElevDec(mm: number, dec: number, sep: DecSep = ','): string { return fmtElevSigned(mm, dec, sep); }

export function spotZ(doc: Doc, view: View, el: Spot): number {
  if (isSectionLike(view)) return el.p.y + makeProjector(view).origin.z;
  if (isPlanLike(view)) return levelElev(doc, view.levelId) + (el.zOff ?? 0);
  return el.p.y + (el.zOff ?? 0);
}

/** Höhe formatiert nach Typ (relativ / m ü. M.) */
function fmtZ(doc: Doc, st: SpotStyle, z: number): string { return fmtElevMode(z, st.elevMode, projectInfo(doc)?.elev00, st.dec, st.sep); }

// ------------------------------------------------------------ Decken/Platten am Punkt (Koten-Kästchen)
export const SLAB_CATS = ['floor', 'foundationSlab'];
export interface SlabHit { el: El; top: number; bot: number; d: number }

/** OK/UK/Dicke einer Decke (Typschichten, Bezug Tragschicht) bzw. Fundamentplatte (Typdicke) */
export function slabLevels(doc: Doc, el: El, ref: 'core' | 'all' = 'core'): SlabHit {
  const t: any = doc.get(el.typeId) ?? {};
  const top0 = levelElev(doc, el.levelId) + (el.offset ?? 0);
  if (el.cat !== 'floor') { const d = t.t ?? 300; return { el, top: top0, bot: top0 - d, d }; }
  const L: { t: number; core?: boolean }[] = t.layers ?? [];
  const all = L.length ? L.reduce((s, l) => s + l.t, 0) : 200;
  const i0 = L.findIndex((l) => l.core); let i1 = -1;
  for (let i = L.length - 1; i >= 0; i--) if (L[i].core) { i1 = i; break; }
  if (ref === 'all' || i0 < 0) return { el, top: top0, bot: top0 - all, d: all };
  const above = L.slice(0, i0).reduce((s, l) => s + l.t, 0); const d = L.slice(i0, i1 + 1).reduce((s, l) => s + l.t, 0);
  return { el, top: top0 - above, bot: top0 - above - d, d };
}

const hiddenIn = (view: View, el: El) => !!(view.hiddenEls?.includes(el.id) || view.hiddenCats?.includes(el.cat));
const isStructural = (el: El) => el.cat !== 'floor' || !!el.structural;

/**
 * Decken/Platten unter Punkt p (Grundriss), sortiert: sichtbar, tragend, Nähe zur Ebene
 * (Grundriss: OK nahe Ebenenhöhe; Deckenplan: UK knapp über der Schnitthöhe).
 */
export function slabsAt(doc: Doc, view: View, p: V2, ref: 'core' | 'all' = 'core'): SlabHit[] {
  const E = levelElev(doc, view.levelId); const cutZ = E + (view.range ?? DEFAULT_RANGE).cut;
  const out: { h: SlabHit; score: number }[] = [];
  for (const cat of SLAB_CATS) for (const el of doc.all(cat)) {
    if (!el.loops?.length || !pointInPoly(p, el.loops)) continue;
    const h = slabLevels(doc, el, ref);
    let score = view.kind === 'ceiling' ? (h.bot >= cutZ - 1 ? h.bot - cutZ : 1e7 + cutZ - h.bot) : Math.abs(h.top - E);
    if (!isStructural(el)) score += 1e8;
    if (hiddenIn(view, el)) score += 1e9;
    out.push({ h, score });
  }
  return out.sort((a, b) => a.score - b.score).map((x) => x.h);
}

/** Decke eines Koten-Kästchens (gewählt oder automatisch am Bezugspunkt) */
export function spotSlab(doc: Doc, view: View, el: Spot): SlabHit | null {
  const st = spotStyle(doc, el);
  const r = el.refId ? doc.get(el.refId) : undefined;
  if (r && SLAB_CATS.includes(r.cat)) return slabLevels(doc, r, st.slabRef);
  return isPlanLike(view) ? slabsAt(doc, view, el.p, st.slabRef)[0] ?? null : null;
}

/** Zeilen des Koten-Kästchens: «OK -0.10», «UK -0.34», «d = 24 cm» */
function slabLines(doc: Doc, view: View, el: Spot, st: SpotStyle): string[] {
  const s = spotSlab(doc, view, el);
  const pre = el.prefix ?? st.prefix;
  if (!s) return [pre + 'OK ?'];
  const cm = s.d / 10; const dTxt = fmtDec(cm, Math.abs(cm - Math.round(cm)) < 0.05 ? 0 : 1, st.sep);
  const lines = [`${pre}OK ${fmtZ(doc, st, s.top)}`];
  if (st.boxUK) lines.push(`UK ${fmtZ(doc, st, s.bot)}`);
  if (st.boxD) lines.push(`d = ${dTxt} cm`);
  return lines;
}

export function spotText(doc: Doc, view: View, el: Spot): string {
  const st = spotStyle(doc, el);
  if (el.kind === 'coord') return `O ${fmtDec(el.p.x / 1000, st.dec, st.sep)}\nN ${fmtDec(el.p.y / 1000, st.dec, st.sep)}`;
  if (el.kind === 'slab') return slabLines(doc, view, el, st).join('\n');
  return (el.prefix ?? st.prefix) + fmtZ(doc, st, spotZ(doc, view, el));
}

function symPos(el: Spot, s: number): V2 {
  if (el.kind === 'coord') return add(el.p, el.off ?? { x: 4 * s, y: 4 * s });
  return el.leader && el.off ? add(el.p, el.off) : el.p;
}

/** Dreieck (Spitze bei tip, Breite 1,25·h); Füllung nach Symbol */
function triangle(dl: DisplayList, tip: V2, h: number, sx: number, sy: number, st: SpotStyle, pen2: Pen, hw = 0.6): void {
  const L = add(tip, { x: -hw * h, y: sy * h }), R = add(tip, { x: hw * h, y: sy * h }), T = add(tip, { x: 0, y: sy * h });
  if (st.symbol === 'filled') dl.fill([[tip, L, R]], solid(st.color), pen2, { ns: true });
  else {
    dl.fill([[tip, L, R]], { color: '#ffffff' }, pen2, { ns: true });
    if (st.symbol === 'half') dl.fill([[tip, T, sx > 0 ? R : L]], solid(st.color), undefined, { ns: true });
  }
}

function drawSlabBox(dl: DisplayList, el: Spot, doc: Doc, view: View, st: SpotStyle): void {
  const s = dl.scale; const c = symPos(el, s);
  const pen: Pen = { w: 1, color: st.color }; const pen2: Pen = { w: 2, color: st.color };
  const lines = slabLines(doc, view, el, st); const size = st.size * s; const lh = size * 1.5;
  const w = Math.max(...lines.map((l) => textWidth(l, size))) + 2.4 * s; const hh = lines.length * lh + 1.0 * s;
  if (el.leader && el.off) dl.line(el.p, c, pen, { ns: true });
  const x0 = c.x - w / 2, x1 = c.x + w / 2, y0 = c.y - hh / 2, y1 = c.y + hh / 2;
  dl.fill([[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]], { color: '#ffffff' }, pen2, { sub: 'box' });
  const font = { size: st.size, color: st.color, family: fontFamily(st.font), ha: 'center' as const };
  // Zeilenblock (Versalhöhe ≈ 0,72 · Schriftgröße) vertikal zentriert
  const top = c.y + ((lines.length - 1) * lh + 0.72 * size) / 2;
  lines.forEach((l, i) => dl.text({ x: c.x, y: top - 0.72 * size - i * lh }, l, font));
}

function drawSpot(dl: DisplayList, el: Spot, doc: Doc, view: View): void {
  const st = spotStyle(doc, el); const s = dl.scale; const h = st.symSize * s;
  if (el.kind === 'slab') { drawSlabBox(dl, el, doc, view, st); return; }
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
  if (st.layout === 'ch') {
    // Schweiz: Bezugslinie auf Höhe der Spitze, Text neben/über dem Dreieck («OK +2.75»)
    triangle(dl, tip, h, sx, sy, st, pen2, 0.625);
    const tx = 1.6 * s;
    dl.line(add(tip, { x: -sx * 1.2 * s, y: 0 }), add(tip, { x: sx * (tx + tw + 1.1 * s), y: 0 }), pen, { sub: 'line' });
    dl.text(add(tip, { x: sx * tx, y: sy * (h + 0.4 * s) }), txt, { ...font, ha: sx > 0 ? 'left' : 'right', va: sy > 0 ? 'baseline' : 'top' });
    return;
  }
  triangle(dl, tip, h, sx, sy, st, pen2);
  const L = add(tip, { x: -0.6 * h, y: sy * h }), R = add(tip, { x: 0.6 * h, y: sy * h });
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
    if (sp.kind !== 'slab') g.push({ id: 'flip', p: add(symPos(sp, s), { x: (sp.flipX ? 1 : -1) * 4 * s, y: (sp.flipY ? -1 : 1) * 1.2 * s }), kind: 'flip', dir: { x: 1, y: 0 }, tip: 'Seite wechseln' });
    void doc;
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
    if (isMirror(m) && sp.kind !== 'slab') patch.flipX = !sp.flipX;
    return patch;
  },
  center: (el) => el.p,
  props: (el) => spotProps(el as Spot),
  typeProps: () => spotTypeProps(),
});

const ELEV_OPTS: [string, string][] = [['rel', 'Relativ (±0.00)'], ['abs', 'Absolut (m ü. M.)'], ['both', 'Relativ und absolut']];

function spotProps(el?: Spot): PropDef[] {
  const g = GROUPS;
  const p: PropDef[] = [
    { key: 'value', label: 'Wert', group: g.dims, type: 'readonly', get: (e, doc) => { const v = doc.get<View>(e.viewId); return v && e.p ? spotText(doc, v, e as Spot).replace(/\n/g, ' / ') : ''; } },
  ];
  if (el?.kind === 'slab') {
    p.push(
      { key: 'slab', label: 'Decke / Platte', group: g.constraints, type: 'readonly', get: (e, doc) => {
        const v = doc.get<View>(e.viewId); const s = v ? spotSlab(doc, v, e as Spot) : null;
        return s ? `${doc.get(s.el.typeId)?.name ?? s.el.cat}${e.refId ? '' : ' (automatisch)'}` : '–';
      } },
      { key: 'nextSlab', label: 'Decke wechseln', group: g.constraints, type: 'button', get: () => 'Nächste am Punkt', action: (e, doc) => {
        const v = doc.get<View>(e.viewId); if (!v || !doc.get(e.id)) return;
        const c = slabsAt(doc, v, e.p); if (!c.length) return;
        const cur = spotSlab(doc, v, e as Spot); const i = c.findIndex((x) => x.el.id === cur?.el.id);
        doc.transaction('Decke wechseln', () => doc.update(e.id, { refId: c[(i + 1) % c.length].el.id }));
      } },
    );
  } else p.push({ key: 'zOff', label: 'Versatz (Grundriss)', group: g.constraints, type: 'length', get: (e) => e.zOff ?? 0, set: (_e, v) => ({ zOff: v || undefined }) });
  p.push(
    { key: 'elevMode', label: 'Höhenangabe', group: g.text, type: 'select', options: [['', 'Wie Typ'], ...ELEV_OPTS], get: (e) => e.elevMode ?? '', set: (_e, v) => ({ elevMode: v || undefined }) },
    { key: 'prefix', label: 'Präfix (z. B. OK, UK, OKFF, OKRD)', group: g.text, type: 'text', get: (e, doc) => e.prefix ?? (doc.get(e.typeId)?.prefix ?? ''), set: (_e, v) => ({ prefix: v }) },
    { key: 'leader', label: 'Führungslinie', group: g.graphics, type: 'bool', get: (e) => !!e.leader, set: (e, v) => ({ leader: v, off: v ? e.off ?? { x: 600, y: 600 } : e.off }) },
  );
  if (el?.kind !== 'slab') p.push(
    { key: 'flipX', label: 'Text links', group: g.graphics, type: 'bool', get: (e) => !!e.flipX, set: (_e, v) => ({ flipX: v }) },
    { key: 'flipY', label: 'Symbol unterhalb (Spitze nach oben)', group: g.graphics, type: 'bool', get: (e) => !!e.flipY, set: (_e, v) => ({ flipY: v }) },
  );
  p.push({ key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) });
  return p;
}

function spotTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'symbol', label: 'Symbol', group: g.graphics, type: 'select', options: [['half', 'Dreieck halb gefüllt'], ['filled', 'Dreieck gefüllt (DE: Fertigmaß, CH: Rohbau)'], ['open', 'Dreieck offen (DE: Rohbaumaß, CH: Fertig)'], ['circle', 'Kreis (Grundriss)'], ['cross', 'Kreuz (Koordinate)'], ['box', 'Kästchen (Decke OK/UK/d)']], get: (t) => t.symbol ?? 'half', set: (_t, v) => ({ symbol: v }) },
    { key: 'layout', label: 'Darstellung', group: g.graphics, type: 'select', options: [['din', 'DIN (Schulterlinie, Text darüber)'], ['ch', 'Schweiz (Bezugslinie an der Spitze)']], get: (t) => t.layout ?? 'din', set: (_t, v) => ({ layout: v }) },
    { key: 'symSize', label: 'Symbolgröße (mm)', group: g.graphics, type: 'number', get: (t) => t.symSize ?? 2.5, set: (_t, v) => ({ symSize: Math.max(0.5, v) }) },
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    { key: 'size', label: 'Textgröße (mm)', group: g.text, type: 'number', get: (t) => t.size ?? 2.5, set: (_t, v) => ({ size: Math.max(0.5, v) }) },
    { key: 'font', label: 'Schriftart', group: g.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    { key: 'prefix', label: 'Präfix', group: g.text, type: 'text', get: (t) => t.prefix ?? '', set: (_t, v) => ({ prefix: v }) },
    { key: 'dec', label: 'Nachkommastellen (m)', group: g.text, type: 'int', get: (t) => t.dec ?? 2, set: (_t, v) => ({ dec: Math.max(0, Math.min(4, Math.round(v))) }) },
    { key: 'sep', label: 'Dezimaltrennzeichen', group: g.text, type: 'select', options: [[',', 'Komma (+2,75)'], ['.', 'Punkt (+2.75)']], get: (t) => (t.sep === '.' ? '.' : ','), set: (_t, v) => ({ sep: v }) },
    { key: 'elevMode', label: 'Höhenangabe', group: g.text, type: 'select', options: ELEV_OPTS, get: (t) => t.elevMode ?? 'rel', set: (_t, v) => ({ elevMode: v }) },
    { key: 'slabRef', label: 'Kästchen: Bezug', group: g.other, type: 'select', options: [['core', 'Tragschicht (Rohbau)'], ['all', 'Gesamter Aufbau']], get: (t) => t.slabRef ?? 'core', set: (_t, v) => ({ slabRef: v }) },
    { key: 'boxUK', label: 'Kästchen: UK anzeigen', group: g.other, type: 'bool', get: (t) => t.boxUK !== false, set: (_t, v) => ({ boxUK: v }) },
    { key: 'boxD', label: 'Kästchen: Dicke d anzeigen', group: g.other, type: 'bool', get: (t) => t.boxD !== false, set: (_t, v) => ({ boxD: v }) },
  ];
}

// ------------------------------------------------------------ Werkzeug
export class SpotTool extends Tool {
  id: string; label: string; kinds: string[];
  leader: boolean;
  private start: V2 | null = null; private cur: V2 | null = null;
  /** Koten-Kästchen: Decken am Bezugspunkt, Tab wechselt */
  private cands: SlabHit[] = []; private cyc = 0; private candKey = '';
  constructor(public kind: SpotKind) {
    super();
    this.id = kind === 'elev' ? 'spotElevation' : kind === 'slab' ? 'spotSlab' : 'spotCoordinate';
    this.label = kind === 'elev' ? 'Höhenkote' : kind === 'slab' ? 'Koten-Kästchen' : 'Koordinate';
    this.kinds = kind === 'elev' ? ['plan', 'ceiling', 'section', 'elevation', 'drafting'] : ['plan', 'ceiling'];
    this.leader = kind === 'coord';
  }
  activate(): void { this.placement = myPlacement(this.id, 'spot', defaultSpotType(app.doc, this.kind)); }
  prompt(): string {
    if (this.start) return 'Klicken Sie, um das Symbol zu platzieren.';
    if (this.kind === 'slab') return 'Punkt in einer Decke/Platte wählen (Tab wechselt zwischen übereinanderliegenden Decken).';
    return this.kind === 'elev' ? 'Punkt wählen (in Schnitten/Ansichten wird die Höhe des Punktes angezeigt).' : 'Punkt wählen.';
  }
  options(): OptionItem[] { return [{ kind: 'check', key: 'leader', label: 'Führungslinie', value: this.leader, onChange: (v) => { this.leader = v; this.start = null; } }]; }
  basePoint(): V2 | null { return this.start; }
  move(e: ToolEvent): void {
    this.cur = e.p;
    if (this.kind !== 'slab' || this.start) return;
    this.cands = slabsAt(app.doc, e.view, e.p);
    const key = this.cands.map((c) => c.el.id).join(';');
    if (key !== this.candKey) { this.candKey = key; this.cyc = 0; }
  }
  key(e: KeyboardEvent): boolean {
    if (e.key === 'Tab' && this.kind === 'slab' && this.cands.length > 1) { this.cyc++; app.redrawOverlay(); return true; }
    return false;
  }
  private cand(): SlabHit | null { return this.cands.length ? this.cands[this.cyc % this.cands.length] : null; }
  private make(p: V2, off: V2 | undefined, view: View): Spot {
    const pr = this.placement!.proto;
    const sp: Spot = { id: '__spot', cat: 'spot', viewId: annoViewId(app.doc, view), typeId: pr.typeId, kind: this.kind, p } as Spot;
    if (this.leader && off) { sp.leader = true; sp.off = off; }
    if (pr.prefix !== undefined) sp.prefix = pr.prefix;
    if (pr.zOff) sp.zOff = pr.zOff;
    const c = this.kind === 'slab' ? this.cand() : null;
    if (c) sp.refId = c.el.id;
    return sp;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.leader && !this.start) { this.start = e.p; app.setPrompt(this.prompt()); return; }
    const sp = this.start ? this.make(this.start, sub(e.p, this.start), e.view) : this.make(e.p, undefined, e.view);
    if (this.kind === 'slab' && !sp.refId) { app.status('Keine Decke/Platte am gewählten Punkt.'); this.start = null; return; }
    app.doc.transaction(this.label, () => app.doc.add({ ...sp, id: newId('sp') }));
    this.start = null;
    app.setPrompt(this.prompt());
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const view: View = vp.view;
    const c = this.kind === 'slab' ? this.cand() : null;
    if (c) for (const r of c.el.loops as V2[][]) dl.poly(r, { w: 5, color: PREV_COL }, true, { ns: true });
    const sp = this.start ? this.make(this.start, sub(this.cur, this.start), view) : this.make(this.cur, this.kind === 'coord' ? { x: 4 * view.scale, y: 4 * view.scale } : undefined, view);
    previewEl(dl, sp, view);
  }
}

export { mul };
