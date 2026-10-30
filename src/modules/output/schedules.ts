// Bauteillisten/Mengen: Definition (Felder, Filter, Sortieren/Gruppieren, Formatierung), Tabellenansicht
// mit bearbeitbaren Zellen, Tabelle als Display-Liste (für Pläne/Druck) und CSV-Export.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCommand, registerViewport, registerDLBuilder, ViewportLike, catDef, allCats, PropDef, GROUPS, scheduleKind } from '../../core/registry';
import { View, levelOptions, materialOptions } from '../../core/view';
import { fmtLen, fmtArea, fmtVolume, fmtNum, parseLen, parseNum, parseAngle, unitSettings } from '../../core/units';
import { DisplayList, textWidth } from '../../render/displayList';
import { boxCorners, V2 } from '../../core/geom';
import { buildViewDL } from '../../views/viewBuilder';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { injectCss, extendViewProps, fileBase } from './common';

// ------------------------------------------------------------ Definition
export type FilterOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'has' | 'nhas';
export interface SchedFilter { key: string; op: FilterOp; value: string }
export interface SchedSort { key: string; desc?: boolean }
export interface SchedDef {
  cat: string;
  fields: string[];
  sort: SchedSort[];
  /** Kopf-/Fußzeile/Leerzeile je Gruppe der ersten Sortierebene */
  header?: boolean; footer?: boolean; blank?: boolean;
  /** Gesamtsummen */
  totals: boolean;
  /** Jedes Exemplar einzeln aufführen */
  itemize: boolean;
  filters: SchedFilter[];
  /** Felder mit Summenbildung */
  sums: string[];
  /** eigene Spaltenüberschriften */
  labels?: Record<string, string>;
}
export const FILTER_OPS: [FilterOp, string][] = [['eq', 'gleich'], ['ne', 'ungleich'], ['gt', 'größer als'], ['ge', 'größer als oder gleich'], ['lt', 'kleiner als'], ['le', 'kleiner als oder gleich'], ['has', 'enthält'], ['nhas', 'enthält nicht']];

type Unit = 'len' | 'area' | 'vol' | 'kg' | 'num' | 'count';
export interface SchedField {
  key: string; label: string; unit?: Unit;
  get(el: El, doc: Doc): any;
  /** bearbeitbar über Exemplar- (onType=false) oder Typparameter */
  edit?: { prop: PropDef; onType: boolean };
}

const NO_SCHEDULE = new Set(['view', 'type', 'material', 'project', 'level', 'grid', 'refplane', 'line', 'viewport', 'cadimport', 'image', 'callout']);
/** Kategorien, für die Bauteillisten erstellt werden können */
export function scheduleCats(): { cat: string; label: string }[] {
  return allCats()
    .filter((d) => !d.annotation && !d.datum && !NO_SCHEDULE.has(d.cat) && (d.scheduleFields || d.solids || d.drawPlan || d.drawPlanBatch || d.hasTypes))
    .map((d) => ({ cat: d.cat, label: d.plural }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

function optionsOf(p: PropDef, doc: Doc): [string, string][] {
  if (p.type === 'level') return levelOptions(doc);
  if (p.type === 'material') return [['', '<Nach Kategorie>'], ...materialOptions(doc)];
  return typeof p.options === 'function' ? p.options(doc) : p.options ?? [];
}
/** Anzeigewert eines Parameters (Auswahl → Beschriftung, Ebene/Material → Name) */
function propValue(p: PropDef, el: El, doc: Doc): any {
  let v: any;
  try { v = p.get(el, doc); } catch { return ''; }
  switch (p.type) {
    case 'select': case 'level': case 'material': { const o = optionsOf(p, doc).find(([k]) => String(k) === String(v ?? '')); return o ? o[1] : v ?? ''; }
    case 'angle': return typeof v === 'number' ? fmtNum((v * 180) / Math.PI, 2) + '°' : v;
    case 'bool': return !!v;
    default: return v;
  }
}
const propUnit = (p: PropDef): Unit | undefined => (p.type === 'length' ? 'len' : p.type === 'area' ? 'area' : p.type === 'number' || p.type === 'int' ? 'num' : undefined);
const fieldable = (p: PropDef) => p.type !== 'button' && p.type !== 'color';
const writable = (p: PropDef) => !!p.set && p.type !== 'readonly' && p.type !== 'area' && p.type !== 'button';
function safeProps(fn: () => PropDef[] | undefined): PropDef[] { try { return fn() ?? []; } catch { return []; } }

/** Alle Felder einer Kategorie (Zusatzfelder, allgemeine Felder, Exemplar- und Typparameter) */
export function fieldsFor(doc: Doc, cat: string): SchedField[] {
  const def = catDef(cat);
  const out = new Map<string, SchedField>();
  const labels = new Set<string>();
  const add = (f: SchedField) => { if (out.has(f.key) || labels.has(f.label)) return; out.set(f.key, f); labels.add(f.label); };
  for (const f of def?.scheduleFields?.() ?? []) add({ key: f.key, label: f.label, unit: f.unit, get: f.get });
  if (def?.hasTypes) add({ key: 'type', label: 'Typ', get: (el, d) => d.get(el.typeId)?.name ?? '' });
  add({ key: 'count', label: 'Anzahl', unit: 'count', get: () => 1 });
  add({ key: 'mark', label: 'Kennzeichen', get: (el) => el.mark ?? '' });
  add({ key: 'comments', label: 'Kommentare', get: (el) => el.comments ?? '' });
  const sample = doc.all(cat)[0];
  const inst = sample && def?.props ? safeProps(() => def.props!(sample, doc)) : [];
  if (!sample || !def?.props || !inst.some((p) => p.key === 'level' || p.key === 'levelId')) add({ key: 'level', label: 'Ebene', get: (el, d) => d.get(el.levelId)?.name ?? '' });
  for (const p of inst) if (fieldable(p)) add({ key: p.key, label: p.label, unit: propUnit(p), get: (el, d) => propValue(p, el, d) });
  const type = sample ? doc.get(sample.typeId) : undefined;
  const tprops = type && def?.typeProps ? safeProps(() => def.typeProps!(type, doc)) : [];
  for (const p of tprops) {
    if (!fieldable(p)) continue;
    // gleichnamiges Feld (z.B. Breite einer Tür) → über den Typparameter bearbeitbar machen statt doppelt aufführen
    const same = [...out.values()].find((f) => f.label === p.label || f.key === p.key);
    if (same) { if (writable(p) && !inst.some((x) => x.key === same.key && writable(x))) same.edit = { prop: p, onType: true }; continue; }
    add({ key: 't.' + p.key, label: p.label, unit: propUnit(p), get: (el, d) => { const t = d.get(el.typeId); return t ? propValue(p, t, d) : ''; } });
  }
  // Bearbeitbarkeit: passender beschreibbarer Parameter
  for (const f of out.values()) {
    if (f.edit) continue;
    if (f.key.startsWith('t.')) { const p = tprops.find((x) => 't.' + x.key === f.key); if (p && writable(p)) f.edit = { prop: p, onType: true }; continue; }
    const p = inst.find((x) => x.key === f.key);
    if (p && writable(p)) f.edit = { prop: p, onType: false };
    else if (f.key === 'mark' || f.key === 'comments') {
      const k = f.key;
      f.edit = { prop: { key: k, label: f.label, group: '', type: 'text', get: (e) => e[k] ?? '', set: (_e, v) => ({ [k]: v }) }, onType: false };
    }
  }
  return [...out.values()];
}

export function defaultDef(doc: Doc, cat: string): SchedDef {
  const fs = fieldsFor(doc, cat);
  const extra = (catDef(cat)?.scheduleFields?.() ?? []).map((f) => f.key).filter((k) => k !== 'type').slice(0, 4);
  let fields = [...(fs.some((f) => f.key === 'type') ? ['type'] : []), ...(cat === 'door' || cat === 'window' ? ['mark'] : []), ...extra, 'count'];
  fields = fields.filter((k, i) => fs.some((f) => f.key === k) && fields.indexOf(k) === i);
  if (fields.length < 2) fields = fs.slice(0, 5).map((f) => f.key);
  const sums = fs.filter((f) => f.unit === 'count' || f.unit === 'area' || f.unit === 'vol' || f.unit === 'kg' || (f.key === 'length' && f.unit === 'len')).map((f) => f.key);
  return { cat, fields, sort: fs.some((f) => f.key === 'type') ? [{ key: 'type' }] : [], totals: true, itemize: true, filters: [], sums };
}
export const schedDef = (v: View): SchedDef => ({ fields: [], sort: [], totals: true, itemize: true, filters: [], sums: [], ...(v.data ?? {}) } as SchedDef);

// ------------------------------------------------------------ Formatierung
export function fmtField(f: SchedField | undefined, v: any): string {
  if (v === undefined || v === null || v === '') return '';
  if (isSketch(v)) return v.text;
  if (typeof v === 'boolean') return v ? 'Ja' : 'Nein';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    switch (f?.unit) {
      case 'len': return fmtLen(v);
      case 'area': return fmtArea(v);
      case 'vol': return fmtVolume(v);
      case 'kg': return fmtNum(v, 1) + ' kg';
      case 'count': return String(Math.round(v));
      default: return fmtNum(v, Number.isInteger(v) ? 0 : 2);
    }
  }
  return String(v);
}
/** Zahl ohne Einheit (CSV) */
function csvNum(f: SchedField, v: number): string {
  switch (f.unit) {
    case 'len': return fmtLen(v);
    case 'area': return fmtNum(v / 1e6, unitSettings.areaDecimals);
    case 'vol': return fmtNum(v / 1e9, 3);
    case 'kg': return fmtNum(v, 1);
    case 'count': return String(Math.round(v));
    default: return fmtNum(v, Number.isInteger(v) ? 0 : 3);
  }
}
const unitSuffix = (f: SchedField) => (f.unit === 'len' ? ` (${unitSettings.length})` : f.unit === 'area' ? ' (m²)' : f.unit === 'vol' ? ' (m³)' : f.unit === 'kg' ? ' (kg)' : '');
const isNumField = (f: SchedField) => !!f.unit;

/** Zellwert mit Skizze (z. B. Biegeform): Text für Tabelle/CSV, Polylinie (beliebige Einheit) mit Beschriftung je Segment für Pläne */
export interface SketchCell { text: string; sketch: { pts: V2[]; labels?: (string | null)[] } }
export const isSketch = (v: any): v is SketchCell => !!v && typeof v === 'object' && typeof v.text === 'string' && !!v.sketch;
function cmp(a: any, b: any): number {
  if (isSketch(a)) a = a.text; if (isSketch(b)) b = b.text;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), 'de', { numeric: true });
}
function safeGet(f: SchedField, el: El, doc: Doc): any { try { return f.get(el, doc); } catch { return ''; } }

function passes(f: SchedField | undefined, flt: SchedFilter, el: El, doc: Doc): boolean {
  if (!f || !flt.key) return true;
  const v = safeGet(f, el, doc);
  if (typeof v === 'number' && flt.op !== 'has' && flt.op !== 'nhas') {
    const x = f.unit === 'len' ? parseLen(flt.value) : f.unit === 'area' ? (parseNum(flt.value) ?? NaN) * 1e6 : f.unit === 'vol' ? (parseNum(flt.value) ?? NaN) * 1e9 : parseNum(flt.value);
    if (x !== null && !isNaN(x)) {
      const eps = Math.max(1e-6, Math.abs(x) * 1e-9, f.unit === 'len' ? 0.5 : 0);
      switch (flt.op) {
        case 'eq': return Math.abs(v - x) <= eps;
        case 'ne': return Math.abs(v - x) > eps;
        case 'gt': return v > x + eps;
        case 'ge': return v >= x - eps;
        case 'lt': return v < x - eps;
        case 'le': return v <= x + eps;
      }
    }
  }
  const s = fmtField(f, v).toLowerCase(), t = flt.value.trim().toLowerCase();
  const c = s.localeCompare(t, 'de', { numeric: true });
  switch (flt.op) {
    case 'eq': return s === t;
    case 'ne': return s !== t;
    case 'has': return s.includes(t);
    case 'nhas': return !s.includes(t);
    case 'gt': return c > 0;
    case 'ge': return c >= 0;
    case 'lt': return c < 0;
    case 'le': return c <= 0;
  }
  return true;
}

// ------------------------------------------------------------ Tabelle berechnen
export interface TRow { kind: 'data' | 'group' | 'footer' | 'total' | 'blank'; cells: any[]; text: string[]; ids: Id[] }
export interface Table { title: string; fields: SchedField[]; heads: string[]; rows: TRow[]; count: number }

export function buildTable(doc: Doc, view: View): Table {
  const d = schedDef(view);
  const all = fieldsFor(doc, d.cat);
  const byKey = new Map(all.map((f) => [f.key, f]));
  const shown = d.fields.map((k) => byKey.get(k)).filter((f): f is SchedField => !!f);
  const sums = new Set(d.sums ?? []);
  const els = doc.all(d.cat).filter((el) => (d.filters ?? []).every((flt) => passes(byKey.get(flt.key), flt, el, doc)));
  const sorts = (d.sort ?? []).map((s) => ({ f: byKey.get(s.key), desc: !!s.desc })).filter((s): s is { f: SchedField; desc: boolean } => !!s.f);
  const keyVals = new Map<Id, any[]>();
  for (const el of els) keyVals.set(el.id, sorts.map((s) => safeGet(s.f, el, doc)));
  els.sort((a, b) => {
    const ka = keyVals.get(a.id)!, kb = keyVals.get(b.id)!;
    for (let i = 0; i < sorts.length; i++) { const c = cmp(ka[i], kb[i]); if (c) return sorts[i].desc ? -c : c; }
    return cmp(a.mark ?? '', b.mark ?? '') || cmp(a.id, b.id);
  });
  const rows: TRow[] = [];
  const text = (cells: any[]) => cells.map((v, i) => fmtField(shown[i], v));
  const labelCol = shown.findIndex((f) => f.unit !== 'count' && !sums.has(f.key));
  const sumCells = (group: El[], label: string): any[] => shown.map((f, i) => {
    if (f.unit === 'count') return group.length;
    if (sums.has(f.key)) { let s = 0; let any = false; for (const el of group) { const v = safeGet(f, el, doc); if (typeof v === 'number' && isFinite(v)) { s += v; any = true; } } return any ? s : ''; }
    return i === labelCol ? label : '';
  });
  const rowOf = (group: El[]): TRow => {
    const cells = shown.map((f) => {
      if (f.unit === 'count') return group.length;
      const vals = group.map((el) => safeGet(f, el, doc));
      if (group.length === 1) return vals[0];
      if (sums.has(f.key) && vals.every((v) => typeof v === 'number')) return vals.reduce((s: number, v: number) => s + v, 0);
      return vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] : '';
    });
    return { kind: 'data', cells, text: text(cells), ids: group.map((e) => e.id) };
  };
  const emitRows = (list: El[]) => {
    if (d.itemize) { for (const el of list) rows.push(rowOf([el])); return; }
    // gleiche Sortierwerte zusammenfassen
    let cur: El[] = [];
    const same = (a: El, b: El) => { const ka = keyVals.get(a.id)!, kb = keyVals.get(b.id)!; return ka.every((v, i) => JSON.stringify(v) === JSON.stringify(kb[i])); };
    for (const el of list) { if (cur.length && !same(cur[0], el)) { rows.push(rowOf(cur)); cur = []; } cur.push(el); }
    if (cur.length) rows.push(rowOf(cur));
  };
  const grouped = sorts.length > 0 && (d.header || d.footer || d.blank);
  if (grouped) {
    let i = 0;
    while (i < els.length) {
      const v0 = keyVals.get(els[i].id)![0];
      let j = i; while (j < els.length && JSON.stringify(keyVals.get(els[j].id)![0]) === JSON.stringify(v0)) j++;
      const g = els.slice(i, j); const gl = fmtField(sorts[0].f, v0) || '(ohne)';
      if (d.header) rows.push({ kind: 'group', cells: [gl], text: [gl], ids: g.map((e) => e.id) });
      emitRows(g);
      if (d.footer) { const c = sumCells(g, `${gl}: ${g.length}`); rows.push({ kind: 'footer', cells: c, text: text(c), ids: g.map((e) => e.id) }); }
      if (d.blank && j < els.length) rows.push({ kind: 'blank', cells: [], text: [], ids: [] });
      i = j;
    }
  } else emitRows(els);
  if (d.totals && els.length) { const c = sumCells(els, `Gesamtsumme: ${els.length}`); rows.push({ kind: 'total', cells: c, text: text(c), ids: [] }); }
  const heads = shown.map((f) => d.labels?.[f.key] || f.label);
  return { title: view.name, fields: shown, heads, rows, count: els.length };
}

// ------------------------------------------------------------ Tabelle als Display-Liste (Plan, Druck, SVG)
/** Skizze in ein Rechteck (Papier-mm) einpassen; flache Formen mindestens 3 mm hoch, Beschriftung außen an den Segmenten */
function drawSketch(dl: DisplayList, sk: SketchCell['sketch'], x0: number, y0: number, x1: number, y1: number): void {
  const P = sk.pts; if (P.length < 2) return;
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const p of P) { bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y); }
  const W = x1 - x0 - 10, H = y1 - y0 - 7, w = bx1 - bx0, hh = by1 - by0;
  const k = Math.min(w > 1e-6 ? W / w : Infinity, hh > 1e-6 ? H / hh : Infinity);
  const kx = isFinite(k) ? (w * k < 3 && w > 1e-6 ? 3 / w : k) : 0, ky = isFinite(k) ? (hh * k < 3 && hh > 1e-6 ? 3 / hh : k) : 0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, mx = (bx0 + bx1) / 2, my = (by0 + by1) / 2;
  const Q = P.map((p) => ({ x: cx + (p.x - mx) * kx, y: cy + (p.y - my) * ky }));
  dl.poly(Q, { w: 3 }, false, { ns: true });
  const c = Q.reduce((s, q) => ({ x: s.x + q.x / Q.length, y: s.y + q.y / Q.length }), { x: 0, y: 0 });
  for (let i = 0; i + 1 < Q.length; i++) {
    const s = sk.labels?.[i]; if (!s) continue;
    const a = Q[i], b = Q[i + 1]; const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    if (Q.length === 2) { nx = 0; ny = 1; } else if ((m.x - c.x) * nx + (m.y - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    dl.text({ x: m.x + nx * 1.6, y: m.y + ny * 1.6 }, s, { size: 1.8, ha: Math.abs(nx) > 0.7 ? (nx > 0 ? 'left' : 'right') : 'center', va: Math.abs(ny) > 0.7 ? (ny > 0 ? 'bottom' : 'top') : 'middle' });
  }
}

registerDLBuilder('schedule', (doc, view) => {
  const sk = scheduleKind(view);
  if (sk) return sk.dl(doc, view);
  const t = buildTable(doc, view);
  const dl = new DisplayList(1);
  const fs = 2.5, pad = 1.5, rh0 = 6, hh = 7, th = 9, rhS = 15;
  const n = t.fields.length;
  if (!n) { dl.text({ x: 0, y: 0 }, view.name + ' (keine Felder)', { size: 3.5, bold: true }); return dl; }
  const sketchCol = t.fields.map((_f, i) => t.rows.some((r) => isSketch(r.cells[i])));
  const cw = t.fields.map((_f, i) => Math.max(sketchCol[i] ? 50 : 14, textWidth(t.heads[i], fs * 1.08) + 2 * pad,
    ...t.rows.filter((r) => (r.kind === 'data' && !sketchCol[i]) || r.kind === 'footer' || r.kind === 'total').map((r) => textWidth(r.text[i] ?? '', fs * (r.kind === 'data' ? 1 : 1.08)) + 2 * pad)));
  const W = cw.reduce((s, x) => s + x, 0);
  const xs: number[] = [0]; for (const w of cw) xs.push(xs[xs.length - 1] + w);
  const thin = { w: 1 }, bold = { w: 3 };
  let y = 0;
  dl.text({ x: W / 2, y: -th / 2 }, t.title, { size: 3.5, bold: true, ha: 'center', va: 'middle' });
  y -= th;
  const top = y;
  // Kopfzeile
  for (let i = 0; i < n; i++) dl.text({ x: (xs[i] + xs[i + 1]) / 2, y: y - hh / 2 }, t.heads[i], { size: fs, bold: true, ha: 'center', va: 'middle' });
  y -= hh;
  dl.line({ x: 0, y }, { x: W, y }, bold);
  for (const r of t.rows) {
    const rh = r.kind === 'data' && r.cells.some(isSketch) ? rhS : rh0;
    const yc = y - rh / 2;
    if (r.kind === 'group') dl.text({ x: pad, y: yc }, r.text[0] ?? '', { size: fs, bold: true, va: 'middle' });
    else if (r.kind !== 'blank') {
      for (let i = 0; i < n; i++) {
        const cv = r.cells[i];
        if (isSketch(cv)) {
          dl.text({ x: xs[i] + 1, y: y - 0.8 }, cv.text.split(':')[0], { size: 1.6, va: 'top', color: '#606060' });
          drawSketch(dl, cv.sketch, xs[i] + pad, y - rh, xs[i + 1] - pad, y - 2);
          continue;
        }
        const s = r.text[i] ?? ''; if (!s) continue;
        const num = typeof r.cells[i] === 'number';
        const label = r.kind !== 'data' && !num;
        dl.text({ x: num ? xs[i + 1] - pad : xs[i] + pad, y: yc }, s, { size: fs, va: 'middle', ha: num ? 'right' : 'left', bold: r.kind === 'total', italic: r.kind === 'footer' && label });
      }
      for (let i = 1; i < n; i++) dl.line({ x: xs[i], y }, { x: xs[i], y: y - rh }, thin, { ns: true });
    }
    y -= rh;
    dl.line({ x: 0, y }, { x: W, y }, r.kind === 'total' || r.kind === 'footer' ? { w: 2 } : thin, { ns: true });
  }
  for (let i = 1; i < n; i++) dl.line({ x: xs[i], y: top }, { x: xs[i], y: top - hh }, thin, { ns: true });
  dl.poly(boxCorners({ min: { x: 0, y }, max: { x: W, y: top } }), bold, true);
  dl.poly(boxCorners({ min: { x: 0, y }, max: { x: W, y: 0 } }), bold, true);
  return dl;
});

// ------------------------------------------------------------ CSV-Export
export function scheduleCsv(doc: Doc, view: View): string {
  const sk = scheduleKind(view);
  if (sk) return '\ufeff' + (sk.csv?.(doc, view) ?? '');
  const t = buildTable(doc, view);
  const q = (s: string) => (/[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines: string[] = [];
  lines.push(t.heads.map((hd, i) => q(hd + unitSuffix(t.fields[i]))).join(';'));
  for (const r of t.rows) {
    if (r.kind === 'blank') { lines.push(''); continue; }
    lines.push(t.fields.map((f, i) => { const v = r.cells[i]; return q(typeof v === 'number' ? csvNum(f, v) : fmtField(f, v)); }).join(';'));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
registerCommand({
  id: 'exportCsv', label: 'Bauteilliste (CSV)', icon: 'csv', tip: 'Aktive Bauteilliste als CSV exportieren (Semikolon, UTF-8 – für Excel)',
  enabled: () => app.activeView()?.kind === 'schedule',
  run: () => {
    const v = app.activeView();
    if (!v || v.kind !== 'schedule') { app.status('Bitte zuerst eine Bauteilliste öffnen.'); return; }
    download(fileBase(v) + '.csv', scheduleCsv(app.doc, v), 'text/csv;charset=utf-8');
  },
});

// ------------------------------------------------------------ Dialog „Eigenschaften der Bauteilliste“
type Tab = 'fields' | 'filter' | 'sort' | 'format';
export function scheduleDialog(init: SchedDef, title: string, onOk: (d: SchedDef) => void, tab: Tab = 'fields'): void {
  const doc = app.doc;
  const d: SchedDef = JSON.parse(JSON.stringify(init));
  d.filters ??= []; d.sort ??= []; d.sums ??= []; d.labels ??= {};
  const fields = fieldsFor(doc, d.cat);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  d.fields = d.fields.filter((k) => byKey.has(k));
  const body = h('div', { class: 'sched-dlg' });
  const tabs = h('div', { class: 'sched-tabs' });
  const pane = h('div', { class: 'sched-pane' });
  body.append(h('div', { class: 'hint' }, `Kategorie: ${catDef(d.cat)?.plural ?? d.cat}`), tabs, pane);
  let cur: Tab = tab;
  const fieldSel = (value: string, withNone = true): HTMLSelectElement => {
    const s = h('select', {}) as HTMLSelectElement;
    if (withNone) s.append(h('option', { value: '' }, '(keine)'));
    for (const f of fields) s.append(h('option', { value: f.key }, f.label));
    s.value = value; return s;
  };
  const render = () => {
    tabs.innerHTML = '';
    for (const [k, l] of [['fields', 'Felder'], ['filter', 'Filter'], ['sort', 'Sortieren/Gruppieren'], ['format', 'Formatierung']] as [Tab, string][]) {
      const b = h('button', { class: 'btn small' + (cur === k ? ' primary' : '') }, l);
      b.onclick = () => { cur = k; render(); };
      tabs.append(b);
    }
    pane.innerHTML = '';
    if (cur === 'fields') {
      const avail = h('select', { multiple: true, size: '14' }) as HTMLSelectElement;
      for (const f of fields) if (!d.fields.includes(f.key)) avail.append(h('option', { value: f.key }, f.label));
      const sel = h('select', { multiple: true, size: '14' }) as HTMLSelectElement;
      for (const k of d.fields) sel.append(h('option', { value: k }, byKey.get(k)!.label));
      const picked = (s: HTMLSelectElement) => [...s.selectedOptions].map((o) => o.value);
      const addF = () => { d.fields.push(...picked(avail)); render(); };
      const remF = () => { const p = picked(sel); d.fields = d.fields.filter((k) => !p.includes(k)); render(); };
      const moveF = (dir: number) => {
        const p = picked(sel); const f = d.fields;
        const idx = p.map((k) => f.indexOf(k)).sort((a, b) => (dir < 0 ? a - b : b - a));
        for (const i of idx) { const j = i + dir; if (j < 0 || j >= f.length || p.includes(f[j])) continue; [f[i], f[j]] = [f[j], f[i]]; }
        render(); for (const o of [...(pane.querySelectorAll('select')[1] as HTMLSelectElement).options]) o.selected = p.includes(o.value);
      };
      avail.ondblclick = addF; sel.ondblclick = remF;
      const btn = (l: string, fn: () => void) => { const b = h('button', { class: 'btn small' }, l); b.onclick = fn; return b; };
      pane.append(h('div', { class: 'sched-cols' },
        h('div', {}, h('div', { class: 'hint' }, 'Verfügbare Felder:'), avail),
        h('div', { class: 'sched-mid' }, btn('Hinzufügen →', addF), btn('← Entfernen', remF), btn('Nach oben', () => moveF(-1)), btn('Nach unten', () => moveF(1))),
        h('div', {}, h('div', { class: 'hint' }, 'Felder der Bauteilliste (in Reihenfolge):'), sel)));
    } else if (cur === 'filter') {
      while (d.filters.length < 4) d.filters.push({ key: '', op: 'eq', value: '' });
      d.filters.forEach((flt, i) => {
        const fs = fieldSel(flt.key); fs.onchange = () => (flt.key = fs.value);
        const op = h('select', {}) as HTMLSelectElement;
        for (const [k, l] of FILTER_OPS) op.append(h('option', { value: k }, l));
        op.value = flt.op; op.onchange = () => (flt.op = op.value as FilterOp);
        const val = h('input', { type: 'text', value: flt.value }) as HTMLInputElement; val.oninput = () => (flt.value = val.value);
        pane.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:90px' }, i ? 'Und:' : 'Filtern nach:'), fs, op, val));
      });
      pane.append(h('div', { class: 'hint' }, 'Längen in Projekteinheiten, Flächen in m², Volumen in m³. Es werden nur Elemente aufgeführt, die alle Bedingungen erfüllen.'));
    } else if (cur === 'sort') {
      while (d.sort.length < 3) d.sort.push({ key: '' });
      d.sort.forEach((s, i) => {
        const fs = fieldSel(s.key); fs.onchange = () => (s.key = fs.value);
        const dir = h('select', {}) as HTMLSelectElement;
        dir.append(h('option', { value: 'asc' }, 'Aufsteigend'), h('option', { value: 'desc' }, 'Absteigend'));
        dir.value = s.desc ? 'desc' : 'asc'; dir.onchange = () => (s.desc = dir.value === 'desc');
        pane.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:110px' }, i ? 'Dann nach:' : 'Sortieren nach:'), fs, dir));
      });
      const chk = (l: string, get: () => boolean, set: (v: boolean) => void) => {
        const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = get(); c.onchange = () => set(c.checked);
        return h('div', { class: 'form-row' }, h('label', {}, c, ' ' + l));
      };
      pane.append(
        h('div', { class: 'hint' }, 'Gruppierung (erste Sortierebene):'),
        chk('Kopfzeile', () => !!d.header, (v) => (d.header = v)),
        chk('Fußzeile (Titel, Anzahl und Summen)', () => !!d.footer, (v) => (d.footer = v)),
        chk('Leerzeile', () => !!d.blank, (v) => (d.blank = v)),
        chk('Gesamtsummen', () => d.totals, (v) => (d.totals = v)),
        chk('Jedes Exemplar einzeln aufführen', () => d.itemize, (v) => (d.itemize = v)),
      );
    } else {
      if (!d.fields.length) { pane.append(h('div', { class: 'hint' }, 'Keine Felder ausgewählt.')); return; }
      const tb = h('table', { class: 'grid' });
      tb.append(h('tr', {}, h('th', {}, 'Feld'), h('th', {}, 'Überschrift'), h('th', {}, 'Summe berechnen')));
      for (const k of d.fields) {
        const f = byKey.get(k)!;
        const lab = h('input', { type: 'text', value: d.labels![k] ?? '', placeholder: f.label }) as HTMLInputElement;
        lab.oninput = () => { if (lab.value.trim()) d.labels![k] = lab.value; else delete d.labels![k]; };
        const sumC = h('input', { type: 'checkbox' }) as HTMLInputElement;
        sumC.checked = d.sums.includes(k); sumC.disabled = !isNumField(f) || f.unit === 'count';
        sumC.onchange = () => { d.sums = d.sums.filter((x) => x !== k); if (sumC.checked) d.sums.push(k); };
        tb.append(h('tr', {}, h('td', {}, f.label), h('td', {}, lab), h('td', { style: 'text-align:center' }, sumC)));
      }
      pane.append(tb);
    }
  };
  render();
  modal(title, body, [
    { label: 'OK', primary: true, onClick: () => {
      if (!d.fields.length) { alert('Bitte mindestens ein Feld hinzufügen.'); cur = 'fields'; render(); return false; }
      d.filters = d.filters.filter((f) => f.key); d.sort = d.sort.filter((s) => s.key);
      onOk(d);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 640);
}

function scheduleName(doc: Doc, cat: string): string {
  const special: Record<string, string> = { door: 'Türliste', window: 'Fensterliste', wall: 'Wandliste', room: 'Raumliste', floor: 'Geschossdeckenliste', column: 'Stützenliste', beam: 'Trägerliste', rebar: 'Bewehrungsliste' };
  const base = special[cat] ?? 'Bauteilliste ' + (catDef(cat)?.plural ?? cat);
  const names = new Set(doc.all<View>('view').map((v) => v.name));
  let n = base, i = 2; while (names.has(n)) n = `${base} ${i++}`;
  return n;
}

/** Neue Bauteilliste (Revit: „Bauteillisten/Mengen“) */
export function newScheduleDialog(preset?: string): void {
  const doc = app.doc;
  const cats = scheduleCats();
  if (!cats.length) { alert('Keine Kategorien für Bauteillisten verfügbar.'); return; }
  const list = h('select', { size: '14', style: 'width:100%' }) as HTMLSelectElement;
  for (const c of cats) list.append(h('option', { value: c.cat }, `${c.label} (${doc.count(c.cat)})`));
  list.value = preset && cats.some((c) => c.cat === preset) ? preset : cats.find((c) => c.cat === 'door')?.cat ?? cats[0].cat;
  const name = h('input', { type: 'text', value: scheduleName(doc, list.value) }) as HTMLInputElement;
  let touched = false;
  name.oninput = () => (touched = true);
  list.onchange = () => { if (!touched) name.value = scheduleName(doc, list.value); };
  const body = h('div', {}, h('div', { class: 'hint' }, 'Kategorie:'), list, h('div', { class: 'form-row' }, h('label', {}, 'Name'), name));
  const next = () => {
    const cat = list.value; const nm = name.value.trim() || scheduleName(doc, cat);
    scheduleDialog(defaultDef(doc, cat), 'Eigenschaften der Bauteilliste', (d) => {
      const id = newId('vw');
      doc.transaction('Bauteilliste erstellen', () => doc.add<View>({ id, cat: 'view', kind: 'schedule', name: nm, scale: 1, detail: 'medium', data: d } as View));
      app.emit('views');
      app.openView(id);
    });
  };
  list.ondblclick = () => { m.close(); next(); };
  const m = modal('Neue Bauteilliste/Mengen', body, [{ label: 'OK', primary: true, onClick: next }, { label: 'Abbrechen', onClick: () => {} }], 420);
}
registerCommand({ id: 'schedule', label: 'Bauteillisten', icon: 'schedule', tip: 'Bauteilliste/Mengen erstellen (Felder, Filter, Sortierung, Summen)', run: () => newScheduleDialog() });

export function editSchedule(v: View, tab: Tab = 'fields'): void {
  scheduleDialog(schedDef(v), 'Eigenschaften der Bauteilliste', (d) => {
    app.doc.transaction('Bauteilliste ändern', () => app.doc.update<View>(v.id, { data: d }));
    app.refreshViews();
  }, tab);
}

extendViewProps('schedule', (v, doc, base) => {
  const g = GROUPS;
  const sk = scheduleKind(v as View);
  if (sk) return [...base.filter((p) => p.key !== 'titleOnSheet'), { key: 'schedCat', label: 'Liste', group: g.identity, type: 'readonly', get: () => sk.label }, ...(sk.props?.(v as View, doc) ?? [])];
  const btn = (key: string, label: string, tab: Tab): PropDef => ({ key, label, group: g.other, type: 'button', get: () => 'Bearbeiten…', action: (e) => editSchedule(e as View, tab) });
  return [
    ...base.filter((p) => p.key !== 'titleOnSheet'),
    { key: 'schedCat', label: 'Kategorie', group: g.identity, type: 'readonly', get: (e) => catDef(e.data?.cat)?.plural ?? e.data?.cat ?? '' },
    { key: 'schedCount', label: 'Anzahl Elemente', group: g.identity, type: 'readonly', get: (e) => String(buildTable(doc, e as View).count) },
    btn('fields', 'Felder', 'fields'), btn('filter', 'Filter', 'filter'), btn('sort', 'Sortierung/Gruppierung', 'sort'), btn('format', 'Formatierung', 'format'),
  ];
});

// ------------------------------------------------------------ Tabellenansicht
injectCss('schedule', `
.sched-vp { position:absolute; inset:0; display:flex; flex-direction:column; background:#fff; }
.sched-bar { display:flex; gap:6px; align-items:center; padding:4px 8px; border-bottom:1px solid #d0d6dc; background:#f4f6f8; font-size:12px; }
.sched-bar .sp { flex:1; }
.sched-scroll { flex:1; overflow:auto; padding:14px 18px; }
table.sched { border-collapse:collapse; font:12px Arial, Helvetica, sans-serif; }
table.sched th, table.sched td { border:1px solid #9aa4ae; padding:2px 8px; white-space:nowrap; height:20px; }
table.sched tr.ttl th { font-size:14px; font-weight:bold; text-align:center; border:1px solid #6a747e; background:#fff; padding:6px; }
table.sched tr.let th { background:#e9edf1; color:#5a646e; font-weight:normal; font-size:11px; text-align:center; height:16px; }
table.sched tr.hd th { background:#f4f6f8; font-weight:bold; text-align:center; }
table.sched td.num { text-align:right; }
table.sched tr.data { cursor:default; }
table.sched tr.data:hover td { background:#eef5ff; }
table.sched tr.sel td { background:#cfe2fb !important; }
table.sched tr.grp td { font-weight:bold; background:#fafbfc; }
table.sched tr.foot td { font-style:italic; border-top:1px solid #444; background:#fafbfc; }
table.sched tr.tot td { font-weight:bold; border-top:2px solid #333; }
table.sched tr.blank td { border-left:none; border-right:none; }
table.sched td.ed:hover { outline:1px solid #2a7be4; outline-offset:-1px; cursor:text; }
table.sched td.editing { padding:0; }
table.sched td input, table.sched td select { width:100%; min-width:80px; box-sizing:border-box; font:inherit; height:20px; border:1px solid #2a7be4; }
.sched-dlg .sched-tabs { display:flex; gap:4px; margin:6px 0; }
.sched-dlg .sched-pane { min-height:300px; border:1px solid #d0d6dc; padding:8px; }
.sched-dlg .sched-cols { display:grid; grid-template-columns:1fr auto 1fr; gap:8px; align-items:center; }
.sched-dlg .sched-cols select { width:100%; }
.sched-dlg .sched-mid { display:flex; flex-direction:column; gap:6px; }
`);

const liveSchedules = new Set<ScheduleView>();
app.on('selection', () => { for (const s of liveSchedules) s.markSelection(); });

class ScheduleView implements ViewportLike {
  view: View;
  el: HTMLElement;
  private scroll: HTMLElement;
  private info: HTMLElement;
  private raf = 0;
  private editing = false;
  private shown = false;
  private table: Table | null = null;
  private defBtns: HTMLElement[] = [];

  constructor(view: View, host: HTMLElement) {
    this.view = view;
    this.el = h('div', { class: 'sched-vp', style: 'display:none' });
    const bar = h('div', { class: 'sched-bar' });
    const b = (l: string, fn: () => void, tip = '') => { const x = h('button', { class: 'btn small', title: tip }, l); x.onclick = fn; return x; };
    this.info = h('span', {});
    this.defBtns = [b('Felder…', () => editSchedule(this.cur(), 'fields')), b('Filter…', () => editSchedule(this.cur(), 'filter')),
      b('Sortieren/Gruppieren…', () => editSchedule(this.cur(), 'sort')), b('Formatierung…', () => editSchedule(this.cur(), 'format'))];
    bar.append(
      ...this.defBtns,
      h('span', { class: 'sp' }), this.info,
      b('Im Modell markieren', () => this.showInModel(), 'Ausgewählte Elemente in einer Ansicht zeigen'),
      b('CSV exportieren', () => download(fileBase(this.cur()) + '.csv', scheduleCsv(app.doc, this.cur()), 'text/csv;charset=utf-8')),
    );
    this.scroll = h('div', { class: 'sched-scroll' });
    this.el.append(bar, this.scroll);
    host.append(this.el);
    liveSchedules.add(this);
  }
  private cur(): View { return app.doc.get<View>(this.view.id) ?? this.view; }
  activate(): void { this.el.style.display = ''; this.shown = true; this.render(); }
  deactivate(): void { this.el.style.display = 'none'; this.shown = false; }
  invalidate(): void {
    if (!this.shown || this.editing || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }
  zoomExtents(): void { /* Tabelle */ }
  dispose(): void { cancelAnimationFrame(this.raf); liveSchedules.delete(this); this.el.remove(); }
  displayList(): DisplayList { return buildViewDL(app.doc, this.cur()); }

  markSelection(): void {
    for (const tr of this.scroll.querySelectorAll<HTMLTableRowElement>('tr.data')) {
      const ids = (tr.dataset.ids ?? '').split(',');
      tr.classList.toggle('sel', ids.some((id) => app.selection.has(id)));
    }
  }

  private showInModel(): void {
    const sel = app.selected();
    if (!sel.length) { app.status('Bitte zuerst eine Zeile auswählen.'); return; }
    const lvl = sel[0].levelId ?? app.doc.get(sel[0].hostId)?.levelId;
    const plan = app.doc.all<View>('view').find((v) => v.kind === 'plan' && (!lvl || v.levelId === lvl));
    if (plan) app.openView(plan.id);
  }

  render(): void {
    const v = this.cur(); this.view = v;
    const doc = app.doc;
    const st = this.scroll.scrollTop, sl = this.scroll.scrollLeft;
    const sk = scheduleKind(v);
    for (const btn of this.defBtns) btn.style.display = sk ? 'none' : '';
    if (sk) {
      try { this.scroll.innerHTML = sk.html(doc, v); } catch (e) { console.error(e); this.scroll.textContent = 'Liste konnte nicht berechnet werden.'; }
      this.info.textContent = sk.count ? `${sk.count(doc, v)} Positionen` : '';
      this.scroll.scrollTop = st; this.scroll.scrollLeft = sl;
      return;
    }
    let t: Table;
    try { t = buildTable(doc, v); } catch (e) { console.error(e); this.scroll.textContent = 'Bauteilliste konnte nicht berechnet werden.'; return; }
    this.table = t;
    this.info.textContent = `${t.count} Element${t.count === 1 ? '' : 'e'}`;
    const n = Math.max(1, t.fields.length);
    const tb = h('table', { class: 'sched' });
    tb.append(h('tr', { class: 'ttl' }, h('th', { colspan: String(n) }, `<${v.name}>`)));
    const let_ = h('tr', { class: 'let' });
    for (let i = 0; i < n; i++) let_.append(h('th', {}, colName(i)));
    tb.append(let_);
    const hd = h('tr', { class: 'hd' });
    t.heads.forEach((l) => hd.append(h('th', {}, l)));
    tb.append(hd);
    for (const r of t.rows) {
      const cls = r.kind === 'data' ? 'data' : r.kind === 'group' ? 'grp' : r.kind === 'footer' ? 'foot' : r.kind === 'total' ? 'tot' : 'blank';
      const tr = h('tr', { class: cls });
      if (r.kind === 'group') { tr.append(h('td', { colspan: String(n) }, r.text[0] ?? '')); tb.append(tr); continue; }
      if (r.kind === 'blank') { tr.append(h('td', { colspan: String(n) }, '\u00a0')); tb.append(tr); continue; }
      tr.dataset.ids = r.ids.join(',');
      t.fields.forEach((f, i) => {
        const td = h('td', { class: typeof r.cells[i] === 'number' ? 'num' : '' }, r.text[i] ?? '');
        if (r.kind === 'data' && f.edit) {
          td.classList.add('ed');
          td.onclick = (e) => { e.stopPropagation(); app.select(r.ids); this.editCell(td, f, r.ids); };
        }
        tr.append(td);
      });
      if (r.kind === 'data') tr.onclick = (e) => app.select(r.ids, e.ctrlKey || e.metaKey ? 'add' : 'set');
      tb.append(tr);
    }
    if (!t.rows.length) tb.append(h('tr', {}, h('td', { colspan: String(n), style: 'color:#888;text-align:center' }, 'Keine Elemente')));
    this.scroll.innerHTML = '';
    this.scroll.append(tb);
    this.scroll.scrollTop = st; this.scroll.scrollLeft = sl;
    this.markSelection();
  }

  /** Zelle bearbeiten → Parameter aller Elemente der Zeile setzen */
  private editCell(td: HTMLElement, f: SchedField, ids: Id[]): void {
    if (this.editing) return;
    const doc = app.doc; const ed = f.edit!; const p = ed.prop;
    const first = doc.get(ids[0]); if (!first) return;
    const target = (el: El) => (ed.onType ? doc.get(el.typeId) : el);
    const t0 = target(first); if (!t0) return;
    let cur: any; try { cur = p.get(t0, doc); } catch { cur = ''; }
    this.editing = true;
    td.classList.add('editing'); td.textContent = '';
    let input: HTMLInputElement | HTMLSelectElement;
    if (p.type === 'select' || p.type === 'level' || p.type === 'material' || p.type === 'bool') {
      const s = h('select', {}) as HTMLSelectElement;
      const opts: [string, string][] = p.type === 'bool' ? [['1', 'Ja'], ['0', 'Nein']] : optionsOf(p, doc);
      for (const [k, l] of opts) s.append(h('option', { value: k }, l));
      s.value = p.type === 'bool' ? (cur ? '1' : '0') : String(cur ?? '');
      input = s;
    } else {
      const fmt = p.type === 'length' ? fmtLen(Number(cur) || 0) : p.type === 'angle' ? fmtNum(((Number(cur) || 0) * 180) / Math.PI, 2) : p.type === 'number' ? fmtNum(Number(cur) || 0, 2).replace(/,00$/, '') : String(cur ?? '');
      input = h('input', { type: 'text', value: fmt }) as HTMLInputElement;
    }
    td.append(input);
    input.focus();
    if (input instanceof HTMLInputElement) input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return; done = true;
      this.editing = false;
      if (commit) {
        let v: any = input.value;
        if (p.type === 'bool') v = input.value === '1';
        else if (p.type === 'length') v = parseLen(input.value);
        else if (p.type === 'number') v = parseNum(input.value);
        else if (p.type === 'int') { v = parseNum(input.value); if (v !== null) v = Math.round(v); }
        else if (p.type === 'angle') v = parseAngle(input.value);
        if (v === null || (typeof v === 'number' && isNaN(v))) { app.status('Ungültiger Wert'); this.render(); return; }
        if (JSON.stringify(v) !== JSON.stringify(cur)) {
          try {
            doc.transaction(`${f.label} ändern`, () => {
              const done2 = new Set<Id>();
              for (const id of ids) {
                const el = doc.get(id); if (!el) continue;
                const tg = target(el); if (!tg || done2.has(tg.id)) continue;
                done2.add(tg.id);
                const patch = p.set!(tg, v, doc);
                if (patch) doc.update(tg.id, patch);
              }
            });
            if (ed.onType) toast('Typparameter geändert – wirkt auf alle Exemplare dieses Typs.');
          } catch (e) { console.error(e); app.status('Wert konnte nicht gesetzt werden.'); }
        }
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      ke.stopPropagation();
      if (ke.key === 'Enter') finish(true);
      else if (ke.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    if (input instanceof HTMLSelectElement) input.addEventListener('change', () => finish(true));
  }
}
function colName(i: number): string { let s = ''; let n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; }

registerViewport({ kinds: ['schedule'], create: (view, host) => new ScheduleView(view, host) });
