// Skizzenmodus (wie Revit "Begrenzung skizzieren"): Linien, Rechteck, Polylinie, Bogen, Kreis,
// "Wände wählen" / "Linien wählen" sammeln; "Fertig stellen" bildet geschlossene Umrisse.
import { app } from '../app';
import { LineDrawTool, PREVIEW } from './drawTool';
import { ToolEvent, OptionItem } from './tool';
import { V2, add, sub, mul, norm, perp, dist, lineLine, arcPoints, signedArea, eq, sideDist } from '../core/geom';
import { catDef } from '../core/registry';
import type { DisplayList } from '../render/displayList';
import type { Wall } from '../elements/wall';
import { wallInfo, layerOffsets } from '../elements/wall';

export interface SketchSeg { a: V2; b: V2; arc?: { c: V2; r: number; a0: number; a1: number } | null; tag?: any }
export const SKETCH_PEN = { w: 3, color: '#d0208c' };

export interface SketchOptions {
  /** offene Linienzüge erlaubt (z.B. Geländer-Pfad) */
  open?: boolean;
  /** vorhandene Skizze (Bearbeiten) */
  initial?: SketchSeg[];
  /** zusätzliche Optionen in der Optionsleiste (z.B. Überstand, Neigung) */
  extra?: () => OptionItem[];
  /** Wand-Bezug beim "Wände wählen" */
  wallRef?: 'ext' | 'int' | 'center' | 'coreExt' | 'coreInt';
  /** Ansichtsarten */
  kinds?: string[];
  /** wird beim Hinzufügen eines Segments aufgerufen (z.B. Neigungsdefinition setzen) */
  onSegment?: (s: SketchSeg) => void;
  /** Vorschau zusätzlich zeichnen */
  preview?: (dl: DisplayList, segs: SketchSeg[]) => void;
}

/** Ergebnis: geschlossene Umrisse (bei open: Linienzüge), Bögen als Polylinien angenähert */
export type SketchDone = (loops: V2[][], segs: SketchSeg[]) => void;

export class SketchTool extends LineDrawTool {
  id = 'sketch'; label: string;
  modes: any = ['line', 'rect', 'polyline', 'arc', 'circle', 'pick'];
  segs: SketchSeg[] = [];
  wallRef: NonNullable<SketchOptions['wallRef']>;
  private hoverWall: { a: V2; b: V2 } | null = null;

  constructor(label: string, private done: SketchDone, private opts: SketchOptions = {}) {
    super();
    this.label = label;
    this.segs = (opts.initial ?? []).map((s) => ({ ...s }));
    this.wallRef = opts.wallRef ?? 'ext';
    this.kinds = opts.kinds ?? ['plan', 'ceiling'];
    this.chain = true;
  }
  txName(): string { return 'Skizze'; }
  prompt(): string { return this.mode === 'pick' ? 'Wand oder Linie wählen (Seite = Wandbezug). Danach „Fertig stellen“.' : super.prompt() + ' „Fertig stellen“ (Enter) beendet die Skizze.'; }

  extraOptions(): OptionItem[] {
    const o: OptionItem[] = [
      { kind: 'button', label: 'Fertig stellen', icon: 'check', primary: true, onClick: () => this.finish() },
      { kind: 'button', label: 'Abbrechen', icon: 'cancel', onClick: () => app.setTool(null) },
    ];
    if (this.mode === 'pick') o.push({ kind: 'select', key: 'wref', label: 'Wandbezug', value: this.wallRef, options: [['ext', 'Außenseite'], ['int', 'Innenseite'], ['center', 'Wandachse'], ['coreExt', 'Tragschicht außen'], ['coreInt', 'Tragschicht innen']], onChange: (v) => (this.wallRef = v as any) });
    o.push(...(this.opts.extra?.() ?? []));
    return o;
  }

  /** In Transaktion aufgerufen – Skizzenlinien sind keine Dokumentelemente */
  createSegment(a: V2, b: V2, arc?: { c: V2; r: number; a0: number; a1: number } | null): void {
    const s: SketchSeg = { a, b, arc: arc ?? null };
    this.opts.onSegment?.(s);
    this.segs.push(s);
    app.redrawOverlay();
  }

  move(e: ToolEvent): void {
    super.move(e);
    this.hoverWall = null;
    if (this.mode === 'pick') {
      for (const h of e.vp.hit(e.raw)) {
        const el = app.doc.get(h.id);
        if (el?.cat === 'wall') { this.hoverWall = this.wallLine(el as Wall); break; }
      }
    }
  }

  private wallLine(w: Wall): { a: V2; b: V2 } {
    const wi = wallInfo(app.doc, w);
    let off = 0;
    const L = layerOffsets(app.doc, w);
    const core = L.filter((l) => l.lay.core);
    const ext = wi.ext; // +1: Außenseite links
    const extFace = (ext * wi.T) / 2, intFace = (-ext * wi.T) / 2;
    switch (this.wallRef) {
      case 'ext': off = extFace; break;
      case 'int': off = intFace; break;
      case 'center': off = 0; break;
      case 'coreExt': off = core.length ? (ext > 0 ? Math.max(...core.map((c) => c.o1)) : Math.min(...core.map((c) => c.o0))) : extFace; break;
      case 'coreInt': off = core.length ? (ext > 0 ? Math.min(...core.map((c) => c.o0)) : Math.max(...core.map((c) => c.o1))) : intFace; break;
    }
    const n = mul(wi.n, off);
    return { a: add(wi.c0, n), b: add(wi.c1, n) };
  }

  down(e: ToolEvent): void {
    if (this.mode === 'pick' && this.hoverWall) {
      let { a, b } = this.hoverWall;
      if (this.offset) { const n = mul(perp(norm(sub(b, a))), this.offset * (this.wallRef === 'int' || this.wallRef === 'coreInt' ? -1 : 1) * (sideDist(e.raw, a, b) >= 0 ? 1 : -1)); a = add(a, n); b = add(b, n); }
      this.createSegment(a, b);
      return;
    }
    super.down(e);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Delete' || e.key === 'Backspace') { this.segs.pop(); app.redrawOverlay(); return true; }
    return false;
  }
  enter(): boolean { this.finish(); return true; }
  escape(): boolean {
    if (super.escape()) return true;
    if (this.segs.length && !confirm('Skizze verwerfen?')) return true;
    return false;
  }

  finish(): void {
    if (!this.segs.length) { app.status('Die Skizze ist leer.'); return; }
    const res = buildLoops(this.segs, !!this.opts.open);
    if (typeof res === 'string') { app.status(res); alert(res); return; }
    const segs = this.segs;
    app.setTool(null);
    this.done(res, segs);
  }

  preview(dl: DisplayList, vp: any): void {
    for (const s of this.segs) {
      if (s.arc) dl.arc(s.arc.c, s.arc.r, s.arc.a0, s.arc.a1, SKETCH_PEN); else dl.line(s.a, s.b, SKETCH_PEN);
    }
    // Sketch-Endpunkte als Fangpunkte sichtbar machen
    this.opts.preview?.(dl, this.segs);
    if (this.hoverWall) dl.line(this.hoverWall.a, this.hoverWall.b, { w: 4, color: '#1e6fd9' });
    super.preview(dl, vp);
  }

  /** Skizzenpunkte als zusätzliche Fangpunkte */
  extraSnaps(): { p: V2; kind: 'end' | 'mid' }[] {
    const out: { p: V2; kind: 'end' | 'mid' }[] = [];
    for (const s of this.segs) out.push({ p: s.a, kind: 'end' }, { p: s.b, kind: 'end' }, { p: { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, kind: 'mid' });
    return out;
  }
}

/** Segmente zu geschlossenen Ringen verbinden (mit automatischem Stutzen/Dehnen kleiner Lücken). */
export function buildLoops(segsIn: SketchSeg[], open = false): V2[][] | string {
  const segs = segsIn.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
  const tol = 1;
  // 1) Lücken/Überstände an Ecken schließen (für "Wände wählen")
  const dangling = (si: number, end: 'a' | 'b') => {
    const p = segs[si][end];
    return !segs.some((t, j) => j !== si && (eq(t.a, p, tol) || eq(t.b, p, tol)));
  };
  for (let i = 0; i < segs.length; i++) for (const ei of ['a', 'b'] as const) {
    if (segs[i].arc || !dangling(i, ei)) continue;
    let best: { j: number; ej: 'a' | 'b'; x: V2; d: number } | null = null;
    for (let j = 0; j < segs.length; j++) {
      if (j === i || segs[j].arc) continue;
      for (const ej of ['a', 'b'] as const) {
        if (!dangling(j, ej)) continue;
        const x = lineLine(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
        if (!x) continue;
        const d = dist(x.p, segs[i][ei]) + dist(x.p, segs[j][ej]);
        const lim = Math.max(1500, 0.3 * (dist(segs[i].a, segs[i].b) + dist(segs[j].a, segs[j].b)));
        if (d < lim && (!best || d < best.d)) best = { j, ej, x: x.p, d };
      }
    }
    if (best) { segs[i][ei] = best.x; segs[best.j][best.ej] = { ...best.x }; }
  }
  // 2) Verketten
  const pts = (s: SketchSeg): V2[] => (s.arc ? arcPoints(s.arc.c, s.arc.r, s.arc.a0, s.arc.a1, 32) : [s.a, s.b]);
  const used = new Uint8Array(segs.length);
  const loops: V2[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = pts(segs[i]);
    // Bogenrichtung an Endpunkte anpassen
    if (segs[i].arc && !eq(chain[0], segs[i].a, 5)) chain.reverse();
    let extended = true;
    while (extended) {
      extended = false;
      const end = chain[chain.length - 1];
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        let p = pts(segs[j]);
        if (eq(p[0], end, tol)) { /* ok */ } else if (eq(p[p.length - 1], end, tol)) p = p.slice().reverse(); else continue;
        chain = chain.concat(p.slice(1)); used[j] = 1; extended = true; break;
      }
      if (!extended) {
        const start = chain[0];
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue;
          let p = pts(segs[j]);
          if (eq(p[p.length - 1], start, tol)) { /* ok */ } else if (eq(p[0], start, tol)) p = p.slice().reverse(); else continue;
          chain = p.slice(0, -1).concat(chain); used[j] = 1; extended = true; break;
        }
      }
    }
    const closed = chain.length > 2 && eq(chain[0], chain[chain.length - 1], tol);
    if (closed) chain.pop();
    if (!open && !closed) return 'Die Skizze ist nicht geschlossen. Linien müssen an den Enden verbunden sein.';
    if (!open && Math.abs(signedArea(chain)) < 1) return 'Die Skizze hat keine Fläche.';
    loops.push(chain);
  }
  // größter Umriss zuerst
  if (!open) loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  return loops;
}

/** Ringe → Skizzensegmente (zum erneuten Bearbeiten) */
export function loopsToSegs(loops: V2[][]): SketchSeg[] {
  const out: SketchSeg[] = [];
  for (const r of loops) for (let i = 0; i < r.length; i++) out.push({ a: r[i], b: r[(i + 1) % r.length] });
  return out;
}

export { PREVIEW, catDef };
