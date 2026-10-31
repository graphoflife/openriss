// N1 Linienstile als Projekttypen: Vorlage, Auflösung, Darstellung, DXF-Layer mit Farbe.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import { linePen, lineStyleOptions } from '../src/elements/datums';
import { buildViewDL } from '../src/views/viewBuilder';

const doc = api.createProject();
assert.ok(doc.get('ls_medium') && doc.get('ls_e_strich') && doc.get('ls_sw_breit'), 'Vorlagenstile');
// eingebaute Schlüssel bleiben gültig und lösen über den Projekttyp auf
assert.equal(linePen(doc, 'medium').w, 3);
api.transaction('Stil ändern', () => doc.update('ls_medium', { color: '#ff00ff' }));
assert.equal(linePen(doc, 'medium').color, '#ff00ff');
assert.ok(lineStyleOptions(doc).some(([k]) => k === 'medium'));
// eigener Stil: magenta gestrichelt fein
const ls = api.addLineStyle({ name: 'Elektro Test', color: '#e000e0', pen: 2, dash: 'dash' });
assert.equal(api.addLineStyle({ color: '#e000e0', pen: 2, dash: 'dash' }).id, ls.id, 'gleicher Stil wird wiederverwendet');
const v = doc.all<any>('view').find((x) => x.kind === 'drafting') ?? api.add<any>({ cat: 'view', kind: 'drafting', name: 'Detail', scale: 20, detail: 'fine' });
api.add({ cat: 'line', viewId: v.id, a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, style: ls.id } as any);
api.add({ cat: 'region', viewId: v.id, typeId: doc.all<any>('type').find((t) => t.of === 'region')?.id, loops: [[{ x: 0, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 600 }]], lineStyle: 'ls_sw_breit' } as any);
const dl = buildViewDL(doc, v);
const pens = dl.items.filter((it: any) => it.k === 'line' || it.k === 'poly').map((it: any) => it.pen);
assert.ok(pens.some((p: any) => p.color === '#e000e0' && p.dash === 'dash' && p.w === 2), 'Detaillinie farbig gestrichelt');
assert.ok(pens.some((p: any) => p.color === '#8b4513' && p.w === 6), 'Bereichsrand Abwasser breit');
// DXF: Layer je Linienstil mit Farbe (ACI 62, True Color 420), Elemente VONLAYER
const dxf = new TextDecoder().decode(api.exportDxf(v.id)).replace(/\r\n/g, '\n');
assert.ok(/\n  2\nLinien-Elektro Test\n 70\n0\n 62\n6\n  6\nSTRICH\n420\n14680288\n/.test(dxf), 'Layer Elektro Test');
assert.ok(/\n  2\nLinien-Abwasser breit\n/.test(dxf), 'Layer Abwasser');
const ent = dxf.slice(dxf.indexOf('ENTITIES'));
const lineEnt = ent.slice(ent.indexOf('Linien-Elektro Test') - 80, ent.indexOf('Linien-Elektro Test') + 120);
assert.ok(!/\n 62\n/.test(lineEnt.slice(lineEnt.indexOf('Linien-Elektro Test'))), 'Linie ohne eigene Farbe (VONLAYER)');
