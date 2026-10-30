// Treppenbewehrung (Massivtreppe als Host): je Lauf geknickte Längsstäbe in der Laufplatte
// (Podest – Lauf – Podest, SSHV Form 104), optional obere Längsstäbe, Querbewehrung über die Laufbreite
// und Querbewehrung in den Podesten. Geometrie aus der Treppe (stairGeom); «An Bauteil anpassen»
// rechnet die Stäbe nach Änderung von Ø/Deckung/Treppe neu.
import { app } from '../../../app';
import type { Doc, El, Id } from '../../../core/doc';
import { newId } from '../../../core/doc';
import { V2, V3, add, mul, perp, dot, sub, sub3, len3 } from '../../../core/geom';
import { registerCommand, registerContextPanel, registerPanel } from '../../../core/registry';
import type { View } from '../../../core/view';
import type { DisplayList } from '../../../render/displayList';
import { Tool, ToolEvent, OptionItem } from '../../../tools/tool';
import { startTool } from '../../../ui/commands';
import { stairGeom, stairType, StairGeom } from '../../architecture/stair';
import { diasFor } from './norm';
import { Rebar, drawRebar, assignPos } from './rebar';
import { vfOf } from './frame';
import { coverFor, refitHooks } from './build';
import { createRebarTag, RebarTag } from './tag';
import { arrangeTags } from './layout';
import { ensureRebarMaterial } from '../common';

export interface StairRebarOpts {
  /** Längsstäbe unten (Laufplatte, geknickt in die Podeste) */
  diaM: number; sM: number;
  /** Querbewehrung (Lauf und Podest) */
  diaQ: number; sQ: number;
  /** obere Längsstäbe */
  top: boolean; diaT: number; sT: number;
  /** Querbewehrung in den Podesten */
  landing: boolean;
  /** Überdeckung (0 = Bauteil/Projekt) */
  cover: number;
}
export type StairPart = 'bot' | 'top' | 'dist' | 'land';
export interface StairFit { run: number; part: StairPart; o: StairRebarOpts }
export const STAIR_DEFAULTS: StairRebarOpts = { diaM: 12, sM: 150, diaQ: 8, sQ: 200, top: false, diaT: 10, sT: 200, landing: true, cover: 0 };
const PART_LABEL: Record<StairPart, string> = { bot: 'Laufplatte unten', top: 'Laufplatte oben', dist: 'Querbewehrung Lauf', land: 'Querbewehrung Podest' };

type Run = StairGeom['runs'][number];
type UZ = [number, number];

/** Lauf im lokalen System: u entlang des Laufs (ab Antritt), v quer, z absolut */
interface RunCtx {
  i: number; run: Run; L: number; k: number; c_: number; zr: number; w: number;
  W3: (u: number, v: number, z: number) => V3;
  D3: V3; N3: V3;
  before: { depth: number; z: number } | null;
  after: { depth: number; z: number } | null;
}
function runCtx(g: StairGeom, i: number): RunCtx {
  const run = g.runs[i];
  const P = (u: number, v: number): V2 => add(add(run.s, mul(run.d, u)), mul(perp(run.d), v));
  const W3 = (u: number, v: number, z: number): V3 => { const q = g.W(P(u, v)); return { x: q.x, y: q.y, z }; };
  const D = g.WV(run.d), N = g.WV(perp(run.d));
  const k = g.r / g.t;
  const end = P(run.L, 0);
  const lnd = (j: number, from: V2, dir: V2) => {
    const l = g.landings[j]; if (!l) return null;
    return { depth: Math.max(...l.ring.map((q) => dot(sub(q, from), dir))), z: l.z };
  };
  return {
    i, run, L: run.L, k, c_: Math.sqrt(1 + k * k), zr: run.z, w: g.w, W3,
    D3: { x: D.x, y: D.y, z: 0 }, N3: { x: N.x, y: N.y, z: 0 },
    before: i > 0 ? lnd(i - 1, run.s, mul(run.d, -1)) : null,
    after: i < g.runs.length - 1 ? lnd(i, end, run.d) : null,
  };
}
/** Schnitt waagrechte Linie z = h mit Gerade z = a + k·u */
const uAt = (h: number, a: number, k: number) => (h - a) / k;
function clean(pts: UZ[]): UZ[] {
  const out: UZ[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1) out.push(p);
  return out;
}

/** Alle Bewehrungssätze einer Treppe (ohne ID/Positionsnummer) */
export function buildStairRebar(doc: Doc, st: El, o: StairRebarOpts): Partial<Rebar>[] {
  const t = stairType(doc, st);
  if ((t?.construction ?? 'massiv') !== 'massiv') return [];
  const g = stairGeom(doc, st);
  const e = t?.waist ?? 160, lt = t?.landingThick ?? 200;
  const c = coverFor(doc, st, o.cover);
  const out: Partial<Rebar>[] = [];
  const base = (dia: number, s: number, part: StairPart, run: number): Partial<Rebar> => ({
    hostId: st.id, dia, layout: 'maxSpacing', count: 2, spacing: s, display: 'first', coverUsed: c, cover: o.cover > 0 ? o.cover : undefined,
    hookA: 0, hookB: 0, mark: PART_LABEL[part], stairFit: { run, part, o: { ...o } } as StairFit,
  } as Partial<Rebar>);
  const bar = (R: RunCtx, pts: UZ[], v: number) => clean(pts).map(([u, z]) => R.W3(u, v, z));
  g.runs.forEach((_, i) => {
    const R = runCtx(g, i);
    if (R.run.m < 2) return;
    const { k, c_, zr, L } = R;
    // --- Längsstäbe unten: Podest – Lauf – Podest
    const dM = o.diaM; const cb = c + dM / 2;
    const a = zr - e * c_ + cb * c_; // Achse parallel zur Laufplattenunterseite
    const pb: UZ[] = []; let kA = c, kB = L - c; // Bereich der geneigten Laufplatte
    if (R.before) { const h = R.before.z - lt + cb; kA = uAt(h, a, k); pb.push([-R.before.depth + c, h], [kA, h]); }
    else { const h = zr + cb; const uk = uAt(h, a, k); if (uk > c) { kA = uk; pb.push([c, h], [uk, h]); } else pb.push([c, a + k * c]); }
    if (R.after) { const h = R.after.z - lt + cb; kB = uAt(h, a, k); pb.push([kB, h], [L + R.after.depth - c, h]); }
    else pb.push([kB, a + k * kB]);
    const v0 = -R.w / 2 + c + dM / 2;
    const pM = bar(R, pb, v0);
    out.push({ ...base(dM, o.sM, 'bot', i), shape: pM.length > 2 ? '99' : '00', pts: pM, dir: R.N3, span: Math.max(0, R.w - 2 * c - dM) });
    // --- Längsstäbe oben (parallel zur Linie der Stufenwurzeln)
    if (o.top) {
      const dT = o.diaT; const ct = c + dT / 2; const at = zr - ct * c_;
      const pt: UZ[] = [];
      if (R.before) { const h = R.before.z - ct; pt.push([-R.before.depth + c, h], [uAt(h, at, k), h]); }
      else { const u0 = Math.max(c, uAt(zr + ct, at, k)); pt.push([u0, at + k * u0]); }
      if (R.after) { const h = R.after.z - ct; pt.push([uAt(h, at, k), h], [L + R.after.depth - c, h]); }
      else pt.push([L - c, at + k * (L - c)]);
      const pT = bar(R, pt, -R.w / 2 + c + dT / 2);
      out.push({ ...base(dT, o.sT, 'top', i), shape: pT.length > 2 ? '99' : '00', pts: pT, dir: R.N3, span: Math.max(0, R.w - 2 * c - dT) });
    }
    // --- Querbewehrung Lauf: auf den unteren Längsstäben, über die geneigte Laufplatte verteilt
    const dQ = o.diaQ; const aq = zr - e * c_ + (c + dM + dQ / 2) * c_;
    const uA = Math.max(kA, 0) + 50, uB = Math.min(kB, L + (R.after?.depth ?? 0)) - 50;
    if (uB > uA) {
      const z0 = aq + k * uA;
      out.push({
        ...base(dQ, o.sQ, 'dist', i), shape: '00', pts: [R.W3(uA, -R.w / 2 + c, z0), R.W3(uA, R.w / 2 - c, z0)],
        dir: { x: R.D3.x / c_, y: R.D3.y / c_, z: k / c_ }, span: (uB - uA) * c_,
      });
    }
    // --- Querbewehrung Podest (nach dem Lauf): quer zum Lauf, über die Podesttiefe verteilt
    const lnd = g.landings[i];
    if (o.landing && lnd && R.after) {
      const vs = lnd.ring.map((q) => dot(sub(q, R.run.s), perp(R.run.d)));
      const vmin = Math.min(...vs), vmax = Math.max(...vs);
      const z = lnd.z - lt + c + dM + dQ / 2; const u0 = L + c + dQ / 2;
      out.push({
        ...base(dQ, o.sQ, 'land', i), shape: '00', pts: [R.W3(u0, vmin + c, z), R.W3(u0, vmax - c, z)],
        dir: R.D3, span: Math.max(0, R.after.depth - 2 * c - dQ),
      });
    }
  });
  return out.filter((p) => p.pts && p.pts.length >= 2 && len3(sub3(p.pts[1], p.pts[0])) > 1);
}

// ------------------------------------------------------------ An Bauteil anpassen
refitHooks.push((doc, el, patch) => {
  const f = el.stairFit as StairFit | undefined; if (!f) return null;
  const st = doc.get(el.hostId); if (!st || st.cat !== 'stair') return null;
  const o: StairRebarOpts = { ...STAIR_DEFAULTS, ...f.o };
  const dia = patch.dia ?? el.dia;
  if (f.part === 'bot') o.diaM = dia; else if (f.part === 'top') { o.diaT = dia; o.top = true; } else o.diaQ = dia;
  if ('cover' in patch) o.cover = patch.cover ?? 0;
  const r = buildStairRebar(doc, st, o).find((p) => (p.stairFit as StairFit).run === f.run && (p.stairFit as StairFit).part === f.part);
  if (!r) return patch;
  return { ...patch, pts: r.pts, dir: r.dir, span: r.span, shape: r.shape, coverUsed: r.coverUsed, stairFit: { ...f, o } } as Partial<Rebar>;
});

/** Sätze anlegen (in Transaktion); optional beschriften (parallel, angeordnet) */
export function addStairRebar(doc: Doc, st: El, o: StairRebarOpts, view?: View | null, tag = false): Id[] {
  ensureRebarMaterial(doc);
  const ids: Id[] = []; const tags: Id[] = [];
  for (const p of buildStairRebar(doc, st, o)) {
    const el = { ...p, id: newId('rb'), cat: 'rebar', pos: 0 } as Rebar;
    el.pos = assignPos(doc, el);
    doc.add(el); ids.push(el.id);
    if (tag && view) { const t = createRebarTag(doc, el, view, undefined, 'ch', true, { par: true }); if (t) tags.push(t.id); }
  }
  if (tags.length && view) for (const [id, p] of arrangeTags(doc, view, new Set(tags))) doc.update(id, p as Partial<RebarTag>);
  return ids;
}

// ------------------------------------------------------------ Werkzeug
const BLUE = '#1e6fd9';
let memo: StairRebarOpts = { ...STAIR_DEFAULTS };
export class StairRebarTool extends Tool {
  id = 'stairRebar'; label = 'Treppenbewehrung'; kinds = ['plan', 'section'];
  snapping = false;
  private hover: El | null = null;
  activate(): void {
    const s = app.selected().find((e) => e.cat === 'stair');
    if (s) this.hover = s;
  }
  prompt(): string { return 'Treppe anklicken – Längsstäbe (Podest–Lauf–Podest), Querbewehrung und Podestbewehrung werden eingepasst.'; }
  options(): OptionItem[] {
    const o = memo; const dias = (cur: number) => diasFor(app.doc, cur).map((d) => [String(d), String(d)] as [string, string]);
    const set = (k: keyof StairRebarOpts, rerender = false) => (v: any) => { (o as any)[k] = v; if (rerender) app.emit('tool'); app.redrawOverlay(); };
    const out: OptionItem[] = [
      { kind: 'select', key: 'diaM', label: 'Längs Ø', value: String(o.diaM), options: dias(o.diaM), onChange: (v) => set('diaM')(Number(v)) },
      { kind: 'length', key: 'sM', label: 's', value: o.sM, onChange: (v) => set('sM')(Math.max(50, v)) },
      { kind: 'select', key: 'diaQ', label: 'Quer Ø', value: String(o.diaQ), options: dias(o.diaQ), onChange: (v) => set('diaQ')(Number(v)) },
      { kind: 'length', key: 'sQ', label: 's', value: o.sQ, onChange: (v) => set('sQ')(Math.max(50, v)) },
      { kind: 'check', key: 'top', label: 'Obere Längsstäbe', value: o.top, onChange: set('top', true) },
    ];
    if (o.top) out.push(
      { kind: 'select', key: 'diaT', label: 'oben Ø', value: String(o.diaT), options: dias(o.diaT), onChange: (v) => set('diaT')(Number(v)) },
      { kind: 'length', key: 'sT', label: 's', value: o.sT, onChange: (v) => set('sT')(Math.max(50, v)) },
    );
    out.push(
      { kind: 'check', key: 'landing', label: 'Podest-Querbewehrung', value: o.landing, onChange: set('landing') },
      { kind: 'length', key: 'cover', label: 'Deckung (0 = Std.)', value: o.cover, onChange: set('cover') },
      { kind: 'check', key: 'tag', label: 'Beschriften', value: app.settings.tagOnPlace, onChange: (x) => { app.settings.tagOnPlace = x; app.saveSettings(); } },
    );
    return out;
  }
  move(e: ToolEvent): void {
    this.hover = null;
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el?.cat === 'stair') { this.hover = el; break; } }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const st = this.hover;
    if (!st) { app.status('Keine Treppe unter dem Cursor.'); return; }
    let ids: Id[] = [];
    app.doc.transaction(this.label, () => { ids = addStairRebar(app.doc, st, { ...memo }, e.view, app.settings.tagOnPlace); });
    app.status(ids.length ? `${ids.length} Bewehrungssätze in der Treppe erstellt.` : 'Nur Massivtreppen (Laufplatte) können bewehrt werden.');
  }
  preview(dl: DisplayList, vp: any): void {
    const view = vp.view as View; if (!this.hover) return;
    const vf = vfOf(app.doc, view); if (!vf) return;
    buildStairRebar(app.doc, this.hover, memo).forEach((p, i) => {
      try { drawRebar(dl, app.doc, { ...p, id: '__stair' + i, cat: 'rebar', pos: 0 } as Rebar, vf, BLUE); } catch { /* */ }
    });
  }
}

registerCommand({
  id: 'stairRebar', label: 'Treppen- bewehrung', icon: 'rebar',
  tip: 'Massivtreppe bewehren: geknickte Längsstäbe Podest–Lauf–Podest (Form 104), optional obere Längsstäbe, Querbewehrung in Lauf und Podest.',
  run: () => startTool(new StairRebarTool(), 'stairRebar'),
});
registerContextPanel({ cats: ['stair'], panel: 'Treppe', items: ['stairRebar'] });
registerPanel('Ingenieurbau', 'Bewehrung', ['stairRebar']);
