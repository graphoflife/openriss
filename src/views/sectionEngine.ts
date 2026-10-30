// Schnitt-/Projektionsmaschine: schneidet 3D-Körper (Solids) mit einer Ebene (Schnittfläche
// mit Materialschraffur) und projiziert die Flächen dahinter (Maleralgorithmus).
// Wird für Schnitte, Ansichten und für Grundriss-Elemente ohne Symboldarstellung genutzt.
import type { Doc, El, Id } from '../core/doc';
import type { Solid, Face } from '../core/registry';
import { catDef } from '../core/registry';
import { V2, V3, sub3, cross3, dot3, add3, mul3, lerp3, clipPolyByPlane, union, Poly, Ring, pointInRing, signedArea, BBox, boxOverlap, emptyBox, extendBox } from '../core/geom';
import { DisplayList } from '../render/displayList';
import type { Pen, Fill } from '../render/styles';
import { OBJECT_STYLES } from '../render/styles';
import { materialOf, projectInfo } from '../core/view';

export interface Projector {
  toView(p: V3): V2;
  depth(p: V3): number;
  /** Blickrichtung (in die Szene) */
  dir: V3;
  origin: V3;
}

// ------------------------------------------------------------ Solid-Cache
let cacheVer = -1;
const solidCache = new Map<Id, Solid[]>();
export function solidsOf(doc: Doc, el: El): Solid[] {
  if (cacheVer !== doc.version) { solidCache.clear(); cacheVer = doc.version; }
  let s = solidCache.get(el.id);
  if (!s) {
    const def = catDef(el.cat);
    try { s = def?.solids ? def.solids(el, doc) : []; } catch (e) { console.warn('Solid-Fehler', el.cat, e); s = []; }
    solidCache.set(el.id, s);
  }
  return s;
}

export function faceNormal(pts: V3[]): V3 {
  // Newell
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a.y - b.y) * (a.z + b.z); y += (a.z - b.z) * (a.x + b.x); z += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** Schnitt einer Fläche mit der Ebene depth=0 → Segmente (in Ansichtskoordinaten) */
function faceCut(f: Face, pr: Projector, out: [V2, V2][]): void {
  const rings = [f.pts, ...(f.holes ?? [])];
  const pts: V3[] = [];
  for (const r of rings) {
    const n = r.length;
    for (let i = 0; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n];
      const da = pr.depth(a), db = pr.depth(b);
      if ((da < 0) !== (db < 0)) pts.push(lerp3(a, b, da / (da - db)));
    }
  }
  if (pts.length < 2) return;
  const v = pts.map((p) => pr.toView(p));
  // entlang der Schnittgeraden sortieren
  let dx = 0, dy = 0, bi = 0, bd = -1;
  for (let i = 1; i < v.length; i++) { const d = Math.hypot(v[i].x - v[0].x, v[i].y - v[0].y); if (d > bd) { bd = d; bi = i; } }
  dx = v[bi].x - v[0].x; dy = v[bi].y - v[0].y;
  const order = v.map((p, i) => ({ p, t: (p.x - v[0].x) * dx + (p.y - v[0].y) * dy, i })).sort((a, b) => a.t - b.t);
  for (let i = 0; i + 1 < order.length; i += 2) out.push([order[i].p, order[i + 1].p]);
}

const key = (p: V2) => Math.round(p.x * 20) + ',' + Math.round(p.y * 20);

/** Segmente zu geschlossenen Ringen verketten */
function chain(segs: [V2, V2][]): Ring[] {
  const adj = new Map<string, { s: number; end: 0 | 1 }[]>();
  segs.forEach((s, i) => {
    for (const e of [0, 1] as const) {
      const k = key(s[e]); let l = adj.get(k); if (!l) { l = []; adj.set(k, l); } l.push({ s: i, end: e });
    }
  });
  const used = new Uint8Array(segs.length);
  const rings: Ring[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const ring: V2[] = [segs[i][0]];
    let cur = segs[i][1];
    const startK = key(segs[i][0]);
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const k = key(cur);
      if (k === startK) break;
      ring.push(cur);
      const nxt = (adj.get(k) ?? []).find((c) => !used[c.s]);
      if (!nxt) break;
      used[nxt.s] = 1;
      cur = segs[nxt.s][nxt.end === 0 ? 1 : 0];
    }
    if (ring.length >= 3 && Math.abs(signedArea(ring)) > 1) rings.push(ring);
  }
  return rings;
}

/** Ringe nach Verschachtelung zu Polygonen mit Löchern ordnen */
export function ringsToPolys(rings: Ring[]): Poly[] {
  const sorted = rings.map((r) => ({ r, a: Math.abs(signedArea(r)) })).sort((a, b) => b.a - a.a);
  const polys: { outer: Ring; holes: Ring[]; depth: number }[] = [];
  for (const { r } of sorted) {
    let depth = 0; let parent: { outer: Ring; holes: Ring[]; depth: number } | null = null;
    for (const p of polys) {
      if (pointInRing(r[0], p.outer) && !p.holes.some((h) => pointInRing(r[0], h))) { if (p.depth >= depth) { depth = p.depth + 1; parent = p; } }
    }
    if (parent && parent.depth % 2 === 0) parent.holes.push(r);
    else polys.push({ outer: r, holes: [], depth: parent ? parent.depth + 1 : 0 });
  }
  return polys.map((p) => [p.outer, ...p.holes]);
}

/** Schnittpolygone eines Elements (z.B. für Bewehrung im Schnitt) */
export function cutPolysOfElement(doc: Doc, el: El, pr: Projector): { mat?: Id; polys: Poly[] }[] {
  const res: { mat?: Id; polys: Poly[] }[] = [];
  for (const s of solidsOf(doc, el)) {
    const segs: [V2, V2][] = [];
    for (const f of s.faces) faceCut(f, pr, segs);
    const rings = chain(segs);
    if (rings.length) res.push({ mat: s.mat, polys: ringsToPolys(rings) });
  }
  return res;
}

export interface EngineOpts {
  cut: boolean;
  far: number;
  detail: 'coarse' | 'medium' | 'fine';
  crop?: BBox | null;
  /** Darstellung der Ansichtsflächen */
  style?: 'hidden' | 'shaded' | 'wire';
  /** Element nur projizieren, wenn dies true liefert (z.B. Grundriss-Tiefe) */
  projFilter?: (el: El) => boolean;
  /** Stift-Überschreibungen pro Kategorie */
  penFor?: (el: El, cut: boolean) => Pen;
  /** Nur Schnitt zeichnen, keine Projektion */
  cutOnly?: boolean;
  projOnly?: boolean;
}

interface ProjFace { el: El; rings: V2[][]; depth: number; fill: string; pen: Pen }

export function catPen(doc: Doc, cat: string, cut: boolean): Pen {
  const ov = projectInfo(doc)?.objStyles?.[cat];
  const st = OBJECT_STYLES[cat] ?? { proj: 1, cut: 3, label: cat };
  const w = cut ? ov?.cut ?? st.cut ?? st.proj : ov?.proj ?? st.proj;
  return { w, color: ov?.color ?? st.color, dash: st.dash };
}

/** Zeichnet Schnitt + Projektion der Elemente in die Display-Liste. */
export function drawSolids(doc: Doc, els: El[], pr: Projector, dl: DisplayList, o: EngineOpts): void {
  const faces: ProjFace[] = [];
  const cuts: { el: El; mat?: Id; color?: string; noCut?: boolean; polys: Poly[] }[] = [];
  for (const el of els) {
    const solids = solidsOf(doc, el);
    if (!solids.length) continue;
    // Grobtest über Bounding Box
    let dmin = Infinity, dmax = -Infinity; const vb = emptyBox();
    for (const s of solids) for (const f of s.faces) for (const p of f.pts) { const d = pr.depth(p); if (d < dmin) dmin = d; if (d > dmax) dmax = d; extendBox(vb, pr.toView(p)); }
    if (dmax < 0 || dmin > o.far) continue;
    if (o.crop && !boxOverlap(vb, o.crop)) continue;
    const projPen = o.penFor ? o.penFor(el, false) : catPen(doc, el.cat, false);
    if (o.cut && !o.projOnly && dmin < 0 && dmax > 0) {
      for (const s of solids) {
        const segs: [V2, V2][] = [];
        for (const f of s.faces) faceCut(f, pr, segs);
        const rings = chain(segs);
        if (rings.length) cuts.push({ el, mat: s.mat, color: s.color, noCut: s.noCut, polys: ringsToPolys(rings) });
      }
    }
    if (o.cutOnly) continue;
    if (o.projFilter && !o.projFilter(el)) continue;
    for (const s of solids) {
      const m = materialOf(doc, s.mat);
      const fillCol = o.style === 'shaded' ? (s.color ?? m?.color ?? '#d8d8d8') : '#ffffff';
      for (const f of s.faces) {
        const n = faceNormal(f.pts);
        const nd = dot3(n, pr.dir);
        if (nd > -1e-3) continue; // Rückseite oder hochkant
        let outer = f.pts;
        if (dmin < 0) outer = clipPolyByPlane(outer, pr.origin, pr.dir);
        if (dmax > o.far) outer = clipPolyByPlane(outer, add3(pr.origin, mul3(pr.dir, o.far)), mul3(pr.dir, -1));
        if (outer.length < 3) continue;
        const rings: V2[][] = [outer.map(pr.toView)];
        for (const h of f.holes ?? []) {
          let hh = h;
          if (dmin < 0) hh = clipPolyByPlane(hh, pr.origin, pr.dir);
          if (dmax > o.far) hh = clipPolyByPlane(hh, add3(pr.origin, mul3(pr.dir, o.far)), mul3(pr.dir, -1));
          if (hh.length >= 3) rings.push(hh.map(pr.toView));
        }
        let ds = 0; for (const p of outer) ds += pr.depth(p);
        let shade = fillCol;
        if (o.style === 'shaded') shade = shadeColor(fillCol, n);
        faces.push({ el, rings, depth: ds / outer.length, fill: shade, pen: s.role === 'glass' ? { ...projPen, w: 1 } : projPen });
      }
    }
  }
  faces.sort((a, b) => b.depth - a.depth);
  for (const f of faces) {
    dl.begin(f.el.id);
    if (o.style === 'wire') dl.poly(f.rings[0], f.pen, true);
    else dl.fill(f.rings, { color: f.fill }, f.pen);
  }
  // Schnittflächen: je Element + Material vereinigen
  const groups = new Map<string, { el: El; mat?: Id; color?: string; noCut?: boolean; polys: Poly[] }>();
  for (const c of cuts) {
    const k = c.el.id + '|' + (c.mat ?? c.color ?? '');
    const g = groups.get(k);
    if (g) g.polys.push(...c.polys); else groups.set(k, { ...c, polys: c.polys.slice() });
  }
  for (const g of groups.values()) {
    const merged = g.polys.length > 1 ? union(g.polys) : g.polys;
    const m = materialOf(doc, g.mat);
    const cutPen = o.penFor ? o.penFor(g.el, true) : catPen(doc, g.el.cat, true);
    const fill: Fill = g.noCut ? { color: '#ffffff' } : cutFill(m?.cutPattern, m?.cutColor, o.detail);
    dl.begin(g.el.id);
    for (const p of merged) dl.fill(p, fill, g.noCut ? { ...cutPen, w: 1 } : cutPen);
  }
}

export function cutFill(pattern: string | undefined, color: string | undefined, detail: string): Fill {
  if (!pattern) return { color: '#ffffff' };
  if (pattern === 'solid') return { color: '#ffffff', pattern: 'solid', patColor: color ?? '#808080' };
  return { color: '#ffffff', pattern, patColor: color ?? '#000000' };
}

function shadeColor(hex: string, n: V3): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const light = { x: -0.4, y: -0.6, z: 0.7 }; const l = Math.hypot(light.x, light.y, light.z);
  const f = 0.6 + 0.4 * Math.max(0, (n.x * light.x + n.y * light.y + n.z * light.z) / l);
  const c = (h: string) => Math.round(Math.min(255, parseInt(h, 16) * f)).toString(16).padStart(2, '0');
  return '#' + c(m[1]) + c(m[2]) + c(m[3]);
}

// ------------------------------------------------------------ Hilfen zum Bau von Solids

/** Prisma aus Grundriss-Ring (beliebig orientiert) zwischen z0 und z1 */
export function prism(ring: V2[], z0: number, z1: number, holes: V2[][] = []): Face[] {
  const ccw = signedArea(ring) > 0 ? ring : ring.slice().reverse();
  const hs = holes.map((h) => (signedArea(h) < 0 ? h : h.slice().reverse()));
  const faces: Face[] = [];
  const top = (r: V2[]) => r.map((p) => ({ x: p.x, y: p.y, z: z1 }));
  const bot = (r: V2[]) => r.slice().reverse().map((p) => ({ x: p.x, y: p.y, z: z0 }));
  faces.push({ pts: top(ccw), holes: hs.map(top) });
  faces.push({ pts: bot(ccw), holes: hs.map(bot) });
  const sides = (r: V2[]) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
      faces.push({ pts: [{ x: a.x, y: a.y, z: z0 }, { x: b.x, y: b.y, z: z0 }, { x: b.x, y: b.y, z: z1 }, { x: a.x, y: a.y, z: z1 }] });
    }
  };
  sides(ccw); hs.forEach(sides);
  return faces;
}

/** Quader aus Ursprung + 3 Kantenvektoren (rechtshändig: u × v = w-Richtung) */
export function box3(o: V3, u: V3, v: V3, w: V3): Face[] {
  const P = (a: number, b: number, c: number) => add3(add3(add3(o, mul3(u, a)), mul3(v, b)), mul3(w, c));
  const q = (a: V3, b: V3, c: V3, d: V3): Face => ({ pts: [a, b, c, d] });
  const p000 = P(0, 0, 0), p100 = P(1, 0, 0), p110 = P(1, 1, 0), p010 = P(0, 1, 0);
  const p001 = P(0, 0, 1), p101 = P(1, 0, 1), p111 = P(1, 1, 1), p011 = P(0, 1, 1);
  const faces = [
    q(p000, p010, p110, p100), q(p001, p101, p111, p011),
    q(p000, p100, p101, p001), q(p100, p110, p111, p101),
    q(p110, p010, p011, p111), q(p010, p000, p001, p011),
  ];
  // Orientierung prüfen
  const n = cross3(u, v);
  if (dot3(n, w) < 0) for (const f of faces) f.pts.reverse();
  return faces;
}

/** Extrusion eines Profils (Ring in lokalen Koordinaten u/v) entlang Pfad-Richtung */
export function extrudeProfile(profile: V2[], origin: V3, uAxis: V3, vAxis: V3, dir: V3, length: number): Face[] {
  const ccw = signedArea(profile) > 0 ? profile : profile.slice().reverse();
  const P = (p: V2, t: number) => add3(add3(add3(origin, mul3(uAxis, p.x)), mul3(vAxis, p.y)), mul3(dir, t));
  const nrm = cross3(uAxis, vAxis);
  const flip = dot3(nrm, dir) < 0;
  const start = ccw.map((p) => P(p, 0)).reverse();
  const end = ccw.map((p) => P(p, length));
  const faces: Face[] = [{ pts: flip ? end.slice().reverse() : start }, { pts: flip ? start.slice().reverse() : end }];
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    const f = [P(a, 0), P(b, 0), P(b, length), P(a, length)];
    faces.push({ pts: flip ? f.reverse() : f });
  }
  return faces;
}

export function sub3v(a: V3, b: V3) { return sub3(a, b); }
