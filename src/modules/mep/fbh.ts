// Fussbodenheizung: Heizkreis als Fläche (Skizze oder Raum wählen) → Verlegemuster Mäander (mit Rücklauf am
// Rand) oder Schnecke (bifilar), Verlegeabstand VA, Randabstand, Kreislänge inkl. Anbindeleitungen zum Verteiler.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, add, sub, mul, dot, norm, perp, dist, signedArea, polylineLength, offsetPolyline, pointInRing, segSeg, interiorPoint,
  polyArea, arcPoints, apply, Mat2, angleOf, Poly,
} from '../../core/geom';
import { registerCategory, GROUPS, PropDef, Solid, Grip } from '../../core/registry';
import { levelElev, isPlanLike } from '../../core/view';
import { cached } from '../../core/cache';
import { fmtNum, fmtArea } from '../../core/units';
import type { DisplayList } from '../../render/displayList';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { SketchTool } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool } from '../../ui/commands';
import { regionAt } from '../architecture/room';
import { loopGrips, dragLoopGrip, transformLoops, moveLoops } from '../architecture/common';
import { sysOf, sysPen, systemOptions, planBand, discVisible, sweep, circleProfile } from './common';
import { fixPos, FixType } from './fixtures';

export interface FbhCircuit extends El {
  cat: 'fbh'; levelId: Id;
  /** Verlegefläche (Aussenring zuerst, weitere Ringe = Aussparungen) */
  loops: V2[][];
  /** Verlegeabstand VA */
  spacing: number;
  pattern: 'meander' | 'snail';
  /** Randabstand */
  edge: number;
  /** Verlegerichtung (Mäander), rad; ohne Angabe: längste Kante */
  angle?: number;
  dia: number;
  /** Rohrachse über Ebene (im Unterlagsboden: negativ, wenn Ebene = OK fertig) */
  offset: number;
  system?: Id;
  /** FBH-Verteiler (HLKSE-Element) */
  manifoldId?: Id;
  name?: string;
  /** spezifische Heizleistung W/m² */
  q?: number;
}

export interface FbhLayout { path: V2[]; conVL: V2[]; conRL: V2[]; area: number; field: number; conn: number; length: number; ok: boolean }

const S = (dir: V2, n: V2) => ({ toW: (s: number, t: number): V2 => add(mul(dir, s), mul(n, t)), s: (p: V2) => dot(p, dir), t: (p: V2) => dot(p, n) });

function selfIntersects(r: V2[]): boolean {
  const n = r.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segSeg(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n], 1e-9)) return true;
  }
  return false;
}
/** doppelte und kollineare Punkte entfernen (Raumbereiche aus Wandflächen enthalten solche) */
export function cleanRing(r0: V2[]): V2[] {
  let r = r0.filter((p, i) => dist(p, r0[(i + 1) % r0.length]) > 1);
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const u = norm(sub(b, a)), v = norm(sub(c, b));
      if (Math.abs(u.x * v.y - u.y * v.x) < 0.01 && u.x * v.x + u.y * v.y > 0) { r = r.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  return r;
}
/** nach innen versetzter Ring (CCW) oder null, wenn er kollabiert */
function inset(outer: V2[], d: number, prev: V2[] | null): V2[] | null {
  const r = offsetPolyline(outer, d, true);
  if (r.length < 3 || signedArea(r) < 1e4 || selfIntersects(r)) return null;
  if (prev && !r.every((p) => pointInRing(p, prev))) return null;
  return r;
}
/** Schnittintervalle einer Geraden t = const mit Ringen (gerade/ungerade-Regel), sortiert nach s */
function intervals(rings: V2[][], sc: ReturnType<typeof S>, t: number): [number, number][] {
  const xs: number[] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]; const ta = sc.t(a), tb = sc.t(b);
    if ((ta <= t && tb > t) || (tb <= t && ta > t)) { const u = (t - ta) / (tb - ta); xs.push(sc.s(a) + (sc.s(b) - sc.s(a)) * u); }
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

function longestEdgeDir(r: V2[]): V2 {
  let best = 0, d: V2 = { x: 1, y: 0 };
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; const L = dist(a, b); if (L > best) { best = L; d = norm(sub(b, a)); } }
  return d;
}

/** Mäander: Leitungen parallel zur Verlegerichtung, 180°-Bögen, Rücklauf entlang des Randes zur Startseite */
function meander(outer: V2[], holes: V2[][], sp: number, edge: number, dir0: V2, near: V2 | null): { path: V2[]; start: V2; end: V2; single: boolean } | null {
  const inner = inset(outer, edge, null); if (!inner) return null;
  const hs = holes.map((h) => offsetPolyline(signedArea(h) < 0 ? h : h.slice().reverse(), edge, true));
  let dir = dir0, n = perp(dir0);
  let sc = S(dir, n);
  const ts = inner.map(sc.t), ss = inner.map(sc.s);
  const tmid = (Math.min(...ts) + Math.max(...ts)) / 2, smid = (Math.min(...ss) + Math.max(...ss)) / 2;
  if (near && sc.t(near) > tmid) n = mul(n, -1);
  if (near && sc.s(near) > smid) dir = mul(dir, -1);
  sc = S(dir, n);
  const T = inner.map(sc.t); const tmin = Math.min(...T), tmax = Math.max(...T);
  let N = Math.floor((tmax - tmin) / sp + 1e-6) + 1;
  if (N > 2 && N % 2) N -= 1;
  if (N < 2) return null;
  const t0 = tmin + ((tmax - tmin) - (N - 1) * sp) / 2;
  const rings = [inner, ...hs];
  const lines = [] as { t: number; iv: [number, number][] }[];
  for (let k = 0; k < N; k++) { const t = t0 + k * sp; lines.push({ t, iv: intervals(rings, sc, Math.min(tmax - 1e-3, Math.max(tmin + 1e-3, t))) }); }
  const single = lines.every((l) => l.iv.length === 1);
  const W = sc.toW;
  const arc = (c: V2, from: number, to: number) => arcPoints(c, sp / 2, from, to, 8).map((q) => W(q.x, q.y));
  if (single) {
    const b = lines.map((l) => l.iv[0][0]), e = lines.map((l) => l.iv[0][1]);
    const lo = lines.map((_, k) => Math.max(b[k] + sp, k % 2 === 1 && k + 1 < N ? b[k + 1] + sp : -Infinity, k % 2 === 0 && k > 0 ? b[k - 1] + sp : -Infinity));
    const hi = lines.map((_, k) => Math.min(e[k] - sp / 2, k % 2 === 0 ? e[k + 1] - sp / 2 : e[k - 1] - sp / 2));
    const path: V2[] = [];
    for (let k = 0; k < N; k++) {
      const t = lines[k].t; const fwd = k % 2 === 0;
      const sA = fwd ? lo[k] : hi[k], sB = fwd ? hi[k] : lo[k];
      path.push(W(sA, t), W(sB, t));
      if (k + 1 < N) {
        // Wende: Halbkreis an der Seite von sB (vorwärts nach +s, rückwärts nach −s ausbauchend)
        const c = { x: sB, y: t + sp / 2 };
        if (fwd) path.push(...arc(c, -Math.PI / 2, Math.PI / 2).slice(1, -1));
        else path.push(...arc(c, Math.PI / 2, Math.PI * 1.5).reverse().slice(1, -1));
      }
    }
    // Rücklauf entlang der Startseite (s = Rand) bis zur ersten Leitung
    for (let k = N - 1; k >= 0; k--) path.push(W(b[k], lines[k].t));
    return { path, start: path[0], end: path[path.length - 1], single: true };
  }
  // Mehrere Teilbereiche (z. B. L-förmig): Teilmäander je zusammenhängendem Streifen, nacheinander verbunden
  type Chain = { k: number; seg: [number, number][]; ts: number[] };
  const chains: Chain[] = [];
  lines.forEach((l, k) => {
    const used = new Set<Chain>();
    for (const iv of l.iv) {
      const c = chains.find((ch) => ch.k === k - 1 && !used.has(ch) && Math.min(ch.seg[ch.seg.length - 1][1], iv[1]) - Math.max(ch.seg[ch.seg.length - 1][0], iv[0]) > sp);
      if (c) { c.k = k; c.seg.push(iv); c.ts.push(l.t); used.add(c); } else { const nc = { k, seg: [iv], ts: [l.t] }; chains.push(nc); used.add(nc); }
    }
  });
  const path: V2[] = [];
  for (const ch of chains) {
    ch.seg.forEach((iv, i) => {
      const fwd = i % 2 === 0; const a = iv[0] + sp / 2, b = iv[1] - sp / 2; if (b <= a) return;
      path.push(W(fwd ? a : b, ch.ts[i]), W(fwd ? b : a, ch.ts[i]));
    });
  }
  if (path.length < 2) return null;
  return { path, start: path[0], end: path[path.length - 1], single: false };
}

/** Schnecke (bifilar): Vorlauf auf geraden Ringen nach innen, Rücklauf auf ungeraden Ringen nach aussen */
function snail(outer: V2[], sp: number, edge: number, near: V2 | null): { path: V2[]; start: V2; end: V2; exit: V2 } | null {
  const rings: V2[][] = [];
  let prev: V2[] | null = null;
  for (let k = 0; k < 400; k++) { const r = inset(outer, edge + k * sp, prev); if (!r) break; rings.push(r); prev = r; }
  if (rings.length < 2) return null;
  // Kern muss gefüllt sein (sonst kollabieren die Ringe zu früh, z. B. bei einspringenden Ecken) → Mäander
  const last = rings[rings.length - 1];
  if ((2 * Math.abs(signedArea(last))) / polylineLength([...last, last[0]]) > 2 * sp) return null;
  const m = outer.length;
  let i0 = 0;
  if (near) { let bd = Infinity; outer.forEach((p, i) => { const d = dist(p, near); if (d < bd) { bd = d; i0 = i; } }); }
  const seq = (r: V2[]) => { const out: V2[] = []; for (let j = 0; j < m; j++) out.push(r[(i0 + j) % m]); return out; };
  const spiral = (ks: number[]): V2[] => {
    const out: V2[] = [];
    for (const k of ks) {
      const v = seq(rings[k]);
      const last = v[m - 1], first = v[0]; const L = dist(last, first);
      out.push(...v);
      out.push(L > 3 * sp ? add(first, mul(norm(sub(last, first)), 2 * sp)) : add(first, mul(sub(last, first), 0.6)));
    }
    return out;
  };
  const even = rings.map((_, k) => k).filter((k) => k % 2 === 0), odd = rings.map((_, k) => k).filter((k) => k % 2 === 1);
  const sup = spiral(even), ret = spiral(odd).reverse();
  const r0 = seq(rings[0]);
  const exit = add(r0[0], mul(norm(sub(r0[m - 1], r0[0])), sp));
  const path = [...sup, ...ret];
  return { path, start: path[0], end: path[path.length - 1], exit };
}

/** Anschlusspunkte des Verteilers (Vorlauf/Rücklauf) für einen Kreis */
function manifoldPorts(doc: Doc, c: FbhCircuit): { vl: V2; rl: V2; ny: V2 } | null {
  const m = doc.get(c.manifoldId); if (!m || m.cat !== 'mepFixture') return null;
  const t = doc.get<FixType>(m.typeId); const W = t?.width ?? 650, D = t?.depth ?? 150;
  const { p, rot } = fixPos(doc, m);
  const ex = { x: Math.cos(rot), y: Math.sin(rot) }, ny = { x: -Math.sin(rot), y: Math.cos(rot) };
  const all = doc.all<FbhCircuit>('fbh').filter((f) => f.manifoldId === m.id).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'de', { numeric: true }) || a.id.localeCompare(b.id));
  const i = Math.max(0, all.findIndex((f) => f.id === c.id)); const n = Math.max(1, all.length);
  const pitch = n > 1 ? Math.min(60, (W - 100) / (n - 1)) : 0;
  const x = -((n - 1) * pitch) / 2 + i * pitch;
  const base = add(add(p, mul(ex, x)), mul(ny, D));
  return { vl: add(base, mul(ex, -12)), rl: add(base, mul(ex, 12)), ny };
}
/** rechtwinklige Anbindeleitung: vom Verteiler weg (ny), dann entlang der Wand; liegt das Ziel hinter der Wand, zuerst entlang der Wand */
function route(port: V2, ny: V2, target: V2, lead: number): V2[] {
  const p1 = add(port, mul(ny, lead)); const ex = perp(ny);
  const front = dot(sub(target, p1), ny) >= 0;
  const corner = front ? add(p1, mul(ny, dot(sub(target, p1), ny))) : add(p1, mul(ex, dot(sub(target, p1), ex)));
  return [port, p1, corner, target].filter((q, i, a) => i === 0 || dist(q, a[i - 1]) > 1);
}

export function fbhLayout(doc: Doc, c: El): FbhLayout {
  const calc = (): FbhLayout => {
    const f = c as FbhCircuit;
    const empty: FbhLayout = { path: [], conVL: [], conRL: [], area: 0, field: 0, conn: 0, length: 0, ok: false };
    if (!f.loops?.length || f.loops[0].length < 3) return empty;
    const o0 = cleanRing(f.loops[0]);
    const outer = signedArea(o0) > 0 ? o0 : o0.slice().reverse();
    const holes = f.loops.slice(1).map(cleanRing).filter((h) => h.length >= 3);
    const area = polyArea([outer, ...holes]);
    const sp = Math.max(50, f.spacing ?? 150), edge = Math.max(0, f.edge ?? 100);
    const ports = manifoldPorts(doc, f);
    const near = ports ? ports.vl : null;
    let res: { path: V2[]; start: V2; end: V2; exit?: V2 } | null = null;
    if (f.pattern === 'snail' && !holes.length) res = snail(outer, sp, edge, near);
    if (!res) {
      // Verlegerichtung: vorgegeben, sonst längste Kante oder quer dazu – bevorzugt ohne geteilte Leitungen
      const d0 = f.angle !== undefined ? { x: Math.cos(f.angle), y: Math.sin(f.angle) } : longestEdgeDir(outer);
      const a = meander(outer, holes, sp, edge, d0, near);
      const b = f.angle === undefined && (!a || !a.single) ? meander(outer, holes, sp, edge, perp(d0), near) : null;
      res = b && (b.single || !a) ? b : a;
    }
    if (!res) return { ...empty, area };
    let conVL: V2[] = [], conRL: V2[] = [];
    if (ports) {
      conVL = route(ports.vl, ports.ny, res.start, 80);
      conRL = route(ports.rl, ports.ny, res.exit ?? res.end, 140);
      if (res.exit) conRL.push(res.end);
    }
    const field = polylineLength(res.path); const conn = polylineLength(conVL) + polylineLength(conRL);
    return { path: res.path, conVL, conRL, area, field, conn, length: field + conn, ok: true };
  };
  return c.id ? cached(doc, 'mepFbh', c.id, calc) : calc();
}
export const fbhPower = (doc: Doc, c: El) => (fbhLayout(doc, c).area / 1e6) * (c.q ?? 30);

// ------------------------------------------------------------ Darstellung
function drawFbh(dl: DisplayList, doc: Doc, c: El, detail: string, scale: number): void {
  const L = fbhLayout(doc, c); const sys = sysOf(doc, c);
  const bp = { w: 1, color: '#808080', dash: 'dash' as const };
  for (const r of c.loops ?? []) dl.poly(r, bp, true);
  if (detail !== 'coarse' && L.path.length) dl.poly(L.path, { ...sysPen(sys, 1) }, false);
  const vl = doc.get<any>('sys_hvl')?.color ?? '#e02020', rl = doc.get<any>('sys_hrl')?.color ?? '#1f4fd8';
  if (L.conVL.length) dl.poly(L.conVL, { w: 1, color: vl, dash: 'dash' }, false, { ns: true });
  if (L.conRL.length) dl.poly(L.conRL, { w: 1, color: rl, dash: 'dash' }, false, { ns: true });
  if (c.loops?.[0]?.length) {
    const ip = interiorPoint(c.loops as Poly);
    const txt = `${c.name ?? 'HK'}: VA ${fmtNum((c.spacing ?? 150) / 10, 0)} cm, ${fmtNum(L.length / 1000, 0)} m, ${fmtNum(fbhPower(doc, c), 0)} W`;
    dl.text(ip, txt, { size: 1.8, ha: 'center', va: 'middle', color: sys.color, opaque: true });
    if (L.length > 120000) dl.text({ x: ip.x, y: ip.y - 2.6 * scale }, '⚠ Kreis > 120 m', { size: 1.6, ha: 'center', va: 'middle', color: '#c00000' });
  }
}

function fbhSolids(doc: Doc, c: El): Solid[] {
  const L = fbhLayout(doc, c); if (L.path.length < 2) return [];
  const z = levelElev(doc, c.levelId) + (c.offset ?? -50);
  const prof = circleProfile((c.dia ?? 16) / 2, 6);
  const sys = sysOf(doc, c);
  const out: Solid[] = [{ faces: sweep(L.path.map((p) => ({ x: p.x, y: p.y, z })), prof), color: sys.color, role: 'mep' }];
  for (const con of [L.conVL, L.conRL]) if (con.length > 1) out.push({ faces: sweep(con.map((p) => ({ x: p.x, y: p.y, z })), prof), color: sys.color, role: 'mep' });
  return out;
}

function fbhProps(): PropDef[] {
  const g = GROUPS; const M = 'Mechanisch';
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Rohrachse über Ebene', group: g.constraints, type: 'length', get: (e) => e.offset ?? -50, set: (_e, v) => ({ offset: v }) },
    { key: 'name', label: 'Heizkreis', group: g.identity, type: 'text', get: (e) => e.name ?? '', set: (_e, v) => ({ name: v }) },
    { key: 'system', label: 'Systemtyp', group: M, type: 'select', options: (d) => systemOptions(d, 'H'), get: (e, d) => sysOf(d, e).id, set: (_e, v) => ({ system: v }) },
    { key: 'manifoldId', label: 'Verteiler', group: M, type: 'select', options: (d) => [['', '–'], ...d.all('mepFixture').filter((f) => d.get<FixType>(f.typeId)?.sym === 'manifold').map((f) => [f.id, `${f.label ?? d.get<FixType>(f.typeId)?.label ?? 'Verteiler'} (${d.get(f.levelId)?.name ?? ''})`] as [string, string])], get: (e) => e.manifoldId ?? '', set: (_e, v) => ({ manifoldId: v || undefined }) },
    { key: 'pattern', label: 'Verlegemuster', group: M, type: 'select', options: [['meander', 'Mäander'], ['snail', 'Schnecke (bifilar)']], get: (e) => e.pattern ?? 'meander', set: (_e, v) => ({ pattern: v }) },
    { key: 'spacing', label: 'Verlegeabstand VA', group: M, type: 'length', get: (e) => e.spacing ?? 150, set: (_e, v) => ({ spacing: Math.max(50, v) }) },
    { key: 'edge', label: 'Randabstand', group: M, type: 'length', get: (e) => e.edge ?? 100, set: (_e, v) => ({ edge: Math.max(0, v) }) },
    { key: 'angle', label: 'Verlegerichtung', group: M, type: 'angle', get: (e) => e.angle ?? angleOf(longestEdgeDir(e.loops?.[0] ?? [{ x: 0, y: 0 }, { x: 1, y: 0 }])), set: (_e, v) => ({ angle: v }) },
    { key: 'dia', label: 'Rohrdurchmesser', group: g.dims, type: 'length', get: (e) => e.dia ?? 16, set: (_e, v) => ({ dia: Math.max(8, v) }) },
    { key: 'q', label: 'Spez. Heizleistung (W/m²)', group: M, type: 'number', get: (e) => e.q ?? 30, set: (_e, v) => ({ q: Math.max(0, v) }) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, d) => (e.loops ? fbhLayout(d, e).area : 0) },
    { key: 'field', label: 'Rohrlänge Feld', group: g.dims, type: 'readonly', get: (e, d) => fmtNum(fbhLayout(d, e).field / 1000, 1) + ' m' },
    { key: 'conn', label: 'Anbindeleitungen', group: g.dims, type: 'readonly', get: (e, d) => fmtNum(fbhLayout(d, e).conn / 1000, 1) + ' m' },
    { key: 'length', label: 'Kreislänge', group: g.dims, type: 'readonly', get: (e, d) => fmtNum(fbhLayout(d, e).length / 1000, 1) + ' m' },
    { key: 'power', label: 'Heizleistung', group: M, type: 'readonly', get: (e, d) => fmtNum(fbhPower(d, e), 0) + ' W' },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

registerCategory({
  cat: 'fbh', label: 'Fussbodenheizkreis', plural: 'Fussbodenheizkreise', planOrder: 30,
  visibleIn: (_el, _doc, view) => discVisible(view, 'H'),
  drawPlan: (ctx, el) => {
    // gehört zum Geschoss seiner Ebene (liegt im Unterlagsboden knapp über/unter der Ebene)
    if (ctx.level && el.levelId !== ctx.level.id) {
      const z = levelElev(ctx.doc, el.levelId) + (el.offset ?? 50); const [lo, hi] = planBand(ctx);
      if (z < lo || z > hi || Math.abs(z - (ctx.level.elev ?? 0)) > 300) return;
    }
    drawFbh(ctx.dl, ctx.doc, el, ctx.detail, ctx.view.scale || 100);
  },
  solids: (el, doc) => fbhSolids(doc, el),
  grips: (el, _doc, view): Grip[] => loopGrips(el.loops, view),
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : undefined; },
  transform: (el, m: Mat2, _doc, view) => (isPlanLike(view) ? { loops: transformLoops(el.loops, m), ...(el.angle !== undefined ? { angle: angleOf(sub(apply(m, { x: Math.cos(el.angle), y: Math.sin(el.angle) }), apply(m, { x: 0, y: 0 }))) } : {}) } : undefined),
  translate3d: (el, d) => ({ loops: moveLoops(el.loops, d), offset: (el.offset ?? -50) + d.z }),
  center: (el) => (el.loops?.length ? interiorPoint(el.loops as Poly) : null),
  props: () => fbhProps(),
  tagText: (el, doc) => `${el.name ?? 'HK'} VA ${fmtNum((el.spacing ?? 150) / 10, 0)} cm ${fmtNum(fbhLayout(doc, el).length / 1000, 0)} m`,
  tagPoint: (el) => (el.loops?.length ? interiorPoint(el.loops as Poly) : null),
  scheduleFields: () => [
    { key: 'name', label: 'Heizkreis', get: (el) => el.name ?? '' },
    { key: 'room', label: 'Raum', get: (el, doc) => roomOf(doc, el) },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => fbhLayout(doc, el).area },
    { key: 'spacing', label: 'VA', unit: 'len', get: (el) => el.spacing ?? 150 },
    { key: 'length', label: 'Rohrlänge', unit: 'len', get: (el, doc) => fbhLayout(doc, el).length },
    { key: 'power', label: 'Leistung (W)', unit: 'num', get: (el, doc) => Math.round(fbhPower(doc, el)) },
    { key: 'manifold', label: 'Verteiler', get: (el, doc) => { const m = doc.get(el.manifoldId); return m ? m.label ?? doc.get<FixType>(m.typeId)?.label ?? '' : ''; } },
  ],
  ifc: (el, doc) => {
    const L = fbhLayout(doc, el);
    return { entity: 'IfcPipeSegment', predefined: 'FLEXIBLESEGMENT', name: `FBH ${el.name ?? ''}`.trim(), psets: { Pset_OpenRiss_HLKSE: { Heizkreis: el.name ?? '', Raum: roomOf(doc, el), Flaeche_m2: Math.round(L.area / 1e4) / 100, VA_mm: el.spacing ?? 150, Rohrlaenge_m: Math.round(L.length / 100) / 10, Leistung_W: Math.round(fbhPower(doc, el)), Muster: el.pattern ?? 'meander' } } };
  },
});

function roomOf(doc: Doc, el: El): string {
  if (!el.loops?.length) return '';
  const ip = interiorPoint(el.loops as Poly);
  const r = doc.all('room').find((x) => x.levelId === el.levelId && x.pt && pointInRing(x.pt, el.loops[0]) ) ?? doc.all('room').find((x) => x.levelId === el.levelId && x.pt && dist(x.pt, ip) < 1);
  return r ? `${r.number ?? ''} ${r.name ?? ''}`.trim() : '';
}

// ------------------------------------------------------------ Erzeugen
export function nextCircuitName(doc: Doc, levelId: Id): string {
  const n = doc.all('fbh').filter((f) => f.levelId === levelId).length + 1;
  return 'HK ' + n;
}
/** nächster FBH-Verteiler auf derselben Ebene */
export function nearestManifold(doc: Doc, levelId: Id, p: V2): Id | undefined {
  let best: Id | undefined; let bd = Infinity;
  for (const f of doc.all('mepFixture')) {
    if (f.levelId !== levelId || doc.get<FixType>(f.typeId)?.sym !== 'manifold') continue;
    const d = dist(fixPos(doc, f).p, p); if (d < bd) { bd = d; best = f.id; }
  }
  return best;
}
export function addCircuit(doc: Doc, levelId: Id, loops: V2[][], o: Partial<FbhCircuit> = {}): FbhCircuit {
  const ip = interiorPoint(loops as Poly);
  return doc.add<FbhCircuit>({
    spacing: 150, pattern: 'meander', edge: 100, dia: 16, offset: -50, system: 'sys_fbh', q: 30,
    name: nextCircuitName(doc, levelId), manifoldId: nearestManifold(doc, levelId, ip),
    ...o, id: newId('hk'), cat: 'fbh', levelId, loops,
  } as FbhCircuit);
}

// ------------------------------------------------------------ Werkzeuge
function fbhPlacement() {
  const lvl = activeLevelId();
  const pl = placementFor('fbh', { levelId: lvl, spacing: 150, pattern: 'meander', edge: 100, dia: 16, offset: -50, system: 'sys_fbh', q: 30 });
  pl.proto.levelId = lvl;
  return pl;
}
const fbhOptions = (p: El): OptionItem[] => [
  { kind: 'select', key: 'pat', label: 'Muster', value: p.pattern ?? 'meander', options: [['meander', 'Mäander'], ['snail', 'Schnecke']], onChange: (v) => { p.pattern = v; } },
  { kind: 'length', key: 'va', label: 'VA', value: p.spacing ?? 150, width: 60, onChange: (v) => { p.spacing = Math.max(50, v); } },
  { kind: 'length', key: 'edge', label: 'Rand', value: p.edge ?? 100, width: 60, onChange: (v) => { p.edge = Math.max(0, v); } },
];

/** Heizkreis-Fläche skizzieren */
export function startFbhSketch(): void {
  const pl = fbhPlacement();
  const t: SketchTool = new SketchTool('Fussbodenheizkreis', (loops) => {
    const { id: _i, cat: _c, ...rest } = pl.proto;
    app.doc.transaction('Heizkreis erstellen', () => { addCircuit(app.doc, pl.proto.levelId || activeLevelId(), loops, rest as Partial<FbhCircuit>); });
  }, { kinds: ['plan'], wallRef: 'int', extra: () => fbhOptions(pl.proto) });
  t.placement = pl;
  t.deactivate = () => rememberProto(pl);
  startTool(t, 'mepFbh');
}

/** Heizkreis durch Klick in einen Raum (Bereich innerhalb der Wände) */
export class FbhRoomTool extends Tool {
  id = 'mepFbhRoom'; label = 'Heizkreis in Raum'; kinds = ['plan'];
  private hover: V2[][] | null = null;
  activate(): void { this.placement = fbhPlacement(); }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Klicken Sie in einen umschlossenen Raum, um einen Fussbodenheizkreis zu erzeugen.'; }
  options(): OptionItem[] { return fbhOptions(this.placement!.proto); }
  move(e: ToolEvent): void {
    const r = regionAt(app.doc, e.view.levelId ?? activeLevelId(e.view), e.raw);
    this.hover = r && !r.open ? r.poly : null;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.hover) { app.status('Kein umschlossener Bereich unter dem Cursor.'); return; }
    const loops = this.hover.map((r) => r.map((p) => ({ ...p })));
    const p = this.placement!.proto; const { id: _i, cat: _c, ...rest } = p;
    app.doc.transaction('Heizkreis erstellen', () => { addCircuit(app.doc, p.levelId || activeLevelId(e.view), loops, rest as Partial<FbhCircuit>); });
  }
  preview(dl: DisplayList): void { if (this.hover) for (const r of this.hover) dl.poly(r, { w: 3, color: '#1e6fd9' }, true); }
}

export { fmtArea };
