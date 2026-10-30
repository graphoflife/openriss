// Ändern-Werkzeuge: Verschieben, Kopieren, Drehen, Spiegeln, Reihe, Skalieren, Ausrichten,
// Stutzen/Dehnen, Teilen, Versatz, Typ anpassen, Messen, Einfügen.
import { app } from '../app';
import { Tool, ToolEvent, OptionItem } from './tool';
import type { El, Id } from '../core/doc';
import {
  V2, add, sub, mul, norm, perp, dist, dot, cross, angleOf, translation, rotation, mirrorMat, scaling, compose,
  lineLine, projectT, lerp, Mat2, closestOnLine, mid, deg, rad,
} from '../core/geom';
import { catDef } from '../core/registry';
import { DisplayList, transformPrim } from '../render/displayList';
import { transformElements, copyTransform, selectionCenter } from './ops';
import { PREVIEW, PREVIEW_THIN, listen } from './drawTool';
import { fmtLen, fmtNum, parseNum } from '../core/units';
import { Wall, wallInfo, keepHostedAbsolute } from '../elements/wall';
import { hostedBy } from '../core/cache';
import { isPlanLike } from '../core/view';

const GHOST = '#1e6fd9';

/** Vorschau: ausgewählte Elemente transformiert zeichnen */
function ghost(dl: DisplayList, vp: any, ids: Set<Id>, m: Mat2): void {
  const src: DisplayList = vp.displayList();
  for (const it of src.items) {
    if (!it.o || !ids.has(it.o) || it.k === 'clip' || it.sel) continue;
    const t: any = transformPrim(it, m);
    if (t.pen) t.pen = { ...t.pen, color: GHOST };
    if (t.k === 'fill') { t.fill = { color: 'transparent' }; t.pen = t.pen ?? { w: 1, color: GHOST }; }
    if (t.k === 'text') t.font = { ...t.font, color: GHOST };
    if (t.k === 'circle' && t.fill) t.fill = undefined, t.pen = t.pen ?? { w: 1, color: GHOST };
    t.ns = true;
    dl.items.push(t);
  }
}

function withHosted(ids: Id[]): Set<Id> {
  const s = new Set(ids);
  for (const id of ids) for (const h of hostedBy(app.doc, id)) s.add(h.id);
  return s;
}

/** Basis: Werkzeug, das eine Auswahl benötigt (vorher wählen oder im Werkzeug wählen + Enter) */
abstract class SelectionTool extends Tool {
  protected ids: Id[] = [];
  protected selecting = false;
  activate(): void {
    this.ids = [...app.selection].filter((id) => !app.doc.get(id)?.pinned);
    this.selecting = this.ids.length === 0;
    if (app.selection.size && !this.ids.length) app.status('Fixierte Elemente können nicht geändert werden (UP zum Lösen).');
  }
  prompt(): string { return this.selecting ? 'Elemente auswählen und mit Enter bestätigen.' : this.stepPrompt(); }
  abstract stepPrompt(): string;
  abstract stepDown(e: ToolEvent): void;
  down(e: ToolEvent): void {
    if (this.selecting) {
      const h = e.vp.hit(e.raw)[0];
      if (h) { app.select([h.id], e.shift ? 'remove' : 'add'); }
      return;
    }
    this.stepDown(e);
  }
  enter(): boolean {
    if (this.selecting) {
      this.ids = [...app.selection].filter((id) => !app.doc.get(id)?.pinned);
      if (this.ids.length) { this.selecting = false; app.setPrompt(this.prompt()); }
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------ Verschieben / Kopieren
export class MoveTool extends SelectionTool {
  id = 'move'; label = 'Verschieben';
  protected start: V2 | null = null; protected cur: V2 | null = null;
  constrain = false;
  stepPrompt(): string { return this.start ? 'Zielpunkt klicken oder Abstand eingeben.' : 'Startpunkt klicken.'; }
  basePoint() { return this.start; }
  options(): OptionItem[] { return [{ kind: 'check', key: 'constrain', label: 'Beschränken', value: this.constrain, onChange: (v) => (this.constrain = v) }]; }
  protected target(p: V2): V2 {
    if (!this.constrain || !this.start) return p;
    const d = sub(p, this.start);
    return Math.abs(d.x) > Math.abs(d.y) ? { x: p.x, y: this.start.y } : { x: this.start.x, y: p.y };
  }
  stepDown(e: ToolEvent): void {
    if (!this.start) { this.start = e.p; return; }
    this.finish(this.target(e.p), e);
  }
  protected finish(p: V2, e: ToolEvent | null): void {
    const d = sub(p, this.start!);
    const view = e?.view ?? app.activeView()!;
    app.doc.transaction(this.label, () => transformElements(this.ids, translation(d.x, d.y), view));
    app.setTool(null);
  }
  move(e: ToolEvent): void { this.cur = this.target(e.p); }
  typedLength(L: number): void {
    if (!this.start || !this.cur) return;
    const d = norm(sub(this.cur, this.start));
    this.finish(add(this.start, mul(d, L)), null);
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.start || !this.cur) return;
    const d = sub(this.cur, this.start);
    ghost(dl, vp, withHosted(this.ids), translation(d.x, d.y));
    dl.line(this.start, this.cur, PREVIEW_THIN);
    listen(dl, this.start, this.cur, vp.view.scale);
  }
}

export class CopyTool extends MoveTool {
  id = 'copy'; label = 'Kopieren';
  multiple = false;
  options(): OptionItem[] { return [...super.options(), { kind: 'check', key: 'multi', label: 'Mehrfach', value: this.multiple, onChange: (v) => (this.multiple = v) }]; }
  protected finish(p: V2, e: ToolEvent | null): void {
    const d = sub(p, this.start!);
    const view = e?.view ?? app.activeView()!;
    let newIds: Id[] = [];
    app.doc.transaction(this.label, () => { newIds = copyTransform(this.ids, translation(d.x, d.y), view); });
    if (!this.multiple) { app.setTool(null); app.select(newIds); }
  }
}

// ------------------------------------------------------------ Drehen
export class RotateTool extends SelectionTool {
  id = 'rotate'; label = 'Drehen';
  private center: V2 | null = null; private a: V2 | null = null; private cur: V2 | null = null;
  private placingCenter = false;
  copy = false; angle = 0;
  activate(): void { super.activate(); }
  private ensureCenter(vp: any): void { if (!this.center && this.ids.length) this.center = selectionCenter(this.ids, vp.view, vp); }
  stepPrompt(): string { return this.placingCenter ? 'Drehzentrum klicken.' : !this.a ? 'Startstrahl klicken (Leertaste: Drehzentrum setzen) oder Winkel eingeben.' : 'Endstrahl klicken.'; }
  basePoint() { return this.placingCenter ? null : this.center; }
  options(): OptionItem[] {
    return [
      { kind: 'check', key: 'copy', label: 'Kopieren', value: this.copy, onChange: (v) => (this.copy = v) },
      { kind: 'angle', key: 'angle', label: 'Winkel', value: this.angle, onChange: (v) => { this.angle = v; if (v) this.apply(rad(v), null); } },
      { kind: 'button', label: 'Zentrum: Ort', onClick: () => { this.placingCenter = true; app.setPrompt(this.prompt()); } },
    ];
  }
  space(): boolean { this.placingCenter = true; app.setPrompt(this.prompt()); return true; }
  stepDown(e: ToolEvent): void {
    this.ensureCenter(e.vp);
    if (this.placingCenter) { this.center = e.p; this.placingCenter = false; return; }
    if (!this.a) { this.a = e.p; return; }
    const ang = angleOf(sub(e.p, this.center!)) - angleOf(sub(this.a, this.center!));
    this.apply(ang, e);
  }
  private apply(ang: number, e: ToolEvent | null): void {
    const view = e?.view ?? app.activeView()!;
    if (!this.center) this.ensureCenter(app.active);
    if (!this.center) return;
    const m = rotation(ang, this.center);
    if (this.copy) app.doc.transaction('Drehen (Kopie)', () => copyTransform(this.ids, m, view));
    else app.doc.transaction('Drehen', () => transformElements(this.ids, m, view));
    app.setTool(null);
  }
  typedLength(v: number): void { /* Zahleneingabe = Winkel in Grad */ this.apply(rad(v), null); }
  move(e: ToolEvent): void { this.ensureCenter(e.vp); this.cur = e.p; }
  escape(): boolean { if (this.a) { this.a = null; return true; } if (this.placingCenter) { this.placingCenter = false; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    this.ensureCenter(vp);
    const c = this.center; if (!c) return;
    const r = vp.view.scale * 2;
    dl.circle(c, r, { w: 2, color: GHOST }); dl.line(sub(c, { x: r * 1.5, y: 0 }), add(c, { x: r * 1.5, y: 0 }), { w: 1, color: GHOST }); dl.line(sub(c, { x: 0, y: r * 1.5 }), add(c, { x: 0, y: r * 1.5 }), { w: 1, color: GHOST });
    if (this.a) dl.line(c, this.a, PREVIEW_THIN);
    if (this.a && this.cur) {
      dl.line(c, this.cur, PREVIEW_THIN);
      const ang = angleOf(sub(this.cur, c)) - angleOf(sub(this.a, c));
      ghost(dl, vp, withHosted(this.ids), rotation(ang, c));
      let dd = deg(ang); while (dd < -180) dd += 360; while (dd > 180) dd -= 360;
      dl.text(add(this.cur, { x: vp.view.scale * 3, y: vp.view.scale * 3 }), fmtNum(dd, 2) + '°', { size: 2.6, color: '#1b3f66', opaque: true });
    }
  }
}

// ------------------------------------------------------------ Spiegeln
function curveAt(e: ToolEvent, filter?: (el: El) => boolean): { a: V2; b: V2; id: Id | null } | null {
  const hits = e.vp.hit(e.raw);
  for (const h of hits) {
    const el = app.doc.get(h.id); if (!el || (filter && !filter(el))) continue;
    const c = catDef(el.cat)?.curve?.(el, app.doc, e.view);
    if (c) return { ...c, id: el.id };
  }
  const segs = e.vp.displayList().segmentsNear(e.raw, e.vp.hitTol());
  if (segs.length) return { a: segs[0].a, b: segs[0].b, id: segs[0].o };
  return null;
}

export class MirrorTool extends SelectionTool {
  id: string; label: string;
  private hoverAxis: { a: V2; b: V2 } | null = null; private start: V2 | null = null; private cur: V2 | null = null;
  copy = true;
  constructor(public draw: boolean) { super(); this.id = draw ? 'mirrorDraw' : 'mirrorPick'; this.label = draw ? 'Spiegeln - Achse zeichnen' : 'Spiegeln - Achse wählen'; }
  stepPrompt(): string { return this.draw ? (this.start ? 'Endpunkt der Spiegelachse' : 'Startpunkt der Spiegelachse') : 'Linie oder Wand als Spiegelachse wählen.'; }
  basePoint() { return this.draw ? this.start : null; }
  options(): OptionItem[] { return [{ kind: 'check', key: 'copy', label: 'Kopieren', value: this.copy, onChange: (v) => (this.copy = v) }]; }
  move(e: ToolEvent): void {
    this.cur = e.p;
    if (!this.draw && !this.selecting) {
      const c = curveAt(e, (el) => !this.ids.includes(el.id));
      this.hoverAxis = c;
      if (c && c.id && app.doc.get(c.id)?.cat === 'wall') { const wi = wallInfo(app.doc, app.doc.get<Wall>(c.id)!); this.hoverAxis = { a: wi.c0, b: wi.c1 }; }
    }
  }
  stepDown(e: ToolEvent): void {
    if (this.draw) {
      if (!this.start) { this.start = e.p; return; }
      this.apply(this.start, e.p, e);
      return;
    }
    if (this.hoverAxis) this.apply(this.hoverAxis.a, this.hoverAxis.b, e);
  }
  private apply(a: V2, b: V2, e: ToolEvent): void {
    if (dist(a, b) < 1) return;
    const m = mirrorMat(a, b);
    if (this.copy) {
      let ids: Id[] = [];
      app.doc.transaction('Spiegeln', () => { ids = copyTransform(this.ids, m, e.view); });
      app.select(ids);
    } else app.doc.transaction('Spiegeln', () => transformElements(this.ids, m, e.view));
    app.setTool(null);
  }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    let axis: { a: V2; b: V2 } | null = null;
    if (this.draw && this.start && this.cur) axis = { a: this.start, b: this.cur };
    if (!this.draw) axis = this.hoverAxis;
    if (!axis || dist(axis.a, axis.b) < 1) return;
    const d = norm(sub(axis.b, axis.a)); const L = 1e5;
    dl.line(sub(axis.a, mul(d, L)), add(axis.a, mul(d, L)), { w: 1, color: GHOST, dash: 'center' });
    ghost(dl, vp, withHosted(this.ids), mirrorMat(axis.a, axis.b));
  }
}

// ------------------------------------------------------------ Reihe
export class ArrayTool extends MoveTool {
  id = 'array'; label = 'Reihe';
  count = 3; toLast = false;
  options(): OptionItem[] {
    return [
      { kind: 'number', key: 'count', label: 'Anzahl', value: this.count, onChange: (v) => (this.count = Math.max(2, Math.round(v))) },
      { kind: 'select', key: 'to', label: 'Verschieben zu', value: this.toLast ? 'last' : 'second', options: [['second', '2.'], ['last', 'Letztes']], onChange: (v) => (this.toLast = v === 'last') },
      ...super.options(),
    ];
  }
  protected finish(p: V2, e: ToolEvent | null): void {
    const d0 = sub(p, this.start!);
    const step = this.toLast ? mul(d0, 1 / (this.count - 1)) : d0;
    const view = e?.view ?? app.activeView()!;
    app.doc.transaction('Reihe', () => { for (let i = 1; i < this.count; i++) copyTransform(this.ids, translation(step.x * i, step.y * i), view); });
    app.setTool(null);
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.start || !this.cur) return;
    const d0 = sub(this.cur, this.start);
    const step = this.toLast ? mul(d0, 1 / (this.count - 1)) : d0;
    const ids = withHosted(this.ids);
    for (let i = 1; i < this.count; i++) ghost(dl, vp, ids, translation(step.x * i, step.y * i));
    listen(dl, this.start, this.cur, vp.view.scale);
  }
}

// ------------------------------------------------------------ Skalieren
export class ScaleTool extends SelectionTool {
  id = 'scale'; label = 'Skalieren';
  factor = 2; graphical = false;
  private base: V2 | null = null; private p1: V2 | null = null; private cur: V2 | null = null;
  stepPrompt(): string { return !this.base ? 'Ursprung (Basispunkt) klicken.' : this.graphical ? (!this.p1 ? 'Referenzpunkt klicken.' : 'Neuen Punkt klicken.') : ''; }
  basePoint() { return this.base; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'mode', label: '', value: this.graphical ? 'g' : 'n', options: [['n', 'Numerisch'], ['g', 'Grafisch']], onChange: (v) => (this.graphical = v === 'g') },
      { kind: 'number', key: 'f', label: 'Faktor', value: this.factor, onChange: (v) => (this.factor = v) },
    ];
  }
  stepDown(e: ToolEvent): void {
    if (!this.base) { this.base = e.p; if (!this.graphical) this.apply(this.factor, e); return; }
    if (!this.p1) { this.p1 = e.p; return; }
    const f = dist(this.base, e.p) / Math.max(1e-6, dist(this.base, this.p1));
    this.apply(f, e);
  }
  private apply(f: number, e: ToolEvent): void {
    if (!(f > 0)) return;
    app.doc.transaction('Skalieren', () => transformElements(this.ids, scaling(f, this.base!), e.view));
    app.setTool(null);
  }
  move(e: ToolEvent): void { this.cur = e.p; }
  preview(dl: DisplayList, vp: any): void {
    if (this.base && this.p1 && this.cur) {
      const f = dist(this.base, this.cur) / Math.max(1e-6, dist(this.base, this.p1));
      ghost(dl, vp, new Set(this.ids), scaling(f, this.base));
      dl.line(this.base, this.cur, PREVIEW_THIN);
    }
  }
}

// ------------------------------------------------------------ Ausrichten
export class AlignTool extends Tool {
  id = 'align'; label = 'Ausrichten';
  private ref: { a: V2; b: V2 } | null = null; private hover: { a: V2; b: V2; id: Id | null } | null = null;
  prompt(): string { return this.ref ? 'Linie/Kante des Elements wählen, das ausgerichtet werden soll.' : 'Referenzlinie oder -punkt wählen, an der ausgerichtet wird.'; }
  move(e: ToolEvent): void {
    const segs = e.vp.displayList().segmentsNear(e.raw, e.vp.hitTol());
    this.hover = segs.length ? { a: segs[0].a, b: segs[0].b, id: segs[0].o } : null;
  }
  down(e: ToolEvent): void {
    if (!this.hover) return;
    if (!this.ref) { this.ref = { a: this.hover.a, b: this.hover.b }; return; }
    const t = this.hover;
    if (!t.id) { app.status('Diese Linie gehört zu keinem verschiebbaren Element.'); return; }
    const d1 = norm(sub(this.ref.b, this.ref.a)), d2 = norm(sub(t.b, t.a));
    if (Math.abs(cross(d1, d2)) > 0.01) {
      // nicht parallel: drehen um Schnittpunkt
      const x = lineLine(this.ref.a, this.ref.b, t.a, t.b);
      if (!x) return;
      let ang = angleOf(d1) - angleOf(d2);
      while (ang > Math.PI / 2) ang -= Math.PI; while (ang < -Math.PI / 2) ang += Math.PI;
      app.doc.transaction('Ausrichten', () => transformElements([t.id!], rotation(ang, x.p), e.view));
    } else {
      const foot = closestOnLine(t.a, this.ref.a, this.ref.b);
      const d = sub(foot, t.a);
      app.doc.transaction('Ausrichten', () => transformElements([t.id!], translation(d.x, d.y), e.view));
    }
  }
  escape(): boolean { if (this.ref) { this.ref = null; return true; } return false; }
  preview(dl: DisplayList): void {
    if (this.ref) { const d = norm(sub(this.ref.b, this.ref.a)); dl.line(sub(this.ref.a, mul(d, 1e5)), add(this.ref.a, mul(d, 1e5)), { w: 1, color: GHOST, dash: 'dash' }); }
    if (this.hover) dl.line(this.hover.a, this.hover.b, { w: 4, color: GHOST });
  }
}

// ------------------------------------------------------------ Stutzen / Dehnen / Teilen
function curveEl(e: ToolEvent): { el: El; a: V2; b: V2 } | null {
  for (const h of e.vp.hit(e.raw)) {
    const el = app.doc.get(h.id); if (!el || el.pinned) continue;
    const def = catDef(el.cat);
    const c = def?.curve?.(el, app.doc, e.view);
    if (c && def?.setCurve) return { el, ...c };
  }
  return null;
}

export class TrimTool extends Tool {
  id = 'trim'; label = 'Stutzen/Dehnen zu Ecke';
  private first: { el: El; a: V2; b: V2; click: V2 } | null = null;
  private hover: { el: El; a: V2; b: V2 } | null = null;
  prompt(): string { return this.first ? 'Zweites Element wählen (den zu behaltenden Teil anklicken).' : 'Erstes Element wählen (den zu behaltenden Teil anklicken).'; }
  move(e: ToolEvent): void { this.hover = curveEl(e); }
  down(e: ToolEvent): void {
    const c = curveEl(e); if (!c) return;
    if (!this.first) { this.first = { ...c, click: e.raw }; return; }
    if (c.el.id === this.first.el.id) return;
    const x = lineLine(this.first.a, this.first.b, c.a, c.b);
    if (!x) { app.status('Die Elemente sind parallel.'); return; }
    const f = this.first;
    app.doc.transaction('Stutzen/Dehnen', () => {
      trimTo(f.el, f.a, f.b, x.p, f.click, e);
      trimTo(c.el, c.a, c.b, x.p, e.raw, e);
    });
    this.first = null;
  }
  escape(): boolean { if (this.first) { this.first = null; return true; } return false; }
  preview(dl: DisplayList): void {
    if (this.first) dl.line(this.first.a, this.first.b, { w: 4, color: GHOST });
    if (this.hover) dl.line(this.hover.a, this.hover.b, { w: 3, color: '#2f8ff0' });
  }
}

function trimTo(el: El, a: V2, b: V2, x: V2, click: V2, e: ToolEvent): void {
  const tx = projectT(x, a, b), tc = projectT(click, a, b);
  const def = catDef(el.cat)!;
  const patch = tc < tx ? def.setCurve!(el, a, x, app.doc, e.view) : def.setCurve!(el, x, b, app.doc, e.view);
  if (patch) app.doc.update(el.id, patch);
}

export class TrimSingleTool extends Tool {
  id = 'trimSingle'; label = 'Stutzen/Dehnen einzelnes Element';
  private boundary: { a: V2; b: V2 } | null = null; private hover: { a: V2; b: V2 } | null = null;
  prompt(): string { return this.boundary ? 'Element wählen, das gestutzt/gedehnt werden soll (zu behaltenden Teil anklicken).' : 'Begrenzung wählen.'; }
  move(e: ToolEvent): void { const c = this.boundary ? curveEl(e) : curveAt(e); this.hover = c; }
  down(e: ToolEvent): void {
    if (!this.boundary) { const c = curveAt(e); if (c) this.boundary = c; return; }
    const c = curveEl(e); if (!c) return;
    const x = lineLine(this.boundary.a, this.boundary.b, c.a, c.b);
    if (!x) { app.status('Parallel zur Begrenzung.'); return; }
    app.doc.transaction('Stutzen/Dehnen', () => trimTo(c.el, c.a, c.b, x.p, e.raw, e));
  }
  escape(): boolean { if (this.boundary) { this.boundary = null; return true; } return false; }
  preview(dl: DisplayList): void {
    if (this.boundary) { const d = norm(sub(this.boundary.b, this.boundary.a)); dl.line(sub(this.boundary.a, mul(d, 1e5)), add(this.boundary.a, mul(d, 1e5)), { w: 1, color: GHOST, dash: 'dash' }); }
    if (this.hover) dl.line(this.hover.a, this.hover.b, { w: 3, color: '#2f8ff0' });
  }
}

export class SplitTool extends Tool {
  id = 'split'; label = 'Element teilen';
  private hover: { el: El; a: V2; b: V2 } | null = null; private cur: V2 | null = null;
  prompt(): string { return 'Klicken Sie auf das Element an der Teilungsstelle.'; }
  move(e: ToolEvent): void { this.hover = curveEl(e); this.cur = this.hover ? closestOnLine(e.p, this.hover.a, this.hover.b) : null; }
  down(e: ToolEvent): void {
    const c = curveEl(e); if (!c) return;
    const p = closestOnLine(e.p, c.a, c.b);
    const t = projectT(p, c.a, c.b);
    if (t <= 0.001 || t >= 0.999) return;
    const def = catDef(c.el.cat)!;
    app.doc.transaction('Teilen', () => {
      const map = app.duplicate([c.el.id], false);
      const copyId = map.get(c.el.id)!;
      const copy = app.doc.get(copyId)!;
      const p1 = def.setCurve!(c.el, c.a, p, app.doc, e.view); if (p1) app.doc.update(c.el.id, p1);
      const p2 = def.setCurve!(copy, p, c.b, app.doc, e.view); if (p2) app.doc.update(copyId, p2);
      // Türen/Fenster der zweiten Hälfte umhängen
      if (c.el.cat === 'wall') {
        const L1 = dist(c.a, p);
        for (const h of hostedBy(app.doc, c.el.id)) if (typeof h.t === 'number' && h.t > L1) app.doc.update(h.id, { hostId: copyId, t: h.t - L1 });
      }
    });
  }
  preview(dl: DisplayList, vp: any): void {
    if (this.hover) dl.line(this.hover.a, this.hover.b, { w: 3, color: '#2f8ff0' });
    if (this.cur && this.hover) {
      const n = perp(norm(sub(this.hover.b, this.hover.a))); const r = vp.view.scale * 3;
      dl.line(add(this.cur, mul(n, r)), sub(this.cur, mul(n, r)), { w: 3, color: '#d03030' });
    }
  }
}

// ------------------------------------------------------------ Versatz
export class OffsetTool extends Tool {
  id = 'offset'; label = 'Versatz';
  distance = 1000; copy = true;
  private hover: { el: El; a: V2; b: V2 } | null = null; private side = 1;
  prompt(): string { return 'Element wählen – die Seite wird durch die Cursorposition bestimmt.'; }
  options(): OptionItem[] {
    return [
      { kind: 'length', key: 'd', label: 'Abstand', value: this.distance, onChange: (v) => (this.distance = v) },
      { kind: 'check', key: 'copy', label: 'Kopieren', value: this.copy, onChange: (v) => (this.copy = v) },
    ];
  }
  move(e: ToolEvent): void {
    this.hover = curveEl(e);
    if (this.hover) { const n = perp(norm(sub(this.hover.b, this.hover.a))); this.side = dot(sub(e.raw, this.hover.a), n) >= 0 ? 1 : -1; }
  }
  down(e: ToolEvent): void {
    const c = this.hover; if (!c) return;
    const n = mul(perp(norm(sub(c.b, c.a))), this.side * this.distance);
    app.doc.transaction('Versatz', () => {
      if (this.copy) copyTransform([c.el.id], translation(n.x, n.y), e.view);
      else transformElements([c.el.id], translation(n.x, n.y), e.view);
    });
  }
  preview(dl: DisplayList): void {
    if (!this.hover) return;
    const n = mul(perp(norm(sub(this.hover.b, this.hover.a))), this.side * this.distance);
    dl.line(add(this.hover.a, n), add(this.hover.b, n), { w: 2, color: GHOST, dash: 'dash' });
    dl.line(this.hover.a, this.hover.b, { w: 3, color: '#2f8ff0' });
  }
}

// ------------------------------------------------------------ Typ anpassen
export class MatchTool extends Tool {
  id = 'match'; label = 'Typeigenschaften anpassen';
  private src: El | null = null;
  prompt(): string { return this.src ? 'Zielelemente anklicken (Esc zum Beenden).' : 'Quellelement anklicken.'; }
  down(e: ToolEvent): void {
    const h = e.vp.hit(e.raw)[0]; if (!h) return;
    const el = app.doc.get(h.id); if (!el) return;
    if (!this.src) { if (!el.typeId) { app.status('Element hat keinen Typ.'); return; } this.src = el; return; }
    if (el.cat !== this.src.cat) { app.status('Kategorie stimmt nicht überein.'); return; }
    app.doc.transaction('Typ anpassen', () => app.doc.update(el.id, { typeId: this.src!.typeId }));
  }
  escape(): boolean { if (this.src) { this.src = null; return true; } return false; }
}

// ------------------------------------------------------------ Messen
export class MeasureTool extends Tool {
  id = 'measure'; label = 'Messen';
  private a: V2 | null = null; private cur: V2 | null = null; private total = 0;
  prompt(): string { return this.a ? 'Nächsten Punkt klicken (Kette). Esc beendet.' : 'Ersten Punkt klicken.'; }
  basePoint() { return this.a; }
  down(e: ToolEvent): void {
    if (!this.a) { this.a = e.p; this.total = 0; return; }
    this.total += dist(this.a, e.p);
    app.status(`Länge: ${fmtLen(dist(this.a, e.p))}   Gesamt: ${fmtLen(this.total)}`);
    this.a = e.p;
  }
  move(e: ToolEvent): void { this.cur = e.p; if (this.a) { app.statusText = `Länge: ${fmtLen(dist(this.a, e.p))}   Gesamt: ${fmtLen(this.total + dist(this.a, e.p))}`; app.emit('status'); } }
  escape(): boolean { if (this.a) { this.a = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void { if (this.a && this.cur) { dl.line(this.a, this.cur, PREVIEW); listen(dl, this.a, this.cur, vp.view.scale); } }
}

// ------------------------------------------------------------ Einfügen (Zwischenablage)
export function copyToClipboard(): void {
  const ids = [...app.selection];
  if (!ids.length) { app.status('Nichts ausgewählt.'); return; }
  const all = withHosted(ids);
  const v = app.activeView();
  app.clipboard = { els: [...all].map((id) => JSON.parse(JSON.stringify(app.doc.get(id)))).filter(Boolean), viewId: v?.id ?? '', levelId: v?.levelId };
  app.status(`${all.size} Element(e) in die Zwischenablage kopiert.`);
}

export class PasteTool extends Tool {
  id = 'paste'; label = 'Einfügen';
  private ref: V2 | null = null; private cur: V2 | null = null;
  activate(): void {
    const cb = app.clipboard; if (!cb) return;
    // Bezugspunkt: Mitte der Elemente in der Quellansicht
    const vp: any = app.viewports.get(cb.viewId) ?? app.active;
    this.ref = vp ? selectionCenter(cb.els.map((e) => e.id).filter((id) => app.doc.has(id)), vp.view, vp) : null;
    if (!this.ref) this.ref = { x: 0, y: 0 };
  }
  prompt(): string { return 'Einfügepunkt klicken.'; }
  basePoint() { return null; }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void { pasteAt(sub(e.p, this.ref!), e.view); app.setTool(null); }
  preview(dl: DisplayList, vp: any): void {
    if (!this.ref || !this.cur || !app.clipboard) return;
    const d = sub(this.cur, this.ref);
    ghost(dl, vp, new Set(app.clipboard.els.map((e) => e.id)), translation(d.x, d.y));
  }
}

/** Einfügen mit Verschiebung; Ebenen werden auf die aktive Ebene umgehängt, ansichtsspezifische Elemente auf die aktive Ansicht. */
export function pasteAt(d: V2, view = app.activeView()!): void {
  const cb = app.clipboard; if (!cb) return;
  const doc = app.doc;
  const ids: Id[] = [];
  doc.transaction('Einfügen', () => {
    const idMap = new Map<Id, Id>();
    for (const e of cb.els) idMap.set(e.id, e.cat.slice(0, 2) + Math.random().toString(36).slice(2, 10));
    const srcLvl = doc.get<any>(cb.levelId); const dstLvl = doc.get<any>(view.levelId);
    const lvls = doc.all<any>('level').sort((a, b) => a.elev - b.elev);
    const shiftLevel = (id: Id | null | undefined): Id | null | undefined => {
      if (!id || !srcLvl || !dstLvl || srcLvl.id === dstLvl.id) return id;
      const i = lvls.findIndex((l) => l.id === id); const di = lvls.findIndex((l) => l.id === dstLvl.id) - lvls.findIndex((l) => l.id === srcLvl.id);
      return lvls[Math.max(0, Math.min(lvls.length - 1, i + di))]?.id ?? id;
    };
    for (const src of cb.els) {
      const c: El = JSON.parse(JSON.stringify(src));
      c.id = idMap.get(src.id)!;
      if (c.hostId) c.hostId = idMap.get(c.hostId) ?? c.hostId;
      if (c.viewId) c.viewId = view.id;
      if (c.levelId && isPlanLike(view)) c.levelId = shiftLevel(c.levelId) as Id;
      if (c.topLevelId && isPlanLike(view)) c.topLevelId = shiftLevel(c.topLevelId) as Id;
      if (c.cat === 'door' || c.cat === 'window') c.mark = undefined;
      doc.add(c);
      ids.push(c.id);
    }
    transformElements(ids, translation(d.x, d.y), view);
  });
  app.select(ids.filter((id) => !doc.get(id)?.hostId));
}

export { lerp, compose, parseNum, mid, keepHostedAbsolute };
