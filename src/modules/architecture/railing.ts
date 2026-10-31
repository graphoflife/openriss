// Geländer: Pfad skizzieren (offen) oder auf einer Treppe (Host) – Pfosten im Abstand, Handlauf,
// optional Füllstäbe. Auf Treppen folgt der Pfad der Steigungslinie.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, sub, norm, perp, apply, eq, lerp, lineLine, polylineLength } from '../../core/geom';
import { surfaceOf } from '../../views/surfaces';
import { registerCategory, registerCommand, registerContextPanel, GROUPS, PropDef, PlanCtx, Solid, Face, Grip } from '../../core/registry';
import { levelElev, typeOf, TypeEl, isPlanLike } from '../../core/view';
import { fmtLen } from '../../core/units';
import { box3, catPen } from '../../views/sectionEngine';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { ToolEvent, OptionItem } from '../../tools/tool';
import { SketchTool, SketchSeg } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import { stairSidePath, stairGeom, Stair } from './stair';
import { identityProps, levelName, registerSketchEditor } from './common';

export interface Railing extends El {
  cat: 'railing';
  levelId: Id; baseOffset: number;
  path: V2[];
  /** Treppe als Host: Pfad aus der Treppengeometrie */
  hostId?: Id;
  side?: 1 | -1;
}
export interface RailingType extends TypeEl {
  of: 'railing'; height: number; postSpacing: number; postSize: number; railW: number; railH: number;
  balusters?: boolean; balusterSpacing?: number; mat?: Id;
}
export const railingType = (doc: Doc, r: El) => typeOf<RailingType>(doc, r);

/** 3D-Pfad (Unterkante) des Geländers */
export function railPath(doc: Doc, r: El): V3[] {
  if (r.hostId) {
    const h = doc.get(r.hostId);
    if (h?.cat === 'stair') return stairSidePath(doc, h, r.side === -1 ? -1 : 1);
    // auf Geschossdecke/Rampe/Platte: Pfad folgt der Oberseite (Zwischenpunkte an den Knicklinien), Versatz = baseOffset
    const s = h ? surfaceOf(doc, h) : null;
    if (s) {
      const pts: V2[] = r.path ?? []; const out: V3[] = [];
      const P = (p: V2): V3 => ({ x: p.x, y: p.y, z: s.topAt(p) + (r.baseOffset ?? 0) });
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          const ts = (s.creases ?? []).map((c) => lineLine(pts[i - 1], pts[i], c.a, c.b)).filter((x): x is NonNullable<typeof x> => !!x && x.t > 1e-6 && x.t < 1 - 1e-6).map((x) => x.t).sort((a, b) => a - b);
          for (const t of ts) out.push(P(lerp(pts[i - 1], pts[i], t)));
        }
        out.push(P(pts[i]));
      }
      return out;
    }
  }
  const z = levelElev(doc, r.levelId) + (r.baseOffset ?? 0);
  return (r.path ?? []).map((p: V2) => ({ x: p.x, y: p.y, z }));
}
/** auf einer Treppe gehostet (Pfad aus der Treppe, nicht bearbeitbar) */
const onStair = (doc: Doc, r: El): boolean => !!r.hostId && doc.get(r.hostId)?.cat === 'stair';
const railLen = (pts: V3[]) => polylineLength(pts.map((p) => ({ x: p.x, y: p.y })));

function railSolids(doc: Doc, r: El): Solid[] {
  const pts = railPath(doc, r); if (pts.length < 2) return [];
  const t = railingType(doc, r);
  const H = t?.height ?? 1000, ps = t?.postSize ?? 40, sp = Math.max(200, t?.postSpacing ?? 1000);
  const rw = t?.railW ?? 50, rh = t?.railH ?? 40; const mat = t?.mat ?? 'm_stahl';
  const posts: Face[] = []; const rails: Face[] = []; const bals: Face[] = [];
  const up = { x: 0, y: 0, z: 1 };
  const post = (p: V3, size: number, h: number, into: Face[]) => into.push(...box3({ x: p.x - size / 2, y: p.y - size / 2, z: p.z }, { x: size, y: 0, z: 0 }, { x: 0, y: size, z: 0 }, { x: 0, y: 0, z: h }));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1) continue;
    const n = Math.max(1, Math.round(L / sp));
    for (let k = 0; k < n; k++) post(lerp3(a, b, k / n), ps, H - rh, posts);
    // Handlauf
    const d = norm(sub({ x: b.x, y: b.y }, { x: a.x, y: a.y })); const nn = perp(d);
    const o = { x: a.x - nn.x * rw / 2, y: a.y - nn.y * rw / 2, z: a.z + H - rh };
    rails.push(...box3(o, { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: nn.x * rw, y: nn.y * rw, z: 0 }, { x: 0, y: 0, z: rh }));
    // Füllstäbe + Untergurt
    if (t?.balusters) {
      const bs = Math.max(80, t.balusterSpacing ?? 120); const m = Math.max(1, Math.round(L / bs));
      for (let k = 1; k < m; k++) post({ ...lerp3(a, b, k / m), z: lerp3(a, b, k / m).z + 100 }, 20, H - rh - 100, bals);
      const o2 = { x: a.x - nn.x * 15, y: a.y - nn.y * 15, z: a.z + 80 };
      rails.push(...box3(o2, { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: nn.x * 30, y: nn.y * 30, z: 0 }, { x: 0, y: 0, z: 20 }));
    }
  }
  post(pts[pts.length - 1], ps, H - rh, posts);
  void up;
  const out: Solid[] = [{ faces: posts, mat }, { faces: rails, mat }];
  if (bals.length) out.push({ faces: bals, mat });
  return out;
}
const lerp3 = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

function drawRailingPlan(ctx: PlanCtx, r: El): void {
  if (ctx.ceiling) return;
  const pts = railPath(ctx.doc, r); if (pts.length < 2) return;
  const t = railingType(ctx.doc, r);
  const vis: Pen = catPen(ctx.doc, 'railing', false); const hid: Pen = { w: 1, dash: 'hidden' };
  let mode: 'base' | 'upper' = 'base'; let cut = ctx.cutZ;
  const host = r.hostId ? ctx.doc.get(r.hostId) : undefined;
  if (host?.cat === 'stair') {
    const g = stairGeom(ctx.doc, host);
    if (g.z0 <= ctx.cutZ + 1 && g.z1 > ctx.cutZ && g.z0 >= ctx.depthZ - 1) mode = 'base';
    else if (g.z1 <= ctx.cutZ + 1 && g.z1 >= ctx.depthZ - 1) {
      if (g.z0 < ctx.depthZ - 1) { mode = 'upper'; cut = g.z0 + (ctx.cutZ - (ctx.level?.elev ?? ctx.depthZ)); }
    } else return;
  } else {
    const z = pts[0].z;
    if (!(z <= ctx.cutZ + 1 && z + (t?.height ?? 1000) >= ctx.depthZ - 1)) return;
  }
  const { dl } = ctx;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const A = { x: a.x, y: a.y }, B = { x: b.x, y: b.y };
    // an der Schnitthöhe teilen
    const parts: [V2, V2, boolean][] = [];
    if ((a.z - cut) * (b.z - cut) < 0) { const f = (cut - a.z) / (b.z - a.z); const M = lerp(A, B, f); parts.push([A, M, a.z <= cut], [M, B, b.z <= cut]); }
    else parts.push([A, B, Math.max(a.z, b.z) <= cut + 0.5]);
    for (const [p, q, below] of parts) {
      if (mode === 'upper') { if (!below) dl.line(p, q, vis, { sub: 'rail' }); }
      else dl.line(p, q, below ? vis : hid, { sub: 'rail' });
    }
  }
  // Pfosten (klein, nur unterhalb der Schnittebene)
  if (ctx.detail !== 'coarse') {
    const ps = t?.postSize ?? 40;
    for (const p of pts) if (mode === 'base' ? p.z <= cut : p.z > cut) dl.poly([{ x: p.x - ps / 2, y: p.y - ps / 2 }, { x: p.x + ps / 2, y: p.y - ps / 2 }, { x: p.x + ps / 2, y: p.y + ps / 2 }, { x: p.x - ps / 2, y: p.y + ps / 2 }], { w: 1 }, true, { ns: true });
  }
}

function railingProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Basisebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (e, v) => (e.hostId ? undefined : { levelId: v }) },
    { key: 'baseOffset', label: 'Versatz unten', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (e, v, doc) => (onStair(doc, e) ? undefined : { baseOffset: v }) },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, doc) => (e.hostId ? (doc.get(e.hostId)?.cat === 'stair' ? 'Treppe' : doc.get(e.hostId) ? 'Geschossdecke / Platte' : '') : '<keiner>') },
    { key: 'side', label: 'Seite', group: g.constraints, type: 'select', options: [['1', 'Links'], ['-1', 'Rechts']], get: (e) => String(e.side ?? 1), set: (e, v) => (e.hostId ? { side: v === '-1' ? -1 : 1 } : undefined) },
    { key: 'length', label: 'Länge', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(railLen(railPath(doc, e))) },
    ...identityProps(),
  ];
}
function railingTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'height', label: 'Geländerhöhe', group: g.construction, type: 'length', get: (t) => t.height ?? 1000, set: (_t, v) => ({ height: Math.max(100, v) }) },
    { key: 'postSpacing', label: 'Pfostenabstand', group: g.construction, type: 'length', get: (t) => t.postSpacing ?? 1000, set: (_t, v) => ({ postSpacing: Math.max(200, v) }) },
    { key: 'postSize', label: 'Pfostenquerschnitt', group: g.construction, type: 'length', get: (t) => t.postSize ?? 40, set: (_t, v) => ({ postSize: Math.max(5, v) }) },
    { key: 'railW', label: 'Handlaufbreite', group: g.construction, type: 'length', get: (t) => t.railW ?? 50, set: (_t, v) => ({ railW: Math.max(5, v) }) },
    { key: 'railH', label: 'Handlaufhöhe (Profil)', group: g.construction, type: 'length', get: (t) => t.railH ?? 40, set: (_t, v) => ({ railH: Math.max(5, v) }) },
    { key: 'balusters', label: 'Füllstäbe', group: g.construction, type: 'bool', get: (t) => !!t.balusters, set: (_t, v) => ({ balusters: v }) },
    { key: 'balusterSpacing', label: 'Füllstababstand', group: g.construction, type: 'length', get: (t) => t.balusterSpacing ?? 120, set: (_t, v) => ({ balusterSpacing: Math.max(80, v) }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
  ];
}

registerCategory({
  cat: 'railing', label: 'Geländer', plural: 'Geländer', hasTypes: true, planOrder: 26,
  drawPlan: drawRailingPlan,
  solids: (el, doc) => railSolids(doc, el),
  grips: (el, doc, view): Grip[] => (onStair(doc, el) || !isPlanLike(view) ? [] : (el.path ?? []).map((p: V2, i: number) => ({ id: 'v:' + i, p, kind: 'end' as const }))),
  dragGrip: (el, id, p, doc) => { const m = id.match(/^v:(\d+)$/); if (!m || onStair(doc, el)) return; const i = +m[1]; return { path: el.path.map((q: V2, k: number) => (k === i ? p : q)) }; },
  transform: (el, m, doc, view) => (onStair(doc, el) || !isPlanLike(view) ? undefined : { path: el.path.map((p: V2) => apply(m, p)) }),
  translate3d: (el, d, doc) => (onStair(doc, el) ? undefined : { path: el.path.map((p: V2) => ({ x: p.x + d.x, y: p.y + d.y })), baseOffset: (el.baseOffset ?? 0) + d.z }),
  center: (el, doc) => { const p = railPath(doc, el); return p.length ? { x: (p[0].x + p[p.length - 1].x) / 2, y: (p[0].y + p[p.length - 1].y) / 2 } : null; },
  props: () => railingProps(),
  typeProps: () => railingTypeProps(),
  tagText: (el, doc) => railingType(doc, el)?.name ?? '',
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => railingType(doc, el)?.name ?? '' },
    { key: 'level', label: 'Basisebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'length', label: 'Länge', unit: 'len', get: (el, doc) => railLen(railPath(doc, el)) },
    { key: 'height', label: 'Geländerhöhe', unit: 'len', get: (el, doc) => railingType(doc, el)?.height ?? 1000 },
  ],
});

// ------------------------------------------------------------ Werkzeug
/** Offene Pfade aus der Skizze; geschlossene Züge bekommen den Anfangspunkt als Endpunkt */
function pathsOf(loops: V2[][], segs: SketchSeg[]): V2[][] {
  return loops.map((l) => {
    if (l.length < 2) return l;
    const f = l[0], e = l[l.length - 1];
    const closed = l.length > 2 && segs.some((s) => (eq(s.a, e, 1) && eq(s.b, f, 1)) || (eq(s.b, e, 1) && eq(s.a, f, 1)));
    return closed ? [...l, { ...f }] : l;
  });
}

const RT = { pickHost: false };
class RailingSketchTool extends SketchTool {
  prompt(): string { return RT.pickHost ? 'Treppe wählen, auf der das Geländer platziert wird.' : 'Geländerpfad zeichnen (offen oder geschlossen). „Fertig stellen“ (Enter) beendet.'; }
  down(e: ToolEvent): void {
    if (RT.pickHost) {
      const st = e.vp.hit(e.raw).map((h: { id: Id }) => app.doc.get(h.id)).find((x: El | undefined) => x?.cat === 'stair') as Stair | undefined;
      if (!st) { app.status('Keine Treppe unter dem Cursor.'); return; }
      const p = this.placement?.proto ?? ({} as El);
      app.doc.transaction('Geländer auf Treppe', () => {
        for (const side of [1, -1] as const) {
          if (app.doc.all('railing').some((r) => r.hostId === st.id && (r.side ?? 1) === side)) continue;
          app.doc.add({ id: newId('rl'), cat: 'railing', typeId: p.typeId, levelId: st.levelId, baseOffset: 0, path: [], hostId: st.id, side } as El);
        }
      });
      RT.pickHost = false;
      app.setTool(null);
      return;
    }
    super.down(e);
  }
}

function startRailing(): void {
  const lvl = activeLevelId();
  RT.pickHost = false;
  const t: RailingSketchTool = new RailingSketchTool('Geländer', (loops, segs) => {
    const p = t.placement?.proto ?? ({} as El); const { id: _i, ...rest } = p;
    const paths = pathsOf(loops, segs).filter((q) => q.length >= 2);
    let ids: Id[] = [];
    app.doc.transaction('Geländer erstellen', () => {
      ids = paths.map((path) => app.doc.add({ ...rest, id: newId('rl'), cat: 'railing', levelId: p.levelId || lvl, baseOffset: p.baseOffset ?? 0, path } as El).id);
    });
    app.select(ids);
  }, {
    open: true, kinds: ['plan'],
    extra: (): OptionItem[] => [{ kind: 'button', label: 'Host wählen', icon: 'stair', onClick: () => { RT.pickHost = true; app.setPrompt(app.tool.prompt()); } }],
  });
  t.placement = placementFor('railing', { levelId: lvl, baseOffset: 0, typeId: 'rlt_1000' });
  t.placement.proto.levelId = lvl;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, 'railing');
}

registerCommand({ id: 'railing', label: 'Geländer', icon: 'railing', tip: 'Geländerpfad skizzieren oder mit „Host wählen“ auf eine Treppe setzen', run: startRailing });
registerSimilar('railing', 'railing');
registerContextPanel({ cats: ['railing'], panel: 'Geländer', items: ['floorEditBoundary'] });

registerSketchEditor('railing', (el) => {
  if (onStair(app.doc, el)) { app.status('Das Geländer folgt seiner Treppe; der Pfad kann nicht skizziert werden.'); return; }
  const initial: SketchSeg[] = [];
  const p: V2[] = el.path ?? [];
  for (let i = 0; i + 1 < p.length; i++) initial.push({ a: p[i], b: p[i + 1] });
  const t = new SketchTool('Pfad bearbeiten', (loops, segs) => {
    const paths = pathsOf(loops, segs).filter((q) => q.length >= 2);
    if (!paths.length) return;
    app.doc.transaction('Pfad bearbeiten', () => app.doc.update(el.id, { path: paths[0] }));
    app.select([el.id]);
  }, { open: true, initial, kinds: ['plan'] });
  startTool(t, 'floorEditBoundary');
});

