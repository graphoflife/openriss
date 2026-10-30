// Räume und Raumtrennungen: Raum = Bereich (um den Raumpunkt), der von raumbegrenzenden Wänden,
// Stützen und Raumtrennungslinien der Ebene umschlossen ist. Fläche/Umfang/Volumen berechnet.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import {
  V2, Ring, Poly, apply, mid, dist, segRect, difference, pointInPoly, bboxOf, polyArea, perimeter, interiorPoint, arcPoints,
} from '../../core/geom';
import { registerCategory, registerCommand, catDef, emitHook, GROUPS, PropDef } from '../../core/registry';
import { levelElev, levelAbove, levelOptions, View } from '../../core/view';
import { cached } from '../../core/cache';
import { fmtArea, fmtLen } from '../../core/units';
import { cutPolysOfElement, catPen } from '../../views/sectionEngine';
import { Wall, wallInfo, wallShape, clipSegToMulti } from '../../elements/wall';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool, PREVIEW } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool, registerSimilar } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { cleanMulti } from './roofGeom';
import { fmtM3, levelName } from './common';

export interface Room extends El {
  cat: 'room';
  name: string;
  number: string;
  levelId: Id;
  pt: V2;
  baseOffset: number;
  topLevelId: Id | null;
  topOffset: number;
  floorFinish?: string; wallFinish?: string; ceilingFinish?: string;
  occupancy?: string; department?: string;
  fillOn?: boolean; color?: string;
}
export interface RoomSep extends El { cat: 'roomsep'; a: V2; b: V2; levelId: Id }

// ------------------------------------------------------------ Bereiche je Ebene
export interface Region { poly: Poly; open: boolean }
/** Höhe über Ebene, in der raumbegrenzende Elemente gesucht werden (Raumberechnungshöhe) */
export const ROOM_CALC_H = 1000;

export function levelRegions(doc: Doc, levelId: Id): Region[] {
  return cached(doc, 'archRegions', levelId, () => {
    const z = levelElev(doc, levelId) + ROOM_CALC_H;
    const obstacles: Poly[] = [];
    for (const w of doc.all<Wall>('wall')) {
      if (w.roomBounding === false) continue;
      const wi = wallInfo(doc, w);
      if (wi.L < 1 || !(wi.z0 <= z && wi.z1 > z)) continue;
      obstacles.push([wallShape(doc, w).ring]);
    }
    for (const s of doc.all<RoomSep>('roomsep')) {
      if (s.levelId !== levelId || dist(s.a, s.b) < 1) continue;
      obstacles.push([segRect(s.a, s.b, 1, 1, 5, 5)]);
    }
    // Stützen (falls vorhanden) schneiden
    if (catDef('column')) {
      const pr = { origin: { x: 0, y: 0, z }, dir: { x: 0, y: 0, z: -1 }, toView: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }), depth: (p: { z: number }) => z - p.z };
      for (const c of doc.all('column')) {
        if (c.roomBounding === false) continue;
        try { for (const g of cutPolysOfElement(doc, c, pr)) obstacles.push(...g.polys); } catch { /* */ }
      }
    }
    if (!obstacles.length) return [];
    const pts = obstacles.flatMap((p) => p[0]);
    const bb = bboxOf(pts); const M = 5000;
    const box: Ring = [{ x: bb.min.x - M, y: bb.min.y - M }, { x: bb.max.x + M, y: bb.min.y - M }, { x: bb.max.x + M, y: bb.max.y + M }, { x: bb.min.x - M, y: bb.max.y + M }];
    const regions = cleanMulti(difference([box], ...obstacles));
    return regions.map((poly) => ({
      poly,
      open: poly[0].some((p) => Math.abs(p.x - box[0].x) < 1 || Math.abs(p.x - box[1].x) < 1 || Math.abs(p.y - box[0].y) < 1 || Math.abs(p.y - box[2].y) < 1),
    }));
  });
}
export function regionAt(doc: Doc, levelId: Id, p: V2): Region | null {
  return levelRegions(doc, levelId).find((r) => pointInPoly(p, r.poly)) ?? null;
}

// ------------------------------------------------------------ Raumdaten
export interface RoomInfo { poly: Poly | null; area: number; perimeter: number; z0: number; z1: number; status: 'ok' | 'open' | 'none' | 'shared' }
export function roomZ(doc: Doc, r: El): [number, number] {
  const z0 = levelElev(doc, r.levelId) + (r.baseOffset ?? 0);
  const top = r.topLevelId && doc.get(r.topLevelId) ? levelElev(doc, r.topLevelId) : levelElev(doc, r.levelId);
  const z1 = top + (r.topOffset ?? 0);
  return [z0, Math.max(z0, z1)];
}
export function roomInfo(doc: Doc, r: El): RoomInfo {
  const calc = (): RoomInfo => {
    const [z0, z1] = roomZ(doc, r);
    if (!r.pt || !r.levelId) return { poly: null, area: 0, perimeter: 0, z0, z1, status: 'none' };
    const reg = regionAt(doc, r.levelId, r.pt);
    if (!reg) return { poly: null, area: 0, perimeter: 0, z0, z1, status: 'none' };
    if (reg.open) return { poly: null, area: 0, perimeter: 0, z0, z1, status: 'open' };
    // weitere Räume im selben Bereich → Raumtrennung fehlt (z.B. offenes Wohnen/Essen/Küche)
    const shared = doc.all<Room>('room').some((o) => o.id !== r.id && o.levelId === r.levelId && o.pt && pointInPoly(o.pt, reg.poly));
    return { poly: reg.poly, area: polyArea(reg.poly), perimeter: reg.poly.reduce((s, q) => s + perimeter(q), 0), z0, z1, status: shared ? 'shared' : 'ok' };
  };
  return r.id ? cached(doc, 'archRoomInfo', r.id, calc) : calc();
}
export const roomText = (doc: Doc, r: El): string => {
  const ri = roomInfo(doc, r);
  const hint = ri.status === 'shared' ? '\n⚠ Raumtrennung fehlt' : ri.status === 'open' ? '\n⚠ nicht umschlossen' : '';
  return `${r.name ?? 'Raum'}\n${r.number ?? ''}\n${fmtArea(ri.area)}${hint}`;
};

export function nextRoomNumber(doc: Doc): string {
  let max = 0;
  for (const r of doc.all<Room>('room')) { const n = parseInt(r.number ?? '', 10); if (!isNaN(n) && n > max) max = n; }
  return String(max + 1);
}

const STATUS: Record<RoomInfo['status'], string> = { ok: 'Umschlossen', open: 'Nicht umschlossen', none: 'Nicht platziert (kein Bereich)', shared: 'Mehrere Räume im selben Bereich – Raumtrennung setzen' };

function roomProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'level', label: 'Ebene', group: g.constraints, type: 'readonly', get: (e, doc) => levelName(doc, e.levelId) },
    { key: 'topLevelId', label: 'Obere Grenze', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.topLevelId ?? e.levelId, set: (_e, v) => ({ topLevelId: v }) },
    { key: 'topOffset', label: 'Begrenzungsversatz', group: g.constraints, type: 'length', get: (e) => e.topOffset ?? 0, set: (_e, v) => ({ topOffset: v }) },
    { key: 'baseOffset', label: 'Versatz unten', group: g.constraints, type: 'length', get: (e) => e.baseOffset ?? 0, set: (_e, v) => ({ baseOffset: v }) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => roomInfo(doc, e).area },
    { key: 'perimeter', label: 'Umfang', group: g.dims, type: 'readonly', get: (e, doc) => fmtLen(roomInfo(doc, e).perimeter) },
    { key: 'height', label: 'Höhe ohne Begrenzung', group: g.dims, type: 'readonly', get: (e, doc) => { const i = roomInfo(doc, e); return fmtLen(i.z1 - i.z0); } },
    { key: 'volume', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => { const i = roomInfo(doc, e); return fmtM3(i.area * (i.z1 - i.z0)); } },
    { key: 'status', label: 'Status', group: g.dims, type: 'readonly', get: (e, doc) => (e.id ? STATUS[roomInfo(doc, e).status] : '') },
    { key: 'number', label: 'Nummer', group: g.identity, type: 'text', get: (e) => e.number ?? '', set: (_e, v) => ({ number: v }) },
    { key: 'name', label: 'Name', group: g.identity, type: 'text', get: (e) => e.name ?? '', set: (_e, v) => ({ name: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'occupancy', label: 'Nutzung', group: g.identity, type: 'text', get: (e) => e.occupancy ?? '', set: (_e, v) => ({ occupancy: v }) },
    { key: 'department', label: 'Abteilung', group: g.identity, type: 'text', get: (e) => e.department ?? '', set: (_e, v) => ({ department: v }) },
    { key: 'floorFinish', label: 'Bodenbelag', group: g.identity, type: 'text', get: (e) => e.floorFinish ?? '', set: (_e, v) => ({ floorFinish: v }) },
    { key: 'wallFinish', label: 'Wandoberfläche', group: g.identity, type: 'text', get: (e) => e.wallFinish ?? '', set: (_e, v) => ({ wallFinish: v }) },
    { key: 'ceilingFinish', label: 'Deckenoberfläche', group: g.identity, type: 'text', get: (e) => e.ceilingFinish ?? '', set: (_e, v) => ({ ceilingFinish: v }) },
    { key: 'fillOn', label: 'Farbfüllung', group: g.graphics, type: 'bool', get: (e) => !!e.fillOn, set: (_e, v) => ({ fillOn: v }) },
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (e) => e.color ?? '#9cc3e6', set: (_e, v) => ({ color: v, fillOn: true }) },
  ];
}

const SEL_PEN = { w: 1, color: '#1e6fd9' };
function drawRoom(dl: DisplayList, doc: Doc, r: El, scale: number): void {
  const info = roomInfo(doc, r);
  if (info.poly) {
    const fill = r.fillOn ? { color: r.color ?? '#9cc3e6', alpha: 0.35 } : { color: 'transparent' };
    dl.fill(info.poly, fill, undefined, { ns: true });
    for (const ring of info.poly) dl.poly(ring, SEL_PEN, true, { sel: true, ns: true });
    // Referenzkreuz
    const b = bboxOf(info.poly[0]);
    for (const [a, c] of [[b.min, b.max], [{ x: b.min.x, y: b.max.y }, { x: b.max.x, y: b.min.y }]] as [V2, V2][]) {
      for (const [s, t] of clipSegToMulti(a, c, [info.poly])) dl.line(s, t, SEL_PEN, { sel: true, ns: true });
    }
  } else {
    // nicht umschlossen: kleines Kreuz am Raumpunkt
    const s = 3 * scale;
    dl.circle(r.pt, s, undefined, { color: 'transparent' }, { ns: true });
    dl.line({ x: r.pt.x - s, y: r.pt.y - s }, { x: r.pt.x + s, y: r.pt.y + s }, { w: 1, color: '#c03030' }, { sel: true, ns: true });
    dl.line({ x: r.pt.x - s, y: r.pt.y + s }, { x: r.pt.x + s, y: r.pt.y - s }, { w: 1, color: '#c03030' }, { sel: true, ns: true });
  }
}

const isLevelPlan = (view: View, levelId: Id | undefined) => (view.kind === 'plan' || view.kind === 'ceiling') && view.levelId === levelId;

registerCategory({
  cat: 'room', label: 'Raum', plural: 'Räume', planOrder: -10,
  visibleIn: (el, _doc, view) => isLevelPlan(view, el.levelId),
  drawPlan: (ctx, el) => drawRoom(ctx.dl, ctx.doc, el, ctx.view.scale),
  transform: (el, m, _doc, view) => (view.kind === 'plan' || view.kind === 'ceiling' ? { pt: apply(m, el.pt) } : undefined),
  translate3d: (el, d) => ({ pt: { x: el.pt.x + d.x, y: el.pt.y + d.y } }),
  center: (el) => el.pt,
  onCopy: (el, doc) => ({ ...el, number: nextRoomNumber(doc) }),
  props: () => roomProps(),
  tagText: (el, doc) => roomText(doc, el),
  tagPoint: (el) => el.pt,
  scheduleFields: () => [
    { key: 'name', label: 'Name', get: (el) => el.name ?? '' },
    { key: 'number', label: 'Nummer', get: (el) => el.number ?? '' },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => roomInfo(doc, el).area },
    { key: 'perimeter', label: 'Umfang', unit: 'len', get: (el, doc) => roomInfo(doc, el).perimeter },
    { key: 'height', label: 'Höhe', unit: 'len', get: (el, doc) => { const i = roomInfo(doc, el); return i.z1 - i.z0; } },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => { const i = roomInfo(doc, el); return i.area * (i.z1 - i.z0); } },
    { key: 'level', label: 'Ebene', get: (el, doc) => levelName(doc, el.levelId) },
    { key: 'floorFinish', label: 'Bodenbelag', get: (el) => el.floorFinish ?? '' },
    { key: 'wallFinish', label: 'Wandoberfläche', get: (el) => el.wallFinish ?? '' },
    { key: 'ceilingFinish', label: 'Deckenoberfläche', get: (el) => el.ceilingFinish ?? '' },
    { key: 'occupancy', label: 'Nutzung', get: (el) => el.occupancy ?? '' },
  ],
});

// ------------------------------------------------------------ Raumtrennung
registerCategory({
  cat: 'roomsep', label: 'Raumtrennung', plural: 'Raumtrennungen', planOrder: 55,
  visibleIn: (el, _doc, view) => isLevelPlan(view, el.levelId),
  drawPlan: (ctx, el) => ctx.dl.line(el.a, el.b, { ...catPen(ctx.doc, 'roomsep', false), w: 1 }, { sub: 'line' }),
  grips: (el, _doc, view) => (view.kind === 'plan' ? [{ id: 'a', p: el.a, kind: 'end' }, { id: 'b', p: el.b, kind: 'end' }] : []),
  dragGrip: (_el, id, p) => (id === 'a' ? { a: p } : id === 'b' ? { b: p } : undefined),
  transform: (el, m, _doc, view) => (view.kind === 'plan' || view.kind === 'ceiling' ? { a: apply(m, el.a), b: apply(m, el.b) } : undefined),
  translate3d: (el, d) => ({ a: { x: el.a.x + d.x, y: el.a.y + d.y }, b: { x: el.b.x + d.x, y: el.b.y + d.y } }),
  curve: (el) => ({ a: el.a, b: el.b }),
  setCurve: (_el, a, b) => ({ a, b }),
  center: (el) => mid(el.a, el.b),
  props: () => [
    { key: 'level', label: 'Ebene', group: GROUPS.constraints, type: 'readonly', get: (e, doc) => levelName(doc, e.levelId) },
    { key: 'length', label: 'Länge', group: GROUPS.dims, type: 'readonly', get: (e) => fmtLen(dist(e.a, e.b)) },
    { key: 'comments', label: 'Kommentare', group: GROUPS.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ],
});

class RoomSepTool extends LineDrawTool {
  id = 'roomSeparator'; label = 'Raumtrennung'; kinds = ['plan'];
  modes: any = ['line', 'rect', 'pick', 'arc', 'circle'];
  createSegment(a: V2, b: V2, arc?: { c: V2; r: number; a0: number; a1: number } | null): void {
    const lvl = activeLevelId();
    const pts = arc ? arcPoints(arc.c, arc.r, arc.a0, arc.a1, 24) : [a, b];
    for (let i = 0; i + 1 < pts.length; i++) app.doc.add<RoomSep>({ id: newId('rs'), cat: 'roomsep', a: pts[i], b: pts[i + 1], levelId: lvl } as RoomSep);
  }
}

// ------------------------------------------------------------ Raum platzieren
export class RoomTool extends Tool {
  id = 'room'; label = 'Raum'; kinds = ['plan'];
  private hover: Region | null = null;
  activate(): void {
    const lvl = activeLevelId();
    const above = levelAbove(app.doc, lvl);
    this.placement = placementFor('room', { levelId: lvl, name: 'Raum', baseOffset: 0, topLevelId: above?.id ?? lvl, topOffset: above ? 0 : 2500 });
    const p = this.placement.proto;
    p.levelId = lvl;
    p.topLevelId = above?.id ?? lvl; p.topOffset = above ? 0 : 2500;
    p.number = nextRoomNumber(app.doc);
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Klicken Sie in einen von Wänden umschlossenen Bereich, um einen Raum zu platzieren.'; }
  options(): OptionItem[] {
    return [
      { kind: 'check', key: 'tag', label: 'Beschriftung bei Platzierung', value: app.settings.tagOnPlace, onChange: (v) => { app.settings.tagOnPlace = v; app.saveSettings(); } },
      { kind: 'button', label: 'Räume automatisch platzieren', icon: 'room', onClick: () => this.autoPlace() },
    ];
  }
  move(e: ToolEvent): void { this.hover = regionAt(app.doc, e.view.levelId ?? activeLevelId(e.view), e.raw); }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const lvl = e.view.levelId ?? activeLevelId(e.view);
    const reg = regionAt(app.doc, lvl, e.raw);
    const existing = reg && !reg.open ? app.doc.all<Room>('room').find((r) => r.levelId === lvl && pointInPoly(r.pt, reg.poly)) : null;
    if (existing) { app.status(`In diesem Bereich befindet sich bereits ein Raum (${existing.number} ${existing.name}).`); }
    const room = this.create(e.raw, lvl, e.view);
    const st = roomInfo(app.doc, room).status;
    if (st !== 'ok') app.status('Warnung: Der Raum ist nicht in einem geschlossenen Bereich (Raum ist nicht umschlossen).');
  }
  private create(pt: V2, lvl: Id, view: View): Room {
    const p = this.placement!.proto;
    const { id: _i, ...rest } = p;
    let room!: Room;
    app.doc.transaction('Raum platzieren', () => {
      room = app.doc.add<Room>({ ...rest, id: newId('rm'), cat: 'room', levelId: lvl, pt, name: p.name || 'Raum', number: p.number || nextRoomNumber(app.doc) } as Room);
      if (app.settings.tagOnPlace) emitHook('tagOnPlace', room, view);
    });
    p.number = nextRoomNumber(app.doc);
    app.emit('tool');
    return room;
  }
  autoPlace(): void {
    const view = app.activeView(); if (!view) return;
    const lvl = view.levelId ?? activeLevelId(view);
    const rooms = app.doc.all<Room>('room').filter((r) => r.levelId === lvl);
    const free = levelRegions(app.doc, lvl).filter((r) => !r.open && polyArea(r.poly) > 0.5e6 && !rooms.some((rm) => pointInPoly(rm.pt, r.poly)));
    if (!free.length) { app.status('Keine freien umschlossenen Bereiche gefunden.'); return; }
    app.doc.transaction('Räume automatisch platzieren', () => { for (const r of free) this.create(interiorPoint(r.poly), lvl, view); });
    app.status(`${free.length} Räume wurden erstellt.`);
  }
  preview(dl: DisplayList): void {
    const r = this.hover; if (!r) return;
    if (r.open) return;
    dl.fill(r.poly, { color: '#1e6fd9', alpha: 0.1 }, PREVIEW, { ns: true });
    const b = bboxOf(r.poly[0]);
    for (const [a, c] of [[b.min, b.max], [{ x: b.min.x, y: b.max.y }, { x: b.max.x, y: b.min.y }]] as [V2, V2][]) {
      for (const [s, t] of clipSegToMulti(a, c, [r.poly])) dl.line(s, t, { w: 1, color: '#1e6fd9' }, { ns: true });
    }
  }
}

registerCommand({ id: 'room', label: 'Raum', icon: 'room', keys: ['RM'], tip: 'Raum in einem von Wänden und Raumtrennungen umschlossenen Bereich platzieren', run: () => startTool(new RoomTool(), 'room') });
registerCommand({ id: 'roomSeparator', label: 'Raumtrennung', icon: 'roomsep', tip: 'Raumtrennungslinie zeichnen (begrenzt Räume ohne Wand)', run: () => startTool(new RoomSepTool(), 'roomSeparator') });
registerSimilar('room', 'room');
registerSimilar('roomsep', 'roomSeparator');
