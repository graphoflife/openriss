// Befehl «Vektorgrafik importieren» (Einfügen): DXF/SVG/PDF als Detaillinien, Füllbereiche und Texte in eine
// 2D-Ansicht (Zeichnungsansicht, Grundriss, Schnitt …) mit Optionsdialog (Zielansicht, Massstab, Seite, Layer).
import { app } from '../../app';
import type { View } from '../../core/view';
import { registerCommand } from '../../core/registry';
import { registerIcon } from '../../ui/icons';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { mid } from '../../core/geom';
import { INSUNITS_MM } from './dxfParse';
import { readVector, importVectorFrom, detectFormat, VectorImportOpts } from './vectorImport';

registerIcon('vecimport', `<path d="M5 2 H14 L19 7 V22 H5 Z" fill="#fff" stroke="currentColor"/><path d="M8 17 L11 10 L14 14 L16 11" fill="none" stroke="#2a6fd6" stroke-width="1.5"/><circle cx="8" cy="17" r="1.2" fill="#2a6fd6"/><circle cx="16" cy="11" r="1.2" fill="#2a6fd6"/>`);

const KINDS = ['drafting', 'plan', 'ceiling', 'section', 'elevation', 'legend', 'sheet'];
const KIND_LABEL: Record<string, string> = { drafting: 'Zeichnungsansicht', plan: 'Grundriss', ceiling: 'Deckenplan', section: 'Schnitt', elevation: 'Ansicht', legend: 'Legende', sheet: 'Plan' };

function pickBytes(accept: string): Promise<{ name: string; data: Uint8Array }> {
  return new Promise((res, rej) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = async () => { const f = i.files?.[0]; if (!f) return rej(new Error('Keine Datei')); res({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }); };
    i.click();
  });
}

async function importVectorCmd(): Promise<void> {
  const doc = app.doc; const act = app.activeView();
  let file: { name: string; data: Uint8Array };
  try { file = await pickBytes('.dxf,.svg,.pdf,.DXF,.SVG,.PDF'); } catch { return; }
  const ext = /\.(dxf|svg|pdf)$/i.exec(file.name)?.[1]?.toLowerCase() as 'dxf' | 'svg' | 'pdf' | undefined;
  const format = ext ?? detectFormat(file.data);
  let read: ReturnType<typeof readVector>;
  try { read = readVector(file.data, { format }); } catch (e) { alert('Die Datei konnte nicht gelesen werden: ' + (e as Error).message); return; }
  const views = doc.all<View>('view').filter((v) => KINDS.includes(v.kind)).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'de'));
  if (!views.length) { alert('Keine 2D-Ansicht vorhanden – bitte zuerst eine Zeichnungsansicht anlegen.'); return; }
  // Dialog
  const target = h('select', {}) as HTMLSelectElement;
  for (const v of views) target.append(h('option', { value: v.id }, `${KIND_LABEL[v.kind] ?? v.kind}: ${v.kind === 'sheet' ? (v.sheetNo ?? '') + ' ' : ''}${v.name}`));
  target.value = act && KINDS.includes(act.kind) ? act.id : views.find((v) => v.kind === 'drafting')?.id ?? views[0].id;
  const viewOf = () => doc.get<View>(target.value)!;
  const scale = h('input', { type: 'number', min: '0.0001', step: 'any', style: 'width:90px' }) as HTMLInputElement;
  const syncScale = () => { if (format !== 'dxf') scale.value = String(viewOf().scale || 1); };
  syncScale(); target.onchange = syncScale;
  const detected = read.cad ? INSUNITS_MM[read.cad.insunits] : undefined;
  if (format === 'dxf') scale.value = String(detected ?? 1);
  const page = h('input', { type: 'number', min: '1', max: String(read.vec?.pages ?? 1), step: '1', value: '1', style: 'width:70px' }) as HTMLInputElement;
  const pos = h('select', {}) as HTMLSelectElement;
  pos.append(h('option', { value: 'center' }, 'Mitte der Grafik in Mitte der Ansicht'), h('option', { value: 'origin' }, format === 'dxf' ? 'Ursprung zu Ursprung' : 'Seite links unten auf 0/0'));
  const cb = (label: string, on = true) => { const i = h('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = on; return { i, row: h('div', { class: 'form-row' }, h('label', {}, i, ' ' + label)) }; };
  const texts = cb('Texte übernehmen'), fills = cb('Füllungen als Füllbereiche'), masks = cb('Weisse Füllungen als Maskierungsbereiche', false);
  const layers = read.vec?.layers ?? read.cad?.layers ?? [];
  const hidden = new Set(read.cad?.hiddenLayers ?? []);
  const lchecks: [HTMLInputElement, string][] = [];
  const llist = h('div', { style: 'max-height:140px;overflow:auto;border:1px solid #c8d0d8;padding:4px' });
  for (const l of layers) { const i = h('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = !hidden.has(l); lchecks.push([i, l]); llist.append(h('div', {}, h('label', {}, i, ' ' + l))); }
  const v = read.vec; const c = read.cad;
  const stats = v ? `${v.paths.length} Pfade, ${v.texts.length} Texte${v.pages && v.pages > 1 ? `, ${v.pages} Seiten` : ''}, Seite ${Math.round(v.w)} × ${Math.round(v.h)} mm` : c ? `${c.ents.length} Elemente auf ${c.layers.length} Layern` : '';
  const body = h('div', {},
    h('div', { class: 'hint' }, `${file.name} (${format.toUpperCase()}): ${stats}`),
    h('div', { class: 'form-row' }, h('label', {}, 'Zielansicht'), target),
    h('div', { class: 'form-row' }, h('label', {}, format === 'dxf' ? 'mm je Zeichnungseinheit' : 'Massstab 1 :'), scale),
    format === 'dxf' && !detected ? h('div', { class: 'hint', style: 'color:#b06000' }, 'Die Datei enthält keine Einheit ($INSUNITS) – bitte angeben (z.B. 1000 für Meter).') : null,
    format === 'pdf' && (v?.pages ?? 1) > 1 ? h('div', { class: 'form-row' }, h('label', {}, 'Seite'), page) : null,
    h('div', { class: 'form-row' }, h('label', {}, 'Positionierung'), pos),
    texts.row, fills.row, masks.row,
    layers.length ? h('div', {}, h('div', { class: 'hint' }, 'Layer / Ebenen'), llist) : null,
    format !== 'dxf' ? h('div', { class: 'hint' }, 'Papier-mm × Massstab = Ansichts-mm. Linien erhalten Linienstile nach Farbe, Breite und Strichmuster; Bögen bleiben Bögen.') : null,
  );
  modal('Vektorgrafik importieren', body, [
    { label: 'Importieren', primary: true, onClick: () => {
      const view = viewOf(); const s = parseFloat(scale.value) || 1;
      const opts: VectorImportOpts = { format, texts: texts.i.checked, fills: fills.i.checked, masks: masks.i.checked, name: 'Vektorgrafik importieren: ' + file.name };
      if (format === 'dxf') opts.unit = s; else opts.scale = s;
      if (layers.length) { const on = lchecks.filter(([i]) => i.checked).map(([, l]) => l); if (on.length < layers.length) opts.layers = on; }
      let rd = read;
      if (format === 'pdf') { const pg = Math.max(1, parseInt(page.value, 10) || 1); opts.page = pg; if (pg !== 1) { try { rd = readVector(file.data, { format, page: pg }); } catch (e) { alert((e as Error).message); return; } } }
      if (pos.value === 'center') {
        const vb = view.id === act?.id ? (app.active as any)?.visibleBox?.() : null;
        const vc = vb ? mid(vb.min, vb.max) : { x: 0, y: 0 };
        if (rd.vec) opts.origin = { x: vc.x - (s * rd.vec.w) / 2, y: vc.y - (s * rd.vec.h) / 2 };
        else if (rd.cad) { const b = rd.cad.box; opts.origin = { x: vc.x - (rd.cad.base.x + (b.min.x + b.max.x) / 2) * s, y: vc.y - (rd.cad.base.y + (b.min.y + b.max.y) / 2) * s }; }
      }
      let r;
      try { r = importVectorFrom(doc, view.id, rd, opts); } catch (e) { console.error(e); alert('Import fehlgeschlagen: ' + (e as Error).message); return; }
      if (view.id !== act?.id) app.openView(view.id);
      app.select(r.ids);
      const sk = Object.entries(r.skipped).map(([k, n]) => `${k} ${n}`).join(', ');
      toast(`${r.lines} Detaillinien (${r.arcs} Bögen), ${r.regions} Füllbereiche, ${r.texts} Texte importiert${r.lineStyles ? `, ${r.lineStyles} neue Linienstile` : ''}.${sk ? ' Nicht übernommen: ' + sk : ''}`, 6000);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 500);
}

registerCommand({ id: 'importVector', label: 'Vektorgrafik', icon: 'vecimport', tip: 'Vektorgrafik (DXF, SVG, PDF) als bearbeitbare Detaillinien, Füllbereiche und Texte in eine 2D-Ansicht importieren', run: () => { importVectorCmd(); } });
