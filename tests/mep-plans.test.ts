// N6: HLKSE-Pläne aus dem Modell – Heizkreise (Nummer, Länge, Leistung, Volumenstrom), Heizkreistabelle,
// Leitungsbeschriftung (DN, Gefälle, Format), Fundamenterder als Kategorie.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import { buildTable } from '../src/modules/output/schedules';
import { buildViewDL } from '../src/views/viewBuilder';
import { catDef } from '../src/core/registry';

const doc = api.createProject();
const lvl = doc.all<any>('level')[0];
const R = (x0: number, y0: number, x1: number, y1: number) => [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]];
const man = api.addFixture(doc, 'mft_fbhv', lvl.id, { x: 0, y: 0 });
const c1 = api.addCircuit(doc, lvl.id, R(4000, 0, 8000, 4000), { q: 40 });
const c2 = api.addCircuit(doc, lvl.id, R(500, 0, 4000, 4000));
assert.equal(c1.manifoldId, man.id);
api.numberCircuits(doc);
assert.equal(doc.get(c2.id)!.name, 'HK 1', 'nächster Kreis zuerst');
assert.equal(doc.get(c1.id)!.name, 'HK 2');
const tag = catDef('fbh')!.tagText!(doc.get(c1.id)!, doc);
assert.match(tag, /^HK 2 · VA 15 cm · \d+ m · \d+ W$/, tag);
api.transaction('Format', () => doc.update(c1.id, { tagFmt: '{name} {room} ({power} W, {flow} l/h)' }));
assert.match(catDef('fbh')!.tagText!(doc.get(c1.id)!, doc), /^HK 2 \(\d+ W, \d+ l\/h\)$/);
// Heizkreistabelle je Verteiler mit Summen
const [tab] = api.createHeatingTable(doc);
const t = buildTable(doc, tab);
assert.equal(t.rows.filter((r) => r.kind === 'data').length, 2);
assert.ok(t.heads.includes('Volumenstrom (l/h)') && t.rows.some((r) => r.kind === 'total'), 'Volumenstrom und Summe');
// Leitung mit DN und Gefälle
const [p] = api.addRunChain(doc, 'pipe', { levelId: lvl.id, pts: [{ x: 0, y: 6000 }, { x: 6000, y: 6000 }], typeId: 'mpt_pe', system: 'sys_sw', dia: 110, slope: 2 });
assert.equal(catDef('pipe')!.tagText!(p, doc), 'SW DN 110 2 %');
api.transaction('Format', () => doc.update(p.id, { tagFmt: '{system} {size} · Gefälle {slope}' }));
assert.equal(catDef('pipe')!.tagText!(doc.get(p.id)!, doc), 'Sanitär Schmutzwasser DN 110 · Gefälle 2 %');
// Fundamenterder entlang einer 30 × 12 m Platte: Ring 300 mm innen + Maschen ≤ 20 m (1 Querlinie)
const fs = api.add<any>({ cat: 'foundationSlab', levelId: lvl.id, offset: -300, loops: R(0, -20000, 30000, -8000) });
const fe = api.addEarthing(doc, fs.id)!;
const L = (fe.paths as any[]).reduce((s, pp) => s + pp.slice(1).reduce((a: number, q: any, i: number) => a + Math.hypot(q.x - pp[i].x, q.y - pp[i].y), 0), 0);
assert.ok(Math.abs(L - (2 * (29400 + 11400) + 11400)) < 1, 'Ring + 1 Masche: ' + L);
const plan = doc.all<any>('view').find((v) => v.kind === 'plan' && v.levelId === lvl.id)!;
assert.ok(buildViewDL(doc, plan).items.some((it: any) => it.o === fe.id), 'Fundamenterder im Grundriss');
const ifc = api.exportIfc();
assert.ok(/IFCCABLESEGMENT\([^;]*\.CONDUCTORSEGMENT\./.test(ifc), 'IFC Fundamenterder');
assert.ok(!api.exportIfc({ disciplines: ['struct'] }).includes('CONDUCTORSEGMENT'), 'nicht im Tragwerksmodell');
