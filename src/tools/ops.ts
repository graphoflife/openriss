// Gemeinsame Bearbeitungsoperationen (Transformieren, Kopieren …) für Werkzeuge.
import { app } from '../app';
import type { Id, El } from '../core/doc';
import { catDef } from '../core/registry';
import { Mat2, V2, translation, apply, add3, mul3, emptyBox, extendBox, BBox, boxValid } from '../core/geom';
import { View, isPlanLike, isSectionLike, makeProjector, annoIn } from '../core/view';

/** Wendet eine 2D-Transformation (in Ansichtskoordinaten) auf Elemente an. In Transaktion aufrufen. */
export function transformElements(ids: Iterable<Id>, m: Mat2, view: View): number {
  const doc = app.doc;
  const set = new Set(ids);
  let n = 0;
  const pr = isSectionLike(view) ? makeProjector(view) : null;
  for (const id of set) {
    const el = doc.get(id);
    if (!el || el.pinned) continue;
    // gehostete Elemente folgen ihrem Host
    if (el.hostId && set.has(el.hostId)) continue;
    const def = catDef(el.cat);
    if (!def) continue;
    let patch: Partial<El> | void = undefined;
    const annotationHere = annoIn(doc, el, view);
    if (annotationHere || isPlanLike(view) || view.kind === 'sheet' || view.kind === 'drafting' || view.kind === 'legend') {
      patch = def.transform?.(el, m, doc, view);
    } else if (pr && def.translate3d) {
      // nur Verschiebung in Schnitt/Ansicht
      const d2 = { x: m.e, y: m.f };
      const d3 = add3(mul3(pr.right, d2.x), mul3(pr.up, d2.y));
      patch = def.translate3d(el, d3, doc);
    } else if (pr && def.transform) {
      patch = def.transform(el, m, doc, view);
    }
    if (patch) { doc.update(id, patch); n++; }
  }
  return n;
}

export function moveElements(ids: Iterable<Id>, d: V2, view: View): number { return transformElements(ids, translation(d.x, d.y), view); }

/** Elemente kopieren und transformieren. Liefert neue IDs. In Transaktion aufrufen. */
export function copyTransform(ids: Id[], m: Mat2, view: View): Id[] {
  const map = app.duplicate(ids.filter((id) => app.doc.get(id)?.cat !== 'view'));
  const newIds = [...map.values()];
  transformElements(newIds, m, view);
  return ids.map((id) => map.get(id)).filter(Boolean) as Id[];
}

/** Mittelpunkt einer Auswahl in der Ansicht (für Drehen) */
export function selectionCenter(ids: Iterable<Id>, view: View, vp?: any): V2 | null {
  const b: BBox = emptyBox();
  const dl = vp?.displayList?.();
  const set = new Set(ids);
  if (dl) {
    for (let i = 0; i < dl.items.length; i++) {
      const it = dl.items[i]; if (!it.o || !set.has(it.o) || it.sel) continue;
      const bb = dl.boxOf(i); if (bb) { extendBox(b, bb.min); extendBox(b, bb.max); }
    }
  }
  if (!boxValid(b)) {
    for (const id of set) {
      const el = app.doc.get(id); const c = el && catDef(el.cat)?.center?.(el, app.doc, view);
      if (c) extendBox(b, c);
    }
  }
  return boxValid(b) ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 } : null;
}

export function selectionOrPrompt(): Id[] | null {
  const ids = [...app.selection];
  return ids.length ? ids : null;
}

export { apply };
