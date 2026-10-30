// Beispiel für die OpenRiss-Skript-API. Ausführen:
//   npx openriss build examples/einfamilienhaus.ts --out haus.oriss --svg plaene --dxf dxf --ifc haus.ifc
import {
  createProject, addLevel, addGrid, addWall, addDoor, addWindow, addFloor, addRoof, addRoom, addColumn, addBeam,
  addRebar, addRebarTag, addSection, addSheet, placeView, addSchedule, tagOnPlace, transaction, doc, sheets,
} from 'openriss';

createProject({ name: 'Einfamilienhaus API', number: '2026-001', client: 'Muster AG', author: 'Skript' });
const eg = 'lvl_eg', og = 'lvl_og';
const dach = addLevel({ name: 'Dach', elev: 5800, plans: true });

for (const [n, x] of [['1', 0], ['2', 6000], ['3', 12000]] as const) addGrid({ name: n, a: { x, y: -2500 }, b: { x, y: 11500 } });
for (const [n, y] of [['A', 0], ['B', 9000]] as const) addGrid({ name: n, a: { x: -2500, y }, b: { x: 14500, y } });

// Außenwände im Uhrzeigersinn (Außenseite links), Innenwand
const P = (x: number, y: number) => ({ x, y });
const ring = [P(0, 0), P(0, 9000), P(12000, 9000), P(12000, 0)];
const walls = ring.map((a, i) => addWall({ a, b: ring[(i + 1) % 4], levelId: eg, topLevelId: og, typeId: 'wt_awwdvs' }));
const iw = addWall({ a: P(6000, 0), b: P(6000, 9000), levelId: eg, topLevelId: og, typeId: 'wt_iw175' });
const wallsOG = ring.map((a, i) => addWall({ a, b: ring[(i + 1) % 4], levelId: og, topLevelId: dach.id, typeId: 'wt_awwdvs' }));

const ops = [
  addDoor({ hostId: walls[3].id, t: 6000, typeId: 'dt_1010' }), addDoor({ hostId: iw.id, t: 3000 }),
  addWindow({ hostId: walls[1].id, t: 3000, typeId: 'ft_2010' }), addWindow({ hostId: walls[1].id, t: 9000 }),
  addWindow({ hostId: walls[2].id, t: 4500, typeId: 'ft_1260' }),
];
addFloor({ loops: [[P(-10, -10), P(-10, 9010), P(12010, 9010), P(12010, -10)]], levelId: eg, typeId: 'flt_bodenplatte_aufbau' });
addFloor({ loops: [[P(-10, -10), P(-10, 9010), P(12010, 9010), P(12010, -10)]], levelId: og, typeId: 'flt_stb20' });
const roof = addRoof({ loops: [[P(-500, -500), P(-500, 9500), P(12500, 9500), P(12500, -500)]], levelId: dach.id, typeId: 'rft_ziegel',
  edges: [[{ slope: false, angle: 30 }, { slope: true, angle: 30 }, { slope: false, angle: 30 }, { slope: true, angle: 30 }]] });
// Giebelwände bis unter das Dach (Wand oben fixieren)
transaction('Giebel', () => { for (const w of [wallsOG[0], wallsOG[2]]) doc.update(w.id, { attachTopId: roof.id }); });
const rooms = [addRoom({ pt: P(3000, 4500), levelId: eg, name: 'Wohnen', number: '0.01' }), addRoom({ pt: P(9000, 4500), levelId: eg, name: 'Küche', number: '0.02' })];

// Tragwerk: Stütze und Unterzug mit Bewehrung
addColumn({ p: P(3000, 4500), levelId: eg, topLevelId: og, topOffset: -500 });
const bm = addBeam({ a: P(0, 4500), b: P(6000, 4500), levelId: og });
const stir = addRebar({ hostId: bm.id, dia: 10, shape: '51', layout: 'maxSpacing', spacing: 150, dir: { x: -1, y: 0, z: 0 }, span: 5930, hookA: 135, hookB: 135,
  hookNA: { x: 0, y: 0, z: 1 }, hookNB: { x: 0, y: 1, z: 0 },
  pts: [{ x: 5965, y: 4385, z: 2535 }, { x: 5965, y: 4615, z: 2535 }, { x: 5965, y: 4615, z: 2965 }, { x: 5965, y: 4385, z: 2965 }, { x: 5965, y: 4385, z: 2535 }] });
const bot = addRebar({ hostId: bm.id, dia: 16, layout: 'count', count: 3, dir: { x: 0, y: 1, z: 0 }, span: 204, pts: [{ x: 5970, y: 4398, z: 2548 }, { x: 30, y: 4398, z: 2548 }] });

// Ansichten und Pläne
const planEG = doc.all<any>('view').find((v) => v.kind === 'plan' && v.levelId === eg);
tagOnPlace([...ops.map((o) => o.id), ...rooms.map((r) => r.id)], planEG.id);
const secA = addSection({ name: 'Schnitt A-A', a: P(4000, -2000), b: P(4000, 11000), far: 4000, z0: -1500, z1: 9000, marker: 'A' });
const det = addSection({ name: 'Detail Unterzug', a: P(3000, 4000), b: P(3000, 5000), far: 1500, z0: 2300, z1: 3200, scale: 20, detail: 'fine', marker: 'D' });
addRebarTag(stir.id, det.id, P(280, 280)); addRebarTag(bot.id, det.id, P(280, -160));
const s1 = addSheet({ no: 'A-101', name: 'Grundriss EG', size: 'A3' });
placeView(s1.id, planEG.id, P(170, 160));
const s2 = addSheet({ no: 'A-201', name: 'Schnitt und Detail', size: 'A3' });
placeView(s2.id, secA.id, P(130, 160)); placeView(s2.id, det.id, P(320, 200));
placeView(s1.id, addSchedule({ name: 'Türliste', cat: 'door' }).id, P(300, 270));
console.log(`Beispielprojekt: ${doc.all().length} Elemente, ${sheets().length} Pläne`);
