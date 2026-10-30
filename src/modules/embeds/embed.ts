// Kategorie «Einlage» (embed): Produkte, die einbetoniert werden. Familien (über den Typ):
// Fugenblech/Fugenband, Rückbiegeanschluss, Schraubanschluss/Muffenstab, Durchstanzbewehrung,
// Ankerschiene, Futterrohr/Mantelrohr (mit runder Wandöffnung), Einlegerohr (Elektro/Lüftung), Einlegekasten.
// Geometrie: Linie (Grundriss-Polylinie + Höhe + Querschnitt), Punkt, oder vom Host abgeleitet
// (Fugenblech an Arbeitsfuge, Ankerschiene am Lichtschacht, Durchstanzbewehrung an Stütze, Futterrohr in Wand).
import type { Doc, El, Id } from '../../core/doc';
import {
  V2, V3, add, sub, mul, perp, norm, dist, dot, fromAngle, angleOf, rotate, apply, applyVec, Mat2, lerp, mid, polylineLength,
} from '../../core/geom';
import { registerCategory, catDef, GROUPS, PropDef, PlanCtx, SectionCtx, Solid, Face, Grip } from '../../core/registry';
import { TypeEl, View, levelOptions, isPlanLike, isSectionLike, levelElev, typesOf } from '../../core/view';
import { box3, extrudeProfile, prism } from '../../views/sectionEngine';
import type { DisplayList } from '../../render/displayList';
import type { Pen, Fill } from '../../render/styles';
import { cached } from '../../core/cache';
import {
  fmtM, fmtKote, fmtMm, plen, polyMid, circleRing, circleProfile, coreSymbol, wallFrame, WallFrame, slabAt, columnBox, RED, addMissing,
} from './common';

export type Family = 'waterstop' | 'rebarBox' | 'coupler' | 'punching' | 'anchorChannel' | 'sleeve' | 'conduit' | 'box';
export const FAMILIES: Record<Family, { label: string; color: string; kind: 'line' | 'point' | 'host' }> = {
  waterstop: { label: 'Fugenblech / Fugenband', color: RED, kind: 'line' },
  rebarBox: { label: 'Rückbiegeanschluss', color: RED, kind: 'line' },
  coupler: { label: 'Schraubanschluss / Muffenstab', color: '#f08c1a', kind: 'line' },
  punching: { label: 'Durchstanzbewehrung', color: '#1f5fd6', kind: 'host' },
  anchorChannel: { label: 'Ankerschiene', color: '#7b3fbf', kind: 'line' },
  sleeve: { label: 'Futterrohr / Mantelrohr', color: '#1f3f9f', kind: 'host' },
  conduit: { label: 'Einlegerohr', color: '#d020a0', kind: 'line' },
  box: { label: 'Einlegekasten / Dose', color: '#d020a0', kind: 'point' },
};
export const FAMILY_OPTIONS: [string, string][] = (Object.keys(FAMILIES) as Family[]).map((k) => [k, FAMILIES[k].label]);

/** Muffen-/Kopplerdaten für Schraubanschlüsse (für ABS-Muffenblock) */
export interface CouplerData { system?: string; product?: string; dia?: number; thread?: string; sleeveLen?: number; partA?: string; partB?: string }

export interface EmbedType extends TypeEl {
  of: 'embed'; family: Family;
  product?: string; maker?: string; color?: string; mat?: Id; description?: string;
  h?: number; t?: number; lo?: number; hi?: number;      // Fugenblech
  dia?: number; s?: number; hB?: number; bw?: number; bd?: number; L?: number; mL?: number;
  coupler?: CouplerData;
  nA?: number; head?: number; hs?: number;                // Durchstanz
  wt?: number; flange?: number;                            // Futterrohr
  system?: 'elektro' | 'lueftung' | 'sanitaer';           // Rohr/Kasten
  w?: number; l?: number; round?: boolean;                 // Kasten
}

export interface Embed extends El {
  cat: 'embed'; family: Family; levelId: Id;
  /** Höhe über Ebene: Achse (Linie/Punkt/Futterrohr), Unterkante (vertikal, Kasten, Durchstanzanker) bzw. Fläche (face 'h') */
  z: number;
  pts?: V2[]; p?: V2; rot?: number;
  /** Fugenblech: stehend (horizontale Fuge), liegend (Plattenfuge), senkrecht (Wandfuge) */
  mode?: 'standing' | 'lying' | 'vertical';
  /** Lage: in Wandfläche ('v') oder Plattenfläche ('h') */
  face?: 'v' | 'h';
  /** Betonseite: links (+1) / rechts (−1) der Linie bzw. Flächenseite oben (+1) / unten (−1) */
  side?: 1 | -1;
  h2?: number;
  /** Muffenstab: Einzelstab senkrecht */
  vert?: boolean;
  /** Linienelemente: Anzahl Stäbe (Muffen) – sonst aus Länge/Abstand */
  count?: number;
  /** Futterrohr: Lage entlang Wand */
  t?: number;
  /** Durchstanz: Anordnung, Anzahl Elemente, Abstände ab Stützenrand */
  pattern?: 'radial' | 'ortho'; n?: number; dists?: number[];
  /** abgeleitet von Host (Arbeitsfuge, Lichtschacht): Index */
  slot?: number;
}

// ------------------------------------------------------------ Typ/Parameter
export const embedType = (doc: Doc, el: El): EmbedType | undefined => doc.get<EmbedType>(el.typeId);
export const familyOf = (doc: Doc, el: El): Family => (embedType(doc, el)?.family ?? el.family ?? 'waterstop') as Family;
/** Parameter: Instanz überschreibt Typ */
export function par(doc: Doc, el: El, k: keyof EmbedType & string, fb: number): number {
  const v = el[k] ?? (embedType(doc, el) as any)?.[k];
  return typeof v === 'number' && isFinite(v) ? v : fb;
}
const DEF: Record<string, number> = { h: 300, t: 1.5, lo: 150, hi: 150, dia: 12, s: 150, hB: 140, bw: 120, bd: 40, L: 1200, mL: 60, nA: 3, head: 30, hs: 200, wt: 6, flange: 0, w: 600, l: 400 };
export const P = (doc: Doc, el: El, k: string): number => par(doc, el, k as any, DEF[k] ?? 0);

// ------------------------------------------------------------ Ableitung vom Host (Arbeitsfuge, Lichtschacht)
type Deriver = (doc: Doc, el: Embed, host: El) => Partial<Embed> | null;
const derivers = new Map<string, Deriver>();
/** Andere Kategorien liefern die Geometrie gehosteter Einlagen (z.B. 'joint' → Fugenblech) */
export function registerEmbedHost(cat: string, fn: Deriver): void { derivers.set(cat, fn); }

/** Wirksame Einlage (Geometrie vom Host aufgelöst) – null, wenn nicht darstellbar */
export function eff(doc: Doc, el: El): Embed | null {
  const calc = (): Embed | null => {
    const e = el as Embed;
    const host = e.hostId ? doc.get(e.hostId) : undefined;
    const d = host ? derivers.get(host.cat) : undefined;
    if (d) { const g = d(doc, e, host!); return g ? ({ ...e, ...g } as Embed) : null; }
    return e;
  };
  return el.id.startsWith('__') ? calc() : cached(doc, 'embEff', el.id, calc);
}
export const zAbs = (doc: Doc, e: Embed): number => levelElev(doc, e.levelId) + (e.z ?? 0);

// ------------------------------------------------------------ Querschnitt (Linienelemente) in (n quer links, z hoch)
export function profileOf(doc: Doc, e: Embed): V2[] {
  const f = familyOf(doc, e);
  const s = e.side ?? 1;
  const rect = (x0: number, y0: number, x1: number, y1: number): V2[] => [{ x: Math.min(x0, x1), y: Math.min(y0, y1) }, { x: Math.max(x0, x1), y: Math.min(y0, y1) }, { x: Math.max(x0, x1), y: Math.max(y0, y1) }, { x: Math.min(x0, x1), y: Math.max(y0, y1) }];
  switch (f) {
    case 'waterstop': {
      const t = Math.max(1, P(doc, e, 't')), lo = P(doc, e, 'lo'), hi = P(doc, e, 'hi');
      return e.mode === 'lying' ? rect(-lo, -t / 2, hi, t / 2) : rect(-t / 2, -lo, t / 2, hi);
    }
    case 'rebarBox': case 'anchorChannel': {
      const bw = P(doc, e, 'bw'), bd = P(doc, e, 'bd');
      return e.face === 'h' ? rect(-bw / 2, 0, bw / 2, -s * bd) : rect(0, -bw / 2, s * bd, bw / 2);
    }
    case 'coupler': {
      const d = P(doc, e, 'dia') + 12, mL = P(doc, e, 'mL');
      return e.face === 'h' ? rect(-d / 2, 0, d / 2, -s * mL) : rect(0, -d / 2, s * mL, d / 2);
    }
    default: {
      const r = Math.max(5, P(doc, e, 'dia') / 2);
      return circleRing({ x: 0, y: 0 }, r, 12);
    }
  }
}

/** Höhenbereich (absolut) */
export function zRange(doc: Doc, e: Embed): [number, number] {
  const z = zAbs(doc, e); const f = familyOf(doc, e);
  if (f === 'waterstop' && e.mode === 'vertical') return [z, z + (e.h2 ?? 3000)];
  if (f === 'box') return [z, z + P(doc, e, 'h')];
  if (f === 'punching') return [z - 20, z + P(doc, e, 'hs')];
  if (f === 'sleeve') { const r = P(doc, e, 'dia') / 2 + P(doc, e, 'wt'); return [z - r, z + r]; }
  if (f === 'coupler' && e.vert) return [z, z + P(doc, e, 'L')];
  if (e.pts) { const pr = profileOf(doc, e); return [z + Math.min(...pr.map((q) => q.y)), z + Math.max(...pr.map((q) => q.y))]; }
  return [z - 50, z + 50];
}

// ------------------------------------------------------------ Durchstanzbewehrung: Elemente um die Stütze
export interface PunchRail { a: V2; b: V2; studs: V2[] }
export function punchRails(doc: Doc, e: Embed): PunchRail[] {
  const col = e.hostId ? doc.get(e.hostId) : undefined;
  const cb = col ? columnBox(doc, col) : null;
  const c = cb?.p ?? e.p ?? { x: 0, y: 0 }; const rot = cb?.rot ?? e.rot ?? 0;
  const b = cb?.b ?? 300, h = cb?.h ?? 300, round = cb?.round ?? false;
  const n = Math.max(1, Math.round(e.n ?? 8));
  const ds = (e.dists?.length ? e.dists : [90, 145, 145]).map((x) => Math.max(0, x));
  const cum: number[] = []; let acc = 0; for (const d of ds) { acc += d; cum.push(acc); }
  const ext = 40;
  const out: PunchRail[] = [];
  const faceDist = (phi: number) => {
    if (round) return b / 2;
    const cx = Math.abs(Math.cos(phi)), sy = Math.abs(Math.sin(phi));
    return Math.min(cx > 1e-9 ? b / 2 / cx : Infinity, sy > 1e-9 ? h / 2 / sy : Infinity);
  };
  if ((e.pattern ?? 'radial') === 'radial') {
    for (let k = 0; k < n; k++) {
      const phi = (k / n) * Math.PI * 2; const d = fromAngle(phi + rot);
      const r0 = faceDist(phi);
      const studs = cum.map((x) => add(c, mul(d, r0 + x)));
      out.push({ a: add(c, mul(d, r0 + cum[0] - ext)), b: add(c, mul(d, r0 + cum[cum.length - 1] + ext)), studs });
    }
  } else {
    // orthogonal: je Stützenseite n/4 Elemente senkrecht zur Seite, gleichmässig über die Seitenbreite
    const per = Math.max(1, Math.round(n / 4));
    for (let side = 0; side < 4; side++) {
      const phi = (side * Math.PI) / 2; const d = fromAngle(phi + rot); const q = perp(d);
      const half = side % 2 === 0 ? b / 2 : h / 2; const width = side % 2 === 0 ? h : b;
      for (let i = 0; i < per; i++) {
        const off = per === 1 ? 0 : ((i + 0.5) / per - 0.5) * width;
        const base = add(add(c, mul(d, half)), mul(q, off));
        out.push({ a: add(base, mul(d, cum[0] - ext)), b: add(base, mul(d, cum[cum.length - 1] + ext)), studs: cum.map((x) => add(base, mul(d, x))) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ Futterrohr: Lage in der Wand
function sleeveGeo(doc: Doc, e: Embed): { F: WallFrame; u: number; z: number; r: number; ri: number; len: number; v0: number; v1: number } | null {
  const F = wallFrame(doc, e.hostId); if (!F) return null;
  const ri = P(doc, e, 'dia') / 2, r = ri + P(doc, e, 'wt');
  const over = e.h2 ?? 0; // Überstand beidseitig
  const v0 = -F.wi.T / 2 - over, v1 = F.wi.T / 2 + over;
  return { F, u: e.t ?? 0, z: zAbs(doc, e), r, ri, len: v1 - v0, v0, v1 };
}

// ------------------------------------------------------------ Grundriss
const pen = (doc: Doc, e: Embed, w = 2, dash?: Pen['dash']): Pen => ({ w, color: embedType(doc, e)?.color ?? FAMILIES[familyOf(doc, e)].color, dash });

function lineSegs(e: Embed): [V2, V2][] {
  const out: [V2, V2][] = [];
  const pts = e.pts ?? [];
  for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i], pts[i + 1]) > 0.5) out.push([pts[i], pts[i + 1]]);
  return out;
}
/** Grundriss-Band eines Segments aus dem Profil (n-Ausdehnung) */
function segBand(a: V2, b: V2, n0: number, n1: number): V2[] {
  const n = perp(norm(sub(b, a)));
  return [add(a, mul(n, n0)), add(b, mul(n, n0)), add(b, mul(n, n1)), add(a, mul(n, n1))];
}

function drawEmbedPlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx;
  const e = eff(doc, el); if (!e) return;
  const [za, zb] = zRange(doc, e);
  if (ctx.ceiling ? zb < ctx.cutZ - 1 || za > ctx.topZ + 1 : zb < ctx.depthZ - 1 || za > ctx.topZ + 1) return;
  const f = familyOf(doc, e); const s = dl.scale; const col = pen(doc, e).color!;
  const fine = ctx.detail === 'fine';
  switch (f) {
    case 'waterstop': {
      if (e.mode === 'vertical') {
        const p = e.p ?? { x: 0, y: 0 }; const d = fromAngle(e.rot ?? 0);
        const lo = P(doc, e, 'lo'), hi = P(doc, e, 'hi');
        dl.line(add(p, mul(d, -lo)), add(p, mul(d, hi)), { w: 5, color: col });
        dl.circle(p, 0.6 * s, undefined, { color: col }, { ns: true });
        return;
      }
      for (const [a, b] of lineSegs(e)) {
        if (e.mode === 'lying') {
          const band = segBand(a, b, -P(doc, e, 'lo'), P(doc, e, 'hi'));
          dl.poly(band, { w: 1, color: col, dash: 'hidden' }, true);
        }
        dl.line(a, b, { w: 4, color: col, dash: 'dash' });
      }
      return;
    }
    case 'rebarBox': case 'anchorChannel': case 'coupler': {
      if (f === 'coupler' && !e.pts) {
        const p = e.p ?? { x: 0, y: 0 }; const r = Math.max((P(doc, e, 'dia') + 12) / 2, 0.9 * s);
        dl.circle(p, r, { w: 2, color: col }, { color: '#ffffff' });
        dl.line(add(p, { x: -r, y: -r }), add(p, { x: r, y: r }), { w: 1, color: col }, { ns: true });
        dl.line(add(p, { x: -r, y: r }), add(p, { x: r, y: -r }), { w: 1, color: col }, { ns: true });
        if (!e.vert) { const d = fromAngle(e.rot ?? 0); dl.line(p, add(p, mul(d, P(doc, e, 'L'))), { w: 2, color: col, dash: 'dash' }, { ns: true }); }
        return;
      }
      const pr = profileOf(doc, e);
      const n0 = Math.min(...pr.map((q) => q.x)), n1 = Math.max(...pr.map((q) => q.x));
      // Mindestbreite 0.8 mm Papier, damit das Band lesbar bleibt
      const minW = 0.8 * s; let a0 = n0, a1 = n1;
      if (a1 - a0 < minW) {
        if (Math.abs(n0) < 1e-6) a1 = Math.max(n1, minW);
        else if (Math.abs(n1) < 1e-6) a0 = Math.min(n0, -minW);
        else { const m = (a0 + a1) / 2; a0 = m - minW / 2; a1 = m + minW / 2; }
      }
      const fill: Fill = f === 'rebarBox' ? { color: '#fde3e3', pattern: 'cross', patColor: col } : f === 'coupler' ? { color: col, pattern: 'solid', patColor: col } : { color: '#efe5fb' };
      for (const [a, b] of lineSegs(e)) {
        dl.fill([segBand(a, b, Math.min(a0, a1), Math.max(a0, a1))], fill, { w: 2, color: col });
        if (f === 'anchorChannel') dl.line(a, b, { w: 3, color: col });
        if (f === 'coupler' && e.face !== 'h' && (fine || ctx.detail === 'medium')) {
          // Stäbe (gestrichelt) in den Beton
          const L = P(doc, e, 'L'); const n = perp(norm(sub(b, a))); const side = e.side ?? 1;
          for (const q of couplerPositions(doc, e)) if (q.seg[0] === a) dl.line(q.p, add(q.p, mul(n, side * L)), { w: 1, color: col, dash: 'hidden' }, { ns: true });
        }
      }
      return;
    }
    case 'conduit': {
      const sys = embedType(doc, e)?.system ?? 'elektro';
      const d = P(doc, e, 'dia');
      const dash: Pen['dash'] = sys === 'elektro' ? 'dash' : undefined;
      const c2 = sys === 'lueftung' ? '#1d1d1d' : col;
      for (const [a, b] of lineSegs(e)) {
        if (fine && d / s > 0.5) { for (const k of [-0.5, 0.5]) { const n = mul(perp(norm(sub(b, a))), d * k); dl.line(add(a, n), add(b, n), { w: 1, color: c2, dash }); } dl.line(a, b, { w: 1, color: c2, dash: 'center' }, { inv: true }); }
        else dl.line(a, b, { w: 2, color: c2, dash });
      }
      return;
    }
    case 'box': {
      const t = embedType(doc, e); const p = e.p ?? { x: 0, y: 0 };
      const c2 = t?.system === 'lueftung' ? '#1d1d1d' : col;
      if (t?.round) { const r = P(doc, e, 'w') / 2; dl.circle(p, r, { w: 2, color: c2 }, { color: '#ffffff' }); return; }
      const ring = boxRing(doc, e);
      dl.fill([ring], { color: '#ffffff' }, { w: 2, color: c2 });
      dl.line(ring[0], ring[2], { w: 1, color: c2 }, { ns: true }); dl.line(ring[1], ring[3], { w: 1, color: c2 }, { ns: true });
      return;
    }
    case 'punching': {
      const head = P(doc, e, 'head');
      for (const r of punchRails(doc, e)) {
        dl.line(r.a, r.b, { w: 2, color: col });
        for (const q of r.studs) dl.circle(q, Math.max(head / 2, 0.45 * s), undefined, { color: RED }, { ns: true });
      }
      return;
    }
    case 'sleeve': {
      const g = sleeveGeo(doc, e); if (!g) return;
      const { F, u, r } = g;
      const above = g.z - r > ctx.cutZ;
      const pp: Pen = { w: 2, color: col, dash: above ? 'hidden' : undefined };
      dl.poly([F.P(u - r, g.v0), F.P(u + r, g.v0), F.P(u + r, g.v1), F.P(u - r, g.v1)], pp, true);
      const fl = P(doc, e, 'flange') / 2;
      if (fl > r) dl.line(F.P(u - fl, 0), F.P(u + fl, 0), { w: 3, color: col });
      coreSymbol(dl, F.P(u, 0), Math.max(Math.min(r, F.wi.T * 0.45), 1.2 * s), { w: 1, color: col }, { sub: 'symbol' });
      return;
    }
  }
}

export function boxRing(doc: Doc, e: Embed): V2[] {
  const p = e.p ?? { x: 0, y: 0 }; const w = P(doc, e, 'w') / 2, l = P(doc, e, 'l') / 2; const r = e.rot ?? 0;
  return [{ x: -w, y: -l }, { x: w, y: -l }, { x: w, y: l }, { x: -w, y: l }].map((q) => add(p, rotate(q, r)));
}

/** Stabpositionen eines Schraubanschlusses (Linie): je Segment im Abstand s, Randabstand s/2 */
export function couplerPositions(doc: Doc, e: Embed): { p: V2; seg: [V2, V2] }[] {
  const out: { p: V2; seg: [V2, V2] }[] = [];
  const segs = lineSegs(e); const L = segs.reduce((acc, [a, b]) => acc + dist(a, b), 0);
  if (!L) return out;
  const s = P(doc, e, 's');
  const n = Math.max(1, e.count ?? Math.floor((L - 1) / s) + 1);
  const step = n > 1 ? Math.min(s, L / n) : 0; const start = (L - step * (n - 1)) / 2;
  let acc = 0; let k = 0;
  for (const [a, b] of segs) {
    const sl = dist(a, b);
    while (k < n && start + k * step <= acc + sl + 1e-6) { out.push({ p: lerp(a, b, (start + k * step - acc) / sl), seg: [a, b] }); k++; }
    acc += sl;
  }
  return out;
}

// ------------------------------------------------------------ 3D
const UP: V3 = { x: 0, y: 0, z: 1 };
const v3 = (p: V2, z: number): V3 => ({ x: p.x, y: p.y, z });
function cyl(a: V3, dir: V3, r: number, len: number, n = 8): Face[] {
  // Achse dir (normiert), Querachsen u/v
  const ref = Math.abs(dir.z) > 0.9 ? { x: 1, y: 0, z: 0 } : UP;
  const u = norm3(cross3(dir, ref)), v = cross3(dir, u);
  return extrudeProfile(circleRing({ x: 0, y: 0 }, r, n), a, u, v, dir, len);
}
const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm3 = (a: V3): V3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

/** Rohr (hohl): Achse dir, Innen-/Aussenradius */
function tube(a: V3, dir: V3, rO: number, rI: number, len: number, n = 20): Face[] {
  const ref = Math.abs(dir.z) > 0.9 ? { x: 1, y: 0, z: 0 } : UP;
  const u = norm3(cross3(dir, ref)), v = cross3(dir, u);
  const P3 = (r: number, k: number, t: number): V3 => {
    const ang = (k / n) * Math.PI * 2; const c = Math.cos(ang) * r, s = Math.sin(ang) * r;
    return { x: a.x + u.x * c + v.x * s + dir.x * t, y: a.y + u.y * c + v.y * s + dir.y * t, z: a.z + u.z * c + v.z * s + dir.z * t };
  };
  const faces: Face[] = [];
  for (let k = 0; k < n; k++) {
    faces.push({ pts: [P3(rO, k, 0), P3(rO, k + 1, 0), P3(rO, k + 1, len), P3(rO, k, len)] });
    faces.push({ pts: [P3(rI, k + 1, 0), P3(rI, k, 0), P3(rI, k, len), P3(rI, k + 1, len)] });
  }
  const ringAt = (r: number, t: number) => Array.from({ length: n }, (_, k) => P3(r, k, t));
  faces.push({ pts: ringAt(rO, len), holes: [ringAt(rI, len).reverse()] });
  faces.push({ pts: ringAt(rO, 0).reverse(), holes: [ringAt(rI, 0)] });
  return faces;
}

function embedSolids(doc: Doc, el: El): Solid[] {
  const e = eff(doc, el); if (!e) return [];
  const t = embedType(doc, e); const f = familyOf(doc, e);
  const color = t?.color ?? FAMILIES[f].color; const mat = t?.mat;
  const z = zAbs(doc, e);
  const out: Solid[] = [];
  const S = (faces: Face[], c = color, m = mat) => { if (faces.length) out.push({ faces, color: c, mat: m }); };
  switch (f) {
    case 'waterstop': {
      if (e.mode === 'vertical') {
        const p = e.p ?? { x: 0, y: 0 }; const d = fromAngle(e.rot ?? 0); const n = perp(d);
        const lo = P(doc, e, 'lo'), hi = P(doc, e, 'hi'), th = Math.max(1, P(doc, e, 't'));
        const o = add(add(p, mul(d, -lo)), mul(n, -th / 2));
        S(box3(v3(o, z), v3(mul(d, lo + hi), 0), v3(mul(n, th), 0), { x: 0, y: 0, z: e.h2 ?? 3000 }));
        return out;
      }
      break;
    }
    case 'coupler': {
      const dia = P(doc, e, 'dia'), L = P(doc, e, 'L'), mL = P(doc, e, 'mL');
      if (!e.pts) {
        const p = e.p ?? { x: 0, y: 0 };
        const dir: V3 = e.vert ? UP : v3(fromAngle(e.rot ?? 0), 0);
        S(cyl(v3(p, z), dir, (dia + 12) / 2, mL), '#606060', 'm_stahl');
        S(cyl(v3(p, z), dir, dia / 2, L), '#8b1a1a', 'm_betonstahl');
        return out;
      }
      const side = e.side ?? 1;
      for (const q of couplerPositions(doc, e)) {
        const n = perp(norm(sub(q.seg[1], q.seg[0])));
        const dir: V3 = e.face === 'h' ? { x: 0, y: 0, z: -side } : v3(mul(n, side), 0);
        S(cyl(v3(q.p, z), dir, (dia + 12) / 2, mL), '#606060', 'm_stahl');
        S(cyl(v3(q.p, z), dir, dia / 2, L), '#8b1a1a', 'm_betonstahl');
      }
      return out;
    }
    case 'box': {
      const h = P(doc, e, 'h');
      if (t?.round) S(prism(circleRing(e.p ?? { x: 0, y: 0 }, P(doc, e, 'w') / 2, 16), z, z + h));
      else S(prism(boxRing(doc, e), z, z + h));
      return out;
    }
    case 'punching': {
      const dia = P(doc, e, 'dia'), head = P(doc, e, 'head'), hs = P(doc, e, 'hs');
      for (const r of punchRails(doc, e)) {
        const d = norm(sub(r.b, r.a)); const n = perp(d);
        S(box3(v3(add(r.a, mul(n, -12)), z - 5), v3(sub(r.b, r.a), 0), v3(mul(n, 24), 0), { x: 0, y: 0, z: 5 }), '#5a6a80', 'm_stahl');
        for (const q of r.studs) {
          S(cyl(v3(q, z), UP, dia / 2, hs, 8), RED, 'm_betonstahl');
          S(cyl(v3(q, z + hs - 10), UP, head / 2, 10, 10), RED, 'm_betonstahl');
        }
      }
      return out;
    }
    case 'sleeve': {
      const g = sleeveGeo(doc, e); if (!g) return out;
      const a = g.F.P3(g.u, g.v0, g.z); const dir = v3(g.F.wi.n, 0);
      S(tube(a, dir, g.r, g.ri, g.len));
      const fl = P(doc, e, 'flange') / 2;
      if (fl > g.r) S(tube(g.F.P3(g.u, -5, g.z), dir, fl, g.r, 10));
      return out;
    }
  }
  // Linienelemente: Profil entlang der Polylinie extrudieren
  const pr = profileOf(doc, e);
  for (const [a, b] of lineSegs(e)) {
    const d = norm(sub(b, a)); const n = perp(d);
    S(extrudeProfile(pr, v3(a, z), v3(n, 0), UP, v3(d, 0), dist(a, b)));
  }
  return out;
}

// ------------------------------------------------------------ Schnitt / Ansicht: Symbole
function drawEmbedSection(ctx: SectionCtx, el: El): void {
  const { doc, dl } = ctx;
  const e = eff(doc, el); if (!e) return;
  const f = familyOf(doc, e); const col = pen(doc, e).color!; const s = dl.scale;
  const z = zAbs(doc, e);
  const near = (p: V3, tol: number) => { const d = ctx.depth(p); return d > -tol && d < tol; };
  if (f === 'waterstop' && e.mode === 'vertical') {
    const p = e.p ?? { x: 0, y: 0 }; const d = fromAngle(e.rot ?? 0);
    if (!near(v3(p, z), 400)) return;
    const a = ctx.toView(v3(add(p, mul(d, -P(doc, e, 'lo'))), z)), b = ctx.toView(v3(add(p, mul(d, P(doc, e, 'hi'))), z));
    const h2 = e.h2 ?? 3000;
    if (Math.abs(a.x - b.x) < 0.8 * s) { const x = (a.x + b.x) / 2; dl.line({ x, y: a.y }, { x, y: a.y + h2 }, { w: 5, color: col }); }
    else dl.poly([a, b, { x: b.x, y: b.y + h2 }, { x: a.x, y: a.y + h2 }], { w: 2, color: col, dash: 'dash' }, true);
    return;
  }
  if (f === 'punching') {
    const hs = P(doc, e, 'hs'), head = P(doc, e, 'head');
    for (const r of punchRails(doc, e)) for (const q of r.studs) {
      if (!near(v3(q, z), Math.max(60, head))) continue;
      const a = ctx.toView(v3(q, z)), b = ctx.toView(v3(q, z + hs));
      dl.line(a, b, { w: 4, color: RED });
      dl.line({ x: a.x - head / 2, y: a.y }, { x: a.x + head / 2, y: a.y }, { w: 4, color: RED }, { ns: true });
      dl.line({ x: b.x - head / 2, y: b.y }, { x: b.x + head / 2, y: b.y }, { w: 4, color: RED }, { ns: true });
    }
    return;
  }
  if (f === 'sleeve') {
    const g = sleeveGeo(doc, e); if (!g) return;
    const c3 = g.F.P3(g.u, 0, g.z);
    const along = Math.abs(dot(g.F.wi.d, { x: ctx.right.x, y: ctx.right.y }));
    if (along > 0.7 && ctx.depth(c3) > -g.F.wi.T && ctx.depth(c3) < ctx.far) {
      // Wandabwicklung: Rohr als Kreis
      const c = ctx.toView(c3);
      dl.circle(c, g.r, { w: 2, color: col }); dl.circle(c, g.ri, { w: 1, color: col });
      const fl = P(doc, e, 'flange') / 2; if (fl > g.r) dl.circle(c, fl, { w: 1, color: col, dash: 'hidden' });
    }
    return;
  }
  if (f === 'box' || (f === 'coupler' && !e.pts)) return; // Körper genügen
  // Linienelemente: Durchstosspunkte durch die Schnittebene → Profil; parallele Stücke nahe der Ebene → Umriss
  const pr = profileOf(doc, e);
  for (const [a, b] of lineSegs(e)) {
    const A = v3(a, z), B = v3(b, z); const da = ctx.depth(A), db = ctx.depth(B);
    const d = norm(sub(b, a)); const n = perp(d);
    if ((da < 0) !== (db < 0)) {
      const X = lerp(a, b, da / (da - db));
      const ring = pr.map((q) => ctx.toView(v3(add(X, mul(n, q.x)), z + q.y)));
      if (f === 'conduit') { const c = ctx.toView(v3(X, z)); dl.circle(c, Math.max(P(doc, e, 'dia') / 2, 0.4 * s), { w: 2, color: col }, { color: '#ffffff' }); }
      else if (f === 'waterstop') {
        // Fugenblech im Schnitt: kräftige rote Linie
        const ys = ring.map((q) => q.y), xs = ring.map((q) => q.x);
        const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
        if (hh >= w) { const x = (Math.max(...xs) + Math.min(...xs)) / 2; dl.line({ x, y: Math.min(...ys) }, { x, y: Math.max(...ys) }, { w: 5, color: col }); }
        else { const y = (Math.max(...ys) + Math.min(...ys)) / 2; dl.line({ x: Math.min(...xs), y }, { x: Math.max(...xs), y }, { w: 5, color: col }); }
      } else dl.fill([ring], { color: f === 'rebarBox' ? '#fde3e3' : f === 'coupler' ? col : '#efe5fb' }, { w: 2, color: col });
      if (f === 'rebarBox') {
        // Bügel: im Beton (ausgezogen, Länge hB) und nach dem Zurückbiegen aus der Fläche (gestrichelt)
        const hB = P(doc, e, 'hB'); const side = e.side ?? 1; const bw = P(doc, e, 'bw');
        // k > 0: in den Beton, k < 0: aus der Fläche heraus
        const at = (off: number, k: number): V3 => (e.face === 'h' ? v3(add(X, mul(n, off)), z - side * k) : v3(add(X, mul(n, side * k)), z + off));
        const legs = [-bw / 2 + 15, bw / 2 - 15];
        for (const off of legs) {
          dl.line(ctx.toView(at(off, 0)), ctx.toView(at(off, hB)), { w: 1, color: col }, { ns: true });
          dl.line(ctx.toView(at(off, 0)), ctx.toView(at(off, -hB)), { w: 1, color: col, dash: 'hidden' }, { ns: true });
        }
        dl.line(ctx.toView(at(legs[0], hB)), ctx.toView(at(legs[1], hB)), { w: 1, color: col }, { ns: true });
      }
      continue;
    }
    // parallel und nahe (Abwicklung): Umriss gestrichelt
    if (Math.abs(da - db) < 1 + 0.05 * dist(a, b) && da > -300 && da < 600) {
      const y0 = Math.min(...pr.map((q) => q.y)), y1 = Math.max(...pr.map((q) => q.y));
      const pa = ctx.toView(v3(a, z + y0)), pb = ctx.toView(v3(b, z + y0)), pc = ctx.toView(v3(b, z + y1)), pd = ctx.toView(v3(a, z + y1));
      if (f === 'waterstop' || f === 'conduit') dl.line(ctx.toView(A), ctx.toView(B), { w: f === 'waterstop' ? 4 : 2, color: col, dash: 'dash' });
      if (f !== 'conduit') dl.poly([pa, pb, pc, pd], { w: 1, color: col, dash: f === 'waterstop' ? 'hidden' : undefined }, true);
    }
  }
}

// ------------------------------------------------------------ Texte
export function embedTagText(doc: Doc, el: El): string {
  const e = eff(doc, el) ?? (el as Embed);
  const t = embedType(doc, e); const f = familyOf(doc, e);
  const prod = t?.product ? ` (${t.product})` : '';
  const name = t?.name ?? FAMILIES[f].label;
  switch (f) {
    case 'waterstop': return `${name} (${fmtMm(P(doc, e, 'lo'))}/${fmtMm(P(doc, e, 'hi'))})`;
    case 'rebarBox': return `Rückbiegeanschluss Ø${fmtMm(P(doc, e, 'dia'))}/${fmtMm(P(doc, e, 's'))}, Bügelhöhe ${fmtM(P(doc, e, 'hB'))} m, L = ${fmtM(plen(e.pts))} m${prod}`;
    case 'coupler': {
      const c = t?.coupler;
      if (!e.pts) return `Muffenstab Ø${fmtMm(P(doc, e, 'dia'))}, L = ${fmtM(P(doc, e, 'L'))} m${c?.product ? ' (' + c.product + ')' : ''}`;
      return `${couplerPositions(doc, e).length} Muffenstäbe Ø${fmtMm(P(doc, e, 'dia'))}, L = ${fmtM(P(doc, e, 'L'))} m${c?.product ? ' (' + c.product + ')' : prod}`;
    }
    case 'punching': return `Durchstanzbewehrung ${e.n ?? 8} × ${t?.product ?? name}, ${e.pattern === 'ortho' ? 'orthogonal' : 'radial'}, Abstände ${(e.dists ?? [90, 145, 145]).map(fmtMm).join(' / ')} mm`;
    case 'anchorChannel': return `Ankerschiene ${t?.product ?? name}, L = ${fmtMm(plen(e.pts) || P(doc, e, 'L'))} mm`;
    case 'sleeve': return `Futterrohr Ø${fmtMm(P(doc, e, 'dia'))}${P(doc, e, 'flange') > 0 ? ' mit Dichtflansch' : ''}, Achse ${fmtKote(zAbs(doc, e))}`;
    case 'conduit': return t?.product ?? name;
    case 'box': return t?.product ?? name;
  }
}

/** Anzahl Stück (Stäbe, Anker, Elemente) */
export function embedCount(doc: Doc, el: El): number {
  const e = eff(doc, el); if (!e) return 0;
  const f = familyOf(doc, e);
  if (f === 'coupler' && e.pts) return couplerPositions(doc, e).length;
  if (f === 'punching') return punchRails(doc, e).length;
  if (f === 'rebarBox') return Math.max(1, Math.floor(plen(e.pts) / P(doc, e, 's')) + 1);
  return 1;
}
export function embedLength(doc: Doc, el: El): number {
  const e = eff(doc, el); if (!e) return 0;
  const f = familyOf(doc, e);
  if (f === 'waterstop' && e.mode === 'vertical') return e.h2 ?? 0;
  if (f === 'sleeve') return sleeveGeo(doc, e)?.len ?? 0;
  if (f === 'coupler' && !e.pts) return P(doc, e, 'L');
  if (f === 'punching') return 0;
  return plen(e.pts);
}

// ------------------------------------------------------------ IFC
function embedIfc(el: El, doc: Doc) {
  const e = eff(doc, el) ?? (el as Embed); const t = embedType(doc, e); const f = familyOf(doc, e);
  const base: Record<string, string | number | boolean> = { Familie: FAMILIES[f].label, Typ: t?.name ?? '', Produkt: t?.product ?? t?.name ?? '' };
  if (t?.maker) base.Hersteller = t.maker;
  const L = embedLength(doc, el); if (L) base.Laenge_mm = Math.round(L);
  const n = embedCount(doc, el); if (n > 1) base.Anzahl = n;
  if (el.mark) base.Kennzeichen = el.mark;
  const psets: Record<string, Record<string, string | number | boolean>> = { CH_Einlage: base };
  const name = embedTagText(doc, el);
  switch (f) {
    case 'waterstop': Object.assign(base, { Hoehe_mm: P(doc, e, 'h'), Dicke_mm: P(doc, e, 't'), Lage: `${fmtMm(P(doc, e, 'lo'))}/${fmtMm(P(doc, e, 'hi'))}` }); return { entity: 'IfcDiscreteAccessory', predefined: 'USERDEFINED', name, psets };
    case 'rebarBox': Object.assign(base, { Durchmesser_mm: P(doc, e, 'dia'), Abstand_mm: P(doc, e, 's'), Buegelhoehe_mm: P(doc, e, 'hB') }); return { entity: 'IfcReinforcingBar', predefined: 'USERDEFINED', name, psets };
    case 'coupler': {
      Object.assign(base, { Durchmesser_mm: P(doc, e, 'dia'), Stablaenge_mm: P(doc, e, 'L'), Abstand_mm: P(doc, e, 's') });
      const c = t?.coupler; if (c) psets.CH_Muffe = Object.fromEntries(Object.entries({ System: c.system, Produkt: c.product, Durchmesser_mm: c.dia, Gewinde: c.thread, Muffenlaenge_mm: c.sleeveLen, TeilA: c.partA, TeilB: c.partB }).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string | number>;
      return { entity: 'IfcMechanicalFastener', predefined: 'COUPLER', name, psets };
    }
    case 'punching': Object.assign(base, { Anordnung: e.pattern === 'ortho' ? 'orthogonal' : 'radial', Elemente: e.n ?? 8, Abstaende_mm: (e.dists ?? []).join('/'), Ankerhoehe_mm: P(doc, e, 'hs'), AnkerDurchmesser_mm: P(doc, e, 'dia') }); return { entity: 'IfcReinforcingBar', predefined: 'PUNCHING', name, psets };
    case 'anchorChannel': return { entity: 'IfcMechanicalFastener', predefined: 'USERDEFINED', name, psets };
    case 'sleeve': Object.assign(base, { Innendurchmesser_mm: P(doc, e, 'dia'), Dichtflansch_mm: P(doc, e, 'flange'), AchsKote_m: Math.round(zAbs(doc, e)) / 1000 }); return { entity: 'IfcPipeSegment', predefined: 'RIGIDSEGMENT', name, psets };
    case 'conduit': {
      Object.assign(base, { Durchmesser_mm: P(doc, e, 'dia'), System: t?.system ?? 'elektro' });
      return t?.system === 'lueftung' ? { entity: 'IfcDuctSegment', predefined: 'RIGIDSEGMENT', name, psets } : t?.system === 'sanitaer' ? { entity: 'IfcPipeSegment', predefined: 'RIGIDSEGMENT', name, psets } : { entity: 'IfcCableCarrierSegment', predefined: 'CONDUITSEGMENT', name, psets };
    }
    case 'box': return t?.system === 'lueftung' ? { entity: 'IfcDuctFitting', predefined: 'JUNCTION', name, psets } : { entity: 'IfcJunctionBox', predefined: 'POWER', name, psets };
  }
}

// ------------------------------------------------------------ Eigenschaften
type PSpec = [string, string, 'len' | 'int'];
const TYPE_PARAMS: Record<Family, PSpec[]> = {
  waterstop: [['h', 'Höhe', 'len'], ['t', 'Dicke', 'len'], ['lo', 'Lage unten / links', 'len'], ['hi', 'Lage oben / rechts', 'len']],
  rebarBox: [['dia', 'Stab-Ø', 'len'], ['s', 'Abstand s', 'len'], ['hB', 'Bügelhöhe', 'len'], ['bw', 'Kastenbreite', 'len'], ['bd', 'Kastentiefe', 'len']],
  coupler: [['dia', 'Stab-Ø', 'len'], ['s', 'Abstand s', 'len'], ['L', 'Stablänge', 'len'], ['mL', 'Muffenlänge', 'len']],
  punching: [['dia', 'Anker-Ø', 'len'], ['head', 'Kopf-Ø', 'len'], ['hs', 'Ankerhöhe', 'len'], ['nA', 'Anker je Element', 'int']],
  anchorChannel: [['bw', 'Schienenbreite', 'len'], ['bd', 'Schienenhöhe', 'len'], ['L', 'Länge', 'len']],
  sleeve: [['dia', 'Innen-Ø', 'len'], ['wt', 'Rohrwandstärke', 'len'], ['flange', 'Dichtflansch-Ø', 'len']],
  conduit: [['dia', 'Rohr-Ø', 'len']],
  box: [['w', 'Breite / Ø', 'len'], ['l', 'Länge', 'len'], ['h', 'Höhe', 'len']],
};
/** Instanzwerte, die den Typ überschreiben dürfen */
const INST_PARAMS: Record<Family, string[]> = { waterstop: ['lo', 'hi'], rebarBox: ['s', 'hB'], coupler: ['s', 'L'], punching: ['hs'], anchorChannel: [], sleeve: ['dia'], conduit: [], box: [] };

function embedTypeProps(type: El): PropDef[] {
  const g = GROUPS; const f = (type.family ?? 'waterstop') as Family;
  const p: PropDef[] = [
    { key: 'family', label: 'Familie', group: g.construction, type: 'readonly', get: (t) => FAMILIES[(t.family ?? 'waterstop') as Family].label },
    { key: 'product', label: 'Produkt', group: g.identity, type: 'text', get: (t) => t.product ?? '', set: (_t, v) => ({ product: v || undefined }) },
    { key: 'maker', label: 'Hersteller', group: g.identity, type: 'text', get: (t) => t.maker ?? '', set: (_t, v) => ({ maker: v || undefined }) },
  ];
  for (const [k, label, kind] of TYPE_PARAMS[f]) p.push({ key: k, label, group: g.dims, type: kind === 'int' ? 'int' : 'length', get: (t) => t[k] ?? DEF[k], set: (_t, v) => (v >= 0 ? { [k]: v } : undefined) });
  if (f === 'conduit' || f === 'box') p.push({ key: 'system', label: 'System', group: g.construction, type: 'select', options: [['elektro', 'Elektro'], ['lueftung', 'Lüftung'], ['sanitaer', 'Sanitär']], get: (t) => t.system ?? 'elektro', set: (_t, v) => ({ system: v }) });
  if (f === 'box') p.push({ key: 'round', label: 'Rund', group: g.construction, type: 'bool', get: (t) => !!t.round, set: (_t, v) => ({ round: v }) });
  if (f === 'coupler') {
    const cp = (k: keyof CouplerData, label: string): PropDef => ({ key: 'cp_' + k, label, group: 'Muffe (ABS)', type: 'text', get: (t) => String(t.coupler?.[k] ?? ''), set: (t, v) => ({ coupler: { ...(t.coupler ?? {}), [k]: k === 'dia' || k === 'sleeveLen' ? (parseFloat(v) || undefined) : v || undefined } }) });
    p.push(cp('system', 'System'), cp('product', 'Muffentyp'), cp('dia', 'Ø'), cp('thread', 'Gewinde'), cp('sleeveLen', 'Muffenlänge'), cp('partA', 'Teil A'), cp('partB', 'Teil B'));
  }
  p.push(
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? FAMILIES[f].color, set: (_t, v) => ({ color: v }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  );
  return p;
}

function embedProps(el: El, doc: Doc): PropDef[] {
  const g = GROUPS; const f = familyOf(doc, el); const derived = !!(el.hostId && derivers.has(doc.get(el.hostId)?.cat ?? ''));
  const p: PropDef[] = [{ key: 'familyRo', label: 'Familie', group: g.identity, type: 'readonly', get: () => FAMILIES[f].label }];
  if (el.hostId) p.push({ key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, d) => { const h = d.get(e.hostId); return h ? (catDef(h.cat)?.label ?? h.cat) + (h.mark ? ' ' + h.mark : '') : '–'; } });
  if (!derived) {
    p.push({ key: 'levelId', label: 'Ebene', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (e, v, d) => ({ levelId: v, z: (e.z ?? 0) + levelElev(d, e.levelId) - levelElev(d, v) }) });
    p.push({ key: 'z', label: f === 'sleeve' ? 'Achshöhe über Ebene' : f === 'box' || f === 'punching' ? 'Unterkante über Ebene' : 'Höhe über Ebene', group: g.constraints, type: 'length', get: (e) => e.z ?? 0, set: (_e, v) => ({ z: v }) });
  }
  p.push({ key: 'zAbs', label: f === 'sleeve' ? 'Achse (Kote)' : 'Höhe (Kote)', group: g.constraints, type: 'readonly', get: (e, d) => { const x = eff(d, e); return x ? fmtKote(zAbs(d, x)) : ''; } });
  if (f === 'waterstop' && !derived) p.push({ key: 'mode', label: 'Lage', group: g.construction, type: 'select', options: [['standing', 'stehend (horizontale Fuge)'], ['lying', 'liegend (Plattenfuge)'], ['vertical', 'senkrecht (Wandfuge)']], get: (e) => e.mode ?? 'standing', set: (_e, v) => ({ mode: v }) });
  if (f === 'waterstop' && el.mode === 'vertical' && !derived) p.push({ key: 'h2', label: 'Länge (senkrecht)', group: g.dims, type: 'length', get: (e) => e.h2 ?? 3000, set: (_e, v) => ({ h2: Math.max(10, v) }) });
  if ((f === 'rebarBox' || f === 'anchorChannel' || f === 'coupler') && !derived) {
    p.push({ key: 'face', label: 'Fläche', group: g.construction, type: 'select', options: [['v', 'Wand-/Stirnfläche (senkrecht)'], ['h', 'Plattenfläche (waagrecht)']], get: (e) => e.face ?? 'v', set: (_e, v) => ({ face: v }) });
    p.push({ key: 'side', label: 'Betonseite', group: g.construction, type: 'select', options: [['1', 'links / oben'], ['-1', 'rechts / unten']], get: (e) => String(e.side ?? 1), set: (_e, v) => ({ side: v === '-1' ? -1 : 1 }) });
  }
  if (f === 'coupler') {
    if (el.pts) p.push({ key: 'count', label: 'Anzahl Stäbe (leer = aus Abstand)', group: g.construction, type: 'text', get: (e) => (e.count ? String(e.count) : ''), set: (_e, v) => ({ count: parseInt(v, 10) > 0 ? parseInt(v, 10) : undefined }) });
    else p.push({ key: 'vert', label: 'Senkrecht', group: g.construction, type: 'bool', get: (e) => !!e.vert, set: (_e, v) => ({ vert: v }) });
  }
  if (f === 'punching') {
    p.push(
      { key: 'pattern', label: 'Anordnung', group: g.construction, type: 'select', options: [['radial', 'radial'], ['ortho', 'orthogonal']], get: (e) => e.pattern ?? 'radial', set: (_e, v) => ({ pattern: v }) },
      { key: 'n', label: 'Anzahl Elemente', group: g.construction, type: 'int', get: (e) => e.n ?? 8, set: (_e, v) => (v >= 1 ? { n: Math.round(v) } : undefined) },
      { key: 'dists', label: 'Abstände ab Stützenrand (mm)', group: g.construction, type: 'text', get: (e) => (e.dists ?? [90, 145, 145]).join(' / '), set: (_e, v) => { const a = String(v).split(/[\s/;,]+/).map((x) => parseFloat(x)).filter((x) => isFinite(x) && x >= 0); return a.length ? { dists: a } : undefined; } },
    );
  }
  for (const k of INST_PARAMS[f]) {
    const spec = TYPE_PARAMS[f].find((x) => x[0] === k); if (!spec) continue;
    p.push({ key: 'i_' + k, label: spec[1] + ' (Instanz)', group: g.dims, type: 'length', get: (e, d) => par(d, e, k as any, DEF[k]), set: (_e, v) => ({ [k]: v > 0 ? v : undefined }) });
  }
  p.push(
    { key: 'len', label: 'Länge', group: g.dims, type: 'readonly', get: (e, d) => fmtM(embedLength(d, e)) + ' m' },
    { key: 'cnt', label: 'Anzahl', group: g.dims, type: 'readonly', get: (e, d) => String(embedCount(d, e)) },
    { key: 'text', label: 'Beschriftung', group: g.text, type: 'readonly', get: (e, d) => embedTagText(d, e) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  );
  return p;
}

// ------------------------------------------------------------ Griffe / Transformation
function isDerived(doc: Doc, el: El): boolean { return !!(el.hostId && derivers.has(doc.get(el.hostId)?.cat ?? '')); }

function embedGrips(el: El, doc: Doc, view: View): Grip[] {
  if (!isPlanLike(view) || isDerived(doc, el)) return [];
  const f = familyOf(doc, el);
  if (f === 'sleeve' || f === 'punching') return [];
  if (el.pts) return (el.pts as V2[]).map((p, i) => ({ id: 'p:' + i, p, kind: 'end' as const, tip: 'Punkt verschieben' }));
  if (el.p) return [{ id: 'c', p: el.p, kind: 'end', tip: 'Verschieben' }];
  return [];
}

function embedTransform(el: El, m: Mat2, doc: Doc): Partial<El> | void {
  if (isDerived(doc, el)) return;
  const f = familyOf(doc, el);
  if (f === 'punching') return;
  if (f === 'sleeve') {
    const F = wallFrame(doc, el.hostId); if (!F) return;
    const q = apply(m, F.P(el.t ?? 0, 0)); return { t: Math.max(0, Math.min(F.wi.L, F.uOf(q))) };
  }
  const patch: Partial<Embed> = {};
  if (el.pts) patch.pts = (el.pts as V2[]).map((p) => apply(m, p));
  if (el.p) patch.p = apply(m, el.p);
  if (el.rot !== undefined || el.p) patch.rot = angleOf(applyVec(m, fromAngle(el.rot ?? 0)));
  if (m.a * m.d - m.b * m.c < 0 && el.side) patch.side = -el.side as 1 | -1;
  return patch;
}

// ------------------------------------------------------------ Kategorie
registerCategory({
  cat: 'embed', label: 'Einlage', plural: 'Einlagen', hasTypes: true, planOrder: 60, hostCats: ['wall', 'column', 'joint', 'lightwell'],
  drawPlan: drawEmbedPlan,
  drawSection: drawEmbedSection,
  solids: (el, doc) => embedSolids(doc, el),
  hostOpening: (el, doc) => {
    if (familyOf(doc, el) !== 'sleeve') return null;
    const e = eff(doc, el); if (!e) return null;
    const g = sleeveGeo(doc, e); if (!g) return null;
    return { u0: g.u - g.r, u1: g.u + g.r, z0: g.z - g.r, z1: g.z + g.r, profile: circleProfile(g.u, g.z, g.r) };
  },
  center: (el, doc) => {
    const e = eff(doc, el); if (!e) return null;
    const f = familyOf(doc, e);
    if (f === 'sleeve') { const g = sleeveGeo(doc, e); return g ? g.F.P(g.u, 0) : null; }
    if (f === 'punching') { const c = e.hostId ? doc.get(e.hostId) : null; return c?.p ?? e.p ?? null; }
    if (e.pts?.length) return polyMid(e.pts).p;
    return e.p ?? null;
  },
  tagPoint: (el, doc, view) => catDef('embed')!.center!(el, doc, view),
  tagText: (el, doc) => embedTagText(doc, el),
  ifc: (el, doc) => embedIfc(el, doc),
  grips: (el, doc, view) => embedGrips(el, doc, view),
  dragGrip: (el, id, p) => {
    if (id === 'c') return { p };
    const m = id.match(/^p:(\d+)$/); if (!m || !el.pts) return;
    const i = +m[1]; return { pts: (el.pts as V2[]).map((q, k) => (k === i ? p : q)) };
  },
  transform: (el, m, doc, view) => (isPlanLike(view) ? embedTransform(el, m, doc) : undefined),
  translate3d: (el, d, doc) => {
    if (isDerived(doc, el)) return;
    const f = familyOf(doc, el);
    if (f === 'sleeve') { const F = wallFrame(doc, el.hostId); return F ? { t: (el.t ?? 0) + d.x * F.wi.d.x + d.y * F.wi.d.y, z: (el.z ?? 0) + d.z } : undefined; }
    if (f === 'punching') return { z: (el.z ?? 0) + d.z };
    const mv = (p: V2) => ({ x: p.x + d.x, y: p.y + d.y });
    return { pts: el.pts ? (el.pts as V2[]).map(mv) : undefined, p: el.p ? mv(el.p) : undefined, z: (el.z ?? 0) + d.z };
  },
  curve: (el, doc, view) => (isPlanLike(view) && el.pts?.length === 2 && !isDerived(doc, el) ? { a: el.pts[0], b: el.pts[1] } : null),
  setCurve: (el, a, b) => (el.pts?.length === 2 ? { pts: [a, b] } : undefined),
  props: (el, doc) => embedProps(el, doc),
  typeProps: (t) => embedTypeProps(t),
  scheduleFields: () => [
    { key: 'family', label: 'Familie', get: (el, doc) => FAMILIES[familyOf(doc, el)].label },
    { key: 'type', label: 'Typ', get: (el, doc) => embedType(doc, el)?.name ?? '' },
    { key: 'product', label: 'Produkt', get: (el, doc) => embedType(doc, el)?.product ?? '' },
    { key: 'maker', label: 'Hersteller', get: (el, doc) => embedType(doc, el)?.maker ?? '' },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => embedLength(doc, el) },
    { key: 'count', label: 'Anzahl', unit: 'num', get: (el, doc) => embedCount(doc, el) },
    { key: 'dia', label: 'Ø', unit: 'len', get: (el, doc) => P(doc, el, 'dia') },
    { key: 'spacing', label: 'Abstand', unit: 'len', get: (el, doc) => (['rebarBox', 'coupler'].includes(familyOf(doc, el)) ? P(doc, el, 's') : '') },
    { key: 'elev', label: 'Höhe (Kote)', get: (el, doc) => { const e = eff(doc, el); return e ? fmtKote(zAbs(doc, e)) : ''; } },
    { key: 'host', label: 'Bauteil', get: (el, doc) => { const h = doc.get(el.hostId); return h ? (h.mark || (catDef(h.cat)?.label ?? h.cat)) : ''; } },
    { key: 'coupler', label: 'Muffe', get: (el, doc) => embedType(doc, el)?.coupler?.product ?? '' },
    { key: 'text', label: 'Beschreibung', get: (el, doc) => embedTagText(doc, el) },
  ],
  visibleIn: (el, doc, view) => (isPlanLike(view) || isSectionLike(view) || view.kind === '3d' ? !!eff(doc, el) : true),
});

// ------------------------------------------------------------ Vorlagentypen
const T = (id: string, family: Family, name: string, x: Partial<EmbedType> = {}): El => ({ id, cat: 'type', of: 'embed', family, name, ...x } as El);
export function embedTemplate(): El[] {
  return [
    T('emt_fb300', 'waterstop', 'Fugenblech 300 × 1,5 mm', { product: 'Fugenblech beschichtet 300/1.5', h: 300, t: 1.5, lo: 150, hi: 150, mat: 'm_stahl', color: RED }),
    T('emt_fband240', 'waterstop', 'Fugenband innenliegend 240', { product: 'Arbeitsfugenband AA 240 (PVC-P)', h: 240, t: 8, lo: 120, hi: 120, color: '#c0392b' }),
    T('emt_rba10', 'rebarBox', 'Rückbiegeanschluss Ø10/150', { product: 'z.B. Typ HBT/Stabox', dia: 10, s: 150, hB: 140, bw: 120, bd: 40, mat: 'm_stahl', color: RED }),
    T('emt_rba12', 'rebarBox', 'Rückbiegeanschluss Ø12/150', { product: 'z.B. Typ HBT/Stabox', dia: 12, s: 150, hB: 140, bw: 160, bd: 40, mat: 'm_stahl', color: RED }),
    T('emt_muffe12', 'coupler', 'Schraubanschluss Muffenstab Ø12', { product: 'Muffenstab Ø12 (Schraubanschluss)', dia: 12, s: 150, L: 1200, mL: 60, color: '#f08c1a', mat: 'm_stahl',
      coupler: { system: 'Lenton', product: 'Lenton A12 Standardmuffe', dia: 12, thread: 'M16', sleeveLen: 60, partA: 'Muffenstab (Muffe bündig Schalung)', partB: 'Anschlussstab mit Gewinde' } }),
    T('emt_muffe16', 'coupler', 'Schraubanschluss Muffenstab Ø16', { product: 'Muffenstab Ø16 (Schraubanschluss)', dia: 16, s: 150, L: 1400, mL: 70, color: '#f08c1a', mat: 'm_stahl',
      coupler: { system: 'Lenton', product: 'Lenton A16 Standardmuffe', dia: 16, thread: 'M20', sleeveLen: 70, partA: 'Muffenstab', partB: 'Anschlussstab mit Gewinde' } }),
    T('emt_dx3', 'punching', 'Doppelkopfanker auf Schienen 3 Anker', { product: 'ancoPLUS DX3-0225', maker: 'Ancotech', dia: 12, head: 36, hs: 225, nA: 3, color: '#1f5fd6', mat: 'm_betonstahl' }),
    T('emt_hta2815', 'anchorChannel', 'Ankerschiene HTA 28/15', { product: 'HTA 28/15', maker: 'Halfen', bw: 28, bd: 15, L: 300, mat: 'm_stahl', color: '#7b3fbf' }),
    T('emt_fr150', 'sleeve', 'Futterrohr Ø150 mit Dichtflansch', { product: 'Futterrohr Faserzement/PE mit Dichtflansch', dia: 150, wt: 8, flange: 260, color: '#1f3f9f' }),
    T('emt_fr200', 'sleeve', 'Futterrohr Ø200 mit Dichtflansch', { product: 'Futterrohr Faserzement/PE mit Dichtflansch', dia: 200, wt: 8, flange: 320, color: '#1f3f9f' }),
    T('emt_m20', 'conduit', 'Elektro-Leerrohr M20', { product: 'KRF M20', dia: 20, system: 'elektro', color: '#d020a0' }),
    T('emt_m25', 'conduit', 'Elektro-Leerrohr M25', { product: 'KRF M25', dia: 25, system: 'elektro', color: '#d020a0' }),
    T('emt_kwl75', 'conduit', 'KWL-Einlegerohr Ø75', { product: 'KWL-Einlegerohr Ø75', dia: 75, system: 'lueftung', color: '#1d1d1d' }),
    T('emt_kwlbox', 'box', 'KWL-Verteilkasten 600 × 400 × 170', { product: 'Verteilkasten KWL (einbetoniert, UK bündig)', w: 600, l: 400, h: 170, system: 'lueftung', color: '#1d1d1d' }),
    T('emt_dose120', 'box', 'Deckendose 120', { product: 'Deckendose 120 mm', w: 120, l: 120, h: 100, round: true, system: 'elektro', color: '#d020a0' }),
  ];
}
export function addEmbedTemplate(doc: Doc): void {
  if (!doc.get('m_betonstahl')) doc.add({ id: 'm_betonstahl', cat: 'material', name: 'Betonstahl B500B', color: '#8b1a1a', cutPattern: 'solid', cutColor: '#000000', density: 7850 } as El);
  if (!doc.get('m_stahl')) doc.add({ id: 'm_stahl', cat: 'material', name: 'Stahl S235', color: '#7a8590', cutPattern: 'solid', cutColor: '#303030', density: 7850 } as El);
  addMissing(doc, embedTemplate());
}
/** Typen einer Familie in Vorlagenreihenfolge (erster = Standard) */
export const typesOfFamily = (doc: Doc, f: Family) => doc.all<EmbedType>('type').filter((t) => t.of === 'embed' && t.family === f);
export { mid, polylineLength, slabAt, wallFrame };
