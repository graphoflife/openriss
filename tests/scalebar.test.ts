// N9: grafische Massstabsleiste – Länge automatisch nach Massstab, Felder, Beschriftung, auf dem Plan massstäblich.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import { niceLength, scalebarLength } from '../src/modules/annotation/details';
import { buildViewDL } from '../src/views/viewBuilder';

assert.equal(niceLength(5000), 5000); assert.equal(niceLength(4999), 2000); assert.equal(niceLength(12000), 10000);
const doc = api.createProject();
const plan = doc.all<any>('view').find((v) => v.kind === 'plan')!;
api.transaction('Massstab', () => doc.update(plan.id, { scale: 100 }));
const sb = api.add<any>({ cat: 'symbol', viewId: plan.id, kind: 'scalebar', p: { x: 0, y: -5000 } });
assert.equal(scalebarLength(sb, 100), 5000, '1:100 → 5 m (50 mm Papier)');
const items = buildViewDL(doc, doc.get(plan.id)!).items.filter((it: any) => it.o === sb.id);
const fills = items.filter((it: any) => it.k === 'fill');
assert.equal(fills.length, 5 - 1 + 4, '5 Felder, erstes in 2 × 2 unterteilt');
const texts = items.filter((it: any) => it.k === 'text').map((it: any) => it.s);
assert.deepEqual(texts.slice(0, 6), ['0', '1', '2', '3', '4', '5 m']);
const xs = fills.flatMap((f: any) => f.rings[0].map((p: any) => p.x));
assert.equal(Math.max(...xs) - Math.min(...xs), 5000, 'Länge in Modell-mm');

// Massstabsleiste im Ansichtstitel auf dem Plan: Papierlänge = Modelllänge / Massstab
{
  const sh = api.add<any>({ cat: 'view', kind: 'sheet', name: 'Test', sheetNo: 'T-1', scale: 1, detail: 'fine', data: { size: 'A3' } });
  const vp = api.placeView(sh.id, plan.id, { x: 200, y: 150 }, undefined, { scaleBar: true });
  const its = buildViewDL(doc, doc.get(sh.id)!).items.filter((it: any) => it.o === vp.id && it.k === 'text');
  const t1 = its.find((t: any) => t.s === '2 m'); const t0 = its.filter((t: any) => t.s === '0').pop();
  assert.ok(t0 && t1, 'Beschriftung der Leiste im Titel (0 … 2 m)');
  assert.ok(Math.abs(t1.p.x - t0.p.x - 2000 / 100) < 1e-6, 'Länge in Papier-mm = 2 m / 100');
}
