// DXF-Export (aktive Ansicht/Plan) und DXF-Import als ansichtsspezifisches Element 'cadimport'
// (halbton/schwarzweiß/farbig, als Einheit wählbar, verschiebbar, fixierbar; Auflösen in Detaillinien mit Linienstilen,
// Füllbereiche und Texte).
import { app } from '../../app';
import type { Doc, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, registerContextPanel, catDef, GROUPS, PropDef } from '../../core/registry';
import { View, annoViewId } from '../../core/view';
import { DisplayList, Prim, Font } from '../../render/displayList';
import { OBJECT_STYLES, Pen } from '../../render/styles';
import { V2, I2, apply, compose, matScale, matAngle, isMirror, mid } from '../../core/geom';
import { fmtNum } from '../../core/units';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { writeDxf, nearestAci, rgbOf } from './dxfWrite';
import { linePen, lineStyleLabel, lineStyleOfPrim } from '../../elements/datums';
import { parseDxf, decodeDxf, CadEnt, CadData, INSUNITS_MM } from './dxfParse';
import { pageOf, fileBase } from './common';
import { CadImport, cadXf, aciHex, cadParts, cadToVec } from './cadGeom';
import { buildVector, VectorImportResult } from './vectorImport';

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
export type { CadImport, Part } from './cadGeom';
export { cadXf, aciHex, cadParts } from './cadGeom';

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
      { key: 'explode', label: 'Auflösen', group: g.other, type: 'button', get: () => 'In Detailelemente auflösen…', action: (e) => explodeImport([e.id]) },
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
        id: newId('ci'), cat: 'cadimport', viewId: annoViewId(app.doc, v), name: file.name, unit: u, offset, rotation: 0, base: data.base, box: data.box,
        entities: data.ents, layers: data.layers, hiddenLayers: onlyVisible.checked ? data.hiddenLayers : [], colors: colors.value as CadImport['colors'],
      };
      if (data.ltypes.length) el.ltypes = data.ltypes;
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
/**
 * CAD-Importe in Detaillinien (Linienstil je Farbe/Linientyp/Linienstärke, Bögen bleiben Bögen), Füllbereiche
 * (Vollfüllungen, Typ je Farbe) und Texte (Typ je Höhe/Farbe) umwandeln; der Import wird entfernt. DOM-frei.
 * Farben: Farbmodus des Imports («Beibehalten» → Farben der Datei, sonst schwarz) oder keepColors.
 */
export function explodeCad(doc: Doc, ids: Id[], o: { keepColors?: boolean; texts?: boolean; fills?: boolean } = {}): VectorImportResult | null {
  const imps = ids.map((id) => doc.get<CadImport>(id)).filter((e): e is CadImport => e?.cat === 'cadimport');
  if (!imps.length) return null;
  return doc.transaction('Import auflösen', () => {
    let tot: VectorImportResult | null = null;
    for (const c of imps) {
      const view = doc.get<View>(c.viewId); if (!view) continue;
      const r = buildVector(doc, view, cadToVec(c, view.scale || 1, o.keepColors ?? c.colors === 'keep'), { xf: I2, textK: 1 / (view.scale || 1), texts: o.texts, fills: o.fills });
      doc.remove(c.id);
      if (!tot) tot = r;
      else {
        tot.lines += r.lines; tot.arcs += r.arcs; tot.regions += r.regions; tot.texts += r.texts; tot.lineStyles += r.lineStyles; tot.types += r.types; tot.ids.push(...r.ids);
        for (const [k, n] of Object.entries(r.skipped)) tot.skipped[k] = (tot.skipped[k] ?? 0) + n;
      }
    }
    return tot;
  });
}

export function explodeImport(ids: Id[]): void {
  const doc = app.doc;
  const imps = ids.map((id) => doc.get<CadImport>(id)).filter((e): e is CadImport => e?.cat === 'cadimport');
  if (!imps.length) { app.status('Bitte einen CAD-Import auswählen.'); return; }
  let n = 0; for (const c of imps) n += c.entities.length;
  if (n > 5000 && !confirm(`${n} Elemente werden in Detaillinien, Füllbereiche und Texte umgewandelt. Das kann das Projekt verlangsamen. Fortfahren?`)) return;
  const r = explodeCad(doc, imps.map((c) => c.id));
  if (!r) return;
  app.select(r.ids);
  toast(`${r.lines} Detaillinien, ${r.regions} Füllbereiche, ${r.texts} Texte erzeugt${r.lineStyles ? ` – ${r.lineStyles} neue Linienstile` : ''}.`, 4000);
}
registerCommand({ id: 'explodeImport', label: 'Auflösen', icon: 'explode', tip: 'Ausgewählten CAD-Import in Detaillinien (mit Linienstilen), Füllbereiche und Texte umwandeln', enabled: () => app.selected().some((e) => e.cat === 'cadimport'), run: () => explodeImport([...app.selection]) });
registerCommand({ id: 'cadLayers', label: 'Layer', icon: 'layers', tip: 'Layer des CAD-Imports ein-/ausblenden', enabled: () => app.selected().some((e) => e.cat === 'cadimport'), run: () => { const c = app.selected().find((e) => e.cat === 'cadimport'); if (c) layerDialog(c as CadImport); } });
registerContextPanel({ cats: ['cadimport'], panel: 'Importsymbol', items: ['explodeImport', 'cadLayers'] });
