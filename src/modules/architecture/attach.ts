// "Wand oben fixieren": Wände an die Unterseite eines Dachs (oder einer Geschossdecke) anschließen;
// "Wand unten fixieren": Unterkante an Ober- oder Unterseite einer (auch geneigten) Platte bzw. Rampe.
// Liefert über registerWallTopProvider das Höhenprofil entlang der Wandachse (which = 'top' | 'base').
import type { Id, El, Doc } from '../../core/doc';
import { V2, add, mul, dist, lineLine, pointInPoly, MultiPoly } from '../../core/geom';
import { registerCommand, registerContextPanel, catDef, GROUPS, PropDef } from '../../core/registry';
import { registerWallTopProvider, Wall, wallInfo } from '../../elements/wall';
import { surfaceOf } from '../../views/surfaces';
import { app } from '../../app';
import { Tool, ToolEvent } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { roofGeomOf, roofZ0 } from './roof';
import { faceRise } from './roofGeom';
import { floorArea } from './floor';

const TARGETS = ['roof', 'floor', 'foundationSlab'];
const BASE_TARGETS = ['floor', 'foundationSlab'];

interface Sampler {
  /** Höhe im Punkt p (null = ausserhalb) */
  at: (p: V2) => number | null;
  /** Flächenkanten (Sprungstellen) */
  edges: [V2, V2][];
  /** Knicklinien (unendliche Geraden durch a–b, stetig) */
  creases: { a: V2; b: V2 }[];
}

const edgesOf = (polys: MultiPoly): [V2, V2][] => {
  const edges: [V2, V2][] = [];
  for (const p of polys) for (const r of p) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
  return edges;
};

/**
 * Ober-/Unterseite des Ziels (face) im Punkt p und Kanten/Knicklinien zur Bestimmung der Knickpunkte.
 * extend: ausserhalb der Fläche die (verlängerte) Fläche verwenden (Unterkante folgt der Plattenebene).
 */
function targetSampler(doc: Doc, t: El, face: 'top' | 'bottom', extend: boolean): Sampler | null {
  if (t.cat === 'roof') {
    const g = roofGeomOf(doc, t); const z0 = roofZ0(doc, t);
    const polys: MultiPoly = g.faces ? g.faces.map((f) => f.poly) : g.footprint;
    return {
      edges: edgesOf(polys), creases: [],
      at: (p) => {
        if (!g.faces) return g.footprint.some((q) => pointInPoly(p, q)) ? z0 : null;
        for (const f of g.faces) if (pointInPoly(p, f.poly)) return z0 + faceRise(f, p);
        return null;
      },
    };
  }
  const s = surfaceOf(doc, t); if (!s) return null;
  // Fundamentplatte: Skizze = ein Polygon mit Löchern (ohne Modulabhängigkeit zum Tragwerk)
  const a: MultiPoly = t.cat === 'floor' ? floorArea(doc, t) : t.loops?.length ? [t.loops] : [];
  const f = face === 'top' ? s.topAt : s.botAt;
  return { edges: edgesOf(a), creases: s.creases ?? [], at: (p) => (extend || a.some((q) => pointInPoly(p, q)) ? f(p) : null) };
}

registerWallTopProvider((w: Wall, doc, c0, c1, zNom, which = 'top') => {
  const base = which === 'base';
  const tid = (base ? w.attachBaseId : w.attachTopId) as Id | undefined;
  if (!tid) return null;
  const t = doc.get(tid); if (!t || !(base ? BASE_TARGETS : TARGETS).includes(t.cat)) return null;
  const s = targetSampler(doc, t, base && w.attachBaseTo !== 'bottom' ? 'top' : 'bottom', base); if (!s) return null;
  // Oberkante: tiefster Punkt über die Wanddicke; Unterkante: 'min' (greift in die Platte ein) oder 'max'
  const pick = base && w.attachBaseMode === 'max' ? Math.max : Math.min;
  const wi = wallInfo(doc, w);
  const L = dist(c0, c1); if (L < 1) return null;
  const d = wi.d, n = wi.n, hT = wi.T / 2;
  const lines = [0, hT, -hT].map((o) => [add(c0, mul(n, o)), add(c1, mul(n, o))] as [V2, V2]);
  // Knickstellen: Schnitte der Wandlinien mit den Flächenkanten (Sprung: beidseitig abtasten) und Knicklinien (stetig)
  const jumps = new Set<number>([0, L]); const kinks = new Set<number>();
  for (const [a, b] of lines) {
    for (const [p, q] of s.edges) {
      const x = lineLine(a, b, p, q);
      if (x && x.t > 0 && x.t < 1 && x.u >= -1e-6 && x.u <= 1 + 1e-6) jumps.add(x.t * L);
    }
    for (const c of s.creases) { const x = lineLine(a, b, c.a, c.b); if (x && x.t > 0 && x.t < 1) kinks.add(x.t * L); }
  }
  const zAt = (u: number): number => {
    const vs: number[] = [];
    for (const [a] of lines) { const v = s.at(add(a, mul(d, u))); if (v !== null) vs.push(v); }
    return vs.length ? pick(...vs) : zNom;
  };
  const sorted = [...new Set([...jumps, ...kinks])].sort((a, b) => a - b);
  const prof: { u: number; z: number }[] = [];
  let inside = false;
  for (const u of sorted) {
    const ua = Math.max(0, u - 0.5), ub = Math.min(L, u + 0.5);
    const at = !jumps.has(u) ? [u] : u === 0 ? [0, ub] : u === L ? [ua, L] : [ua, ub];
    for (const uu of at) {
      const z = zAt(uu);
      if (z !== zNom) inside = true;
      const last = prof[prof.length - 1];
      if (!last || uu > last.u + 1e-6) prof.push({ u: uu, z });
    }
  }
  if (!inside) return null;
  return prof;
});

// ------------------------------------------------------------ Befehle
class AttachTool extends Tool {
  id: string; label: string; kinds = ['plan', 'ceiling', 'section', 'elevation'];
  private walls: Id[] = [];
  private hover: Id | null = null;
  constructor(private which: 'top' | 'base') {
    super();
    this.id = which === 'top' ? 'wallAttachTop' : 'wallAttachBase';
    this.label = which === 'top' ? 'Oben fixieren' : 'Unten fixieren';
  }
  private targets(): string[] { return this.which === 'top' ? TARGETS : BASE_TARGETS; }
  activate(): void { this.walls = app.selected().filter((e) => e.cat === 'wall').map((e) => e.id); }
  prompt(): string {
    if (!this.walls.length) return 'Wände wählen (Strg für mehrere) und mit Enter bestätigen.';
    return this.which === 'top' ? 'Dach oder Geschossdecke wählen, an der die Wände oben fixiert werden.' : 'Geschossdecke, Rampe oder Fundamentplatte wählen, auf der die Wände unten fixiert werden.';
  }
  move(e: ToolEvent): void {
    this.hover = null;
    const want = this.walls.length ? this.targets() : ['wall'];
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el && want.includes(el.cat)) { this.hover = el.id; break; } }
    e.vp.hover = this.hover;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.walls.length) {
      if (this.hover) app.select([this.hover], 'add');
      return;
    }
    if (!this.hover) { app.status(this.which === 'top' ? 'Bitte ein Dach oder eine Geschossdecke wählen.' : 'Bitte eine Geschossdecke oder Fundamentplatte wählen.'); return; }
    const target = this.hover;
    app.doc.transaction(this.which === 'top' ? 'Wand oben fixieren' : 'Wand unten fixieren', () => {
      for (const id of this.walls) app.doc.update(id, this.which === 'top' ? { attachTopId: target } : { attachBaseId: target });
    });
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
registerCommand({ id: 'wallAttachTop', label: 'Oben fixieren', icon: 'attach', tip: 'Gewählte Wände oben an einem Dach oder einer Geschossdecke fixieren', run: () => startTool(new AttachTool('top'), 'wallAttachTop') });
registerCommand({
  id: 'wallDetachTop', label: 'Oben lösen', icon: 'detach', tip: 'Fixierung der Wandoberkante lösen',
  enabled: () => selWalls().some((w) => w.attachTopId),
  run: () => {
    const ws = selWalls().filter((w) => w.attachTopId);
    app.doc.transaction('Wand oben lösen', () => { for (const w of ws) app.doc.update(w.id, { attachTopId: undefined }); });
  },
});
registerCommand({ id: 'wallAttachBase', label: 'Unten fixieren', icon: 'attachBase', tip: 'Unterkante der gewählten Wände an einer (geneigten) Geschossdecke, Rampe oder Fundamentplatte fixieren', run: () => startTool(new AttachTool('base'), 'wallAttachBase') });
registerCommand({
  id: 'wallDetachBase', label: 'Unten lösen', icon: 'detach', tip: 'Fixierung der Wandunterkante lösen',
  enabled: () => selWalls().some((w) => w.attachBaseId),
  run: () => {
    const ws = selWalls().filter((w) => w.attachBaseId);
    app.doc.transaction('Wand unten lösen', () => { for (const w of ws) app.doc.update(w.id, { attachBaseId: undefined }); });
  },
});
registerContextPanel({ cats: ['wall'], panel: 'Fixieren', items: ['wallAttachBase', 'wallDetachBase'] });

// Eigenschaften der Unterkanten-Fixierung (nur bei fixierten Wänden)
{
  const def = catDef('wall');
  if (def) {
    const orig = def.props;
    def.props = (el, doc) => {
      const p = orig ? orig(el, doc) : [];
      if (!el.attachBaseId) return p;
      const g = GROUPS.constraints;
      const extra: PropDef[] = [
        { key: 'attachBase', label: 'Unterkante fixiert an', group: g, type: 'readonly', get: (e, d) => { const t = d.get(e.attachBaseId); return t ? t.mark || d.get(t.typeId)?.name || catDef(t.cat)?.label || t.cat : '–'; } },
        { key: 'attachBaseTo', label: 'Unterkante an', group: g, type: 'select', options: [['top', 'Oberseite der Platte'], ['bottom', 'Unterseite der Platte']], get: (e) => e.attachBaseTo ?? 'top', set: (_e, v) => ({ attachBaseTo: v === 'bottom' ? 'bottom' : undefined }) },
        { key: 'attachBaseMode', label: 'Über Wanddicke', group: g, type: 'select', options: [['min', 'Tiefster Punkt (greift ein)'], ['max', 'Höchster Punkt']], get: (e) => e.attachBaseMode ?? 'min', set: (_e, v) => ({ attachBaseMode: v === 'max' ? 'max' : undefined }) },
      ];
      const i = p.findIndex((x) => x.key === 'baseOffset');
      p.splice(i >= 0 ? i + 1 : p.length, 0, ...extra);
      return p;
    };
  }
}
