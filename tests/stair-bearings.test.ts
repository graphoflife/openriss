// Treppenlager: U-Treppe zwischen Wänden mit Decke oben – Z-Lager, Schalldämmlager, Querkraftdorne,
// Fugenplatten; Elemente folgen den Treppenfeldern, Decke wird am Austritt ausgeklinkt, IFC-Zuordnung.
import assert from 'node:assert/strict';
import { createProject, addLevel, addWall, addFloor, addStair, doc, transaction, syncStairBearings, exportIfc } from '../src/api';
import { stairJoints } from '../src/modules/architecture/stairJoints';
import { floorArea } from '../src/modules/architecture/floor';
import { multiArea } from '../src/modules/architecture/common';
import { catDef } from '../src/core/registry';

createProject({ name: 'Treppenlager' });
const eg = addLevel({ name: 'EG', elev: 0 }).id;
const og = addLevel({ name: 'OG', elev: 2800 }).id;
const W = (a: any, b: any) => addWall({ a, b, levelId: eg, topLevelId: og, typeId: 'wt_stb20', topOffset: -250 });
W({ x: -1500, y: -700 }, { x: 3260, y: -700 });
W({ x: 3260, y: -800 }, { x: 3260, y: 2100 });
W({ x: 3260, y: 2000 }, { x: -1500, y: 2000 });
const slab = addFloor({ levelId: og, typeId: 'flt_stb25', loops: [
  [{ x: -2000, y: -1000 }, { x: 3500, y: -1000 }, { x: 3500, y: 2300 }, { x: -2000, y: 2300 }],
  [{ x: 0, y: -600 }, { x: 3160, y: -600 }, { x: 3160, y: 1900 }, { x: 0, y: 1900 }],
] });
const area0 = multiArea(floorArea(doc, doc.get(slab.id)!));
const s = addStair({ p0: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, levelId: eg, topLevelId: og, shape: 'U', width: 1200, gap: 100, typeId: 'stt_stb' });
assert.equal(doc.all('stairBearing').length, 0, 'monolithisch: keine Lager');

transaction('Lager', () => doc.update(s.id, { jBot: 'pad', jTop: 'z', jLand: 'z', jLandWall: 'console', wallPlate: true }));
syncStairBearings(s.id);
const jg = stairJoints(doc, doc.get(s.id)!);
const kinds = (k: string) => jg.parts.filter((p) => p.kind === k).length;
assert.equal(kinds('zBearing'), 3, 'Z-Lager: Lauf/Podest, Podest/Lauf, Austritt');
assert.equal(kinds('pad'), 4, 'Schalldämmlager am Antritt und auf drei Wandkonsolen');
assert.equal(kinds('plate'), 5, 'Fugenplatten: zwei Lauf/Wand, drei Podest/Wand');
assert.equal(doc.all('stairBearing').length, jg.parts.length);
assert.deepEqual(jg.insets, [[10, 0], [10, 0]], 'Läufe an der Wand um die Fuge schmaler');
// Z-Lager Lauf/Podest: Konsole in halber Podestdicke, Nase auf Podesthöhe
const zl = jg.parts.find((p) => p.key === 'r0t')!;
assert.equal(Math.round(zl.z0), 1200); assert.equal(Math.round(zl.z1), 1400);
// Decke am Austritt ausgeklinkt (2 × Konsolentiefe über die Laufbreite)
assert.equal(jg.slabCuts.length, 1);
assert.equal(Math.round(area0 - multiArea(floorArea(doc, doc.get(slab.id)!))), 240 * 1200);
// Bauteilliste, Beschriftung, IFC
const sb = doc.all('stairBearing').find((e) => e.key === 'r1t')!;
assert.match(catDef('stairBearing')!.tagText!(sb, doc), /^Z-Lager Elastomer-Z-Lager, l = /);
const ifc = exportIfc('t.ifc');
assert.equal((ifc.match(/IFCDISCRETEACCESSORY\(/g) ?? []).length, 7);
assert.equal((ifc.match(/IFCCOVERING\([^;]*\.INSULATION\./g) ?? []).length, 5);

// Querkraftdorne: gerade Fugen mit Fugenplatte
transaction('Dorne', () => doc.update(s.id, { jTop: 'dowel', jLand: 'dowel', jLandWall: 'dowel', jBot: 'mono' }));
syncStairBearings(s.id);
const jd = stairJoints(doc, doc.get(s.id)!);
assert.equal(jd.parts.filter((p) => p.kind === 'dowel').length, 6);
assert.ok(jd.parts.filter((p) => p.kind === 'dowel').every((p) => p.count === 2 && p.thick === 20));
assert.equal((exportIfc('t.ifc').match(/IFCMECHANICALFASTENER\([^;]*\.DOWEL\./g) ?? []).length, 6);

// zurück auf monolithisch: Lager entfernt, Decke wieder vollständig
transaction('Mono', () => doc.update(s.id, { jTop: undefined, jLand: undefined, jLandWall: undefined, wallPlate: undefined }));
syncStairBearings(s.id);
assert.equal(doc.all('stairBearing').length, 0);
assert.equal(Math.round(multiArea(floorArea(doc, doc.get(slab.id)!))), Math.round(area0));
console.log('  Treppenlager: Z-Lager, Schalldämmlager, Querkraftdorne, Fugenplatten, Deckenausklinkung, IFC');
