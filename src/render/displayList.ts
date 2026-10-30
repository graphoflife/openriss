// Display-Liste: Jede Ansicht wird in eine Liste einfacher 2D-Grundelemente (in Ansichts-mm)
// übersetzt. Dieselbe Liste wird für Bildschirm (Canvas), SVG/PDF, DXF, Treffertest (Auswahl)
// und Objektfang verwendet. Jedes Grundelement kennt sein Eigentümer-Element (o).
import {
  V2, BBox, Mat2, apply, dist, distToSeg, closestOnSeg, segSeg, emptyBox, extendBox, pointInRing,
  boxOverlap, boxContains, matScale, arcPoints, normAngle, fromAngle, add, mid, sub, len, matAngle, isMirror,
} from '../core/geom';
import type { Pen, Fill } from './styles';
import type { Id } from '../core/doc';

export interface Font {
  size: number;            // Papier-mm
  rot?: number;            // rad, im Ansichtskoordinatensystem
  ha?: 'left' | 'center' | 'right';
  va?: 'top' | 'middle' | 'bottom' | 'baseline';
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  family?: string;
  /** Hintergrund abdecken (wie "Hintergrund: Undurchsichtig") */
  opaque?: boolean;
  box?: boolean;
}

interface PBase {
  o?: Id | null;      // Eigentümer
  ns?: boolean;       // kein Objektfang
  sel?: boolean;      // nur sichtbar, wenn markiert (z.B. Raum-Kreuz)
  sub?: string;       // Unterreferenz (z.B. "face:l") für Ausrichten/Bemaßen
  ht?: boolean;       // Halbton
  inv?: boolean;      // unsichtbar (nur Fang/Treffer, z.B. Wandachse)
}
export type Prim =
  | (PBase & { k: 'line'; a: V2; b: V2; pen: Pen })
  | (PBase & { k: 'poly'; pts: V2[]; closed?: boolean; pen: Pen })
  | (PBase & { k: 'fill'; rings: V2[][]; fill: Fill; pen?: Pen })
  | (PBase & { k: 'arc'; c: V2; r: number; a0: number; a1: number; pen: Pen })
  | (PBase & { k: 'circle'; c: V2; r: number; pen?: Pen; fill?: Fill })
  | (PBase & { k: 'text'; p: V2; s: string; font: Font })
  | (PBase & { k: 'clip'; rings: V2[][] | null }) // Zuschneidebereich setzen/aufheben
  /** Rasterbild: p = linke untere Ecke, w/h in Ansichts-mm, rot (rad) um p, src = Daten-URL */
  | (PBase & { k: 'image'; p: V2; w: number; h: number; rot?: number; src: string; alpha?: number });

export class DisplayList {
  items: Prim[] = [];
  /** Maßstab der Ansicht (1:scale) – wird für Text-/Symbolgrößen benötigt */
  scale: number;
  owner: Id | null = null;
  halftone = false;
  noSnap = false;
  private boxes: (BBox | null)[] | null = null;

  constructor(scale = 100) { this.scale = scale; }

  /** Papier-mm in Ansichts-mm umrechnen */
  p(mm: number): number { return mm * this.scale; }

  begin(owner: Id | null): this { this.owner = owner; return this; }

  private push(pr: Prim): void {
    pr.o = pr.o === undefined ? this.owner : pr.o;
    if (this.halftone) pr.ht = true;
    if (this.noSnap) pr.ns = true;
    this.items.push(pr);
    this.boxes = null;
  }
  line(a: V2, b: V2, pen: Pen, extra: Partial<PBase> = {}): void { this.push({ k: 'line', a, b, pen, ...extra }); }
  poly(pts: V2[], pen: Pen, closed = false, extra: Partial<PBase> = {}): void { if (pts.length > 1) this.push({ k: 'poly', pts, closed, pen, ...extra }); }
  fill(rings: V2[][], fill: Fill, pen?: Pen, extra: Partial<PBase> = {}): void {
    const r = rings.filter((x) => x.length >= 3);
    if (r.length) this.push({ k: 'fill', rings: r, fill, pen, ...extra });
  }
  arc(c: V2, r: number, a0: number, a1: number, pen: Pen, extra: Partial<PBase> = {}): void { this.push({ k: 'arc', c, r, a0, a1, pen, ...extra }); }
  circle(c: V2, r: number, pen?: Pen, fill?: Fill, extra: Partial<PBase> = {}): void { this.push({ k: 'circle', c, r, pen, fill, ...extra }); }
  text(p: V2, s: string, font: Font, extra: Partial<PBase> = {}): void { if (s !== '') this.push({ k: 'text', p, s, font, ns: true, ...extra }); }
  clip(rings: V2[][] | null): void { this.push({ k: 'clip', rings, o: null, ns: true }); }
  /** Rasterbild; back = ganz nach hinten (unter alle bisherigen Grundelemente) */
  image(p: V2, w: number, h: number, src: string, rot = 0, extra: Partial<PBase> & { alpha?: number } = {}, back = false): void {
    this.push({ k: 'image', p, w, h, src, rot, ns: true, ...extra });
    if (back) this.items.unshift(this.items.pop()!);
  }

  append(other: DisplayList, xf?: Mat2): void {
    for (const it of other.items) this.items.push(xf ? transformPrim(it, xf) : it);
    this.boxes = null;
  }

  // ------------------------------------------------------------ Abfragen
  bbox(): BBox {
    const b = emptyBox();
    for (const it of this.items) { const bb = primBox(it, this.scale); if (bb) { extendBox(b, bb.min); extendBox(b, bb.max); } }
    return b;
  }
  private ensureBoxes(): (BBox | null)[] {
    if (!this.boxes) this.boxes = this.items.map((it) => primBox(it, this.scale));
    return this.boxes;
  }
  boxOf(i: number): BBox | null { return this.ensureBoxes()[i]; }

  /**
   * Treffertest. tol in Ansichts-mm. Liefert Eigentümer sortiert nach Priorität
   * (Kanten vor Flächen, kleinere Flächen vor größeren).
   */
  hit(p: V2, tol: number, filter?: (id: Id) => boolean): { id: Id; d: number; area: number; sub?: string }[] {
    const boxes = this.ensureBoxes();
    const best = new Map<Id, { id: Id; d: number; area: number; sub?: string }>();
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.o || it.k === 'clip') continue;
      const bb = boxes[i];
      if (bb && (p.x < bb.min.x - tol || p.x > bb.max.x + tol || p.y < bb.min.y - tol || p.y > bb.max.y + tol)) continue;
      if (filter && !filter(it.o)) continue;
      const r = primDist(it, p, this.scale);
      if (r === null) continue;
      let d = r.d; let area = r.area;
      if (d > tol) continue;
      if (r.inside) d = tol * 0.9; // Flächen haben schwächere Priorität als Kanten
      const prev = best.get(it.o);
      if (!prev || d < prev.d || (d === prev.d && area < prev.area)) best.set(it.o, { id: it.o, d, area, sub: it.sub });
    }
    return [...best.values()].sort((a, b) => a.d - b.d || a.area - b.area);
  }

  /** Alle Eigentümer, deren Geometrie vollständig (inside=true) bzw. teilweise im Rechteck liegt. */
  inBox(box: BBox, crossing: boolean): Set<Id> {
    const boxes = this.ensureBoxes();
    const touched = new Set<Id>(); const outside = new Set<Id>();
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]; const bb = boxes[i];
      if (!it.o || !bb || it.sel || it.inv) continue;
      const fully = boxContains(box, bb.min) && boxContains(box, bb.max);
      if (fully) touched.add(it.o);
      else if (crossing && boxOverlap(box, bb) && primCrossesBox(it, box, this.scale)) touched.add(it.o);
      else outside.add(it.o);
    }
    if (!crossing) for (const o of outside) touched.delete(o);
    return touched;
  }

  /** Segmente (für Fang, Ausrichten, Stutzen …) in der Nähe eines Punktes. */
  segmentsNear(p: V2, r: number): { a: V2; b: V2; o: Id | null; sub?: string; prim: Prim }[] {
    const boxes = this.ensureBoxes();
    const out: { a: V2; b: V2; o: Id | null; sub?: string; prim: Prim }[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]; const bb = boxes[i];
      if (it.ns || !bb) continue;
      if (p.x < bb.min.x - r || p.x > bb.max.x + r || p.y < bb.min.y - r || p.y > bb.max.y + r) continue;
      forEachSeg(it, (a, b) => { if (distToSeg(p, a, b) <= r) out.push({ a, b, o: it.o ?? null, sub: it.sub, prim: it }); });
    }
    return out;
  }
}

export function forEachSeg(it: Prim, cb: (a: V2, b: V2) => void): void {
  switch (it.k) {
    case 'line': cb(it.a, it.b); break;
    case 'poly': for (let i = 0; i + 1 < it.pts.length; i++) cb(it.pts[i], it.pts[i + 1]); if (it.closed && it.pts.length > 2) cb(it.pts[it.pts.length - 1], it.pts[0]); break;
    case 'fill': if (it.pen) for (const r of it.rings) for (let i = 0; i < r.length; i++) cb(r[i], r[(i + 1) % r.length]); break;
    default: break;
  }
}

export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[il.,:;|'!1]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-ZÄÖÜ]/.test(ch) ? 0.68 : 0.56;
  return w * size;
}
/** Eckpunkte des Textrahmens (Ansichts-mm) */
export function textBox(it: { p: V2; s: string; font: Font }, scale: number): V2[] {
  const lines = it.s.split('\n');
  const size = it.font.size * scale;
  const w = Math.max(...lines.map((l) => textWidth(l, size)));
  const lh = size * 1.25; const h = lh * lines.length - (lh - size);
  const ha = it.font.ha ?? 'left'; const va = it.font.va ?? 'baseline';
  const x0 = ha === 'left' ? 0 : ha === 'center' ? -w / 2 : -w;
  // y aufwärts positiv: Grundlinie bei 0, erste Zeile oben
  const yTop = va === 'top' ? 0 : va === 'middle' ? h / 2 : va === 'bottom' ? h : size;
  const corners = [{ x: x0, y: yTop - h }, { x: x0 + w, y: yTop - h }, { x: x0 + w, y: yTop }, { x: x0, y: yTop }];
  const rot = it.font.rot ?? 0; const c = Math.cos(rot), s = Math.sin(rot);
  return corners.map((q) => ({ x: it.p.x + q.x * c - q.y * s, y: it.p.y + q.x * s + q.y * c }));
}

function primBox(it: Prim, scale: number): BBox | null {
  const b = emptyBox();
  switch (it.k) {
    case 'line': extendBox(b, it.a); extendBox(b, it.b); break;
    case 'poly': for (const p of it.pts) extendBox(b, p); break;
    case 'fill': for (const r of it.rings) for (const p of r) extendBox(b, p); break;
    case 'arc': case 'circle': extendBox(b, { x: it.c.x - it.r, y: it.c.y - it.r }); extendBox(b, { x: it.c.x + it.r, y: it.c.y + it.r }); break;
    case 'text': for (const p of textBox(it, scale)) extendBox(b, p); break;
    case 'image': for (const p of imageCorners(it)) extendBox(b, p); break;
    case 'clip': return null;
  }
  return b;
}

/** Eckpunkte eines Bildes (Ansichts-mm, gegen Uhrzeigersinn ab linker unterer Ecke) */
export function imageCorners(it: { p: V2; w: number; h: number; rot?: number }): V2[] {
  const c = Math.cos(it.rot ?? 0), s = Math.sin(it.rot ?? 0);
  const P = (x: number, y: number) => ({ x: it.p.x + x * c - y * s, y: it.p.y + x * s + y * c });
  return [P(0, 0), P(it.w, 0), P(it.w, it.h), P(0, it.h)];
}

function onArc(ang: number, a0: number, a1: number): boolean {
  const s = normAngle(a1 - a0); const t = normAngle(ang - a0);
  return t <= s + 1e-9;
}

function primDist(it: Prim, p: V2, scale: number): { d: number; inside?: boolean; area: number } | null {
  switch (it.k) {
    case 'line': return { d: distToSeg(p, it.a, it.b), area: 0 };
    case 'poly': {
      let d = Infinity;
      for (let i = 0; i + 1 < it.pts.length; i++) d = Math.min(d, distToSeg(p, it.pts[i], it.pts[i + 1]));
      if (it.closed && it.pts.length > 2) d = Math.min(d, distToSeg(p, it.pts[it.pts.length - 1], it.pts[0]));
      return { d, area: 0 };
    }
    case 'fill': {
      let d = Infinity; let inside = false; let area = 0;
      for (let ri = 0; ri < it.rings.length; ri++) {
        const r = it.rings[ri];
        for (let i = 0; i < r.length; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % r.length]));
        if (pointInRing(p, r)) inside = !inside;
        if (ri === 0) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], q = r[(i + 1) % r.length]; s += a.x * q.y - q.x * a.y; } area = Math.abs(s / 2); }
      }
      if (inside) return { d: 0, inside: true, area };
      return { d, area };
    }
    case 'arc': {
      const ang = Math.atan2(p.y - it.c.y, p.x - it.c.x);
      if (onArc(ang, it.a0, it.a1)) return { d: Math.abs(dist(p, it.c) - it.r), area: 0 };
      const e0 = add(it.c, fromAngle(it.a0, it.r)), e1 = add(it.c, fromAngle(it.a1, it.r));
      return { d: Math.min(dist(p, e0), dist(p, e1)), area: 0 };
    }
    case 'circle': {
      const dc = dist(p, it.c);
      if (it.fill && dc <= it.r) return { d: 0, inside: true, area: Math.PI * it.r * it.r };
      return { d: Math.abs(dc - it.r), area: 0 };
    }
    case 'image': {
      const r = imageCorners(it);
      if (pointInRing(p, r)) return { d: 0, inside: true, area: it.w * it.h };
      let d = Infinity; for (let i = 0; i < 4; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % 4]));
      return { d, area: it.w * it.h };
    }
    case 'text': {
      const r = textBox(it, scale);
      if (pointInRing(p, r)) return { d: 0, area: 1 };
      let d = Infinity; for (let i = 0; i < 4; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % 4]));
      return { d, area: 1 };
    }
    default: return null;
  }
}

function primCrossesBox(it: Prim, box: BBox, scale: number): boolean {
  const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
  let hit = false;
  const test = (a: V2, b: V2) => {
    if (hit) return;
    if (boxContains(box, a) || boxContains(box, b)) { hit = true; return; }
    for (let i = 0; i < 4; i++) if (segSeg(a, b, corners[i], corners[(i + 1) % 4])) { hit = true; return; }
  };
  if (it.k === 'fill') {
    for (const r of it.rings) for (let i = 0; i < r.length; i++) test(r[i], r[(i + 1) % r.length]);
    if (!hit && pointInRing(box.min, it.rings[0])) hit = true;
    return hit;
  }
  if (it.k === 'arc' || it.k === 'circle') {
    const pts = it.k === 'arc' ? arcPoints(it.c, it.r, it.a0, it.a1, 32) : arcPoints(it.c, it.r, 0, Math.PI * 2 - 1e-6, 32);
    for (let i = 0; i + 1 < pts.length; i++) test(pts[i], pts[i + 1]);
    return hit;
  }
  if (it.k === 'text') { const r = textBox(it, scale); for (let i = 0; i < 4; i++) test(r[i], r[(i + 1) % 4]); return hit; }
  forEachSeg(it, test);
  return hit;
}

/** Grundelement mit einer Ähnlichkeitstransformation abbilden (z.B. Ansichtsfenster auf Plan). */
export function transformPrim(it: Prim, m: Mat2): Prim {
  const s = matScale(m); const rot = matAngle(m); const mir = isMirror(m);
  const P = (p: V2) => apply(m, p);
  switch (it.k) {
    case 'line': return { ...it, a: P(it.a), b: P(it.b) };
    case 'poly': return { ...it, pts: it.pts.map(P) };
    case 'fill': return { ...it, rings: it.rings.map((r) => r.map(P)) };
    case 'arc': {
      const a0 = mir ? rot - it.a1 : it.a0 + rot; const a1 = mir ? rot - it.a0 : it.a1 + rot;
      return { ...it, c: P(it.c), r: it.r * s, a0, a1 };
    }
    case 'circle': return { ...it, c: P(it.c), r: it.r * s };
    case 'text': return { ...it, p: P(it.p), font: { ...it.font, rot: (it.font.rot ?? 0) + rot } };
    case 'clip': return { ...it, rings: it.rings ? it.rings.map((r) => r.map(P)) : null };
    case 'image': return { ...it, p: P(it.p), w: it.w * s, h: it.h * s, rot: (it.rot ?? 0) + rot };
  }
}

/** Hilfen für Fangpunkte aus der Display-Liste */
export interface SnapCand { p: V2; kind: 'end' | 'mid' | 'center' | 'quad' | 'int' | 'near' | 'perp' | 'grid' | 'point'; o?: Id | null }

export function snapCandidates(dl: DisplayList, p: V2, r: number, from?: V2 | null): SnapCand[] {
  const out: SnapCand[] = [];
  const segs: { a: V2; b: V2; o: Id | null }[] = [];
  for (let i = 0; i < dl.items.length; i++) {
    const it = dl.items[i];
    if (it.ns || it.k === 'text' || it.k === 'clip' || it.sel) continue;
    const bb = dl.boxOf(i);
    if (!bb || p.x < bb.min.x - r || p.x > bb.max.x + r || p.y < bb.min.y - r || p.y > bb.max.y + r) continue;
    if (it.k === 'arc' || it.k === 'circle') {
      out.push({ p: it.c, kind: 'center', o: it.o });
      if (it.k === 'arc') {
        out.push({ p: add(it.c, fromAngle(it.a0, it.r)), kind: 'end', o: it.o });
        out.push({ p: add(it.c, fromAngle(it.a1, it.r)), kind: 'end', o: it.o });
      } else {
        for (let q = 0; q < 4; q++) out.push({ p: add(it.c, fromAngle((q * Math.PI) / 2, it.r)), kind: 'quad', o: it.o });
      }
      const d = dist(p, it.c);
      if (d > 1e-6 && Math.abs(d - it.r) < r) out.push({ p: add(it.c, { x: ((p.x - it.c.x) / d) * it.r, y: ((p.y - it.c.y) / d) * it.r }), kind: 'near', o: it.o });
      continue;
    }
    forEachSeg(it, (a, b) => {
      if (len(sub(b, a)) < 1e-6) return;
      if (distToSeg(p, a, b) > r) return;
      segs.push({ a, b, o: it.o ?? null });
      out.push({ p: a, kind: 'end', o: it.o }, { p: b, kind: 'end', o: it.o }, { p: mid(a, b), kind: 'mid', o: it.o });
      out.push({ p: closestOnSeg(p, a, b), kind: 'near', o: it.o });
      if (from) {
        const d = sub(b, a); const t = ((from.x - a.x) * d.x + (from.y - a.y) * d.y) / (d.x * d.x + d.y * d.y);
        if (t > 0 && t < 1) out.push({ p: { x: a.x + d.x * t, y: a.y + d.y * t }, kind: 'perp', o: it.o });
      }
    });
  }
  // Schnittpunkte
  const ns = Math.min(segs.length, 60);
  for (let i = 0; i < ns; i++) for (let j = i + 1; j < ns; j++) {
    const x = segSeg(segs[i].a, segs[i].b, segs[j].a, segs[j].b, 1e-6);
    if (x) out.push({ p: x, kind: 'int' });
  }
  return out;
}
