// Pläne (Blätter): Neuer Plan, Plankopf nach DIN-Formaten, Rahmen mit Heftrand, Display-Liste des Plans.
import { app } from '../../app';
import type { Doc } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCommand, registerDLBuilder, onHook, catDef, GROUPS, PropDef } from '../../core/registry';
import { View, projectInfo } from '../../core/view';
import { DisplayList, textWidth, Font } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { V2, boxCorners } from '../../core/geom';
import { viewElements } from '../../views/viewBuilder';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { DIN, SHEET_FORMATS, sheetSize, formatKey, parseFormat, extendViewProps, isSheet } from './common';

// ------------------------------------------------------------ Nummerierung
export function nextSheetNo(doc: Doc): string {
  const nos = doc.all<View>('view').filter((v) => v.kind === 'sheet').map((v) => v.sheetNo ?? '');
  const last = nos.filter((n) => /\d+$/.test(n)).sort((a, b) => a.localeCompare(b, 'de', { numeric: true })).pop();
  if (!last) return 'A-101';
  const m = last.match(/^(.*?)(\d+)$/)!;
  let n = parseInt(m[2], 10);
  let cand = '';
  do { n++; cand = m[1] + String(n).padStart(m[2].length, '0'); } while (nos.includes(cand));
  return cand;
}
export const sheetNoTaken = (doc: Doc, no: string, except?: string) => doc.all<View>('view').some((v) => v.kind === 'sheet' && v.id !== except && v.sheetNo === no);

// ------------------------------------------------------------ Neuer Plan
export function newSheetDialog(): void {
  const doc = app.doc;
  const body = h('div', {});
  const list = h('select', { size: '10', style: 'width:100%' }) as HTMLSelectElement;
  for (const [k, l] of SHEET_FORMATS) list.append(h('option', { value: k }, `${l}  (${DIN[k.slice(0, 2)].join(' × ')} mm)`));
  list.value = 'A1q';
  const no = h('input', { type: 'text', value: nextSheetNo(doc) }) as HTMLInputElement;
  const name = h('input', { type: 'text', value: 'Ohne Namen' }) as HTMLInputElement;
  body.append(
    h('div', { class: 'hint' }, 'Plankopf wählen:'), list,
    h('div', { class: 'form-row' }, h('label', {}, 'Plannummer'), no),
    h('div', { class: 'form-row' }, h('label', {}, 'Planname'), name),
  );
  const ok = (): boolean | void => {
    const sheetNo = no.value.trim();
    if (!sheetNo) { alert('Bitte eine Plannummer eingeben.'); return false; }
    if (sheetNoTaken(doc, sheetNo)) { alert(`Die Plannummer „${sheetNo}“ ist bereits vergeben.`); return false; }
    createSheet(list.value || 'A1q', sheetNo, name.value.trim() || 'Ohne Namen');
  };
  list.ondblclick = () => { if (ok() !== false) m.close(); };
  const m = modal('Neuer Plan', body, [{ label: 'OK', primary: true, onClick: ok }, { label: 'Abbrechen', onClick: () => {} }], 420);
}

export function createSheet(format: string, sheetNo: string, name: string): string {
  const doc = app.doc; const pi = projectInfo(doc);
  const id = newId('vw');
  doc.transaction('Neuer Plan', () => doc.add<View>({
    id, cat: 'view', kind: 'sheet', name, sheetNo, scale: 1, detail: 'medium',
    data: { ...parseFormat(format), drawnBy: pi?.author ?? '', checkedBy: '', date: new Date().toLocaleDateString('de-DE'), index: '' },
  } as View));
  app.emit('views');
  app.openView(id);
  toast(`Plan ${sheetNo} - ${name} erstellt.`);
  return id;
}

registerCommand({ id: 'sheet', label: 'Plan', icon: 'sheet', tip: 'Neuen Plan mit Plankopf (DIN A0–A4) erstellen', run: newSheetDialog });
onHook('newSheet', newSheetDialog);

// ------------------------------------------------------------ Plankopf-Dialog (titleblock)
export function titleBlockDialog(sheet: View): void {
  const doc = app.doc; const pi = projectInfo(doc);
  const d = { ...(sheet.data ?? {}) };
  const body = h('div', {});
  const fmt = h('select', {}) as HTMLSelectElement;
  for (const [k, l] of SHEET_FORMATS) fmt.append(h('option', { value: k }, l));
  fmt.value = formatKey(sheet);
  const inp = (v: string) => h('input', { type: 'text', value: v }) as HTMLInputElement;
  const no = inp(sheet.sheetNo ?? ''), name = inp(sheet.name);
  const drawn = inp(d.drawnBy ?? ''), checked = inp(d.checkedBy ?? ''), date = inp(d.date ?? ''), index = inp(d.index ?? ''), status = inp(d.status ?? '');
  status.placeholder = pi?.status ?? '';
  const row = (l: string, e: HTMLElement) => h('div', { class: 'form-row' }, h('label', {}, l), e);
  body.append(row('Plankopf / Format', fmt), row('Plannummer', no), row('Planname (Planinhalt)', name), row('Gezeichnet', drawn), row('Geprüft', checked),
    row('Datum', date), row('Index', index), row('Planstatus', status),
    h('div', { class: 'hint' }, 'Bauvorhaben, Bauherr, Adresse und Projektnummer stammen aus „Verwalten › Projektinformationen“.'));
  modal('Plankopf bearbeiten', body, [
    { label: 'OK', primary: true, onClick: () => {
      const sheetNo = no.value.trim();
      if (!sheetNo || sheetNoTaken(doc, sheetNo, sheet.id)) { alert('Die Plannummer ist leer oder bereits vergeben.'); return false; }
      doc.transaction('Plankopf', () => doc.update<View>(sheet.id, {
        sheetNo, name: name.value.trim() || sheet.name,
        data: { ...d, ...parseFormat(fmt.value), drawnBy: drawn.value, checkedBy: checked.value, date: date.value, index: index.value, status: status.value },
      }));
      app.refreshViews(); app.emit('views'); app.emit('view');
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 460);
}
registerCommand({
  id: 'titleblock', label: 'Plankopf', icon: 'titleblock', tip: 'Plankopf und Format des aktiven Plans bearbeiten',
  enabled: () => isSheet(app.activeView()), run: () => { const v = app.activeView(); if (v && isSheet(v)) titleBlockDialog(v); },
});

// ------------------------------------------------------------ Eigenschaften des Plans
extendViewProps('sheet', (v, doc, base) => {
  const g = GROUPS;
  const field = (key: string, label: string): PropDef => ({
    key, label, group: g.identity, type: 'text', get: (e) => e.data?.[key] ?? '', set: (e, x) => ({ data: { ...(e.data ?? {}), [key]: x } }),
  });
  const p: PropDef[] = base.filter((x) => x.key !== 'titleOnSheet').map((x) => (x.key === 'name' ? { ...x, label: 'Planname' } : x));
  p.push(
    { key: 'sheetNo', label: 'Plannummer', group: g.identity, type: 'text', get: (e) => e.sheetNo ?? '', set: (e, x) => {
      const s = String(x).trim();
      if (!s || sheetNoTaken(doc, s, e.id)) { alert('Die Plannummer ist leer oder bereits vergeben.'); return; }
      return { sheetNo: s };
    } },
    field('drawnBy', 'Gezeichnet'), field('checkedBy', 'Geprüft'), field('date', 'Plandatum'), field('index', 'Index'), field('status', 'Planstatus'),
    { key: 'format', label: 'Plankopf (Format)', group: g.other, type: 'select', options: SHEET_FORMATS, get: (e) => formatKey(e as View), set: (e, x) => ({ data: { ...(e.data ?? {}), ...parseFormat(x) } }) },
    { key: 'scaleTxt', label: 'Maßstab', group: g.other, type: 'readonly', get: (e, d) => sheetScaleText(d, e as View) },
    { key: 'tb', label: 'Plankopf', group: g.other, type: 'button', get: () => 'Bearbeiten…', action: (e) => titleBlockDialog(e as View) },
  );
  void v;
  return p;
});

// ------------------------------------------------------------ Maßstab aus Ansichtsfenstern
export function sheetScaleText(doc: Doc, sheet: View): string {
  const scales = new Set<number>();
  for (const vp of doc.all('viewport')) {
    if (vp.viewId !== sheet.id) continue;
    const v = doc.get<View>(vp.refId);
    if (v && v.kind !== 'schedule' && v.kind !== 'legend') scales.add(v.scale);
  }
  if (!scales.size) return '';
  if (scales.size > 1) return 'Wie angegeben';
  return '1 : ' + [...scales][0];
}

// ------------------------------------------------------------ Display-Liste des Plans
const FRAME_L = 20, FRAME_O = 5; // Heftrand links, sonst 5 mm (DIN 824)
const THIN: Pen = { w: 2 }, BOLD: Pen = { w: 5 };

registerDLBuilder('sheet', (doc, sheet) => {
  const dl = new DisplayList(1);
  const { w, h: H } = sheetSize(sheet);
  const paper = boxCorners({ min: { x: 0, y: 0 }, max: { x: w, y: H } });
  dl.begin(null);
  dl.fill([paper], { color: '#ffffff' }, undefined, { ns: true, sub: 'paperEdge' });
  dl.poly(paper, { w: 1, color: '#7a8088' }, true, { ns: true, sub: 'paperEdge' });
  // Rahmen
  const fx0 = FRAME_L, fy0 = FRAME_O, fx1 = w - FRAME_O, fy1 = H - FRAME_O;
  dl.poly(boxCorners({ min: { x: fx0, y: fy0 }, max: { x: fx1, y: fy1 } }), { w: 6 }, true);
  // Faltmarken / Heftrand-Markierung (kurze Striche am Papierrand)
  dl.line({ x: 0, y: H / 2 }, { x: 5, y: H / 2 }, { w: 1 }, { ns: true });
  drawTitleBlock(dl, doc, sheet, { x: fx1, y: fy0 }, fx1 - fx0);
  // Ansichtsfenster und Beschriftungen auf dem Plan
  const { annos } = viewElements(doc, sheet);
  annos.sort((a, b) => (catDef(a.cat)?.planOrder ?? 50) - (catDef(b.cat)?.planOrder ?? 50));
  for (const el of annos) {
    dl.begin(el.id);
    try { catDef(el.cat)?.drawAnnotation?.(dl, el, doc, sheet); } catch (e) { console.warn('Plan-Zeichenfehler', el.cat, e); }
    dl.clip(null);
  }
  dl.begin(null);
  return dl;
});

/** Text, der in eine Zelle passt (Schriftgröße wird bei Bedarf verkleinert) */
function fitText(dl: DisplayList, p: V2, s: string, maxW: number, font: Font): void {
  if (!s) return;
  const lines = s.split('\n');
  const w = Math.max(...lines.map((l) => textWidth(l, font.size * (font.bold ? 1.08 : 1))));
  const size = w > maxW && w > 0 ? Math.max(1.2, (font.size * maxW) / w) : font.size;
  dl.text(p, s, { ...font, size });
}

/** Deutscher Plankopf unten rechts (Ecke = rechte untere Rahmenecke) */
function drawTitleBlock(dl: DisplayList, doc: Doc, sheet: View, corner: V2, frameW: number): void {
  const pi = projectInfo(doc); const d = sheet.data ?? {};
  const W = Math.min(180, frameW);
  const x0 = corner.x - W, x1 = corner.x;
  const LBL: Font = { size: 1.8, color: '#404040' };
  const cell = (x: number, y: number, cw: number, ch: number, label: string, value: string, size = 3, bold = false) => {
    dl.poly(boxCorners({ min: { x, y }, max: { x: x + cw, y: y + ch } }), THIN, true, { ns: true });
    dl.text({ x: x + 1.5, y: y + ch - 1.2 }, label, { ...LBL, va: 'top' });
    fitText(dl, { x: x + 2, y: y + Math.min(2.5, ch * 0.25) }, value, cw - 4, { size, bold });
  };
  // Zeilen von unten nach oben
  let y = corner.y;
  const u = W / 180; // Spaltenraster skaliert bei schmalem Rahmen (A4 hoch)
  cell(x0, y, 120 * u, 10, 'Entwurfsverfasser', pi?.author ?? '', 2.8);
  cell(x0 + 120 * u, y, 60 * u, 10, 'Format', `${d.size ?? 'A1'} ${d.portrait ? 'hoch' : 'quer'}  ${sheetSize(sheet).w} × ${sheetSize(sheet).h}`, 2.2);
  y += 10;
  cell(x0, y, 45 * u, 10, 'Datum', d.date ?? pi?.date ?? '', 2.6);
  cell(x0 + 45 * u, y, 45 * u, 10, 'Gezeichnet', d.drawnBy ?? '', 2.6);
  cell(x0 + 90 * u, y, 45 * u, 10, 'Geprüft', d.checkedBy ?? '', 2.6);
  cell(x0 + 135 * u, y, 45 * u, 10, 'Planstatus', d.status || pi?.status || '', 2.6);
  y += 10;
  cell(x0, y, 60 * u, 12, 'Plan-Nr.', sheet.sheetNo ?? '', 5, true);
  cell(x0 + 60 * u, y, 40 * u, 12, 'Maßstab', sheetScaleText(doc, sheet), 3.5);
  cell(x0 + 100 * u, y, 20 * u, 12, 'Index', d.index ?? '', 3.5, true);
  cell(x0 + 120 * u, y, 60 * u, 12, 'Projekt-Nr.', pi?.number ?? '', 3.5);
  y += 12;
  cell(x0, y, W, 14, 'Planinhalt', sheet.name, 4.5, true);
  y += 14;
  cell(x0, y, W, 10, 'Bauherr', pi?.client ?? '', 3);
  y += 10;
  dl.poly(boxCorners({ min: { x: x0, y }, max: { x: x1, y: y + 18 } }), THIN, true, { ns: true });
  dl.text({ x: x0 + 1.5, y: y + 18 - 1.2 }, 'Bauvorhaben / Projekt', { ...LBL, va: 'top' });
  fitText(dl, { x: x0 + 2, y: y + 7 }, pi?.name ?? '', W - 4, { size: 4.5, bold: true });
  fitText(dl, { x: x0 + 2, y: y + 2.5 }, pi?.address ?? '', W - 4, { size: 2.6 });
  y += 18;
  // kräftiger Außenrand des Plankopfs
  dl.poly(boxCorners({ min: { x: x0, y: corner.y }, max: { x: x1, y } }), BOLD, true);
}
