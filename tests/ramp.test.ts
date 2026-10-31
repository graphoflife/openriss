// N12 Geneigte Platten, Rampen, Gefälle: Neigungspfeil/Profil, Körper (Volumen = Grundfläche × Dicke),
// Fläche (Ober-/Unterseite), Längsschnitt, Wände mit Unterkante auf der Rampe (Tür-Regel), IFC (IfcRamp, Brep).
import assert from 'node:assert/strict';
import * as api from '../src/api';
import type { V2 } from '../src/core/geom';
import { polyArea } from '../src/core/geom';
import { solidsOf, solidVolume, cutPolysOfElement } from '../src/views/sectionEngine';
import { surfaceOf } from '../src/views/surfaces';
import { buildViewDL } from '../src/views/viewBuilder';
import { catDef } from '../src/core/registry';
import { createRamp, rampProfile } from '../src/modules/architecture/ramp';
import { slopeOf, slopedArea } from '../src/modules/architecture/slope';
import { floorArea } from '../src/modules/architecture/floor';
import { wallBounds, wallZAt, wallArea, Wall } from '../src/elements/wall';
import { openingZ0 } from '../src/elements/openings';
import { slabAt } from '../src/modules/embeds/common';
import { slabLevels } from '../src/modules/annotation/spots';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b}`);
const doc = api.createProject();
const R = (x0: number, y0: number, x1: number, y1: number): V2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const vol = (id: string) => solidVolume(solidsOf(doc, doc.get(id)!));

// ------------------------------------------------------------ ebene Decke: Körper unverändert (Schichten als Prismen)
const flat = api.add({ cat: 'floor', id: 'fl_flat', levelId: 'lvl_eg', offset: 0, typeId: 'flt_aufbau', loops: [R(0, 0, 5000, 4000)] });
const fs = solidsOf(doc, flat);
assert.equal(fs.length, 4, 'je Schicht ein Körper');
assert.deepEqual(fs.map((s) => s.faces.length), [6, 6, 6, 6], 'Quader');
near(solidVolume(fs), 5000 * 4000 * 350, 1, 'Volumen eben');
assert.equal(surfaceOf(doc, flat)?.flat, true);

// ------------------------------------------------------------ Neigungspfeil {a, b, pct}
const tilt = api.add({ cat: 'floor', id: 'fl_tilt', levelId: 'lvl_eg', offset: 0, typeId: 'flt_stb20', loops: [R(0, 10000, 4000, 13000)], slope: { a: { x: 0, y: 11000 }, b: { x: 4000, y: 11000 }, pct: 2 } } as any);
const st = surfaceOf(doc, tilt)!;
assert.equal(st.flat, false);
near(st.topAt({ x: 0, y: 12000 }), 0, 1e-9, 'OK am Pfeilanfang');
near(st.topAt({ x: 4000, y: 10000 }), -80, 1e-9, '2 % auf 4 m');
near(st.botAt({ x: 2000, y: 10000 }), -40 - 200, 1e-9, 'UK lotrecht');
near(vol('fl_tilt'), 4000 * 3000 * 200, 1, 'Volumen geneigt = Fläche × Dicke');
near(slopedArea(floorArea(doc, tilt), slopeOf(tilt)), 4000 * 3000 * Math.hypot(1, 0.02), 1, 'geneigte Fläche');

// ------------------------------------------------------------ Rampe 6.00 m licht, 15 % mit Übergängen 8 % / 3 m
{
  const p = rampProfile(24000, -2980, 8, 3000);
  near(p.main, (2980 - 480) / 18000, 1e-12, 'Hauptneigung');
  assert.equal(p.prof.length, 4);
}
let rampId = '', wallIds: string[] = [];
api.transaction('Rampe', () => {
  const r = createRamp(doc, { a: { x: -24000, y: 7000 }, b: { x: 0, y: 7000 }, levelId: 'lvl_eg', offset: 0, endOffset: -3240, width: 6000, transPct: 8, transLen: 3000, wallTypeId: 'wt_stb25', typeId: 'flt_stb25', wallTop: 1000 });
  rampId = r.floor.id; wallIds = r.walls.map((w) => w.id);
  near(r.main, (3240 - 480) / 18000, 1e-12, 'Hauptneigung Rampe');
});
const ramp = doc.get(rampId)!;
assert.equal(ramp.ramp, true);
const sr = surfaceOf(doc, ramp)!;
near(sr.topAt({ x: -24000, y: 7000 }), 0, 1e-9, 'OK oben');
near(sr.topAt({ x: -21000, y: 5000 }), -240, 1e-9, 'Ende Übergang oben (8 % × 3 m)');
near(sr.topAt({ x: -12000, y: 9000 }), -240 - 9000 * (2760 / 18000), 1e-6, 'Rampenmitte');
near(sr.topAt({ x: 0, y: 7000 }), -3240, 1e-9, 'OK unten');
near(sr.zMax, 0, 1e-9); near(sr.zMin, -3240 - 250, 1e-9);
assert.equal(sr.creases?.length, 2, 'zwei Knicklinien');
const area = polyArea([R(-24000, 7000 - 3250, 0, 7000 + 3250)]);
near(vol(rampId), area * 250, 1, 'Volumen Rampe = Grundfläche × Dicke');
assert.equal(solidsOf(doc, ramp)[0].faces.length, 3 + 3 + 4, 'eine Hülle: 3 Zellen oben/unten + 4 Seiten');
near(catDef('floor')!.scheduleFields!().find((f) => f.key === 'volume')!.get(ramp, doc), area * 250, 1, 'Listenvolumen');

// Längsschnitt (y = 7000): Oberkante geknickt
const pr = { origin: { x: 0, y: 7000, z: 0 }, dir: { x: 0, y: 1, z: 0 }, toView: (p: any) => ({ x: p.x, y: p.z }), depth: (p: any) => p.y - 7000 };
const cut = cutPolysOfElement(doc, ramp, pr as any);
assert.equal(cut.length, 1); assert.equal(cut[0].polys.length, 1);
const ring = cut[0].polys[0][0];
near(polyArea(cut[0].polys[0]), 24000 * 250, 1, 'Schnittfläche');
const topPts = ring.filter((q) => ring.some((r) => Math.abs(r.x - q.x) < 1e-6 && r.y < q.y - 1)).sort((a, b) => a.x - b.x);
assert.deepEqual(topPts.map((q) => Math.round(q.x)), [-24000, -21000, -3000, 0], 'Knicke der Oberkante');
assert.deepEqual(topPts.map((q) => Math.round(q.y)), [0, -240, -3000, -3240]);

// Trogwände: Unterkante folgt der Rampe (auf der Oberseite)
assert.equal(wallIds.length, 2);
const w = doc.get<Wall>(wallIds[0])!;
const wb = wallBounds(doc, w);
assert.ok(wb.base && !wb.top, 'Unterkantenprofil');
near(wb.zMin, -3240, 1e-6); near(wb.zMax, 1000, 1e-6);
for (const x of [-24000, -21000, -12000, -3000, 0]) {
  const u = Math.abs(x - (w.a.x)); // Wand 0 läuft von x = 0 nach x = −24000
  near(wallZAt(doc, w, u)[0], sr.topAt({ x, y: w.a.y }), 1e-6, 'UK Wand = OK Rampe bei x = ' + x);
}
const T = 250, L = 24000;
// Wandfläche = ∫(OK − UK): OK waagrecht 1000, UK = Rampenprofil
const prof = [{ s: 0, z: 0 }, { s: 3000, z: -240 }, { s: 21000, z: -3000 }, { s: 24000, z: -3240 }];
let A = 0; for (let i = 1; i < prof.length; i++) A += (1000 - (prof[i - 1].z + prof[i].z) / 2) * (prof[i].s - prof[i - 1].s);
near(wallArea(doc, w), A, 1, 'Wandfläche mit Profil');
near(vol(w.id), A * T, 1, 'Wandvolumen = Fläche × Dicke (geschlossene Hülle)');
// geschlossen: Volumen unabhängig vom Bezugspunkt
const moved = solidsOf(doc, w)[0].faces.map((f) => ({ pts: f.pts.map((p) => ({ x: p.x + 1e5, y: p.y - 3e5, z: p.z + 2e5 })), holes: f.holes?.map((h) => h.map((p) => ({ x: p.x + 1e5, y: p.y - 3e5, z: p.z + 2e5 }))) }));
near(solidVolume([moved]), A * T, 1, 'Hülle geschlossen');
const ws = solidsOf(doc, w)[0];
const zs = ws.faces.flatMap((f) => f.pts.map((p) => p.z));
near(Math.min(...zs), -3240, 1e-6, 'Körper-UK'); near(Math.max(...zs), 1000, 1e-6, 'Körper-OK');

// Tür in der Trogwand: Unterkante = höchster Punkt der Wandunterkante im Türbereich
const door = api.addDoor({ hostId: w.id, t: 6000, sill: 0 } as any);
const dW = (doc.get(door.typeId) as any)?.width ?? 1000;
near(openingZ0(doc, door as any), Math.max(...[6000 - dW / 2, 6000 + dW / 2].map((u) => wallZAt(doc, w, u)[0])), 1e-6, 'Tür-UK');
near(openingZ0(doc, door as any), sr.topAt({ x: -6000 - dW / 2, y: 7000 }), 1e-6, 'Tür-UK = Rampe am oberen Türrand');
const vd = vol(w.id);
assert.ok(vd < A * T && vd > A * T - dW * 2200 * T, 'Türöffnung abgezogen');
near(vd, wallArea(doc, w) * T, 1, 'Volumen mit Tür = Fläche × Dicke');

// Platte am Punkt (Einlagen) und Koten-Kästchen: Höhen am Punkt
near(slabAt(doc, { x: -12000, y: 7000 }, -1000)!.top, sr.topAt({ x: -12000, y: 7000 }), 1e-6, 'slabAt lokal');
near(slabLevels(doc, ramp, 'core', { x: -12000, y: 7000 }).top, sr.topAt({ x: -12000, y: 7000 }), 1e-6, 'Kote lokal');

// ------------------------------------------------------------ Grundriss / Schnitt zeichnen ohne Fehler
const plan = doc.all<any>('view').find((v) => v.kind === 'plan' && v.levelId === 'lvl_eg')!;
api.transaction('Ansichtsbereich', () => doc.update(plan.id, { range: { top: 2300, cut: -1500, bottom: -4000, depth: -4000 } }));
const dl = buildViewDL(doc, doc.get<any>(plan.id));
assert.ok(dl.items.some((it: any) => it.k === 'text' && it.o === rampId && /%/.test(it.s)), 'Gefällepfeil mit Prozentangabe');
assert.ok(dl.items.some((it: any) => it.k === 'fill' && it.o === rampId), 'Schnittfläche der Rampe im Grundriss');

// ------------------------------------------------------------ Bearbeiten: Griffe, Spiegeln, Prüfung
{
  const g = catDef('floor')!.grips!(ramp, doc, doc.get<any>(plan.id));
  assert.ok(g.some((x) => x.id === 'sl:0') && g.some((x) => x.id === 'sl:1'), 'Griffe am Neigungspfeil');
  const pt = catDef('floor')!.dragGrip!(ramp, 'sl:1', { x: 6000, y: 7000 }, doc, doc.get<any>(plan.id)) as any;
  near(pt.slope.prof[3].s, 30000, 1e-6, 'Profil gestreckt'); near(pt.slope.prof[3].dz, -3240, 1e-9, 'Höhe am Ende bleibt');
  // Spiegeln an x = 0: Gefälle zeigt mit
  const mp = catDef('floor')!.transform!(ramp, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 } as any, doc, doc.get<any>(plan.id)) as any;
  assert.equal(mp.slope.dir.x, -1); assert.equal(mp.slope.a.x, 24000);
  const errs = api.validate([{ id: 'x', cat: 'floor', levelId: 'lvl_eg', loops: [R(0, 0, 1000, 1000)], slope: { a: { x: 0, y: 0 }, pct: 2 } } as any], doc);
  assert.ok(errs.some((e) => e.field === 'slope'), 'Gefälle geprüft');
  assert.equal(api.validate([{ id: 'y', cat: 'wall', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, levelId: 'lvl_eg', attachBaseId: rampId } as any], doc).length, 0);
}

// ------------------------------------------------------------ IFC
const ifc = api.exportIfc('Rampe.ifc');
assert.ok(/IFCRAMP\([^;]*\.STRAIGHT_RUN_RAMP\.\);/.test(ifc), 'IfcRamp');
assert.ok(ifc.includes("'CH_Gefaelle'"), 'Pset Gefälle');
assert.ok(ifc.includes("'Pset_RampCommon'"));
const wallLine = ifc.split('\n').find((l) => l.includes('IFCWALL(') && l.includes(`'${w.id}'`));
assert.ok(wallLine, 'Wand im IFC');
const repId = wallLine!.match(/,#(\d+),'[^']*',\.NOTDEFINED\.\);/);
assert.ok(repId, 'Wand mit Unterkantenprofil: NOTDEFINED (Brep)');
assert.ok(/IFCSHAPEREPRESENTATION\([^)]*'Body','Brep'/.test(ifc), 'Brep-Körper');
// Prüfung mit IfcOpenShell (falls die Python-Umgebung von «Hausbau 1» vorhanden ist)
const PY = '/home/stefan/Documents/CodingProjects/Hausbau 1/.venv/bin/python';
if (existsSync(PY)) {
  const dir = mkdtempSync(join(tmpdir(), 'openriss-ramp-')); const f = join(dir, 'rampe.ifc');
  writeFileSync(f, ifc);
  const r = spawnSync(PY, ['-c', 'import sys, ifcopenshell, ifcopenshell.validate as v\nf = ifcopenshell.open(sys.argv[1]); l = v.json_logger(); v.validate(f, l, express_rules=True)\nprint(len(l.statements), len(f.by_type("IfcRamp")))', f], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '0 1', 'IFC gültig (IfcOpenShell), eine IfcRamp');
}

// ------------------------------------------------------------ Hausbau 2: Rampe als EINE Platte mit Profil + Trogwände (falls vorhanden)
const HB2 = '/home/stefan/Documents/CodingProjects/Hausbau 2/ausgabe/05_OpenRiss/Hausbau2.oriss';
if (existsSync(HB2)) {
  api.loadProject(readFileSync(HB2, 'utf8'));
  const old = doc.all().filter((e) => /^RA-\d+$/.test(e.id) || /^W-RA-[SN]\d+$/.test(e.id));
  // M.RAMPE: Profil OK Fahrbahn (x, z) in m, Breite 6.00 m netto + 2 × 30 cm Trogwände, Platte 40 cm, OK Wand +0.80
  const prof = [[-24.00, -0.22], [-22.47, -0.25], [-19.47, -0.49], [-3.00, -2.96], [0.00, -3.20]];
  api.transaction('Rampe ersetzen', () => {
    for (const e of old) doc.remove(e.id);
    doc.add({ id: 'RA', cat: 'floor', typeId: 'flt_rampe40', levelId: 'lvl_1ug', offset: 2980, structural: true, ramp: true, loops: [R(-24000, 3700, 0, 10300)],
      slope: { a: { x: -24000, y: 7000 }, dir: { x: 1, y: 0 }, prof: prof.map(([x, z]) => ({ s: (x + 24) * 1000, dz: (z + 0.22) * 1000 })) } } as any);
    for (const [id, y, a, b] of [['W-RA-S', 3850, -24000, 0], ['W-RA-N', 10150, 0, -24000]] as [string, number, number, number][])
      doc.add({ id, cat: 'wall', typeId: 'wt_stb30', a: { x: a, y }, b: { x: b, y }, levelId: 'lvl_1ug', baseOffset: 0, topLevelId: null, height: 4000, locLine: 'center', structural: true, attachBaseId: 'RA' } as any);
  });
  assert.equal(old.length, 24, '8 Plattenstücke + 16 Wandstücke ersetzt');
  const ra2 = doc.get('RA')!; const s2 = surfaceOf(doc, ra2)!;
  for (const [x, z] of prof) near(s2.topAt({ x: x * 1000, y: 5000 }), z * 1000, 1e-6, 'Kote Rampe x = ' + x);
  near(vol('RA'), 24000 * 6600 * 400, 1, 'Volumen Rampe');
  for (const id of ['W-RA-S', 'W-RA-N']) {
    const wr = doc.get<Wall>(id)!;
    near(wallZAt(doc, wr, id === 'W-RA-S' ? 4530 : 3000)[0], id === 'W-RA-S' ? -490 : -2960, 1e-6, 'UK Trogwand (x = −19.47 bzw. −3.00)');
    near(vol(id), wallArea(doc, wr) * 300, 1, 'Trogwand geschlossen');
  }
  const sec = doc.all<any>('view').find((v) => v.name === 'Rampe Längsschnitt');
  if (sec) assert.ok(buildViewDL(doc, sec).items.some((it: any) => it.o === 'RA' && it.k === 'fill'), 'Rampe im Längsschnitt geschnitten');
  assert.ok(/IFCRAMP\(/.test(api.exportIfc('Hausbau2.ifc', { cats: ['floor', 'wall'] })), 'IfcRamp im Teilmodell');
}

export { doc };
