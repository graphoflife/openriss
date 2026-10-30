// Beispielprojekt "Einfamilienhaus": zeigt Wände, Öffnungen, Decken, Dach, Treppe, Räume, Möbel,
// Bemaßung, Beschriftung, Unterzug mit Bewehrung, Schnitte, Pläne und eine Türliste.
import { app } from '../../app';
import { newId, El, Id } from '../../core/doc';
import { registerCommand, emitHook } from '../../core/registry';
import { newProject } from '../../core/template';
import { View, levels } from '../../core/view';
import { V2 } from '../../core/geom';
import { sectionGeomPatch } from '../../elements/datums';
import { createRebarTag } from '../structure/rebar/tag';
import { defaultDef } from '../output/schedules';
import { viewExtent } from '../output/viewports';
import { applyUnits, toast } from '../../ui/dialogs';

const P = (x: number, y: number): V2 => ({ x, y });

function buildSample(): void {
  const doc = app.doc;
  for (const id of [...app.viewports.keys()]) app.closeView(id);
  app.select([]);
  newProject(doc);
  emitHook('loaded', doc);
  const plan = (lvl: Id) => doc.all<View>('view').find((v) => v.kind === 'plan' && v.levelId === lvl)!;
  const eg = 'lvl_eg', og = 'lvl_og';
  let planEG!: View, planOG!: View;

  doc.transaction('Beispielprojekt', () => {
    doc.update('project', { name: 'Einfamilienhaus Musterstraße', number: '2026-014', client: 'Familie Muster', address: 'Musterstraße 1, 12345 Musterstadt', author: 'OpenRiss' });
    planEG = plan(eg); planOG = plan(og);
    // Zuschnitt der Grundrisse (ohne Ansichtssymbole)
    for (const v of [planEG, planOG]) doc.update(v.id, { crop: { on: true, show: false, min: P(-4000, -4500), max: P(16000, 12500) } });

    // Raster
    const grid = (name: string, a: V2, b: V2) => doc.add({ id: 'gr_' + name, cat: 'grid', name, a, b } as El);
    grid('1', P(0, -3200), P(0, 11800)); grid('2', P(5000, -3200), P(5000, 11800)); grid('3', P(12000, -3200), P(12000, 11800));
    grid('A', P(-3200, 0), P(15200, 0)); grid('B', P(-3200, 9000), P(15200, 9000));

    // Wände (Außenwände im Uhrzeigersinn → Außenseite links)
    const wall = (id: string, a: V2, b: V2, typeId: string, lvl: Id, extra: Partial<El> = {}) =>
      doc.add({ id, cat: 'wall', typeId, a, b, levelId: lvl, baseOffset: 0, topLevelId: lvl === eg ? og : null, topOffset: 0, height: 2600, locLine: 'center', flip: false, ...extra } as El);
    for (const [lvl, s] of [[eg, ''], [og, 'o']] as [Id, string][]) {
      wall('eW' + s, P(0, 0), P(0, 9000), 'wt_awwdvs', lvl);
      wall('eN' + s, P(0, 9000), P(12000, 9000), 'wt_awwdvs', lvl);
      wall('eE' + s, P(12000, 9000), P(12000, 0), 'wt_awwdvs', lvl);
      wall('eS' + s, P(12000, 0), P(0, 0), 'wt_awwdvs', lvl);
      wall('i1' + s, P(5000, 0), P(5000, 9000), 'wt_iw175', lvl);
      wall('i2' + s, P(5000, 4000), P(12000, 4000), 'wt_iw115', lvl);
    }
    wall('i3', P(9000, 0), P(9000, 4000), 'wt_iw115', eg);
    wall('i3o', P(9000, 4000), P(9000, 9000), 'wt_iw115', og);
    wall('i4o', P(0, 5500), P(5000, 5500), 'wt_iw115', og);

    // Türen und Fenster
    let mark = 0;
    const op = (cat: 'door' | 'window', host: string, t: number, typeId: string, extra: Partial<El> = {}) => {
      const w = doc.get(host)!; const ty = doc.get<any>(typeId);
      return doc.add({ id: newId(cat.slice(0, 2)), cat, typeId, hostId: host, levelId: w.levelId, t, sill: cat === 'window' ? ty?.sill ?? 900 : 0, mark: cat === 'door' ? String(++mark) : undefined, ...extra } as El);
    };
    const openings: El[] = [
      op('door', 'eS', 5000, 'dt_1010', { flipFacing: false }), op('door', 'i1', 2000, 'dt_885'), op('door', 'i2', 2000, 'dt_885'), op('door', 'i3', 2500, 'dt_885'),
      op('window', 'eS', 10500, 'ft_2010'), op('window', 'eS', 8200, 'ft_tuer'), op('window', 'eS', 1500, 'ft_1260'),
      op('window', 'eW', 6800, 'ft_1260'), op('window', 'eN', 2500, 'ft_2010'), op('window', 'eN', 8500, 'ft_1260'),
      op('window', 'eE', 2500, 'ft_1010'), op('window', 'eE', 7000, 'ft_1010'),
      op('door', 'i4o', 3000, 'dt_885'), op('door', 'i1o', 2000, 'dt_885'), op('door', 'i1o', 4800, 'dt_885'), op('door', 'i3o', 2000, 'dt_760'),
      op('window', 'eSo', 3500, 'ft_885'), op('window', 'eSo', 9500, 'ft_1260'), op('window', 'eNo', 2500, 'ft_2010'),
      op('window', 'eNo', 7000, 'ft_1260'), op('window', 'eNo', 10500, 'ft_1260'), op('window', 'eEo', 2500, 'ft_1010'),
    ];

    // Decken
    doc.add({ id: 'fl_eg', cat: 'floor', typeId: 'flt_bodenplatte_aufbau', levelId: eg, offset: 0, loops: [[P(-10, -10), P(-10, 9010), P(12010, 9010), P(12010, -10)]] } as El);
    doc.add({ id: 'fl_og', cat: 'floor', typeId: 'flt_aufbau', levelId: og, offset: 0, loops: [[P(-10, -10), P(-10, 9010), P(12010, 9010), P(12010, -10)], [P(180, 350), P(1300, 350), P(1300, 5150), P(180, 5150)]] } as El);

    // Satteldach (Traufen Nord/Süd, Giebel West/Ost) und Giebelwände oben fixieren
    doc.add({ id: 'roof1', cat: 'roof', typeId: 'rft_ziegel', levelId: og, baseOffset: 2600,
      loops: [[P(-680, -680), P(-680, 9680), P(12680, 9680), P(12680, -680)]],
      edges: [[{ slope: false, angle: 35 }, { slope: true, angle: 35 }, { slope: false, angle: 35 }, { slope: true, angle: 35 }]] } as El);
    for (const id of ['eWo', 'eEo']) doc.update(id, { attachTopId: 'roof1' });

    // Treppe mit Geländer
    doc.add({ id: 'st1', cat: 'stair', typeId: 'stt_stb', levelId: eg, baseOffset: 0, topLevelId: og, topOffset: 0, height: 3000, shape: 'straight', turn: 1,
      width: 1000, maxRiser: 180, tread: 280, landing: 0, gap: 100, risers: 0, split: 0, p0: P(680, 450), dir: P(0, 1) } as El);
    doc.add({ id: 'rl1', cat: 'railing', typeId: 'rlt_1000', levelId: eg, baseOffset: 0, path: [], hostId: 'st1', side: -1 } as El);

    // Unterzug unter der OG-Wand
    const bt = doc.all<any>('type').find((t) => t.of === 'beam' && /30\/50/.test(t.name));
    if (bt) doc.add({ id: 'bm1', cat: 'beam', typeId: bt.id, a: P(0, 5500), b: P(5000, 5500), levelId: og, offA: 0, offB: 0, zJust: 'top', yOff: 0 } as El);

    // Räume
    const room = (name: string, number: string, lvl: Id, pt: V2) =>
      doc.add({ id: newId('rm'), cat: 'room', name, number, levelId: lvl, pt, baseOffset: 0, topLevelId: lvl === eg ? og : null, topOffset: lvl === eg ? 0 : 2600 } as El);
    const rooms = [
      room('Wohnen / Essen', '0.01', eg, P(3000, 6500)), room('Küche', '0.02', eg, P(8500, 6500)), room('Flur', '0.03', eg, P(7000, 1500)), room('Arbeiten', '0.04', eg, P(10500, 2000)),
      room('Flur', '1.01', og, P(3000, 3000)), room('Schlafen', '1.02', og, P(2500, 7300)), room('Bad', '1.03', og, P(8500, 2000)), room('Kind 1', '1.04', og, P(7000, 6500)), room('Kind 2', '1.05', og, P(10500, 6500)),
    ];

    // Möbel
    const comp = (typeId: string, lvl: Id, p: V2, rot = 0) => { if (doc.get(typeId)) doc.add({ id: newId('cp'), cat: 'component', typeId, levelId: lvl, offset: 0, rot, p } as El); };
    comp('cpt_tisch160', eg, P(3000, 7200)); comp('cpt_sofa', eg, P(3200, 2200)); comp('cpt_kueche', eg, P(7400, 8520), Math.PI);
    comp('cpt_tisch160', eg, P(10500, 2200)); comp('cpt_bett180', og, P(2500, 7600)); comp('cpt_bett90', og, P(6200, 7800)); comp('cpt_bett90', og, P(11000, 7800));
    comp('cpt_badewanne', og, P(10900, 800)); comp('cpt_wc', og, P(6000, 450)); comp('cpt_waschtisch', og, P(7200, 450));

    // Beschriftung bei Platzierung (Türen, Fenster, Räume)
    for (const el of [...openings, ...rooms]) emitHook('tagOnPlace', el, el.levelId === eg ? planEG : planOG);

    // Bemaßung (assoziativ an Rastern und Wandaußenflächen)
    const dim = (viewId: Id, refs: any[], dir: V2, line: V2) => doc.add({ id: newId('dm'), cat: 'dimension', viewId, typeId: 'dimt_s25', kind: 'linear', aligned: true, refs, dir, line } as El);
    const gref = (id: string) => { const g = doc.get<any>(id)!; return { id, sub: 'line', a: g.a, b: g.b }; };
    for (const v of [planEG, planOG]) {
      dim(v.id, [gref('gr_1'), gref('gr_2'), gref('gr_3')], P(-1, 0), P(6000, -2000));
      dim(v.id, [{ id: v === planEG ? 'eW' : 'eWo', sub: 'face', side: 1, a: P(-180, 0), b: P(-180, 9000) }, { id: v === planEG ? 'eE' : 'eEo', sub: 'face', side: 1, a: P(12180, 9000), b: P(12180, 0) }], P(-1, 0), P(6000, -2800));
      dim(v.id, [gref('gr_A'), gref('gr_B')], P(0, 1), P(-2000, 4500));
    }

    // Schnitt durch Haus und Treppe, Detailschnitt Unterzug
    const ls = levels(doc);
    const mkSection = (id: string, name: string, marker: string, A: V2, B: V2, scale: number, cropY: [number, number], far: number, detail: View['detail'], cropX?: [number, number]) => {
      const v: any = { id, cat: 'view', kind: 'section', name, scale, detail, far, data: { marker }, crop: { on: true, show: true, min: P(cropX?.[0] ?? 0, cropY[0]), max: P(cropX?.[1] ?? 0, cropY[1]) } };
      Object.assign(v, sectionGeomPatch(A, B, v));
      if (cropX) v.crop = { ...v.crop, min: P(cropX[0], cropY[0]), max: P(cropX[1], cropY[1]) };
      return doc.add(v as View);
    };
    mkSection('sec_a', 'Schnitt A-A', 'A', P(2500, -2500), P(2500, 11500), 100, [(ls[0]?.elev ?? 0) - 1200, 9500], 3000, 'medium');
    mkSection('sec_b', 'Schnitt B-B', 'B', P(-2500, 2000), P(14500, 2000), 100, [-1200, 9500], 12000, 'coarse');
    const det = mkSection('sec_det', 'Detail Unterzug', 'D1', P(2500, 5000), P(2500, 6000), 20, [2250, 3250], 1500, 'fine');

    // Bewehrung im Unterzug: Bügel Ø10/15, unten 3 Ø16, oben 2 Ø12
    if (bt) {
      const r1 = doc.add({ id: 'rb1', cat: 'rebar', hostId: 'bm1', pos: 1, dia: 10, shape: '51', layout: 'maxSpacing', count: 4, spacing: 150, display: 'first', coverUsed: 30,
        pts: [{ x: 4965, y: 5385, z: 2535 }, { x: 4965, y: 5615, z: 2535 }, { x: 4965, y: 5615, z: 2965 }, { x: 4965, y: 5385, z: 2965 }, { x: 4965, y: 5385, z: 2535 }],
        dir: { x: -1, y: 0, z: 0 }, span: 4930, hookA: 135, hookB: 135, hookNA: { x: 0, y: 0, z: 1 }, hookNB: { x: 0, y: 1, z: 0 } } as El);
      const r2 = doc.add({ id: 'rb2', cat: 'rebar', hostId: 'bm1', pos: 2, dia: 16, shape: '00', layout: 'count', count: 3, spacing: 100, display: 'first', coverUsed: 30,
        pts: [{ x: 4970, y: 5398, z: 2548 }, { x: 30, y: 5398, z: 2548 }], dir: { x: 0, y: 1, z: 0 }, span: 204, hookA: 0, hookB: 0 } as El);
      const r3 = doc.add({ id: 'rb3', cat: 'rebar', hostId: 'bm1', pos: 3, dia: 12, shape: '00', layout: 'count', count: 2, spacing: 100, display: 'first', coverUsed: 30,
        pts: [{ x: 4970, y: 5604, z: 2954 }, { x: 30, y: 5604, z: 2954 }], dir: { x: 0, y: -1, z: 0 }, span: 208, hookA: 0, hookB: 0 } as El);
      const s = det.scale;
      const offs: V2[] = [P(14 * s, 14 * s), P(14 * s, -8 * s), P(14 * s, 4 * s)];
      [r1, r2, r3].forEach((r, i) => { try { createRebarTag(doc, r, det, offs[i], 'std', true); } catch (e) { console.warn(e); } });
    }

    // Türliste
    const sched = doc.add({ id: 'sch_door', cat: 'view', kind: 'schedule', name: 'Türliste', scale: 1, detail: 'medium', data: defaultDef(doc, 'door') } as View);

    // Pläne mit Ansichtsfenstern
    const sheet = (id: string, no: string, name: string) => doc.add({ id, cat: 'view', kind: 'sheet', name, sheetNo: no, scale: 1, detail: 'medium',
      data: { size: 'A3', portrait: false, drawnBy: 'OpenRiss', checkedBy: '', date: new Date().toLocaleDateString('de-DE'), index: '' } } as View);
    const s1 = sheet('sh_101', 'A-101', 'Grundriss Erdgeschoss'); const s2 = sheet('sh_102', 'A-102', 'Grundriss Obergeschoss');
    const s3 = sheet('sh_201', 'A-201', 'Schnitt und Details');
    const place = (sh: View, v: View, center: V2, detail: string) => {
      const b = viewExtent(doc, v);
      doc.add({ id: newId('vp'), cat: 'viewport', viewId: sh.id, refId: v.id, center, detail,
        anchor: v.kind === 'schedule' ? P(b.min.x, b.max.y) : P((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2) } as El);
    };
    place(s1, doc.get<View>(planEG.id)!, P(170, 165), '1');
    place(s2, doc.get<View>(planOG.id)!, P(170, 165), '1');
    place(s3, doc.get<View>('sec_a')!, P(120, 165), '1');
    place(s3, doc.get<View>('sec_det')!, P(300, 205), '2');
    place(s1, sched, P(300, 270), '2');
  });
  doc.clearHistory();
  applyUnits();
  app.openView(planEG.id);
  app.emit('views');
  toast('Beispielprojekt geladen. Pläne, Schnitte, Türliste und 3D-Ansicht finden Sie im Projektbrowser.', 4500);
}

registerCommand({
  id: 'loadSample', label: 'Beispielprojekt', icon: 'plan', tip: 'Einfamilienhaus mit Plänen, Schnitten, Bewehrung und Türliste laden',
  run: () => {
    if (app.doc.dirty && !confirm('Das aktuelle Projekt wird ersetzt. Ungespeicherte Änderungen gehen verloren. Fortfahren?')) return;
    buildSample();
  },
});
