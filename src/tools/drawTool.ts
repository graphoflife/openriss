// Basiswerkzeug für linienförmiges Zeichnen (Linie, Rechteck, Linien wählen, Bogen)
// mit Kettenmodus, Versatz, Längeneingabe und "hörender" Bemaßung wie in Revit.
import { app } from '../app';
import { Tool, ToolEvent, OptionItem } from './tool';
import { V2, add, sub, mul, norm, perp, dist, angleOf, fromAngle, mid, deg } from '../core/geom';
import { catDef } from '../core/registry';
import type { DisplayList } from '../render/displayList';
import { fmtLen, fmtNum } from '../core/units';
import type { Pen } from '../render/styles';
import { arcFrom3 } from '../elements/datums';

export type DrawMode = 'line' | 'rect' | 'pick' | 'arc' | 'circle' | 'polyline';
export const MODE_LABELS: Record<DrawMode, { label: string; icon: string }> = {
  line: { label: 'Linie', icon: 'line' },
  rect: { label: 'Rechteck', icon: 'rect' },
  pick: { label: 'Linien wählen', icon: 'pickline' },
  arc: { label: 'Bogen (Start-Ende-Radius)', icon: 'arc' },
  circle: { label: 'Kreis', icon: 'circle' },
  polyline: { label: 'Polylinie', icon: 'polyline' },
};

export const PREVIEW: Pen = { w: 2, color: '#1e6fd9' };
export const PREVIEW_THIN: Pen = { w: 1, color: '#1e6fd9', dash: 'dash' };

export abstract class LineDrawTool extends Tool {
  modes: DrawMode[] = ['line', 'rect', 'pick'];
  mode: DrawMode = 'line';
  chain = true;
  showChain = true;
  offset = 0;
  showOffset = true;
  protected start: V2 | null = null;
  protected cur: V2 | null = null;
  protected arcEnd: V2 | null = null;
  protected pickHover: { a: V2; b: V2; id: string } | null = null;

  /** Segment erzeugen (innerhalb einer Transaktion). arc optional. */
  abstract createSegment(a: V2, b: V2, arc?: { c: V2; r: number; a0: number; a1: number } | null): void;
  /** Name der Transaktion */
  txName(): string { return this.label; }
  /** Zusätzliche Optionen (vor den Standardoptionen) */
  extraOptions(): OptionItem[] { return []; }
  /** Linien, die beim "Linien wählen" akzeptiert werden */
  pickFilter(cat: string): boolean { return ['wall', 'line', 'grid', 'refplane', 'beam', 'floor', 'roof', 'ceiling'].includes(cat); }
  /** nach dem Erzeugen */
  afterCreate(): void { /* */ }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void { dl.line(a, b, PREVIEW); }

  prompt(): string {
    if (this.mode === 'pick') return 'Linie oder Wand wählen.';
    if (this.mode === 'arc') return !this.start ? 'Startpunkt des Bogens' : !this.arcEnd ? 'Endpunkt des Bogens' : 'Punkt auf dem Bogen';
    if (this.mode === 'circle') return !this.start ? 'Mittelpunkt des Kreises' : 'Radius';
    if (!this.start) return 'Klicken Sie, um den Startpunkt festzulegen.';
    return 'Klicken Sie, um den Endpunkt festzulegen. Zahl eingeben für exakte Länge. Esc beendet die Kette.';
  }
  basePoint(): V2 | null { return this.mode === 'pick' ? null : this.start; }

  options(): OptionItem[] {
    const o: OptionItem[] = [
      { kind: 'buttons', key: 'mode', value: this.mode, options: this.modes.map((m) => ({ id: m, label: MODE_LABELS[m].label, icon: MODE_LABELS[m].icon, tip: MODE_LABELS[m].label })), onChange: (v) => { this.mode = v as DrawMode; this.start = null; this.arcEnd = null; app.setPrompt(this.prompt()); app.emit('tool'); } },
      ...this.extraOptions(),
    ];
    if (this.showChain) o.push({ kind: 'check', key: 'chain', label: 'Kette', value: this.chain, onChange: (v) => (this.chain = v) });
    if (this.showOffset) o.push({ kind: 'length', key: 'offset', label: 'Versatz', value: this.offset, onChange: (v) => (this.offset = v) });
    return o;
  }

  private off(a: V2, b: V2): [V2, V2] {
    if (!this.offset) return [a, b];
    const n = mul(perp(norm(sub(b, a))), this.offset);
    return [add(a, n), add(b, n)];
  }

  protected commit(a: V2, b: V2, arc?: { c: V2; r: number; a0: number; a1: number } | null): void {
    if (dist(a, b) < 1 && !arc) return;
    const [p, q] = arc ? [a, b] : this.off(a, b);
    app.doc.transaction(this.txName(), () => this.createSegment(p, q, arc));
    this.afterCreate();
  }

  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (this.mode === 'pick') { this.pick(e); return; }
    const p = e.p;
    if (!this.start) { this.start = p; this.cur = p; return; }
    if (this.mode === 'rect') {
      const a = this.start, c = p; const b = { x: c.x, y: a.y }, d = { x: a.x, y: c.y };
      app.doc.transaction(this.txName(), () => {
        for (const [s, t] of [[a, b], [b, c], [c, d], [d, a]] as [V2, V2][]) if (dist(s, t) > 1) this.createSegment(s, t);
      });
      this.afterCreate();
      this.start = null;
      return;
    }
    if (this.mode === 'arc') {
      if (!this.arcEnd) { this.arcEnd = p; return; }
      const arc = arcFrom3(this.start, p, this.arcEnd);
      if (arc) this.commit(this.start, this.arcEnd, arc);
      this.start = this.chain ? this.arcEnd : null; this.arcEnd = null;
      return;
    }
    if (this.mode === 'circle') {
      const r = dist(this.start, p);
      if (r > 1) {
        const c = this.start;
        app.doc.transaction(this.txName(), () => {
          this.createSegment(add(c, { x: r, y: 0 }), add(c, { x: -r, y: 0 }), { c, r, a0: 0, a1: Math.PI });
          this.createSegment(add(c, { x: -r, y: 0 }), add(c, { x: r, y: 0 }), { c, r, a0: Math.PI, a1: Math.PI * 2 });
        });
        this.afterCreate();
      }
      this.start = null;
      return;
    }
    this.commit(this.start, p);
    this.start = this.chain ? p : null;
  }

  private pick(e: ToolEvent): void {
    const h = this.pickHover;
    if (!h) { app.status('Keine Linie unter dem Cursor.'); return; }
    // Versatzrichtung zum Cursor
    let [a, b] = [h.a, h.b];
    if (this.offset) {
      const n = perp(norm(sub(b, a)));
      const side = (e.raw.x - a.x) * n.x + (e.raw.y - a.y) * n.y >= 0 ? 1 : -1;
      const d = mul(n, side * this.offset);
      a = add(a, d); b = add(b, d);
    }
    app.doc.transaction(this.txName(), () => this.createSegment(a, b));
    this.afterCreate();
  }

  move(e: ToolEvent): void {
    this.cur = e.p;
    if (this.mode === 'pick') {
      const hits = e.vp.hit(e.raw, (id: string) => { const el = app.doc.get(id); return !!el && this.pickFilter(el.cat); });
      this.pickHover = null;
      for (const h of hits) {
        const el = app.doc.get(h.id)!;
        const c = catDef(el.cat)?.curve?.(el, app.doc, e.view);
        if (c) { this.pickHover = { ...c, id: h.id }; break; }
      }
      if (!this.pickHover) {
        // beliebige Kante der Anzeige
        const segs = e.vp.displayList().segmentsNear(e.raw, e.vp.hitTol());
        if (segs.length) this.pickHover = { a: segs[0].a, b: segs[0].b, id: '' };
      }
    }
  }

  typedLength(L: number, e: ToolEvent | null): void {
    if (!this.start) return;
    const target = this.cur ?? e?.p;
    if (!target) return;
    const d = norm(sub(target, this.start));
    if (Math.hypot(d.x, d.y) < 0.5) return;
    const end = add(this.start, mul(d, L));
    if (this.mode === 'rect') return;
    this.commit(this.start, end);
    this.start = this.chain ? end : null;
    this.cur = end;
    app.setPrompt(this.prompt());
  }

  escape(): boolean {
    if (this.start || this.arcEnd) { this.start = null; this.arcEnd = null; return true; }
    return false;
  }

  preview(dl: DisplayList, vp: any): void {
    const s = vp.view.scale as number;
    if (this.mode === 'pick') {
      if (this.pickHover) dl.line(this.pickHover.a, this.pickHover.b, { w: 4, color: '#1e6fd9' });
      return;
    }
    if (!this.start || !this.cur) return;
    const a = this.start, c = this.cur;
    if (this.mode === 'rect') {
      const b = { x: c.x, y: a.y }, d = { x: a.x, y: c.y };
      for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]] as [V2, V2][]) this.segmentPreview(dl, p, q);
      listen(dl, a, b, s); listen(dl, b, c, s);
      return;
    }
    if (this.mode === 'arc') {
      if (!this.arcEnd) { dl.line(a, c, PREVIEW_THIN); listen(dl, a, c, s); return; }
      const arc = arcFrom3(a, c, this.arcEnd);
      if (arc) dl.arc(arc.c, arc.r, arc.a0, arc.a1, PREVIEW);
      return;
    }
    if (this.mode === 'circle') { dl.circle(a, dist(a, c), PREVIEW); listen(dl, a, c, s); return; }
    const [p, q] = this.off(a, c);
    this.segmentPreview(dl, p, q);
    if (this.offset) dl.line(a, c, PREVIEW_THIN);
    listen(dl, a, c, s);
  }
}

/** "Hörende" Bemaßung: Länge und Winkel am Gummiband */
export function listen(dl: DisplayList, a: V2, b: V2, scale: number): void {
  const L = dist(a, b); if (L < 1) return;
  const d = norm(sub(b, a)); const n = perp(d);
  const off = mul(n, 6 * scale);
  const pa = add(a, off), pb = add(b, off);
  const pen: Pen = { w: 1, color: '#3a6ea5' };
  dl.line(pa, pb, pen, { ns: true }); dl.line(a, pa, pen, { ns: true }); dl.line(b, pb, pen, { ns: true });
  let ang = angleOf(d); let rot = ang; if (rot > Math.PI / 2) rot -= Math.PI; if (rot <= -Math.PI / 2) rot += Math.PI;
  dl.text(add(mid(pa, pb), mul(n, 1.2 * scale)), fmtLen(L), { size: 2.6, ha: 'center', va: 'bottom', rot, color: '#1b3f66', opaque: true });
  let a360 = deg(ang); if (a360 < 0) a360 += 360;
  dl.text(add(b, mul(n, -4 * scale)), fmtNum(a360, 2) + '°', { size: 2.2, ha: 'center', va: 'middle', color: '#1b3f66', opaque: true });
}

export { fromAngle };
