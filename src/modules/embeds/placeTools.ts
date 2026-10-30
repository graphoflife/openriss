// Werkzeuge und Dialoge: Arbeitsfuge (Wand senkrecht/waagrecht, Platte), Dämmzone (Skizze), Lichtschacht,
// Legende Dämmzonen, Pressungen laden, Etappenvolumen, Dämmstoff-Kennwerte.
import { app } from '../../app';
import type { El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, mul, sub, eq, centroid } from '../../core/geom';
import { levelElev, isPlanLike, isSectionLike, makeProjector, typesOf } from '../../core/view';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { LineDrawTool, PREVIEW } from '../../tools/drawTool';
import { SketchTool } from '../../tools/sketchTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { wallAt, Wall } from '../../elements/wall';
import { wallFrame, slabAt, zigzag, ensureTemplate, addMissing, fmtM3 } from './common';
import { Joint, JointKind, setJointWaterstop } from './joint';
import { ensureEmbedTypes } from './tools';
import { insulTemplate, addInsulTemplate, addPressureMap, MAT_KEYS, InsulMaterial } from './insulation';
import { lightwellTemplate, createRails, Lightwell } from './lightwell';
import { stageVolumes } from './stages';
import { typesOfFamily } from './embed';

// ------------------------------------------------------------ Arbeitsfuge
export const JOPT = { kind: 'wallV' as JointKind, at: 'base' as 'base' | 'head', stageA: 1, stageB: 2, waterstop: true };
export class JointTool extends LineDrawTool {
  id = 'joint'; label = 'Arbeitsfuge'; kinds = ['plan', 'section', 'elevation'];
  modes: any = ['line'];
  showOffset = false;
  private wall: Wall | null = null; private u = 0; private zc: number | null = null;
  private lastId: Id | null = null;
  activate(): void { ensureEmbedTypes(); }
  supports(v: any): boolean { return JOPT.kind === 'slab' ? isPlanLike(v) : super.supports(v); }
  prompt(): string {
    if (JOPT.kind === 'slab') return 'Fugenverlauf in der Platte zeichnen (von Rand zu Rand). Esc beendet die Fuge.';
    return JOPT.kind === 'wallV' ? 'In eine Wand klicken (Grundriss oder Abwicklung), um eine senkrechte Arbeitsfuge zu setzen.' : 'Wand wählen: waagrechte Arbeitsfuge am Wandfuss/-kopf (im Schnitt: auf Klickhöhe).';
  }
  options(): OptionItem[] {
    const o: OptionItem[] = [
      { kind: 'select', key: 'kind', label: 'Art', value: JOPT.kind, options: [['wallV', 'Wand senkrecht'], ['wallH', 'Wand waagrecht'], ['slab', 'Platte']], onChange: (v) => { JOPT.kind = v as JointKind; this.start = null; this.lastId = null; app.emit('tool'); app.setPrompt(this.prompt()); } },
    ];
    if (JOPT.kind === 'wallH') o.push({ kind: 'select', key: 'at', label: 'Höhe', value: JOPT.at, options: [['base', 'Wandfuss'], ['head', 'Wandkopf']], onChange: (v) => (JOPT.at = v as 'base' | 'head') });
    o.push(
      { kind: 'number', key: 'sa', label: JOPT.kind === 'wallH' ? 'Etappe unten' : 'Etappe links', value: JOPT.stageA, width: 34, onChange: (v) => (JOPT.stageA = Math.max(0, Math.round(v))) },
      { kind: 'number', key: 'sb', label: JOPT.kind === 'wallH' ? 'oben' : 'rechts', value: JOPT.stageB, width: 34, onChange: (v) => (JOPT.stageB = Math.max(0, Math.round(v))) },
      { kind: 'check', key: 'ws', label: 'Fugenblech', value: JOPT.waterstop, onChange: (v) => (JOPT.waterstop = v) },
    );
    if (JOPT.kind === 'slab') o.push(...super.options().filter((x: any) => x.key === 'chain'));
    return o;
  }
  private stages(): Partial<Joint> { return { stageA: JOPT.stageA || undefined, stageB: JOPT.stageB || undefined }; }
  private add(j: Partial<Joint>): Joint {
    const doc = app.doc; const host = doc.get(j.hostId);
    const el = doc.add<Joint>({ id: newId('af'), cat: 'joint', levelId: host?.levelId, ...this.stages(), ...j } as Joint);
    if (JOPT.waterstop) setJointWaterstop(doc, el, true);
    return el;
  }
  move(e: ToolEvent): void {
    if (JOPT.kind === 'slab') { super.move(e); return; }
    const doc = app.doc; this.wall = null; this.zc = null;
    if (isPlanLike(e.view)) {
      this.wall = wallAt(doc, e.raw, levelElev(doc, e.view.levelId) + 1000, 50);
      if (this.wall) this.u = Math.round(wallFrame(doc, this.wall.id)!.uOf(e.p) / 5) * 5;
    } else if (isSectionLike(e.view)) {
      for (const h of e.vp.hit(e.raw)) { const el = doc.get(h.id); if (el?.cat === 'wall') { this.wall = el as Wall; break; } }
      if (this.wall) { const w3 = makeProjector(e.view).toWorld(e.p); this.u = Math.round(wallFrame(doc, this.wall.id)!.uOf(w3) / 5) * 5; this.zc = Math.round(w3.z / 5) * 5; }
    }
  }
  down(e: ToolEvent): void {
    if (JOPT.kind === 'slab') { super.down(e); return; }
    if (e.button !== 0) return;
    const w = this.wall; if (!w) { app.status('Bitte in eine Wand klicken.'); return; }
    const F = wallFrame(app.doc, w.id)!;
    app.doc.transaction('Arbeitsfuge', () => {
      if (JOPT.kind === 'wallV') this.add({ kind: 'wallV', hostId: w.id, t: Math.max(0, Math.min(F.wi.L, this.u)) });
      else if (this.zc !== null && this.zc > F.wi.z0 + 100 && this.zc < F.wi.z1 - 100) this.add({ kind: 'wallH', hostId: w.id, at: 'z', dz: this.zc - F.wi.z0 });
      else this.add({ kind: 'wallH', hostId: w.id, at: this.zc !== null ? (this.zc > (F.wi.z0 + F.wi.z1) / 2 ? 'head' : 'base') : JOPT.at });
    });
  }
  createSegment(a: V2, b: V2): void {
    const doc = app.doc;
    const last = this.lastId ? doc.get<Joint>(this.lastId) : undefined;
    if (last?.pts && eq(last.pts[last.pts.length - 1], a, 0.5)) { doc.update(last.id, { pts: [...last.pts, b] }); return; }
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const sl = slabAt(doc, m, levelElev(doc, activeLevelId()));
    if (!sl) { app.status('Keine Platte unter der Fuge gefunden.'); return; }
    this.lastId = this.add({ kind: 'slab', hostId: sl.el.id, pts: [a, b] }).id;
  }
  escape(): boolean { this.lastId = null; return super.escape(); }
  preview(dl: DisplayList, vp: any): void {
    if (JOPT.kind === 'slab') { super.preview(dl, vp); return; }
    if (!this.wall) return;
    const F = wallFrame(app.doc, this.wall.id)!; const s = vp.view.scale as number;
    if (isPlanLike(vp.view)) {
      if (JOPT.kind === 'wallV') dl.poly(zigzag(F.P(this.u, -F.wi.T / 2), F.P(this.u, F.wi.T / 2), 0.9 * s), PREVIEW);
      else dl.line(F.P(0, 0), F.P(F.wi.L, 0), { ...PREVIEW, dash: 'dash' });
    } else {
      const pr = makeProjector(vp.view);
      if (JOPT.kind === 'wallV') dl.line(pr.toView(F.P3(this.u, 0, F.wi.z0)), pr.toView(F.P3(this.u, 0, F.wi.z1)), PREVIEW);
      else if (this.zc !== null) dl.line(pr.toView(F.P3(0, 0, this.zc)), pr.toView(F.P3(F.wi.L, 0, this.zc)), { ...PREVIEW, dash: 'dash' });
    }
  }
}

// ------------------------------------------------------------ Dämmzone
export function ensureInsulTypes(): void {
  const doc = app.doc;
  if (typesOf(doc, 'insulZone').length) return;
  doc.transaction('Dämmzonen-Typen ergänzen', () => addInsulTemplate(doc));
}
export function startInsulZone(): void {
  ensureInsulTypes();
  const lvl = activeLevelId();
  const t: SketchTool = new SketchTool('Dämmzone', (loops) => {
    const doc = app.doc; const p = t.placement?.proto ?? ({} as El); const { id: _i, ...rest } = p;
    const c = centroid(loops[0]);
    // Host: Platte über der Zone (tiefste Unterkante am Ort)
    const sl = slabAt(doc, c, -1e9, (s) => s.el.cat === 'foundationSlab' || s.el.cat === 'floor');
    let id = '';
    doc.transaction('Dämmzone erstellen', () => {
      id = doc.add({ ...rest, id: newId('dz'), cat: 'insulZone', loops, levelId: p.levelId || lvl, offset: p.offset ?? 0, hostId: p.autoHost !== false && sl ? sl.el.id : undefined } as El).id;
    });
    app.select([id]);
  }, { kinds: ['plan'], wallRef: 'ext' });
  t.placement = placementFor('insulZone', { levelId: lvl, offset: 0 });
  t.placement.proto.levelId = lvl;
  t.deactivate = () => rememberProto(t.placement);
  startTool(t, 'insulZone');
}

// ------------------------------------------------------------ Lichtschacht
export const LWO = { zTop: 2500 };
export class LightwellTool extends Tool {
  id = 'lightwell'; label = 'Lichtschacht'; kinds = ['plan'];
  private wall: Wall | null = null; private u = 0; private flip = false;
  activate(): void {
    ensureEmbedTypes();
    ensureTemplate(app.doc, 'lightwell', () => lightwellTemplate());
    this.placement = placementFor('lightwell', { levelId: activeLevelId(), zTop: LWO.zTop });
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return 'An eine Wand klicken (Seite = Cursorseite), um den Lichtschacht zu platzieren.'; }
  options(): OptionItem[] { return [{ kind: 'length', key: 'zt', label: 'Oberkante über Ebene', value: LWO.zTop, onChange: (v) => (LWO.zTop = v) }]; }
  move(e: ToolEvent): void {
    const doc = app.doc; this.wall = wallAt(doc, e.raw, levelElev(doc, e.view.levelId) + 1000, 1500);
    if (!this.wall) return;
    const F = wallFrame(doc, this.wall.id)!; this.u = Math.round(F.uOf(e.p) / 10) * 10;
    this.flip = Math.sign(F.vOf(e.raw)) !== F.wi.ext;
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const w = this.wall; if (!w) { app.status('Lichtschächte werden an eine Wand gesetzt.'); return; }
    const doc = app.doc; const p = this.placement!.proto;
    doc.transaction('Lichtschacht platzieren', () => {
      const lw = doc.add<Lightwell>({ id: newId('ls'), cat: 'lightwell', typeId: p.typeId, hostId: w.id, levelId: w.levelId, t: this.u, zTop: LWO.zTop, flip: this.flip } as Lightwell);
      createRails(doc, lw, typesOfFamily(doc, 'anchorChannel')[0]?.id);
    });
  }
  preview(dl: DisplayList): void {
    if (!this.wall) return;
    const doc = app.doc; const F = wallFrame(doc, this.wall.id)!; const t = doc.get<any>(this.placement!.proto.typeId);
    const W = (t?.W ?? 1500) / 2, D = t?.D ?? 1000; const s = (this.flip ? -1 : 1) * F.wi.ext; const f = s * F.wi.T / 2;
    dl.poly([F.P(this.u - W, f), F.P(this.u - W, f + s * D), F.P(this.u + W, f + s * D), F.P(this.u + W, f)], PREVIEW);
  }
}

// ------------------------------------------------------------ Legende
export class LegendTool extends Tool {
  id = 'insulLegend'; label = 'Legende Dämmzonen'; kinds = ['plan', 'ceiling', 'section', 'elevation', 'drafting', 'legend'];
  prompt(): string { return 'Klicken Sie, um die Legende der Dämmzonen zu platzieren (linke obere Ecke).'; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    const v = e.view;
    app.doc.transaction('Legende Dämmzonen', () => app.doc.add({ id: newId('lg'), cat: 'insulLegend', viewId: v.id, p: e.p } as El));
    app.setTool(null);
  }
}

// ------------------------------------------------------------ Dialoge (nur zur Laufzeit im Browser)
export function importPressure(): void {
  const v = app.activeView(); const lvl = v?.levelId ?? activeLevelId();
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,.txt,.json';
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return;
    try {
      const txt = await f.text(); let n = 0;
      app.doc.transaction('Pressungen laden', () => { const el = addPressureMap(app.doc, txt, lvl, f.name.replace(/\.[^.]+$/, '')); n = (el.pts?.length ?? 0) + (el.grid ? el.grid.nx * el.grid.ny : 0); });
      app.status(`${n} Pressungswerte geladen.`);
    } catch (err: any) { app.status('Datei nicht lesbar: ' + (err?.message ?? err)); }
  };
  inp.click();
}

export async function stageVolumesDialog(): Promise<void> {
  const { modal } = await import('../../ui/dialogs'); const { h } = await import('../../ui/shell');
  const m = stageVolumes(app.doc);
  const t = h('table', { class: 'grid' });
  t.append(h('tr', {}, h('th', {}, 'Etappe'), h('th', {}, 'Betonvolumen')));
  let sum = 0;
  for (const [s, vol] of m) { sum += vol; t.append(h('tr', {}, h('td', {}, String(s)), h('td', { style: 'text-align:right' }, fmtM3(vol)))); }
  t.append(h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', { style: 'text-align:right' }, h('b', {}, fmtM3(sum)))));
  const body = h('div', { style: 'min-width:320px' }, m.size ? t : h('div', {}, 'Keine Etappen definiert (Eigenschaft «Etappe» bzw. Etappen der Arbeitsfugen).'));
  modal('Volumen je Etappe', body, [{ label: 'Schliessen', primary: true, onClick: () => {} }]);
}

export async function insulMaterialsDialog(): Promise<void> {
  const { modal } = await import('../../ui/dialogs'); const { h } = await import('../../ui/shell');
  const doc = app.doc;
  if (!doc.all('material').some((m) => (m as InsulMaterial).sigmaC !== undefined)) doc.transaction('Dämmstoffe ergänzen', () => addMissing(doc, insulTemplate().filter((e) => e.cat === 'material')));
  const mats = doc.all<InsulMaterial>('material').filter((m) => m.cutPattern === 'insulation' || m.sigmaC !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const t = h('table', { class: 'grid' });
  t.append(h('tr', {}, h('th', {}, 'Material'), ...MAT_KEYS.map(([, l]) => h('th', {}, l))));
  for (const m of mats) {
    const cells = MAT_KEYS.map(([k]) => {
      const inp = h('input', { type: 'text', value: m[k] !== undefined ? String(m[k]) : '', style: 'width:70px' }) as HTMLInputElement;
      inp.onchange = () => { const v = parseFloat(inp.value.replace(',', '.')); doc.transaction('Kennwert ändern', () => doc.update(m.id, { [k]: isFinite(v) && v > 0 ? v : undefined })); };
      return h('td', {}, inp);
    });
    t.append(h('tr', {}, h('td', {}, m.name), ...cells));
  }
  modal('Dämmstoff-Kennwerte (druckfeste Dämmung)', h('div', {}, t, h('div', { class: 'hint' }, 'σ10: Druckspannung bei 10 % Stauchung (EN 826); σc: Dauerdruckspannung bei ≤ 2 % Kriechstauchung nach 50 Jahren (EN 1606); f_cd: Bemessungswert der Druckfestigkeit.')),
    [{ label: 'Schliessen', primary: true, onClick: () => { app.refreshViews(); } }], 760);
}
export { add, mul, sub };
