// HLKSE-Apparate und Plansymbole (parametrische Typen wie Bauteile): Steckdose, Schalter, Leuchten, Rauchmelder,
// Multimedia, Verteiler (Elektro/FBH), Bodenablauf, Anschlusspunkte WC/Lavabo, Heizkörper, Lüftungsventile,
// Wärmepumpe, Speicher, Lüftungsgerät. Wandmontierte Elemente haften an der Wandoberfläche (Host = Wand).
// Lokales System: Ursprung = Einfügepunkt (Wandoberfläche bzw. Mitte), +y zeigt in den Raum.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, dot, dist, angleOf, apply, applyVec, cross, Mat2, arcPoints } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, Solid, Grip } from '../../core/registry';
import { levelElev, typeOf, TypeEl, isPlanLike, levelAbove } from '../../core/view';
import { Wall, wallInfo, wallAt } from '../../elements/wall';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { fmtNum } from '../../core/units';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { Disc, DISC_OPTIONS, DISC_LABEL, sysOf, systemOptions, planBand, discVisible, registerMepTemplate, addType, boxFaces, MepSystem } from './common';

export type FixSym =
  | 'socket' | 'switch' | 'lightC' | 'lightW' | 'smoke' | 'data' | 'boardE'
  | 'manifold' | 'radiator' | 'heatPump' | 'tank'
  | 'floorDrain' | 'conWC' | 'conLA'
  | 'ventSup' | 'ventExh' | 'ahu' | 'box'
  | 'shower' | 'bathtub' | 'sinkK' | 'washer' | 'liftStation' | 'hob' | 'inverter' | 'pas';
export interface FixType extends TypeEl {
  of: 'mepFixture'; sym: FixSym; disc: Disc;
  width: number; depth: number; height: number;
  mount: 'floor' | 'wall' | 'ceiling';
  /** Vorgabe-Montagehöhe (Unterkante) über Ebene */
  elev: number;
  label?: string; count?: number; system?: Id; power?: number; flow?: number; description?: string;
}
export interface Fixture extends El {
  cat: 'mepFixture'; levelId: Id; p: V2; rot: number; offset: number;
  /** wandmontiert: Wand, Lage entlang der Wandachse und Seite (+1 links / −1 rechts) */
  hostId?: Id; t?: number; side?: 1 | -1;
  system?: Id; flow?: number; label?: string;
}

interface SymCtx {
  W: number; D: number; s: number; pen: Pen; thin: Pen; doc: Doc; el: El; t: FixType;
  line(a: V2, b: V2, p?: Pen): void; poly(pts: V2[], closed?: boolean, p?: Pen): void;
  rect(x0: number, y0: number, x1: number, y1: number, p?: Pen): void; circ(c: V2, r: number, p?: Pen, fill?: string): void;
  tri(a: V2, b: V2, c: V2, color: string): void; text(p: V2, s: string, size: number, color?: string): void;
}
interface SymDef { label: string; disc: Disc; anchor: 'wall' | 'center'; ifc: [string, string]; plan(c: SymCtx): void }

const V = (x: number, y: number): V2 => ({ x, y });
const colorOf = (doc: Doc, id: Id) => doc.get<MepSystem>(id)?.color ?? '#404040';

export const FIX_SYMBOLS: Record<FixSym, SymDef> = {
  socket: {
    label: 'Steckdose', disc: 'E', anchor: 'wall', ifc: ['IfcOutlet', 'POWEROUTLET'],
    plan: (c) => {
      const r = 1.5 * c.s, g = 0.5 * c.s; const m = V(0, g + r);
      c.line(V(0, 0), V(0, g)); c.circ(m, r); c.line(V(-r, m.y), V(r, m.y));
      const n = c.el.count ?? c.t.count ?? 1; if (n > 1) c.text(V(r + 0.9 * c.s, m.y + 0.9 * c.s), String(n), 1.8);
    },
  },
  switch: {
    label: 'Schalter', disc: 'E', anchor: 'wall', ifc: ['IfcSwitchingDevice', 'TOGGLESWITCH'],
    plan: (c) => {
      const r = 0.9 * c.s, g = 0.5 * c.s; const m = V(0, g + r);
      c.line(V(0, 0), V(0, g)); c.circ(m, r);
      const d = V(Math.SQRT1_2, Math.SQRT1_2); const q0 = add(m, mul(d, r)), q1 = add(m, mul(d, r + 2.2 * c.s));
      c.line(q0, q1); c.line(q1, add(q1, mul(V(d.y, -d.x), 0.8 * c.s)));
    },
  },
  lightC: {
    label: 'Leuchte (Decke)', disc: 'E', anchor: 'center', ifc: ['IfcLightFixture', 'POINTSOURCE'],
    plan: (c) => { const r = 2.3 * c.s, k = r * Math.SQRT1_2; c.circ(V(0, 0), r); c.line(V(-k, -k), V(k, k)); c.line(V(-k, k), V(k, -k)); },
  },
  lightW: {
    label: 'Leuchte (Wand)', disc: 'E', anchor: 'wall', ifc: ['IfcLightFixture', 'DIRECTIONSOURCE'],
    plan: (c) => { const r = 1.8 * c.s, g = 0.5 * c.s, k = r * Math.SQRT1_2; const m = V(0, g + r); c.line(V(0, 0), V(0, g)); c.circ(m, r); c.line(add(m, V(-k, -k)), add(m, V(k, k))); c.line(add(m, V(-k, k)), add(m, V(k, -k))); },
  },
  smoke: {
    label: 'Rauchmelder', disc: 'E', anchor: 'center', ifc: ['IfcSensor', 'SMOKESENSOR'],
    plan: (c) => { c.circ(V(0, 0), 1.6 * c.s, { ...c.pen, color: '#d02020' }); c.text(V(0, 0), 'R', 1.8, '#d02020'); },
  },
  data: {
    label: 'Multimedia-Dose', disc: 'E', anchor: 'wall', ifc: ['IfcOutlet', 'DATAOUTLET'],
    plan: (c) => { const a = 1.4 * c.s, g = 0.5 * c.s; c.line(V(0, 0), V(0, g)); c.rect(-a, g, a, g + 2 * a); c.text(V(0, g + a), 'MM', 1.4); },
  },
  boardE: {
    label: 'Verteiler Elektro', disc: 'E', anchor: 'wall', ifc: ['IfcElectricDistributionBoard', 'DISTRIBUTIONBOARD'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.tri(V(-c.W / 2, 0), V(c.W / 2, 0), V(c.W / 2, c.D), c.pen.color ?? '#000'); c.text(V(0, c.D + 1.6 * c.s), c.el.label ?? c.t.label ?? 'UV', 2); },
  },
  manifold: {
    label: 'Verteiler Heizung (FBH)', disc: 'H', anchor: 'wall', ifc: ['IfcPipeFitting', 'JUNCTION'],
    plan: (c) => {
      c.rect(-c.W / 2, 0, c.W / 2, c.D);
      c.line(V(-c.W / 2 + 30, c.D * 0.33), V(c.W / 2 - 30, c.D * 0.33), { ...c.thin, color: colorOf(c.doc, 'sys_hvl') });
      c.line(V(-c.W / 2 + 30, c.D * 0.67), V(c.W / 2 - 30, c.D * 0.67), { ...c.thin, color: colorOf(c.doc, 'sys_hrl') });
      c.text(V(0, c.D + 1.6 * c.s), c.el.label ?? c.t.label ?? 'FBH-V', 2);
    },
  },
  radiator: {
    label: 'Heizkörper', disc: 'H', anchor: 'wall', ifc: ['IfcSpaceHeater', 'RADIATOR'],
    plan: (c) => {
      const y0 = Math.min(40, c.D * 0.3);
      c.rect(-c.W / 2, y0, c.W / 2, y0 + c.D); c.line(V(-c.W / 2, y0 + c.D / 2), V(c.W / 2, y0 + c.D / 2), c.thin);
      c.circ(V(-c.W / 2 - 0.9 * c.s, y0 + c.D / 2), 0.7 * c.s);
    },
  },
  heatPump: {
    label: 'Wärmepumpe', disc: 'H', anchor: 'wall', ifc: ['IfcUnitaryEquipment', 'USERDEFINED'],
    plan: (c) => {
      c.rect(-c.W / 2, 0, c.W / 2, c.D);
      if ((c.el.label ?? c.t.label ?? '').match(/aussen/i) || c.t.name.match(/aussen/i)) c.circ(V(c.W * 0.15, c.D / 2), Math.min(c.W, c.D) * 0.35, c.thin);
      c.text(V(-c.W * 0.2, c.D / 2), 'WP', 2.2);
    },
  },
  tank: {
    label: 'Speicher / Boiler', disc: 'S', anchor: 'center', ifc: ['IfcTank', 'STORAGE'],
    plan: (c) => { const r = Math.min(c.W, c.D) / 2; c.circ(V(0, 0), r); c.circ(V(0, 0), r - Math.min(40, r * 0.15), c.thin); c.text(V(0, 0), c.el.label ?? c.t.label ?? 'BWW', 2); },
  },
  floorDrain: {
    label: 'Bodenablauf', disc: 'S', anchor: 'center', ifc: ['IfcWasteTerminal', 'FLOORTRAP'],
    plan: (c) => {
      const a = Math.max(c.W / 2, 1.4 * c.s); c.rect(-a, -a, a, a); c.circ(V(0, 0), a * 0.6, c.thin);
      c.line(V(-a * 0.6, 0), V(a * 0.6, 0), c.thin); c.line(V(0, -a * 0.6), V(0, a * 0.6), c.thin);
    },
  },
  conWC: {
    label: 'Anschluss WC', disc: 'S', anchor: 'wall', ifc: ['IfcSanitaryTerminal', 'TOILETPAN'],
    plan: (c) => {
      const r = 0.9 * c.s, y = 1.6 * c.s;
      c.circ(V(-1.3 * c.s, y), r * 1.3, { ...c.pen, color: colorOf(c.doc, 'sys_sw') }, colorOf(c.doc, 'sys_sw'));
      c.circ(V(1.3 * c.s, y), r, { ...c.pen, color: colorOf(c.doc, 'sys_kw') }, colorOf(c.doc, 'sys_kw'));
      c.text(V(0, y + 2.2 * c.s), c.el.label ?? c.t.label ?? 'WC', 1.6);
    },
  },
  conLA: {
    label: 'Anschluss Lavabo', disc: 'S', anchor: 'wall', ifc: ['IfcSanitaryTerminal', 'WASHHANDBASIN'],
    plan: (c) => {
      const r = 0.8 * c.s, y = 1.6 * c.s;
      c.circ(V(-1.8 * c.s, y), r, { ...c.pen, color: colorOf(c.doc, 'sys_kw') }, colorOf(c.doc, 'sys_kw'));
      c.circ(V(0, y), r, { ...c.pen, color: colorOf(c.doc, 'sys_ww') }, colorOf(c.doc, 'sys_ww'));
      c.circ(V(1.8 * c.s, y), r * 1.2, { ...c.pen, color: colorOf(c.doc, 'sys_sw') }, colorOf(c.doc, 'sys_sw'));
      c.text(V(0, y + 2.2 * c.s), c.el.label ?? c.t.label ?? 'LA', 1.6);
    },
  },
  ventSup: {
    label: 'Lüftungsventil Zuluft', disc: 'L', anchor: 'center', ifc: ['IfcAirTerminal', 'DIFFUSER'],
    plan: (c) => ventPlan(c, 'ZU'),
  },
  ventExh: {
    label: 'Lüftungsventil Abluft', disc: 'L', anchor: 'center', ifc: ['IfcAirTerminal', 'GRILLE'],
    plan: (c) => ventPlan(c, 'AB'),
  },
  ahu: {
    label: 'Lüftungsgerät', disc: 'L', anchor: 'wall', ifc: ['IfcUnitaryEquipment', 'AIRHANDLER'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.line(V(-c.W / 2, 0), V(c.W / 2, c.D), c.thin); c.line(V(-c.W / 2, c.D), V(c.W / 2, 0), c.thin); c.text(V(0, c.D + 1.6 * c.s), c.el.label ?? c.t.label ?? 'KWL', 2); },
  },
  box: {
    label: 'Apparat (allgemein)', disc: 'S', anchor: 'wall', ifc: ['IfcBuildingElementProxy', 'NOTDEFINED'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.text(V(0, c.D / 2), c.el.label ?? c.t.label ?? '', 2); },
  },
  shower: {
    label: 'Dusche', disc: 'S', anchor: 'wall', ifc: ['IfcSanitaryTerminal', 'SHOWER'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.line(V(-c.W / 2, 0), V(c.W / 2, c.D), c.thin); c.line(V(-c.W / 2, c.D), V(c.W / 2, 0), c.thin); c.circ(V(0, c.D / 2), Math.min(60, c.W * 0.08), c.thin); },
  },
  bathtub: {
    label: 'Badewanne', disc: 'S', anchor: 'wall', ifc: ['IfcSanitaryTerminal', 'BATH'],
    plan: (c) => {
      c.rect(-c.W / 2, 0, c.W / 2, c.D);
      const o = Math.min(70, c.D * 0.12), r = Math.min(200, (c.D - 2 * o) / 2), x0 = -c.W / 2 + o, x1 = c.W / 2 - o, y0 = o, y1 = c.D - o;
      c.poly([...arcPoints(V(x1 - r, y0 + r), r, -Math.PI / 2, 0, 6), ...arcPoints(V(x1 - r, y1 - r), r, 0, Math.PI / 2, 6), ...arcPoints(V(x0 + r, y1 - r), r, Math.PI / 2, Math.PI, 6), ...arcPoints(V(x0 + r, y0 + r), r, Math.PI, Math.PI * 1.5, 6)], true, c.thin);
      c.circ(V(c.W / 2 - o - 120, c.D / 2), 25, c.thin);
    },
  },
  sinkK: {
    label: 'Spültisch / Ausguss', disc: 'S', anchor: 'wall', ifc: ['IfcSanitaryTerminal', 'SINK'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.rect(-c.W * 0.4, c.D * 0.15, Math.min(c.W * 0.05, c.W * 0.4 - 50), c.D * 0.8, c.thin); c.circ(V(-c.W * 0.17, c.D * 0.47), 22, c.thin); c.text(V(c.W * 0.25, c.D / 2), c.el.label ?? c.t.label ?? '', 1.8); },
  },
  washer: {
    label: 'Waschmaschine / Tumbler', disc: 'S', anchor: 'wall', ifc: ['IfcElectricAppliance', 'WASHINGMACHINE'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.circ(V(0, c.D / 2), Math.min(c.W, c.D) * 0.32, c.thin); c.text(V(0, c.D / 2), c.el.label ?? c.t.label ?? 'WM', 1.8); },
  },
  liftStation: {
    label: 'Hebeanlage', disc: 'S', anchor: 'wall', ifc: ['IfcWasteTerminal', 'WASTETRAP'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.circ(V(0, c.D / 2), Math.min(c.W, c.D) * 0.3, c.thin); c.text(V(0, c.D / 2), c.el.label ?? c.t.label ?? 'HA', 1.8); },
  },
  hob: {
    label: 'Kochfeld / Dampfabzug', disc: 'E', anchor: 'wall', ifc: ['IfcElectricAppliance', 'ELECTRICCOOKER'],
    plan: (c) => {
      c.rect(-c.W / 2, 0, c.W / 2, c.D); const r = Math.min(c.W, c.D) * 0.13;
      for (const [x, y] of [[-0.22, 0.3], [0.22, 0.3], [-0.22, 0.7], [0.22, 0.7]]) c.circ(V(x * c.W, y * c.D), r, c.thin);
    },
  },
  inverter: {
    label: 'PV-Wechselrichter', disc: 'E', anchor: 'wall', ifc: ['IfcElectricDistributionBoard', 'USERDEFINED'],
    plan: (c) => { c.rect(-c.W / 2, 0, c.W / 2, c.D); c.line(V(-c.W / 2, 0), V(c.W / 2, c.D), c.thin); c.text(V(-c.W * 0.2, c.D * 0.7), '=', 1.8); c.text(V(c.W * 0.2, c.D * 0.3), '~', 1.8); },
  },
  pas: {
    label: 'Potentialausgleichsschiene', disc: 'E', anchor: 'wall', ifc: ['IfcDiscreteAccessory', 'USERDEFINED'],
    plan: (c) => {
      c.rect(-c.W / 2, 0, c.W / 2, c.D); const y = c.D + 1.2 * c.s;
      c.line(V(0, c.D), V(0, y)); c.line(V(-1.2 * c.s, y), V(1.2 * c.s, y)); c.line(V(-0.8 * c.s, y + 0.5 * c.s), V(0.8 * c.s, y + 0.5 * c.s)); c.line(V(-0.4 * c.s, y + c.s), V(0.4 * c.s, y + c.s));
      c.text(V(0, y + 2.4 * c.s), c.el.label ?? c.t.label ?? 'PAS', 1.8);
    },
  },
};
function ventPlan(c: SymCtx, def: string): void {
  const sys = sysOf(c.doc, c.el.system ? c.el : { ...c.el, system: c.t.system } as El);
  const p: Pen = { w: 2, color: sys.color };
  const r = Math.max(c.W / 2, 1.5 * c.s);
  c.circ(V(0, 0), r, p); c.circ(V(0, 0), r * 0.45, { ...p, w: 1 });
  const flow = c.el.flow ?? c.t.flow;
  c.text(V(r + 0.6 * c.s, 0), `${sys.abbr || def}${flow ? ' ' + fmtNum(flow, 0) + ' m³/h' : ''}`, 1.8, sys.color);
}
export const symOptions = (): [string, string][] => Object.entries(FIX_SYMBOLS).map(([k, v]) => [k, v.label]);

// ------------------------------------------------------------ Lage
export const fixType = (doc: Doc, el: El) => typeOf<FixType>(doc, el);
/** Einfügepunkt und Drehung (wandmontiert: aus Wand, Lage t und Seite) */
export function fixPos(doc: Doc, el: El): { p: V2; rot: number } {
  const w = el.hostId ? doc.get<Wall>(el.hostId) : undefined;
  if (w && w.cat === 'wall' && typeof el.t === 'number') {
    const wi = wallInfo(doc, w); const side = el.side ?? 1;
    const n = mul(wi.n, side);
    return { p: add(add(wi.c0, mul(wi.d, el.t)), mul(n, wi.T / 2)), rot: angleOf(n) - Math.PI / 2 };
  }
  // frei platziert: p = Mitte des Symbols (wandmontierte Symbole haben den Ursprung an der Wandseite)
  const p = el.p ?? V(0, 0), rot = el.rot ?? 0; const t = fixType(doc, el);
  if (t && (FIX_SYMBOLS[t.sym] ?? FIX_SYMBOLS.box).anchor === 'wall') { const h = (t.depth ?? 0) / 2; return { p: { x: p.x + Math.sin(rot) * h, y: p.y - Math.cos(rot) * h }, rot }; }
  return { p, rot };
}
export function fixZ(doc: Doc, el: El): number { return levelElev(doc, el.levelId) + (el.offset ?? fixType(doc, el)?.elev ?? 0); }

function L2Wf(p: V2, rot: number): (q: V2) => V2 {
  const co = Math.cos(rot), si = Math.sin(rot);
  return (q) => ({ x: p.x + q.x * co - q.y * si, y: p.y + q.x * si + q.y * co });
}

export function drawFixture(dl: DisplayList, doc: Doc, el: El, t: FixType | undefined, pen: Pen, scale: number, at?: { p: V2; rot: number }): void {
  if (!t) return;
  const sym = FIX_SYMBOLS[t.sym] ?? FIX_SYMBOLS.box;
  const { p, rot } = at ?? fixPos(doc, el);
  const X = L2Wf(p, rot);
  const thin: Pen = { w: 1, color: pen.color };
  const ctx: SymCtx = {
    W: t.width ?? 300, D: t.depth ?? 200, s: scale, pen, thin, doc, el, t,
    line: (a, b, q = pen) => dl.line(X(a), X(b), q),
    poly: (pts, closed = false, q = pen) => dl.poly(pts.map(X), q, closed),
    rect: (x0, y0, x1, y1, q = pen) => dl.poly([V(x0, y0), V(x1, y0), V(x1, y1), V(x0, y1)].map(X), q, true),
    circ: (c, r, q = pen, fill) => dl.circle(X(c), r, q, fill ? { color: fill, pattern: 'solid', patColor: fill } : { color: '#ffffff' }),
    tri: (a, b, c, color) => dl.fill([[X(a), X(b), X(c)]], { color, pattern: 'solid', patColor: color }, undefined, { ns: true }),
    text: (q, s, size, color) => dl.text(X(q), s, { size, ha: 'center', va: 'middle', color: color ?? pen.color, rot: textRotOf(rot) }),
  };
  sym.plan(ctx);
}
const textRotOf = (rot: number) => { let a = rot % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; if (a > Math.PI / 2 && a <= Math.PI * 1.5) a -= Math.PI; return a > Math.PI ? a - 2 * Math.PI : a; };

function fixSolids(doc: Doc, el: El): Solid[] {
  const t = fixType(doc, el); if (!t) return [];
  const sym = FIX_SYMBOLS[t.sym] ?? FIX_SYMBOLS.box;
  const { p, rot } = fixPos(doc, el); const X = L2Wf(p, rot);
  const W = t.width ?? 300, D = t.depth ?? 200, H = t.height ?? 300;
  const z0 = fixZ(doc, el);
  const color = sysOf(doc, el.system ? el : ({ ...el, system: t.system } as El)).color;
  const col = t.disc === 'E' ? '#f4f4f4' : ['tank', 'heatPump', 'ahu', 'manifold', 'boardE'].includes(t.sym) ? '#e8e8e8' : color;
  if (t.sym === 'tank' || t.sym === 'lightC' || t.sym === 'ventSup' || t.sym === 'ventExh' || t.sym === 'smoke') {
    const ring = arcPoints(V(0, 0), Math.min(W, D) / 2, 0, Math.PI * 2 - 1e-6, 16).slice(0, -1).map(X);
    return [{ faces: boxFaces(ring, z0, z0 + H), color: col, noCut: true }];
  }
  const y0 = sym.anchor === 'wall' ? 0 : -D / 2;
  const ring = [V(-W / 2, y0), V(W / 2, y0), V(W / 2, y0 + D), V(-W / 2, y0 + D)].map(X);
  return [{ faces: boxFaces(ring, z0, z0 + H), color: col, noCut: true }];
}

function fixProps(el: El, doc: Doc): PropDef[] {
  const g = GROUPS; const t = fixType(doc, el);
  const p: PropDef[] = [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'level', get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Höhe über Ebene', group: g.constraints, type: 'length', get: (e, d) => e.offset ?? fixType(d, e)?.elev ?? 0, set: (_e, v) => ({ offset: v }) },
    { key: 'rot', label: 'Drehung', group: g.constraints, type: 'angle', get: (e, d) => fixPos(d, e).rot, set: (e, v) => (e.hostId ? undefined : { rot: v }) },
    { key: 'host', label: 'Host', group: g.constraints, type: 'readonly', get: (e, d) => (e.hostId && d.get(e.hostId) ? 'Wand' : '–') },
    { key: 'system', label: 'Systemtyp', group: 'Mechanisch', type: 'select', options: (d) => [['', '–'], ...systemOptions(d)], get: (e, d) => e.system ?? fixType(d, e)?.system ?? '', set: (_e, v) => ({ system: v || undefined }) },
  ];
  if (t && (t.sym === 'ventSup' || t.sym === 'ventExh' || t.sym === 'ahu')) p.push({ key: 'flow', label: 'Volumenstrom (m³/h)', group: 'Mechanisch', type: 'number', get: (e, d) => e.flow ?? fixType(d, e)?.flow ?? 0, set: (_e, v) => ({ flow: v || undefined }) });
  if (t && t.sym === 'socket') p.push({ key: 'count', label: 'Anzahl Steckdosen', group: 'Elektro', type: 'int', get: (e, d) => e.count ?? fixType(d, e)?.count ?? 1, set: (_e, v) => ({ count: Math.max(1, Math.round(v)) }) });
  p.push(
    { key: 'label', label: 'Bezeichnung', group: g.identity, type: 'text', get: (e, d) => e.label ?? fixType(d, e)?.label ?? '', set: (_e, v) => ({ label: v || undefined }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
  );
  return p;
}
function fixTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'sym', label: 'Symbol', group: g.graphics, type: 'select', options: symOptions(), get: (t) => t.sym ?? 'box', set: (_t, v) => ({ sym: v, disc: FIX_SYMBOLS[v as FixSym]?.disc }) },
    { key: 'disc', label: 'Gewerk', group: g.identity, type: 'select', options: DISC_OPTIONS, get: (t) => t.disc ?? 'S', set: (_t, v) => ({ disc: v }) },
    { key: 'mount', label: 'Montage', group: g.constraints, type: 'select', options: [['floor', 'Boden'], ['wall', 'Wand'], ['ceiling', 'Decke']], get: (t) => t.mount ?? 'floor', set: (_t, v) => ({ mount: v }) },
    { key: 'elev', label: 'Vorgabe-Höhe (UK)', group: g.constraints, type: 'length', get: (t) => t.elev ?? 0, set: (_t, v) => ({ elev: v }) },
    { key: 'width', label: 'Breite', group: g.dims, type: 'length', get: (t) => t.width, set: (_t, v) => ({ width: Math.max(10, v) }) },
    { key: 'depth', label: 'Tiefe', group: g.dims, type: 'length', get: (t) => t.depth, set: (_t, v) => ({ depth: Math.max(10, v) }) },
    { key: 'height', label: 'Höhe', group: g.dims, type: 'length', get: (t) => t.height, set: (_t, v) => ({ height: Math.max(10, v) }) },
    { key: 'label', label: 'Planbezeichnung', group: g.identity, type: 'text', get: (t) => t.label ?? '', set: (_t, v) => ({ label: v }) },
    { key: 'system', label: 'Vorgabe-System', group: 'Mechanisch', type: 'select', options: (d) => [['', '–'], ...systemOptions(d)], get: (t) => t.system ?? '', set: (_t, v) => ({ system: v || undefined }) },
    { key: 'power', label: 'Leistung (W)', group: 'Elektro', type: 'number', get: (t) => t.power ?? 0, set: (_t, v) => ({ power: v || undefined }) },
    { key: 'flow', label: 'Volumenstrom (m³/h)', group: 'Mechanisch', type: 'number', get: (t) => t.flow ?? 0, set: (_t, v) => ({ flow: v || undefined }) },
    { key: 'count', label: 'Anzahl (Steckdosen/Kreise)', group: g.other, type: 'int', get: (t) => t.count ?? 1, set: (_t, v) => ({ count: Math.max(1, Math.round(v)) }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

function transformFix(el: El, m: Mat2, doc: Doc): Partial<Fixture> {
  const { p, rot } = fixPos(doc, el);
  const np = apply(m, p);
  if (el.hostId) {
    const w = doc.get<Wall>(el.hostId);
    if (w) {
      const wi = wallInfo(doc, w); const t = dot(sub(np, wi.c0), wi.d);
      const off = dot(sub(np, wi.c0), wi.n);
      if (t >= 0 && t <= wi.L && Math.abs(Math.abs(off) - wi.T / 2) < 300) return { t, side: off >= 0 ? 1 : -1 };
    }
  }
  const wy = applyVec(m, { x: -Math.sin(rot), y: Math.cos(rot) });
  const nr = angleOf(wy) - Math.PI / 2;
  const t = fixType(doc, el); const h = t && (FIX_SYMBOLS[t.sym] ?? FIX_SYMBOLS.box).anchor === 'wall' ? (t.depth ?? 0) / 2 : 0;
  return { hostId: undefined, t: undefined, side: undefined, p: { x: np.x - Math.sin(nr) * h, y: np.y + Math.cos(nr) * h }, rot: nr };
}

registerCategory({
  cat: 'mepFixture', label: 'HLKSE-Element', plural: 'HLKSE-Elemente', hasTypes: true, planOrder: 62,
  visibleIn: (el, doc, view) => discVisible(view, fixType(doc, el)?.disc ?? 'S'),
  drawPlan: (ctx, el) => {
    const t = fixType(ctx.doc, el); if (!t) return;
    const z = fixZ(ctx.doc, el); const [lo, hi] = planBand(ctx);
    if (z + (t.height ?? 0) < lo || z > hi) return;
    const sys = el.system || t.system ? sysOf(ctx.doc, el.system ? el : ({ ...el, system: t.system } as El)) : null;
    const color = t.disc === 'E' ? '#d0209c' : sys?.color ?? '#000000';
    drawFixture(ctx.dl, ctx.doc, el, t, { w: 2, color }, ctx.view.scale || 100);
  },
  solids: (el, doc) => fixSolids(doc, el),
  grips: (el, doc, view): Grip[] => {
    if (!isPlanLike(view) || el.hostId) return [];
    const { p, rot } = fixPos(doc, el); const r = view.scale * 6;
    return [{ id: 'rot', p: add(p, { x: -Math.sin(rot) * r, y: Math.cos(rot) * r }), kind: 'end', tip: 'Drehen' }];
  },
  dragGrip: (el, id, p) => { if (id === 'rot' && el.p && dist(p, el.p) > 10) return { rot: angleOf(sub(p, el.p)) - Math.PI / 2 }; },
  transform: (el, m, doc, view) => (isPlanLike(view) ? transformFix(el, m, doc) : undefined),
  translate3d: (el, d, doc) => {
    const base = transformFix(el, { a: 1, b: 0, c: 0, d: 1, e: d.x, f: d.y }, doc);
    return { ...base, offset: (el.offset ?? fixType(doc, el)?.elev ?? 0) + d.z };
  },
  center: (el, doc) => fixPos(doc, el).p,
  props: (el, doc) => fixProps(el, doc),
  typeProps: () => fixTypeProps(),
  tagText: (el, doc) => {
    const t = fixType(doc, el); if (!t) return '';
    const flow = el.flow ?? t.flow;
    if (t.disc === 'L' && flow) return `${sysOf(doc, el.system ? el : ({ ...el, system: t.system } as El)).abbr} ${fmtNum(flow, 0)} m³/h`;
    return el.label ?? t.label ?? t.name;
  },
  tagPoint: (el, doc) => fixPos(doc, el).p,
  scheduleFields: () => [
    { key: 'type', label: 'Typ', get: (el, doc) => fixType(doc, el)?.name ?? '' },
    { key: 'disc', label: 'Gewerk', get: (el, doc) => DISC_LABEL[fixType(doc, el)?.disc ?? 'S'] },
    { key: 'symbol', label: 'Symbol', get: (el, doc) => FIX_SYMBOLS[fixType(doc, el)?.sym ?? 'box']?.label ?? '' },
    { key: 'system', label: 'System', get: (el, doc) => { const t = fixType(doc, el); const id = el.system ?? t?.system; return id ? doc.get(id)?.name ?? '' : ''; } },
    { key: 'zOff', label: 'Höhe über Ebene', unit: 'len', get: (el, doc) => el.offset ?? fixType(doc, el)?.elev ?? 0 },
    { key: 'flow', label: 'Volumenstrom (m³/h)', unit: 'num', get: (el, doc) => el.flow ?? fixType(doc, el)?.flow ?? 0 },
    { key: 'power', label: 'Leistung (W)', unit: 'num', get: (el, doc) => fixType(doc, el)?.power ?? 0 },
    { key: 'units', label: 'Anzahl Einheiten', unit: 'num', get: (el, doc) => el.count ?? fixType(doc, el)?.count ?? 1 },
  ],
  ifc: (el, doc) => {
    const t = fixType(doc, el); if (!t) return null;
    const [entity, predefined] = (FIX_SYMBOLS[t.sym] ?? FIX_SYMBOLS.box).ifc;
    const flow = el.flow ?? t.flow;
    const pset: Record<string, string | number | boolean> = { Gewerk: DISC_LABEL[t.disc], Typ: t.name, Hoehe_ueber_Ebene: el.offset ?? t.elev ?? 0 };
    const sysId = el.system ?? t.system; if (sysId && doc.get(sysId)) pset.System = doc.get(sysId)!.name;
    if (flow) pset.Volumenstrom_m3h = flow;
    if (t.power) pset.Leistung_W = t.power;
    return { entity, predefined, name: el.label ?? t.label ?? t.name, psets: { Pset_OpenRiss_HLKSE: pset } };
  },
});

// ------------------------------------------------------------ Vorlage
registerMepTemplate((doc, has) => {
  const ft = (id: Id, name: string, sym: FixSym, mount: FixType['mount'], elev: number, w: number, d: number, h: number, extra: Partial<FixType> = {}) =>
    addType(doc, has, { id, of: 'mepFixture', name, sym, disc: FIX_SYMBOLS[sym].disc, mount, elev, width: w, depth: d, height: h, ...extra } as any);
  ft('mft_sd3', 'Steckdose T13 3-fach', 'socket', 'wall', 300, 160, 50, 80, { count: 3, label: 'T13' });
  ft('mft_sd1', 'Steckdose T13 1-fach', 'socket', 'wall', 300, 80, 50, 80, { count: 1, label: 'T13' });
  ft('mft_sch', 'Schalter', 'switch', 'wall', 1050, 80, 50, 80);
  ft('mft_ld', 'Deckenleuchte', 'lightC', 'ceiling', 2450, 300, 300, 80);
  ft('mft_lw', 'Wandleuchte', 'lightW', 'wall', 1900, 200, 120, 200);
  ft('mft_rm', 'Rauchmelder', 'smoke', 'ceiling', 2450, 100, 100, 50);
  ft('mft_mm', 'Multimedia-Dose', 'data', 'wall', 300, 80, 50, 80, { label: 'MM' });
  ft('mft_uv', 'Unterverteiler Elektro', 'boardE', 'wall', 1000, 600, 150, 800, { label: 'UV' });
  ft('mft_hv', 'Hauptverteilung HV', 'boardE', 'wall', 400, 600, 250, 1200, { label: 'HV' });
  ft('mft_fbhv', 'FBH-Verteiler', 'manifold', 'wall', 300, 650, 150, 700, { label: 'FBH-V', count: 7, system: 'sys_hvl' });
  ft('mft_hk', 'Heizkörper 600 × 1000', 'radiator', 'wall', 150, 1000, 100, 600, { system: 'sys_hvl', power: 800 });
  ft('mft_wpa', 'Wärmepumpe Aussengerät 8 kW', 'heatPump', 'floor', 0, 1200, 500, 1400, { label: 'WP aussen', power: 8000 });
  ft('mft_wpi', 'Wärmepumpe Innengerät (Hydromodul)', 'heatPump', 'wall', 300, 450, 800, 1800, { label: 'WP innen' });
  ft('mft_bww', 'Warmwasserspeicher 300 l', 'tank', 'floor', 0, 700, 700, 1800, { label: 'BWW', system: 'sys_ww' });
  ft('mft_ba', 'Bodenablauf', 'floorDrain', 'floor', 0, 150, 150, 100, { system: 'sys_sw' });
  ft('mft_awc', 'Anschluss WC', 'conWC', 'wall', 0, 400, 200, 400, { label: 'WC' });
  ft('mft_ala', 'Anschluss Lavabo', 'conLA', 'wall', 550, 400, 150, 300, { label: 'LA' });
  ft('mft_vzu', 'Lüftungsventil Zuluft Ø125', 'ventSup', 'ceiling', 2500, 125, 125, 60, { system: 'sys_zul', flow: 30 });
  ft('mft_vab', 'Lüftungsventil Abluft Ø125', 'ventExh', 'ceiling', 2500, 125, 125, 60, { system: 'sys_abl', flow: 30 });
  ft('mft_kwl', 'KWL-Gerät 250 m³/h', 'ahu', 'wall', 1200, 900, 600, 650, { label: 'KWL', flow: 250 });
  ft('mft_du', 'Dusche 90 × 90', 'shower', 'floor', 0, 900, 900, 50, { system: 'sys_sw' });
  ft('mft_bw', 'Badewanne 170 × 75', 'bathtub', 'floor', 0, 1700, 750, 600);
  ft('mft_sp', 'Spültisch 120', 'sinkK', 'wall', 0, 1200, 600, 900, { label: 'SP' });
  ft('mft_ag', 'Ausguss / Waschtrog', 'sinkK', 'wall', 0, 500, 450, 850, { label: 'AG' });
  ft('mft_wm', 'Waschmaschine', 'washer', 'floor', 0, 600, 600, 850, { label: 'WM', power: 2300 });
  ft('mft_tu', 'Tumbler (Wärmepumpe)', 'washer', 'floor', 0, 600, 600, 850, { label: 'TU', power: 800 });
  ft('mft_ha', 'Hebeanlage (oberflur)', 'liftStation', 'floor', 0, 600, 600, 500, { label: 'HA', power: 1500, system: 'sys_sw' });
  ft('mft_ko', 'Kochfeld mit Umluft-Dampfabzug', 'hob', 'wall', 850, 800, 520, 60, { power: 7400 });
  ft('mft_wr', 'PV-Wechselrichter 8 kW', 'inverter', 'wall', 1200, 450, 200, 700, { label: 'WR', power: 8000 });
  ft('mft_pas', 'Potentialausgleichsschiene PAS', 'pas', 'wall', 400, 300, 60, 100, { label: 'PAS' });
});

// ------------------------------------------------------------ Erzeugen (auch für Skripte/API)
/** Element frei platzieren (p = Einfügepunkt, rot in rad) */
export function addFixture(doc: Doc, typeId: Id, levelId: Id, p: V2, o: Partial<Fixture> = {}): Fixture {
  const t = doc.get<FixType>(typeId);
  return doc.add<Fixture>({ rot: 0, offset: t?.elev ?? 0, ...o, id: newId('mf'), cat: 'mepFixture', typeId, levelId, p: { ...p } } as Fixture);
}
/** Wandmontage: nächste Wand zum Punkt p suchen und auf deren Oberfläche setzen */
export function wallMount(doc: Doc, p: V2, z: number, tol = 400): { hostId: Id; t: number; side: 1 | -1; p: V2; rot: number } | null {
  const w = wallAt(doc, p, z, tol); if (!w) return null;
  const wi = wallInfo(doc, w);
  const t = Math.max(0, Math.min(wi.L, dot(sub(p, wi.c0), wi.d)));
  const side: 1 | -1 = dot(sub(p, wi.c0), wi.n) >= 0 ? 1 : -1;
  const n = mul(wi.n, side);
  return { hostId: w.id, t, side, p: add(add(wi.c0, mul(wi.d, t)), mul(n, wi.T / 2)), rot: angleOf(n) - Math.PI / 2 };
}

// ------------------------------------------------------------ Werkzeug
export class FixtureTool extends Tool {
  id: string; label: string; kinds = ['plan', 'ceiling'];
  private cur: V2 | null = null; private mount: ReturnType<typeof wallMount> = null;
  static snapWall = true;
  constructor(id: string, label: string, private syms: FixSym[] = []) { super(); this.id = id; this.label = label; }
  activate(): void {
    const lvl = activeLevelId();
    const types = app.doc.all<FixType>('type').filter((t) => t.of === 'mepFixture');
    const pref = this.syms.length ? types.find((t) => this.syms.includes(t.sym)) : undefined;
    const pl = placementFor('mepFixture', { levelId: lvl, rot: 0 });
    pl.proto.levelId = lvl;
    if (pref && (!pl.proto.typeId || !this.syms.includes(app.doc.get<FixType>(pl.proto.typeId)?.sym as FixSym))) pl.proto.typeId = pref.id;
    const setType = pl.setType;
    pl.setType = (id) => { pl.proto.offset = app.doc.get<FixType>(id)?.elev ?? 0; setType(id); };
    const t = app.doc.get<FixType>(pl.proto.typeId);
    pl.proto.offset = t?.elev ?? 0;
    pl.typeId = pl.proto.typeId;
    this.placement = pl;
  }
  deactivate(): void { rememberProto(this.placement); }
  private type(): FixType | undefined { return app.doc.get<FixType>(this.placement?.proto.typeId); }
  prompt(): string { return this.type()?.mount === 'wall' ? 'Klicken Sie an eine Wand (Element haftet an der Wandoberfläche). Leertaste dreht frei platzierte Elemente.' : 'Klicken Sie, um das Element zu platzieren. Leertaste dreht um 90°.'; }
  options(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'select', key: 'type', label: 'Typ', value: p.typeId ?? '', options: app.doc.all<FixType>('type').filter((t) => t.of === 'mepFixture' && (!this.syms.length || this.syms.includes(t.sym))).map((t) => [t.id, t.name] as [string, string]), onChange: (v) => { this.placement!.setType(v); app.emit('tool'); } },
      { kind: 'length', key: 'off', label: 'Höhe', value: p.offset ?? 0, width: 70, onChange: (v) => { p.offset = v; } },
      { kind: 'check', key: 'wall', label: 'An Wand', value: FixtureTool.snapWall, onChange: (v) => { FixtureTool.snapWall = v; } },
      { kind: 'angle', key: 'rot', label: 'Drehung', value: p.rot ?? 0, onChange: (v) => { p.rot = v; } },
    ];
  }
  space(): boolean { const p = this.placement!.proto; p.rot = ((p.rot ?? 0) + Math.PI / 2) % (Math.PI * 2); app.emit('tool'); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void {
    this.cur = e.p; this.mount = null;
    const t = this.type();
    if (t && t.mount === 'wall' && FixtureTool.snapWall) this.mount = wallMount(app.doc, e.raw, levelElev(app.doc, e.view.levelId) + Math.max(100, this.placement!.proto.offset ?? 0), 500);
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const p = this.placement!.proto; const t = this.type(); if (!t) { app.status('Kein Typ gewählt.'); return; }
    if (t.mount === 'wall' && FixtureTool.snapWall && !this.mount) app.status('Keine Wand in der Nähe – Element wird frei platziert.');
    const m = this.mount;
    app.doc.transaction('HLKSE-Element platzieren', () => {
      const { id: _i, cat: _c, ...rest } = p;
      addFixture(app.doc, t.id, p.levelId || activeLevelId(e.view), m ? m.p : e.p, { ...rest, offset: p.offset ?? t.elev, rot: m ? m.rot : p.rot ?? 0, ...(m ? { hostId: m.hostId, t: m.t, side: m.side } : {}) } as Partial<Fixture>);
    });
  }
  preview(dl: DisplayList, vp: any): void {
    const t = this.type(); if (!t || !this.cur) return;
    const at = this.mount ? { p: this.mount.p, rot: this.mount.rot } : { p: this.cur, rot: this.placement!.proto.rot ?? 0 };
    drawFixture(dl, app.doc, this.placement!.proto, t, PREVIEW, vp.view.scale, at);
  }
}

export { levelAbove };
