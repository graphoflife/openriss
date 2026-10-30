// DXF-Import (ASCII): LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, ELLIPSE, SPLINE, TEXT, MTEXT, ATTRIB,
// SOLID/TRACE/3DFACE, HATCH (Vollfüllung), LEADER, INSERT (Blöcke aufgelöst, verschachtelt, Reihen) und DIMENSION (Block).
// Ergebnis: kompakte Geometrie in Datei-Einheiten relativ zu einem Basispunkt. Rein funktional (ohne DOM).
import { V2, Mat2, BBox, apply, compose, matScale, matAngle, isMirror, emptyBox, extendBox, boxValid } from '../../core/geom';

/** Kompaktes CAD-Element (Koordinaten relativ zu CadData.base) */
export interface CadEnt {
  /** l Linie, p Polylinie, c Kreis, a Bogen, t Text, s gefüllte Fläche */
  t: 'l' | 'p' | 'c' | 'a' | 't' | 's';
  p: number[];
  /** Bulges je Scheitel (nur Polylinie) */
  b?: number[];
  c?: 1;
  r?: number;
  a0?: number; a1?: number;
  s?: string; h?: number; rot?: number;
  /** Ausrichtung: ha 0 links/1 Mitte/2 rechts; va 0 Grundlinie/1 unten/2 Mitte/3 oben */
  ha?: number; va?: number;
  /** Layer-Index */
  L?: number;
  /** Farbe: ACI 1..255 oder -(RGB+1) */
  k?: number;
}
export interface CadData {
  ents: CadEnt[];
  layers: string[];
  /** Layer, die in der Datei aus/gefroren sind */
  hiddenLayers: string[];
  /** $INSUNITS (0 = ohne Einheit) */
  insunits: number;
  base: V2;
  /** Umgrenzung relativ zu base */
  box: BBox;
  version: string;
  skipped: Record<string, number>;
}

/** mm je Datei-Einheit für $INSUNITS */
export const INSUNITS_MM: Record<number, number> = { 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 14: 100, 15: 10000 };

// ------------------------------------------------------------ Dekodierung
const CODEPAGES: Record<string, string> = { ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1257: 'windows-1257', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5' };
export function decodeDxf(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 6000)));
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error('Binäre DXF-Dateien werden nicht unterstützt (bitte als ASCII-DXF speichern).');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/.exec(head)?.[1] ?? '';
  const n = parseInt(ver.slice(2), 10) || 0;
  let enc = 'windows-1252';
  if (n >= 1021) enc = 'utf-8';
  else { const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1]?.toUpperCase(); if (cp && CODEPAGES[cp]) enc = CODEPAGES[cp]; }
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
}

// ------------------------------------------------------------ Datensätze
class Rec {
  c: number[] = []; v: string[] = [];
  constructor(public type: string) {}
  str(code: number, def = ''): string { const i = this.c.indexOf(code); return i < 0 ? def : this.v[i]; }
  num(code: number, def = 0): number { const i = this.c.indexOf(code); if (i < 0) return def; const x = parseFloat(this.v[i]); return isFinite(x) ? x : def; }
  has(code: number): boolean { return this.c.includes(code); }
}

function readRecords(text: string): { sections: Map<string, Rec[]> } {
  const lines = text.split(/\r\n|\r|\n/);
  const sections = new Map<string, Rec[]>();
  let sec: Rec[] | null = null; let rec: Rec | null = null; let expectName = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (isNaN(code)) { i--; continue; } // Leerzeilen tolerieren
    const val = lines[i + 1];
    if (code === 0) {
      const t = val.trim();
      if (t === 'SECTION') { expectName = true; sec = null; rec = null; continue; }
      if (t === 'ENDSEC') { sec = null; rec = null; continue; }
      if (t === 'EOF') break;
      rec = new Rec(t);
      sec?.push(rec);
      continue;
    }
    if (expectName && code === 2) { expectName = false; rec = new Rec('__'); sec = [rec]; sections.set(val.trim(), sec); continue; }
    if (rec) { rec.c.push(code); rec.v.push(code === 1 || code === 3 ? val : val.trim()); }
  }
  return { sections };
}

// ------------------------------------------------------------ Texte
function cleanText(s: string, mtext: boolean): string {
  let t = s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_m, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%');
  if (mtext) {
    // maskierte Zeichen schützen (\\ \{ \}), Formatcodes entfernen, Gruppenklammern entfernen
    t = t.replace(/\\\\/g, '\u0003').replace(/\\\{/g, '\u0001').replace(/\\\}/g, '\u0002')
      .replace(/\\P/g, '\n').replace(/\\~/g, '\u00a0')
      .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, '$1/$2')
      .replace(/\\[ACcFfHhQqTtWwp][^;\\{}]*;/g, '')
      .replace(/\\[LlOoKkNX]/g, '')
      .replace(/[{}]/g, '')
      .replace(/\u0001/g, '{').replace(/\u0002/g, '}').replace(/\u0003/g, '\\');
  }
  return t;
}

// ------------------------------------------------------------ Transformationen
const I: Mat2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const FLIPX: Mat2 = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const T = (x: number, y: number): Mat2 => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
const R = (a: number): Mat2 => ({ a: Math.cos(a), b: Math.sin(a), c: -Math.sin(a), d: Math.cos(a), e: 0, f: 0 });
const S = (x: number, y: number): Mat2 => ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
const uniform = (m: Mat2) => Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-9 * Math.max(1, Math.hypot(m.a, m.b)) && Math.abs(m.a * m.c + m.b * m.d) < 1e-9 * Math.max(1, m.a * m.a + m.b * m.b);
/** Objektkoordinatensystem: Extrusion (0,0,-1) spiegelt x */
const ocs = (r: Rec, m: Mat2) => (r.num(230, 1) < 0 ? compose(m, FLIPX) : m);
const deg = Math.PI / 180;

function bulgeArc(p0: V2, p1: V2, b: number): { c: V2; r: number; a0: number; a1: number } | null {
  const dx = p1.x - p0.x, dy = p1.y - p0.y; const L = Math.hypot(dx, dy);
  if (L < 1e-12 || Math.abs(b) < 1e-9) return null;
  const ang = 4 * Math.atan(b);
  const r = L / (2 * Math.sin(Math.abs(ang) / 2));
  const hd = r * Math.cos(Math.abs(ang) / 2) * Math.sign(b);
  const c = { x: (p0.x + p1.x) / 2 - (dy / L) * hd, y: (p0.y + p1.y) / 2 + (dx / L) * hd };
  let a0 = Math.atan2(p0.y - c.y, p0.x - c.x), a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  if (b < 0) [a0, a1] = [a1, a0];
  return { c, r: Math.abs(r), a0, a1 };
}
/** Bogenpunkte (gegen Uhrzeigersinn a0 → a1) */
function arcPts(c: V2, r: number, a0: number, a1: number, n = 0): V2[] {
  let sw = a1 - a0; while (sw <= 0) sw += Math.PI * 2;
  const k = n || Math.max(4, Math.ceil(sw / (Math.PI / 24)));
  const out: V2[] = [];
  for (let i = 0; i <= k; i++) { const a = a0 + (sw * i) / k; out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
  return out;
}
/** Polylinie mit Bulges in Punkte auflösen */
function flattenBulges(pts: V2[], bul: number[], closed: boolean): V2[] {
  const out: V2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    out.push(pts[i]);
    const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
    if (j < 0) break;
    const arc = bul[i] ? bulgeArc(pts[i], pts[j], bul[i]) : null;
    if (arc) {
      const ap = arcPts(arc.c, arc.r, arc.a0, arc.a1);
      if (bul[i] < 0) ap.reverse();
      out.push(...ap.slice(1, -1));
    }
  }
  return out;
}

/** B-Spline (de Boor) */
function bspline(ctrl: V2[], knots: number[], deg_: number, w?: number[]): V2[] {
  const n = ctrl.length;
  if (n < 2 || knots.length !== n + deg_ + 1) return ctrl;
  const t0 = knots[deg_], t1 = knots[n];
  const out: V2[] = []; const steps = Math.min(400, Math.max(16, n * 8));
  for (let s = 0; s <= steps; s++) {
    const t = Math.min(t1 - 1e-12, t0 + ((t1 - t0) * s) / steps);
    let k = deg_; while (k < n - 1 && t >= knots[k + 1]) k++;
    const d: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j <= deg_; j++) { const i = k - deg_ + j; const ww = w?.[i] ?? 1; d.push({ x: ctrl[i].x * ww, y: ctrl[i].y * ww, w: ww }); }
    for (let r = 1; r <= deg_; r++) for (let j = deg_; j >= r; j--) {
      const i = k - deg_ + j; const den = knots[i + deg_ - r + 1] - knots[i];
      const a = den ? (t - knots[i]) / den : 0;
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
    }
    out.push({ x: d[deg_].x / d[deg_].w, y: d[deg_].y / d[deg_].w });
  }
  return out;
}

// ------------------------------------------------------------ Hauptfunktion
export function parseDxf(text: string, maxEnts = 400000): CadData {
  const { sections } = readRecords(text);
  const header = sections.get('HEADER') ?? [];
  let insunits = 0; let version = '';
  // HEADER besteht aus einem Datensatz-Strom mit 9er-Codes
  for (const r of header) for (let i = 0; i < r.c.length; i++) {
    if (r.c[i] !== 9) continue;
    if (r.v[i] === '$INSUNITS') insunits = parseInt(r.v[i + 1] ?? '0', 10) || 0;
    if (r.v[i] === '$ACADVER') version = r.v[i + 1] ?? '';
  }
  // Layer-Tabelle
  const layerColor = new Map<string, number>(); const hidden = new Set<string>();
  for (const r of sections.get('TABLES') ?? []) {
    if (r.type !== 'LAYER' || !r.has(2)) continue;
    const name = r.str(2); const col = r.num(62, 7);
    layerColor.set(name, Math.abs(col) || 7);
    if (col < 0 || (r.num(70) & 1)) hidden.add(name);
    if (r.has(420)) layerColor.set(name, -(r.num(420) + 1));
  }
  // Blöcke
  const blocks = new Map<string, { base: V2; recs: Rec[] }>();
  let cur: { base: V2; recs: Rec[] } | null = null;
  for (const r of sections.get('BLOCKS') ?? []) {
    if (r.type === 'BLOCK') { cur = { base: { x: r.num(10), y: r.num(20) }, recs: [] }; blocks.set(r.str(2), cur); continue; }
    if (r.type === 'ENDBLK') { cur = null; continue; }
    cur?.recs.push(r);
  }

  const layers: string[] = []; const layerIdx = new Map<string, number>();
  const L = (name: string) => { let i = layerIdx.get(name); if (i === undefined) { i = layers.length; layers.push(name); layerIdx.set(name, i); } return i; };
  const ents: CadEnt[] = []; const skipped: Record<string, number> = {};
  const skip = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  let tooMany = false;

  interface Ctx { m: Mat2; layer: string; color: number; depth: number }
  const resolve = (r: Rec, ctx: Ctx): { layer: string; k: number } => {
    let layer = r.str(8, '0');
    if (layer === '0' && ctx.depth > 0) layer = ctx.layer;
    let k = r.num(62, 256);
    if (r.has(420)) k = -(r.num(420) + 1);
    else if (k === 0) k = ctx.color;
    else if (k === 256) k = layerColor.get(layer) ?? 7;
    return { layer, k };
  };
  const push = (e: CadEnt, r: Rec, ctx: Ctx) => {
    if (ents.length >= maxEnts) { tooMany = true; return; }
    const { layer, k } = resolve(r, ctx);
    e.L = L(layer); if (k !== 7) e.k = k;
    ents.push(e);
  };
  const P = (m: Mat2, x: number, y: number) => apply(m, { x, y });
  const flat = (pts: V2[]) => { const o: number[] = []; for (const p of pts) o.push(p.x, p.y); return o; };
  const polyEnt = (pts: V2[], bul: number[] | null, closed: boolean, m: Mat2, r: Rec, ctx: Ctx) => {
    if (pts.length < 2) return;
    const hasB = !!bul && bul.some((b) => Math.abs(b) > 1e-9);
    if (hasB && !uniform(m)) { pts = flattenBulges(pts, bul!, closed); bul = null; }
    const tp = pts.map((p) => apply(m, p));
    const e: CadEnt = { t: 'p', p: flat(tp) };
    if (closed) e.c = 1;
    if (bul && hasB) e.b = bul.map((b) => (isMirror(m) ? -b : b));
    push(e, r, ctx);
  };
  const circleEnt = (c: V2, rad: number, m: Mat2, r: Rec, ctx: Ctx, a0?: number, a1?: number) => {
    if (uniform(m)) {
      const cc = apply(m, c); const s = matScale(m); const rot = matAngle(m);
      if (a0 === undefined || a1 === undefined) { push({ t: 'c', p: [cc.x, cc.y], r: rad * s }, r, ctx); return; }
      const [b0, b1] = isMirror(m) ? [rot - a1, rot - a0] : [a0 + rot, a1 + rot];
      push({ t: 'a', p: [cc.x, cc.y], r: rad * s, a0: b0, a1: b1 }, r, ctx);
      return;
    }
    const pts = arcPts(c, rad, a0 ?? 0, a1 ?? Math.PI * 2, a0 === undefined ? 64 : 0);
    polyEnt(a0 === undefined ? pts.slice(0, -1) : pts, null, a0 === undefined, m, r, ctx);
  };
  const textEnt = (s: string, p: V2, hgt: number, rotRad: number, ha: number, va: number, m: Mat2, r: Rec, ctx: Ctx) => {
    if (!s.trim()) return;
    const q = apply(m, p);
    const dir = { x: m.a * Math.cos(rotRad) + m.c * Math.sin(rotRad), y: m.b * Math.cos(rotRad) + m.d * Math.sin(rotRad) };
    const hs = Math.hypot(m.c, m.d) || 1;
    const e: CadEnt = { t: 't', p: [q.x, q.y], s, h: hgt * hs };
    const rot = Math.atan2(dir.y, dir.x); if (Math.abs(rot) > 1e-9) e.rot = rot;
    if (ha) e.ha = ha; if (va) e.va = va;
    push(e, r, ctx);
  };

  const walk = (recs: Rec[], ctx: Ctx) => {
    for (let i = 0; i < recs.length && !tooMany; i++) {
      const r = recs[i];
      if (r.num(67) === 1) { if (r.type === 'POLYLINE' || (r.type === 'INSERT' && r.num(66) === 1)) while (i + 1 < recs.length && recs[i + 1].type !== 'SEQEND') i++; continue; }
      const m = ctx.m;
      switch (r.type) {
        case 'LINE': {
          const a = P(m, r.num(10), r.num(20)), b = P(m, r.num(11), r.num(21));
          push({ t: 'l', p: [a.x, a.y, b.x, b.y] }, r, ctx);
          break;
        }
        case 'LWPOLYLINE': {
          const mo = ocs(r, m); const pts: V2[] = []; const bul: number[] = [];
          for (let j = 0; j < r.c.length; j++) {
            const c = r.c[j];
            if (c === 10) { pts.push({ x: parseFloat(r.v[j]), y: 0 }); bul.push(0); }
            else if (c === 20 && pts.length) pts[pts.length - 1].y = parseFloat(r.v[j]);
            else if (c === 42 && pts.length) bul[bul.length - 1] = parseFloat(r.v[j]) || 0;
          }
          polyEnt(pts, bul, (r.num(70) & 1) === 1, mo, r, ctx);
          break;
        }
        case 'POLYLINE': {
          const flags = r.num(70); const pts: V2[] = []; const bul: number[] = [];
          while (i + 1 < recs.length && recs[i + 1].type === 'VERTEX') {
            const v = recs[++i]; const vf = v.num(70);
            if (vf & 16 || (vf & 128 && !(vf & 64))) continue; // Spline-Rahmen / Netzflächen
            pts.push({ x: v.num(10), y: v.num(20) }); bul.push(v.num(42));
          }
          if (i + 1 < recs.length && recs[i + 1].type === 'SEQEND') i++;
          if (flags & 64 || flags & 16) { skip('POLYLINE (Netz)'); break; }
          polyEnt(pts, bul, (flags & 1) === 1, flags & 8 ? m : ocs(r, m), r, ctx);
          break;
        }
        case 'CIRCLE': circleEnt({ x: r.num(10), y: r.num(20) }, r.num(40), ocs(r, m), r, ctx); break;
        case 'ARC': circleEnt({ x: r.num(10), y: r.num(20) }, r.num(40), ocs(r, m), r, ctx, r.num(50) * deg, r.num(51) * deg); break;
        case 'ELLIPSE': {
          const c = { x: r.num(10), y: r.num(20) }; const mj = { x: r.num(11), y: r.num(21) }; const ratio = r.num(40, 1);
          const sg = r.num(230, 1) < 0 ? -1 : 1;
          const mn = { x: -mj.y * ratio * sg, y: mj.x * ratio * sg };
          let t0 = r.num(41, 0), t1 = r.num(42, Math.PI * 2); while (t1 <= t0) t1 += Math.PI * 2;
          const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
          const n = Math.max(8, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 72));
          const pts: V2[] = [];
          for (let k = 0; k <= (full ? n - 1 : n); k++) { const t = t0 + ((t1 - t0) * k) / n; pts.push({ x: c.x + mj.x * Math.cos(t) + mn.x * Math.sin(t), y: c.y + mj.y * Math.cos(t) + mn.y * Math.sin(t) }); }
          polyEnt(pts, null, full, m, r, ctx);
          break;
        }
        case 'SPLINE': {
          const ctrl: V2[] = [], fit: V2[] = [], knots: number[] = [], w: number[] = [];
          for (let j = 0; j < r.c.length; j++) {
            const c = r.c[j], v = parseFloat(r.v[j]);
            if (c === 10) ctrl.push({ x: v, y: 0 }); else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1].y = v;
            else if (c === 11) fit.push({ x: v, y: 0 }); else if (c === 21 && fit.length) fit[fit.length - 1].y = v;
            else if (c === 40) knots.push(v); else if (c === 41) w.push(v);
          }
          const pts = ctrl.length >= 2 ? bspline(ctrl, knots, r.num(71, 3), w.length === ctrl.length ? w : undefined) : fit;
          polyEnt(pts, null, false, m, r, ctx);
          break;
        }
        case 'TEXT': case 'ATTRIB': {
          if (r.type === 'ATTRIB' && r.num(70) & 1) break;
          const ha0 = r.num(72), va0 = r.num(r.type === 'ATTRIB' ? 74 : 73);
          const aligned = ha0 !== 0 || va0 !== 0;
          const p = aligned && r.has(11) ? { x: r.num(11), y: r.num(21) } : { x: r.num(10), y: r.num(20) };
          const ha = ha0 === 4 ? 1 : ha0 === 1 || ha0 === 2 ? ha0 : 0;
          const va = ha0 === 4 ? 2 : va0;
          textEnt(cleanText(r.str(1), false), p, r.num(40, 2.5), r.num(50) * deg, ha, va, ocs(r, m), r, ctx);
          break;
        }
        case 'MTEXT': {
          let s = ''; for (let j = 0; j < r.c.length; j++) if (r.c[j] === 3) s += r.v[j];
          s += r.str(1);
          const att = r.num(71, 1);
          const ha = (att - 1) % 3, va = att <= 3 ? 3 : att <= 6 ? 2 : 1;
          const rot = r.has(11) ? Math.atan2(r.num(21), r.num(11)) : r.num(50) * deg;
          textEnt(cleanText(s, true), { x: r.num(10), y: r.num(20) }, r.num(40, 2.5), rot, ha, va, m, r, ctx);
          break;
        }
        case 'SOLID': case 'TRACE': case '3DFACE': {
          const q = [0, 1, 2, 3].map((k) => P(m, r.num(10 + k), r.num(20 + k)));
          let ring = r.type === '3DFACE' ? q : [q[0], q[1], q[3], q[2]];
          ring = ring.filter((p, k) => k === 0 || Math.hypot(p.x - ring[k - 1].x, p.y - ring[k - 1].y) > 1e-9);
          if (ring.length > 2 && Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y) < 1e-9) ring.pop();
          if (ring.length >= 3) push(r.type === '3DFACE' ? { t: 'p', p: flat(ring), c: 1 } : { t: 's', p: flat(ring) }, r, ctx);
          break;
        }
        case 'HATCH': {
          if (r.num(70) !== 1) { skip('HATCH (Muster)'); break; }
          const mo = ocs(r, m);
          for (const ring of hatchRings(r)) if (ring.length >= 3) push({ t: 's', p: flat(ring.map((p) => apply(mo, p))) }, r, ctx);
          break;
        }
        case 'LEADER': {
          const pts: V2[] = [];
          for (let j = 0; j < r.c.length; j++) { if (r.c[j] === 10) pts.push({ x: parseFloat(r.v[j]), y: 0 }); else if (r.c[j] === 20 && pts.length) pts[pts.length - 1].y = parseFloat(r.v[j]); }
          polyEnt(pts, null, false, m, r, ctx);
          break;
        }
        case 'INSERT': case 'DIMENSION': {
          const name = r.str(2); const blk = blocks.get(name);
          const { layer, k } = resolve(r, ctx);
          const sub: Ctx = { m, layer, color: k, depth: ctx.depth + 1 };
          if (blk && ctx.depth < 12) {
            if (r.type === 'DIMENSION') walk(blk.recs, sub);
            else {
              const mo = ocs(r, m);
              const sx = r.num(41, 1), sy = r.num(42, 1), rot = r.num(50) * deg;
              const nc = Math.max(1, r.num(70, 1)), nr = Math.max(1, r.num(71, 1)), dc = r.num(44), dr = r.num(45);
              for (let ci = 0; ci < nc; ci++) for (let ri = 0; ri < nr; ri++) {
                const bm = compose(mo, compose(T(r.num(10), r.num(20)), compose(R(rot), compose(T(ci * dc, ri * dr), compose(S(sx, sy), T(-blk.base.x, -blk.base.y))))));
                walk(blk.recs, { ...sub, m: bm });
              }
            }
          } else if (!blk) skip(r.type + ' (Block fehlt)');
          // Attribute folgen dem INSERT
          if (r.type === 'INSERT' && r.num(66) === 1) {
            const attrs: Rec[] = [];
            while (i + 1 < recs.length && recs[i + 1].type === 'ATTRIB') attrs.push(recs[++i]);
            if (i + 1 < recs.length && recs[i + 1].type === 'SEQEND') i++;
            walk(attrs, ctx);
          }
          break;
        }
        case 'ATTDEF': case 'POINT': case 'SEQEND': case 'VERTEX': case 'VIEWPORT': case '__': break;
        default: skip(r.type);
      }
    }
  };
  walk(sections.get('ENTITIES') ?? [], { m: I, layer: '0', color: 7, depth: 0 });
  if (tooMany) skipped['(Grenze erreicht)'] = 1;

  // Basispunkt = Mitte der Umgrenzung, Koordinaten relativ (kleinere Zahlen, Genauigkeit)
  const bb = emptyBox();
  for (const e of ents) {
    if (e.t === 'c' || e.t === 'a') { extendBox(bb, { x: e.p[0] - e.r!, y: e.p[1] - e.r! }); extendBox(bb, { x: e.p[0] + e.r!, y: e.p[1] + e.r! }); }
    else for (let j = 0; j + 1 < e.p.length; j += 2) extendBox(bb, { x: e.p[j], y: e.p[j + 1] });
  }
  const base = boxValid(bb) ? { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2 } : { x: 0, y: 0 };
  const rd = (v: number) => Math.round(v * 1e5) / 1e5;
  for (const e of ents) {
    for (let j = 0; j + 1 < e.p.length; j += 2) { e.p[j] = rd(e.p[j] - base.x); e.p[j + 1] = rd(e.p[j + 1] - base.y); }
    if (e.r !== undefined) e.r = rd(e.r);
    if (e.h !== undefined) e.h = rd(e.h);
    if (e.b) e.b = e.b.map((b) => Math.round(b * 1e6) / 1e6);
  }
  const box = boxValid(bb) ? { min: { x: bb.min.x - base.x, y: bb.min.y - base.y }, max: { x: bb.max.x - base.x, y: bb.max.y - base.y } } : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { ents, layers, hiddenLayers: layers.filter((l) => hidden.has(l)), insunits, base, box, version, skipped };
}

/** Umrandungen einer HATCH (Polylinien- und Kantenpfade: Linie, Bogen, Ellipse, Spline-Stützpunkte) */
function hatchRings(r: Rec): V2[][] {
  const rings: V2[][] = [];
  let j = r.c.indexOf(91); if (j < 0) return rings;
  const np = parseInt(r.v[j], 10) || 0; j++;
  const at = (code: number) => { while (j < r.c.length && r.c[j] !== code) j++; return j < r.c.length ? parseFloat(r.v[j++]) : 0; };
  const next = (code: number) => (r.c[j] === code ? parseFloat(r.v[j++]) : 0);
  for (let pi = 0; pi < np && j < r.c.length; pi++) {
    const flag = at(92);
    const ring: V2[] = [];
    if (flag & 2) {
      const hasB = at(72); at(73); const nv = at(93);
      const pts: V2[] = []; const bul: number[] = [];
      for (let k = 0; k < nv; k++) { const x = at(10), y = next(20); pts.push({ x, y }); bul.push(hasB && r.c[j] === 42 ? next(42) : 0); }
      ring.push(...flattenBulges(pts, bul, true));
    } else {
      const ne = at(93);
      for (let k = 0; k < ne; k++) {
        const et = at(72);
        if (et === 1) { const x0 = at(10), y0 = next(20), x1 = at(11), y1 = next(21); ring.push({ x: x0, y: y0 }); void x1; void y1; }
        else if (et === 2) {
          const cx = at(10), cy = next(20), rad = at(40), a0 = at(50) * deg, a1 = at(51) * deg, ccw = at(73);
          // im Uhrzeigersinn: Winkel sind gespiegelt gespeichert
          const pts = ccw ? arcPts({ x: cx, y: cy }, rad, a0, a1) : arcPts({ x: cx, y: cy }, rad, -a1, -a0).reverse();
          ring.push(...pts.slice(0, -1));
        } else if (et === 3) {
          const cx = at(10), cy = next(20), mx = at(11), my = next(21), ratio = at(40), t0 = at(50) * deg, t1 = at(51) * deg, ccw = at(73);
          let s = t0, e = t1; if (!ccw) { s = -t1; e = -t0; } while (e <= s) e += Math.PI * 2;
          const ep: V2[] = [];
          for (let q = 0; q < 48; q++) { const t = s + ((e - s) * q) / 48; ep.push({ x: cx + mx * Math.cos(t) - my * ratio * Math.sin(t), y: cy + my * Math.cos(t) + mx * ratio * Math.sin(t) }); }
          ring.push(...(ccw ? ep : ep.reverse()));
        } else if (et === 4) {
          at(94); at(73); at(74); const nk = at(95), nc = at(96);
          for (let q = 0; q < nk; q++) at(40);
          for (let q = 0; q < nc; q++) { const x = at(10), y = next(20); ring.push({ x, y }); }
        }
      }
    }
    if (ring.length >= 3) rings.push(ring);
    // Quellobjekte überspringen
    const ns = r.c[j] === 97 ? parseInt(r.v[j++], 10) || 0 : 0;
    for (let k = 0; k < ns && r.c[j] === 330; k++) j++;
  }
  return rings;
}
