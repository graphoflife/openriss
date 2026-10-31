// N13: Tortypen (Rolltor, Sektionaltor, Lifttür) und Liftkabine – Grundriss, Ansicht, IFC.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import { buildViewDL } from '../src/views/viewBuilder';

const doc = api.createProject();
const [eg, og] = doc.all<any>('level').sort((a, b) => a.elev - b.elev);
const w = api.add<any>({ cat: 'wall', a: { x: 0, y: 0 }, b: { x: 10000, y: 0 }, levelId: eg.id, topLevelId: og.id, baseOffset: 0, topOffset: 0, height: 3000, locLine: 'center', flip: false, structural: true });
const roll = api.add<any>({ cat: 'door', hostId: w.id, typeId: 'dt_rolltor', t: 3000, sill: 0 });
const sec = api.add<any>({ cat: 'door', hostId: w.id, typeId: 'dt_sektional', t: 7000, sill: 0 });
const lift = api.add<any>({ cat: 'door', hostId: w.id, typeId: 'dt_lift', t: 9300, sill: 0 });
const plan = doc.all<any>('view').find((v) => v.kind === 'plan' && v.levelId === eg.id)!;
const dl = buildViewDL(doc, plan);
const own = (id: string) => dl.items.filter((it: any) => it.o === id);
assert.ok(own(roll.id).some((it: any) => it.pen?.dash === 'hidden'), 'Rolltor: Wickelkasten gestrichelt');
assert.ok(own(sec.id).filter((it: any) => it.k === 'line' && it.pen?.dash === 'hidden').length >= 2, 'Sektionaltor: Laufschienen');
assert.ok(own(lift.id).filter((it: any) => it.k === 'poly').length >= 4, 'Lifttür: Zarge + 2 Blätter');
// Ansicht von aussen (Süden, Blick nach +y): Lamellen
const els = doc.all<any>('view').filter((v) => v.kind === 'elevation');
assert.ok(els.some((ev) => buildViewDL(doc, ev).items.filter((it: any) => it.o === roll.id && it.k === 'line').length >= 5), 'Rolltor-Lamellen in Ansicht');
// Lift: erscheint auf beiden Ebenen
const lf = api.add<any>({ cat: 'elevator', levelId: eg.id, topLevelId: og.id, p: { x: 5000, y: 2000 }, load: 1000, persons: 13 });
const planOG = doc.all<any>('view').find((v) => v.kind === 'plan' && v.levelId === og.id)!;
for (const v of [plan, planOG]) assert.ok(buildViewDL(doc, v).items.some((it: any) => it.o === lf.id && it.k === 'text' && it.s === 'Lift 1000 kg / 13 P.'), 'Lift im Grundriss ' + v.name);
const ifc = api.exportIfc();
assert.ok(/IFCDOOR\([^;]*\.ROLLINGUP\./.test(ifc), 'Rolltor ROLLINGUP');
assert.ok(/IFCDOOR\([^;]*\.USERDEFINED\.,'SECTIONAL'/.test(ifc), 'Sektionaltor');
assert.ok(/IFCTRANSPORTELEMENT\([^;]*\.ELEVATOR\./.test(ifc), 'Lift als IfcTransportElement');
