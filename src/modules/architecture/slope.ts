// Geneigte Platten (Geschossdecke, Fundamentplatte) und Rampen: Höhenverlauf dz über die Station
// s = (p − a)·dir, stückweise linear (zwei Punkte = Neigungspfeil wie in Revit, mehr = Rampe mit Übergängen).
// Fläche (Ober-/Unterseite), Knicklinien, Körper je Schicht (Dicke lotrecht), geneigte Fläche,
// Grundriss (Schnitt über die Schnittmaschine, Kanten, Gefällepfeile «15 %» talwärts), Griffe, Eigenschaften.
import type { Doc, El, Id } from '../../core/doc';
import {
  V2, add, sub, mul, dot, norm, perp, dist, mid, apply, applyVec, len, Mat2, Poly, MultiPoly, polyArea, interiorPoint,
  intersection, ensureCCW, fromAngle,
} from '../../core/geom';
import type { Solid, Surface, Grip, PlanCtx, PropDef } from '../../core/registry';
import { GROUPS, registerCommand, registerContextPanel } from '../../core/registry';
import { View, isPlanLike } from '../../core/view';
import { profiledPrism, splitAtCreases, drawSolids, catPen } from '../../views/sectionEngine';
import { planProjector } from '../../views/viewBuilder';
import { clipSegToMulti } from '../../elements/wall';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtNum, fmtLen } from '../../core/units';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { startTool } from '../../ui/commands';
import { drawOutline } from './common';

/** Profilpunkt: Station s (mm entlang dir ab a) und Höhenversatz dz zur Oberkante der Platte (Ebene + Versatz) */
export interface SlopePt { s: number; dz: number }
/** Gefälle: Bezugspunkt a, Richtung dir (Einheitsvektor), Höhenverlauf (mind. 2 Punkte, nach s sortiert) */
export interface SlopeDef { a: V2; dir: V2; prof: SlopePt[] }
/** Eingabeform: Neigungspfeil von a nach b, Gefälle pct in % (positiv = fällt von a nach b) */
export interface SlopeArrow { a: V2; b: V2; pct: number }

const isV2 = (v: any): v is V2 => !!v && isFinite(v.x) && isFinite(v.y);

/** Neigungspfeil (a → b, fällt um pct %) als Gefälle */
export function slopeFromArrow(a: V2, b: V2, pct: number): SlopeDef | null {
  const L = dist(a, b); if (L < 1 || !isFinite(pct)) return null;
  return { a: { x: a.x, y: a.y }, dir: norm(sub(b, a)), prof: [{ s: 0, dz: 0 }, { s: L, dz: (-L * pct) / 100 }] };
}

/** Gefälle eines Elements (normalisiert, auch aus der Eingabeform {a, b, pct}); null = eben */
export function slopeOf(el: El | undefined | null): SlopeDef | null {
  const s = el?.slope; if (!s || !isV2(s.a)) return null;
  if (!Array.isArray(s.prof) && isV2(s.b) && typeof s.pct === 'number') return slopeFromArrow(s.a, s.b, s.pct);
  if (!isV2(s.dir) || !Array.isArray(s.prof)) return null;
  const d = norm(s.dir); if (!d.x && !d.y) return null;
  const prof: SlopePt[] = [];
  for (const q of s.prof.filter((q: any) => q && isFinite(q.s) && isFinite(q.dz)).slice().sort((p: SlopePt, q: SlopePt) => p.s - q.s)) {
    const last = prof[prof.length - 1];
    if (last && q.s - last.s < 1e-6) last.dz = q.dz; else prof.push({ s: q.s, dz: q.dz });
  }
  if (prof.length < 2 || prof.every((q) => Math.abs(q.dz) < 1e-9)) return null;
  return { a: s.a, dir: d, prof };
}

/** Station eines Grundrisspunkts */
export const stationOf = (sl: SlopeDef, p: V2): number => dot(sub(p, sl.a), sl.dir);
/** Punkt auf der Gefällslinie (durch a) bei Station s */
export const pointAt = (sl: SlopeDef, s: number): V2 => add(sl.a, mul(sl.dir, s));

function segIndex(P: SlopePt[], s: number): number { let i = 1; while (i < P.length - 1 && s > P[i].s) i++; return i; }
/** Höhenversatz bei Station s (ausserhalb des Profils mit der Neigung der Endabschnitte verlängert) */
export function dzAt(sl: SlopeDef, s: number): number {
  const P = sl.prof; const i = segIndex(P, s); const a = P[i - 1], b = P[i];
  return a.dz + ((b.dz - a.dz) * (s - a.s)) / (b.s - a.s);
}
/** Neigung (dz/ds) bei Station s */
export function gradAt(sl: SlopeDef, s: number): number {
  const P = sl.prof; const i = segIndex(P, s); return (P[i].dz - P[i - 1].dz) / (P[i].s - P[i - 1].s);
}
/** Höhenversatz im Grundrisspunkt p */
export const slopeDz = (sl: SlopeDef, p: V2): number => dzAt(sl, stationOf(sl, p));

/** Knicklinien (quer zur Gefällsrichtung) an den inneren Profilpunkten mit Neigungswechsel */
export function slopeCreases(sl: SlopeDef): { a: V2; b: V2 }[] {
  const out: { a: V2; b: V2 }[] = []; const P = sl.prof;
  for (let i = 1; i + 1 < P.length; i++) {
    const g0 = (P[i].dz - P[i - 1].dz) / (P[i].s - P[i - 1].s), g1 = (P[i + 1].dz - P[i].dz) / (P[i + 1].s - P[i].s);
    if (Math.abs(g1 - g0) < 1e-9) continue;
    const q = pointAt(sl, P[i].s); out.push({ a: q, b: add(q, perp(sl.dir)) });
  }
  return out;
}

/** Stationsbereich einer Fläche */
export function stationRange(sl: SlopeDef, area: MultiPoly): [number, number] {
  let s0 = Infinity, s1 = -Infinity;
  for (const p of area) for (const r of p) for (const q of r) { const s = stationOf(sl, q); if (s < s0) s0 = s; if (s > s1) s1 = s; }
  return [s0, s1];
}
/** kleinster / grösster Höhenversatz über der Fläche */
export function slopeRange(sl: SlopeDef, area: MultiPoly): [number, number] {
  const [s0, s1] = stationRange(sl, area);
  if (!isFinite(s0)) return [0, 0];
  const v = [dzAt(sl, s0), dzAt(sl, s1), ...sl.prof.filter((q) => q.s > s0 && q.s < s1).map((q) => q.dz)];
  return [Math.min(...v), Math.max(...v)];
}

/** Geneigte (wahre) Fläche: Grundfläche je Neigungsabschnitt × √(1 + g²) – für Schalung, Matten, Beläge */
export function slopedArea(area: MultiPoly, sl: SlopeDef | null): number {
  let A = 0;
  if (!sl) { for (const p of area) A += polyArea(p); return A; }
  const cr = slopeCreases(sl);
  for (const poly of area) for (const cell of splitAtCreases(poly, cr)) {
    const g = gradAt(sl, stationOf(sl, interiorPoint(cell)));
    A += polyArea(cell) * Math.sqrt(1 + g * g);
  }
  return A;
}

/** Körper je Schicht (oben → unten) unter einer geneigten Oberseite; Dicke lotrecht (Volumen = Fläche × Dicke) */
export function slopedLayerSolids(area: MultiPoly, top: (p: V2) => number, layers: { mat: Id; t: number }[], sl: SlopeDef, fallbackMat?: Id): Solid[] {
  const out: Solid[] = [];
  const ls = layers.length ? layers : [{ mat: fallbackMat ?? 'm_beton', t: 200 }];
  const cr = slopeCreases(sl);
  let acc = 0;
  for (const l of ls) {
    if (l.t >= 0.5) {
      const o = acc, t = l.t;
      const faces = area.flatMap((p) => profiledPrism(p, (q) => top(q) - o, (q) => top(q) - o - t, cr));
      if (faces.length) out.push({ faces, mat: l.mat });
    }
    acc += l.t;
  }
  return out;
}

/** Fläche einer geneigten Platte: Oberkante topFlat + dz, Dicke T lotrecht; zMin/zMax über der Grundfläche */
export function slopedSurface(sl: SlopeDef, topFlat: number, T: number, area: MultiPoly): Surface {
  const top = (p: V2) => topFlat + slopeDz(sl, p);
  const [d0, d1] = slopeRange(sl, area);
  return { topAt: top, botAt: (p) => top(p) - T, creases: slopeCreases(sl), zMin: topFlat + d0 - T, zMax: topFlat + d1, flat: false };
}

// ------------------------------------------------------------ Bearbeiten
/** Gefälle mit dem Element transformieren (Verschieben, Drehen, Spiegeln – die Richtung wird mitgespiegelt) */
export function transformSlope(sl: SlopeDef, m: Mat2): SlopeDef {
  const d = applyVec(m, sl.dir); const k = len(d) || 1;
  return { a: apply(m, sl.a), dir: norm(d), prof: sl.prof.map((q) => ({ s: q.s * k, dz: q.dz })) };
}
export const moveSlope = (sl: SlopeDef, d: V2): SlopeDef => ({ ...sl, a: { x: sl.a.x + d.x, y: sl.a.y + d.y } });

/** Griffe am Neigungspfeil: Anfang (sl:0) und Ende (sl:1) des Profils */
export function slopeGrips(el: El, view: View): Grip[] {
  const sl = slopeOf(el); if (!sl || !isPlanLike(view)) return [];
  const P = sl.prof;
  return [
    { id: 'sl:0', p: pointAt(sl, P[0].s), kind: 'end', tip: 'Neigungspfeil: Anfang verschieben (Höhen bleiben)' },
    { id: 'sl:1', p: pointAt(sl, P[P.length - 1].s), kind: 'end', tip: 'Neigungspfeil: Ende verschieben (Höhen bleiben)' },
  ];
}
/** Griff am Neigungspfeil ziehen: Pfeil neu ausrichten/strecken, Höhenversätze der Profilpunkte bleiben */
export function dragSlopeGrip(el: El, id: string, p: V2): { slope: SlopeDef } | undefined {
  if (id !== 'sl:0' && id !== 'sl:1') return;
  const sl = slopeOf(el); if (!sl) return;
  const P = sl.prof; const s0 = P[0].s, s1 = P[P.length - 1].s;
  const A = id === 'sl:0' ? p : pointAt(sl, s0), B = id === 'sl:1' ? p : pointAt(sl, s1);
  const L = dist(A, B); if (L < 10) return;
  const k = L / (s1 - s0);
  return { slope: { a: { x: A.x, y: A.y }, dir: norm(sub(B, A)), prof: P.map((q) => ({ s: (q.s - s0) * k, dz: q.dz })) } };
}

/** Prozentangabe «15 %» (eine Nachkommastelle, wenn nötig) */
export function fmtPct(g: number): string {
  const v = Math.abs(g) * 100; const d = Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1;
  return fmtNum(v, d) + ' %';
}
/** Gefälle als Text: «15 %» bzw. Abschnitte «8 % / 15 % / 8 %» */
export function slopeText(sl: SlopeDef | null): string {
  if (!sl) return '–';
  const P = sl.prof; const parts: string[] = [];
  for (let i = 1; i < P.length; i++) parts.push(fmtPct((P[i].dz - P[i - 1].dz) / (P[i].s - P[i - 1].s)));
  return parts.join(' / ');
}
/** grösstes Gefälle (Betrag, als Anteil) */
export const maxGrade = (sl: SlopeDef | null): number => {
  if (!sl) return 0; let g = 0; const P = sl.prof;
  for (let i = 1; i < P.length; i++) g = Math.max(g, Math.abs((P[i].dz - P[i - 1].dz) / (P[i].s - P[i - 1].s)));
  return g;
};

/** Eigenschaften des Gefälles (Geschossdecke, Fundamentplatte) */
export function slopeProps(el: El | undefined, area: (el: El, doc: Doc) => MultiPoly, topFlat: (el: El, doc: Doc) => number): PropDef[] {
  const g = GROUPS;
  const all = slopePropDefs(area, topFlat);
  // ebene Platte: nur «Neigungspfeil zeichnen»
  return el && !slopeOf(el) ? all.filter((p) => p.key === 'slopeArrow') : all;
}
function slopePropDefs(area: (el: El, doc: Doc) => MultiPoly, topFlat: (el: El, doc: Doc) => number): PropDef[] {
  const g = GROUPS;
  const two = (e: El) => { const sl = slopeOf(e); return sl && sl.prof.length === 2 ? sl : null; };
  return [
    { key: 'slopeInfo', label: 'Gefälle', group: g.constraints, type: 'readonly', get: (e) => slopeText(slopeOf(e)) },
    { key: 'slopePct', label: 'Gefälle Neigungspfeil (%)', group: g.constraints, type: 'number',
      get: (e) => { const sl = two(e); return sl ? Math.round(((sl.prof[0].dz - sl.prof[1].dz) / (sl.prof[1].s - sl.prof[0].s)) * 1e5) / 1e3 : 0; },
      set: (e, v) => {
        const sl = slopeOf(e);
        if (!sl) return;
        if (sl.prof.length !== 2) { app.status('Gefälle mit mehreren Abschnitten (Rampe): Profil über die API/JSON ändern.'); return; }
        const [p0, p1] = sl.prof;
        return { slope: { ...sl, prof: [p0, { s: p1.s, dz: p0.dz - ((p1.s - p0.s) * v) / 100 }] } };
      } },
    { key: 'slopeArrow', label: 'Neigungspfeil', group: g.constraints, type: 'button', get: (e) => (slopeOf(e) ? 'Neu zeichnen…' : 'Zeichnen…'), action: (e) => startSlopeArrow(e) },
    { key: 'slopeRemove', label: 'Gefälle entfernen', group: g.constraints, type: 'button', get: () => 'Entfernen', action: (e, doc) => {
      if (!e.slope || !doc.get(e.id)) return;
      doc.transaction('Gefälle entfernen', () => doc.update(e.id, { slope: undefined }));
    } },
    { key: 'elevRange', label: 'Höhe Oberkante (min. / max.)', group: g.dims, type: 'readonly', get: (e, doc) => {
      const sl = slopeOf(e); const t = topFlat(e, doc); if (!sl) return fmtLen(t);
      const [d0, d1] = slopeRange(sl, area(e, doc)); return `${fmtLen(t + d0)} / ${fmtLen(t + d1)}`;
    } },
    { key: 'slopedArea', label: 'Geneigte Fläche', group: g.dims, type: 'area', get: (e, doc) => slopedArea(area(e, doc), slopeOf(e)) },
  ];
}

// ------------------------------------------------------------ Grundriss
/** Stationsintervalle (innerhalb s0..s1), in denen pred(s) gilt – Knickstellen und Durchgänge durch die Höhen zs beachten */
function stationIntervals(sl: SlopeDef, s0: number, s1: number, zs: number[], z: (s: number) => number, pred: (s: number) => boolean): [number, number][] {
  const cand = [s0, s1, ...sl.prof.map((q) => q.s).filter((s) => s > s0 && s < s1)].sort((a, b) => a - b);
  const pts = new Set<number>(cand);
  for (let i = 0; i + 1 < cand.length; i++) {
    const a = cand[i], b = cand[i + 1], za = z(a), zb = z(b);
    for (const h of zs) if ((za - h) * (zb - h) < 0) pts.add(a + ((h - za) / (zb - za)) * (b - a));
  }
  const ss = [...pts].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ss.length; i++) {
    if (ss[i + 1] - ss[i] < 1e-3 || !pred((ss[i] + ss[i + 1]) / 2)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - ss[i]) < 1e-3) last[1] = ss[i + 1]; else out.push([ss[i], ss[i + 1]]);
  }
  return out;
}
/** Band quer zur Gefällsrichtung zwischen den Stationen s0 und s1 */
function bandPoly(sl: SlopeDef, s0: number, s1: number, R: number): Poly {
  const n = perp(sl.dir); const A = pointAt(sl, s0), B = pointAt(sl, s1);
  return [ensureCCW([add(A, mul(n, -R)), add(B, mul(n, -R)), add(B, mul(n, R)), add(A, mul(n, R))])];
}
function clipToIntervals(sl: SlopeDef, area: MultiPoly, iv: [number, number][], R: number): MultiPoly {
  const out: MultiPoly = [];
  for (const [a, b] of iv) out.push(...intersection(area, bandPoly(sl, a - 0.01, b + 0.01, R)));
  return out;
}

/** Gefällepfeil (Schweizer Darstellung): Linie mit gefüllter Spitze talwärts, Prozentangabe über der Linie */
export function slopeArrow(dl: DisplayList, hi: V2, lo: V2, label: string, pen: Pen): void {
  const s = dl.scale; const L = dist(hi, lo);
  if (L < 5 * s) return;
  const d = norm(sub(lo, hi)), n = perp(d);
  const h = Math.min(2.5 * s, L / 3), w = 0.75 * s;
  const base = sub(lo, mul(d, h));
  dl.line(hi, base, pen, { ns: true });
  dl.fill([[lo, add(base, mul(n, w)), sub(base, mul(n, w))]], { color: pen.color ?? '#000000' }, undefined, { ns: true });
  let ang = Math.atan2(d.y, d.x);
  if (ang > Math.PI / 2 + 1e-6) ang -= Math.PI; else if (ang <= -Math.PI / 2 + 1e-6) ang += Math.PI;
  const up = perp(fromAngle(ang));
  dl.text(add(mid(hi, lo), mul(up, 0.8 * s)), label, { size: 2.5, rot: ang, ha: 'center', va: 'bottom', color: pen.color });
}

export interface SlopedPlanOpts {
  /** Stiftkategorie (Objektstil) */
  styleCat: string;
  /** unterhalb der Schnittebene verdeckt (gestrichelt) zeichnen, z.B. Fundamente */
  hidden?: boolean;
  /** unterhalb davon nicht mehr zeichnen (Standard: Ansichtstiefe) */
  belowLimit?: number;
  /** Kanten unter geschnittenen Wänden ausblenden */
  mask?: boolean;
}

/**
 * Geneigte Platte im Grundriss: geschnittener Bereich über die Schnittmaschine (nur Schnitt), übrige sichtbare
 * Teile (unterhalb der Schnittebene bzw. im Deckenplan oberhalb) als Kanten, Gefällepfeile je Abschnitt.
 */
export function drawSlopedSlabPlan(ctx: PlanCtx, el: El, area: MultiPoly, sl: SlopeDef, surf: Surface, o: SlopedPlanOpts): void {
  if (!area.length) return;
  const { doc, dl } = ctx;
  if (surf.zMin < ctx.cutZ && surf.zMax > ctx.cutZ) {
    drawSolids(doc, [el], planProjector(ctx.cutZ, ctx.ceiling), dl, {
      cut: true, cutOnly: true, far: 1e9, detail: ctx.detail, penFor: (_e, cut) => catPen(doc, o.styleCat, cut),
    });
  }
  dl.begin(el.id);
  const [s0, s1] = stationRange(sl, area);
  if (!isFinite(s0) || s1 - s0 < 1e-3) return;
  const T = surf.topAt(sl.a) - surf.botAt(sl.a);
  const top = (s: number) => surf.topAt(pointAt(sl, s));
  // sichtbar: Grundriss – Oberseite unter der Schnittebene und über der Ansichtstiefe; Deckenplan – Unterseite über der Schnittebene
  const lim = o.belowLimit ?? ctx.depthZ;
  const vis = ctx.ceiling
    ? (s: number) => { const b = top(s) - T; return b >= ctx.cutZ - 1 && b <= ctx.topZ + 1; }
    : (s: number) => { const t = top(s); return t <= ctx.cutZ + 1 && t >= lim - 1; };
  const zs = ctx.ceiling ? [ctx.cutZ + T, ctx.topZ + T] : [ctx.cutZ, lim];
  const iv = stationIntervals(sl, s0, s1, zs, top, vis);
  const R = 4 * (s1 - s0) + 4 * Math.max(...area.flatMap((p) => p[0].map((q) => Math.abs(dot(sub(q, sl.a), perp(sl.dir)))))) + 1000;
  const projPen = catPen(doc, o.styleCat, false);
  const pen = o.hidden ? { ...projPen, dash: 'hidden' as const } : projPen;
  if (iv.length) {
    const visA = iv.length === 1 && iv[0][0] <= s0 + 1e-3 && iv[0][1] >= s1 - 1e-3 ? area : clipToIntervals(sl, area, iv, R);
    if (o.mask === false) { for (const p of visA) for (const r of p) dl.poly(r, pen, true); }
    else drawOutline(ctx, visA, pen);
  }
  // Gefällepfeile: auf der Gefällslinie durch a (sonst durch die Flächenmitte), je Profilabschnitt, im sichtbaren oder geschnittenen Bereich
  const shown = stationIntervals(sl, s0, s1, [ctx.cutZ, ctx.cutZ + T, lim], top, (s) => vis(s) || (top(s) - T < ctx.cutZ && top(s) > ctx.cutZ));
  if (!shown.length) return;
  let lineA = sl.a;
  let onLine = clipSegToMulti(pointAt(sl, s0 - 1), pointAt(sl, s1 + 1), area);
  if (!onLine.length) {
    const c = interiorPoint(area[0]); lineA = add(sl.a, mul(perp(sl.dir), dot(sub(c, sl.a), perp(sl.dir))));
    onLine = clipSegToMulti(add(lineA, mul(sl.dir, s0 - 1)), add(lineA, mul(sl.dir, s1 + 1)), area);
  }
  const lineIv = onLine.map(([p, q]) => [dot(sub(p, lineA), sl.dir), dot(sub(q, lineA), sl.dir)].sort((a, b) => a - b) as [number, number]);
  const P = sl.prof; const apen: Pen = { w: 1, color: projPen.color };
  const cut = (a: number, b: number, ivs: [number, number][]) => ivs.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as [number, number]).filter(([x, y]) => y - x > 1);
  for (let i = 1; i < P.length; i++) {
    const g = (P[i].dz - P[i - 1].dz) / (P[i].s - P[i - 1].s);
    if (Math.abs(g) < 1e-4) continue;
    for (const [a, b] of cut(P[i - 1].s, P[i].s, shown)) for (const [x0, y0] of cut(a, b, lineIv)) {
      // Pfeile benachbarter Abschnitte nicht aneinanderstossen lassen
      const m = Math.min(0.12 * (y0 - x0), 3 * dl.scale); const x = x0 + m, y = y0 - m;
      const A = add(lineA, mul(sl.dir, x)), B = add(lineA, mul(sl.dir, y));
      if (g < 0) slopeArrow(dl, A, B, fmtPct(g), apen); else slopeArrow(dl, B, A, fmtPct(g), apen);
    }
  }
}

// ------------------------------------------------------------ Werkzeug «Neigungspfeil»
const SA = { pct: 2 };
/** Neigungspfeil für eine Platte zeichnen: Anfang (hoch) und Ende (tief) wählen, Gefälle in % */
export class SlopeArrowTool extends Tool {
  id = 'slopeArrow'; label = 'Neigungspfeil'; kinds = ['plan', 'ceiling'];
  private start: V2 | null = null; private cur: V2 | null = null;
  constructor(private target: Id) { super(); }
  prompt(): string { return this.start ? 'Endpunkt des Neigungspfeils (talwärts) wählen.' : 'Anfangspunkt des Neigungspfeils (oben) wählen. Die Höhe bleibt dort erhalten.'; }
  options(): OptionItem[] { return [{ kind: 'number', key: 'pct', label: 'Gefälle %', value: SA.pct, onChange: (v) => { SA.pct = v; app.redrawOverlay(); } }]; }
  basePoint(): V2 | null { return this.start; }
  move(e: ToolEvent): void { this.cur = e.p; }
  escape(): boolean { if (this.start) { this.start = null; app.setPrompt(this.prompt()); return true; } return false; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.start) { this.start = e.p; app.setPrompt(this.prompt()); return; }
    const sl = slopeFromArrow(this.start, e.p, SA.pct); if (!sl) return;
    const el = app.doc.get(this.target);
    if (!el) { app.setTool(null); return; }
    app.doc.transaction('Neigungspfeil', () => app.doc.update(el.id, { slope: sl }));
    app.select([el.id]);
    app.setTool(null);
  }
  preview(dl: DisplayList): void {
    if (!this.start || !this.cur || dist(this.start, this.cur) < 1) return;
    slopeArrow(dl, this.start, this.cur, fmtNum(SA.pct, 1) + ' %', PREVIEW);
  }
}
export function startSlopeArrow(el: El): void { startTool(new SlopeArrowTool(el.id), 'slopeArrow'); }
const SLOPE_CATS = ['floor', 'foundationSlab'];
const slopeTarget = (): El | undefined => app.selected().find((e) => SLOPE_CATS.includes(e.cat));
registerCommand({
  id: 'slopeArrow', label: 'Neigungspfeil', icon: 'slopeArrow', tip: 'Gefälle der gewählten Geschossdecke/Fundamentplatte mit einem Neigungspfeil festlegen (Anfang oben, Ende talwärts, Gefälle in %)',
  enabled: () => !!slopeTarget(), run: () => { const e = slopeTarget(); if (e) startSlopeArrow(e); else app.status('Bitte eine Geschossdecke oder Fundamentplatte wählen.'); },
});
registerContextPanel({ cats: SLOPE_CATS, panel: 'Gefälle', items: ['slopeArrow'] });

/** IFC: Eigenschaften des Gefälles (Pset «CH_Gefaelle») */
export function slopePset(sl: SlopeDef | null, area: MultiPoly): Record<string, string | number | { v: number; k: 'area' }> | null {
  if (!sl) return null;
  return {
    Gefaelle_max_Prozent: Math.round(maxGrade(sl) * 1e5) / 1e3,
    Gefaelle: slopeText(sl),
    Profil: sl.prof.map((q) => `${(q.s / 1000).toFixed(3)}:${(q.dz / 1000).toFixed(3)}`).join(' '),
    Flaeche_geneigt: { v: slopedArea(area, sl) / 1e6, k: 'area' },
  };
}
