// Bewehrung Schweiz: BVBS-Prüfziffer (Beispiele der Richtlinie 3.1), SSHV-Formerkennung, Positionen je Plan,
// Eisenliste und ABS-Export im Vergleich mit dem Projekt «Hausbau 1» (falls vorhanden).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import '../src/registerModules';
import { app } from '../src/app';
import type { V3 } from '../src/core/geom';
import { offsetPolyline } from '../src/core/geom';
import { dlBuilder } from '../src/core/registry';
import { bvbsChecksum, bvbsSelfTest, bvbsLine } from '../src/modules/structure/rebar/bvbs';
import { figureOf, planarize, checkFigure, mandrelOf, minLegs } from '../src/modules/structure/rebar/sshv';
import { assignPos, Rebar } from '../src/modules/structure/rebar/rebar';
import { planOf } from '../src/modules/structure/rebar/norm';
import { rebarFigure, absExport, eisenRows, eisenSummary, eisenlisteCsv, renumberPlans, createRebarSchedule, createEisenliste } from '../src/modules/structure/steel';
import { stahllisteCsv } from '../src/modules/structure/schedule';
import { eisenlisteHtml } from '../src/modules/structure/eisenliste';

// ------------------------------------------------------------ BVBS (Selbsttest der Python-Referenz)
assert.equal(bvbsChecksum('BF2D@HjTestPDF@r417@ia@p1@l1000@n10@e0.888@d12@gB500A@s48@v@Gl400@w90@l600@w0@C'), 72);
assert.equal(bvbsChecksum('abcde@C'), 78);
assert.ok(bvbsSelfTest());
assert.equal(bvbsLine({ project: '2026-101', plan: 'T-205', index: '0', pos: 17, len: 1180, n: 200, kgEach: 1.18 * 0.617, dia: 10, mandrel: 40, legs: [500, 180, 500], angles: [90, 90] }),
  'BF2D@Hj2026-101@rT-205@i0@p17@l1180@n200@e0.728@d10@gB500B@s40@v@Gl500@w90@l180@w90@l500@w0@C72@');
assert.equal(bvbsLine({ project: '2026-101', plan: 'T-205', index: '0', pos: 28, len: 1200, n: 14, kgEach: 1.2 * 0.888, dia: 12, mandrel: 48, legs: [1200], angles: [],
  coupler: { end: { sys: 'Muffe M12 (z.B. Lenton/ Ancon)', type: 'A12' } } }),
  'BF2D@Hj2026-101@rT-205@i0@p28@l1200@n14@e1.066@d12@gB500B@s48@v@Gl1200@w0@Ma@b@c@nMuffe M12 (z.B. Lenton/ Ancon)@oA12@p1@C93@');

// ------------------------------------------------------------ SSHV-Formen (Achspolylinien, Ø 10, d3 = 40)
const P = (x: number, y: number, z = 0): V3 => ({ x, y, z });
const fig = (pts: V3[], d = 10) => figureOf(pts, d, mandrelOf('SIA', d));
const cm = (f: { legs: number[] }) => f.legs.map((l) => Math.round(l / 10)).join('/');
assert.equal(fig([P(0, 0), P(3000, 0)]).nr, '1');
// U-Steckbügel: Achse 495/170/495 → Aussenmasse 50/18/50 cm
let f = fig([P(0, 495), P(0, 0), P(170, 0), P(170, 495)]);
assert.equal(f.nr, '205'); assert.equal(cm(f), '50/18/50'); assert.deepEqual(f.angles, [90, 90]);
f = fig([P(0, 300), P(0, 0), P(170, 0), P(170, 495)]); assert.equal(f.nr, '206');
f = fig([P(0, 295, 0), P(0, 0, 0), P(0, 0, 975)], 16); assert.equal(f.nr, '103');
f = fig([P(0, 0), P(1000, 0), P(1000, 500), P(2000, 500)]); assert.equal(f.nr, '231');
f = fig([P(0, 0), P(1000, 0), P(1500, 500), P(2500, 500)]); assert.equal(f.nr, '209');
// Stab mit 180°-Haken (zwei 90°-Ecken, Steg = Biegerolle + Ø)
f = fig([P(0, 0), P(2000, 0), P(2000, 50), P(1900, 50)]); assert.equal(f.nr, '101'); assert.equal(f.angles.length, 1); assert.equal(Math.abs(f.angles[0]), 180);
// geschlossener Bügel mit Haken 135° (OpenRiss-Form 51)
const h = 80 / Math.SQRT2;
f = fig([P(h, 300 - h), P(0, 300), P(0, 0), P(200, 0), P(200, 300), P(0, 300), P(h, 300 - h)]); assert.equal(f.nr, '553');
// Bügel mit Übergriff (405) und räumliche Form
f = fig([P(200, 300), P(0, 300), P(0, 0), P(200, 0), P(200, 290), P(10, 290)]); assert.equal(f.nr, '405');
assert.equal(fig([P(0, 0), P(500, 0), P(500, 500), P(500, 500, 500)]).planar, false);
assert.ok(planarize([P(0, 0), P(1, 0)]).planar);
// Biegerollen und Mindestschenkel
assert.equal(mandrelOf('SIA', 16), 64); assert.equal(mandrelOf('SIA', 18), 126); assert.equal(mandrelOf('DIN', 18), 72); assert.equal(mandrelOf('SIA', 10, 'd1'), 150);
assert.deepEqual(minLegs(10), { A: 100, B: 70 });
assert.ok(checkFigure(fig([P(0, 60), P(0, 0), P(170, 0), P(170, 495)]), 10).some((w) => w.startsWith('Schenkel 3')));

// ------------------------------------------------------------ Hausbau 1: Eisenliste T-205, ABS
const ORISS = '/home/stefan/Documents/CodingProjects/Hausbau 1/ausgabe/05_OpenRiss/Hausbau1.oriss';
const ABS = '/home/stefan/Documents/CodingProjects/Hausbau 1/ausgabe/04_Eisenlisten/T-205.abs';
const CSV = '/home/stefan/Documents/CodingProjects/Hausbau 1/ausgabe/04_Eisenlisten/T-205_Eisenliste.csv';
if (existsSync(ORISS) && existsSync(ABS)) {
  const doc = app.doc;
  doc.load(JSON.parse(readFileSync(ORISS, 'utf8')));
  const ref = readFileSync(ABS, 'latin1').split('\r\n').filter(Boolean);
  // Plan: Feld «plan» oder (Migration) Plannummer in «Kommentare»
  const t205 = doc.all<Rebar>('rebar').filter((r) => planOf(r) === 'T-205');
  assert.ok(t205.length > 50);
  doc.transaction('CH', () => {
    doc.update('project', { rebarNorm: 'SIA' } as any);
    for (const r of t205) if (r.form) doc.update(r.id, { form: undefined }); // Formnummer automatisch erkennen
  });
  const same = (txt: string) => { const l = txt.split('\r\n').filter(Boolean); return l.filter((x, i) => x === ref[i]).length; };
  const raw = absExport(doc, 'T-205');
  const nRaw = same(raw);
  console.log(`  T-205.abs aus Hausbau1.oriss (unverändert): ${nRaw}/${ref.length} Zeilen identisch`);
  assert.equal(raw.split('\r\n').filter(Boolean).length, ref.length);
  // Generator-Daten angleichen: Schenkelpunkte = Stabachse (Aussenmass − Ø/2 je gebogenes Ende), Muffe Pos. 28 wie Referenz
  const refLegs = new Map(readFileSync(CSV, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(';')).map((c) => [Number(c[1]), c[5]] as [number, string]));
  doc.transaction('Achsen', () => {
    for (const r of t205) {
      const want = refLegs.get(r.pos);
      if (r.pts.length >= 3 && want && cm(rebarFigure(doc, r)) !== want) {
        const p0 = r.pts[0], u = norm(sub(r.pts[1], p0));
        const n = norm(cross(sub(r.pts[1], p0), sub(r.pts[2], p0))), v = cross(n, u);
        const flat = r.pts.map((p) => ({ x: dot(sub(p, p0), u), y: dot(sub(p, p0), v) }));
        const len2 = (q: { x: number; y: number }[]) => q.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - q[i].x, p.y - q[i].y), 0);
        const a = offsetPolyline(flat, r.dia / 2), b = offsetPolyline(flat, -r.dia / 2);
        const off = len2(a) < len2(b) ? a : b;
        doc.update(r.id, { pts: off.map((q) => add(p0, add(mul(u, q.x), mul(v, q.y)))) });
      }
      if (r.pos === 28) doc.update(r.id, { coupler: { end: { sys: 'Muffe M12 (z.B. Lenton/ Ancon)', type: 'A12' } } });
    }
  });
  const fixed = absExport(doc, 'T-205');
  const nFix = same(fixed);
  console.log(`  T-205.abs mit Achsgeometrie und Muffe: ${nFix}/${ref.length} Zeilen identisch`);
  if (nFix !== ref.length) for (const [i, l] of fixed.split('\r\n').filter(Boolean).entries()) if (l !== ref[i]) console.log('   −', ref[i], '\n   +', l);
  assert.equal(nFix, ref.length);
  assert.ok(fixed.endsWith('\r\n'));
  // A3: U-Steckbügel Pos. 17 = Form 205, 50/18/50
  const p17 = t205.find((r) => r.pos === 17)!;
  const f17 = rebarFigure(doc, doc.get<Rebar>(p17.id)!);
  assert.equal(f17.nr, '205'); assert.equal(cm(f17), '50/18/50');
  // A4: Eisenliste (Zusammenfassung wie T-205_Eisenliste.pdf: 27 Positionen, 1201.7 kg, Spezial 1 Pos.)
  const rows = eisenRows(doc, 'T-205');
  const z = eisenSummary(rows);
  assert.equal(z.count, 27); assert.equal(z.kg.toFixed(1), '1201.7'); assert.equal((z.fixLen / 1000).toFixed(2), '1189.05'); assert.equal(z.special.count, 1);
  assert.equal((z.bLen / 1000).toFixed(2), '657.51');
  const csvRef = readFileSync(CSV, 'utf8').trim().split(/\r?\n/).map((l) => l.split(';').slice(0, 10).join(';'));
  const csv = eisenlisteCsv(doc, 'T-205').trim().split(/\r?\n/).map((l) => l.split(';').slice(0, 10).join(';'));
  assert.deepEqual(csv.slice(1), csvRef.slice(1));
  assert.ok(eisenlisteHtml(doc, { plan: 'T-205' }).includes('Form 205'));
  assert.ok(stahllisteCsv(doc, 'T-205').split('\r\n').length > 28);
  // Liste auf dem Plan: Display-Liste mit Formskizzen
  const el = createEisenliste(doc, 'T-205');
  const dl = dlBuilder('schedule')!(doc, el);
  assert.ok(dl.items.filter((p) => p.k === 'poly').length > 28);
  // C1: Vorlage «Stahlliste je Plan» (Bauteilliste mit Skizzen)
  const sv = createRebarSchedule(doc, 'T-205');
  const dl2 = dlBuilder('schedule')!(doc, sv);
  assert.ok(dl2.items.some((p) => p.k === 'text' && p.s === '18'));
  // A6: Positionen je Plan
  const cur17 = doc.get<Rebar>(p17.id)!;
  assert.equal(assignPos(doc, { ...cur17, id: 'rb_test', plan: 'T-205' } as Rebar), 17);
  assert.equal(assignPos(doc, { ...cur17, id: 'rb_test2', plan: 'T-999', comments: '' } as Rebar), 1);
  renumberPlans(doc, true);
  for (const p of ['T-201', 'T-205', 'T-211']) {
    const pos = new Set(doc.all<Rebar>('rebar').filter((r) => planOf(r) === p).map((r) => r.pos));
    assert.ok(pos.has(1) && Math.max(...pos) === pos.size, `${p}: Positionen 1…n`);
  }
} else console.log('  (Hausbau 1 nicht gefunden – Vergleich übersprungen)');

function sub(a: V3, b: V3): V3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add(a: V3, b: V3): V3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function mul(a: V3, s: number): V3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: V3, b: V3): V3 { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function norm(a: V3): V3 { const l = Math.hypot(a.x, a.y, a.z) || 1; return mul(a, 1 / l); }
