// N8: Breitenfaktor je Texttyp (Schmalschrift) in Messung, SVG, PDF und DXF; eigene PDF-Schrift je Familie.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import * as api from '../src/api';
import { textBox, fontWf } from '../src/render/displayList';
import { buildViewDL } from '../src/views/viewBuilder';
import { pageOf, pageSvg } from '../src/modules/output/common';

assert.equal(fontWf({ family: '"Arial Narrow", Arial, Helvetica, sans-serif' }), 0.82);
assert.equal(fontWf({ family: 'Arial', wf: 0.9 }), 0.9);
const w1 = textBox({ p: { x: 0, y: 0 }, s: 'Mittelwand', font: { size: 2.5, ha: 'left' } }, 1);
const w2 = textBox({ p: { x: 0, y: 0 }, s: 'Mittelwand', font: { size: 2.5, ha: 'left', wf: 0.8 } }, 1);
assert.ok(Math.abs((w2[1].x - w2[0].x) / (w1[1].x - w1[0].x) - 0.8) < 1e-9, 'Textrahmen schmaler');

const doc = api.createProject();
api.add({ cat: 'type', id: 'txt_narrow', of: 'text', name: 'Text 2,5 mm Arial Narrow', size: 2.5, font: 'Arial Narrow' } as any);
api.add({ cat: 'type', id: 'txt_wf', of: 'text', name: 'Text 2,5 mm Breite 0.7', size: 2.5, font: 'Arial', widthFactor: 0.7 } as any);
const v = api.add<any>({ cat: 'view', kind: 'drafting', name: 'Schriften', scale: 1, detail: 'fine' });
api.add({ cat: 'text', viewId: v.id, typeId: 'txt_narrow', p: { x: 0, y: 0 }, s: 'Schmal' } as any);
api.add({ cat: 'text', viewId: v.id, typeId: 'txt_wf', p: { x: 0, y: -10 }, s: 'Faktor' } as any);
const texts = buildViewDL(doc, v).items.filter((it: any) => it.k === 'text') as any[];
assert.equal(fontWf(texts.find((t) => t.s === 'Schmal').font), 0.82);
assert.equal(fontWf(texts.find((t) => t.s === 'Faktor').font), 0.7);
assert.ok(/scale\(0\.82 1\)/.test(pageSvg(pageOf(doc, v)!)), 'SVG skaliert');
const dxf = new TextDecoder().decode(api.exportDxf(v.id)).replace(/\r\n/g, '\n');
assert.ok(/\n 41\n0\.82\n/.test(dxf) || /\\W0\.82;/.test(dxf), 'DXF Breitenfaktor');
// PDF: horizontale Skalierung im Inhaltsstrom
const sh = api.add<any>({ cat: 'view', kind: 'sheet', name: 'Schriften', sheetNo: 'S-1', scale: 1, detail: 'fine', data: { size: 'A4' } });
api.placeView(sh.id, v.id, { x: 150, y: 100 });
const pdf = Buffer.from(await api.exportPdf([sh.id]));
const streams: string[] = []; let i = 0;
while ((i = pdf.indexOf('stream\n', i)) >= 0) { const j = pdf.indexOf('endstream', i); try { streams.push(inflateSync(pdf.subarray(i + 7, j)).toString('latin1')); } catch { /* Bild/Schrift */ } i = j; }
assert.ok(streams.some((s) => /0\.82 0 0 1 0 0 cm/.test(s) && /0\.7 0 0 1 0 0 cm/.test(s)), 'PDF Tz/cm');
// eigene Schrift für «Arial Narrow» (falls auf dem System vorhanden): eingebettet, ohne Breitenfaktor
const ttf = '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf';
if (existsSync(ttf)) {
  api.registerPdfFont('Arial Narrow', new Uint8Array(readFileSync(ttf)));
  const pdf2 = Buffer.from(await api.exportPdf([sh.id])).toString('latin1');
  assert.ok(/\/BaseFont \/[A-Z]{6}\+[A-Za-z]*Narrow/.test(pdf2), 'Schmalschrift eingebettet');
}
