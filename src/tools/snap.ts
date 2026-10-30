// Objektfang: Endpunkte, Mittelpunkte, Schnittpunkte, Lot, Nächster, Zentrum;
// ohne Treffer Winkel- (15°-Schritte) und Längenrundung relativ zum Basispunkt.
import { V2, dist, sub, add, mul, fromAngle, angleOf } from '../core/geom';
import { DisplayList, snapCandidates, SnapCand } from '../render/displayList';
import { app } from '../app';

export interface SnapResult { p: V2; kind: string; label: string; guide?: { a: V2; b: V2 } }

const LABEL: Record<string, string> = {
  end: 'Endpunkt', mid: 'Mittelpunkt', int: 'Schnittpunkt', center: 'Zentrum', quad: 'Quadrant',
  near: 'Nächster', perp: 'Lotrecht', angle: 'Winkel', length: 'Länge', point: 'Punkt',
};
const PRIORITY: Record<string, number> = { end: 0, int: 0, center: 1, quad: 1, mid: 1, perp: 2, near: 4, point: 0 };

/** Fangpunkt berechnen. pxPerMm: Bildschirmpixel je Ansichts-mm. */
export function computeSnap(dl: DisplayList | null, raw: V2, pxPerMm: number, from: V2 | null, opts: { shift?: boolean; extra?: SnapCand[] } = {}): SnapResult | null {
  const s = app.settings;
  const override = app.snapOverride;
  const enabled = s.snaps && override !== 'off';
  const r = 10 / pxPerMm; // 10 px Fangradius
  if (enabled && dl) {
    const cands = [...snapCandidates(dl, raw, r, from), ...(opts.extra ?? [])].filter((c) => {
      if (override && override !== 'off') return c.kind === override || (override === 'end' && c.kind === 'point');
      return s.snapKinds[c.kind] !== false;
    });
    let best: SnapCand | null = null; let bs = Infinity;
    for (const c of cands) {
      const d = dist(c.p, raw);
      if (d > r) continue;
      const score = d * pxPerMm + (PRIORITY[c.kind] ?? 3) * 4;
      if (score < bs) { bs = score; best = c; }
    }
    if (best) return { p: best.p, kind: best.kind, label: LABEL[best.kind] ?? best.kind };
  }
  if (from && !opts.shift && s.snapKinds.angle !== false && enabled) {
    // Winkelfang auf 15°-Schritte, Längenrundung je nach Zoom
    const v = sub(raw, from); const L = Math.hypot(v.x, v.y);
    if (L * pxPerMm < 5) return null;
    const ang = angleOf(v); const step = Math.PI / 12;
    const snapped = Math.round(ang / step) * step;
    const devPx = Math.abs(Math.sin(ang - snapped)) * L * pxPerMm;
    if (devPx < 8) {
      const inc = niceIncrement(pxPerMm);
      const Lr = s.snapKinds.length !== false ? Math.max(inc, Math.round(L / inc) * inc) : L;
      const p = add(from, fromAngle(snapped, Lr));
      return { p, kind: 'angle', label: Math.round((snapped * 180) / Math.PI) + '°', guide: { a: from, b: add(from, fromAngle(snapped, Math.max(Lr, L) * 4)) } };
    }
  }
  if (from && opts.shift) {
    // Orthogonal erzwingen
    const v = sub(raw, from);
    const p = Math.abs(v.x) > Math.abs(v.y) ? { x: raw.x, y: from.y } : { x: from.x, y: raw.y };
    return { p, kind: 'angle', label: 'Orthogonal' };
  }
  return null;
}

/** Sinnvolle Rundung je Zoomstufe (etwa 6 px) */
export function niceIncrement(pxPerMm: number): number {
  const target = 6 / pxPerMm;
  const steps = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  for (const st of steps) if (st >= target) return st;
  return 10000;
}

export function snapMarkerPath(kind: string): string { return kind; }
export { mul };
