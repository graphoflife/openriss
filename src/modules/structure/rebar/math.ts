// Bewehrung – reine Geometrie/Mathematik (ohne App-Abhängigkeiten, in Node testbar):
// Biegerollen nach DIN EN 1992-1-1/NA, Haken, Ausrundung der Schenkelpolylinie, Längen, Gewichte,
// Verlegeregeln und das Einpassen der Biegeformen in ein Schnittpolygon (abzüglich Betondeckung).
import {
  V2, V3, add, sub, mul, norm, perp, dot, dist, distToSeg, closestOnSeg, signedArea, cross, offsetPolyline, pointInRing,
  add3, sub3, mul3, dot3, len3, norm3, lineLine,
} from '../../../core/geom';

export const DIAS = [6, 8, 10, 12, 14, 16, 20, 25, 28, 32];
/** Gewicht je m in kg (7850 kg/m³): 0,00617 · Ø² */
export const kgPerM = (d: number) => 0.00617 * d * d;
/** Biegerollendurchmesser dm (Haken, Winkelhaken, Bügel): Ø < 20 → 4Ø, sonst 7Ø */
export const mandrel = (d: number) => (d < 20 ? 4 : 7) * d;
/** Biegeradius der Stabachse */
export const bendR = (d: number) => mandrel(d) / 2 + d / 2;
/** gerades Hakenende nach dem Bogen (DIN EN 1992-1-1 Bild 8.5DE) */
export function hookExt(ang: number, d: number): number {
  if (ang >= 120) return Math.max(5 * d, 50);   // Haken 135°/180°
  return Math.max(10 * d, 70);                  // Winkelhaken 90°
}

// ------------------------------------------------------------ Haken
/** Hakenpunkte ab Stabende E (t: Richtung nach außen, n: Biegerichtung) */
export function hookPts(E: V3, t: V3, n: V3, ang: number, d: number): V3[] {
  const r = bendR(d), e = hookExt(ang, d);
  if (ang >= 179) {
    const P1 = add3(E, mul3(n, 2 * r));
    return [P1, add3(P1, mul3(t, -(r + e)))];
  }
  const a = (ang * Math.PI) / 180;
  const h = add3(mul3(t, Math.cos(a)), mul3(n, Math.sin(a)));
  return [add3(E, mul3(h, r * Math.tan(a / 2) + e))];
}

export interface BarShape { pts: V3[]; dia: number; hookA?: number; hookB?: number; hookNA?: V3; hookNB?: V3 }
/** Vollständige Eckpunkt-Polylinie inkl. Haken */
export function fullPolyline(s: BarShape): V3[] {
  const pts = s.pts; const m = pts.length;
  if (m < 2) return pts.slice();
  const out = pts.slice();
  if (s.hookA && s.hookNA) {
    const t = norm3(sub3(pts[0], pts[1]));
    out.unshift(...hookPts(pts[0], t, s.hookNA, s.hookA, s.dia).reverse());
  }
  if (s.hookB && s.hookNB) {
    const t = norm3(sub3(pts[m - 1], pts[m - 2]));
    out.push(...hookPts(pts[m - 1], t, s.hookNB, s.hookB, s.dia));
  }
  return out;
}

// ------------------------------------------------------------ Ausrundung
export interface Filleted { path: V3[]; len: number; straight: number; arcs: number }
/** Ecken mit Radius r ausrunden; liefert Pfad und exakte Achslänge */
export function fillet(pts: V3[], r: number, segPer90 = 4): Filleted {
  const n = pts.length;
  const segLen: number[] = [];
  for (let i = 0; i + 1 < n; i++) segLen.push(len3(sub3(pts[i + 1], pts[i])));
  if (n < 3 || r <= 0) { const L = segLen.reduce((s, x) => s + x, 0); return { path: pts.slice(), len: L, straight: L, arcs: 0 }; }
  const T = new Array(n).fill(0), th = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (segLen[i - 1] < 1e-6 || segLen[i] < 1e-6) continue;
    const din = norm3(sub3(pts[i], pts[i - 1])), dout = norm3(sub3(pts[i + 1], pts[i]));
    const c = Math.max(-1, Math.min(1, dot3(din, dout)));
    const a = Math.acos(c);
    if (a < 1e-4 || a > Math.PI - 1e-3) continue;
    th[i] = a; T[i] = r * Math.tan(a / 2);
  }
  // Tangentenlängen begrenzen (kurze Schenkel)
  for (let i = 0; i + 1 < n; i++) {
    const s = T[i] + T[i + 1];
    if (s > segLen[i] && s > 0) { const f = segLen[i] / s; if (i > 0) T[i] *= f; if (i + 1 < n - 1) T[i + 1] *= f; }
  }
  const path: V3[] = [pts[0]];
  let arcs = 0;
  for (let i = 1; i < n - 1; i++) {
    if (!th[i] || T[i] < 1e-6) { path.push(pts[i]); continue; }
    const din = norm3(sub3(pts[i], pts[i - 1])), dout = norm3(sub3(pts[i + 1], pts[i]));
    const ri = T[i] / Math.tan(th[i] / 2);
    const A = sub3(pts[i], mul3(din, T[i])), B = add3(pts[i], mul3(dout, T[i]));
    const bis = norm3(sub3(dout, din));
    const C = add3(pts[i], mul3(bis, ri / Math.cos(th[i] / 2)));
    const va = sub3(A, C), vb = sub3(B, C);
    const k = Math.max(2, Math.ceil((th[i] / (Math.PI / 2)) * segPer90));
    const s0 = Math.sin(th[i]);
    for (let j = 0; j <= k; j++) {
      const u = j / k;
      const p = s0 < 1e-9 ? A : add3(C, add3(mul3(va, Math.sin((1 - u) * th[i]) / s0), mul3(vb, Math.sin(u * th[i]) / s0)));
      path.push(p);
    }
    arcs += ri * th[i];
  }
  path.push(pts[n - 1]);
  let straight = 0;
  for (let i = 0; i + 1 < n; i++) straight += Math.max(0, segLen[i] - T[i] - T[i + 1]);
  return { path, len: straight + arcs, straight, arcs };
}

/** Schenkellängen (Außenmaße: Achsmaß zwischen Eckpunkten + Ø/2 je gebogenem Ende) */
export function legLengths(full: V3[], d: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < full.length; i++) {
    let L = len3(sub3(full[i + 1], full[i]));
    if (i > 0) L += d / 2;
    if (i + 1 < full.length - 1) L += d / 2;
    out.push(L);
  }
  return out;
}

// ------------------------------------------------------------ Verlegung
export type Layout = 'single' | 'count' | 'maxSpacing' | 'countSpacing';
export const LAYOUT_LABELS: [Layout, string][] = [['single', 'Einzeln'], ['count', 'Feste Anzahl'], ['maxSpacing', 'Maximaler Abstand'], ['countSpacing', 'Anzahl mit Abstand']];
/** Abstände der Stäbe vom ersten Stab entlang der Verteilrichtung */
export function layoutOffsets(layout: Layout, count: number, spacing: number, span: number): number[] {
  span = Math.max(0, span);
  switch (layout) {
    case 'single': return [0];
    case 'count': {
      const n = Math.max(1, Math.round(count));
      if (n === 1) return [0];
      return Array.from({ length: n }, (_, i) => (i * span) / (n - 1));
    }
    case 'maxSpacing': {
      const s = Math.max(10, spacing);
      const n = Math.max(1, Math.ceil(span / s - 1e-6) + 1);
      if (n === 1 || span < 1) return [0];
      return Array.from({ length: n }, (_, i) => (i * span) / (n - 1));
    }
    case 'countSpacing': {
      const n = Math.max(1, Math.round(count)); const s = Math.max(1, spacing);
      return Array.from({ length: n }, (_, i) => i * s);
    }
  }
}

// ------------------------------------------------------------ Polygon-Hilfen (2D)
/** doppelte und kollineare Punkte entfernen, gegen den Uhrzeigersinn ausrichten */
export function cleanRing(r0: V2[]): V2[] {
  let r = r0.filter((p, i) => dist(p, r0[(i + 1) % r0.length]) > 0.5);
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const d1 = norm(sub(b, a)), d2 = norm(sub(c, b));
      if (Math.abs(cross(d1, d2)) < 2e-3 && dot(d1, d2) > 0) { r = r.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  return signedArea(r) < 0 ? r.slice().reverse() : r;
}

/** Ring um d nach innen versetzen (Ring gegen den Uhrzeigersinn); null, wenn er zusammenfällt */
export function insetRing(r: V2[], d: number): V2[] | null {
  if (r.length < 3) return null;
  const o = offsetPolyline(r, d, true);
  const a0 = signedArea(r), a1 = signedArea(o);
  if (a1 <= 1 || a1 >= a0) return null;
  return o;
}

const nearestEdge = (r: V2[], p: V2): number => {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < r.length; i++) { const d = distToSeg(p, r[i], r[(i + 1) % r.length]); if (d < bd) { bd = d; bi = i; } }
  return bi;
};
const nearestCorner = (r: V2[], p: V2): number => {
  let bi = 0, bd = Infinity;
  r.forEach((q, i) => { const d = dist(p, q); if (d < bd) { bd = d; bi = i; } });
  return bi;
};

export type FitKind = '00' | '11' | '21' | '51' | 'L';
export interface Fit2 {
  /** Schenkelpolylinie (Ansichtskoordinaten) */
  pts: V2[];
  /** Hakenrichtung (ins Bauteilinnere) an Anfang/Ende */
  nA: V2; nB: V2;
  /** nur Längsstäbe: Verteilung in der Ansichtsebene */
  ldir?: V2; lspan?: number;
}

/**
 * Biegeform in den (inneren) Ring einpassen.
 * off = Abstand Bauteilrand → Stabachse; legLen = Schenkellänge (0 = bis zur nächsten Ecke).
 */
export function fitShape(kind: FitKind, ring0: V2[], click: V2, off: number, legLen = 0, single = false): Fit2 | null {
  const ring = cleanRing(ring0);
  const R = insetRing(ring, off);
  if (!R) return null;
  const n = R.length;
  const P = (i: number) => R[((i % n) + n) % n];
  const e = (i: number) => norm(sub(P(i + 1), P(i)));     // Kante i → i+1
  const leg = (from: V2, to: V2) => { const full = dist(from, to); const L = legLen > 0 ? Math.min(legLen, full) : full; return add(from, mul(norm(sub(to, from)), L)); };
  switch (kind) {
    case '00': {
      const i = nearestEdge(R, click);
      return { pts: [P(i), P(i + 1)], nA: perp(e(i)), nB: perp(e(i)) };
    }
    case '11': {
      const k = nearestCorner(R, click);
      return { pts: [leg(P(k), P(k - 1)), P(k), leg(P(k), P(k + 1))], nA: perp(e(k - 1)), nB: perp(e(k)) };
    }
    case '21': {
      const i = nearestEdge(R, click);
      return { pts: [leg(P(i), P(i - 1)), P(i), P(i + 1), leg(P(i + 1), P(i + 2))], nA: perp(e(i - 1)), nB: perp(e(i + 1)) };
    }
    case '51': {
      const k = nearestCorner(R, click);
      const pts: V2[] = [];
      for (let j = 0; j <= n; j++) pts.push(P(k + j));
      return { pts, nA: perp(e(k)), nB: perp(e(k - 1)) };
    }
    case 'L': {
      const i = nearestEdge(R, click);
      if (single) {
        let best = P(i), bd = Infinity;
        for (let j = 0; j < n; j++) { const q = closestOnSeg(click, P(j), P(j + 1)); const d = dist(q, click); if (d < bd) { bd = d; best = q; } }
        return { pts: [best], nA: { x: 0, y: 0 }, nB: { x: 0, y: 0 } };
      }
      return { pts: [P(i)], nA: { x: 0, y: 0 }, nB: { x: 0, y: 0 }, ldir: e(i), lspan: dist(P(i), P(i + 1)) };
    }
  }
}

/** Normale zu Segment a→b, die ins Innere des Rings zeigt */
export function inwardNormal(a: V2, b: V2, ring: V2[], fallback?: V2): V2 {
  const n = perp(norm(sub(b, a)));
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const s of [5, 20, 60]) {
    if (pointInRing(add(m, mul(n, s)), ring)) return n;
    if (pointInRing(add(m, mul(n, -s)), ring)) return mul(n, -1);
  }
  if (fallback) return dot(n, sub(fallback, m)) >= 0 ? n : mul(n, -1);
  return n;
}

/** Gerade durch p in Richtung u mit Ring schneiden; liefert das Stück, das p enthält (oder das nächste) */
export function chordThrough(ring: V2[], p: V2, u: V2): [V2, V2] | null {
  const ts: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const x = lineLine(p, add(p, u), a, b);
    if (x && x.u >= -1e-9 && x.u <= 1 + 1e-9) ts.push(x.t);
  }
  ts.sort((a, b) => a - b);
  const uniq = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-6);
  let best: [number, number] | null = null; let bd = Infinity;
  for (let i = 0; i + 1 < uniq.length; i++) {
    const m = (uniq[i] + uniq[i + 1]) / 2;
    if (!pointInRing(add(p, mul(u, m)), ring)) continue;
    const d = uniq[i] <= 0 && uniq[i + 1] >= 0 ? 0 : Math.min(Math.abs(uniq[i]), Math.abs(uniq[i + 1]));
    if (d < bd) { bd = d; best = [uniq[i], uniq[i + 1]]; }
  }
  return best ? [add(p, mul(u, best[0])), add(p, mul(u, best[1]))] : null;
}

/** Signatur gleicher Stäbe (für Positionsnummern) */
export function barSignature(dia: number, full: V3[], code: string): string {
  const legs = legLengths(full, dia).map((l) => Math.round(l / 10));
  // Biegewinkel (gerundet) gehören zur Form
  const angs: number[] = [];
  for (let i = 1; i + 1 < full.length; i++) {
    const a = norm3(sub3(full[i], full[i - 1])), b = norm3(sub3(full[i + 1], full[i]));
    angs.push(Math.round((Math.acos(Math.max(-1, Math.min(1, dot3(a, b)))) * 180) / Math.PI / 5) * 5);
  }
  const f = legs.join(',') + '|' + angs.join(','), r = legs.slice().reverse().join(',') + '|' + angs.slice().reverse().join(',');
  return `${dia}|${code}|${f < r ? f : r}`;
}
