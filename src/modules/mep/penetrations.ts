// Koordination HLKSE ↔ Tragwerk: «Durchbrüche ermitteln» sucht, wo Rohre/Kanäle/Leerrohre Wände und
// Geschossdecken durchdringen, fasst nahe Durchdringungen zusammen und übergibt sie an das Tragwerk:
//  - Wand: runde Wandöffnung (Kernbohrung, `opening` shape 'round') bzw. Rechtecköffnung; in Aussenwänden unter
//    Terrain optional Futterrohr mit Dichtflansch (`embed` family 'sleeve'), falls das Einlagen-Modul geladen ist
//  - Decke: runde/rechteckige vertikale Öffnung (`shaft` mit hostId = Decke)
//  - Leerrohre/Kanäle in der Deckenstärke: Einlegerohre (`embed` family 'conduit')
// Vor dem Erzeugen läuft der Hook 'mepPenetrations' ({ doc, items, handled: Set<key> }): andere Module können
// Einträge selbst übernehmen und ihren Schlüssel in `handled` eintragen. Erneutes Ausführen aktualisiert die
// früher erzeugten Elemente (Feld `mepKey`) statt sie zu verdoppeln.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, sub, mul, dot, cross, dist, lineLine, pointInPoly, fromAngle, MultiPoly, Poly } from '../../core/geom';
import { catDef, emitHook } from '../../core/registry';
import { levelElev, typesOf } from '../../core/view';
import { cached } from '../../core/cache';
import { Wall, wallInfo, wallOpenings, wallType, wallZAt } from '../../elements/wall';
import { surfaceOf } from '../../views/surfaces';
import { fmtNum } from '../../core/units';
import { floorArea, floorTop, floorThick } from '../architecture/floor';
import { RUN_CATS, MepRun, runInfo, sizeLabel, RunInfo, partnersOf } from './runs';

export interface Penetration {
  key: string;
  kind: 'wall' | 'slab' | 'embed';
  hostId: Id; hostCat: string; hostName: string;
  runIds: Id[];
  /** Mittelpunkt (Welt) */
  p: V3;
  shape: 'round' | 'rect';
  /** Öffnungsmass inkl. Zuschlag: Wand – Breite entlang der Wand × Höhe; Decke – x × y; rund: w = h = Durchmesser */
  w: number; h: number;
  /** Wand: Lage entlang der Achse (ab c0) und UK über Ebene der Wand */
  u?: number; sill?: number;
  /** Decke (rechteckig): Ausrichtung entlang Richtung */
  dir?: V2;
  /** Einlage: Polylinie des zusammenhängenden Strangs in der Decke */
  pts?: V2[];
  /** Wand mit Erdberührung (unter ±0.00, Aussenwand) → Futterrohr */
  wet?: boolean;
  label: string;
  purpose: string;
  /** früher erzeugtes Element mit gleichem Schlüssel */
  existing?: Id;
}
export interface PenOpts {
  /** Zuschlag auf den Aussendurchmesser (total, mm) – Ringspalt */
  clearance?: number;
  /** Durchdringungen näher als dieser Abstand zusammenfassen (mm) */
  merge?: number;
  /** nur Leitungen dieser Ebene */
  levelId?: Id;
  /** Leerrohre/Kanäle in Decken als Einlagen melden */
  embeds?: boolean;
}

/** Kernbohrungs-Durchmesser (Bohrkronen) */
export const CORE_DIAS = [52, 62, 72, 82, 92, 102, 112, 122, 132, 152, 162, 182, 200, 225, 250, 275, 300, 350, 400, 450, 500];
export const coreDia = (d: number): number => CORE_DIAS.find((x) => x >= d - 0.5) ?? Math.ceil(d / 50) * 50;
const up10 = (v: number) => Math.ceil(v / 10 - 1e-9) * 10;

const outer = (ri: RunInfo) => ({ W: ri.W + 2 * ri.ins, H: ri.H + 2 * ri.ins });
const runLabel = (doc: Doc, el: El, ri: RunInfo) => `${ri.sys.abbr} ${sizeLabel(doc, el)}`.trim();

interface Slab { el: El; top: number; bot: number; area: MultiPoly; at: (p: V2) => [number, number] }
/** tragende Geschossdecken (ohne reine Bodenaufbauten); Fläche ohne Schächte, aber inkl. früher erzeugter HLKSE-Öffnungen */
function slabs(doc: Doc): Slab[] {
  return cached(doc, 'mepSlabs', '', () => doc.all('floor').filter((f) => {
    const layers: { fn?: string; core?: boolean }[] | undefined = doc.get(f.typeId)?.layers;
    return f.structural || !layers?.length || layers.some((l) => l.fn === 'structure');
  }).map((f) => {
    const top = floorTop(doc, f);
    const own = doc.all('shaft').filter((s) => s.mepAuto && s.hostId === f.id && s.loops?.[0]?.length).map((s) => [s.loops[0]] as Poly);
    // geneigte Decken: UK/OK am Punkt; top/bot = Hüllhöhen
    const s = surfaceOf(doc, f); const T = floorThick(doc, f);
    if (s && !s.flat) return { el: f, top: s.zMax, bot: s.zMin, area: [...floorArea(doc, f), ...own], at: (p: V2) => [s.botAt(p), s.topAt(p)] as [number, number] };
    return { el: f, top, bot: top - T, area: [...floorArea(doc, f), ...own], at: () => [top - T, top] as [number, number] };
  }));
}
const inArea = (p: V2, a: MultiPoly) => a.some((poly) => pointInPoly(p, poly));

/** Durchdringungen ermitteln (ohne das Modell zu ändern) */
export function findPenetrations(doc: Doc, o: PenOpts = {}): Penetration[] {
  const c = o.clearance ?? 50; const out: Penetration[] = [];
  const walls = doc.all<Wall>('wall').map((w) => ({ w, wi: wallInfo(doc, w) }));
  const sl = slabs(doc);
  const runs = RUN_CATS.flatMap((cat) => doc.all<MepRun>(cat)).filter((r) => !o.levelId || r.levelId === o.levelId);
  for (const r of runs) {
    const ri = runInfo(doc, r); if (ri.L < 1) continue;
    const { W, H } = outer(ri); const lab = runLabel(doc, r, ri);
    // ---------------- Wände
    if (!ri.vertical) {
      for (const { w, wi } of walls) {
        const x = lineLine(r.a, r.b, wi.c0, wi.c1); if (!x) continue;
        if (x.t < -1e-6 || x.t > 1 + 1e-6 || x.u < 0 || x.u > 1) continue;
        const sinA = Math.abs(cross(ri.d2, wi.d)); if (sinA < 0.15) continue;
        const cosA = Math.sqrt(Math.max(0, 1 - sinA * sinA));
        // Leitung kreuzt die Wandachse (endet sie davor, z. B. Anschluss an der Wand, zählt sie nicht)
        const zc = ri.A.z + (ri.B.z - ri.A.z) * x.t;
        const u = x.u * wi.L;
        const [wz0, wz1] = wallZAt(doc, w, u);
        if (zc <= wz0 + 1 || zc >= wz1 - 1) continue;
        const slopeZ = ri.L2 > 1 ? Math.abs(ri.B.z - ri.A.z) / ri.L2 * (wi.T / sinA) : 0;
        const wAlong = W / sinA + (wi.T * cosA) / sinA, hz = H + slopeZ;
        // in bestehender Öffnung (Tür/Fenster/Öffnung, nicht von HLKSE erzeugt)?
        const inside = wallOpenings(doc, w).some((op) => !op.el.mepKey && op.u0 <= u - wAlong / 2 && op.u1 >= u + wAlong / 2 && op.z0 <= zc - hz / 2 && op.z1 >= zc + hz / 2);
        if (inside) continue;
        const round = ri.round && sinA > 0.95 && slopeZ < 20;
        const base = levelElev(doc, w.levelId);
        const wt = wallType(doc, w);
        const wet = round && zc < 0 && (wt?.function === 'exterior' || wt?.function === 'foundation' || wt?.function === 'retaining');
        const d = round ? coreDia(W + c) : 0;
        const ww = round ? d : up10(wAlong + c), hh = round ? d : up10(hz + c);
        out.push({
          key: '', kind: 'wall', hostId: w.id, hostCat: 'wall', hostName: wt?.name ?? 'Wand', runIds: [r.id],
          p: { x: x.p.x, y: x.p.y, z: zc }, shape: round ? 'round' : 'rect', w: ww, h: hh, u, sill: zc - hh / 2 - base, wet,
          label: '', purpose: lab,
        });
      }
    }
    // ---------------- Decken
    for (const s of sl) {
      const zl = Math.min(ri.A.z, ri.B.z), zh = Math.max(ri.A.z, ri.B.z);
      if (ri.vertical) {
        const [sb, stp] = s.at(r.a);
        if (zl < sb - 1 && zh > stp + 1 && inArea(r.a, s.area)) {
          const d = coreDia(W + c);
          out.push({ key: '', kind: 'slab', hostId: s.el.id, hostCat: 'floor', hostName: doc.get(s.el.typeId)?.name ?? 'Decke', runIds: [r.id], p: { x: r.a.x, y: r.a.y, z: (sb + stp) / 2 }, shape: ri.round ? 'round' : 'rect', w: ri.round ? d : up10(W + c), h: ri.round ? d : up10(H + c), dir: { x: 1, y: 0 }, label: '', purpose: lab });
        }
        continue;
      }
      // geneigte Leitung durch die Decke (geneigte Decke: Durchstosspunkt iterativ)
      let zm = (s.top + s.bot) / 2, p2 = r.a, sb = s.bot, stp = s.top;
      for (let k = 0; k < 3; k++) {
        const t = (zm - ri.A.z) / (ri.B.z - ri.A.z || 1e-9);
        p2 = add(r.a, mul(sub(r.b, r.a), t)); [sb, stp] = s.at(p2); zm = (sb + stp) / 2;
      }
      if (zl < sb - 1 && zh > stp + 1) {
        if (inArea(p2, s.area)) {
          const tanA = ri.L2 / Math.abs(ri.B.z - ri.A.z);
          const len = W / Math.max(0.1, Math.cos(Math.atan(tanA))) + (stp - sb) * tanA;
          out.push({ key: '', kind: 'slab', hostId: s.el.id, hostCat: 'floor', hostName: doc.get(s.el.typeId)?.name ?? 'Decke', runIds: [r.id], p: { x: p2.x, y: p2.y, z: zm }, shape: 'rect', w: up10(len + c), h: up10(W + c), dir: ri.d2, label: '', purpose: lab });
        }
        continue;
      }
      // in der Deckenstärke verlegt → Einlage
      const [ba, ta] = s.at(r.a), [bb, tb] = s.at(r.b);
      const inSlab = Math.min(ri.A.z - ba, ri.B.z - bb) - H / 2 > 5 && Math.min(ta - ri.A.z, tb - ri.B.z) - H / 2 > 5;
      if (o.embeds !== false && r.cat !== 'pipe' && inSlab && inArea(r.a, s.area) && inArea(r.b, s.area)) {
        out.push({ key: '', kind: 'embed', hostId: s.el.id, hostCat: 'floor', hostName: doc.get(s.el.typeId)?.name ?? 'Decke', runIds: [r.id], p: { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2, z: (ri.A.z + ri.B.z) / 2 }, shape: 'round', w: ri.W, h: ri.H, label: '', purpose: lab });
      }
    }
  }
  const merged = mergePens(doc, chainEmbeds(doc, out), o.merge ?? 100, c);
  // Schlüssel, Bezeichnungen und vorhandene Elemente
  const existing = new Map<string, Id>();
  for (const e of [...doc.all('opening'), ...doc.all('shaft'), ...doc.all('embed')]) if (e.mepKey) existing.set(e.mepKey, e.id);
  let nr = 0;
  for (const p of merged) {
    p.key = `${p.kind}|${p.hostId}|${[...p.runIds].sort().join(',')}`;
    p.existing = existing.get(p.key);
    if (p.kind !== 'embed') p.label = 'DB-' + String(++nr).padStart(2, '0');
  }
  return merged;
}

/** Einlegerohre: verbundene Leitungen derselben Decke zu einem Strang (eine Einlage mit Polylinie) zusammenfassen */
function chainEmbeds(doc: Doc, list: Penetration[]): Penetration[] {
  const emb = list.filter((p) => p.kind === 'embed');
  const byRun = new Map(emb.map((p) => [p.runIds[0], p]));
  const next = (id: Id): Id | undefined => partnersOf(doc, id, 'b').find((q) => q.end === 'a' && byRun.get(q.id)?.hostId === byRun.get(id)!.hostId)?.id;
  const hasPrev = new Set<Id>(); for (const id of byRun.keys()) { const n = next(id); if (n) hasPrev.add(n); }
  const done = new Set<Id>(); const out: Penetration[] = list.filter((p) => p.kind !== 'embed');
  const starts = [...byRun.keys()].filter((id) => !hasPrev.has(id)).concat([...byRun.keys()]);
  for (const id0 of starts) {
    if (done.has(id0)) continue;
    const ids: Id[] = []; let id: Id | undefined = id0;
    while (id && !done.has(id)) { done.add(id); ids.push(id); id = next(id); }
    const runs = ids.map((i) => doc.get<MepRun>(i)!);
    const pts: V2[] = [{ ...runs[0].a }, ...runs.map((r) => ({ ...r.b }))];
    const f = byRun.get(ids[0])!; const m = pts[Math.floor(pts.length / 2)];
    out.push({ ...f, runIds: ids, pts, p: { x: m.x, y: m.y, z: f.p.z } });
  }
  return out;
}

/** nahe Durchdringungen im selben Bauteil zu einer Rechtecköffnung zusammenfassen */
function mergePens(doc: Doc, list: Penetration[], gap: number, c: number): Penetration[] {
  const out: Penetration[] = []; const used = new Set<number>();
  // Duplikate (Knick der Leitung genau in der Wand-/Deckenachse): gleiche Stelle → eine Durchdringung
  const d3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  list.forEach((p, i) => {
    for (let j = 0; j < i; j++) {
      const q = list[j];
      if (used.has(j) || q.kind !== p.kind || q.hostId !== p.hostId || p.kind === 'embed' || d3(q.p, p.p) > 5) continue;
      for (const id of p.runIds) if (!q.runIds.includes(id)) q.runIds.push(id);
      if (p.w > q.w || p.h > q.h) Object.assign(q, { w: Math.max(p.w, q.w), h: Math.max(p.h, q.h), shape: p.shape === q.shape ? q.shape : 'rect', sill: p.sill !== undefined && q.sill !== undefined ? Math.min(p.sill, q.sill) : q.sill });
      used.add(i); break;
    }
  });
  const rest = list.filter((_, i) => !used.has(i));
  const groups: Penetration[][] = [];
  for (const p of rest) {
    if (p.kind === 'embed') { groups.push([p]); continue; }
    const g = groups.find((gr) => gr[0].kind === p.kind && gr[0].hostId === p.hostId && gr.some((q) => boxGap(q, p) < gap));
    if (g) g.push(p); else groups.push([p]);
  }
  for (const g of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const f = g[0];
    if (f.kind === 'wall') {
      const u0 = Math.min(...g.map((p) => p.u! - p.w / 2)), u1 = Math.max(...g.map((p) => p.u! + p.w / 2));
      const z0 = Math.min(...g.map((p) => p.p.z - p.h / 2)), z1 = Math.max(...g.map((p) => p.p.z + p.h / 2));
      const w = doc.get<Wall>(f.hostId)!; const wi = wallInfo(doc, w); const base = levelElev(doc, w.levelId);
      const u = (u0 + u1) / 2, zc = (z0 + z1) / 2;
      const ww = up10(u1 - u0), hh = up10(z1 - z0);
      const P = add(wi.c0, mul(wi.d, u));
      out.push({ ...f, runIds: g.flatMap((p) => p.runIds), p: { x: P.x, y: P.y, z: zc }, shape: 'rect', w: ww, h: hh, u, sill: zc - hh / 2 - base, wet: g.some((p) => p.wet), purpose: g.map((p) => p.purpose).join(' + ') });
    } else {
      const xs = g.flatMap((p) => [p.p.x - p.w / 2, p.p.x + p.w / 2]), ys = g.flatMap((p) => [p.p.y - p.h / 2, p.p.y + p.h / 2]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({ ...f, runIds: g.flatMap((p) => p.runIds), p: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: f.p.z }, shape: 'rect', w: up10(x1 - x0), h: up10(y1 - y0), dir: { x: 1, y: 0 }, purpose: g.map((p) => p.purpose).join(' + ') });
    }
  }
  void c;
  return out;
}
function boxGap(a: Penetration, b: Penetration): number {
  if (a.kind === 'wall') {
    const du = Math.abs(a.u! - b.u!) - (a.w + b.w) / 2, dz = Math.abs(a.p.z - b.p.z) - (a.h + b.h) / 2;
    return Math.max(du, dz);
  }
  return Math.max(Math.abs(a.p.x - b.p.x) - (a.w + b.w) / 2, Math.abs(a.p.y - b.p.y) - (a.h + b.h) / 2);
}

// ------------------------------------------------------------ Übergabe an das Tragwerk
export interface ApplyOpts { sleeves?: boolean; embeds?: boolean; removeStale?: boolean }
export interface ApplyResult { created: Id[]; updated: Id[]; removed: number; handedOver: number; skipped: number }

const circleLoop = (c: V2, r: number, n = 32): V2[] => { const out: V2[] = []; for (let i = 0; i < n; i++) out.push(add(c, fromAngle((i / n) * Math.PI * 2, r))); return out; };
function rectLoop(c: V2, w: number, h: number, dir: V2 = { x: 1, y: 0 }): V2[] {
  const n = { x: -dir.y, y: dir.x }; const A = mul(dir, w / 2), B = mul(n, h / 2);
  return [sub(sub(c, A), B), sub(add(c, A), B), add(add(c, A), B), add(sub(c, A), B)];
}
function embedTypeFor(doc: Doc, family: string, dia: number): El | undefined {
  const ts = typesOf(doc, 'embed').filter((t) => t.family === family);
  return ts.filter((t) => (t.dia ?? 0) >= dia - 0.5).sort((a, b) => (a.dia ?? 0) - (b.dia ?? 0))[0] ?? ts.sort((a, b) => Math.abs((a.dia ?? 0) - dia) - Math.abs((b.dia ?? 0) - dia))[0];
}

/** Durchbrüche/Einlagen erzeugen bzw. aktualisieren (innerhalb einer Transaktion aufrufen) */
export function applyPenetrations(doc: Doc, items: Penetration[], o: ApplyOpts = {}): ApplyResult {
  const res: ApplyResult = { created: [], updated: [], removed: 0, handedOver: 0, skipped: 0 };
  const handled = new Set<string>();
  emitHook('mepPenetrations', { doc, items, handled });
  res.handedOver = handled.size;
  const hasEmbed = !!catDef('embed');
  const keys = new Set(items.map((p) => p.key));
  const put = (p: Penetration, el: El) => {
    const ex = p.existing && doc.get(p.existing);
    if (ex && ex.cat === el.cat) { const { id: _i, ...patch } = el; doc.update(ex.id, patch); res.updated.push(ex.id); }
    else { if (ex) doc.remove(ex.id); doc.add(el); res.created.push(el.id); }
  };
  for (const p of items) {
    if (handled.has(p.key)) continue;
    const common = { mepAuto: true, mepKey: p.key, mark: p.label || undefined, comments: `HLKSE: ${p.purpose}` };
    if (p.kind === 'wall') {
      const w = doc.get<Wall>(p.hostId); if (!w) { res.skipped++; continue; }
      const base = levelElev(doc, w.levelId);
      if (p.wet && o.sleeves !== false && hasEmbed && p.shape === 'round') {
        const t = embedTypeFor(doc, 'sleeve', p.w);
        if (t) { put(p, { id: newId('em'), cat: 'embed', family: 'sleeve', typeId: t.id, hostId: w.id, levelId: w.levelId, t: p.u!, z: p.p.z - base, dia: p.w, ...common } as El); continue; }
      }
      if (!catDef('opening')) { res.skipped++; continue; }
      put(p, { id: newId(p.shape === 'round' ? 'kb' : 'wo'), cat: 'opening', hostId: w.id, levelId: w.levelId, t: p.u!, width: p.w, height: p.h, sill: p.sill!, ...(p.shape === 'round' ? { shape: 'round' } : {}), ...common } as El);
    } else if (p.kind === 'slab') {
      const f = doc.get(p.hostId); if (!f || !catDef('shaft')) { res.skipped++; continue; }
      const c = { x: p.p.x, y: p.p.y };
      const loops = [p.shape === 'round' ? circleLoop(c, p.w / 2) : rectLoop(c, p.w, p.h, p.dir)];
      put(p, { id: newId('vo'), cat: 'shaft', loops, hostId: f.id, levelId: f.levelId, baseOffset: 0, topLevelId: null, topOffset: 0, height: 0, ...(p.shape === 'round' ? { shape: 'round', dia: p.w } : {}), ...common } as El);
    } else if (p.kind === 'embed') {
      if (o.embeds === false || !hasEmbed) { res.skipped++; continue; }
      const r = doc.get<MepRun>(p.runIds[0]); if (!r) { res.skipped++; continue; }
      const ri = runInfo(doc, r);
      const fam = 'conduit';
      const t = embedTypeFor(doc, fam, ri.W); if (!t) { res.skipped++; continue; }
      put(p, { id: newId('em'), cat: 'embed', family: fam, typeId: t.id, levelId: r.levelId, z: (ri.A.z + ri.B.z) / 2 - levelElev(doc, r.levelId), pts: (p.pts ?? [r.a, r.b]).map((q) => ({ ...q })), dia: ri.W, ...common, mark: undefined } as El);
    }
  }
  if (o.removeStale !== false) {
    for (const e of [...doc.all('opening'), ...doc.all('shaft'), ...doc.all('embed')]) if (e.mepAuto && e.mepKey && !keys.has(e.mepKey)) { doc.remove(e.id); res.removed++; }
  }
  return res;
}

export function penSizeText(p: Penetration): string {
  if (p.kind === 'embed') return p.shape === 'round' ? `Ø${fmtNum(p.w, 0)}` : `${fmtNum(p.w, 0)}×${fmtNum(p.h, 0)}`;
  return p.shape === 'round' ? `KB Ø${fmtNum(p.w, 0)}` : `${fmtNum(p.w, 0)}/${fmtNum(p.h, 0)}`;
}
export const PEN_KIND_LABEL: Record<Penetration['kind'], string> = { wall: 'Wand', slab: 'Decke', embed: 'Einlage (Decke)' };
