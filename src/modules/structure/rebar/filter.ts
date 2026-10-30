// Bewehrung – Ansichtsfilter «Bewehrungslage»: je Ansicht nur Stäbe einer Lage (unten/oben, 1./2. Lage),
// einer Richtung (x/y/vertikal) und/oder eines Bewehrungsplans – statt langer Listen ausgeblendeter
// Elemente. Lage und Richtung werden aus der Geometrie erkannt und lassen sich je Satz überschreiben.
import type { Doc, El } from '../../../core/doc';
import { catDef, onHook, GROUPS, PropDef } from '../../../core/registry';
import { View, isPlanLike, isSectionLike } from '../../../core/view';
import { cached, hostedBy } from '../../../core/cache';
import { solidsOf } from '../../../views/sectionEngine';
import { isVisibleInView } from '../../../views/viewBuilder';
import type { Rebar } from './rebar';
import { coverFor } from './build';
import { isConcrete } from '../common';
import { planOf, rebarPlans } from './norm';

export type Side = 'u' | 'o';
export type BarDir = 'x' | 'y' | 'z';
export interface RebarClass { side: Side | null; lage: 1 | 2 | null; dir: BarDir }
/** Filter je Ansicht (view.data.rebarFilter) */
export interface RebarFilter { layer?: string; dir?: BarDir | ''; plan?: string; dims?: boolean }

export const LAYER_FILTERS: [string, string][] = [
  ['', 'Alle'], ['u', 'unten'], ['o', 'oben'], ['u1', 'unten, 1. Lage'], ['u2', 'unten, 2. Lage'], ['o1', 'oben, 1. Lage'], ['o2', 'oben, 2. Lage'],
];
export const DIR_FILTERS: [string, string][] = [['', 'Alle'], ['x', 'Richtung x'], ['y', 'Richtung y'], ['z', 'vertikal']];
/** Bauteile ohne Lage oben/unten */
const NO_SIDE = ['wall', 'column', 'stair'];

export const filterOf = (v: View): RebarFilter => v.data?.rebarFilter ?? {};

/** Höhenbereich der Betonkörper eines Bauteils */
function hostZ(doc: Doc, host: El): [number, number] | null {
  return cached(doc, 'rbHostZ', host.id, () => {
    let lo = Infinity, hi = -Infinity;
    for (const s of solidsOf(doc, host)) {
      if (!isConcrete(doc, s.mat)) continue;
      for (const f of s.faces) for (const p of f.pts) { if (p.z < lo) lo = p.z; if (p.z > hi) hi = p.z; }
    }
    return hi > lo ? [lo, hi] as [number, number] : null;
  });
}

/** Seite und Abstand Bauteilrand → Staboberfläche (ohne Klassierung) */
function sideDist(doc: Doc, el: Rebar): { side: Side; gap: number; host: El } | null {
  const host = doc.get(el.hostId);
  if (!host || NO_SIDE.includes(host.cat) || !el.pts?.length) return null;
  const hz = hostZ(doc, host); if (!hz) return null;
  let z0 = Infinity, z1 = -Infinity;
  for (const p of el.pts) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const T = hz[1] - hz[0];
  if (z1 - z0 > Math.max(0.5 * T, 2 * el.dia)) return null; // stehende Stäbe (Anschlüsse, Bügel)
  const zc = (z0 + z1) / 2; const side: Side = zc < (hz[0] + hz[1]) / 2 ? 'u' : 'o';
  return { side, gap: (side === 'u' ? zc - hz[0] : hz[1] - zc) - el.dia / 2, host };
}

/** kleinster Randabstand der Stäbe eines Bauteils je Seite (= 1. Lage) */
function minGap(doc: Doc, hostId: string, side: Side): number {
  return cached(doc, 'rbMinGap', hostId + side, () => {
    let m = Infinity;
    for (const e of hostedBy(doc, hostId)) {
      if (e.cat !== 'rebar') continue;
      const s = sideDist(doc, e as Rebar);
      if (s && s.side === side) m = Math.min(m, s.gap);
    }
    return m;
  });
}

/** Lage und Richtung eines Bewehrungssatzes (gecacht) */
export function rebarClass(doc: Doc, el: Rebar): RebarClass {
  const calc = (): RebarClass => {
    // Richtung: längster Schenkel
    let best = -1; let dir: BarDir = 'z';
    const P = el.pts ?? [];
    for (let i = 1; i < P.length; i++) {
      const dx = P[i].x - P[i - 1].x, dy = P[i].y - P[i - 1].y, dz = P[i].z - P[i - 1].z;
      const h = Math.hypot(dx, dy); const L = Math.hypot(h, dz);
      if (L > best + 0.5) { best = L; dir = Math.abs(dz) > h ? 'z' : Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'; }
    }
    if (el.ldir) dir = el.ldir;
    // Lage: Überschreibung → Einpassung (Plattenmodus) → Geometrie
    const lg: string | undefined = el.lage ?? el.fit?.slab;
    if (lg) return { side: lg[0] as Side, lage: lg[1] === '2' ? 2 : 1, dir };
    const s = sideDist(doc, el);
    if (!s) return { side: null, lage: null, dir };
    const c = el.coverUsed ?? coverFor(doc, s.host, el.cover);
    const lage = s.gap <= c + 3 || s.gap <= minGap(doc, el.hostId, s.side) + 3 ? 1 : 2;
    return { side: s.side, lage, dir };
  };
  return el.id.startsWith('__') ? calc() : cached(doc, 'rbClass', el.id, calc);
}

/** Zusätzliche Sichtbarkeitsregeln für Bewehrung (z. B. Wandabwicklung: nur Stäbe dieser Wandseite) */
const extraRules: ((doc: Doc, el: El, view: View) => boolean)[] = [];
export function addRebarRule(fn: (doc: Doc, el: El, view: View) => boolean): void { extraRules.push(fn); }

/** Erfüllt der Bewehrungssatz den Filter der Ansicht? */
export function passesFilter(doc: Doc, el: El, view: View): boolean {
  const f = filterOf(view);
  if (f.plan && planOf(el) !== f.plan) return false;
  if (el.cat === 'rebar' && (f.layer || f.dir)) {
    const c = rebarClass(doc, el as Rebar);
    if (f.dir && c.dir !== f.dir) return false;
    if (f.layer) {
      if (!c.side || c.side !== f.layer[0]) return false;
      if (f.layer.length > 1 && String(c.lage) !== f.layer[1]) return false;
    }
  }
  for (const r of extraRules) if (!r(doc, el, view)) return false;
  return true;
}

// ------------------------------------------------------------ Einbindung: Sichtbarkeit
for (const cat of ['rebar', 'areaRebar', 'fabricArea']) {
  const def = catDef(cat); if (!def) continue;
  const base = def.visibleIn;
  def.visibleIn = (el, doc, view) => (!base || base(el, doc, view)) && passesFilter(doc, el, view);
}
{
  // Beschriftung nur, wenn die beschriftete Bewehrung in der Ansicht sichtbar ist
  const def = catDef('rebarTag');
  if (def) {
    const base = def.visibleIn;
    def.visibleIn = (el, doc, view) => {
      if (base && !base(el, doc, view)) return false;
      const r = doc.get(el.refId);
      return !r || isVisibleInView(doc, view, r, true);
    };
  }
}

// ------------------------------------------------------------ Eigenschaften: Bewehrungssatz
{
  const def = catDef('rebar')!;
  const base = def.props;
  const LAGEN: [string, string][] = [['', 'automatisch'], ['u1', 'unten, 1. Lage'], ['u2', 'unten, 2. Lage'], ['o1', 'oben, 1. Lage'], ['o2', 'oben, 2. Lage']];
  const lbl = (c: RebarClass) => `${c.side ? (c.side === 'u' ? 'unten' : 'oben') + ', ' + c.lage + '. Lage' : 'ohne Lage'} · ${c.dir === 'z' ? 'vertikal' : 'Richtung ' + c.dir}`;
  def.props = (el, doc) => [
    ...(base ? base(el, doc) : []),
    { key: 'lage', label: 'Lage (Ansichtsfilter)', group: GROUPS.rebar, type: 'select', options: LAGEN, get: (e) => e.lage ?? '', set: (_e, v) => ({ lage: v || undefined }) },
    { key: 'ldir', label: 'Richtung (Ansichtsfilter)', group: GROUPS.rebar, type: 'select', options: [['', 'automatisch'], ['x', 'x'], ['y', 'y'], ['z', 'vertikal']], get: (e) => e.ldir ?? '', set: (_e, v) => ({ ldir: v || undefined }) },
    { key: 'rclass', label: 'Erkannte Lage', group: GROUPS.rebar, type: 'readonly', get: (e, d) => lbl(rebarClass(d, e as Rebar)) },
    { key: 'distDim', label: 'Masskette Verlegebereich', group: GROUPS.graphics, type: 'bool', get: (e) => !!e.distDim, set: (_e, v) => ({ distDim: v || undefined }) },
  ];
}

// ------------------------------------------------------------ Eigenschaften: Ansicht
type ViewPropFn = (v: View, doc: Doc) => PropDef[];
const viewPropFns: ViewPropFn[] = [];
let viewWrapped = false;
/** Zusätzliche Ansichtseigenschaften des Tragwerksmoduls (Kern und andere Module bleiben erhalten) */
export function addViewProps(fn: ViewPropFn): void { viewPropFns.push(fn); installViewProps(); }
function installViewProps(): void {
  const d = catDef('view'); if (!d || viewWrapped) return;
  viewWrapped = true;
  const base = d.props;
  d.props = (el, doc) => [...(base ? base(el, doc) : []), ...viewPropFns.flatMap((f) => f(el as View, doc))];
}
onHook('started', installViewProps);

const filterPatch = (e: El, k: keyof RebarFilter, v: any): Partial<El> => ({ data: { ...(e.data ?? {}), rebarFilter: { ...(e.data?.rebarFilter ?? {}), [k]: v || undefined } } });
export const planOptions = (doc: Doc): [string, string][] => [['', 'Alle'], ...rebarPlans(doc).filter((p) => p).map((p) => [p, p] as [string, string])];
addViewProps((v) => {
  if (!isPlanLike(v) && !isSectionLike(v)) return [];
  const g = 'Bewehrung';
  return [
    { key: 'rfLayer', label: 'Bewehrungslage', group: g, type: 'select', options: LAYER_FILTERS, get: (e) => filterOf(e as View).layer ?? '', set: (e, x) => filterPatch(e, 'layer', x) },
    { key: 'rfDir', label: 'Stabrichtung', group: g, type: 'select', options: DIR_FILTERS, get: (e) => filterOf(e as View).dir ?? '', set: (e, x) => filterPatch(e, 'dir', x) },
    { key: 'rfPlan', label: 'Nur Bewehrungsplan', group: g, type: 'select', options: planOptions, get: (e) => filterOf(e as View).plan ?? '', set: (e, x) => filterPatch(e, 'plan', x) },
    { key: 'rfDims', label: 'Masskette Verlegebereich (alle Sätze)', group: g, type: 'bool', get: (e) => !!filterOf(e as View).dims, set: (e, x) => filterPatch(e, 'dims', !!x) },
  ];
});
