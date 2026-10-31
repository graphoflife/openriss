// Wandabwicklung: je Wandseite (aussen/innen) eine Ansicht der abgewickelten Wandfläche – intern ein Schnitt
// knapp vor der Wandfläche mit Blick auf die Wand (x entlang der Wand, y = Höhe). Sichtbar ist nur die
// Bewehrung dieser Wandseite; Öffnungen mit Rohbaumassen, Arbeitsfugen (Kategorie-Darstellung im Schnitt)
// und Massketten (Wandlänge, Öffnungen, Höhen) werden aus der aktuellen Wand automatisch gezeichnet.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, V3, add, sub, mul, dot, perp, sub3, dot3 } from '../../core/geom';
import { registerCategory, registerCommand, registerContextPanel, registerPanel, catDef, GROUPS } from '../../core/registry';
import { View, makeProjector } from '../../core/view';
import type { DisplayList } from '../../render/displayList';
import { fmtLen, fmtElev } from '../../core/units';
import { Wall, wallInfo, wallShape, wallOpenings, layerOffsets, WallInfo, wallBounds } from '../../elements/wall';
import { sectionGeomPatch } from '../../elements/datums';
import { Rebar, rebarGeo } from './rebar/rebar';
import { addRebarRule, addViewProps } from './rebar/filter';
import { drawChain } from './rebar/layout';

export type DevSide = 'ext' | 'int';
export interface DevInfo { wallId: Id; side: DevSide }
/** Wandabwicklung? (Schnittansicht mit data.dev) */
export const devOf = (v: View | El | undefined | null): DevInfo | null => (v && v.cat === 'view' && v.kind === 'section' && v.data?.dev?.wallId ? v.data.dev : null);
export const SIDE_LABEL: Record<DevSide, string> = { ext: 'aussen', int: 'innen' };

/** Abstand der Schnittebene vor der Wandfläche */
const GAP = 10;
/** Normale zur betrachteten Seite (zeigt zum Betrachter) */
const sideNormal = (wi: WallInfo, side: DevSide): V2 => mul(wi.n, side === 'ext' ? wi.ext : -wi.ext);

/** Ausdehnung der Wandfläche dieser Seite (side) bzw. des ganzen Wandumrisses entlang u (Wandachse ab c0), inkl. Ecken */
function faceRange(doc: Doc, w: Wall, side: DevSide | null): [number, number] {
  const wi = wallInfo(doc, w);
  const ring = wallShape(doc, w).ring;
  let on = side ? ring.filter((p) => dot(sub(p, wi.c0), sideNormal(wi, side)) > wi.T / 2 - 1) : ring;
  if (on.length < 2) on = ring;
  const us = on.map((p) => dot(sub(p, wi.c0), wi.d));
  return [Math.min(...us), Math.max(...us)];
}
/** Himmelsrichtung, aus der man auf die Wandseite blickt */
function compass(v: V2): string {
  const a = (Math.atan2(v.y, v.x) * 180) / Math.PI;
  const k = Math.round(((a + 360) % 360) / 45) % 8;
  return ['Osten', 'Nordosten', 'Norden', 'Nordwesten', 'Westen', 'Südwesten', 'Süden', 'Südosten'][k];
}

/** Lage der Ansicht (Schnittlinie vor der Wandfläche, Zuschnitt, Tiefe) */
export function devGeomPatch(doc: Doc, w: Wall, side: DevSide, v: Partial<View>): Partial<View> {
  const wi = wallInfo(doc, w); const nV = sideNormal(wi, side);
  const s = v.scale || 50;
  const [u0, u1] = faceRange(doc, w, null);
  const d = perp(nV); // Blickrichtung = -nV → Zeichenrichtung der Schnittlinie
  const sgn = dot(d, wi.d); // +1: x läuft mit der Wand, -1: gegen die Wand
  const P = (u: number) => add(add(wi.c0, mul(wi.d, u)), mul(nV, wi.T / 2 + GAP));
  const mL = 300 + 22 * s, mR = 300 + 13 * s;
  const A = sgn > 0 ? P(u0 - mL) : P(u1 + mL), B = sgn > 0 ? P(u1 + mR) : P(u0 - mR);
  const wb = wallBounds(doc, w); // Hülle (Ober-/Unterkante mit Profil)
  const crop = { on: true, show: false, min: { x: 0, y: wb.zMin - 300 - 13 * s }, max: { x: 0, y: wb.zMax + 300 + 3 * s } };
  return { ...sectionGeomPatch(A, B, { ...v, crop } as View), far: wi.T + 2 * GAP };
}

const HIDE = ['door', 'window', 'room', 'roomtag', 'tag', 'stair', 'railing', 'component', 'level', 'grid', 'mepFixture', 'mepSystem'];

/** Abwicklungen einer Wand anlegen bzw. vorhandene an die Wand anpassen (in Transaktion). Liefert Ansichts-IDs. */
export function createWallDevelopment(doc: Doc, w: Wall, sides: DevSide[] = ['ext', 'int'], scale = 50): Id[] {
  const out: Id[] = [];
  const wi = wallInfo(doc, w);
  for (const side of sides) {
    const old = doc.all<View>('view').find((v) => devOf(v)?.wallId === w.id && devOf(v)?.side === side);
    if (old) { doc.update(old.id, devGeomPatch(doc, w, side, old)); out.push(old.id); continue; }
    const name = `Abwicklung ${w.mark || w.id} – Seite ${SIDE_LABEL[side]} (Blick von ${compass(sideNormal(wi, side))})`;
    const v: any = {
      id: newId('vw'), cat: 'view', kind: 'section', name, scale, detail: 'fine', discipline: 'struct',
      hiddenCats: HIDE.slice(), data: { dev: { wallId: w.id, side }, marker: '' },
    };
    Object.assign(v, devGeomPatch(doc, w, side, v));
    doc.add(v);
    doc.add({ id: newId('da'), cat: 'wallDevAnno', viewId: v.id, chains: true, labels: true } as El);
    out.push(v.id);
  }
  return out;
}

// ------------------------------------------------------------ Sichtbarkeit
/** Liegt der Bewehrungssatz auf der betrachteten Wandseite? (Mittellage: erste Seite, z. B. Steckbügel) */
export function rebarOnSide(doc: Doc, el: Rebar, dv: DevInfo): boolean {
  const w = doc.get<Wall>(dv.wallId); if (!w) return false;
  const wi = wallInfo(doc, w); const g = rebarGeo(doc, el);
  const dir = el.dir ?? { x: 0, y: 0, z: 1 };
  let o0 = Infinity, o1 = -Infinity, u0 = Infinity, u1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const c0: V3 = { x: wi.c0.x, y: wi.c0.y, z: 0 }; const n3: V3 = { x: wi.n.x * wi.ext, y: wi.n.y * wi.ext, z: 0 }; const d3: V3 = { x: wi.d.x, y: wi.d.y, z: 0 };
  for (const t of [g.offs[0] ?? 0, g.offs[g.n - 1] ?? 0]) for (const p of g.path) {
    const q = sub3({ x: p.x + dir.x * t, y: p.y + dir.y * t, z: p.z + dir.z * t }, c0);
    const o = dot3(q, n3), u = dot3(q, d3);
    o0 = Math.min(o0, o); o1 = Math.max(o1, o); u0 = Math.min(u0, u); u1 = Math.max(u1, u); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z);
  }
  // nur Stäbe innerhalb der Wanddicke (unabhängig vom Host), die die Wandfläche berühren
  if (o0 < -wi.T / 2 - 20 || o1 > wi.T / 2 + 20 || u1 < -wi.T - 50 || u0 > wi.L + wi.T + 50 || z1 < wallBounds(doc, w).zMin - 50 || z0 > wallBounds(doc, w).zMax + 50) return false;
  // Seite bezogen auf die Mitte des Tragkerns (Schichtaufbau mit Dämmung aussen)
  const core = layerOffsets(doc, w).filter((l) => l.lay.core).flatMap((l) => [l.o0 * wi.ext, l.o1 * wi.ext]);
  const c0m = core.length ? Math.min(...core) : -wi.T / 2, c1m = core.length ? Math.max(...core) : wi.T / 2;
  const m = (o0 + o1) / 2 - (c0m + c1m) / 2;
  if (Math.abs(m) < Math.max(10, 0.15 * (c1m - c0m))) return dv.side === 'ext';
  return dv.side === 'ext' ? m > 0 : m < 0;
}
addRebarRule((doc, el, view) => {
  const dv = devOf(view); if (!dv) return true;
  return el.cat === 'rebar' ? rebarOnSide(doc, el as Rebar, dv) : el.hostId === dv.wallId;
});
{
  // Abwicklungen erscheinen nicht als Schnittsymbol im Grundriss
  const def = catDef('view');
  if (def) { const base = def.visibleIn; def.visibleIn = (el, doc, view) => !devOf(el) && (!base || base(el, doc, view)); }
}

// ------------------------------------------------------------ Automatische Bemassung und Öffnungen
function drawDevAnno(dl: DisplayList, el: El, doc: Doc, view: View): void {
  const dv = devOf(view); if (!dv) return;
  const w = doc.get<Wall>(dv.wallId); if (!w) return;
  const wi = wallInfo(doc, w); const pr = makeProjector(view); const s = view.scale || 50;
  const at = (u: number, z: number): V2 => pr.toView({ x: wi.c0.x + wi.d.x * u, y: wi.c0.y + wi.d.y * u, z });
  const X = (u: number) => at(u, 0).x;
  const [fu0, fu1] = faceRange(doc, w, dv.side);
  const xa = Math.min(X(fu0), X(fu1)), xb = Math.max(X(fu0), X(fu1));
  const [ru0, ru1] = faceRange(doc, w, null); const ra = Math.min(X(ru0), X(ru1)), rb = Math.max(X(ru0), X(ru1));
  const pen = { w: 1, color: '#000000' };
  const ops = wallOpenings(doc, w);
  // Öffnungen: Diagonalkreuz + Rohbaumasse
  for (const o of ops) {
    const xs = [X(o.u0), X(o.u1)].sort((a, b) => a - b);
    const p0 = { x: xs[0], y: o.z0 }, p1 = { x: xs[1], y: o.z1 };
    if (!o.profile) { dl.line(p0, p1, pen, { ns: true }); dl.line({ x: p0.x, y: p1.y }, { x: p1.x, y: p0.y }, pen, { ns: true }); }
    if (el.labels !== false) {
      const c = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const t = `${fmtLen(xs[1] - xs[0])} / ${fmtLen(o.z1 - o.z0)}` + (o.z0 > wi.z0 + 1 ? `\nUK ${fmtElev(o.z0)}` : '');
      dl.text(c, t, { size: 2, ha: 'center', va: 'middle', opaque: true });
    }
  }
  // Höhenangaben Wandfuss / Wandkopf (mit Profil: höchster bzw. tiefster Punkt)
  const wb = wallBounds(doc, w);
  if (el.labels !== false) for (const [z, t] of [[wb.zMax, wb.top ? 'OK Wand max.' : 'OK Wand'], [wb.zMin, wb.base ? 'UK Wand min.' : 'UK Wand']] as [number, string][]) {
    dl.line({ x: ra - 20 * s, y: z }, { x: xa, y: z }, pen, { ns: true });
    dl.text({ x: ra - 1.5 * s, y: z + 0.5 * s }, `${t} ${fmtElev(z)}`, { size: 2, ha: 'right', va: 'bottom' });
  }
  if (el.chains === false) return;
  const xdir = { x: 1, y: 0 }, ydir = { x: 0, y: 1 };
  const yb = wb.zMin - 300;
  // Kette 1: Wandenden, Öffnungen, Arbeitsfugen
  const xs = new Set<number>([xa, xb]);
  for (const o of ops) for (const u of [o.u0, o.u1]) { const x = X(u); if (x > xa + 1 && x < xb - 1) xs.add(Math.round(x)); }
  for (const j of doc.all('joint')) if (j.hostId === w.id && typeof j.t === 'number' && j.kind !== 'wallH') { const x = X(j.t); if (x > xa + 1 && x < xb - 1) xs.add(Math.round(x)); }
  const ch1 = [...xs].sort((a, b) => a - b).map((x) => ({ x, y: wb.zMin }));
  if (ch1.length > 2) drawChain(dl, doc, view, ch1, xdir, { x: 0, y: yb - 5 * s });
  // Kette 2: Gesamtlänge der Wandfläche
  drawChain(dl, doc, view, [{ x: xa, y: wb.zMin }, { x: xb, y: wb.zMin }], xdir, { x: 0, y: yb - (ch1.length > 2 ? 10 : 5) * s });
  // Höhenketten rechts: Öffnungskanten, Gesamthöhe
  const zs = new Set<number>([wb.zMin, wb.zMax]);
  for (const o of ops) for (const z of [o.z0, o.z1]) if (z > wb.zMin + 1 && z < wb.zMax - 1) zs.add(Math.round(z));
  const xr = rb + 300;
  const ch3 = [...zs].sort((a, b) => a - b).map((y) => ({ x: xb, y }));
  if (ch3.length > 2) drawChain(dl, doc, view, ch3, ydir, { x: xr + 5 * s, y: 0 });
  drawChain(dl, doc, view, [{ x: xb, y: wb.zMin }, { x: xb, y: wb.zMax }], ydir, { x: xr + (ch3.length > 2 ? 10 : 5) * s, y: 0 });
}

registerCategory({
  cat: 'wallDevAnno', label: 'Abwicklungsbemaßung', plural: 'Abwicklungsbemaßungen', annotation: true, planOrder: 91,
  drawAnnotation: (dl, el, doc, view) => drawDevAnno(dl, el, doc, view),
  props: () => [
    { key: 'chains', label: 'Massketten (Länge, Öffnungen, Höhen)', group: GROUPS.graphics, type: 'bool', get: (e) => e.chains !== false, set: (_e, v) => ({ chains: v }) },
    { key: 'labels', label: 'Öffnungsmasse und Höhenangaben', group: GROUPS.graphics, type: 'bool', get: (e) => e.labels !== false, set: (_e, v) => ({ labels: v }) },
  ],
});

// ------------------------------------------------------------ Ansichtseigenschaften
addViewProps((v, doc) => {
  const dv = devOf(v); if (!dv) return [];
  const g = 'Wandabwicklung';
  return [
    { key: 'devWall', label: 'Wand', group: g, type: 'readonly', get: () => { const w = doc.get(dv.wallId); return w ? (w.mark || w.id) : '– (gelöscht)'; } },
    { key: 'devSide', label: 'Wandseite', group: g, type: 'readonly', get: () => SIDE_LABEL[dv.side] },
    { key: 'devSync', label: 'An Wand anpassen', group: g, type: 'button', get: () => 'Anpassen', action: (e, d) => {
      const w = d.get<Wall>(dv.wallId); if (!w) return;
      d.transaction('Abwicklung anpassen', () => d.update(e.id, devGeomPatch(d, w, dv.side, e as View)));
    } },
  ];
});

// ------------------------------------------------------------ Befehl
registerCommand({
  id: 'wallDevelopment', label: 'Wand- abwicklung', icon: 'section',
  tip: 'Abwicklung der gewählten Wand(e) je Wandseite (aussen/innen) mit der Bewehrung dieser Seite, Öffnungen und Massketten. Vorhandene Abwicklungen werden an die Wand angepasst.',
  enabled: () => app.selected().some((e) => e.cat === 'wall'),
  run: () => {
    const walls = app.selected().filter((e) => e.cat === 'wall') as Wall[];
    if (!walls.length) { app.status('Bitte zuerst eine Wand wählen.'); return; }
    let ids: Id[] = [];
    app.doc.transaction('Wandabwicklung', () => { for (const w of walls) ids = ids.concat(createWallDevelopment(app.doc, w)); });
    app.emit('views');
    if (ids[0]) app.openView(ids[0]);
    app.status(`${ids.length} Abwicklung(en) erstellt bzw. angepasst.`);
  },
});
registerContextPanel({ cats: ['wall'], panel: 'Abwicklung', items: ['wallDevelopment'] });
registerPanel('Ingenieurbau', 'Bewehrung', ['wallDevelopment']);
