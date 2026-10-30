// Prinzipschema (2D, Zeichnungsansicht): Schemasymbole (Pumpe, Ventile, Mischer, Wärmepumpe, Speicher,
// Verteiler, Heizkörper, FBH, Lüftungsgerät …) mit Anschlusspunkten und Systemleitungen (Farbe/Linienart
// des Systemtyps, Fliesspfeile). Symbolgrössen in Papier-mm (wie Beschriftungen).
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, dist, mid, angleOf, apply, applyVec, norm, perp, arcPoints } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, Grip } from '../../core/registry';
import type { View } from '../../core/view';
import type { DisplayList } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool, PREVIEW } from '../../tools/drawTool';
import { sysOf, sysPen, systemOptions, MepSystem } from './common';
import type { FbhCircuit } from './fbh';
import { fbhLayout } from './fbh';
import type { FixType } from './fixtures';

export type SchemaKind = 'pump' | 'valve' | 'valve3' | 'mixer' | 'check' | 'heatpump' | 'tank' | 'manifold' | 'radiator' | 'fbh' | 'ahu' | 'fan' | 'expansion' | 'meter' | 'filter' | 'hx' | 'box';
export interface SchemaSym extends El { cat: 'schemaSym'; viewId: Id; p: V2; rot: number; kind: SchemaKind; size?: number; label?: string; system?: Id; ports?: number }
export interface SchemaLine extends El { cat: 'schemaLine'; viewId: Id; a: V2; b: V2; system?: Id; arrow?: boolean }

const V = (x: number, y: number): V2 => ({ x, y });
interface SCtx { u: number; pen: Pen; thin: Pen; el: El; line(a: V2, b: V2, p?: Pen): void; poly(pts: V2[], closed?: boolean, p?: Pen, fill?: string): void; circ(c: V2, r: number, p?: Pen, fill?: string): void; text(p: V2, s: string, size?: number): void }
interface KindDef { label: string; ports(u: number, el: El): V2[]; draw(c: SCtx): void; text?: V2 }

const rect = (c: SCtx, w: number, h: number, fill?: string) => c.poly([V(-w / 2, -h / 2), V(w / 2, -h / 2), V(w / 2, h / 2), V(-w / 2, h / 2)], true, c.pen, fill);
const bow = (c: SCtx, r: number) => { c.poly([V(-r, -0.6 * r), V(-r, 0.6 * r), V(0, 0)], true); c.poly([V(r, -0.6 * r), V(r, 0.6 * r), V(0, 0)], true); };
const nPorts = (el: El) => Math.max(1, Math.min(12, el.ports ?? 4));

export const SCHEMA_KINDS: Record<SchemaKind, KindDef> = {
  pump: {
    label: 'Umwälzpumpe', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)],
    draw: (c) => { const r = c.u / 2; c.circ(V(0, 0), r); c.poly([V(r, 0), V(-r / 2, r * 0.866), V(-r / 2, -r * 0.866)], true); },
  },
  valve: { label: 'Absperrventil', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)], draw: (c) => bow(c, c.u / 2) },
  valve3: {
    label: '3-Weg-Ventil', ports: (u) => [V(-u / 2, 0), V(u / 2, 0), V(0, -u / 2)],
    draw: (c) => { const r = c.u / 2; bow(c, r); c.poly([V(-0.6 * r, -r), V(0.6 * r, -r), V(0, 0)], true); },
  },
  mixer: {
    label: 'Mischventil mit Antrieb', ports: (u) => [V(-u / 2, 0), V(u / 2, 0), V(0, -u / 2)],
    draw: (c) => { const r = c.u / 2; bow(c, r); c.poly([V(-0.6 * r, -r), V(0.6 * r, -r), V(0, 0)], true, c.pen, c.pen.color); c.line(V(0, 0), V(0, 0.8 * r)); rect({ ...c, poly: (pts, cl, p, f) => c.poly(pts.map((q) => add(q, V(0, r))), cl, p, f) } as SCtx, 0.7 * r, 0.5 * r); c.text(V(0, r), 'M', 1.6); },
  },
  check: {
    label: 'Rückflussverhinderer', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)],
    draw: (c) => { const r = c.u / 2; c.line(V(-r, 0), V(-0.4 * r, 0)); c.line(V(0.4 * r, 0), V(r, 0)); c.poly([V(-0.4 * r, -0.5 * r), V(-0.4 * r, 0.5 * r), V(0.4 * r, 0)], true); c.line(V(0.4 * r, -0.5 * r), V(0.4 * r, 0.5 * r)); },
  },
  heatpump: {
    label: 'Wärmepumpe', ports: (u) => [V(-u, 0.35 * u), V(-u, -0.35 * u), V(u, 0.35 * u), V(u, -0.35 * u)],
    draw: (c) => { rect(c, 2 * c.u, 1.4 * c.u); const z = []; for (let i = 0; i <= 6; i++) z.push(V(-0.6 * c.u + (1.2 * c.u * i) / 6, (i % 2 ? 0.25 : -0.25) * c.u)); c.poly(z, false, c.thin); c.text(V(0, 0.5 * c.u), 'WP', 2); },
    text: V(0, -0.95),
  },
  tank: {
    label: 'Speicher', ports: (u) => [V(-0.6 * u, 0.8 * u), V(-0.6 * u, -0.8 * u), V(0.6 * u, 0.8 * u), V(0.6 * u, -0.8 * u)],
    draw: (c) => {
      const w = 0.6 * c.u, h = 1.2 * c.u;
      const pts = [...arcPoints(V(0, h - w), w, 0, Math.PI, 10), ...arcPoints(V(0, -h + w), w, Math.PI, Math.PI * 2, 10)];
      c.poly(pts, true);
    },
    text: V(0, 0),
  },
  manifold: {
    // Ports: 0 = Vorlauf ein (links oben), 1 = Rücklauf aus (links unten), dann je Abgang Vorlauf/Rücklauf (unten)
    label: 'Verteiler', ports: (u, el) => {
      const n = nPorts(el); const L = (n + 1) * 0.6 * u; const out = [V(-L / 2, 0.25 * u), V(-L / 2, -0.25 * u)];
      for (let i = 0; i < n; i++) { const x = -L / 2 + 0.6 * u * (i + 1); out.push(V(x - 0.12 * u, -0.75 * u), V(x + 0.12 * u, -0.75 * u)); }
      return out;
    },
    draw: (c) => {
      const n = nPorts(c.el); const L = (n + 1) * 0.6 * c.u;
      c.poly([V(-L / 2, 0.15 * c.u), V(L / 2, 0.15 * c.u), V(L / 2, 0.35 * c.u), V(-L / 2, 0.35 * c.u)], true);
      c.poly([V(-L / 2, -0.35 * c.u), V(L / 2, -0.35 * c.u), V(L / 2, -0.15 * c.u), V(-L / 2, -0.15 * c.u)], true);
      for (let i = 0; i < n; i++) { const x = -L / 2 + 0.6 * c.u * (i + 1); c.line(V(x - 0.12 * c.u, 0.15 * c.u), V(x - 0.12 * c.u, -0.75 * c.u)); c.line(V(x + 0.12 * c.u, -0.35 * c.u), V(x + 0.12 * c.u, -0.75 * c.u)); }
    },
    text: V(0, 0.55),
  },
  radiator: {
    label: 'Heizkörper', ports: (u) => [V(-0.8 * u, -0.4 * u), V(0.8 * u, -0.4 * u)],
    draw: (c) => { rect(c, 1.6 * c.u, 0.8 * c.u); for (let i = 1; i < 6; i++) { const x = -0.8 * c.u + (1.6 * c.u * i) / 6; c.line(V(x, -0.4 * c.u), V(x, 0.4 * c.u), c.thin); } },
  },
  fbh: {
    label: 'Fussbodenheizung', ports: (u) => [V(-0.5 * u, 0.45 * u), V(0.5 * u, 0.45 * u)],
    draw: (c) => {
      rect(c, 1.6 * c.u, 0.9 * c.u, '#fde0e0');
      const z: V2[] = []; const n = 6;
      for (let i = 0; i <= n; i++) { const x = -0.6 * c.u + (1.2 * c.u * i) / n; z.push(V(x, i % 2 ? -0.25 * c.u : 0.25 * c.u), V(x, i % 2 ? 0.25 * c.u : -0.25 * c.u)); }
      c.poly(z.slice(1), false, c.thin);
    },
  },
  ahu: {
    label: 'Lüftungsgerät (WRG)', ports: (u) => [V(-u, 0.4 * u), V(-u, -0.4 * u), V(u, 0.4 * u), V(u, -0.4 * u)],
    draw: (c) => { rect(c, 2 * c.u, 1.4 * c.u); c.line(V(-c.u, -0.7 * c.u), V(c.u, 0.7 * c.u), c.thin); c.line(V(-c.u, 0.7 * c.u), V(c.u, -0.7 * c.u), c.thin); },
    text: V(0, -0.95),
  },
  fan: {
    label: 'Ventilator', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)],
    draw: (c) => { const r = c.u / 2; c.circ(V(0, 0), r); c.line(V(-r * 0.2, r * 0.98), V(r, 0)); c.line(V(-r * 0.2, -r * 0.98), V(r, 0)); },
  },
  expansion: {
    label: 'Ausdehnungsgefäss', ports: (u) => [V(0, -0.75 * u)],
    draw: (c) => { const r = 0.45 * c.u; c.circ(V(0, 0), r); c.line(V(-r, 0), V(r, 0)); c.line(V(0, -r), V(0, -0.75 * c.u)); },
  },
  meter: {
    label: 'Zähler', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)],
    draw: (c) => { const r = 0.4 * c.u; c.circ(V(0, 0), r); c.line(V(-c.u / 2, 0), V(-r, 0)); c.line(V(r, 0), V(c.u / 2, 0)); c.text(V(0, 0), 'Z', 1.6); },
  },
  filter: {
    label: 'Filter / Schmutzfänger', ports: (u) => [V(-u / 2, 0), V(u / 2, 0)],
    draw: (c) => { const r = c.u / 2; c.poly([V(-r, 0), V(0, r * 0.7), V(r, 0), V(0, -r * 0.7)], true); c.line(V(0, -r * 0.7), V(0, r * 0.7), { ...c.thin, dash: 'dash' }); },
  },
  hx: {
    label: 'Wärmetauscher', ports: (u) => [V(-0.6 * u, 0.5 * u), V(-0.6 * u, -0.5 * u), V(0.6 * u, 0.5 * u), V(0.6 * u, -0.5 * u)],
    draw: (c) => { rect(c, 1.2 * c.u, c.u); c.poly([V(-0.6 * c.u, 0.5 * c.u), V(-0.2 * c.u, -0.3 * c.u), V(0.2 * c.u, 0.3 * c.u), V(0.6 * c.u, -0.5 * c.u)], false, c.thin); },
  },
  box: { label: 'Apparat (Rechteck)', ports: (u) => [V(-u, 0), V(u, 0), V(0, 0.6 * u), V(0, -0.6 * u)], draw: (c) => rect(c, 2 * c.u, 1.2 * c.u), text: V(0, 0) },
};
export const schemaKindOptions = (): [string, string][] => Object.entries(SCHEMA_KINDS).map(([k, v]) => [k, v.label]);

function frame(el: El): (q: V2) => V2 {
  const co = Math.cos(el.rot ?? 0), si = Math.sin(el.rot ?? 0);
  return (q) => ({ x: el.p.x + q.x * co - q.y * si, y: el.p.y + q.x * si + q.y * co });
}
export function symUnit(el: El, scale: number): number { return (el.size ?? 8) * scale; }
/** Anschlusspunkte (Ansichtskoordinaten) */
export function schemaPorts(el: El, scale: number): V2[] {
  const k = SCHEMA_KINDS[el.kind as SchemaKind] ?? SCHEMA_KINDS.box; const X = frame(el);
  return k.ports(symUnit(el, scale), el).map(X);
}

export function drawSchemaSym(dl: DisplayList, doc: Doc, el: El, scale: number, penIn?: Pen): void {
  const k = SCHEMA_KINDS[el.kind as SchemaKind] ?? SCHEMA_KINDS.box;
  const X = frame(el); const u = symUnit(el, scale);
  const col = penIn?.color ?? (el.system ? sysOf(doc, el).color : '#000000');
  const pen: Pen = penIn ?? { w: 3, color: col }; const thin: Pen = { w: 1, color: col };
  const c: SCtx = {
    u, pen, thin, el,
    line: (a, b, p = pen) => dl.line(X(a), X(b), p),
    poly: (pts, closed = false, p = pen, fill) => { if (fill && closed) dl.fill([pts.map(X)], { color: fill, pattern: 'solid', patColor: fill }, p); else if (closed) dl.fill([pts.map(X)], { color: '#ffffff' }, p); else dl.poly(pts.map(X), p, false); },
    circ: (q, r, p = pen, fill) => dl.circle(X(q), r, p, fill ? { color: fill, pattern: 'solid', patColor: fill } : { color: '#ffffff' }),
    text: (q, s, size = 2) => dl.text(X(q), s, { size, ha: 'center', va: 'middle', color: col }),
  };
  k.draw(c);
  for (const q of schemaPorts(el, scale)) dl.circle(q, 0.25 * scale, { w: 1, color: col }, undefined, { inv: true });
  const label = el.label ?? '';
  if (label) {
    const q = k.text ?? V(0, -0.9);
    dl.text(X(mul(q, u)), label, { size: 2, ha: 'center', va: q.y === 0 ? 'middle' : q.y > 0 ? 'bottom' : 'top', color: col });
  }
}

export function drawSchemaLine(dl: DisplayList, doc: Doc, el: El, scale: number): void {
  const sys = sysOf(doc, el.system ? el : ({ ...el, system: 'sys_hvl' } as El));
  const pen = sysPen(sys, 4);
  dl.line(el.a, el.b, pen);
  const L = dist(el.a, el.b);
  if ((el.arrow ?? sys.flow) && L > 12 * scale) {
    const d = norm(sub(el.b, el.a)); const n = perp(d); const tip = add(mid(el.a, el.b), mul(d, 1.2 * scale)); const l = 2.4 * scale;
    dl.fill([[tip, add(sub(tip, mul(d, l)), mul(n, 0.8 * scale)), sub(sub(tip, mul(d, l)), mul(n, 0.8 * scale))]], { color: sys.color, pattern: 'solid', patColor: sys.color }, undefined, { ns: true });
  }
}

const symProps = (): PropDef[] => {
  const g = GROUPS;
  return [
    { key: 'kind', label: 'Symbol', group: g.graphics, type: 'select', options: schemaKindOptions(), get: (e) => e.kind ?? 'box', set: (_e, v) => ({ kind: v }) },
    { key: 'label', label: 'Beschriftung', group: g.text, type: 'text', get: (e) => e.label ?? '', set: (_e, v) => ({ label: v || undefined }) },
    { key: 'size', label: 'Grösse (Papier-mm)', group: g.graphics, type: 'number', get: (e) => e.size ?? 8, set: (_e, v) => ({ size: Math.max(2, v) }) },
    { key: 'rot', label: 'Drehung', group: g.graphics, type: 'angle', get: (e) => e.rot ?? 0, set: (_e, v) => ({ rot: v }) },
    { key: 'ports', label: 'Abgänge (Verteiler)', group: g.graphics, type: 'int', get: (e) => e.ports ?? 4, set: (_e, v) => ({ ports: Math.max(1, Math.min(12, Math.round(v))) }) },
    { key: 'system', label: 'Systemtyp (Farbe)', group: 'Mechanisch', type: 'select', options: (d) => [['', '–'], ...systemOptions(d)], get: (e) => e.system ?? '', set: (_e, v) => ({ system: v || undefined }) },
  ];
};
const lineProps = (): PropDef[] => [
  { key: 'system', label: 'Systemtyp', group: 'Mechanisch', type: 'select', options: (d) => systemOptions(d), get: (e, d) => sysOf(d, e.system ? e : ({ ...e, system: 'sys_hvl' } as El)).id, set: (_e, v) => ({ system: v }) },
  { key: 'arrow', label: 'Fliesspfeil', group: GROUPS.graphics, type: 'bool', get: (e, d) => e.arrow ?? sysOf(d, e.system ? e : ({ ...e, system: 'sys_hvl' } as El)).flow ?? false, set: (_e, v) => ({ arrow: v }) },
  { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e) => Math.round(dist(e.a, e.b)) + ' mm' },
];

registerCategory({
  cat: 'schemaSym', label: 'Schemasymbol', plural: 'Schemasymbole', annotation: true, planOrder: 92,
  drawAnnotation: (dl, el, doc, view) => drawSchemaSym(dl, doc, el, view.scale || 50),
  grips: (el, _doc, view): Grip[] => { const u = symUnit(el, view.scale || 50); const X = frame(el); return [{ id: 'rot', p: X(V(0, u * 1.3)), kind: 'end', tip: 'Drehen' }]; },
  dragGrip: (el, id, p) => (id === 'rot' && dist(p, el.p) > 1 ? { rot: Math.round(((angleOf(sub(p, el.p)) - Math.PI / 2) / (Math.PI / 12))) * (Math.PI / 12) } : undefined),
  transform: (el, m) => { const wy = applyVec(m, { x: -Math.sin(el.rot ?? 0), y: Math.cos(el.rot ?? 0) }); return { p: apply(m, el.p), rot: angleOf(wy) - Math.PI / 2 }; },
  center: (el) => el.p,
  props: () => symProps(),
});
registerCategory({
  cat: 'schemaLine', label: 'Schemaleitung', plural: 'Schemaleitungen', annotation: true, planOrder: 91,
  drawAnnotation: (dl, el, doc, view) => drawSchemaLine(dl, doc, el, view.scale || 50),
  grips: (el): Grip[] => [{ id: 'a', p: el.a, kind: 'end' }, { id: 'b', p: el.b, kind: 'end' }],
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m) => ({ a: apply(m, el.a), b: apply(m, el.b) }),
  center: (el) => mid(el.a, el.b),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  props: () => lineProps(),
});

// ------------------------------------------------------------ Erzeugen (auch für Skripte/API)
export function createSchemaView(doc: Doc, name: string, scale = 50): View {
  return doc.add<View>({ id: newId('vw'), cat: 'view', kind: 'drafting', name, scale, detail: 'medium', data: { mepSchema: true } } as View);
}
export function addSchemaSym(doc: Doc, viewId: Id, kind: SchemaKind, p: V2, o: Partial<SchemaSym> = {}): SchemaSym {
  return doc.add<SchemaSym>({ rot: 0, size: 8, ...o, id: newId('ss'), cat: 'schemaSym', viewId, kind, p: { ...p } } as SchemaSym);
}
export function addSchemaLine(doc: Doc, viewId: Id, pts: V2[], system?: Id, arrow?: boolean): SchemaLine[] {
  const out: SchemaLine[] = [];
  for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i], pts[i + 1]) > 0.5) out.push(doc.add<SchemaLine>({ id: newId('sl'), cat: 'schemaLine', viewId, a: { ...pts[i] }, b: { ...pts[i + 1] }, system, ...(arrow !== undefined ? { arrow } : {}) } as SchemaLine));
  return out;
}

/**
 * Prinzipschema Heizung aus dem Modell: Wärmepumpe (aussen/innen), Speicher, Vor-/Rücklauf-Sammelleitung,
 * je Ebene ein FBH-Verteiler (Anzahl Kreise aus dem Modell) mit Heizkreisen.
 */
export function autoHeatingSchema(doc: Doc, viewId: Id): number {
  const view = doc.get<View>(viewId); const s = view?.scale || 50; const u = 8 * s;
  const fixes = doc.all('mepFixture');
  const tOf = (f: El) => doc.get<FixType>(f.typeId);
  const nameOf = (f: El | undefined, fb: string) => (f ? f.label ?? tOf(f)?.label ?? tOf(f)?.name ?? fb : fb);
  const mans = fixes.filter((f) => tOf(f)?.sym === 'manifold').sort((a, b) => (doc.get<any>(a.levelId)?.elev ?? 0) - (doc.get<any>(b.levelId)?.elev ?? 0));
  const hp = fixes.filter((f) => tOf(f)?.sym === 'heatPump');
  const tank = fixes.find((f) => tOf(f)?.sym === 'tank');
  let n = 0;
  const sym = (k: SchemaKind, p: V2, o: Partial<SchemaSym> = {}) => { n++; return addSchemaSym(doc, viewId, k, p, o); };
  const line = (pts: V2[], sys: Id) => { n += addSchemaLine(doc, viewId, pts, sys).length; };
  const outdoor = hp.find((f) => /aussen/i.test(nameOf(f, '')));
  const indoor = hp.find((f) => f !== outdoor) ?? (outdoor ? undefined : hp[0]);
  // Wärmeerzeugung: Aussengerät → Hydromodul (Kältemittel), Speicherladung
  const wpA = sym('heatpump', V(0, 0), { label: nameOf(outdoor, 'WP-Aussengerät') });
  const hmP = V(4.5 * u, 0);
  sym('box', hmP, { label: nameOf(indoor, 'Hydromodul'), system: 'sys_hvl' });
  const pa = schemaPorts(wpA, s);
  line([pa[2], add(hmP, V(-u, 0.35 * u))], 'sys_hvl');
  line([add(hmP, V(-u, -0.35 * u)), pa[3]], 'sys_hrl');
  const tkP = V(4.5 * u, -3.6 * u);
  sym('tank', tkP, { label: nameOf(tank, 'BWW'), system: 'sys_ww' });
  line([add(hmP, V(-0.3 * u, -0.6 * u)), add(tkP, V(-0.3 * u, 1.2 * u))], 'sys_hvl');
  line([add(tkP, V(0.3 * u, 1.2 * u)), add(hmP, V(0.3 * u, -0.6 * u))], 'sys_hrl');
  // Sammelleitungen mit Umwälzpumpe im Vorlauf
  const yVL = 3.4 * u, yRL = 2.8 * u; const xV = 6.3 * u, xR = 7.2 * u;
  const list = mans.length ? mans : [null];
  const nOf = (m: El | null) => { const cs = m ? doc.all<FbhCircuit>('fbh').filter((c) => c.manifoldId === m.id) : []; return { cs, n: Math.max(1, cs.length || (m ? tOf(m)?.count ?? 4 : 4)) }; };
  let cursor = xR + 1.4 * u; let xEnd = cursor;
  const placed: { m: El | null; cx: number; L: number; ports: number }[] = [];
  for (const m of list) { const ports = Math.min(nOf(m).n, 8); const L = (ports + 1) * 0.6 * u; const cx = cursor + L / 2; placed.push({ m, cx, L, ports }); cursor = cx + L / 2 + 2.2 * u; xEnd = cx - L / 2 - 0.4 * u; }
  line([add(hmP, V(u, 0.35 * u)), V(xV, 0.35 * u), V(xV, yVL), V(xEnd, yVL)], 'sys_hvl');
  line([V(xEnd - 0.4 * u, yRL), V(xR, yRL), V(xR, -0.35 * u), add(hmP, V(u, -0.35 * u))], 'sys_hrl');
  sym('pump', V(xV, (0.35 * u + yVL) / 2), { rot: Math.PI / 2, system: 'sys_hvl' });
  for (const { m, cx, ports } of placed) {
    const { cs, n: nC } = nOf(m);
    const lvl = m ? doc.get<any>(m.levelId)?.name ?? '' : '';
    const mv = sym('manifold', V(cx, 0.6 * u), { ports, label: `FBH-Verteiler ${lvl} (${nC} Kreise)`, system: 'sys_hvl' });
    const ps = schemaPorts(mv, s);
    line([V(ps[0].x - 0.4 * u, yVL), V(ps[0].x - 0.4 * u, ps[0].y), ps[0]], 'sys_hvl');
    line([ps[1], V(ps[1].x - 0.8 * u, ps[1].y), V(ps[1].x - 0.8 * u, yRL)], 'sys_hrl');
    const len = cs.reduce((a, c) => a + fbhLayout(doc, c).length, 0);
    const vl = ps[2 + 2 * (ports - 1)], rl = ps[3 + 2 * (ports - 1)];
    const bx = rl.x + 0.5 * u, by = -2.0 * u;
    sym('fbh', V(bx - u, by), { label: `Heizkreise ${lvl}${len ? ` – ${Math.round(len / 1000)} m` : ''}`, system: 'sys_fbh' });
    line([vl, V(vl.x, by + 0.45 * u + 0.5 * u), V(bx - 1.5 * u, by + 0.95 * u), V(bx - 1.5 * u, by + 0.45 * u)], 'sys_hvl');
    line([V(bx - 0.5 * u, by + 0.45 * u), V(bx - 0.5 * u, by + 0.7 * u), V(rl.x, by + 0.7 * u), rl], 'sys_hrl');
  }
  return n;
}

// ------------------------------------------------------------ Werkzeuge
export class SchemaSymbolTool extends Tool {
  id = 'schemaSymbol'; label = 'Schemasymbol'; kinds = ['drafting', 'legend'];
  static kind: SchemaKind = 'pump'; static rot = 0; static label = ''; static system = '';
  private cur: V2 | null = null;
  prompt(): string { return 'Klicken Sie, um das Schemasymbol zu platzieren. Leertaste dreht um 90°.'; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'k', label: 'Symbol', value: SchemaSymbolTool.kind, options: schemaKindOptions(), onChange: (v) => { SchemaSymbolTool.kind = v as SchemaKind; app.redrawOverlay(); } },
      { kind: 'text', key: 'l', label: 'Beschriftung', value: SchemaSymbolTool.label, width: 120, onChange: (v) => { SchemaSymbolTool.label = v; } },
      { kind: 'select', key: 's', label: 'System', value: SchemaSymbolTool.system, options: [['', '–'], ...systemOptions(app.doc)], onChange: (v) => { SchemaSymbolTool.system = v; } },
      { kind: 'angle', key: 'r', label: 'Drehung', value: SchemaSymbolTool.rot, onChange: (v) => { SchemaSymbolTool.rot = v; } },
    ];
  }
  space(): boolean { SchemaSymbolTool.rot = (SchemaSymbolTool.rot + Math.PI / 2) % (2 * Math.PI); app.emit('tool'); app.redrawOverlay(); return true; }
  move(e: ToolEvent): void { this.cur = e.p; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    app.doc.transaction('Schemasymbol', () => addSchemaSym(app.doc, e.view.id, SchemaSymbolTool.kind, e.p, { rot: SchemaSymbolTool.rot, label: SchemaSymbolTool.label || undefined, system: SchemaSymbolTool.system || undefined }));
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    drawSchemaSym(dl, app.doc, { id: '', cat: 'schemaSym', p: this.cur, rot: SchemaSymbolTool.rot, kind: SchemaSymbolTool.kind, label: SchemaSymbolTool.label } as El, vp.view.scale || 50, PREVIEW);
  }
}

export class SchemaLineTool extends LineDrawTool {
  id = 'schemaLine'; label = 'Systemleitung (Schema)'; kinds = ['drafting', 'legend'];
  modes: any = ['line', 'pick'];
  static system = 'sys_hvl';
  extraOptions(): OptionItem[] { return [{ kind: 'select', key: 's', label: 'System', value: SchemaLineTool.system, options: systemOptions(app.doc), onChange: (v) => { SchemaLineTool.system = v; } }]; }
  pickFilter(cat: string): boolean { return cat === 'schemaLine' || cat === 'line'; }
  createSegment(a: V2, b: V2): void { addSchemaLine(app.doc, app.activeView()!.id, [a, b], SchemaLineTool.system); }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void {
    const s: MepSystem | undefined = app.doc.get<MepSystem>(SchemaLineTool.system);
    dl.line(a, b, s ? { ...sysPen(s, 4) } : PREVIEW);
  }
}
