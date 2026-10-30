// Werkzeuge für Einlagen: Linienelemente (Polylinie mit Kette), Punktelemente, Durchstanzbewehrung
// um eine gewählte Stütze, Futterrohr in Wand (Grundriss oder Wandabwicklung).
import { app } from '../../app';
import type { El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, sub, norm, perp, dist, eq, fromAngle, mid, sideDist, projectT } from '../../core/geom';
import { levelElev, isPlanLike, isSectionLike, makeProjector, levels } from '../../core/view';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool, PREVIEW, PREVIEW_THIN } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import type { DisplayList } from '../../render/displayList';
import { wallAt, Wall } from '../../elements/wall';
import { Embed, EmbedType, Family, FAMILIES, typesOfFamily, embedType, addEmbedTemplate, punchRails, P } from './embed';
import { wallFrame, slabAt, columnBox, circleRing, coreSymbol, fmtKote } from './common';

export function ensureEmbedTypes(): void {
  const doc = app.doc;
  if (doc.all('type').some((t) => t.of === 'embed') && doc.get('m_betonstahl')) return;
  doc.transaction('Einlagen-Typen ergänzen', () => addEmbedTemplate(doc));
}

/** Platzierung mit Typvorauswahl der Familie */
function familyPlacement(family: Family, lvl: Id, defaults: Partial<El> = {}) {
  const pl = placementFor('embed', { levelId: lvl, z: 0, ...defaults });
  pl.proto.levelId = lvl;
  const cur = app.doc.get<EmbedType>(pl.proto.typeId);
  if (!cur || cur.family !== family) {
    const t = typesOfFamily(app.doc, family)[0];
    if (t) { pl.proto.typeId = t.id; pl.typeId = t.id; }
  }
  pl.proto.family = family;
  return pl;
}

// ------------------------------------------------------------ Linien- und Punkt-Einlagen
interface Opts { auto: boolean; z: number; side: 1 | -1; mode: 'standing' | 'lying' | 'vertical'; face: 'v' | 'h'; point: boolean; vert: boolean; h2: number }
const OPTS: Record<string, Opts> = {};
const optsFor = (f: Family): Opts => (OPTS[f] ??= { auto: true, z: 0, side: 1, mode: 'standing', face: f === 'coupler' ? 'v' : 'v', point: f === 'box', vert: false, h2: 3000 });

export class EmbedTool extends LineDrawTool {
  id: string; label: string; kinds = ['plan'];
  modes: any = ['line', 'pick'];
  private lastId: Id | null = null;
  private o: Opts;
  constructor(public family: Family, cmdId: string) {
    super(); this.id = cmdId; this.label = FAMILIES[family].label; this.o = optsFor(family);
    this.showOffset = family !== 'box';
  }
  private get fam(): Family { return (app.doc.get<EmbedType>(this.placement?.proto.typeId)?.family ?? this.family) as Family; }
  private isPoint(): boolean { const f = this.fam; return f === 'box' || (f === 'coupler' && this.o.point) || (f === 'waterstop' && this.o.mode === 'vertical'); }
  activate(): void {
    ensureEmbedTypes();
    this.placement = familyPlacement(this.family, activeLevelId());
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string {
    if (this.isPoint()) return `Klicken Sie, um ${this.label} zu platzieren. Leertaste: Seite/Richtung wechseln.`;
    return super.prompt() + ' Leertaste: Betonseite wechseln.';
  }
  extraOptions(): OptionItem[] {
    const f = this.fam; const o = this.o; const ch = () => { app.emit('tool'); app.setPrompt(this.prompt()); };
    const out: OptionItem[] = [];
    if (f === 'waterstop') out.push({ kind: 'select', key: 'mode', label: 'Lage', value: o.mode, options: [['standing', 'stehend (Wandfuss/-kopf)'], ['lying', 'liegend (Plattenfuge)'], ['vertical', 'senkrecht (Wandfuge)']], onChange: (v) => { o.mode = v as Opts['mode']; ch(); } });
    if (f === 'waterstop' && o.mode === 'vertical') out.push({ kind: 'length', key: 'h2', label: 'Länge', value: o.h2, onChange: (v) => (o.h2 = Math.max(10, v)) });
    if (f === 'rebarBox' || f === 'anchorChannel' || f === 'coupler') out.push({ kind: 'select', key: 'face', label: 'Fläche', value: o.face, options: [['v', 'senkrecht (Wand/Stirn)'], ['h', 'waagrecht (Platte)']], onChange: (v) => (o.face = v as 'v' | 'h') });
    if (f === 'coupler') out.push({ kind: 'check', key: 'pt', label: 'Einzelstab', value: o.point, onChange: (v) => { o.point = v; ch(); } });
    if (f === 'coupler' && o.point) out.push({ kind: 'check', key: 'vert', label: 'senkrecht', value: o.vert, onChange: (v) => (o.vert = v) });
    out.push({ kind: 'check', key: 'auto', label: 'Höhe aus Bauteil', value: o.auto, onChange: (v) => { o.auto = v; ch(); } });
    if (!o.auto) out.push({ kind: 'length', key: 'z', label: 'Höhe über Ebene', value: o.z, onChange: (v) => (o.z = v) });
    return out;
  }
  options(): OptionItem[] {
    if (!this.isPoint()) return super.options();
    return this.extraOptions();
  }
  space(): boolean { this.o.side = this.o.side === 1 ? -1 : 1; app.status(this.o.side > 0 ? 'Betonseite links / oben' : 'Betonseite rechts / unten'); app.redrawOverlay(); return true; }

  /** Höhe (über Ebene) und Seite für ein Segment bestimmen */
  private place(a: V2, b: V2 | null): { z: number; side: 1 | -1; face: 'v' | 'h'; hostSlab?: Id } {
    const doc = app.doc; const lvl = this.placement!.proto.levelId as Id; const L = levelElev(doc, lvl);
    const f = this.fam; const o = this.o; const m = b ? mid(a, b) : a;
    let z = o.z; let side = o.side; let face = o.face;
    if (o.auto) {
      const w = wallAt(doc, m, null, 60);
      const F = w ? wallFrame(doc, w.id) : null;
      const sl = slabAt(doc, m, L);
      if (f === 'waterstop') {
        if (o.mode === 'standing' && F) z = F.wi.z0 - L;
        else if (sl) z = (o.mode === 'standing' ? sl.top : (sl.top + sl.bot) / 2) - L;
        else if (F) z = F.wi.z0 - L;
      } else if (f === 'conduit') { if (sl) z = (sl.top + sl.bot) / 2 - L; }
      else if (f === 'box') { if (sl) z = sl.bot - L; }
      else if (f === 'coupler' && !b) { if (sl) z = (sl.top + sl.bot) / 2 - L; }
      else if (face === 'h') { if (sl) { z = (side > 0 ? sl.top : sl.bot) - L; } }
      else if (face === 'v' && b) {
        // Betonseite: Richtung zum Bauteil (Wandachse bzw. Platteninneres)
        const n = perp(norm(sub(b, a)));
        if (F && Math.abs(F.vOf(m)) >= 1) {
          const toAxis = mul(F.wi.n, -Math.sign(F.vOf(m)));
          side = n.x * toAxis.x + n.y * toAxis.y > 0 ? 1 : -1;
        }
        if (!F && sl) { const inn = slabAt(doc, add(m, mul(n, 60)), L); side = inn && inn.el.id === sl.el.id ? 1 : -1; z = (sl.top + sl.bot) / 2 - L; }
        if (F && f === 'coupler') z = (F.wi.z0 + F.wi.z1) / 2 - L;
      }
    }
    return { z, side, face };
  }

  createSegment(a: V2, b: V2): void {
    const doc = app.doc; const p = this.placement!.proto; const f = this.fam;
    const last = this.lastId ? doc.get<Embed>(this.lastId) : undefined;
    if (last?.pts && eq(last.pts[last.pts.length - 1], a, 0.5) && last.typeId === p.typeId && (f === 'conduit' || f === 'waterstop' || f === 'rebarBox')) {
      doc.update(last.id, { pts: [...last.pts, b] });
      return;
    }
    const pl = this.place(a, b);
    const { id: _i, ...rest } = p;
    const el = doc.add<Embed>({ ...rest, id: newId('em'), cat: 'embed', family: f, levelId: p.levelId, typeId: p.typeId, pts: [a, b], z: pl.z, side: pl.side,
      face: f === 'rebarBox' || f === 'anchorChannel' || f === 'coupler' ? pl.face : undefined, mode: f === 'waterstop' ? this.o.mode : undefined } as Embed);
    this.lastId = el.id;
  }
  afterCreate(): void { app.status(`${this.label} erstellt.`); }
  escape(): boolean { this.lastId = null; return super.escape(); }

  down(e: ToolEvent): void {
    if (!this.isPoint()) { super.down(e); return; }
    if (e.button !== 0) return;
    const doc = app.doc; const p = this.placement!.proto; const f = this.fam; const pl = this.place(e.p, null);
    const { id: _i, ...rest } = p;
    doc.transaction(this.label + ' platzieren', () => {
      const base = { ...rest, id: newId('em'), cat: 'embed', family: f, levelId: p.levelId, typeId: p.typeId, p: e.p, z: pl.z } as Embed;
      if (f === 'waterstop') { base.mode = 'vertical'; base.h2 = this.o.h2; base.rot = this.pointRot(e.p); }
      if (f === 'coupler') { base.vert = this.o.vert; base.rot = this.pointRot(e.p) + (this.o.side > 0 ? Math.PI / 2 : -Math.PI / 2); }
      if (f === 'box') base.rot = this.pointRot(e.p);
      doc.add(base);
    });
  }
  /** Richtung: entlang der nächsten Wand */
  private pointRot(p: V2): number {
    const w = wallAt(app.doc, p, null, 200); const F = w ? wallFrame(app.doc, w.id) : null;
    return F ? Math.atan2(F.wi.d.y, F.wi.d.x) : 0;
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.isPoint()) { super.preview(dl, vp); return; }
    const c = this.cur; if (!c) return;
    const t = embedType(app.doc, this.placement!.proto); const s = vp.view.scale as number;
    if (this.fam === 'box') {
      const w = (t?.w ?? 600) / 2, l = (t?.round ? t?.w ?? 120 : t?.l ?? 400) / 2;
      if (t?.round) dl.circle(c, w, PREVIEW); else dl.poly([{ x: -w, y: -l }, { x: w, y: -l }, { x: w, y: l }, { x: -w, y: l }].map((q) => add(c, q)), PREVIEW, true);
    } else dl.circle(c, 1.5 * s, PREVIEW);
  }
  segmentPreview(dl: DisplayList, a: V2, b: V2): void {
    dl.line(a, b, PREVIEW);
    const pl = this.place(a, b); const f = this.fam;
    if (f === 'rebarBox' || f === 'anchorChannel' || (f === 'coupler' && pl.face === 'v')) {
      const n = mul(perp(norm(sub(b, a))), pl.side * (vpScale(this) * 2));
      dl.line(mid(a, b), add(mid(a, b), n), PREVIEW_THIN);
    }
  }
}
const vpScale = (_t: Tool): number => app.activeView()?.scale ?? 50;

// ------------------------------------------------------------ Durchstanzbewehrung: Stütze wählen
export const PUNCH = { pattern: 'radial' as 'radial' | 'ortho', n: 8, dists: '90/145/145', where: 'auto' as 'auto' | 'below' | 'above' };
export class PunchTool extends Tool {
  id = 'embedPunching'; label = 'Durchstanzbewehrung'; kinds = ['plan'];
  private hover: El | null = null;
  activate(): void { ensureEmbedTypes(); this.placement = familyPlacement('punching', activeLevelId()); }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'Stütze wählen, um die Durchstanzbewehrung darum anzuordnen.'; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'pat', label: 'Anordnung', value: PUNCH.pattern, options: [['radial', 'radial'], ['ortho', 'orthogonal']], onChange: (v) => (PUNCH.pattern = v as 'radial' | 'ortho') },
      { kind: 'number', key: 'n', label: 'Elemente', value: PUNCH.n, width: 40, onChange: (v) => (PUNCH.n = Math.max(1, Math.round(v))) },
      { kind: 'text', key: 'd', label: 'Abstände ab Stützenrand', value: PUNCH.dists, width: 90, onChange: (v) => (PUNCH.dists = v) },
      { kind: 'select', key: 'w', label: 'Platte', value: PUNCH.where, options: [['auto', 'automatisch'], ['below', 'unter der Stütze'], ['above', 'über der Stütze']], onChange: (v) => (PUNCH.where = v as any) },
    ];
  }
  move(e: ToolEvent): void {
    this.hover = null;
    for (const h of e.vp.hit(e.raw)) { const el = app.doc.get(h.id); if (el?.cat === 'column') { this.hover = el; break; } }
    e.vp.hover = this.hover?.id ?? null;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const col = this.hover; if (!col) { app.status('Bitte eine Tragwerksstütze wählen.'); return; }
    const el = createPunching(col, this.placement!.proto.typeId);
    if (!el) app.status('Keine Platte unter oder über der Stütze gefunden.');
    else app.status('Durchstanzbewehrung erstellt.');
  }
  preview(dl: DisplayList): void {
    if (!this.hover) return;
    const tmp = { id: '__punch', cat: 'embed', family: 'punching', hostId: this.hover.id, pattern: PUNCH.pattern, n: PUNCH.n, dists: parseDists(PUNCH.dists), levelId: this.hover.levelId, z: 0 } as Embed;
    for (const r of punchRails(app.doc, tmp)) { dl.line(r.a, r.b, PREVIEW); for (const q of r.studs) dl.circle(q, 20, PREVIEW); }
  }
}
export const parseDists = (s: string): number[] => { const a = s.split(/[\s/;,]+/).map((x) => parseFloat(x)).filter((x) => isFinite(x) && x >= 0); return a.length ? a : [90, 145, 145]; };

/** Durchstanzbewehrung um eine Stütze anlegen (eigene Transaktion). Platte: unter dem Stützenfuss oder über dem Stützenkopf. */
export function createPunching(col: El, typeId?: Id, o: Partial<typeof PUNCH> = {}): Embed | null {
  const doc = app.doc; const cb = columnBox(doc, col); if (!cb) return null;
  const where = o.where ?? PUNCH.where;
  const below = where !== 'above' ? slabAt(doc, cb.p, cb.z0, (s) => Math.abs(s.top - cb.z0) < 60) : null;
  const above = where !== 'below' ? slabAt(doc, cb.p, cb.z1, (s) => Math.abs(s.bot - cb.z1) < 60) : null;
  const sl = where === 'above' ? above : where === 'below' ? below : below ?? above;
  if (!sl) return null;
  const t = doc.get<EmbedType>(typeId) ?? typesOfFamily(doc, 'punching')[0];
  const cover = 40;
  let out: Embed | null = null;
  doc.transaction('Durchstanzbewehrung', () => {
    const lvl = col.levelId as Id; const L = levelElev(doc, lvl);
    const tmp = { id: newId('em'), cat: 'embed', family: 'punching', typeId: t?.id, hostId: col.id, levelId: lvl, z: sl.bot + cover - L,
      pattern: o.pattern ?? PUNCH.pattern, n: o.n ?? PUNCH.n, dists: parseDists(o.dists ?? PUNCH.dists) } as Embed;
    // Ankerhöhe aus Plattendicke, falls Typwert nicht passt
    const hs = P(doc, tmp, 'hs');
    if (hs > sl.thick - 2 * cover) tmp.hs = Math.max(50, sl.thick - 2 * cover);
    out = doc.add(tmp);
  });
  return out;
}

// ------------------------------------------------------------ Futterrohr in Wand
export const SLEEVE = { axis: 1500 };
export class SleeveTool extends Tool {
  id = 'embedSleeve'; label = 'Futterrohr'; kinds = ['plan', 'section', 'elevation'];
  private host: Wall | null = null; private u = 0; private zAx = 0;
  activate(): void { ensureEmbedTypes(); this.placement = familyPlacement('sleeve', activeLevelId()); }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'In eine Wand klicken (Grundriss: Achshöhe aus Option; Schnitt/Abwicklung: Klickpunkt = Achse).'; }
  options(): OptionItem[] { return [{ kind: 'length', key: 'ax', label: 'Achshöhe über Ebene', value: SLEEVE.axis, onChange: (v) => (SLEEVE.axis = v) }]; }
  move(e: ToolEvent): void {
    const doc = app.doc; this.host = null;
    if (isPlanLike(e.view)) {
      const z = levelElev(doc, e.view.levelId) + 1000;
      this.host = wallAt(doc, e.raw, z, 300);
      if (this.host) { const F = wallFrame(doc, this.host.id)!; this.u = Math.round(F.uOf(e.p) / 5) * 5; this.zAx = levelElev(doc, this.host.levelId) + SLEEVE.axis; }
    } else if (isSectionLike(e.view)) {
      for (const h of e.vp.hit(e.raw)) { const el = doc.get(h.id); if (el?.cat === 'wall') { this.host = el as Wall; break; } }
      if (this.host) {
        const pr = makeProjector(e.view); const w = pr.toWorld(e.p);
        const F = wallFrame(doc, this.host.id)!; this.u = Math.round(F.uOf(w) / 5) * 5; this.zAx = Math.round(w.z / 5) * 5;
      }
    }
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const w = this.host; if (!w) { app.status('Futterrohre werden in eine Wand gesetzt.'); return; }
    const doc = app.doc; const p = this.placement!.proto;
    doc.transaction('Futterrohr platzieren', () => {
      doc.add<Embed>({ id: newId('em'), cat: 'embed', family: 'sleeve', typeId: p.typeId, hostId: w.id, levelId: w.levelId, t: this.u, z: this.zAx - levelElev(doc, w.levelId) } as Embed);
    });
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.host) return;
    const F = wallFrame(app.doc, this.host.id)!; const t = embedType(app.doc, this.placement!.proto); const r = (t?.dia ?? 150) / 2 + (t?.wt ?? 8);
    if (isPlanLike(vp.view)) dl.poly([F.P(this.u - r, -F.wi.T / 2), F.P(this.u + r, -F.wi.T / 2), F.P(this.u + r, F.wi.T / 2), F.P(this.u - r, F.wi.T / 2)], PREVIEW, true);
    else { const pr = makeProjector(vp.view); dl.circle(pr.toView(F.P3(this.u, 0, this.zAx)), r, PREVIEW); dl.text(add(pr.toView(F.P3(this.u, 0, this.zAx)), { x: r * 1.2, y: r }), 'Achse ' + fmtKote(this.zAx), { size: 2.2, color: '#1e6fd9' }); }
  }
}

export { circleRing, coreSymbol, levels, sideDist, projectT, dist, fromAngle };
