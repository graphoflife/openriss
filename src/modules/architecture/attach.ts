// "Wand oben fixieren": Wände an die Unterseite eines Dachs (oder einer Geschossdecke) anschließen.
// Liefert über registerWallTopProvider das Höhenprofil entlang der Wandachse.
import type { Id, El } from '../../core/doc';
import { V2, add, mul, dist, lineLine, pointInPoly, MultiPoly } from '../../core/geom';
import { registerCommand } from '../../core/registry';
import { registerWallTopProvider, Wall, wallInfo } from '../../elements/wall';
import { app } from '../../app';
import { Tool, ToolEvent } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { roofGeomOf, roofZ0 } from './roof';
import { faceRise } from './roofGeom';
import { floorArea, floorTop, floorThick } from './floor';

const TARGETS = ['roof', 'floor'];

/** Unterseite des Ziels an Punkt p (null = außerhalb) und Kanten zur Bestimmung der Knickpunkte */
function targetSampler(doc: typeof app.doc, t: El): { at: (p: V2) => number | null; edges: [V2, V2][] } | null {
  if (t.cat === 'roof') {
    const g = roofGeomOf(doc, t); const z0 = roofZ0(doc, t);
    const polys: MultiPoly = g.faces ? g.faces.map((f) => f.poly) : g.footprint;
    const edges: [V2, V2][] = [];
    for (const p of polys) for (const r of p) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
    return {
      edges,
      at: (p) => {
        if (!g.faces) return g.footprint.some((q) => pointInPoly(p, q)) ? z0 : null;
        for (const f of g.faces) if (pointInPoly(p, f.poly)) return z0 + faceRise(f, p);
        return null;
      },
    };
  }
  if (t.cat === 'floor') {
    const a = floorArea(doc, t); const zb = floorTop(doc, t) - floorThick(doc, t);
    const edges: [V2, V2][] = [];
    for (const p of a) for (const r of p) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
    return { edges, at: (p) => (a.some((q) => pointInPoly(p, q)) ? zb : null) };
  }
  return null;
}

registerWallTopProvider((w: Wall, doc, c0, c1, zTop) => {
  const tid = (w as El).attachTopId as Id | undefined;
  if (!tid) return null;
  const t = doc.get(tid); if (!t || !TARGETS.includes(t.cat)) return null;
  const s = targetSampler(doc, t); if (!s) return null;
  const wi = wallInfo(doc, w);
  const L = dist(c0, c1); if (L < 1) return null;
  const d = wi.d, n = wi.n, hT = wi.T / 2;
  const lines = [0, hT, -hT].map((o) => [add(c0, mul(n, o)), add(c1, mul(n, o))] as [V2, V2]);
  // Knickstellen: Schnitte der Wandlinien mit den Flächenkanten
  const us = new Set<number>([0, L]);
  for (const [a, b] of lines) for (const [p, q] of s.edges) {
    const x = lineLine(a, b, p, q);
    if (x && x.t > 0 && x.t < 1 && x.u >= -1e-6 && x.u <= 1 + 1e-6) us.add(x.t * L);
  }
  const zAt = (u: number): number => {
    let z = Infinity; let any = false;
    for (const [a] of lines) { const v = s.at(add(a, mul(d, u))); if (v !== null) { any = true; z = Math.min(z, v); } }
    return any ? z : zTop;
  };
  const sorted = [...us].sort((a, b) => a - b);
  const prof: { u: number; z: number }[] = [];
  let inside = false;
  for (const u of sorted) {
    const ua = Math.max(0, u - 0.5), ub = Math.min(L, u + 0.5);
    for (const uu of u === 0 ? [0, ub] : u === L ? [ua, L] : [ua, ub]) {
      const z = zAt(uu);
      if (z !== zTop) inside = true;
      const last = prof[prof.length - 1];
      if (!last || uu > last.u + 1e-6) prof.push({ u: uu, z });
    }
  }
  if (!inside) return null;
  return prof;
});

// ------------------------------------------------------------ Befehle
class AttachTopTool extends Tool {
  id = 'wallAttachTop'; label = 'Oben fixieren'; kinds = ['plan', 'ceiling', 'section', 'elevation'];
  private walls: Id[] = [];
  private hover: Id | null = null;
  activate(): void { this.walls = app.selected().filter((e) => e.cat === 'wall').map((e) => e.id); }
  prompt(): string {
    return this.walls.length ? 'Dach oder Geschossdecke wählen, an der die Wände oben fixiert werden.' : 'Wände wählen (Strg für mehrere) und mit Enter bestätigen.';
  }
  move(e: ToolEvent): void {
    this.hover = null;
    const want = this.walls.length ? TARGETS : ['wall'];
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el && want.includes(el.cat)) { this.hover = el.id; break; } }
    e.vp.hover = this.hover;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.walls.length) {
      if (this.hover) app.select([this.hover], 'add');
      return;
    }
    if (!this.hover) { app.status('Bitte ein Dach oder eine Geschossdecke wählen.'); return; }
    const target = this.hover;
    app.doc.transaction('Wand oben fixieren', () => { for (const id of this.walls) app.doc.update(id, { attachTopId: target }); });
    app.select(this.walls);
    app.setTool(null);
  }
  enter(): boolean {
    if (!this.walls.length) {
      this.walls = app.selected().filter((e) => e.cat === 'wall').map((e) => e.id);
      app.setPrompt(this.prompt());
      return true;
    }
    return false;
  }
  preview(dl: DisplayList): void { void dl; }
}

const selWalls = () => app.selected().filter((e) => e.cat === 'wall');
registerCommand({ id: 'wallAttachTop', label: 'Oben fixieren', icon: 'attach', tip: 'Gewählte Wände oben an einem Dach oder einer Geschossdecke fixieren', run: () => startTool(new AttachTopTool(), 'wallAttachTop') });
registerCommand({
  id: 'wallDetachTop', label: 'Oben lösen', icon: 'detach', tip: 'Fixierung der Wandoberkante lösen',
  enabled: () => selWalls().some((w) => w.attachTopId),
  run: () => {
    const ws = selWalls().filter((w) => w.attachTopId);
    app.doc.transaction('Wand oben lösen', () => { for (const w of ws) app.doc.update(w.id, { attachTopId: undefined }); });
  },
});

