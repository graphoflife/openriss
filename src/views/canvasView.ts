// 2D-Ansichtsfenster (Grundriss, Schnitt, Ansicht, Zeichnungsansicht, Plan):
// Zoomen/Verschieben, Zeichnen der Display-Liste, Überlagerung (Auswahl, Griffe,
// temporäre Bemaßungen, Werkzeugvorschau, Fangsymbole) und Weitergabe der Maus an Werkzeuge.
import { app } from '../app';
import type { View } from '../core/view';
import { ViewportLike, catDef, registerViewport, Grip, TempDim, emitHook } from '../core/registry';
import { DisplayList } from '../render/displayList';
import { paint } from '../render/canvasPainter';
import { SEL_COLOR, HOVER_COLOR } from '../render/styles';
import { Mat2, V2, invert, apply, BBox, boxValid, dist, sub, add, mul, norm, perp, mid, boxInflate } from '../core/geom';
import { buildViewDL } from './viewBuilder';
import { computeSnap, SnapResult } from '../tools/snap';
import type { ToolEvent } from '../tools/tool';
import { fmtLen, parseLen } from '../core/units';
import type { Id, El } from '../core/doc';
import { buildViewControlBar } from '../ui/viewControlBar';

let tempVisVersion = 0;
export function bumpTempVis(): void { tempVisVersion++; app.refreshViews(); }

interface GripHit { el: El; grip: Grip; s: V2 }
interface DimHit { td: TempDim; rect: { x: number; y: number; w: number; h: number }; el: El }

export class CanvasView implements ViewportLike {
  view: View;
  el: HTMLElement;
  base: HTMLCanvasElement;
  over: HTMLCanvasElement;
  bar: HTMLElement;
  center: V2 = { x: 0, y: 0 };
  zoom = 0.05; // px je Ansichts-mm
  private dl: DisplayList | null = null;
  private dlKey = '';
  private raf = 0;
  private overRaf = 0;
  mouse: V2 = { x: 0, y: 0 };
  lastEvent: ToolEvent | null = null;
  hover: Id | null = null;
  hoverSet: Set<Id> | null = null;
  hoverCands: { id: Id }[] = [];
  snap: SnapResult | null = null;
  grips: GripHit[] = [];
  dims: DimHit[] = [];
  private panning: { s: V2; c: V2 } | null = null;
  private ro: ResizeObserver;
  private input: HTMLInputElement | null = null;
  private zoomHistory: { c: V2; z: number }[] = [];
  dpr = window.devicePixelRatio || 1;

  constructor(view: View, host: HTMLElement) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'viewport';
    this.base = document.createElement('canvas');
    this.over = document.createElement('canvas');
    this.base.className = 'vp-base';
    this.over.className = 'vp-over';
    const stack = document.createElement('div');
    stack.className = 'vp-stack';
    stack.append(this.base, this.over);
    this.bar = document.createElement('div');
    this.bar.className = 'view-control-bar';
    this.el.append(stack, this.bar);
    host.appendChild(this.el);
    this.el.style.display = 'none';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(stack);
    this.bindEvents();
    buildViewControlBar(this);
  }

  // ------------------------------------------------------------ Transformation
  xf(): Mat2 {
    const W = this.base.clientWidth, H = this.base.clientHeight; const z = this.zoom;
    return { a: z, b: 0, c: 0, d: -z, e: W / 2 - this.center.x * z, f: H / 2 + this.center.y * z };
  }
  toView(s: V2): V2 { return apply(invert(this.xf()), s); }
  toScreen(p: V2): V2 { return apply(this.xf(), p); }
  visibleBox(): BBox {
    const a = this.toView({ x: 0, y: 0 }), b = this.toView({ x: this.base.clientWidth, y: this.base.clientHeight });
    return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } };
  }
  pxPerPaperMm(): number { return this.zoom * (this.view.scale || 1); }

  // ------------------------------------------------------------ Display-Liste
  displayList(): DisplayList {
    const key = app.doc.version + '|' + tempVisVersion + '|' + this.view.id;
    if (!this.dl || key !== this.dlKey) {
      const v = app.doc.get<View>(this.view.id) ?? this.view;
      this.view = v;
      try { this.dl = buildViewDL(app.doc, v); } catch (e) { console.error('Ansicht konnte nicht aufgebaut werden', e); this.dl = new DisplayList(v.scale); }
      this.dlKey = key;
    }
    return this.dl;
  }

  // ------------------------------------------------------------ ViewportLike
  activate(): void { this.el.style.display = ''; this.resize(); this.invalidate(); }
  deactivate(): void { this.el.style.display = 'none'; this.closeInput(); }
  invalidate(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }
  dispose(): void { this.ro.disconnect(); this.el.remove(); cancelAnimationFrame(this.raf); }
  zoomExtents(): void {
    const dl = this.displayList();
    let b: BBox = dl.bbox();
    if (this.view.crop?.on) b = { min: this.view.crop.min, max: this.view.crop.max };
    if (!boxValid(b)) b = { min: { x: -5000, y: -5000 }, max: { x: 15000, y: 10000 } };
    this.fitBox(b);
  }
  fitBox(b: BBox): void {
    const W = this.base.clientWidth || 800, H = this.base.clientHeight || 600;
    const w = Math.max(b.max.x - b.min.x, 1000), h = Math.max(b.max.y - b.min.y, 1000);
    this.pushZoom();
    this.zoom = Math.min(W / (w * 1.12), H / (h * 1.12));
    this.center = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    this.invalidate();
  }
  pushZoom(): void { this.zoomHistory.push({ c: { ...this.center }, z: this.zoom }); if (this.zoomHistory.length > 30) this.zoomHistory.shift(); }
  zoomPrevious(): void { const z = this.zoomHistory.pop(); if (z) { this.center = z.c; this.zoom = z.z; this.invalidate(); } }
  zoomBy(f: number, at?: V2): void {
    const s = at ?? { x: this.base.clientWidth / 2, y: this.base.clientHeight / 2 };
    const before = this.toView(s);
    this.zoom = Math.max(1e-5, Math.min(50, this.zoom * f));
    const after = this.toView(s);
    this.center = add(this.center, sub(before, after));
    this.invalidate();
  }

  private resize(): void {
    const w = this.base.clientWidth, h = this.base.clientHeight;
    if (!w || !h) return;
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.over]) { c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr); }
    this.invalidate();
  }

  // ------------------------------------------------------------ Zeichnen
  render(): void {
    const ctx = this.base.getContext('2d');
    if (!ctx || !this.base.width) return;
    const dl = this.displayList();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.view.kind === 'sheet' ? '#8c96a0' : app.settings.background;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    emitHook('beforePaint', this, ctx);
    paint(ctx, dl, this.xf(), { pxPerPaperMm: this.pxPerPaperMm(), thin: app.settings.thinLines, visible: boxInflate(this.visibleBox(), 10), dpr: this.dpr, background: app.settings.background });
    this.drawOverlay();
  }
  redrawOverlay(): void {
    if (this.overRaf) return;
    this.overRaf = requestAnimationFrame(() => { this.overRaf = 0; this.drawOverlay(); });
  }

  private drawOverlay(): void {
    const ctx = this.over.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    const dl = this.displayList(); const xf = this.xf(); const k = this.pxPerPaperMm(); const dpr = this.dpr;
    const sel = app.selection;
    // Vorauswahl
    const hov = this.hoverSet ?? (this.hover && !sel.has(this.hover) ? new Set([this.hover]) : null);
    if (hov) paint(ctx, dl, xf, { pxPerPaperMm: k, thin: true, filter: (it) => !!it.o && hov.has(it.o), color: HOVER_COLOR, boost: 1, showSel: true, noFill: true, dpr });
    if (sel.size) paint(ctx, dl, xf, { pxPerPaperMm: k, thin: app.settings.thinLines, filter: (it) => !!it.o && sel.has(it.o), color: SEL_COLOR, boost: 0.5, showSel: true, noFill: true, dpr });
    // Griffe und temporäre Bemaßungen (nur im Ändern-Werkzeug)
    this.grips = []; this.dims = [];
    if (app.tool === app.defaultTool && sel.size && sel.size <= 60) {
      for (const id of sel) {
        const el = app.doc.get(id); if (!el) continue;
        const def = catDef(el.cat);
        if (el.cat !== 'view' && el.viewId && el.viewId !== this.view.id) continue;
        if (def?.grips && !el.pinned) {
          for (const g of def.grips(el, app.doc, this.view)) this.grips.push({ el, grip: g, s: this.toScreen(g.p) });
        }
      }
      if (sel.size === 1) {
        const el = app.doc.get([...sel][0]);
        const def = el && catDef(el.cat);
        if (el && def?.tempDims && !el.pinned) {
          try { for (const td of def.tempDims(el, app.doc, this.view)) this.drawTempDim(ctx, td, el); } catch (e) { console.warn(e); }
        }
      }
      for (const g of this.grips) this.drawGrip(ctx, g);
    }
    // Werkzeugvorschau
    const pdl = new DisplayList(this.view.scale || 1);
    try { app.tool?.preview(pdl, this); } catch (e) { console.warn(e); }
    if (pdl.items.length) paint(ctx, pdl, xf, { pxPerPaperMm: k, thin: false, dpr, showSel: true });
    // Fang
    if (this.snap) this.drawSnap(ctx, this.snap);
  }

  private drawGrip(ctx: CanvasRenderingContext2D, g: GripHit): void {
    const d = this.dpr; const x = g.s.x * d, y = g.s.y * d; const r = 4.5 * d;
    ctx.save();
    ctx.fillStyle = '#2a7be4'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2 * d;
    const kind = g.grip.kind ?? 'end';
    if (kind === 'flip') {
      const dir = g.grip.dir ? norm({ x: g.grip.dir.x, y: -g.grip.dir.y }) : { x: 1, y: 0 };
      const L = 9 * d; const n = { x: -dir.y, y: dir.x };
      ctx.strokeStyle = '#1e6fd9'; ctx.lineWidth = 2 * d; ctx.beginPath();
      ctx.moveTo(x - dir.x * L, y - dir.y * L); ctx.lineTo(x + dir.x * L, y + dir.y * L);
      for (const sgn of [1, -1]) {
        const tx = x + sgn * dir.x * L, ty = y + sgn * dir.y * L;
        ctx.moveTo(tx, ty); ctx.lineTo(tx - sgn * dir.x * 4 * d + n.x * 4 * d, ty - sgn * dir.y * 4 * d + n.y * 4 * d);
        ctx.moveTo(tx, ty); ctx.lineTo(tx - sgn * dir.x * 4 * d - n.x * 4 * d, ty - sgn * dir.y * 4 * d - n.y * 4 * d);
      }
      ctx.stroke();
    } else if (kind === 'arrow') {
      const dir = g.grip.dir ? norm({ x: g.grip.dir.x, y: -g.grip.dir.y }) : { x: 1, y: 0 }; const n = { x: -dir.y, y: dir.x };
      ctx.beginPath(); ctx.moveTo(x + dir.x * 7 * d, y + dir.y * 7 * d);
      ctx.lineTo(x + n.x * 5 * d, y + n.y * 5 * d); ctx.lineTo(x - n.x * 5 * d, y - n.y * 5 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (kind === 'text') {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  private drawTempDim(ctx: CanvasRenderingContext2D, td: TempDim, el: El): void {
    const d = this.dpr;
    const a = this.toScreen(td.a), b = this.toScreen(td.b);
    if (dist(a, b) < 4) return;
    ctx.save();
    ctx.strokeStyle = '#3a6ea5'; ctx.lineWidth = 1 * d; ctx.setLineDash([]);
    const dir = norm(sub(b, a)); const n = perp(dir);
    ctx.beginPath(); ctx.moveTo(a.x * d, a.y * d); ctx.lineTo(b.x * d, b.y * d); ctx.stroke();
    for (const p of [a, b]) {
      ctx.beginPath(); ctx.moveTo((p.x - n.x * 6) * d, (p.y - n.y * 6) * d); ctx.lineTo((p.x + n.x * 6) * d, (p.y + n.y * 6) * d); ctx.stroke();
      ctx.beginPath(); ctx.moveTo((p.x - (dir.x + n.x) * 3) * d, (p.y - (dir.y + n.y) * 3) * d); ctx.lineTo((p.x + (dir.x + n.x) * 3) * d, (p.y + (dir.y + n.y) * 3) * d); ctx.stroke();
    }
    const m = mid(a, b);
    const txt = fmtLen(td.value);
    ctx.font = `${12 * d}px Arial, sans-serif`;
    const w = ctx.measureText(txt).width / d + 8, h = 16;
    const off = sub(m, mul(n, 11));
    const rect = { x: off.x - w / 2, y: off.y - h / 2, w, h };
    ctx.fillStyle = td.apply ? '#ffffff' : '#f0f0f0';
    ctx.fillRect(rect.x * d, rect.y * d, rect.w * d, rect.h * d);
    ctx.strokeRect(rect.x * d, rect.y * d, rect.w * d, rect.h * d);
    ctx.fillStyle = '#1b3f66'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, off.x * d, off.y * d + 1);
    ctx.restore();
    this.dims.push({ td, rect, el });
  }

  private drawSnap(ctx: CanvasRenderingContext2D, s: SnapResult): void {
    const d = this.dpr; const p = this.toScreen(s.p); const x = p.x * d, y = p.y * d; const r = 6 * d;
    ctx.save();
    ctx.strokeStyle = '#d07000'; ctx.lineWidth = 1.8 * d; ctx.setLineDash([]);
    if (s.guide) {
      const a = this.toScreen(s.guide.a), b = this.toScreen(s.guide.b);
      ctx.save(); ctx.strokeStyle = '#4a90d9'; ctx.lineWidth = 1 * d; ctx.setLineDash([4 * d, 3 * d]);
      ctx.beginPath(); ctx.moveTo(a.x * d, a.y * d); ctx.lineTo(b.x * d, b.y * d); ctx.stroke(); ctx.restore();
    }
    ctx.beginPath();
    switch (s.kind) {
      case 'end': case 'point': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
      case 'mid': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); break;
      case 'int': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
      case 'center': case 'quad': ctx.arc(x, y, r, 0, Math.PI * 2); break;
      case 'perp': ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.moveTo(x, y + r); ctx.lineTo(x, y - r); break;
      case 'near': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.closePath(); break;
      default: ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    }
    ctx.stroke();
    if (s.kind !== 'angle') {
      ctx.font = `${11 * d}px Arial, sans-serif`;
      const w = ctx.measureText(s.label).width + 8 * d;
      ctx.fillStyle = '#fffbe6'; ctx.strokeStyle = '#a08040'; ctx.lineWidth = 1 * d;
      ctx.fillRect(x + 10 * d, y + 10 * d, w, 16 * d); ctx.strokeRect(x + 10 * d, y + 10 * d, w, 16 * d);
      ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(s.label, x + 14 * d, y + 18 * d);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ Treffer
  hitTol(): number { return 5 / this.zoom; }
  hit(p: V2, filter?: (id: Id) => boolean) {
    const dl = this.displayList();
    const own = (id: Id) => {
      const e = app.doc.get(id); if (!e) return false;
      return filter ? filter(id) : true;
    };
    return dl.hit(p, this.hitTol(), own);
  }
  gripAt(s: V2): GripHit | null {
    for (let i = this.grips.length - 1; i >= 0; i--) if (dist(this.grips[i].s, s) < 9) return this.grips[i];
    return null;
  }
  dimAt(s: V2): DimHit | null {
    for (const d of this.dims) if (s.x >= d.rect.x && s.x <= d.rect.x + d.rect.w && s.y >= d.rect.y && s.y <= d.rect.y + d.rect.h) return d;
    return null;
  }

  // ------------------------------------------------------------ Eingabefelder
  /** Eingabefeld an Bildschirmposition (z.B. Länge beim Zeichnen, temporäre Bemaßung) */
  openInput(s: V2, initial: string, onOk: (v: string) => void, selectAll = true): void {
    this.closeInput();
    const inp = document.createElement('input');
    inp.className = 'vp-input';
    inp.value = initial;
    inp.style.left = s.x + 'px'; inp.style.top = s.y + 'px';
    this.el.querySelector('.vp-stack')!.appendChild(inp);
    this.input = inp;
    // Fokus erst nach der Standardaktion des Mausklicks setzen
    const focus = () => { inp.focus(); if (selectAll) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length); };
    focus(); setTimeout(focus, 0);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = inp.value; this.closeInput(); onOk(v); }
      else if (e.key === 'Escape') this.closeInput();
    });
    setTimeout(() => inp.addEventListener('blur', () => setTimeout(() => { if (this.input === inp && document.activeElement !== inp) this.closeInput(); }, 150)), 50);
  }
  closeInput(): void { if (this.input) { this.input.remove(); this.input = null; } }
  hasInput(): boolean { return !!this.input; }

  editTempDim(h: DimHit): void {
    if (!h.td.apply) return;
    const s = { x: h.rect.x, y: h.rect.y };
    this.openInput(s, fmtLen(h.td.value), (v) => {
      const val = parseLen(v);
      if (val === null || val < 0) { app.status('Ungültiger Wert'); return; }
      app.doc.transaction('Temporäre Bemaßung', () => h.td.apply!(val));
    });
  }

  /** Längeneingabe beim Zeichnen (Tippen einer Zahl) */
  startTypedLength(first: string): void {
    const tool = app.tool;
    if (!tool.typedLength || !tool.basePoint()) return;
    this.openInput({ x: this.mouse.x + 14, y: this.mouse.y + 14 }, first, (v) => {
      const L = parseLen(v);
      if (L === null || L <= 0) { app.status('Ungültige Länge'); return; }
      tool.typedLength!(L, this.lastEvent);
      this.redrawOverlay();
    }, false);
  }

  // ------------------------------------------------------------ Ereignisse
  makeEvent(e: MouseEvent): ToolEvent {
    const r = this.over.getBoundingClientRect();
    const s = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.mouse = s;
    const raw = this.toView(s);
    let snap: SnapResult | null = null;
    const tool = app.tool;
    if (tool && tool.snapping && (tool !== app.defaultTool || (tool as any).wantsSnap?.())) {
      snap = computeSnap(this.displayList(), raw, this.zoom, tool.basePoint(), { shift: e.shiftKey, extra: (tool as any).extraSnaps?.(this) });
    }
    this.snap = snap;
    const ev: ToolEvent = { p: snap ? snap.p : raw, raw, screen: s, snap, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, view: this.view, vp: this };
    this.lastEvent = ev;
    return ev;
  }

  private bindEvents(): void {
    const c = this.over;
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); emitHook('contextmenu', this, e); });
    c.addEventListener('mousedown', (e) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (e.button === 1) { e.preventDefault(); this.panning = { s: { x: e.clientX, y: e.clientY }, c: { ...this.center } }; c.style.cursor = 'grabbing'; return; }
      if (e.button === 2) return;
      const ev = this.makeEvent(e);
      if (!app.tool.supports(this.view)) { app.status(`„${app.tool.label}“ ist in dieser Ansicht nicht verfügbar.`); return; }
      try { app.tool.down(ev); } catch (err) { console.error(err); app.status('Fehler: ' + (err as Error).message); }
      app.setPrompt(app.tool.prompt());
      this.redrawOverlay();
    });
    window.addEventListener('mousemove', (e) => {
      if (this.el.style.display === 'none') return;
      if (this.panning) {
        const dx = e.clientX - this.panning.s.x, dy = e.clientY - this.panning.s.y;
        this.center = { x: this.panning.c.x - dx / this.zoom, y: this.panning.c.y + dy / this.zoom };
        this.invalidate();
        return;
      }
      if (e.target !== c && !(e.buttons & 1)) return;
      const ev = this.makeEvent(e);
      try { app.tool.move(ev); } catch (err) { console.error(err); }
      emitHook('cursor', this, ev);
      this.redrawOverlay();
    });
    window.addEventListener('mouseup', (e) => {
      if (this.el.style.display === 'none') return;
      if (this.panning && e.button === 1) { this.panning = null; c.style.cursor = app.tool?.cursor ?? 'default'; return; }
      if (e.button !== 0) return;
      const ev = this.makeEvent(e);
      try { app.tool.up(ev); } catch (err) { console.error(err); }
      this.redrawOverlay();
    });
    c.addEventListener('dblclick', (e) => {
      const ev = this.makeEvent(e);
      try { app.tool.dbl(ev); } catch (err) { console.error(err); }
    });
    c.addEventListener('auxclick', (e) => { if (e.button === 1 && e.detail === 2) this.zoomExtents(); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const f = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      this.zoomBy(f, { x: e.clientX - r.left, y: e.clientY - r.top });
    }, { passive: false });
    c.addEventListener('mouseleave', () => { this.hover = null; this.hoverSet = null; this.snap = null; this.redrawOverlay(); });
    c.addEventListener('dragover', (e) => { e.preventDefault(); });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const p = this.toView({ x: e.clientX - r.left, y: e.clientY - r.top });
      emitHook('canvasDrop', this, e.dataTransfer, p);
    });
    c.addEventListener('mouseenter', () => { c.style.cursor = app.tool?.cursor ?? 'default'; });
  }
}

registerViewport({
  kinds: ['plan', 'ceiling', 'elevation', 'section', 'drafting', 'legend', 'sheet'],
  create: (view, host) => new CanvasView(view, host),
});
