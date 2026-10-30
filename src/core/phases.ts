// Phasen für Umbauplanung: Bestand, Neubau, Abbruch. Darstellung nach deutscher Bauantragskonvention
// (Bestand grau, Abbruch gelb gestrichelt, Neubau rot) oder gefiltert (nur Bestand / nur Planung).
import type { Doc, El } from './doc';
import type { View } from './view';
import type { DisplayList, Prim } from '../render/displayList';
import type { PropDef } from './registry';

export type Phase = 'existing' | 'new' | 'demolished';
export const PHASE_LABELS: [Phase, string][] = [['new', 'Neubau'], ['existing', 'Bestand'], ['demolished', 'Bestand – Abbruch']];
export type PhaseMode = 'all' | 'permit' | 'existingOnly' | 'planned';
export const PHASE_MODES: [PhaseMode, string][] = [
  ['all', 'Alles anzeigen'], ['permit', 'Bauantrag (Bestand grau, Abbruch gelb, Neubau rot)'],
  ['existingOnly', 'Bestand (vor Umbau)'], ['planned', 'Planung (ohne Abbruch)'],
];
export const phaseOf = (el: El): Phase => (el.phase as Phase) ?? 'new';

const COLORS: Record<Phase, string> = { existing: '#9a9a9a', new: '#e02020', demolished: '#f2d200' };

/** Sichtbarkeit nach Phasenfilter */
export function phaseVisible(el: El, view: View): boolean {
  const m = (view.phaseMode as PhaseMode) ?? 'all';
  const p = phaseOf(el);
  if (m === 'existingOnly') return p !== 'new';
  if (m === 'planned') return p !== 'demolished';
  return true;
}

/** Display-Liste nach Phase einfärben (nur Bauantragsdarstellung) */
export function applyPhaseGraphics(doc: Doc, view: View, dl: DisplayList): void {
  if (view.phaseMode !== 'permit') return;
  const cache = new Map<string, Phase | null>();
  const ph = (id: string | null | undefined): Phase | null => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id)!;
    const el = doc.get(id);
    const r = el && !el.viewId && el.cat !== 'view' && el.cat !== 'level' && el.cat !== 'grid' ? phaseOf(el) : null;
    cache.set(id, r); return r;
  };
  for (const it of dl.items as Prim[]) {
    const p = ph(it.o);
    if (!p) continue;
    if (it.k === 'fill') {
      const isCut = !!it.fill.pattern || (it.fill.color && it.fill.color !== '#ffffff' && it.fill.color !== 'transparent');
      if (isCut && it.fill.color !== 'transparent') it.fill = { color: COLORS[p], pattern: p === 'existing' ? it.fill.pattern : undefined, patColor: '#000000' };
    }
    if (p === 'demolished' && 'pen' in it && it.pen) it.pen = { ...it.pen, dash: 'dash' };
  }
}

export function phaseProps(): PropDef[] {
  return [{
    key: 'phase', label: 'Phase', group: 'Phasen', type: 'select', options: PHASE_LABELS as [string, string][],
    get: (e) => phaseOf(e), set: (_e, v) => ({ phase: v === 'new' ? undefined : v }),
  }];
}

// ------------------------------------------------------------ Grafiken in Ansicht überschreiben
export interface GraphicOverride { color?: string; w?: number; halftone?: boolean; fillColor?: string; dash?: string }

/** Überschreibungen nach Kategorie (VV) und Element (Grafiken überschreiben) anwenden */
export function applyOverrides(doc: Doc, view: View, dl: DisplayList): void {
  const byCat = (view.catOverrides ?? {}) as Record<string, GraphicOverride>;
  const byEl = (view.elOverrides ?? {}) as Record<string, GraphicOverride>;
  if (!Object.keys(byCat).length && !Object.keys(byEl).length) return;
  const cache = new Map<string, GraphicOverride | null>();
  const ov = (id: string | null | undefined): GraphicOverride | null => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id)!;
    const el = doc.get(id);
    const c = el ? byCat[el.cat] : undefined; const e = byEl[id];
    const r = c || e ? { ...(c ?? {}), ...(e ?? {}) } : null;
    cache.set(id, r); return r;
  };
  for (const it of dl.items as Prim[]) {
    const o = ov(it.o); if (!o) continue;
    if (o.halftone) it.ht = true;
    if ('pen' in it && it.pen) it.pen = { ...it.pen, ...(o.color ? { color: o.color } : {}), ...(o.w ? { w: o.w } : {}), ...(o.dash ? { dash: o.dash as any } : {}) };
    if (it.k === 'fill' && o.fillColor && it.fill.color !== 'transparent') it.fill = { color: o.fillColor, pattern: 'solid', patColor: o.fillColor };
    if (it.k === 'text' && o.color) it.font = { ...it.font, color: o.color };
  }
}
