// Gemeinsamer Unterbau: Körper mit geknickter Oberseite (Rampe), Volumen geschlossener Körper, Schnitt.
import assert from 'node:assert/strict';
import '../src/registerModules';
import type { V2 } from '../src/core/geom';
import { profiledPrism, solidVolume, prism, cutPolysOfElement } from '../src/views/sectionEngine';
import { polyArea } from '../src/core/geom';

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`);

// Quader: Volumen exakt
near(solidVolume([prism([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1000 }, { x: 0, y: 1000 }], 0, 500)]), 2000 * 1000 * 500, 1e-3, 'Quader');

// Rampe 10 × 6 m mit Knicken bei x = 3 m und 7 m (8 % / 15 % / 8 %), Stärke 400 senkrecht, mit Loch
const ring: V2[] = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 }];
const hole: V2[] = [{ x: 4000, y: 2000 }, { x: 5000, y: 2000 }, { x: 5000, y: 3000 }, { x: 4000, y: 3000 }];
const prof = [{ s: 0, z: 0 }, { s: 3000, z: -240 }, { s: 7000, z: -840 }, { s: 10000, z: -1080 }];
const zt = (p: V2) => {
  for (let i = 1; i < prof.length; i++) if (p.x <= prof[i].s + 1e-9) { const a = prof[i - 1], b = prof[i]; return a.z + ((b.z - a.z) * (p.x - a.s)) / (b.s - a.s); }
  return prof[prof.length - 1].z;
};
const zb = (p: V2) => zt(p) - 400;
const creases = [{ a: { x: 3000, y: 0 }, b: { x: 3000, y: 1 } }, { a: { x: 7000, y: 0 }, b: { x: 7000, y: 1 } }];
const faces = profiledPrism([ring, hole], zt, zb, creases);
const area = polyArea([ring, hole]);
near(solidVolume([faces]), area * 400, area * 400 * 1e-9, 'Rampe');
// Oberseite: 3 Zellen (oben) + 3 (unten) + Seiten (4 außen + 4 Loch)
assert.equal(faces.length, 6 + 8);
// Schnitt längs (y = 1000) ergibt ein geschlossenes Polygon mit der Fläche Länge × 400
const el: any = { id: '__t', cat: 'probe' };
const { registerCategory } = await import('../src/core/registry');
registerCategory({ cat: 'probe', label: 'Probe', plural: 'Proben', solids: () => [{ faces }] });
const { app } = await import('../src/app');
const pr = { origin: { x: 0, y: 1000, z: 0 }, dir: { x: 0, y: 1, z: 0 }, toView: (p: any) => ({ x: p.x, y: p.z }), depth: (p: any) => p.y - 1000 };
const cuts = cutPolysOfElement(app.doc, el, pr as any);
assert.equal(cuts.length, 1);
near(cuts[0].polys.reduce((s, p) => s + polyArea(p), 0), 10000 * 400, 1, 'Schnittfläche Rampe');
