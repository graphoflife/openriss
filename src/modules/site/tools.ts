// Werkzeuge und Dialoge «Grundstück»: Gelände aus Punkten (Klicken, Höhe aus der Optionsleiste), Gelände importieren
// (Text/CSV «x y z» bzw. «E N H» in LV95 → Projekt-Basispunkt, Höhentexte aus CAD-Import), Aushub skizzieren,
// Aushub-Umriss bearbeiten, Volumenübersicht. parsePoints ist DOM-frei (auch für Skripte).
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import type { V2, V3 } from '../../core/geom';
import { apply } from '../../core/geom';
import { projectInfo, levelElev, ProjectInfo } from '../../core/view';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { SketchTool, loopsToSegs } from '../../tools/sketchTool';
import { activeLevelId } from '../../tools/elementTools';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { PREVIEW } from '../../tools/drawTool';
import { fmtM3 } from '../embeds/common';
import { cadXf } from '../output/dxfCommands';
import { fmtHeight } from './topo';
import { excavationVolumes } from './excavation';
import { planRange } from '../../views/viewBuilder';
import { excSite, terrainZ } from './site';

/** gewachsenes Terrain am Punkt bzw. Ersatzhöhe der Grube */
function siteTop(doc: Doc, el: El, p: V2): number { const s = excSite(doc, el); const z = s ? terrainZ(s.sg, p) : NaN; return isFinite(z) ? z : el.top ?? 0; }

// ------------------------------------------------------------ Punkte aus Text
export type CoordMode = 'auto' | 'lv95' | 'm' | 'mm';
export type HeightMode = 'auto' | 'abs' | 'rel';
export interface ParsedPoints { pts: V3[]; basePoint?: { E: number; N: number }; elev00?: number; info: string; skipped: number }
const isE = (v: number) => v > 2.4e6 && v < 2.9e6, isN = (v: number) => v > 1.0e6 && v < 1.35e6;

/**
 * Punkte aus Text lesen: je Zeile «x y z» (Trennzeichen Leerzeichen, Tab, Komma oder Semikolon; optional Punktnummer
 * vorne, Code hinten). LV95 («E N H» in m) wird um den Projekt-Basispunkt verschoben (fehlt er, wird er aus den Daten
 * gesetzt), absolute Höhen (m ü. M.) um den Höhenbezug ±0.00.
 */
export function parsePoints(text: string, doc: Doc, coord: CoordMode = 'auto', heights: HeightMode = 'auto'): ParsedPoints {
  const rows: number[][] = []; let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#') || l.startsWith('//')) continue;
    const toks = l.includes(';') ? l.split(';').map((t) => t.trim().replace(',', '.')) : l.includes('\t') ? l.split('\t') : l.split(/[\s,]+/);
    const nums = toks.map((t) => (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t.trim()) ? parseFloat(t) : NaN));
    const vals = nums.filter((v) => isFinite(v));
    if (vals.length < 3) { skipped++; continue; }
    let i = vals.findIndex((v, k) => k + 2 < vals.length && isE(v) && isN(vals[k + 1]));
    if (i < 0) i = vals.length >= 4 && Number.isInteger(vals[0]) ? 1 : 0;
    if (i + 2 >= vals.length) i = vals.length - 3;
    rows.push([vals[i], vals[i + 1], vals[i + 2]]);
  }
  const pi = projectInfo(doc) as ProjectInfo | undefined;
  let mode = coord;
  if (mode === 'auto') {
    const big = rows.length && rows.every((r) => isE(r[0]) && isN(r[1]));
    const mx = Math.max(0, ...rows.map((r) => Math.max(Math.abs(r[0]), Math.abs(r[1]))));
    mode = big ? 'lv95' : mx < 20000 ? 'm' : 'mm';
  }
  let hm = heights;
  if (hm === 'auto') hm = mode === 'lv95' || (mode === 'm' && rows.length > 0 && rows.every((r) => r[2] > 200)) ? 'abs' : 'rel';
  const out: ParsedPoints = { pts: [], info: '', skipped };
  let bp = pi?.basePoint;
  if (mode === 'lv95' && !bp && rows.length) {
    const E = rows.reduce((s, r) => s + r[0], 0) / rows.length, N = rows.reduce((s, r) => s + r[1], 0) / rows.length;
    bp = { E: Math.round(E), N: Math.round(N) }; out.basePoint = bp;
  }
  let e00 = pi?.elev00;
  if (hm === 'abs' && typeof e00 !== 'number' && rows.length) { e00 = Math.floor(Math.min(...rows.map((r) => r[2]))); out.elev00 = e00; }
  const k = mode === 'mm' ? 1 : 1000;
  for (const [x, y, z] of rows) {
    const X = mode === 'lv95' ? (x - bp!.E) * 1000 : x * k, Y = mode === 'lv95' ? (y - bp!.N) * 1000 : y * k;
    const Z = hm === 'abs' ? (z - (e00 ?? 0)) * 1000 : z * k;
    out.pts.push({ x: Math.round(X * 10) / 10, y: Math.round(Y * 10) / 10, z: Math.round(Z * 10) / 10 });
  }
  out.info = `${out.pts.length} Punkte (${mode === 'lv95' ? 'LV95' : mode === 'm' ? 'lokal, m' : 'lokal, mm'}, Höhen ${hm === 'abs' ? 'm ü. M.' : 'relativ'})` +
    (out.basePoint ? `, Basispunkt E ${out.basePoint.E} / N ${out.basePoint.N} gesetzt` : '') + (out.elev00 !== undefined ? `, ±0.00 = ${out.elev00.toFixed(2)} m ü. M. gesetzt` : '') +
    (skipped ? `, ${skipped} Zeilen übersprungen` : '');
  return out;
}

/** Höhentexte eines CAD-Imports als Punkte (Text = Höhe in m ü. M. bzw. relativ in m) */
export function pointsFromCad(doc: Doc, cad: El): V3[] {
  const m = cadXf(cad as any); const e00 = projectInfo(doc)?.elev00; const out: V3[] = [];
  for (const e of cad.entities ?? []) {
    if (e.t !== 't' || typeof e.s !== 'string') continue;
    const s = e.s.trim().replace(',', '.'); if (!/^[-+]?\d+(\.\d+)?$/.test(s)) continue;
    const v = parseFloat(s); const p = apply(m, { x: e.p[0], y: e.p[1] });
    const z = v > 200 && typeof e00 === 'number' ? (v - e00) * 1000 : v * 1000;
    out.push({ x: p.x, y: p.y, z });
  }
  return out;
}

/** Punkte übernehmen: neues Gelände oder Punkte zu einem bestehenden hinzufügen (in Transaktion) */
export function applyPoints(doc: Doc, r: ParsedPoints | V3[], topoId?: Id | null, name = 'Gelände'): El | null {
  const pts = Array.isArray(r) ? r : r.pts; if (!pts.length) return null;
  if (!Array.isArray(r) && (r.basePoint || r.elev00 !== undefined)) doc.update('project', { ...(r.basePoint ? { basePoint: r.basePoint } : {}), ...(r.elev00 !== undefined ? { elev00: r.elev00 } : {}) } as any);
  const t = topoId ? doc.get(topoId) : null;
  if (t?.cat === 'topo') return doc.update(t.id, { pts: [...(t.pts ?? []), ...pts] }) ?? null;
  return doc.add({ id: newId('tp'), cat: 'topo', name, pts, phase: 'existing' } as El);
}

// ------------------------------------------------------------ Gelände aus Punkten
export const TOPO_OPT = { z: 0 };
export class TopoPointsTool extends Tool {
  id = 'topoPoints'; label = 'Gelände aus Punkten'; kinds = ['plan'];
  pts: V3[] = []; target: Id | null = null;
  activate(): void { const s = app.selected().find((e) => e.cat === 'topo'); this.target = s?.id ?? null; this.pts = []; }
  prompt(): string { return `Punkte klicken (Höhe in der Optionsleiste)${this.target ? ', werden zum gewählten Gelände hinzugefügt' : ''}. Enter oder «Fertig stellen» erzeugt das Gelände; Rücktaste entfernt den letzten Punkt.`; }
  options(): OptionItem[] {
    const doc = app.doc; const e00 = projectInfo(doc)?.elev00;
    return [
      { kind: 'length', key: 'z', label: 'Höhe', value: TOPO_OPT.z, onChange: (v) => { TOPO_OPT.z = v; app.emit('tool'); } },
      { kind: 'label', text: typeof e00 === 'number' ? `= ${fmtHeight(doc, TOPO_OPT.z)} m ü. M.` : '(relativ zu ±0.00)' },
      { kind: 'button', label: 'Fertig stellen', icon: 'check', primary: true, onClick: () => this.finish() },
      { kind: 'button', label: 'Abbrechen', icon: 'cancel', onClick: () => app.setTool(null) },
    ];
  }
  down(e: ToolEvent): void { if (e.button !== 0) return; this.pts.push({ x: e.p.x, y: e.p.y, z: TOPO_OPT.z }); app.redrawOverlay(); app.status(`${this.pts.length} Punkte`); }
  key(e: KeyboardEvent): boolean { if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); app.redrawOverlay(); return true; } return false; }
  enter(): boolean { this.finish(); return true; }
  finish(): void {
    const doc = app.doc; const pts = this.pts;
    if (!this.target && pts.length < 3) { app.status('Mindestens 3 Punkte für ein Gelände.'); return; }
    let id: Id = '';
    doc.transaction('Gelände aus Punkten', () => { id = applyPoints(doc, pts, this.target)?.id ?? ''; });
    this.pts = []; app.setTool(null); if (id) app.select([id]);
  }
  preview(dl: DisplayList): void {
    const s = dl.scale; const h = 0.8 * s;
    for (const p of this.pts) {
      dl.line({ x: p.x - h, y: p.y - h }, { x: p.x + h, y: p.y + h }, PREVIEW); dl.line({ x: p.x - h, y: p.y + h }, { x: p.x + h, y: p.y - h }, PREVIEW);
      dl.text({ x: p.x + 1.2 * s, y: p.y }, fmtHeight(app.doc, p.z), { size: 2, va: 'middle', color: PREVIEW.color });
    }
  }
}

// ------------------------------------------------------------ Aushub
export const EXC_OPT: { bottom: number | null; slope: number; work: number; vertical: boolean } = { bottom: null, slope: 1, work: 0, vertical: false };
export function startExcavation(): void {
  const lvl = activeLevelId();
  if (EXC_OPT.bottom === null) EXC_OPT.bottom = levelElev(app.doc, lvl) - 500;
  const t: SketchTool = new SketchTool('Aushub', (loops) => {
    const doc = app.doc; const pts = loops[0]; let id = '';
    doc.transaction('Aushub erstellen', () => {
      id = doc.add({ id: newId('ex'), cat: 'excavation', pts, bottom: EXC_OPT.bottom ?? 0, slope: EXC_OPT.slope, work: EXC_OPT.work > 0 ? EXC_OPT.work : undefined, levelId: lvl,
        edges: EXC_OPT.vertical ? pts.map(() => ({ vertical: true })) : undefined } as El).id;
    });
    app.select([id]);
    // Hinweis, wenn die Grube ausserhalb des Ansichtsbereichs liegt (Grundriss zeigt sie dann nicht)
    const v = app.activeView(); const el = doc.get(id);
    if (v && el) {
      const r = planRange(doc, v); const top = Math.max(...pts.map((p) => siteTop(doc, el, p)));
      if (top < r.depthZ - 1) app.status('Aushub erstellt – er liegt unter der Ansichtstiefe dieses Grundrisses. Sichtbar in Grundrissen mit tieferem Ansichtsbereich, in Schnitten und 3D.');
    }
  }, {
    kinds: ['plan'], wallRef: 'ext',
    extra: () => [
      { kind: 'length', key: 'bot', label: 'Sohle', value: EXC_OPT.bottom ?? 0, onChange: (v) => (EXC_OPT.bottom = v) },
      { kind: 'number', key: 'n', label: 'Böschung (1:n) n', value: EXC_OPT.slope, width: 40, onChange: (v) => (EXC_OPT.slope = v > 0 ? v : 1) },
      { kind: 'length', key: 'ar', label: 'Arbeitsraum', value: EXC_OPT.work, onChange: (v) => (EXC_OPT.work = Math.max(0, v)) },
      { kind: 'check', key: 'vb', label: 'Verbau (senkrecht)', value: EXC_OPT.vertical, onChange: (v) => (EXC_OPT.vertical = v) },
    ],
  });
  startTool(t, 'excavation');
}
/** Umriss der gewählten Baugrube neu skizzieren */
export function editExcavation(): void {
  const el = app.selected().find((e) => e.cat === 'excavation'); if (!el) { app.status('Bitte eine Baugrube wählen.'); return; }
  const t = new SketchTool('Aushub bearbeiten', (loops) => {
    const pts = loops[0]; const keep = pts.length === el.pts.length;
    app.doc.transaction('Aushub bearbeiten', () => app.doc.update(el.id, { pts, edges: keep ? el.edges : undefined }));
    app.select([el.id]);
  }, { kinds: ['plan'], initial: loopsToSegs([el.pts]) });
  startTool(t, 'excavationEdit');
}

// ------------------------------------------------------------ Dialoge (nur Browser)
export async function importTopoDialog(topoId?: Id | null): Promise<void> {
  const { modal } = await import('../../ui/dialogs'); const { h } = await import('../../ui/shell');
  const doc = app.doc;
  const target = topoId ?? app.selected().find((e) => e.cat === 'topo')?.id ?? null;
  const ta = h('textarea', { rows: 12, style: 'width:100%;font-family:monospace', placeholder: 'x y z  bzw.  Nr E N H  (LV95, m ü. M.)\n2600123.40 1200456.10 452.35\n…' }) as HTMLTextAreaElement;
  const sel = (opts: [string, string][]) => { const s = h('select', {}) as HTMLSelectElement; for (const [v, l] of opts) s.append(h('option', { value: v }, l)); return s; };
  const cm = sel([['auto', 'automatisch'], ['lv95', 'LV95 (E/N in m)'], ['m', 'lokal in m'], ['mm', 'lokal in mm']]);
  const hm = sel([['auto', 'automatisch'], ['abs', 'm ü. M.'], ['rel', 'relativ zu ±0.00']]);
  const file = h('input', { type: 'file', accept: '.txt,.csv,.xyz,.pts,.asc' }) as HTMLInputElement;
  file.onchange = async () => { const f = file.files?.[0]; if (f) ta.value = await f.text(); };
  const info = h('div', { class: 'hint' }, '');
  const cad = app.selected().find((e) => e.cat === 'cadimport');
  const bp = projectInfo(doc)?.basePoint;
  const body = h('div', { style: 'min-width:520px' },
    h('div', { class: 'form-row' }, h('label', {}, 'Datei'), file), ta,
    h('div', { class: 'form-row' }, h('label', {}, 'Koordinaten'), cm), h('div', { class: 'form-row' }, h('label', {}, 'Höhen'), hm),
    h('div', { class: 'hint' }, bp ? `Projekt-Basispunkt LV95: E ${bp.E} / N ${bp.N}` : 'Kein Projekt-Basispunkt: bei LV95-Daten wird er aus dem Mittel der Punkte gesetzt.'), info);
  const run = (fromCad: boolean) => {
    let n = 0; let id = '';
    doc.transaction('Gelände importieren', () => {
      const r = fromCad && cad ? pointsFromCad(doc, cad) : parsePoints(ta.value, doc, cm.value as CoordMode, hm.value as HeightMode);
      n = Array.isArray(r) ? r.length : r.pts.length;
      if (!Array.isArray(r)) info.textContent = r.info;
      id = applyPoints(doc, r, target)?.id ?? '';
    });
    if (!n) { app.status('Keine Punkte gefunden.'); return false; }
    app.status(`${n} Geländepunkte übernommen.`); if (id) app.select([id]); app.refreshViews();
    return true;
  };
  const buttons: { label: string; primary?: boolean; onClick: () => boolean | void }[] = [{ label: target ? 'Punkte hinzufügen' : 'Gelände erzeugen', primary: true, onClick: () => run(false) }];
  if (cad) buttons.push({ label: 'Höhentexte aus CAD-Import', onClick: () => run(true) });
  buttons.push({ label: 'Abbrechen', onClick: () => {} });
  modal('Gelände importieren', body, buttons, 640);
}

export async function excVolumesDialog(): Promise<void> {
  const { modal } = await import('../../ui/dialogs'); const { h } = await import('../../ui/shell');
  const doc = app.doc; const excs = doc.all('excavation');
  const t = h('table', { class: 'grid' });
  t.append(h('tr', {}, ...['Baugrube', 'Aushub', 'Hinterfüllung', 'Bauwerk', 'Sohle', 'Böschung', 'Verbau'].map((x) => h('th', {}, x))));
  let sc = 0, sb = 0;
  const m2 = (v: number) => (v / 1e6).toFixed(1) + ' m²';
  for (const e of excs) {
    const v = excavationVolumes(doc, e); if (!v) continue; sc += v.cut; sb += v.backfill;
    t.append(h('tr', {}, h('td', {}, e.mark || e.comments || e.id), ...[fmtM3(v.cut), fmtM3(v.backfill), fmtM3(v.building), m2(v.bottomArea), m2(v.slopeArea), m2(v.wallArea)].map((x) => h('td', { style: 'text-align:right' }, x))));
  }
  t.append(h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', { style: 'text-align:right' }, h('b', {}, fmtM3(sc))), h('td', { style: 'text-align:right' }, h('b', {}, fmtM3(sb)))));
  modal('Aushub und Hinterfüllung', h('div', { style: 'min-width:560px' }, excs.length ? t : h('div', {}, 'Keine Baugruben im Projekt.'),
    h('div', { class: 'hint' }, 'Aushub: zwischen Gelände und Grubenfläche (Überschneidungen der tiefsten Grube zugeordnet). Hinterfüllung = Aushub − Bauwerk im Aushub.')),
    [{ label: 'Schliessen', primary: true, onClick: () => {} }], 760);
}

export function startTopoPoints(): void { startTool(new TopoPointsTool(), 'topoPoints'); }
export type { V2 };
