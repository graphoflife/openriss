// Befehle „PDF“ (aktiver Plan/aktive Ansicht) und „Alle Pläne als PDF“ – direkter Download, ohne Druckdialog.
import { app } from '../../app';
import { registerCommand } from '../../core/registry';
import type { Id } from '../../core/doc';
import type { View } from '../../core/view';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { printable, fileBase } from './common';
import { sheetsToPdfAsync } from './pdf';

const sheetsSorted = (): View[] => app.doc.all<View>('view').filter((v) => v.kind === 'sheet')
  .sort((a, b) => (a.sheetNo ?? '').localeCompare(b.sheetNo ?? '', 'de', { numeric: true }) || a.name.localeCompare(b.name, 'de'));

let busy = false;
/** PDF erzeugen und herunterladen */
export async function downloadPdf(ids: Id[], name: string, monochrome = false): Promise<void> {
  if (busy) { app.status('PDF wird bereits erstellt …'); return; }
  busy = true;
  app.status(`PDF wird erstellt (${ids.length} ${ids.length === 1 ? 'Seite' : 'Seiten'}) …`);
  try {
    await new Promise((r) => setTimeout(r, 30)); // Statuszeile zeichnen lassen
    const t0 = performance.now();
    const bytes = await sheetsToPdfAsync(app.doc, ids, { monochrome, title: name });
    download(name.replace(/[\\/:*?"<>|]+/g, '_') + '.pdf', new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    app.status(`PDF erstellt: ${ids.length} ${ids.length === 1 ? 'Seite' : 'Seiten'}, ${(bytes.length / 1048576).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.error(e);
    alert('PDF-Export fehlgeschlagen: ' + (e as Error).message);
  } finally { busy = false; }
}

registerCommand({
  id: 'exportPdf', label: 'PDF', icon: 'pdf', tip: 'Aktiven Plan bzw. aktive 2D-Ansicht maßstäblich als Vektor-PDF speichern (Schrift eingebettet)',
  run: () => {
    const v = app.activeView();
    if (!printable(v)) { app.status('Bitte einen Plan, eine 2D-Ansicht oder eine Bauteilliste öffnen.'); return; }
    void downloadPdf([v!.id], fileBase(v!));
  },
});

registerCommand({
  id: 'exportPdfAll', label: 'Alle Pläne als PDF', icon: 'pdf', tip: 'Ausgewählte Pläne (Standard: alle) als ein mehrseitiges Vektor-PDF speichern',
  run: () => {
    const sheets = sheetsSorted();
    if (!sheets.length) { app.status('Das Projekt enthält keine Pläne.'); return; }
    const list = h('div', { style: 'max-height:300px;overflow:auto;border:1px solid #c8d0d8;padding:4px;margin:4px 0 8px' });
    const checks: [HTMLInputElement, View][] = [];
    for (const s of sheets) {
      const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = true;
      checks.push([c, s]);
      list.append(h('div', {}, h('label', {}, c, ` ${s.sheetNo ?? ''} - ${s.name}  (${s.data?.size ?? 'A1'} ${s.data?.portrait ? 'hoch' : 'quer'})`)));
    }
    const all = h('button', { class: 'btn small' }, 'Alle'); all.onclick = () => { for (const [c] of checks) c.checked = true; };
    const none = h('button', { class: 'btn small' }, 'Keine'); none.onclick = () => { for (const [c] of checks) c.checked = false; };
    const color = h('select', {}) as HTMLSelectElement;
    color.append(h('option', { value: 'color' }, 'Farbe'), h('option', { value: 'mono' }, 'Schwarzweiß'));
    const proj = app.doc.get('project') as { name?: string } | undefined;
    const body = h('div', { style: 'min-width:420px' },
      h('div', {}, h('span', { class: 'hint' }, 'Pläne (nach Plannummer)'), ' ', all, ' ', none),
      list,
      h('div', { class: 'form-row' }, h('label', {}, 'Farben'), color),
      h('div', { class: 'hint' }, 'Ein PDF mit einer Seite je Plan im Planformat (A0–A4), Maßstab 1:1 – beim Drucken „Tatsächliche Größe“ wählen.'),
    );
    modal('Alle Pläne als PDF', body, [
      { label: 'PDF erstellen', primary: true, onClick: () => {
        const ids = checks.filter(([c]) => c.checked).map(([, s]) => s.id);
        if (!ids.length) { toast('Bitte mindestens einen Plan auswählen.'); return false; }
        void downloadPdf(ids, ids.length === 1 ? fileBase(app.doc.get(ids[0]) as View) : (proj?.name || 'Plansatz'), color.value === 'mono');
      } },
      { label: 'Abbrechen', onClick: () => {} },
    ], 480);
  },
});
