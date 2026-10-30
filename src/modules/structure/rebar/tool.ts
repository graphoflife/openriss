// Werkzeug „Stabbewehrung“ (und „Bügel“): Biegeform wählen, in Schnitt oder Grundriss in die
// Schnittfläche eines Betonbauteils klicken → Form wird mit Deckung eingepasst und über die Bauteiltiefe
// verteilt. Gerade Stäbe auch Punkt zu Punkt, Freiform als Skizze. Grundriss + Platte: Stäbe in Lage.
import { app } from '../../../app';
import type { Id } from '../../../core/doc';
import { newId } from '../../../core/doc';
import { V2, dist, closestOnSeg, mid } from '../../../core/geom';
import { Tool, ToolEvent, OptionItem } from '../../../tools/tool';
import type { View } from '../../../core/view';
import { planRange } from '../../../views/viewBuilder';
import type { DisplayList } from '../../../render/displayList';
import { fmtNum } from '../../../core/units';
import { DIAS, LAYOUT_LABELS, Layout, cleanRing, insetRing } from './math';
import { HostHit, hostAt, slabAt, planFrame, sectionFrame, vfOf } from './frame';
import { BuildOpts, ShapeKind, buildFitted, buildSlab, buildDrawn, coverFor, SLAB_LAYERS, SlabLayer } from './build';
import { Rebar, drawRebar, assignPos, rebarGeo, rebarLabel, DISPLAY_LABELS, Display } from './rebar';
import { createRebarTag } from './tag';
import { HOST_CATS, ensureRebarMaterial } from '../common';

const KINDS: [ShapeKind, string][] = [
  ['00', '00 – Gerader Stab'], ['11', '11 – Winkel (L)'], ['21', '21 – U-Bügel / Steckbügel'], ['51', '51 – Bügel geschlossen'],
  ['L', 'Längsstäbe (⟂ Ansicht)'], ['99', 'Skizze (Freiform)'],
];
const HOOKS: [string, string][] = [['0', 'ohne'], ['90', '90°'], ['135', '135°'], ['180', '180°']];
const BLUE = '#1e6fd9';

interface State extends BuildOpts { draw: boolean }
const memory = new Map<string, State>();

export class RebarTool extends Tool {
  id: string; label: string; kinds = ['plan', 'section'];
  private st: State;
  private hostOnly: Id | null = null;
  private pts: V2[] = [];
  private hit: HostHit | null = null;
  private slab = false;
  private cand: Partial<Rebar> | null = null;
  private await: Partial<Rebar> | null = null;
  private curP: V2 | null = null;
  private msg = '';

  constructor(id = 'rebar', label = 'Stabbewehrung', preset: Partial<State> = {}) {
    super();
    this.id = id; this.label = label;
    this.st = {
      kind: '21', draw: false, dia: 10, hookA: 0, hookB: 0, legLen: 0, layout: 'maxSpacing', count: 4, spacing: 150, cover: 0,
      display: 'first', layer: 'u1', orient: 'par', ...preset, ...(memory.get(id) ?? {}),
    };
  }

  activate(): void {
    app.doc.get('m_betonstahl') || app.doc.transaction('Betonstahl', () => ensureRebarMaterial(app.doc));
    const sel = app.selected();
    if (sel.length === 1 && sel[0].cat === 'rebar') {
      const r = sel[0] as Rebar;
      Object.assign(this.st, { dia: r.dia, layout: r.layout, count: r.count, spacing: r.spacing, hookA: r.hookA ?? 0, hookB: r.hookB ?? 0, display: r.display ?? 'first' });
      if (['00', '11', '21', '51', '99'].includes(r.shape) && this.id === 'rebar') this.st.kind = (r.fit?.kind ?? r.shape) as ShapeKind;
    } else {
      const h = sel.filter((e) => HOST_CATS.includes(e.cat));
      this.hostOnly = h.length === 1 ? h[0].id : null;
    }
  }
  deactivate(): void { memory.set(this.id, { ...this.st }); }

  private drawMode(): boolean { return this.st.kind === '99' || (this.st.kind === '00' && this.st.draw); }
  prompt(): string {
    if (this.await) return 'Klicken Sie, um Seite und Breite des Verlegebereichs festzulegen.';
    if (this.drawMode()) {
      if (!this.pts.length) return 'Ersten Punkt des Stabes im Bauteil klicken.';
      return this.st.kind === '99' ? 'Nächsten Punkt klicken – Enter oder Doppelklick beendet die Skizze, Rücktaste entfernt den letzten Punkt.' : 'Endpunkt des Stabes klicken.';
    }
    return 'In die Schnittfläche eines Betonbauteils klicken – die Biegeform wird mit Betondeckung eingepasst (Ecke/Kante nahe dem Cursor).';
  }

  options(): OptionItem[] {
    const s = this.st; const o: OptionItem[] = [];
    const set = <K extends keyof State>(k: K, rerender = false) => (v: any) => { (s as any)[k] = v; this.reset(false); if (rerender) app.emit('tool'); app.redrawOverlay(); };
    if (this.id === 'rebar') o.push({ kind: 'select', key: 'kind', label: 'Biegeform', value: s.kind, options: KINDS, onChange: set('kind', true) });
    if (s.kind === '00') o.push({ kind: 'check', key: 'draw', label: 'Punkt zu Punkt', value: s.draw, onChange: set('draw', true) });
    o.push({ kind: 'select', key: 'dia', label: 'Ø', value: String(s.dia), options: DIAS.map((d) => [String(d), String(d)] as [string, string]), onChange: (v) => set('dia')(Number(v)) });
    if (s.kind !== '51' && s.kind !== 'L') {
      o.push({ kind: 'select', key: 'hookA', label: 'Haken Anf.', value: String(s.hookA), options: HOOKS, onChange: (v) => set('hookA')(Number(v)) });
      o.push({ kind: 'select', key: 'hookB', label: 'Ende', value: String(s.hookB), options: HOOKS, onChange: (v) => set('hookB')(Number(v)) });
    }
    if (s.kind === '11' || s.kind === '21') o.push({ kind: 'length', key: 'leg', label: 'Schenkel (0 = bis Ecke)', value: s.legLen, onChange: set('legLen') });
    o.push({ kind: 'select', key: 'layout', label: 'Layout', value: s.layout, options: LAYOUT_LABELS, onChange: set('layout', true) });
    if (s.layout === 'count' || s.layout === 'countSpacing') o.push({ kind: 'number', key: 'count', label: 'Anzahl', value: s.count, width: 40, onChange: (v) => set('count')(Math.max(1, Math.round(v))) });
    if (s.layout === 'maxSpacing' || s.layout === 'countSpacing') o.push({ kind: 'length', key: 'sp', label: 'Abstand', value: s.spacing, onChange: (v) => set('spacing')(Math.max(10, v)) });
    o.push({ kind: 'length', key: 'cover', label: 'Deckung (0 = Std.)', value: s.cover, onChange: set('cover') });
    const v = app.activeView();
    if (v?.kind === 'plan') {
      o.push({ kind: 'select', key: 'layer', label: 'Lage (Platte)', value: s.layer, options: SLAB_LAYERS, onChange: set('layer') });
      o.push({ kind: 'select', key: 'orient', label: 'Richtung', value: s.orient, options: [['par', 'parallel zur Kante'], ['perp', 'senkrecht zur Kante']], onChange: set('orient') });
    }
    o.push({ kind: 'select', key: 'display', label: 'Darstellung', value: s.display, options: DISPLAY_LABELS, onChange: (x) => set('display')(x as Display) });
    o.push({ kind: 'check', key: 'tag', label: 'Beschriften', value: app.settings.tagOnPlace, onChange: (x) => { app.settings.tagOnPlace = x; app.saveSettings(); } });
    if (this.hostOnly) o.push({ kind: 'button', label: 'Nur gewähltes Bauteil – aufheben', onClick: () => { this.hostOnly = null; app.emit('tool'); } });
    if (s.kind === '99' && this.pts.length >= 2) o.push({ kind: 'button', label: 'Fertig stellen', icon: 'check', primary: true, onClick: () => this.finishDraw() });
    return o;
  }

  private reset(full = true): void {
    if (full) { this.pts = []; this.await = null; this.hit = null; }
    this.cand = null;
    app.setPrompt(this.prompt());
  }

  // ------------------------------------------------------------ Host-Ermittlung
  private findHit(view: View, p: V2): void {
    this.slab = false; this.hit = null;
    if (view.kind === 'section') { this.hit = hostAt(app.doc, sectionFrame(view), p, this.hostOnly); return; }
    const cutZ = planRange(app.doc, view).cutZ;
    this.hit = hostAt(app.doc, planFrame(cutZ), p, this.hostOnly);
    if (!this.hit) { this.hit = slabAt(app.doc, p, cutZ, this.hostOnly); this.slab = !!this.hit; }
  }

  private build(p: V2): Partial<Rebar> | null {
    const h = this.hit; if (!h) return null;
    const s = this.st;
    this.msg = '';
    if (this.slab) {
      if (s.kind !== '00' && s.kind !== '99') { this.msg = 'Im Grundriss liegender Bauteile nur gerade Stäbe oder Skizze – Bügel/Winkel im Schnitt zeichnen.'; return null; }
      return buildSlab(app.doc, h, p, s);
    }
    return buildFitted(app.doc, h, p, s);
  }

  move(e: ToolEvent): void {
    this.curP = e.p;
    if (this.await) {
      this.cand = buildDrawn(app.doc, this.hit!, this.pts, this.st, true, e.p);
      return;
    }
    if (this.drawMode()) {
      if (!this.pts.length) { this.findHit(e.view, e.raw); this.cand = null; return; }
      this.cand = this.hit ? buildDrawn(app.doc, this.hit, [...this.pts, e.p], this.st, this.slab, null) : null;
      return;
    }
    this.findHit(e.view, e.raw);
    this.cand = this.build(e.raw);
  }

  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.await) { this.commit(buildDrawn(app.doc, this.hit!, this.pts, this.st, true, e.p)); this.reset(); return; }
    if (this.drawMode()) {
      if (!this.pts.length) {
        this.findHit(e.view, e.p);
        if (!this.hit) this.findHit(e.view, e.raw);
        if (!this.hit) { app.status('Bitte innerhalb eines Betonbauteils beginnen.'); return; }
        this.pts.push(e.p);
        return;
      }
      if (dist(this.pts[this.pts.length - 1], e.p) < 1) return;
      this.pts.push(e.p);
      if (this.st.kind === '00') this.finishDraw();
      else app.emit('tool');
      return;
    }
    this.findHit(e.view, e.raw);
    const c = this.build(e.raw);
    if (!c) { app.status(this.msg || (this.hit ? 'Die Biegeform passt nicht in die Schnittfläche (Deckung zu groß?).' : 'Kein Betonbauteil unter dem Cursor (Wand, Decke, Stütze, Träger, Fundament).')); return; }
    this.commit(c);
  }

  private finishDraw(): void {
    if (!this.hit || this.pts.length < 2) return;
    if (this.slab && this.st.layout !== 'single') { this.await = buildDrawn(app.doc, this.hit, this.pts, this.st, true, null); app.setPrompt(this.prompt()); app.emit('tool'); return; }
    this.commit(buildDrawn(app.doc, this.hit, this.pts, this.st, this.slab, null));
    this.reset();
    app.emit('tool');
  }

  private commit(c: Partial<Rebar> | null): void {
    if (!c || !c.pts?.length) { app.status('Bewehrung konnte nicht erzeugt werden.'); return; }
    const doc = app.doc; const view = app.activeView();
    let label = ''; let pos = 0;
    doc.transaction(this.label, () => {
      const el = { ...c, id: newId('rb'), cat: 'rebar', pos: 0 } as Rebar;
      el.pos = pos = assignPos(doc, el);
      doc.add(el);
      label = rebarLabel(doc, el, 'std');
      if (app.settings.tagOnPlace && view) createRebarTag(doc, el, view);
    });
    app.status(`Position ${pos}: ${label} erstellt.`);
  }

  enter(): boolean { if (this.st.kind === '99' && this.pts.length >= 2) { this.finishDraw(); return true; } return false; }
  dbl(): void { if (this.st.kind === '99' && this.pts.length >= 2) this.finishDraw(); }
  escape(): boolean { if (this.pts.length || this.await) { this.reset(); app.emit('tool'); return true; } return false; }
  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.pts.length) { this.pts.pop(); if (!this.pts.length) this.hit = null; app.redrawOverlay(); return true; }
    return false;
  }
  basePoint(): V2 | null { return this.pts.length ? this.pts[this.pts.length - 1] : null; }

  /** Deckungslinie des Bauteils als Fangpunkte */
  private coverRing(): V2[] | null {
    if (!this.hit) return null;
    const c = coverFor(app.doc, this.hit.host, this.st.cover) + this.st.dia / 2;
    return insetRing(cleanRing(this.hit.ring), c);
  }
  extraSnaps(): { p: V2; kind: 'end' | 'mid' | 'near' }[] {
    if (!this.drawMode()) return [];
    const R = this.coverRing(); if (!R) return [];
    const out: { p: V2; kind: 'end' | 'mid' | 'near' }[] = [];
    for (let i = 0; i < R.length; i++) {
      const a = R[i], b = R[(i + 1) % R.length];
      out.push({ p: a, kind: 'end' }, { p: mid(a, b), kind: 'mid' });
      if (this.curP) out.push({ p: closestOnSeg(this.curP, a, b), kind: 'near' });
    }
    return out;
  }

  preview(dl: DisplayList, vp: any): void {
    const view = vp.view as View;
    const s = view.scale || 100;
    if (this.hit) {
      const pen = { w: 1, color: BLUE };
      dl.poly(this.hit.ring, pen, true, { ns: true });
      if (!this.slab || this.drawMode()) { const R = this.coverRing(); if (R) dl.poly(R, { w: 1, color: BLUE, dash: 'dash' as const }, true, { ns: true }); }
    }
    for (let i = 0; i + 1 < this.pts.length; i++) dl.line(this.pts[i], this.pts[i + 1], { w: 1, color: BLUE, dash: 'dash' });
    const c = this.await ?? this.cand;
    if (!c || !c.pts?.length) return;
    const vf = vfOf(app.doc, view); if (!vf) return;
    const el = { ...c, id: '__preview', cat: 'rebar', pos: 0 } as Rebar;
    try {
      drawRebar(dl, app.doc, el, vf, BLUE);
      if (this.curP) {
        const g = rebarGeo(app.doc, el);
        dl.text({ x: this.curP.x + 3 * s, y: this.curP.y - 4 * s }, `${rebarLabel(app.doc, el, 'std')}   l = ${fmtNum(g.len / 1000, 2)} m`, { size: 2.2, color: BLUE, opaque: true });
      }
    } catch (err) { console.warn(err); }
  }
}

export const LAYOUTS: Layout[] = ['single', 'count', 'maxSpacing', 'countSpacing'];
export type { SlabLayer };
