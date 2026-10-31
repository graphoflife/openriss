// N14 Grossformat-Pläne: 70 m langes Gebäude, Grundriss in drei abhängige Ansichten geteilt, je auf einem A0;
// Abgleich der Eigenschaften (ein Rückgängig-Schritt), Beschriftungen der Primäransicht im Teilplan (zugeschnitten),
// Anschlusslinien mit Plannummer des Nachbarteils, Übersichtsrahmen, Schlüsselplan, Löschen mit der Primäransicht.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as api from '../src/api';
import type { View } from '../src/core/view';
import { annoViewId, dependentsOf, cropBox } from '../src/core/view';
import { buildViewDL } from '../src/views/viewBuilder';
import { splitView, addDependentView, addKeyPlan, matchSides, planModelBox } from '../src/modules/output/largeSheets';
import { isEditableIn } from '../src/tools/selectTool';
import { tagsOf } from '../src/modules/annotation/tags';
import { sheetRefOf } from '../src/elements/datums';

const doc = api.createProject();
const lv = doc.all<any>('level').sort((a, b) => a.elev - b.elev)[0];
const L = 70000, D = 14000;
const P = (x: number, y: number) => ({ x, y });
const ring = [P(0, 0), P(L, 0), P(L, D), P(0, D)];
for (let i = 0; i < 4; i++) api.addWall({ a: ring[i], b: ring[(i + 1) % 4], levelId: lv.id });
for (let x = 7000; x < L; x += 7000) api.addWall({ a: P(x, 0), b: P(x, D), levelId: lv.id });
api.addFloor({ loops: [ring], levelId: lv.id });
const plan = doc.all<View>('view').find((v) => v.kind === 'plan' && v.levelId === lv.id)!;
const mb = planModelBox(doc, plan);
assert.ok(mb.max.x - mb.min.x > L && mb.max.x - mb.min.x < L + 1000, 'Modellausdehnung ohne Ansichtssymbole');
// Beschriftungen der Primäransicht: Text im ersten Teil, Text ganz rechts
const t1 = api.add<any>({ cat: 'text', viewId: plan.id, p: P(4000, 9000), s: 'Text-im-Teil-1' });
api.add<any>({ cat: 'text', viewId: plan.id, p: P(66000, 9000), s: 'Text-im-Teil-3' });

// ------------------------------------------------------------ Teilen
const parts = splitView(doc, plan.id, { n: 3, overlap: 2000 });
assert.equal(parts.length, 3);
assert.equal(doc.undoName(), 'Ansicht teilen', 'ein Rückgängig-Schritt');
const crops = parts.map((p) => cropBox(doc.get<View>(p.id)!)!);
for (let i = 0; i < 3; i++) {
  const v = doc.get<View>(parts[i].id)!;
  assert.equal(v.parentId, plan.id); assert.equal(v.hostId, plan.id); assert.equal(v.levelId, plan.levelId); assert.ok(v.crop?.on);
  if (i) assert.ok(Math.abs(crops[i - 1].max.x - crops[i].min.x - 2000) < 1e-6, 'Überlappung 2 m');
  assert.ok(Math.abs((crops[i].max.x - crops[i].min.x) - (crops[0].max.x - crops[0].min.x)) < 1e-6, 'gleich breit');
}
assert.ok(crops[0].min.x <= mb.min.x && crops[2].max.x >= mb.max.x, 'ganzes Gebäude abgedeckt');
const mls = doc.all<any>('matchline');
assert.equal(mls.length, 2);
assert.ok(mls.every((m) => m.viewId === plan.id), 'Anschlusslinien gehören zur Primäransicht');
assert.equal(matchSides(doc, mls[0]).left?.id, parts[0].id); assert.equal(matchSides(doc, mls[0]).right?.id, parts[1].id);
// automatische Zuordnung (ohne views) ergibt dasselbe
assert.equal(matchSides(doc, { ...mls[1], views: undefined }).left?.id, parts[1].id);
assert.equal(matchSides(doc, { ...mls[1], views: undefined }).right?.id, parts[2].id);

// ------------------------------------------------------------ Abgleich der Eigenschaften
api.transaction('Massstab', () => doc.update<View>(plan.id, { scale: 50, detail: 'fine' }));
for (const p of parts) { const v = doc.get<View>(p.id)!; assert.equal(v.scale, 50); assert.equal(v.detail, 'fine'); }
doc.undo();
for (const p of [plan, ...parts]) { const v = doc.get<View>(p.id)!; assert.equal(v.scale, 100); assert.equal(v.detail, 'medium'); }
doc.redo(); doc.undo();
// Änderung an einer abhängigen Ansicht geht an die Primäransicht und die anderen Teile; Zuschnitt bleibt eigen
const c1 = JSON.stringify(doc.get<View>(parts[1].id)!.crop);
api.transaction('Sichtbarkeit', () => doc.update<View>(parts[1].id, { hiddenCats: ['room'], data: { ...(doc.get<View>(parts[1].id)!.data ?? {}), rebarFilter: { plan: 'T-1' } } }));
for (const p of [plan, ...parts]) {
  const v = doc.get<View>(p.id)!;
  assert.deepEqual(v.hiddenCats, ['room']); assert.equal(v.data?.rebarFilter?.plan, 'T-1');
}
assert.equal(doc.get<View>(parts[0].id)!.data?.marker, '1', 'Symbolbeschriftung bleibt eigen');
assert.equal(doc.get<View>(parts[2].id)!.data?.marker, '3');
api.transaction('Zuschnitt', () => doc.update<View>(parts[0].id, { crop: { ...doc.get<View>(parts[0].id)!.crop!, show: true } }));
assert.equal(JSON.stringify(doc.get<View>(parts[1].id)!.crop), c1, 'Zuschnitt eigen');
assert.ok(!doc.get<View>(plan.id)!.crop?.show);
doc.undo(); doc.undo();
assert.equal(doc.get<View>(parts[2].id)!.hiddenCats, undefined, 'Rückgängig stellt alle Teile wieder her');

// ------------------------------------------------------------ Beschriftungen der Primäransicht in den Teilen
assert.equal(annoViewId(doc, doc.get<View>(parts[1].id)), plan.id);
assert.ok(isEditableIn(t1, doc.get<View>(parts[0].id)!), 'Text der Primäransicht im Teilplan bearbeitbar');
const texts = (v: View) => buildViewDL(doc, doc.get<View>(v.id)!).items.filter((p: any) => p.k === 'text').map((p: any) => p.s as string);
const d0 = texts(parts[0]), d2 = texts(parts[2]);
assert.ok(d0.includes('Text-im-Teil-1') && !d0.includes('Text-im-Teil-3'), 'Beschriftungszuschnitt Teil 1');
assert.ok(d2.includes('Text-im-Teil-3') && !d2.includes('Text-im-Teil-1'), 'Beschriftungszuschnitt Teil 3');
const dl0 = buildViewDL(doc, doc.get<View>(parts[0].id)!);
const clips = dl0.items.filter((p: any) => p.k === 'clip' && p.rings);
assert.ok(clips.length >= 2, 'Modell und Beschriftungen zugeschnitten');
const last = clips[clips.length - 1] as any;
assert.ok(Math.abs(last.rings[0][1].x - crops[0].max.x) < 1e-6, 'Beschriftung am Zuschnitt beschnitten');
// Beschriftung aus einem Teilplan gehört der Primäransicht (keine doppelten Beschriftungen)
const tag = api.add<any>({ cat: 'tag', viewId: annoViewId(doc, doc.get<View>(parts[0].id)), refId: doc.all('wall')[0].id, off: P(0, 0) });
assert.equal(tag.viewId, plan.id);
assert.equal(tagsOf(doc, tag.refId, parts[0].id).length, 1); assert.equal(tagsOf(doc, tag.refId, plan.id).length, 1);

// ------------------------------------------------------------ Pläne, Anschlusslinien, Schlüsselplan
const sheets = [1, 2, 3].map((i) => api.addSheet({ no: `A-102.${i}`, name: `Grundriss EG Teil ${i}`, size: 'A0' }));
api.placeView(sheets[0].id, parts[0].id, P(520, 450));
const svg1a = api.exportSvg(sheets[0].id);
assert.ok(/ANSCHLUSS GRUNDRISS|ANSCHLUSS .*TEIL 2/i.test(svg1a), 'vor dem Platzieren: Ansichtsname des Nachbarteils');
api.placeView(sheets[1].id, parts[1].id, P(520, 450));
api.placeView(sheets[2].id, parts[2].id, P(520, 450));
const svg1 = api.exportSvg(sheets[0].id), svg2 = api.exportSvg(sheets[1].id), svg3 = api.exportSvg(sheets[2].id);
assert.ok(svg1.includes('ANSCHLUSS PLAN A-102.2') && !svg1.includes('ANSCHLUSS PLAN A-102.3'), 'Teil 1 → A-102.2 (Zwischenspeicher erneuert)');
assert.ok(svg2.includes('ANSCHLUSS PLAN A-102.1') && svg2.includes('ANSCHLUSS PLAN A-102.3'), 'Teil 2 → A-102.1 und A-102.3');
assert.ok(svg3.includes('ANSCHLUSS PLAN A-102.2') && !svg3.includes('ANSCHLUSS PLAN A-102.1'), 'Teil 3 → A-102.2');
assert.equal(sheetRefOf(doc, plan)?.sheet, 'A-102.1', 'Verweis auf nicht platzierte Primäransicht: erster Teilplan');
// Übersicht: Rahmen der Teilpläne mit Plannummern in der Primäransicht
api.transaction('Übersicht', () => doc.update<View>(plan.id, { depFrames: true }));
assert.equal(doc.get<View>(parts[0].id)!.depFrames, undefined, 'Übersichtsrahmen eigen');
const ov = buildViewDL(doc, doc.get<View>(plan.id)!);
assert.equal(ov.items.filter((p: any) => p.sub === 'depFrame').length, 3);
const ovt = ov.items.filter((p: any) => p.k === 'text').map((p: any) => p.s);
assert.ok(['A-102.1', 'A-102.2', 'A-102.3'].every((s) => ovt.includes(s)));
assert.ok(ovt.includes('PLAN A-102.1') && ovt.includes('PLAN A-102.2'), 'Anschlusslinie in der Übersicht: Plannummern beider Seiten');
// Schlüsselplan auf Plan 2: Gebäudeumriss, drei Teile, Teil 2 schraffiert
const kp = addKeyPlan(doc, sheets[1].id);
assert.equal(kp.refId, plan.id);
const sdl = buildViewDL(doc, doc.get<View>(sheets[1].id)!);
const kpItems = sdl.items.filter((p: any) => p.o === kp.id);
assert.equal(kpItems.filter((p: any) => p.sub === 'keyPart').length, 1, 'ein Teil schraffiert');
const hatch = kpItems.find((p: any) => p.sub === 'keyPart') as any;
const hx = hatch.rings[0].map((q: any) => q.x);
const kx = (x: number) => kp.p.x + (x - crops[0].min.x) * (kp.size / (crops[2].max.x - crops[0].min.x));
assert.ok(Math.abs(Math.min(...hx) - kx(crops[1].min.x)) < 0.5 && Math.abs(Math.max(...hx) - kx(crops[1].max.x)) < 0.5, 'Schraffur = Teil 2');
assert.ok(kpItems.some((p: any) => p.k === 'poly' && p.closed && p.pts.length === 4 && p.pen.w === 3), 'Gebäudeumriss');
const kpt = kpItems.filter((p: any) => p.k === 'text').map((p: any) => p.s);
assert.ok(kpt.includes('Schlüsselplan') && kpt.includes('A-102.1') && kpt.includes('A-102.3'));
assert.ok(kp.p.x + kp.size < 1189 - 5 && kp.p.y > 62, 'Lage über dem Plankopf');
if (process.env.ORISS_SVG) writeFileSync(process.env.ORISS_SVG, api.exportSvg(sheets[1].id));

// ------------------------------------------------------------ Abhängige Ansicht duplizieren, Kopie unabhängig
const extra = addDependentView(doc, parts[1].id, { name: 'EG Detailbereich' });
assert.equal(extra.parentId, plan.id, 'abhängige Ansicht einer abhängigen → Primäransicht');
assert.equal(dependentsOf(doc, plan.id).length, 4);

// ------------------------------------------------------------ Löschen der Primäransicht entfernt alles Abhängige
api.transaction('Löschen', () => doc.remove(plan.id));
assert.equal(doc.all<View>('view').filter((v) => v.parentId === plan.id).length, 0, 'abhängige Ansichten gelöscht');
assert.equal(doc.all('matchline').length, 0);
assert.equal(doc.all('keyplan').length, 0);
assert.equal(doc.all<any>('viewport').filter((vp) => parts.some((p) => p.id === vp.refId)).length, 0, 'Ansichtsfenster der Teile gelöscht');
doc.undo();
assert.equal(dependentsOf(doc, plan.id).length, 4, 'Rückgängig stellt die Teile wieder her');
