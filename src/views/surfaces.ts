// Gemeinsame Flächenabfrage: Ober-/Unterseite flächiger Bauteile (Decke, Platte, Dach, Gelände) als Funktion
// der Lage. Grundlage für geneigte Decken/Rampen (Anschlüsse von Wänden, Koten, Einlagen, Leitungen …).
import type { Doc, El } from '../core/doc';
import type { V2 } from '../core/geom';
import { catDef, Surface } from '../core/registry';
import { cached } from '../core/cache';

/** Fläche eines Elements (null, wenn die Kategorie keine Fläche kennt) */
export function surfaceOf(doc: Doc, el: El | undefined | null): Surface | null {
  if (!el) return null;
  const calc = (): Surface | null => {
    const d = catDef(el.cat);
    try { return d?.surface?.(el, doc) ?? null; } catch (e) { console.warn('Flächenfehler', el.cat, e); return null; }
  };
  return !el.id || el.id.startsWith('__') ? calc() : cached(doc, 'surface', el.id, calc);
}

/** Ebene Fläche mit konstanten Höhen */
export function flatSurface(top: number, bot: number): Surface {
  return { topAt: () => top, botAt: () => bot, zMin: bot, zMax: top, flat: true };
}

/** Oberseite im Punkt p (Rückfall: Wert für ebene Bauteile) */
export const topAt = (doc: Doc, el: El, p: V2, fallback: number): number => surfaceOf(doc, el)?.topAt(p) ?? fallback;
/** Unterseite im Punkt p */
export const botAt = (doc: Doc, el: El, p: V2, fallback: number): number => surfaceOf(doc, el)?.botAt(p) ?? fallback;
