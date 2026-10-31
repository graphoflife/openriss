// N7 Lange Bauteillisten umbrechen: Abschnitte mit wiederholter Kopfzeile, Übertrag/Zwischentotal, Ansichtsfenster
// mit Abschnittsbereich (Fortsetzung auf weiteren Plänen), Eisenliste mit Übertrag in kg.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import type { El } from '../src/core/doc';
import { buildViewDL } from '../src/views/viewBuilder';
import { buildTable, schedSegments, tableParts, fieldsFor } from '../src/modules/output/schedules';
import { vpBox, Viewport } from '../src/modules/output/viewports';
import { pageOf, pageSvg } from '../src/modules/output/common';
import { createEisenliste, eisenRows } from '../src/modules/structure/steel';

const doc = api.createProject();
const lv = doc.all<any>('level').sort((a, b) => a.elev - b.elev)[0];
const walls: El[] = [];
for (let i = 0; i < 60; i++) walls.push(api.addWall({ a: { x: 0, y: i * 1000 }, b: { x: 2000 + i * 100, y: i * 1000 }, levelId: lv.id }));
api.transaction('Kennzeichen', () => walls.forEach((w, i) => doc.update(w.id, { mark: 'W' + String(i + 1).padStart(2, '0') })));
const def = { cat: 'wall', fields: ['mark', 'length', 'area', 'count'], sort: [{ key: 'mark' }], totals: true, itemize: true, filters: [], sums: ['length', 'area', 'count'] };
const sc = api.addSchedule({ name: 'Wandliste', cat: 'wall', def });
const full = buildTable(doc, sc);
assert.equal(full.rows.filter((r) => r.kind === 'data').length, 60);
const total0 = full.rows.find((r) => r.kind === 'total')!.cells;
assert.equal(schedSegments(doc, sc).length, 1, 'ohne Umbruch ein Abschnitt');

// ------------------------------------------------------------ Umbruch bei 120 mm
api.transaction('Umbruch', () => doc.update(sc.id, { data: { ...doc.get<any>(sc.id).data, split: { maxH: 120 } } }));
const v = doc.get<any>(sc.id);
const segs = schedSegments(doc, v);
// Zeile 6 mm, Titel+Kopf 16 mm, Übertrag 6 mm: 16 Zeilen, dann je 15, letzte Zeile bleibt bei der Gesamtsumme
assert.equal(segs.length, 4, 'vier Abschnitte');
for (const s of segs) assert.ok(s.h <= 120 + 1e-6, `Abschnittshöhe ${s.h} ≤ 120`);
const texts = (dl: { items: any[] }) => dl.items.filter((p) => p.k === 'text').map((p) => p.s as string);
for (const s of segs) assert.equal(texts(s.dl).filter((t) => t === 'Länge').length, 1, 'Kopfzeile in jedem Abschnitt');
assert.ok(texts(segs[1].dl).includes('Wandliste (Fortsetzung)'));
const parts = tableParts(doc, v);
assert.equal(parts.length, 4);
const lenF = fieldsFor(doc, 'wall').find((f) => f.key === 'length')!;
const seen: El[] = [];
parts.forEach((rows, k) => {
  if (k > 0) {
    assert.equal(rows[0].kind, 'carry', 'Übertrag am Anfang');
    assert.equal(rows[0].cells[0], 'Übertrag');
    assert.equal(rows[0].cells[3], seen.length, 'Übertrag Anzahl = bisherige Zeilen');
    const s = seen.reduce((a, el) => a + lenF.get(el, doc), 0);
    assert.ok(Math.abs(rows[0].cells[1] - s) < 1e-6, 'Übertrag Länge = Teilsumme');
  }
  for (const r of rows) if (r.kind === 'data') seen.push(...r.ids.map((id) => doc.get(id)!));
  if (k < parts.length - 1) {
    const last = rows[rows.length - 1];
    assert.equal(last.kind, 'carry', 'Übertrag am Ende');
    assert.equal(last.cells[3], seen.length);
    assert.ok(!rows.some((r) => r.kind === 'total'), 'Gesamtsumme nur im letzten Abschnitt');
  }
});
assert.equal(seen.length, 60, 'jede Zeile genau einmal');
assert.deepEqual(parts[3][parts[3].length - 1].cells, total0, 'Gesamtsumme unverändert');
// Übertrag am Anfang = Übertrag am Ende des vorherigen Abschnitts
for (let k = 1; k < parts.length; k++) assert.deepEqual(parts[k][0].cells, parts[k - 1][parts[k - 1].length - 1].cells);
// Zwischentotal je Abschnitt (Summe der Abschnittszeilen)
api.transaction('Zwischentotal', () => doc.update(sc.id, { data: { ...doc.get<any>(sc.id).data, split: { maxH: 120, subtotal: true } } }));
const p2 = tableParts(doc, doc.get<any>(sc.id));
for (const rows of p2) {
  const st = rows.find((r) => r.kind === 'subtotal')!;
  assert.ok(st, 'Zwischentotal');
  assert.equal(st.cells[3], rows.filter((r) => r.kind === 'data').length);
}
for (const s of schedSegments(doc, doc.get<any>(sc.id))) assert.ok(s.h <= 120 + 1e-6);

// ------------------------------------------------------------ Ansichtsfenster: zwei Abschnitte nebeneinander, Fortsetzung auf zweitem Plan
api.transaction('Spalten', () => doc.update(sc.id, { data: { ...doc.get<any>(sc.id).data, split: { maxH: 120, cols: 2, gap: 10 } } }));
const sv = doc.get<any>(sc.id);
const segs2 = schedSegments(doc, sv);
const W = segs2[0].w;
const sh1 = api.addSheet({ no: 'A-601', name: 'Wandliste 1', size: 'A3' });
const sh2 = api.addSheet({ no: 'A-602', name: 'Wandliste 2', size: 'A3' });
const vp1 = api.placeView(sh1.id, sc.id, { x: 30, y: 280 }) as Viewport;
const vp2 = api.placeView(sh2.id, sc.id, { x: 30, y: 280 }) as Viewport;
api.transaction('Fortsetzung', () => doc.update(vp2.id, { segFrom: 2, segCount: 'rest' }));
const b1 = vpBox(doc, doc.get<Viewport>(vp1.id)!, sv), b2 = vpBox(doc, doc.get<Viewport>(vp2.id)!, sv);
assert.ok(Math.abs(b1.max.x - b1.min.x - (2 * W + 10)) < 0.5, 'zwei Abschnitte nebeneinander');
assert.ok(b1.max.y - b1.min.y <= 120 + 0.5 && b2.max.y - b2.min.y <= 120 + 0.5, 'Höhe ≤ Abschnittshöhe');
assert.ok(Math.abs(b1.max.y - 280) < 0.5 && Math.abs(b1.min.x - 30) < 0.5, 'linke obere Ecke am Einfügepunkt');
const s1 = pageSvg(pageOf(doc, doc.get<any>(sh1.id))!), s2 = pageSvg(pageOf(doc, doc.get<any>(sh2.id))!);
assert.ok(s1.includes('Übertrag') && s2.includes('Übertrag') && s2.includes('Gesamtsumme') && !s1.includes('Gesamtsumme'));
assert.equal((s1.match(/Wandliste \(Fortsetzung\)/g) ?? []).length, 1, 'Plan 1: Abschnitte 1–2');
assert.equal((s2.match(/Wandliste \(Fortsetzung\)/g) ?? []).length, 2, 'Plan 2: Abschnitte 3–4');
// Abschnitt ausserhalb: Hinweis statt leerer Liste
api.transaction('zu weit', () => doc.update(vp2.id, { segFrom: 7 }));
assert.ok(pageSvg(pageOf(doc, doc.get<any>(sh2.id))!).includes('nicht vorhanden'));
// Ansicht selbst (Druck/Export): alle Abschnitte
assert.equal(texts(buildViewDL(doc, sv)).filter((t) => t === 'Länge').length, 4);

// ------------------------------------------------------------ Eisenliste: Übertrag in kg, Zusammenfassung nur am Schluss
const host = walls[0];
api.transaction('Bewehrung', () => {
  for (let i = 0; i < 40; i++) {
    const dia = [8, 10, 12, 16][i % 4]; const L = 1000 + 50 * i; const bent = i % 3 === 0;
    const pts = bent ? [{ x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 0 }, { x: L, y: 0, z: 0 }] : [{ x: 0, y: 0, z: 0 }, { x: L, y: 0, z: 0 }];
    doc.add({ id: 'rb' + i, cat: 'rebar', hostId: host.id, dia, pts, pos: i + 1, plan: 'T-900', shape: '00', layout: 'single', count: 1 + (i % 5), spacing: 150, display: 'first', hookA: 0, hookB: 0, dir: { x: 0, y: 1, z: 0 }, span: 0 } as any);
  }
});
const rows = eisenRows(doc, 'T-900');
assert.equal(rows.length, 40);
const el = createEisenliste(doc, 'T-900');
assert.equal(schedSegments(doc, el).length, 1);
api.transaction('Umbruch', () => doc.update(el.id, { data: { ...doc.get<any>(el.id).data, split: { maxH: 300, subtotal: true } } }));
const ev = doc.get<any>(el.id);
const es = schedSegments(doc, ev);
assert.ok(es.length >= 2, `Eisenliste in ${es.length} Abschnitte`);
for (const s of es) assert.ok(s.h <= 300 + 1e-6, `Höhe ${s.h}`);
const kgOf = (t: string) => Number(/Gewicht ([\d.]+) kg/.exec(t)![1]);
let run = 0;
es.forEach((s, k) => {
  const tx = s.dl.items.filter((p: any) => p.k === 'text') as any[];
  // Positionsnummern (fett, rechtsbündig in der ersten Spalte)
  const pos = tx.filter((p) => p.font.bold && p.font.ha === 'right' && Math.abs(p.p.x - 10.5) < 0.01).map((p) => Number(p.s));
  const kg = rows.filter((r) => pos.includes(r.pos)).reduce((a, r) => a + r.kg, 0);
  const carry = tx.filter((p) => /^Gewicht /.test(p.s)).map((p) => kgOf(p.s));
  if (k > 0) assert.equal(carry[0].toFixed(1), run.toFixed(1), 'Übertrag am Anfang = Gewicht der vorherigen Abschnitte');
  run += kg;
  if (k < es.length - 1) {
    assert.equal(carry[carry.length - 1].toFixed(1), run.toFixed(1), 'Übertrag am Ende (kg)');
    assert.equal(carry[carry.length - 2].toFixed(1), kg.toFixed(1), 'Zwischentotal des Abschnitts (kg)');
  }
  assert.ok(!tx.some((p) => /Übertrag/.test(p.s) && / m$/.test(p.s)), 'kein Übertrag in Metern');
  assert.equal(tx.some((p) => p.s === 'Zusammenfassung (B500B)'), k === es.length - 1, 'Zusammenfassung nur im letzten Abschnitt');
  assert.ok(tx.some((p) => p.s === 'Tot. [m]'), 'Kopfzeile wiederholt');
});
assert.equal(run.toFixed(1), rows.reduce((a, r) => a + r.kg, 0).toFixed(1), 'alle Positionen genau einmal');
// zwei Abschnitte nebeneinander auf einem A1
api.transaction('Spalten', () => doc.update(el.id, { data: { ...doc.get<any>(el.id).data, split: { maxH: 300, cols: 2 } } }));
const sh3 = api.addSheet({ no: 'T-900.1', name: 'Eisenliste T-900', size: 'A1' });
const vp3 = api.placeView(sh3.id, el.id, { x: 30, y: 570 }) as Viewport;
const b3 = vpBox(doc, doc.get<Viewport>(vp3.id)!, doc.get<any>(el.id));
assert.ok(b3.max.x - b3.min.x > 2 * 186 && b3.max.y - b3.min.y <= 300 + 0.5, 'Eisenliste zweispaltig');
assert.ok(pageSvg(pageOf(doc, doc.get<any>(sh3.id))!).includes('Übertrag'));
