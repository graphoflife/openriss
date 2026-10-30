// Einfache, versionsgebundene Caches für abgeleitete Daten (werden bei jeder Änderung verworfen).
import type { Doc, El, Id } from './doc';

const caches = new Map<string, { ver: number; map: Map<string, any> }>();

export function cached<T>(doc: Doc, space: string, key: string, fn: () => T): T {
  let c = caches.get(space);
  if (!c || c.ver !== doc.version) { c = { ver: doc.version, map: new Map() }; caches.set(space, c); }
  if (c.map.has(key)) return c.map.get(key);
  const v = fn();
  c.map.set(key, v);
  return v;
}

/** Index: Host-ID → gehostete Elemente */
export function hostedIndex(doc: Doc): Map<Id, El[]> {
  return cached(doc, 'hosted', '', () => {
    const m = new Map<Id, El[]>();
    for (const e of doc.all()) {
      if (!e.hostId) continue;
      let l = m.get(e.hostId); if (!l) { l = []; m.set(e.hostId, l); } l.push(e);
    }
    return m;
  });
}
export function hostedBy(doc: Doc, id: Id): El[] { return hostedIndex(doc).get(id) ?? []; }
