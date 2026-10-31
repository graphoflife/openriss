// DXF-Export (aktive Ansicht/Plan) und DXF-Import als ansichtsspezifisches Element 'cadimport'
// (halbton/schwarzweiß/farbig, als Einheit wählbar, verschiebbar, fixierbar; Auflösen in Detaillinien).
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, registerContextPanel, catDef, GROUPS, PropDef } from '../../core/registry';
import type { View } from '../../core/view';
import { DisplayList, Prim, Font } from '../../render/displayList';
import { OBJECT_STYLES, Pen } from '../../render/styles';
import { V2, Mat2, apply, compose, matScale, matAngle, isMirror, mid, rotation } from '../../core/geom';
import { fmtNum } from '../../core/units';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { writeDxf, nearestAci, rgbOf } from './dxfWrite';
import { linePen, lineStyleLabel, lineStyleOfPrim } from '../../elements/datums';
import { parseDxf, decodeDxf, CadEnt, CadData, INSUNITS_MM } from './dxfParse';
import { pageOf, fileBase } from './common';

// ------------------------------------------------------------ Export
function exportDxfDialog(): void {
  const v = app.activeView();
  if (!v || v.kind === '3d') { app.status('Bitte einen Plan, eine 2D-Ansicht oder eine Bauteilliste öffnen.'); return; }
  const ver = h('select', {}) as HTMLSelectElement;
  ver.append(h('option', { value: 'R2000' }, 'AutoCAD 2000 (AC1015) – mit Linienstärken'), h('option', { value: 'R12' }, 'AutoCAD R12 (AC1009) – maximal kompatibel'));
  const col = h('select', {}) as HTMLSelectElement;
  col.append(h('option', { value: 'color' }, 'Farben beibehalten'), h('option', { value: 'mono' }, 'Schwarzweiß (VonLayer)'));
  const sheet = v.kind === 'sheet';
  const body = h('div', {},
    h('div', { class: 'form-row' }, h('label', {}, 'Dateiformat'), ver),
    h('div', { class: 'form-row' }, h('label', {}, 'Farben'), col),
    h('div', { class: 'hint' }, sheet
      ? 'Plan wird in Papier-Millimetern (1:1) exportiert. Layer je Kategorie.'
      : `Ansicht wird in Modell-Millimetern 1:1 exportiert (Texte/Linientypen für 1:${v.scale}). Layer je Kategorie, Einheit mm ($INSUNITS = 4).`),
  );
  modal('DXF exportieren', body, [
    { label: 'Exportieren', primary: true, onClick: () => {
      try {
        const bytes = exportDxf(app.doc, v, ver.value as 'R2000' | 'R12', col.value === 'mono');
        if (bytes) download(fileBase(v) + '.dxf', new Blob([bytes], { type: 'application/dxf' }));
      } catch (e) { console.error(e); alert('DXF-Export fehlgeschlagen: ' + (e as Error).message); }
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 460);
}

export function exportDxf(doc: Doc, v: View, version: 'R2000' | 'R12', mono: boolean): Uint8Array<ArrayBuffer> | null {
  const p = pageOf(doc, v); if (!p) return null;
  const catOfLayer = new Map<string, string>();
  const stylePen = new Map<string, Pen>();
  const layerOf = (it: Prim): string => {
    let cat: string | undefined;
    // Detail-/Modelllinien und Bereichsränder: ein Layer je Linienstil (mit Layerfarbe)
    const ls = it.sub?.startsWith('ls:') ? it.sub.slice(3) : lineStyleOfPrim(doc, it.o ? doc.get(it.o) : undefined, it.sub);
    if (ls && ls !== 'invisible') {
      const name = 'Linien-' + lineStyleLabel(doc, ls).replace(/[<>]/g, '');
      if (!stylePen.has(name)) stylePen.set(name, linePen(doc, ls));
      return name;
    }
    if (it.sub?.startsWith('cat:')) cat = it.sub.slice(4);
    else if (it.o) {
      const el = doc.get(it.o);
      cat = el?.cat === 'view' ? (el.kind === 'section' ? 'section' : el.kind === 'elevation' ? 'elevation' : 'view') : el?.cat;
      if (el?.cat === 'cadimport') return 'Import-' + (el.name ?? 'DXF').replace(/\.dxf$/i, '');
    }
    if (!cat) return v.kind === 'sheet' ? 'Plankopf' : v.kind === 'schedule' ? 'Bauteilliste' : '0';
    const name = OBJECT_STYLES[cat]?.label ?? catDef(cat)?.plural ?? cat;
    catOfLayer.set(name, cat);
    return name;
  };
  const layerColor = (name: string) => { const c = rgbOf(OBJECT_STYLES[catOfLayer.get(name) ?? '']?.color); return c ? nearestAci(...c) : 7; };
  return writeDxf(p.dl, { version, scale: p.dl.scale || 1, layerOf, layerColor, mono, layerPen: (name) => stylePen.get(name) });
}

registerCommand({ id: 'exportDxf', label: 'DXF', icon: 'dxf', tip: 'Aktive Ansicht (Modell-mm 1:1) bzw. aktiven Plan (Papier-mm) als DXF exportieren', run: exportDxfDialog });

// ------------------------------------------------------------ Element „CAD-Import“
export interface CadImport extends El {
  cat: 'cadimport';
  viewId: Id;
  name: string;
  /** mm je Datei-Einheit */
  unit: number;
  /** Lage des Basispunkts in der Ansicht (mm) */
  offset: V2;
  rotation: number;
  scale?: number;
  mirror?: boolean;
  /** Basispunkt in Datei-Einheiten (gespeicherte Koordinaten sind relativ dazu) */
  base: V2;
  /** Umgrenzung relativ zum Basispunkt (Datei-Einheiten) */
  box?: { min: V2; max: V2 };
  entities: CadEnt[];
  layers: string[];
  hiddenLayers?: string[];
  colors: 'bw' | 'keep' | 'ht';
}

export function cadXf(c: CadImport): Mat2 {
  const s = (c.unit || 1) * (c.scale ?? 1);
  const m: Mat2 = { a: s, b: 0, c: 0, d: c.mirror ? -s : s, e: 0, f: 0 };
  return compose({ ...rotation(c.rotation ?? 0), e: c.offset.x, f: c.offset.y }, m);
}

/** AutoCAD-Farbindex → Hex (näherungsweise vollständige Tabelle) */
export function aciHex(k: number | undefined): string {
  if (k === undefined || k === 7 || k === 0 || k === 256) return '#000000';
  if (k < 0) { const v = -k - 1; const s = '#' + v.toString(16).padStart(6, '0'); const rgb = rgbOf(s); return rgb && Math.min(...rgb) > 235 ? '#000000' : s; }
  const base: Record<number, string> = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0' };
  if (base[k]) return base[k];
  const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  if (k >= 250) { const g = [51, 91, 132, 173, 214, 0][k - 250] ?? 0; return hex(g, g, g); }
  const hue = Math.floor((k - 10) / 10) * 15; const sub = (k - 10) % 10;
  const lev = [255, 165, 127, 76, 38][Math.floor(sub / 2)];
  const f = (n: number) => { const kk = (n + hue / 60) % 6; return 1 - Math.max(0, Math.min(kk, 4 - kk, 1)); };
  let rgb = [f(5), f(3), f(1)].map((x) => x * lev);
  if (sub % 2) rgb = rgb.map((x) => x / 2 + lev / 2);
  return hex(rgb[0], rgb[1], rgb[2]);
}

function bulgeArc(p0: V2, p1: V2, b: number): { c: V2; r: number; a0: number; a1: number } | null {
  const dx = p1.x - p0.x, dy = p1.y - p0.y; const L = Math.hypot(dx, dy);
  if (L < 1e-12 || Math.abs(b) < 1e-9) return null;
  const ang = 4 * Math.atan(b);
  const r = L / (2 * Math.sin(Math.abs(ang) / 2));
  const hd = r * Math.cos(Math.abs(ang) / 2) * Math.sign(b);
  const c = { x: (p0.x + p1.x) / 2 - (dy / L) * hd, y: (p0.y + p1.y) / 2 + (dx / L) * hd };
  let a0 = Math.atan2(p0.y - c.y, p0.x - c.x), a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  if (b < 0) [a0, a1] = [a1, a0];
  return { c, r: Math.abs(r), a0, a1 };
}

/** Geometrie eines CAD-Imports als Liste einfacher Teile in Ansichtskoordinaten */
type Part =
  | { k: 'line'; a: V2; b: V2; e: CadEnt }
  | { k: 'poly'; pts: V2[]; closed: boolean; e: CadEnt }
  | { k: 'arc'; c: V2; r: number; a0: number; a1: number; e: CadEnt }
  | { k: 'circle'; c: V2; r: number; e: CadEnt }
  | { k: 'fill'; pts: V2[]; e: CadEnt }
  | { k: 'text'; p: V2; s: string; size: number; rot: number; ha: number; va: number; e: CadEnt };

function cadParts(c: CadImport, cb: (p: Part) => void): void {
  const m = cadXf(c); const s = matScale(m); const mir = isMirror(m); const rot = matAngle(m);
  const hidden = new Set((c.hiddenLayers ?? []).map((l) => c.layers.indexOf(l)));
  const P = (x: number, y: number) => apply(m, { x, y });
  const arc = (e: CadEnt, cc: V2, r: number, a0: number, a1: number) => {
    const [b0, b1] = mir ? [rot - a1, rot - a0] : [a0 + rot, a1 + rot];
    cb({ k: 'arc', c: apply(m, cc), r: r * s, a0: b0, a1: b1, e });
  };
  for (const e of c.entities) {
    if (e.L !== undefined && hidden.has(e.L)) continue;
    const p = e.p;
    switch (e.t) {
      case 'l': cb({ k: 'line', a: P(p[0], p[1]), b: P(p[2], p[3]), e }); break;
      case 'p': {
        const raw: V2[] = []; for (let i = 0; i + 1 < p.length; i += 2) raw.push({ x: p[i], y: p[i + 1] });
        if (!e.b) { cb({ k: 'poly', pts: raw.map((q) => apply(m, q)), closed: !!e.c, e }); break; }
        // gerade Abschnitte als Polylinie, Bulges als Bögen
        let run: V2[] = [raw[0]];
        const n = raw.length; const segs = e.c ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const q0 = raw[i], q1 = raw[(i + 1) % n]; const b = e.b[i] ?? 0;
          const a = b ? bulgeArc(q0, q1, b) : null;
          if (a) {
            if (run.length > 1) cb({ k: 'poly', pts: run.map((q) => apply(m, q)), closed: false, e });
            arc(e, a.c, a.r, a.a0, a.a1); run = [q1];
          } else run.push(q1);
        }
        if (run.length > 1) cb({ k: 'poly', pts: run.map((q) => apply(m, q)), closed: false, e });
        break;
      }
      case 'c': cb({ k: 'circle', c: P(p[0], p[1]), r: (e.r ?? 0) * s, e }); break;
      case 'a': arc(e, { x: p[0], y: p[1] }, e.r ?? 0, e.a0 ?? 0, e.a1 ?? 0); break;
      case 's': { const pts: V2[] = []; for (let i = 0; i + 1 < p.length; i += 2) pts.push(P(p[i], p[i + 1])); cb({ k: 'fill', pts, e }); break; }
      case 't': {
        const r0 = e.rot ?? 0;
        const d = { x: m.a * Math.cos(r0) + m.c * Math.sin(r0), y: m.b * Math.cos(r0) + m.d * Math.sin(r0) };
        cb({ k: 'text', p: P(p[0], p[1]), s: e.s ?? '', size: (e.h ?? 1) * s, rot: Math.atan2(d.y, d.x), ha: e.ha ?? 0, va: e.va ?? 0, e });
        break;
      }
    }
  }
}

const HA: Font['ha'][] = ['left', 'center', 'right'];
const VA: Font['va'][] = ['baseline', 'bottom', 'middle', 'top'];

registerCategory({
  cat: 'cadimport', label: 'Importierte CAD-Datei', plural: 'CAD-Importe', annotation: true, planOrder: -50,
  drawAnnotation: (dl, el) => {
    const c = el as CadImport;
    const ht = c.colors === 'ht';
    const col = (e: CadEnt) => (c.colors === 'keep' ? aciHex(e.k) : '#000000');
    const ex = ht ? { ht: true } : {};
    cadParts(c, (q) => {
      const pen: Pen = { w: 1, color: col(q.e) };
      switch (q.k) {
        case 'line': dl.line(q.a, q.b, pen, ex); break;
        case 'poly': dl.poly(q.pts, pen, q.closed, ex); break;
        case 'arc': dl.arc(q.c, q.r, q.a0, q.a1, pen, ex); break;
        case 'circle': dl.circle(q.c, q.r, pen, undefined, ex); break;
        case 'fill': dl.fill([q.pts], { color: col(q.e), pattern: 'solid', patColor: col(q.e) }, undefined, ex); break;
        case 'text': dl.text(q.p, q.s, { size: q.size / (dl.scale || 1), rot: q.rot, ha: HA[q.ha] ?? 'left', va: VA[q.va] ?? 'baseline', color: col(q.e) }, ex); break;
      }
    });
  },
  transform: (el, m) => {
    const c = el as CadImport;
    const M = compose(m, cadXf(c));
    return { offset: apply(m, c.offset), rotation: matAngle(M), mirror: isMirror(M), scale: matScale(M) / (c.unit || 1) };
  },
  center: (el) => {
    const c = el as CadImport;
    return c.box ? apply(cadXf(c), mid(c.box.min, c.box.max)) : c.offset;
  },
  props: () => {
    const g = GROUPS;
    const p: PropDef[] = [
      { key: 'name', label: 'Datei', group: g.identity, type: 'readonly', get: (e) => e.name },
      { key: 'unit', label: 'Importeinheit', group: g.identity, type: 'readonly', get: (e) => unitLabel(e.unit) },
      { key: 'count', label: 'Elemente', group: g.identity, type: 'readonly', get: (e) => String(e.entities?.length ?? 0) },
      { key: 'colors', label: 'Farben', group: g.graphics, type: 'select', options: COLOR_OPTS, get: (e) => e.colors ?? 'bw', set: (_e, x) => ({ colors: x }) },
      { key: 'layers', label: 'Layer', group: g.graphics, type: 'button', get: (e) => `${e.layers.length - (e.hiddenLayers?.length ?? 0)} von ${e.layers.length} sichtbar…`, action: (e) => layerDialog(e as CadImport) },
      { key: 'rotation', label: 'Drehung', group: g.constraints, type: 'angle', get: (e) => e.rotation ?? 0, set: (e, x) => ({ rotation: x }) },
      { key: 'scale', label: 'Skalierung', group: g.constraints, type: 'number', get: (e) => e.scale ?? 1, set: (_e, x) => (x > 0 ? { scale: x } : undefined) },
      { key: 'explode', label: 'Auflösen', group: g.other, type: 'button', get: () => 'In Detaillinien auflösen…', action: (e) => explodeImport([e.id]) },
    ];
    return p;
  },
});

const COLOR_OPTS: [string, string][] = [['bw', 'Schwarzweiß'], ['keep', 'Beibehalten'], ['ht', 'Halbton']];
const UNITS: [string, string, number][] = [['mm', 'Millimeter', 1], ['cm', 'Zentimeter', 10], ['dm', 'Dezimeter', 100], ['m', 'Meter', 1000], ['in', 'Zoll', 25.4], ['ft', 'Fuß', 304.8]];
const unitLabel = (u: number) => UNITS.find((x) => Math.abs(x[2] - u) < 1e-9)?.[1] ?? `1 Einheit = ${fmtNum(u, 3)} mm`;

function layerDialog(c: CadImport): void {
  const counts = new Map<number, number>();
  for (const e of c.entities) counts.set(e.L ?? -1, (counts.get(e.L ?? -1) ?? 0) + 1);
  const hidden = new Set(c.hiddenLayers ?? []);
  const list = h('div', { style: 'max-height:360px;overflow:auto;border:1px solid #c8d0d8;padding:4px' });
  const checks: [HTMLInputElement, string][] = [];
  c.layers.forEach((l, i) => {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = !hidden.has(l);
    checks.push([cb, l]);
    list.append(h('div', {}, h('label', {}, cb, ` ${l}  (${counts.get(i) ?? 0})`)));
  });
  const all = h('button', { class: 'btn small' }, 'Alle'); all.onclick = () => checks.forEach(([cb]) => (cb.checked = true));
  const none = h('button', { class: 'btn small' }, 'Keine'); none.onclick = () => checks.forEach(([cb]) => (cb.checked = false));
  modal('Layer – ' + c.name, h('div', {}, h('div', { class: 'form-row' }, all, none), list), [
    { label: 'OK', primary: true, onClick: () => {
      app.doc.transaction('Layer ein-/ausblenden', () => app.doc.update<CadImport>(c.id, { hiddenLayers: checks.filter(([cb]) => !cb.checked).map(([, l]) => l) }));
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 420);
}

// ------------------------------------------------------------ Import
function pickFile(accept: string): Promise<File> {
  return new Promise((res, rej) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = () => { const f = i.files?.[0]; if (f) res(f); else rej(new Error('Keine Datei')); };
    i.click();
  });
}

async function importDxfCmd(): Promise<void> {
  const v = app.activeView();
  if (!v || v.kind === '3d' || v.kind === 'schedule') { app.status('DXF-Import ist nur in 2D-Ansichten und Plänen möglich.'); return; }
  let file: File;
  try { file = await pickFile('.dxf,.DXF'); } catch { return; }
  if (/\.dwg$/i.test(file.name)) { alert('DWG wird nicht unterstützt – bitte als DXF speichern.'); return; }
  let data: CadData;
  try { data = parseDxf(decodeDxf(await file.arrayBuffer())); } catch (e) { alert('DXF konnte nicht gelesen werden: ' + (e as Error).message); return; }
  if (!data.ents.length) { alert('Die Datei enthält keine importierbaren Elemente im Modellbereich.'); return; }
  const detected = INSUNITS_MM[data.insunits];
  // Dialog „CAD-Formate importieren“
  const unit = h('select', {}) as HTMLSelectElement;
  if (detected) unit.append(h('option', { value: 'auto' }, `Automatisch erkennen (${unitLabel(detected)})`));
  for (const [k, l] of UNITS) unit.append(h('option', { value: k }, l));
  unit.value = detected ? 'auto' : v.kind === 'sheet' ? 'mm' : 'm';
  const pos = h('select', {}) as HTMLSelectElement;
  pos.append(h('option', { value: 'center' }, 'Automatisch – Mitte zu Mitte'), h('option', { value: 'origin' }, 'Automatisch – Ursprung zu Ursprung'));
  const colors = h('select', {}) as HTMLSelectElement;
  for (const [k, l] of COLOR_OPTS) colors.append(h('option', { value: k }, l));
  const onlyVisible = h('input', { type: 'checkbox' }) as HTMLInputElement; onlyVisible.checked = true;
  const sk = Object.entries(data.skipped).map(([k, n]) => `${k} (${n})`).join(', ');
  const body = h('div', {},
    h('div', { class: 'hint' }, `${file.name}: ${data.ents.length} Elemente auf ${data.layers.length} Layern${data.version ? ' · ' + data.version : ''}`),
    h('div', { class: 'form-row' }, h('label', {}, 'Importeinheiten'), unit),
    detected ? null : h('div', { class: 'hint', style: 'color:#b06000' }, 'Die Datei enthält keine Einheit ($INSUNITS). Bitte die Einheit der Zeichnung angeben.'),
    h('div', { class: 'form-row' }, h('label', {}, 'Positionierung'), pos),
    h('div', { class: 'form-row' }, h('label', {}, 'Farben'), colors),
    h('div', { class: 'form-row' }, h('label', {}, onlyVisible, ' Ausgeblendete Layer der Datei ausblenden')),
    sk ? h('div', { class: 'hint' }, 'Nicht übernommen: ' + sk) : null,
  );
  modal('CAD-Formate importieren', body, [
    { label: 'Öffnen', primary: true, onClick: () => {
      const u = unit.value === 'auto' ? detected! : UNITS.find((x) => x[0] === unit.value)?.[2] ?? 1;
      const vp: any = app.active;
      let offset: V2 = { x: data.base.x * u, y: data.base.y * u };
      if (pos.value === 'center') {
        const vb = vp?.visibleBox?.();
        offset = vb ? mid(vb.min, vb.max) : { x: 0, y: 0 };
      }
      const el: CadImport = {
        id: newId('ci'), cat: 'cadimport', viewId: v.id, name: file.name, unit: u, offset, rotation: 0, base: data.base, box: data.box,
        entities: data.ents, layers: data.layers, hiddenLayers: onlyVisible.checked ? data.hiddenLayers : [], colors: colors.value as CadImport['colors'],
      };
      app.doc.transaction('DXF importieren', () => app.doc.add(el));
      app.select([el.id]);
      if (pos.value === 'origin') vp?.zoomExtents?.();
      toast(`${file.name}: ${data.ents.length} Elemente importiert.`);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 480);
}
registerCommand({ id: 'importDxf', label: 'CAD importieren', icon: 'dxf', tip: 'DXF-Datei (ASCII) in die aktive Ansicht importieren (Einheiten, Blöcke, Layer)', run: () => { importDxfCmd(); } });

// ------------------------------------------------------------ Auflösen
export function explodeImport(ids: Id[]): void {
  const doc = app.doc;
  const imps = ids.map((id) => doc.get<CadImport>(id)).filter((e): e is CadImport => e?.cat === 'cadimport');
  if (!imps.length) { app.status('Bitte einen CAD-Import auswählen.'); return; }
  let n = 0; for (const c of imps) n += c.entities.length;
  if (n > 5000 && !confirm(`${n} Elemente werden in Detaillinien umgewandelt. Das kann das Projekt verlangsamen. Fortfahren?`)) return;
  const created: Id[] = [];
  let texts = 0;
  doc.transaction('Import auflösen', () => {
    for (const c of imps) {
      const keep: CadEnt[] = [];
      const add = (a: V2, b: V2, arc?: { c: V2; r: number; a0: number; a1: number }) => {
        if (!arc && Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return;
        const id = newId('li'); created.push(id);
        doc.add({ id, cat: 'line', viewId: c.viewId, a, b, style: 'thin', ...(arc ? { arc } : {}) });
      };
      const arcEnds = (cc: V2, r: number, a0: number, a1: number) => add({ x: cc.x + Math.cos(a0) * r, y: cc.y + Math.sin(a0) * r }, { x: cc.x + Math.cos(a1) * r, y: cc.y + Math.sin(a1) * r }, { c: cc, r, a0, a1 });
      cadParts({ ...c, hiddenLayers: c.hiddenLayers }, (q) => {
        switch (q.k) {
          case 'line': add(q.a, q.b); break;
          case 'poly': case 'fill': {
            const pts = q.pts; const closed = q.k === 'fill' || q.closed;
            for (let i = 0; i + 1 < pts.length; i++) add(pts[i], pts[i + 1]);
            if (closed && pts.length > 2) add(pts[pts.length - 1], pts[0]);
            break;
          }
          case 'arc': arcEnds(q.c, q.r, q.a0, q.a1); break;
          case 'circle': arcEnds(q.c, q.r, 0, Math.PI); arcEnds(q.c, q.r, Math.PI, Math.PI * 2); break;
          case 'text': keep.push(q.e); texts++; break;
        }
      });
      if (keep.length) doc.update<CadImport>(c.id, { entities: keep });
      else doc.remove(c.id);
    }
  });
  app.select(created);
  toast(`${created.length} Detaillinien erzeugt${texts ? ` – ${texts} Texte bleiben als Import erhalten` : ''}.`, 4000);
}
registerCommand({ id: 'explodeImport', label: 'Auflösen', icon: 'explode', tip: 'Ausgewählten CAD-Import in Detaillinien umwandeln (Texte bleiben als Import erhalten)', enabled: () => app.selected().some((e) => e.cat === 'cadimport'), run: () => explodeImport([...app.selection]) });
registerCommand({ id: 'cadLayers', label: 'Layer', icon: 'layers', tip: 'Layer des CAD-Imports ein-/ausblenden', enabled: () => app.selected().some((e) => e.cat === 'cadimport'), run: () => { const c = app.selected().find((e) => e.cat === 'cadimport'); if (c) layerDialog(c as CadImport); } });
registerContextPanel({ cats: ['cadimport'], panel: 'Importsymbol', items: ['explodeImport', 'cadLayers'] });
