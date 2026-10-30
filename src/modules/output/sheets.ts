// Pläne (Blätter): Neuer Plan, Plankopf-Vorlagen (Deutschland/DIN, Schweiz) mit Revisionstabelle,
// Rahmen mit Heftrand, Display-Liste des Plans.
import { app } from '../../app';
import type { Doc, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCommand, registerDLBuilder, onHook, catDef, GROUPS, PropDef } from '../../core/registry';
import { View, projectInfo } from '../../core/view';
import { DisplayList, textWidth, Font } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { V2, boxCorners } from '../../core/geom';
import { viewElements } from '../../views/viewBuilder';
import { modal, toast, registerProjectInfoField } from '../../ui/dialogs';
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
  const sel = (opts: [string, string][], v: string) => { const e = h('select', {}) as HTMLSelectElement; for (const [k, l] of opts) e.append(h('option', { value: k }, l)); e.value = v; return e; };
  const fmt = sel(SHEET_FORMATS, formatKey(sheet));
  const tb = sel([['', `Projektvorgabe (${titleBlockLabel(projectTitleBlock(doc))})`], ...titleBlockOptions()], d.titleBlock ?? '');
  const inp = (v: string, ph = '') => h('input', { type: 'text', value: v, placeholder: ph }) as HTMLInputElement;
  const no = inp(sheet.sheetNo ?? ''), name = inp(sheet.name), sub = inp(d.subtitle ?? '');
  const drawn = inp(d.drawnBy ?? ''), checked = inp(d.checkedBy ?? ''), date = inp(d.date ?? ''), index = inp(d.index ?? '', currentIndex(sheet) || '–');
  const status = inp(d.status ?? '', pi?.status ?? ''), author = inp(d.author ?? '', pi?.author ?? ''), note = inp(d.note ?? '', elevNote(doc));
  const row = (l: string, e: HTMLElement) => h('div', { class: 'form-row' }, h('label', {}, l), e);
  const revBtn = h('button', { class: 'btn small' }, 'Revisionen…'); revBtn.onclick = () => { m.close(); revisionsDialog(sheet); };
  body.append(row('Plankopf-Vorlage', tb), row('Format', fmt), row('Plannummer', no), row('Planname (Planinhalt)', name), row('Untertitel', sub),
    row('Projektverfasser / Fachplaner', author), row('Gezeichnet', drawn), row('Geprüft', checked), row('Datum', date), row('Index', index),
    row('Planstatus / Phase', status), row('Hinweis (CH)', note), h('div', { style: 'margin:6px 0' }, revBtn),
    h('div', { class: 'hint' }, 'Bauvorhaben, Bauherr, Adresse, Projektnummer, Landesvorlage und Höhenbezug stammen aus „Verwalten › Projektinformationen“. Leerer Index = Index der letzten Revision.'));
  const m = modal('Plankopf bearbeiten', body, [
    { label: 'OK', primary: true, onClick: () => {
      const sheetNo = no.value.trim();
      if (!sheetNo || sheetNoTaken(doc, sheetNo, sheet.id)) { alert('Die Plannummer ist leer oder bereits vergeben.'); return false; }
      const opt = (v: string) => (v.trim() ? v : undefined);
      doc.transaction('Plankopf', () => doc.update<View>(sheet.id, {
        sheetNo, name: name.value.trim() || sheet.name,
        data: { ...d, ...parseFormat(fmt.value), drawnBy: drawn.value, checkedBy: checked.value, date: date.value, index: index.value, status: status.value,
          titleBlock: tb.value || undefined, subtitle: opt(sub.value), author: opt(author.value), note: opt(note.value) },
      }));
      app.refreshViews(); app.emit('views'); app.emit('view');
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 500);
}
registerCommand({
  id: 'titleblock', label: 'Plankopf', icon: 'titleblock', tip: 'Plankopf (Vorlage, Felder) und Format des aktiven Plans bearbeiten',
  enabled: () => isSheet(app.activeView()), run: () => { const v = app.activeView(); if (v && isSheet(v)) titleBlockDialog(v); },
});

// ------------------------------------------------------------ Revisionen (Revisionstabelle über dem Plankopf)
export interface Revision { index: string; date: string; text: string; by: string }
export const revisionsOf = (sheet: View): Revision[] => (Array.isArray(sheet.data?.revisions) ? sheet.data.revisions : []);
/** Angezeigter Index: Feld «Index», sonst Index der letzten Revision */
export const currentIndex = (sheet: View): string => (sheet.data?.index || revisionsOf(sheet).slice(-1)[0]?.index || '');
const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Nächster Index: 0 → 1, a → b; erster Index CH «0», sonst «a» */
export function nextRevIndex(revs: Revision[], ch: boolean): string {
  const last = revs[revs.length - 1]?.index?.trim() ?? '';
  if (!last) return revs.length ? String(revs.length) : ch ? '0' : 'a';
  if (/^\d+$/.test(last)) return String(parseInt(last, 10) + 1);
  if (/^[a-yA-Y]$/.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1);
  return last + "'";
}

/** Revision anhängen (DOM-frei, z. B. für Skripte); setzt den Plan-Index auf die neue Revision */
export function addRevision(doc: Doc, sheetId: Id, r: Partial<Revision> & { text: string }): Revision | null {
  const sheet = doc.get<View>(sheetId); if (!sheet || sheet.kind !== 'sheet') return null;
  const revs = revisionsOf(sheet);
  const rev: Revision = { index: r.index ?? nextRevIndex(revs, projectInfo(doc)?.locale === 'CH'), date: r.date ?? today(), text: r.text, by: r.by ?? sheet.data?.drawnBy ?? '' };
  doc.transaction('Revision', () => doc.update<View>(sheetId, { data: { ...(sheet.data ?? {}), revisions: [...revs, rev], index: rev.index } }));
  return rev;
}

export function revisionsDialog(sheet0: View): void {
  const doc = app.doc; const sheet = doc.get<View>(sheet0.id); if (!sheet) return;
  const revs: Revision[] = revisionsOf(sheet).map((r) => ({ ...r }));
  const ch = projectInfo(doc)?.locale === 'CH';
  const body = h('div', { style: 'min-width:620px' });
  const render = () => {
    body.innerHTML = '';
    const t = h('table', { class: 'grid', style: 'width:100%' });
    t.append(h('tr', {}, h('th', { style: 'width:60px' }, 'Index'), h('th', { style: 'width:100px' }, 'Datum'), h('th', {}, 'Änderung'), h('th', { style: 'width:70px' }, 'Gez.'), h('th', { style: 'width:30px' }, '')));
    revs.forEach((r, i) => {
      const cell = (k: keyof Revision) => { const e = h('input', { type: 'text', value: r[k] ?? '', style: 'width:100%' }) as HTMLInputElement; e.onchange = () => (r[k] = e.value); return h('td', {}, e); };
      const del = h('button', { class: 'btn small', title: 'Revision löschen' }, '×'); del.onclick = () => { revs.splice(i, 1); render(); };
      t.append(h('tr', {}, cell('index'), cell('date'), cell('text'), cell('by'), h('td', {}, del)));
    });
    if (!revs.length) t.append(h('tr', {}, h('td', { colspan: '5', style: 'text-align:center;color:#666' }, 'Keine Revisionen')));
    const add = h('button', { class: 'btn small' }, 'Neue Revision');
    add.onclick = () => { revs.push({ index: nextRevIndex(revs, ch), date: today(), text: revs.length ? '' : 'Erstausgabe', by: sheet.data?.drawnBy ?? '' }); render(); };
    body.append(t, h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, add),
      h('div', { class: 'hint' }, 'Die Revisionstabelle steht über dem Plankopf (älteste oben). Der Plan-Index folgt der letzten Revision.'));
  };
  render();
  modal(`Revisionen – ${sheet.sheetNo ?? ''} ${sheet.name}`, body, [
    { label: 'OK', primary: true, onClick: () => {
      const cur = doc.get<View>(sheet.id); if (!cur) return;
      const clean = revs.filter((r) => r.index.trim() || r.text.trim());
      doc.transaction('Revisionen', () => doc.update<View>(sheet.id, { data: { ...(cur.data ?? {}), revisions: clean.length ? clean : undefined, index: clean.length ? clean[clean.length - 1].index : cur.data?.index ?? '' } }));
      app.refreshViews(); app.emit('views'); app.emit('view');
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 680);
}
registerCommand({
  id: 'revisions', label: 'Revisionen', icon: 'titleblock', tip: 'Revisionstabelle des aktiven Plans bearbeiten (Index, Datum, Änderung, Gez.)',
  enabled: () => isSheet(app.activeView()), run: () => { const v = app.activeView(); if (v && isSheet(v)) revisionsDialog(v); },
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
    field('subtitle', 'Untertitel'), field('drawnBy', 'Gezeichnet'), field('checkedBy', 'Geprüft'), field('date', 'Plandatum'), field('index', 'Index'), field('status', 'Planstatus / Phase'),
    { key: 'titleBlock', label: 'Plankopf-Vorlage', group: g.other, type: 'select', options: () => [['', `Projektvorgabe (${titleBlockLabel(projectTitleBlock(doc))})`], ...titleBlockOptions()],
      get: (e) => e.data?.titleBlock ?? '', set: (e, x) => ({ data: { ...(e.data ?? {}), titleBlock: x || undefined } }) },
    { key: 'format', label: 'Plankopf (Format)', group: g.other, type: 'select', options: SHEET_FORMATS, get: (e) => formatKey(e as View), set: (e, x) => ({ data: { ...(e.data ?? {}), ...parseFormat(x) } }) },
    { key: 'scaleTxt', label: 'Maßstab', group: g.other, type: 'readonly', get: (e, d) => sheetScaleText(d, e as View) },
    { key: 'tb', label: 'Plankopf', group: g.other, type: 'button', get: () => 'Bearbeiten…', action: (e) => titleBlockDialog(e as View) },
    { key: 'revs', label: 'Revisionen', group: g.other, type: 'button', get: (e) => `Bearbeiten… (${revisionsOf(e as View).length})`, action: (e) => revisionsDialog(e as View) },
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
  titleBlockDef(titleBlockOf(doc, sheet)).draw(dl, doc, sheet, { x: fx1, y: fy0 }, fx1 - fx0);
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
const rect = (dl: DisplayList, x0: number, y0: number, x1: number, y1: number, pen: Pen = THIN) =>
  dl.poly(boxCorners({ min: { x: x0, y: y0 }, max: { x: x1, y: y1 } }), pen, true, { ns: true });

// ------------------------------------------------------------ Plankopf-Vorlagen
/** Plankopf: zeichnet unten rechts (corner = rechte untere Rahmenecke, Papier-mm) */
export interface TitleBlockDef { id: string; label: string; draw: (dl: DisplayList, doc: Doc, sheet: View, corner: V2, frameW: number) => void }
const TITLE_BLOCKS: TitleBlockDef[] = [];
export function registerTitleBlock(def: TitleBlockDef): void {
  const i = TITLE_BLOCKS.findIndex((t) => t.id === def.id);
  if (i >= 0) TITLE_BLOCKS[i] = def; else TITLE_BLOCKS.push(def);
}
export const titleBlockOptions = (): [string, string][] => TITLE_BLOCKS.map((t) => [t.id, t.label]);
const titleBlockDef = (id: string): TitleBlockDef => TITLE_BLOCKS.find((t) => t.id === id) ?? TITLE_BLOCKS[0];
const titleBlockLabel = (id: string): string => titleBlockDef(id)?.label ?? id;
/** Projektvorgabe: ProjectInfo.titleBlock, sonst nach Landesvorlage (CH → «Schweiz») */
export function projectTitleBlock(doc: Doc): string {
  const pi = projectInfo(doc);
  if (pi?.titleBlock && TITLE_BLOCKS.some((t) => t.id === pi.titleBlock)) return pi.titleBlock;
  return pi?.locale === 'CH' ? 'ch' : 'din';
}
/** Plankopf eines Plans: eigene Wahl, sonst Projektvorgabe */
export function titleBlockOf(doc: Doc, sheet: View): string {
  const t = sheet.data?.titleBlock;
  return t && TITLE_BLOCKS.some((x) => x.id === t) ? t : projectTitleBlock(doc);
}
/** Hinweis «Masse in m, Koten bezogen auf ±0.00 = … m ü. M.» */
export function elevNote(doc: Doc): string {
  const z = projectInfo(doc)?.elev00;
  return z === undefined || z === null || !isFinite(z) ? 'Masse in m' : `Masse in m, Koten bezogen auf ±0.00 = ${z.toFixed(2)} m ü. M.`;
}

/** Revisionstabelle (Index, Datum, Änderung, Gez.) ab Unterkante y; älteste oben. Gibt die Oberkante zurück. */
function drawRevisions(dl: DisplayList, x0: number, x1: number, y: number, revs: Revision[], always: boolean): number {
  if (!revs.length && !always) return y;
  const zh = 4.2; const H = zh * (revs.length + 1); const u = (x1 - x0) / 180;
  dl.fill([boxCorners({ min: { x: x0, y }, max: { x: x1, y: y + H } })], { color: '#ffffff' }, THIN, { ns: true });
  const cx = [x0 + 2, x0 + 12 * u, x0 + 32 * u];
  const hf: Font = { size: 2.3, bold: true };
  const hy = y + zh * revs.length + 1.3;
  dl.text({ x: cx[0], y: hy }, 'Index', hf); dl.text({ x: cx[1], y: hy }, 'Datum', hf); dl.text({ x: cx[2], y: hy }, 'Änderung', hf);
  dl.text({ x: x1 - 2, y: hy }, 'Gez.', { ...hf, ha: 'right' });
  revs.slice().reverse().forEach((r, i) => {
    const ty = y + zh * i + 1.3; const f: Font = { size: 2.3 };
    fitText(dl, { x: cx[0], y: ty }, r.index ?? '', cx[1] - cx[0] - 1, f);
    fitText(dl, { x: cx[1], y: ty }, r.date ?? '', cx[2] - cx[1] - 1, f);
    fitText(dl, { x: cx[2], y: ty }, r.text ?? '', x1 - 14 - cx[2], f);
    fitText(dl, { x: x1 - 2, y: ty }, r.by ?? '', 11, { ...f, ha: 'right' });
  });
  return y + H;
}

/** Deutscher Plankopf unten rechts (Ecke = rechte untere Rahmenecke) */
function drawTitleBlockDIN(dl: DisplayList, doc: Doc, sheet: View, corner: V2, frameW: number): void {
  const pi = projectInfo(doc); const d = sheet.data ?? {};
  const W = Math.min(180, frameW);
  const x0 = corner.x - W, x1 = corner.x;
  const LBL: Font = { size: 1.8, color: '#404040' };
  const cell = (x: number, y: number, cw: number, ch: number, label: string, value: string, size = 3, bold = false) => {
    rect(dl, x, y, x + cw, y + ch);
    dl.text({ x: x + 1.5, y: y + ch - 1.2 }, label, { ...LBL, va: 'top' });
    fitText(dl, { x: x + 2, y: y + Math.min(2.5, ch * 0.25) }, value, cw - 4, { size, bold });
  };
  // Zeilen von unten nach oben
  let y = corner.y;
  const u = W / 180; // Spaltenraster skaliert bei schmalem Rahmen (A4 hoch)
  cell(x0, y, 120 * u, 10, 'Entwurfsverfasser', d.author || pi?.author || '', 2.8);
  cell(x0 + 120 * u, y, 60 * u, 10, 'Format', `${d.size ?? 'A1'} ${d.portrait ? 'hoch' : 'quer'}  ${sheetSize(sheet).w} × ${sheetSize(sheet).h}`, 2.2);
  y += 10;
  cell(x0, y, 45 * u, 10, 'Datum', d.date ?? pi?.date ?? '', 2.6);
  cell(x0 + 45 * u, y, 45 * u, 10, 'Gezeichnet', d.drawnBy ?? '', 2.6);
  cell(x0 + 90 * u, y, 45 * u, 10, 'Geprüft', d.checkedBy ?? '', 2.6);
  cell(x0 + 135 * u, y, 45 * u, 10, 'Planstatus', d.status || pi?.status || '', 2.6);
  y += 10;
  cell(x0, y, 60 * u, 12, 'Plan-Nr.', sheet.sheetNo ?? '', 5, true);
  cell(x0 + 60 * u, y, 40 * u, 12, 'Maßstab', sheetScaleText(doc, sheet), 3.5);
  cell(x0 + 100 * u, y, 20 * u, 12, 'Index', currentIndex(sheet), 3.5, true);
  cell(x0 + 120 * u, y, 60 * u, 12, 'Projekt-Nr.', pi?.number ?? '', 3.5);
  y += 12;
  if (d.subtitle) {
    cell(x0, y, W, 14, 'Planinhalt', '', 4.5, true);
    fitText(dl, { x: x0 + 2, y: y + 5.6 }, sheet.name, W - 4, { size: 3.8, bold: true });
    fitText(dl, { x: x0 + 2, y: y + 1.8 }, d.subtitle, W - 4, { size: 2.4 });
  } else cell(x0, y, W, 14, 'Planinhalt', sheet.name, 4.5, true);
  y += 14;
  cell(x0, y, W, 10, 'Bauherr', pi?.client ?? '', 3);
  y += 10;
  rect(dl, x0, y, x1, y + 18);
  dl.text({ x: x0 + 1.5, y: y + 18 - 1.2 }, 'Bauvorhaben / Projekt', { ...LBL, va: 'top' });
  fitText(dl, { x: x0 + 2, y: y + 7 }, pi?.name ?? '', W - 4, { size: 4.5, bold: true });
  fitText(dl, { x: x0 + 2, y: y + 2.5 }, pi?.address ?? '', W - 4, { size: 2.6 });
  y += 18;
  // kräftiger Außenrand des Plankopfs
  rect(dl, x0, corner.y, x1, y, BOLD);
  drawRevisions(dl, x0, x1, y, revisionsOf(sheet), false);
}

/**
 * Schweizer Plankopf (180 × 62 mm): Projekt, Bauherrschaft, Projektverfasser/Fachplaner, Planinhalt,
 * Massstab/Datum/Gez./Gepr./Format/Phase, Projekt-Nr. mit Hinweis zum Höhenbezug, Plan-Nr. und Index;
 * Revisionstabelle darüber.
 */
function drawTitleBlockCH(dl: DisplayList, doc: Doc, sheet: View, corner: V2, frameW: number): void {
  const pi = projectInfo(doc); const d = sheet.data ?? {};
  const W = Math.min(180, frameW); const u = W / 180; const HK = 62;
  const x0 = corner.x - W, x1 = corner.x, y0 = corner.y, yT = y0 + HK, yP = y0 + 18.5;
  const GREY = '#8c8c8c';
  const lbl = (x: number, yTop: number, s: string) => dl.text({ x: x + 1.5, y: yTop - 0.9 }, s, { size: 1.9, color: GREY, va: 'top' });
  dl.fill([boxCorners({ min: { x: x0, y: y0 }, max: { x: x1, y: yT } })], { color: '#ffffff' }, undefined, { ns: true });
  // Kopfzeilen
  const rows: [number, number, string, string][] = [
    [yT - 10.5, yT, 'Projekt', [pi?.name, pi?.address].filter(Boolean).join(' – ')],
    [yT - 18.5, yT - 10.5, 'Bauherrschaft', pi?.client ?? ''],
    [yT - 26.5, yT - 18.5, 'Projektverfasser / Fachplaner', d.author || pi?.author || ''],
  ];
  for (const [ya, yb, l, v] of rows) {
    dl.line({ x: x0, y: ya }, { x: x1, y: ya }, THIN, { ns: true });
    lbl(x0, yb, l);
    fitText(dl, { x: x0 + 2, y: ya + 1.6 }, v, W - 4, { size: 3.1 });
  }
  // Planinhalt
  lbl(x0, yT - 26.5, 'Planinhalt');
  fitText(dl, { x: x0 + 2, y: yP + (d.subtitle ? 5.6 : 3.6) }, sheet.name, W - 4, { size: 4.6, bold: true });
  if (d.subtitle) fitText(dl, { x: x0 + 2, y: yP + 1.6 }, d.subtitle, W - 4, { size: 2.7 });
  // Feldzeile
  const scale = sheetScaleText(doc, sheet).replace(' : ', ':');
  const fmt = `${d.size ?? 'A1'}${d.portrait ? ' hoch' : ''}`;
  const fields: [string, string][] = [['Massstab', scale], ['Datum', d.date || pi?.date || ''], ['Gez.', d.drawnBy ?? ''], ['Gepr.', d.checkedBy || '—'], ['Format', fmt], ['Phase', d.status || pi?.status || '']];
  const wL = 85 * u; const bw = wL / fields.length;
  fields.forEach(([l, v], i) => {
    const x = x0 + i * bw;
    rect(dl, x, y0 + 9, x + bw, yP);
    lbl(x - 0.6, yP, l);
    fitText(dl, { x: x + 1, y: y0 + 10.8 }, v, bw - 1.6, { size: 2.9 });
  });
  rect(dl, x0, y0, x0 + wL, y0 + 9);
  fitText(dl, { x: x0 + 2, y: y0 + 5.2 }, pi?.number ? `Projekt-Nr. ${pi.number}` : '', wL - 4, { size: 2.5 });
  fitText(dl, { x: x0 + 2, y: y0 + 1.8 }, d.note ?? elevNote(doc), wL - 4, { size: 2.0 });
  // Plan-Nr. und Index
  const xa = x0 + wL, xb = x0 + 155 * u;
  rect(dl, xa, y0, xb, yP, BOLD); lbl(xa + 0.5, yP, 'Plan-Nr.');
  fitText(dl, { x: (xa + xb) / 2, y: y0 + 4.5 }, sheet.sheetNo ?? '', xb - xa - 4, { size: 8, bold: true, ha: 'center' });
  rect(dl, xb, y0, x1, yP, BOLD); lbl(xb + 0.5, yP, 'Index');
  fitText(dl, { x: (xb + x1) / 2, y: y0 + 4.5 }, currentIndex(sheet), x1 - xb - 3, { size: 8, bold: true, ha: 'center' });
  rect(dl, x0, y0, x1, yT, BOLD);
  drawRevisions(dl, x0, x1, yT, revisionsOf(sheet), true);
}

registerTitleBlock({ id: 'din', label: 'Deutschland (DIN)', draw: drawTitleBlockDIN });
registerTitleBlock({ id: 'ch', label: 'Schweiz', draw: drawTitleBlockCH });

// Projektvorgabe der Plankopf-Vorlage in «Projektinformationen»
registerProjectInfoField({
  key: 'titleBlock', label: 'Plankopf-Vorlage', options: [['', 'Nach Landesvorlage'], ...titleBlockOptions()],
  get: (pi) => pi.titleBlock ?? '', set: (pi, v) => { pi.titleBlock = v || undefined; },
});
