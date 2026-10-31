// N3/N4/N5/N10: Fachmodule headless ohne manuelle Imports, Vorlagen in createProject(), MEP ohne eigene Transaktion,
// Arbeitsfugen im IFC, IFC-Teilmodelle, Vorlagen-IDs werden zusammengeführt statt still ersetzt.
import assert from 'node:assert/strict';
import * as api from '../src/api';

const doc = api.createProject();
const types = (of: string) => doc.all<any>('type').filter((t) => t.of === of);
for (const of of ['embed', 'insulZone', 'mepFixture', 'lineStyle', 'lightwell']) assert.ok(types(of).length > 0, 'Vorlagentypen ' + of);
assert.ok(doc.get('m_xps500')?.sigmaC > 0, 'Vorlagenmaterial XPS 500 mit Kennwerten');

const lvl = api.addLevel({ name: 'UG', elev: -3000 });
const w = api.add<any>({ cat: 'wall', a: { x: 0, y: 0 }, b: { x: 8000, y: 0 }, levelId: lvl.id, topLevelId: null, height: 2600, baseOffset: 0, topOffset: 0, locLine: 'center', flip: false, structural: true });
const fs = api.add<any>({ cat: 'foundationSlab', levelId: lvl.id, offset: 0, loops: [[{ x: -500, y: -4000 }, { x: 8500, y: -4000 }, { x: 8500, y: 500 }, { x: -500, y: 500 }]] });
// Einlage, Fuge (mit Fugenblech), Dämmzone – ohne Import der Fachmodule
const emb = api.add<any>({ cat: 'embed', family: 'conduit', typeId: types('embed').find((t) => t.family === 'conduit')?.id ?? types('embed')[0].id, levelId: lvl.id, z: -150, pts: [{ x: 1000, y: -1000 }, { x: 6000, y: -1000 }] });
assert.equal(emb.cat, 'embed');
const j = api.add<any>({ cat: 'joint', kind: 'wallV', hostId: w.id, t: 4000, stageA: 1, stageB: 2 });
api.add<any>({ cat: 'embed', family: 'waterstop', typeId: types('embed').find((t) => t.family === 'waterstop')!.id, hostId: j.id, levelId: lvl.id, z: 0 });
api.add<any>({ cat: 'insulZone', typeId: 'izt_xps500', levelId: lvl.id, offset: -300, hostId: fs.id, loops: [[{ x: 0, y: -3000 }, { x: 4000, y: -3000 }, { x: 4000, y: 0 }, { x: 0, y: 0 }]] });
// MEP direkt (ohne transaction())
const fx = api.addFixture(doc, types('mepFixture')[0].id, lvl.id, { x: 2000, y: -2000 });
assert.equal(fx.cat, 'mepFixture');
api.addRunChain(doc, 'pipe', { levelId: lvl.id, pts: [{ x: 1000, y: -2500 }, { x: 5000, y: -2500 }], slope: 2 });

// N10: Vorlagen-ID im Skript neu angelegt → Warnung, Kennwerte bleiben
const nw = api.warnings.length;
api.add({ cat: 'material', id: 'm_xps500', name: 'XPS 500 (Projekt)', color: '#88aaff' } as any);
assert.equal(api.warnings.length, nw + 1, 'Warnung bei vorhandener ID');
assert.ok(doc.get('m_xps500')!.sigmaC > 0 && doc.get('m_xps500')!.name === 'XPS 500 (Projekt)', 'zusammengeführt');
api.add({ cat: 'material', id: 'm_test_ersatz', name: 'X' } as any);
api.add({ cat: 'material', id: 'm_test_ersatz', name: 'Y' } as any, { replace: true });
assert.equal(doc.get('m_test_ersatz')!.name, 'Y');

// N4/N5: Fuge im IFC, Teilmodell Tragwerk ohne Haustechnik
const all = api.exportIfc('Test.ifc');
assert.ok(/IFCBUILDINGELEMENTPROXY\([^;]*'AF Etappe 1 \| 2/.test(all), 'Arbeitsfuge als Proxy');
assert.ok(all.includes("'CH_Arbeitsfuge'") && /IFCRELCONNECTSELEMENTS\([^;]*'Fugenblech'/.test(all), 'Pset und Bezug zum Fugenblech');
assert.ok(/IFCPIPESEGMENT|IFCFLOWSEGMENT/.test(all) && /IFCSANITARYTERMINAL|IFCFLOWTERMINAL|IFCELECTRIC|IFCOUTLET|IFCLIGHTFIXTURE|IFCDISTRIBUTION/.test(all), 'Haustechnik im Gesamtmodell');
const st = api.exportIfc({ disciplines: ['struct'] });
assert.ok(st.includes('IFCWALL(') && st.includes("'AF Etappe"), 'Tragwerk: Wand und Fuge');
assert.ok(!/IFCPIPESEGMENT|IFCFLOWSEGMENT/.test(st), 'Tragwerk ohne Leitungen');
const ex = api.exportIfc({ excludeCats: ['joint'] });
assert.ok(!ex.includes("'AF Etappe"), 'excludeCats');
const only = api.exportIfc({ cats: ['wall'] });
assert.ok(only.includes('IFCWALL(') && !only.includes('IFCSLAB('), 'cats');
