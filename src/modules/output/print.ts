// Drucken / PDF (Browser-Druckdialog mit exakter Papiergröße), SVG- und PNG-Export.
import { app } from '../../app';
import { registerCommand } from '../../core/registry';
import type { View } from '../../core/view';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { Page, pageOf, pageSvg, printable, fileBase, esc } from './common';

const fmtMm = (v: number) => (Math.round(v * 100) / 100).toString();

/** Seiten als HTML-Dokument (je Seite ein SVG, Seitengröße per @page) */
function printHtml(pages: Page[], mono: boolean, title: string): string {
  const sizes = new Map<string, string>();
  const parts: string[] = [];
  pages.forEach((p, i) => {
    const key = fmtMm(p.w) + 'x' + fmtMm(p.h);
    if (!sizes.has(key)) sizes.set(key, 's' + sizes.size);
    // IDs je Seite eindeutig machen (Clip-Pfade, Muster)
    const svg = pageSvg(p, mono).replace(/^<\?xml[^>]*>\s*/, '').replace(/(id="|url\(#)([^")]+)/g, `$1pg${i}_$2`);
    parts.push(`<div class="pg ${sizes.get(key)}" style="width:${fmtMm(p.w)}mm;height:${fmtMm(p.h)}mm">${svg}</div>`);
  });
  const first = pages[0];
  const css = [`@page { size: ${fmtMm(first.w)}mm ${fmtMm(first.h)}mm; margin: 0; }`];
  for (const [key, cls] of sizes) { const [w, hh] = key.split('x'); css.push(`@page ${cls} { size: ${w}mm ${hh}mm; margin: 0; } .pg.${cls} { page: ${cls}; }`); }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
html, body { margin: 0; padding: 0; background: #fff; }
.pg { overflow: hidden; break-after: page; page-break-after: always; position: relative; }
.pg:last-child { break-after: auto; page-break-after: auto; }
.pg svg { display: block; width: 100%; height: 100%; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
${css.join('\n')}
</style></head><body>${parts.join('')}</body></html>`;
}

/** Druckt die Seiten über einen unsichtbaren iFrame (Browser: „Als PDF speichern“ für PDF) */
export function printPages(pages: Page[], mono = false, title = 'OpenRiss'): void {
  if (!pages.length) return;
  const html = printHtml(pages, mono, title);
  const ifr = document.createElement('iframe');
  ifr.setAttribute('aria-hidden', 'true');
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(ifr);
  const w = ifr.contentWindow; const d = ifr.contentDocument;
  if (!w || !d) { ifr.remove(); return; }
  d.open(); d.write(html); d.close();
  const go = () => {
    const prevTitle = document.title;
    document.title = title; // Dateiname-Vorschlag beim PDF-Speichern
    try { w.focus(); w.print(); } finally { setTimeout(() => { document.title = prevTitle; }, 1000); }
    setTimeout(() => ifr.remove(), 60000);
    w.addEventListener('afterprint', () => setTimeout(() => ifr.remove(), 500));
  };
  // Bilder (Daten-URLs) laden lassen
  setTimeout(go, 300);
}

/** Druckdialog (Revit: Drucken – Druckbereich, Farben) */
function printDialog(pdf: boolean): void {
  const doc = app.doc; const av = app.activeView();
  const sheets = doc.all<View>('view').filter((v) => v.kind === 'sheet').sort((a, b) => (a.sheetNo ?? '').localeCompare(b.sheetNo ?? '', 'de', { numeric: true }));
  if (!printable(av) && !sheets.length) { app.status('Keine druckbare Ansicht: bitte einen Plan oder eine 2D-Ansicht öffnen.'); return; }
  const body = h('div', { style: 'min-width:420px' });
  const rCur = h('input', { type: 'radio', name: 'prange' }) as HTMLInputElement;
  const rSel = h('input', { type: 'radio', name: 'prange' }) as HTMLInputElement;
  rCur.checked = printable(av); rSel.checked = !printable(av); rCur.disabled = !printable(av);
  const list = h('div', { style: 'max-height:240px;overflow:auto;border:1px solid #c8d0d8;padding:4px;margin:4px 0 8px 22px' });
  const checks: [HTMLInputElement, View][] = [];
  for (const s of sheets) {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = av?.id === s.id || (!printable(av) && sheets.length === 1);
    c.onchange = () => { if (c.checked) { rSel.checked = true; } };
    checks.push([c, s]);
    list.append(h('div', {}, h('label', {}, c, ` ${s.sheetNo ?? ''} - ${s.name}  (${s.data?.size ?? 'A1'} ${s.data?.portrait ? 'hoch' : 'quer'})`)));
  }
  const all = h('button', { class: 'btn small' }, 'Alle Pläne'); all.onclick = () => { for (const [c] of checks) c.checked = true; rSel.checked = true; };
  const none = h('button', { class: 'btn small' }, 'Keine'); none.onclick = () => { for (const [c] of checks) c.checked = false; };
  const color = h('select', {}) as HTMLSelectElement;
  color.append(h('option', { value: 'color' }, 'Farbe'), h('option', { value: 'mono' }, 'Schwarzweiß'));
  body.append(
    h('div', { class: 'hint' }, 'Druckbereich'),
    h('div', {}, h('label', {}, rCur, ' Aktuelles Fenster' + (av ? `: ${av.kind === 'sheet' ? (av.sheetNo ?? '') + ' - ' : ''}${av.name}` : ''))),
    h('div', {}, h('label', {}, rSel, ' Ausgewählte Pläne'), ' ', all, ' ', none),
    sheets.length ? list : h('div', { class: 'hint', style: 'margin-left:22px' }, 'Keine Pläne vorhanden.'),
    h('div', { class: 'form-row' }, h('label', {}, 'Farben'), color),
    h('div', { class: 'hint' }, pdf
      ? 'Im folgenden Druckdialog als Ziel „Als PDF speichern“ wählen. Papierformat und Ränder (0) werden automatisch gesetzt; Maßstab 100 % / „Tatsächliche Größe“.'
      : 'Papierformat und Ränder werden automatisch gesetzt. Für maßstäbliche Ausdrucke „Tatsächliche Größe“ (100 %) wählen.'),
  );
  modal(pdf ? 'PDF exportieren' : 'Drucken', body, [
    { label: pdf ? 'PDF erstellen…' : 'Drucken…', primary: true, onClick: () => {
      const views = rCur.checked && av ? [av] : checks.filter(([c]) => c.checked).map(([, s]) => s);
      const pages = views.map((v) => pageOf(doc, v)).filter((p): p is Page => !!p);
      if (!pages.length) { alert('Bitte mindestens einen Plan auswählen.'); return false; }
      const title = pages.length === 1 ? fileBase(pages[0].view) : (doc.get('project') as any)?.name ?? 'OpenRiss';
      printPages(pages, color.value === 'mono', title);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 480);
}

registerCommand({ id: 'print', label: 'Drucken', icon: 'print', tip: 'Aktuellen Plan bzw. Ansicht oder mehrere Pläne drucken (Strg+P)', run: () => printDialog(false) });
// 'exportPdf' / 'exportPdfAll': direkter Vektor-PDF-Export ohne Druckdialog → pdfCommands.ts

// ------------------------------------------------------------ SVG
function activePage(): Page | null {
  const v = app.activeView();
  if (!printable(v)) { app.status('Bitte einen Plan, eine 2D-Ansicht oder eine Bauteilliste öffnen.'); return null; }
  const p = pageOf(app.doc, v!);
  if (!p) app.status('Diese Ansicht kann nicht exportiert werden.');
  return p;
}
registerCommand({
  id: 'exportSvg', label: 'SVG', icon: 'svg', tip: 'Aktive Ansicht bzw. aktiven Plan maßstäblich als SVG (Papier-mm) exportieren',
  run: () => { const p = activePage(); if (p) download(fileBase(p.view) + '.svg', pageSvg(p), 'image/svg+xml'); },
});

// ------------------------------------------------------------ PNG
/** pHYs-Block (Auflösung) in PNG einfügen */
function pngWithDpi(buf: ArrayBuffer, dpi: number): Blob {
  const src = new Uint8Array(buf);
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // nach Signatur (8) + IHDR (25)
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at)); out.set(chunk, at); out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}
let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function exportPng(p: Page, dpi: number, transparent: boolean): Promise<void> {
  const MAXPX = 120e6, MAXSIDE = 16000;
  let px = dpi / 25.4;
  let W = Math.round(p.w * px), H = Math.round(p.h * px);
  const f = Math.min(1, Math.sqrt(MAXPX / (W * H)), MAXSIDE / Math.max(W, H));
  if (f < 1) { px *= f; W = Math.round(p.w * px); H = Math.round(p.h * px); toast(`Auflösung auf ${Math.round(px * 25.4)} dpi begrenzt (Bildgröße).`, 4000); }
  let svg = pageSvg(p);
  if (transparent) svg = svg.replace(/<rect x="0" y="0" width="[^"]+" height="[^"]+" fill="#ffffff"\/>/, '');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Kein Canvas');
    if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(img, 0, 0, W, H);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (!blob) throw new Error('PNG konnte nicht erzeugt werden');
    download(fileBase(p.view) + '.png', pngWithDpi(await blob.arrayBuffer(), px * 25.4));
  } finally { URL.revokeObjectURL(url); }
}

registerCommand({
  id: 'exportPng', label: 'Bild (PNG)', icon: 'png', tip: 'Aktive Ansicht bzw. aktiven Plan als Rasterbild mit wählbarer Auflösung exportieren',
  run: () => {
    const p = activePage(); if (!p) return;
    const dpi = h('select', {}) as HTMLSelectElement;
    for (const d of [72, 96, 150, 200, 300, 600]) dpi.append(h('option', { value: String(d) }, d + ' dpi'));
    dpi.value = '150';
    const tr = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const info = h('div', { class: 'hint' });
    const upd = () => { const k = parseInt(dpi.value, 10) / 25.4; info.textContent = `Papiergröße ${Math.round(p.w)} × ${Math.round(p.h)} mm → ${Math.round(p.w * k)} × ${Math.round(p.h * k)} Pixel`; };
    dpi.onchange = upd; upd();
    modal('Bild exportieren (PNG)', h('div', {}, h('div', { class: 'form-row' }, h('label', {}, 'Auflösung'), dpi), h('div', { class: 'form-row' }, h('label', {}, tr, ' Transparenter Hintergrund')), info), [
      { label: 'Exportieren', primary: true, onClick: () => { exportPng(p, parseInt(dpi.value, 10), tr.checked).catch((e) => { console.error(e); alert('PNG-Export fehlgeschlagen: ' + (e as Error).message); }); } },
      { label: 'Abbrechen', onClick: () => {} },
    ]);
  },
});
