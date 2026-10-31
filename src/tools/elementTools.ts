// Werkzeuge zum Erzeugen von Kernelementen: Wand, Tür, Fenster, Linien, Raster,
// Referenzebene, Ebene, Schnitt, Ansicht.
import { app } from '../app';
import { Tool, ToolEvent, OptionItem, PlacementTarget } from './tool';
import { LineDrawTool, PREVIEW, listen } from './drawTool';
import type { El, Id } from '../core/doc';
import { newId } from '../core/doc';
import { V2, add, sub, mul, norm, perp, dist, sideDist, projectT, dot, mid } from '../core/geom';
import { catDef, emitHook, PlanCtx } from '../core/registry';
import { View, Level, levels, levelAbove, levelOptions, typesOf, isPlanLike, isSectionLike, makeProjector, annoViewId } from '../core/view';
import { Wall, wallInfo, wallAt, locOffset, wallType, LOC_LINE_LABELS, LocLine } from '../elements/wall';
import { Opening, nextMark } from '../elements/openings';
import { nextGridName, lineStyleOptions, sectionGeomPatch } from '../elements/datums';
import { createPlanViews } from '../core/template';
import type { DisplayList } from '../render/displayList';
import { fmtLen } from '../core/units';

export function activeLevelId(view?: View | null): Id {
  const v = view ?? app.activeView();
  if (v?.levelId) return v.levelId;
  const ls = levels(app.doc);
  if (v && isSectionLike(v)) return ls[0]?.id ?? '';
  return ls[0]?.id ?? '';
}

/** Vorgabewerte je Kategorie (Typ + Parameter) über Werkzeugaufrufe hinweg merken */
const lastProto = new Map<string, El>();
export function placementFor(cat: string, defaults: Partial<El>): PlacementTarget {
  // Standardtyp: erster Typ in Vorlagen-Reihenfolge (nicht alphabetisch)
  const types = app.doc.all<any>('type').filter((t) => t.of === cat);
  const prev = lastProto.get(cat);
  const proto: El = { id: '', cat, ...defaults, ...(prev ?? {}) } as El;
  if (prev) Object.assign(proto, { levelId: defaults.levelId, topLevelId: defaults.topLevelId ?? prev.topLevelId });
  if (!proto.typeId || !app.doc.get(proto.typeId)) proto.typeId = types[0]?.id;
  const t: PlacementTarget = {
    cat, proto, typeId: proto.typeId,
    setType: (id) => { proto.typeId = id; t.typeId = id; lastProto.set(cat, { ...proto }); app.emit('tool'); },
  };
  lastProto.set(cat, proto);
  return t;
}
export function rememberProto(p: PlacementTarget | null): void { if (p) lastProto.set(p.cat, { ...p.proto }); }

// ------------------------------------------------------------ Wand
export class WallTool extends LineDrawTool {
  id = 'wall'; label = 'Wand'; kinds = ['plan'];
  private flipNext = false;
  structural = false;
  activate(): void {
    const lvl = activeLevelId();
    const above = levelAbove(app.doc, lvl);
    this.placement = placementFor('wall', { levelId: lvl, baseOffset: 0, topLevelId: above?.id ?? null, topOffset: 0, height: 3000, locLine: 'center', structural: this.structural });
    this.placement.proto.levelId = lvl;
    if (this.placement.proto.topLevelId && !app.doc.get(this.placement.proto.topLevelId)) this.placement.proto.topLevelId = above?.id ?? null;
    if (this.structural) this.placement.proto.structural = true;
  }
  deactivate(): void { rememberProto(this.placement); }
  extraOptions(): OptionItem[] {
    const p = this.placement!.proto;
    return [
      { kind: 'select', key: 'top', label: 'Höhe', value: p.topLevelId ?? '', options: [['', 'Nicht verbunden'], ...levelOptions(app.doc)], onChange: (v) => { p.topLevelId = v || null; app.emit('tool'); } },
      ...(p.topLevelId ? [] : [{ kind: 'length', key: 'height', label: '', value: p.height ?? 3000, onChange: (v: number) => (p.height = v) } as OptionItem]),
      { kind: 'select', key: 'loc', label: 'Basislinie', value: p.locLine ?? 'center', options: LOC_LINE_LABELS as [string, string][], onChange: (v) => (p.locLine = v as LocLine) },
    ];
  }
  space(): boolean { this.flipNext = !this.flipNext; app.status(this.flipNext ? 'Außenseite rechts' : 'Außenseite links'); app.redrawOverlay(); return true; }
  createSegment(a: V2, b: V2): void {
    const p = this.placement!.proto;
    app.doc.add<Wall>({ ...p, id: newId('wa'), cat: 'wall', a, b, flip: this.flipNext } as Wall);
  }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void {
    const p = this.placement!.proto;
    const t = app.doc.get<any>(p.typeId);
    const T = t ? t.layers.reduce((s: number, l: any) => s + l.t, 0) : 200;
    const off = locOffset(t, (p.locLine ?? 'center') as LocLine, this.flipNext);
    const d = norm(sub(b, a)); const n = perp(d);
    const c0 = add(a, mul(n, off)), c1 = add(b, mul(n, off));
    const ext = this.flipNext ? -1 : 1;
    dl.poly([add(c0, mul(n, T / 2)), add(c1, mul(n, T / 2)), add(c1, mul(n, -T / 2)), add(c0, mul(n, -T / 2))], PREVIEW, true);
    dl.line(add(c0, mul(n, ext * T / 2)), add(c1, mul(n, ext * T / 2)), { w: 4, color: '#1e6fd9' });
  }
}

export class StructuralWallTool extends WallTool { id = 'wallStruct'; label = 'Tragende Wand'; structural = true; }

// ------------------------------------------------------------ Linien
export class LinesTool extends LineDrawTool {
  id: string; label: string;
  modes: any = ['line', 'rect', 'polyline', 'arc', 'circle', 'pick'];
  style = 'medium';
  constructor(public detail: boolean) {
    super();
    this.id = detail ? 'detailLine' : 'modelLine';
    this.label = detail ? 'Detaillinie' : 'Modelllinie';
    this.kinds = detail ? ['plan', 'ceiling', 'section', 'elevation', 'drafting', 'legend'] : ['plan'];
    const s = localStorage.getItem('openriss.lineStyle'); if (s) this.style = s;
  }
  extraOptions(): OptionItem[] {
    return [{ kind: 'select', key: 'style', label: 'Linienstil', value: this.style, options: lineStyleOptions(app.doc), onChange: (v) => { this.style = v; localStorage.setItem('openriss.lineStyle', v); } }];
  }
  createSegment(a: V2, b: V2, arc?: any): void {
    const v = app.activeView()!;
    const base: any = { id: newId('li'), cat: 'line', a, b, style: this.style, arc: arc ?? undefined };
    if (this.detail) base.viewId = annoViewId(app.doc, v); else base.levelId = activeLevelId(v);
    app.doc.add(base);
  }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void { dl.line(a, b, PREVIEW); }
}

// ------------------------------------------------------------ Raster / Referenzebene
export class GridTool extends LineDrawTool {
  id = 'grid'; label = 'Raster'; kinds = ['plan'];
  modes: any = ['line', 'pick'];
  showChain = false; chain = false;
  private nextName = '';
  activate(): void { this.nextName = nextGridName(app.doc); }
  extraOptions(): OptionItem[] { return [{ kind: 'text', key: 'name', label: 'Bezeichnung', value: this.nextName, width: 50, onChange: (v) => (this.nextName = v) }]; }
  createSegment(a: V2, b: V2): void {
    app.doc.add({ id: newId('gr'), cat: 'grid', name: this.nextName, a, b } as any);
  }
  afterCreate(): void { this.nextName = nextGridName(app.doc, this.nextName); app.emit('tool'); }
}

export class RefPlaneTool extends LineDrawTool {
  id = 'refplane'; label = 'Referenzebene'; kinds = ['plan'];
  modes: any = ['line', 'pick']; chain = false; showChain = false;
  createSegment(a: V2, b: V2): void { app.doc.add({ id: newId('rp'), cat: 'refplane', a, b, name: '' } as any); }
}

// ------------------------------------------------------------ Ebene (in Schnitt/Ansicht)
export class LevelTool extends Tool {
  id = 'level'; label = 'Ebene'; kinds = ['section', 'elevation'];
  private start: V2 | null = null; private cur: V2 | null = null;
  makePlans = true;
  prompt(): string { return this.start ? 'Endpunkt der Ebene' : 'Startpunkt der Ebene (Höhe)'; }
  options(): OptionItem[] { return [{ kind: 'check', key: 'plan', label: 'Grundriss erstellen', value: this.makePlans, onChange: (v) => (this.makePlans = v) }]; }
  basePoint() { return this.start; }
  down(e: ToolEvent): void {
    if (!this.start) { this.start = e.p; return; }
    const z = this.start.y + (makeProjector(e.view).origin.z);
    const ls = levels(app.doc);
    const name = nextLevelName(ls.map((l) => l.name), z, ls);
    app.doc.transaction('Ebene erstellen', () => {
      const x0 = Math.min(this.start!.x, e.p.x), x1 = Math.max(this.start!.x, e.p.x);
      const l = app.doc.add<Level>({ id: newId('lv'), cat: 'level', name, elev: Math.round(z), story: true, ext: x1 - x0 > 500 ? [x0, x1] : undefined } as any);
      if (this.makePlans) createPlanViews(app.doc, l);
    });
    this.start = null;
    app.emit('views');
  }
  move(e: ToolEvent): void { this.cur = this.start ? { x: e.p.x, y: this.start.y } : e.p; }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const y = this.start ? this.start.y : this.cur.y;
    const x0 = this.start ? this.start.x : this.cur.x - 2000;
    dl.line({ x: x0, y }, { x: this.cur.x, y }, { ...PREVIEW, dash: 'center' });
    dl.text({ x: this.cur.x, y: y + vp.view.scale * 2 }, 'Höhe ' + fmtLen(y), { size: 2.5, color: '#1e6fd9' });
  }
}
function nextLevelName(names: string[], z: number, ls: Level[]): string {
  const og = ls.filter((l) => l.elev > 1).length;
  let cand = z > 0 ? `${og + 1}. Obergeschoss` : z < -1 ? 'Untergeschoss' : 'Ebene';
  let i = 2; const base = cand;
  while (names.includes(cand)) cand = `${base} (${i++})`;
  return cand;
}

// ------------------------------------------------------------ Schnitt & Ansicht
export class SectionTool extends Tool {
  id = 'section'; label = 'Schnitt'; kinds = ['plan', 'ceiling'];
  private start: V2 | null = null; private cur: V2 | null = null;
  prompt(): string { return this.start ? 'Endpunkt der Schnittlinie (Blickrichtung nach links)' : 'Startpunkt der Schnittlinie'; }
  basePoint() { return this.start; }
  down(e: ToolEvent): void {
    if (!this.start) { this.start = e.p; return; }
    if (dist(this.start, e.p) < 100) return;
    const n = app.doc.all<View>('view').filter((v) => v.kind === 'section').length;
    const letter = String.fromCharCode(65 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
    const ls = levels(app.doc);
    const zmin = (ls[0]?.elev ?? 0) - 1500, zmax = (ls[ls.length - 1]?.elev ?? 3000) + 4000;
    app.doc.transaction('Schnitt erstellen', () => {
      const v: any = { id: newId('vw'), cat: 'view', kind: 'section', name: 'Schnitt ' + letter, scale: e.view.scale || 100, detail: 'medium', far: 6000, data: { marker: letter },
        crop: { on: true, show: true, min: { x: 0, y: zmin }, max: { x: dist(this.start!, e.p), y: zmax } } };
      Object.assign(v, sectionGeomPatch(this.start!, e.p, v));
      app.doc.add(v);
      app.select([v.id]);
    });
    this.start = null;
    app.emit('views');
  }
  move(e: ToolEvent): void { this.cur = e.p; }
  escape(): boolean { if (this.start) { this.start = null; return true; } return false; }
  preview(dl: DisplayList, vp: any): void {
    if (!this.start || !this.cur) return;
    dl.line(this.start, this.cur, { w: 4, color: '#1e6fd9' });
    const dir = perp(norm(sub(this.cur, this.start)));
    const m = mid(this.start, this.cur);
    dl.line(m, add(m, mul(dir, vp.view.scale * 10)), { w: 2, color: '#1e6fd9' });
    listen(dl, this.start, this.cur, vp.view.scale);
  }
}

export class ElevationTool extends Tool {
  id = 'elevation'; label = 'Ansicht'; kinds = ['plan'];
  private cur: V2 | null = null; private dir: V2 = { x: 0, y: 1 };
  prompt(): string { return 'Klicken Sie, um das Ansichtssymbol zu platzieren (Richtung zeigt zur nächsten Wand).'; }
  move(e: ToolEvent): void {
    this.cur = e.p;
    // Richtung zur nächsten Wand
    let best = Infinity;
    for (const w of app.doc.all<Wall>('wall')) {
      const wi = wallInfo(app.doc, w);
      const t = Math.max(0, Math.min(1, projectT(e.p, wi.c0, wi.c1)));
      const q = add(wi.c0, mul(sub(wi.c1, wi.c0), t)); const d = dist(q, e.p);
      if (d < best && d > 1) { best = d; const nn = wi.n; const s = sideDist(e.p, wi.c0, wi.c1) > 0 ? -1 : 1; this.dir = mul(nn, s); }
    }
    if (best === Infinity) this.dir = { x: 0, y: 1 };
  }
  down(e: ToolEvent): void {
    const n = app.doc.all<View>('view').filter((v) => v.kind === 'elevation').length + 1;
    app.doc.transaction('Ansicht erstellen', () => {
      app.doc.add({ id: newId('vw'), cat: 'view', kind: 'elevation', name: 'Ansicht ' + n, scale: e.view.scale || 100, detail: 'medium', origin: { x: e.p.x, y: e.p.y, z: 0 }, dir: this.dir, far: 30000, data: { marker: String(n) } } as any);
    });
    app.emit('views');
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.cur) return;
    const r = vp.view.scale * 4.5; const c = sub(this.cur, mul(this.dir, r * 1.6));
    dl.circle(c, r, { w: 2, color: '#1e6fd9' });
    const tip = add(c, mul(this.dir, r * 1.7)); const n = perp(this.dir);
    dl.poly([add(c, mul(n, r)), tip, sub(c, mul(n, r))], { w: 2, color: '#1e6fd9' }, true);
  }
}

// ------------------------------------------------------------ Tür / Fenster
export class OpeningTool extends Tool {
  id: string; label: string; kinds = ['plan'];
  private host: Wall | null = null; private t = 0; private side = 1;
  private hand = false;
  constructor(public cat: 'door' | 'window') { super(); this.id = cat; this.label = cat === 'door' ? 'Tür' : 'Fenster'; }
  activate(): void {
    const t0 = app.doc.all<any>('type').find((t) => t.of === this.cat);
    this.placement = placementFor(this.cat, { sill: this.cat === 'window' ? t0?.sill ?? 900 : 0 });
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return `Klicken Sie in eine Wand, um ${this.cat === 'door' ? 'die Tür' : 'das Fenster'} zu platzieren. Leertaste: Anschlag wechseln.`; }
  options(): OptionItem[] {
    return [{ kind: 'check', key: 'tag', label: 'Beschriftung bei Platzierung', value: app.settings.tagOnPlace, onChange: (v) => { app.settings.tagOnPlace = v; app.saveSettings(); } }];
  }
  space(): boolean { this.hand = !this.hand; app.redrawOverlay(); return true; }
  private proto(): Opening | null {
    if (!this.host) return null;
    const p = this.placement!.proto;
    const wi = wallInfo(app.doc, this.host);
    return { ...p, id: '__preview', cat: this.cat, hostId: this.host.id, levelId: this.host.levelId, t: this.t, sill: p.sill ?? 0,
      flipFacing: this.side * wi.ext > 0, flipHand: this.hand } as Opening;
  }
  move(e: ToolEvent): void {
    const v = e.view; const lv = app.doc.get<Level>(v.levelId);
    const z = (lv?.elev ?? 0) + 1000;
    const w = wallAt(app.doc, e.raw, z, 300);
    this.host = w;
    if (w) {
      const wi = wallInfo(app.doc, w);
      const W = (app.doc.get<any>(this.placement!.proto.typeId)?.width ?? 1000);
      let t = dot(sub(e.p, wi.c0), wi.d);
      t = Math.max(W / 2, Math.min(wi.L - W / 2, t));
      // auf 5 mm runden
      this.t = Math.round(t / 5) * 5;
      this.side = sideDist(e.raw, wi.c0, wi.c1) >= 0 ? 1 : -1;
    }
  }
  down(e: ToolEvent): void {
    const o = this.proto();
    if (!o) { app.status('Tür und Fenster müssen in eine Wand gesetzt werden.'); return; }
    app.doc.transaction(this.label + ' platzieren', () => {
      const el = { ...o, id: newId(this.cat.slice(0, 2)) } as Opening;
      if (this.cat === 'door') el.mark = nextMark(app.doc, 'door');
      else el.mark = nextMark(app.doc, 'window');
      app.doc.add(el);
      if (app.settings.tagOnPlace) emitHook('tagOnPlace', el, e.view);
    });
  }
  preview(dl: DisplayList, vp: any): void {
    const o = this.proto(); if (!o) return;
    const def = catDef(this.cat)!;
    const view = vp.view as View;
    const lv = app.doc.get<Level>(view.levelId);
    const ctx: PlanCtx = { doc: app.doc, view, dl, level: lv, cutZ: (lv?.elev ?? 0) + 1200, bottomZ: lv?.elev ?? 0, topZ: (lv?.elev ?? 0) + 2300, depthZ: lv?.elev ?? 0, detail: view.detail, ceiling: false };
    const sub0 = dl.items.length;
    try { def.drawPlan!(ctx, o); } catch { /* */ }
    for (let i = sub0; i < dl.items.length; i++) { const it: any = dl.items[i]; if (it.pen) it.pen = { ...it.pen, color: '#1e6fd9' }; }
    // Öffnungsumriss
    const wi = wallInfo(app.doc, this.host!); const W = app.doc.get<any>(o.typeId)?.width ?? 1000;
    const P = (u: number, v: number) => add(add(wi.c0, mul(wi.d, u)), mul(wi.n, v));
    dl.poly([P(o.t - W / 2, -wi.T / 2), P(o.t + W / 2, -wi.T / 2), P(o.t + W / 2, wi.T / 2), P(o.t - W / 2, wi.T / 2)], PREVIEW, true);
    // temporäre Abstände
    try {
      for (const td of def.tempDims?.(o, app.doc, view) ?? []) listen(dl, td.a, td.b, view.scale * 0.6);
    } catch { /* */ }
  }
}

export { wallType, isPlanLike };
