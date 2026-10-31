// Gebäudeansichten an die Modellausdehnung anpassen (Vorlage liegt um ein 12 × 9 m-Haus).
import type { Doc } from '../core/doc';
import { catDef } from '../core/registry';
import { View, levels } from '../core/view';
import { V2, emptyBox, extendBox, boxValid } from '../core/geom';
import { solidsOf } from './sectionEngine';

/** Liegen die Ansichtssymbole noch an den Positionen der Projektvorlage? */
export function elevationsAtTemplate(doc: Doc): boolean {
  const T: Record<string, [number, number]> = { 'Süd': [5000, -6000], 'Nord': [5000, 16000], 'Ost': [18000, 5000], 'West': [-8000, 5000] };
  const els = doc.all<View>('view').filter((v) => v.kind === 'elevation');
  return els.length > 0 && els.every((v) => T[v.name] && v.origin && Math.abs(v.origin.x - T[v.name][0]) < 1 && Math.abs(v.origin.y - T[v.name][1]) < 1);
}

/** Gebäudeansichten (Süd/Nord/Ost/West) um die Modellausdehnung legen, Zuschnitt und Tiefe anpassen */
export function fitElevationsTo(doc: Doc, margin = 6000): void {
  const b = emptyBox();
  for (const e of doc.all()) {
    // Gelände und Aushub (Grundstück) zählen nicht zur Gebäudeausdehnung
    if (e.viewId || e.cat === 'view' || e.cat === 'grid' || e.cat === 'level' || !catDef(e.cat)?.solids || catDef(e.cat)?.ifcSite || e.cat === 'topo' || e.cat === 'excavation') continue;
    try { for (const s of solidsOf(doc, e)) for (const f of s.faces) for (const p of f.pts) extendBox(b, p); } catch { /* */ }
  }
  if (!boxValid(b)) return;
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
  const ls = levels(doc); const z0 = (ls[0]?.elev ?? 0) - 2000, z1 = (ls[ls.length - 1]?.elev ?? 3000) + 5000;
  const hw = (b.max.x - b.min.x) / 2 + 3000, hh = (b.max.y - b.min.y) / 2 + 3000;
  const pos: Record<string, [V2, V2, number]> = {
    'Süd': [{ x: cx, y: b.min.y - margin }, { x: 0, y: 1 }, hw], 'Nord': [{ x: cx, y: b.max.y + margin }, { x: 0, y: -1 }, hw],
    'Ost': [{ x: b.max.x + margin, y: cy }, { x: -1, y: 0 }, hh], 'West': [{ x: b.min.x - margin, y: cy }, { x: 1, y: 0 }, hh],
  };
  doc.transaction('Ansichten anpassen', () => {
    for (const v of doc.all<View>('view')) {
      const p = v.kind === 'elevation' ? pos[v.name] : undefined; if (!p) continue;
      doc.update(v.id, { origin: { x: p[0].x, y: p[0].y, z: 0 }, dir: p[1], far: margin * 2 + Math.max(b.max.x - b.min.x, b.max.y - b.min.y),
        crop: { on: true, show: false, min: { x: -p[2], y: z0 }, max: { x: p[2], y: z1 } } } as any);
    }
  });
}

