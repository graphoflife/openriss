// Gelände und Baugrube: exakte Aushubvolumen (Böschung 1:n, Berme, Verbau, geneigtes Gelände), Schnitt, IFC.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../src/api';
import type { El } from '../src/core/doc';
import { solidVolume, cutPolysOfElement, solidsOf } from '../src/views/sectionEngine';
import { polyArea } from '../src/core/geom';
import { excavationVolumes, siteGeom, siteZ, earthSolid, cutSolid, excSite, parsePoints, buildTin, tinZ } from '../src/modules/site';

const rel = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${msg}: ${a} ≠ ${b} (${(((a - b) / b) * 100).toFixed(4)} %)`);
const frustum = (a: number, b: number, H: number, n: number) => a * b * H + (a + b) * n * H * H + (4 / 3) * n * n * H ** 3;
const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

function project(terrain: (x: number, y: number) => number, R = 60000): El {
  api.createProject();
  const pts = [];
  for (const x of [-R, 0, R]) for (const y of [-R, 0, R]) pts.push({ x, y, z: terrain(x, y) });
  return api.add({ cat: 'topo', name: 'Test', pts } as any);
}
const A = 20000, B = 10000, H = 4000;

// (a) ebenes Gelände, Rechteck a × b, Tiefe H, Böschung 1:n
for (const n of [1, 1.5]) {
  const topo = project(() => 0);
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: n } as any);
  const v = excavationVolumes(api.doc, ex)!;
  rel(v.cut, frustum(A, B, H, n), 1e-3, `Aushub 1:${n}`);
  rel(v.bottomArea, A * B, 1e-6, 'Sohlenfläche');
  const sl = Math.sqrt(1 + 1 / (n * n)); // Böschungsfläche: Grundriss der Böschungen × Neigungsfaktor
  rel(v.slopeArea, ((A + 2 * n * H) * (B + 2 * n * H) - A * B) * sl, 1e-6, 'Böschungsfläche');
  // geschlossene Körper: Erdkörper und Aushubkörper
  const sg = siteGeom(api.doc, topo);
  rel(solidVolume([earthSolid(sg)]), 120000 * 120000 * (0 - sg.zBase) - v.cut, 1e-7, 'Erdkörper');
  rel(solidVolume([cutSolid(sg, 0)]), v.cut, 1e-7, 'Aushubkörper');
  assert.equal(v.backfill, v.cut, 'ohne Bauwerk: Hinterfüllung = Aushub');
  // Endfläche: Sohle, Böschung, Gelände
  near(siteZ(sg, { x: A / 2, y: B / 2 }), -H, 1e-6, 'Sohle');
  near(siteZ(sg, { x: A / 2, y: -n * 1000 }), -H + 1000, 1e-6, 'Böschung');
  near(siteZ(sg, { x: A / 2, y: -n * H - 10 }), 0, 1e-6, 'Gelände');
  if (n === 1) {
    // Zwischenspeicher: unabhängige Änderung baut das Netz nicht neu
    api.addLevel({ name: 'Test', elev: 7000, plans: false });
    assert.equal(siteGeom(api.doc, api.doc.get(topo.id)!), sg, 'Cache über Elementobjekte');
    api.transaction('Sohle', () => api.doc.update(ex.id, { bottom: -H - 1000 }));
    assert.notEqual(siteGeom(api.doc, api.doc.get(topo.id)!), sg, 'Änderung der Grube');
    assert.equal(siteGeom(api.doc, api.doc.get(topo.id)!).dom, sg.dom, 'Netz bleibt');
  }
}
function near(a: number, b: number, tol: number, msg: string) { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b}`); }

// (b) mit Berme (1.0 m über der Sohle, 1.5 m breit), Böschung 1:1
{
  project(() => 0);
  const dz = 1000, w = 1500, n = 1;
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: n, berm: { dz, width: w } } as any);
  const v = excavationVolumes(api.doc, ex)!;
  const A2 = A + 2 * n * dz + 2 * w, B2 = B + 2 * n * dz + 2 * w;
  rel(v.cut, frustum(A, B, dz, n) + frustum(A2, B2, H - dz, n), 1e-3, 'Aushub mit Berme');
  rel(v.bermArea, A2 * B2 - (A + 2 * n * dz) * (B + 2 * n * dz), 1e-6, 'Bermenfläche');
}

// (c) Verbau: Südkante senkrecht
{
  const topo = project(() => 0);
  const n = 1.5;
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: n, edges: [{ vertical: true }, {}, {}, {}] } as any);
  const v = excavationVolumes(api.doc, ex)!;
  rel(v.cut, A * B * H + ((A + 2 * B) * n * H * H) / 2 + (2 * n * n * H ** 3) / 3, 1e-3, 'Aushub mit Verbau');
  rel(v.wallArea, A * H + n * H * H, 1e-6, 'Verbaufläche');
  const sg = siteGeom(api.doc, topo);
  rel(solidVolume([earthSolid(sg)]), 120000 * 120000 * (0 - sg.zBase) - v.cut, 1e-7, 'Erdkörper mit Verbau');
  rel(solidVolume([cutSolid(sg, 0)]), v.cut, 1e-7, 'Aushubkörper mit Verbau');
  near(siteZ(sg, { x: A / 2, y: -1 }), 0, 1e-6, 'hinter dem Verbau');
  near(siteZ(sg, { x: A / 2, y: 1 }), -H, 1e-6, 'vor dem Verbau');
}

// (d) geneigtes Gelände (Ebene 5 % in x, 2 % in y): Volumen weiterhin exakt (Vergleich mit feiner Integration)
{
  const T = (x: number, y: number) => 0.05 * x + 0.02 * y + 300;
  const topo = project(T);
  const n = 1.25;
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: n } as any);
  const v = excavationVolumes(api.doc, ex)!;
  const pit = (x: number, y: number) => -H + Math.max(0, -x, x - A, -y, y - B) / n;
  let s = 0; const h = 40;
  for (let x = -20000 + h / 2; x < A + 20000; x += h) for (let y = -20000 + h / 2; y < B + 20000; y += h) s += Math.max(0, T(x, y) - pit(x, y));
  rel(v.cut, s * h * h, 1e-4, 'Aushub geneigtes Gelände');
  const sg = siteGeom(api.doc, topo);
  rel(solidVolume([cutSolid(sg, 0)]), v.cut, 1e-7, 'Aushubkörper geneigt');
}

// (d2) nicht konvexer Umriss (L-Form) auf geneigtem Gelände: Grate an den ausspringenden, Kehle an der einspringenden
// Ecke. Bezug: bei rechtwinkligen Umrissen ist die Grubenfläche Sohle + (L∞-Abstand zum Umriss)/n.
{
  const T = (x: number, y: number) => 0.03 * x - 0.02 * y;
  const topo = project(T);
  const n = 1.5, Hd = 3500;
  const L = [{ x: 0, y: 0 }, { x: 30000, y: 0 }, { x: 30000, y: 12000 }, { x: 12000, y: 12000 }, { x: 12000, y: 25000 }, { x: 0, y: 25000 }];
  const ex = api.add({ cat: 'excavation', pts: L, bottom: -Hd, slope: n } as any);
  const v = excavationVolumes(api.doc, ex)!;
  const linf = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => Math.max(0, x0 - x, x - x1, y0 - y, y - y1);
  const pit = (x: number, y: number) => -Hd + Math.min(linf(x, y, 0, 0, 30000, 12000), linf(x, y, 0, 0, 12000, 25000)) / n;
  let s = 0; const h = 40;
  for (let x = -12000 + h / 2; x < 42000; x += h) for (let y = -12000 + h / 2; y < 37000; y += h) s += Math.max(0, T(x, y) - pit(x, y));
  rel(v.cut, s * h * h, 1e-4, 'Aushub L-Form');
  const sg = siteGeom(api.doc, topo);
  rel(solidVolume([cutSolid(sg, 0)]), v.cut, 1e-7, 'Aushubkörper L-Form');
  // Grat an der ausspringenden Ecke (0, 25000), Kehle an der einspringenden Ecke (12000, 12000)
  near(siteZ(sg, { x: -1500, y: 26500 }), -Hd + 1000, 1e-6, 'Grat');
  near(siteZ(sg, { x: 13500, y: 13000 }), -Hd + 1000 / 1.5, 1e-6, 'Kehle');
}

// (e) Schnitt durch die Grube: Schnittfläche des Erdkörpers = Rechteck bis Unterkante − Grubenquerschnitt
{
  const topo = project(() => 0);
  const n = 1;
  api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: n } as any);
  const sg = siteGeom(api.doc, topo);
  const yc = B / 2;
  const pr = { origin: { x: 0, y: yc, z: 0 }, dir: { x: 0, y: 1, z: 0 }, toView: (p: any) => ({ x: p.x, y: p.z }), depth: (p: any) => p.y - yc };
  const cuts = cutPolysOfElement(api.doc, api.doc.get(topo.id)!, pr as any);
  assert.equal(cuts.length, 1); assert.equal(cuts[0].polys.length, 1, 'eine Schnittfläche');
  const area = polyArea(cuts[0].polys[0]);
  rel(area, 120000 * -sg.zBase - (A + n * H) * H, 1e-9, 'Schnittfläche');
  // Profil: Sohle zwischen 0 und A auf −H, Krone bei −nH und A + nH auf 0
  const ring = cuts[0].polys[0][0];
  const has = (x: number, z: number) => ring.some((p) => Math.abs(p.x - x) < 0.01 && Math.abs(p.y - z) < 0.01);
  assert.ok(has(0, -H) && has(A, -H) && has(-n * H, 0) && has(A + n * H, 0), 'Profilpunkte');
}

// TIN: Höhenlinien als Zwangskanten, keine flachen Dreiecke zwischen den Linien, LV95-Koordinaten
{
  const E = 2600000e3, N = 1200000e3; // LV95 in mm
  const contours = [1, 2, 3].map((k) => ({ z: k * 1000, pts: Array.from({ length: 24 }, (_, i) => ({ x: E + Math.cos((i / 24) * 2 * Math.PI) * (40000 - k * 10000), y: N + Math.sin((i / 24) * 2 * Math.PI) * (40000 - k * 10000) })) }));
  const tin = buildTin({ pts: [{ x: E, y: N, z: 3500 }, { x: E - 45000, y: N - 45000, z: 0 }, { x: E + 45000, y: N - 45000, z: 0 }, { x: E + 45000, y: N + 45000, z: 0 }, { x: E - 45000, y: N + 45000, z: 0 }], contours });
  assert.ok(tin.nt > 70, 'Dreiecke');
  let flat = 0;
  for (let k = 0; k < tin.nt; k++) { const z = [0, 1, 2].map((j) => tin.z[tin.tri[3 * k + j]]); if (Math.abs(z[0] - z[1]) < 0.5 && Math.abs(z[0] - z[2]) < 0.5) flat++; }
  assert.equal(flat, 0, 'keine Terrassen');
  // zwischen zwei Höhenlinien liegt die Höhe zwischen ihren Koten
  const zm = tinZ(tin, E + 25000 - tin.ox, N - tin.oy);
  assert.ok(zm > 1000 && zm < 2000, 'Höhe zwischen den Linien ' + zm);
}

// Import: LV95 mit m ü. M. → Basispunkt/Höhenbezug
{
  api.createProject();
  const r = parsePoints('1 2600010.00 1200020.00 452.30\n2 2600030.0 1200020.0 452.80\n3 2600030 1200050 453.10', api.doc);
  assert.equal(r.pts.length, 3); assert.deepEqual(r.basePoint, { E: 2600023, N: 1200030 }); assert.equal(r.elev00, 452);
  near(r.pts[0].x, -13000, 1e-6, 'E'); near(r.pts[0].z, 300, 1e-6, 'H');
}

// (g) ohne Geländemodell (ebenes Ersatzgelände auf top), Sohle nach Längsprofil (Rampentrog), Böschung 1:2
{
  api.createProject();
  const prof = [{ s: 2000, z: -600 }, { s: 14000, z: -3000 }, { s: 20000, z: -3200 }];
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, 20000, 6000), top: -200, slope: 2, bottom: -3200, bottomProfile: { o: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, pts: prof } } as any);
  const v = excavationVolumes(api.doc, ex)!;
  const zb = (x: number) => { if (x <= prof[0].s) return prof[0].z; for (let i = 1; i < prof.length; i++) if (x <= prof[i].s) return prof[i - 1].z + ((prof[i].z - prof[i - 1].z) * (x - prof[i - 1].s)) / (prof[i].s - prof[i - 1].s); return prof[prof.length - 1].z; };
  const pit = (x: number, y: number) => zb(x) + Math.max(0, -x, x - 20000, -y, y - 6000) / 2;
  let s = 0; const h = 25;
  for (let x = -8000 + h / 2; x < 28000; x += h) for (let y = -8000 + h / 2; y < 14000; y += h) s += Math.max(0, -200 - pit(x, y));
  rel(v.cut, s * h * h, 1e-4, 'Rampentrog ohne Gelände');
  near(v.zBottomMin, -3200, 1e-6, 'Sohle min'); near(v.zBottomMax, -600, 1e-6, 'Sohle max');
}

// (f) IFC: Gelände und Aushub als IfcGeographicElement im Grundstück
{
  const topo = project(() => 0);
  const ex = api.add({ cat: 'excavation', pts: rect(0, 0, A, B), bottom: -H, slope: 1, mark: 'BG1' } as any);
  const lvl = api.doc.all('level')[0];
  api.addWall({ a: { x: 2000, y: 2000 }, b: { x: 18000, y: 2000 }, levelId: lvl.id, baseOffset: -H, height: H + 1000 });
  const v = excavationVolumes(api.doc, ex)!;
  const wallVol = solidVolume(solidsOf(api.doc, api.doc.all('wall')[0]));
  rel(v.building, wallVol * (H / (H + 1000)), 1e-3, 'Bauwerk im Aushub (unter Terrain)');
  rel(v.backfill, v.cut - v.building, 1e-9, 'Hinterfüllung');
  const ifc = api.exportIfc('site.ifc');
  const geo = ifc.split('\n').filter((l) => l.includes('IFCGEOGRAPHICELEMENT('));
  assert.equal(geo.length, 2, 'zwei IfcGeographicElement');
  assert.ok(geo.some((l) => l.includes('.TERRAIN.')) && geo.some((l) => l.includes('.USERDEFINED.') && l.includes("'Aushub'")), 'TERRAIN und Aushub');
  const siteId = ifc.match(/#(\d+)=IFCSITE\(/)![1];
  const ids = geo.map((l) => l.match(/^#(\d+)=/)![1]);
  const rel0 = ifc.split('\n').find((l) => l.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE') && l.trim().endsWith(`#${siteId});`));
  assert.ok(rel0 && ids.every((i) => new RegExp(`#${i}[,)]`).test(rel0)), 'im Grundstück enthalten');
  assert.ok(/CH_Aushub/.test(ifc) && /Volumen_Aushub/.test(ifc), 'Pset CH_Aushub');
  // Validierung mit IfcOpenShell (falls vorhanden)
  const py = '/home/stefan/Documents/CodingProjects/Hausbau 1/.venv/bin/python';
  if (existsSync(py)) {
    const dir = mkdtempSync(join(tmpdir(), 'site-ifc-')); const f = join(dir, 'site.ifc'); writeFileSync(f, ifc);
    const r = spawnSync(py, ['-c', `import ifcopenshell, ifcopenshell.validate, sys
f=ifcopenshell.open(sys.argv[1]); l=ifcopenshell.validate.json_logger(); ifcopenshell.validate.validate(f, l)
print(len(l.statements)); [print(s) for s in l.statements[:5]]`, f], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    if (r.status === 0) assert.equal(r.stdout.trim().split('\n')[0], '0', 'IFC-Validierung: ' + r.stdout);
    else console.warn('IfcOpenShell nicht ausführbar:', r.stderr.slice(0, 200));
  }
  void topo; void excSite;
}
