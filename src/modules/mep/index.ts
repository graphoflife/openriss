// Modul: mep – Gebäudetechnik (HLKSE): Systemtypen, Rohre/Kanäle/Leerrohre mit Bögen und Gefälle,
// Steigleitungen, Fussbodenheizkreise, Apparate und Plansymbole, Prinzipschemata (Zeichnungsansicht),
// Durchbrüche/Einlagen ans Tragwerk, Leitungslisten, HLKSE-Grundrisse. Register «Gebäudetechnik».
import './icons';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCommand, registerPanel, registerContextPanel } from '../../core/registry';
import { View, Level, levels, isPlanLike, DEFAULT_RANGE } from '../../core/view';
import { app } from '../../app';
import { startTool, registerSimilar } from '../../ui/commands';
import { modal, promptDialog } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { fmtNum } from '../../core/units';
import { buildViewDL } from '../../views/viewBuilder';
import { makeTag, tagsOf } from '../annotation/tags';
import { Disc, DISC_LABEL, ensureMepTemplate } from './common';
import { RunTool, RiserTool, RUN_CATS, MepRun, applySlope, runInfo, RunCat } from './runs';
import { FixtureTool, FixSym } from './fixtures';
import { startFbhSketch, FbhRoomTool, numberCircuits } from './fbh';
export { numberCircuits, fbhFlow, fbhTagText } from './fbh';
export { addEarthing, earthPathsForSlab } from './earthing';
import './earthing';
import { SchemaSymbolTool, SchemaLineTool, createSchemaView, autoHeatingSchema } from './schema';
import { findPenetrations, applyPenetrations, penSizeText, PEN_KIND_LABEL, PenOpts } from './penetrations';

// ------------------------------------------------------------ Befehle: Leitungen
const runCmd = (id: string, label: string, cat: RunCat, icon: string, tip: string, preset: Partial<MepRun>, keys: string[] = []) =>
  registerCommand({ id, label, icon, keys, tip, run: () => { ensureMepTemplate(app.doc); startTool(new PresetRunTool(cat, id, label.replace(/- /g, ''), preset), id); } });

/** Leitungswerkzeug mit Voreinstellung (System, Typ, Grösse, Gefälle) */
class PresetRunTool extends RunTool {
  constructor(cat: RunCat, id: string, label: string, private preset: Partial<MepRun>) { super(cat, id, label); }
  activate(): void {
    super.activate();
    const p = this.placement!.proto;
    const t = this.preset.typeId && app.doc.get(this.preset.typeId);
    if (t) this.placement!.setType(t.id);
    Object.assign(p, this.preset);
    if (!('slope' in this.preset)) delete p.slope;
    if (this.preset.typeId) this.placement!.typeId = this.preset.typeId;
  }
}

runCmd('mepPipeH', 'Heizungs- leitung', 'pipe', 'mepPipeH', 'Heizungsrohr zeichnen (Vorlauf/Rücklauf). Kette mit Längeneingabe; Bögen entstehen an den Knicken.', { system: 'sys_hvl', typeId: 'mpt_stahl', dia: 28, offset: 2400 }, ['HL']);
runCmd('mepPipeS', 'Wasser- leitung', 'pipe', 'mepPipeS', 'Sanitärleitung (Kalt-/Warmwasser, Zirkulation) zeichnen.', { system: 'sys_kw', typeId: 'mpt_mvr', dia: 20, offset: 2450 }, ['PI']);
runCmd('mepDrain', 'Abwasser- leitung', 'pipe', 'mepDrain', 'Abwasserleitung mit Gefälle: Höhe des Anfangs eingeben, die Höhe läuft entlang der Kette mit (Gefällepfeil mit %).', { system: 'sys_sw', typeId: 'mpt_pe', dia: 110, slope: 2, offset: 2400 }, ['AW']);
runCmd('mepDuct', 'Lüftungs- kanal', 'duct', 'mepDuct', 'Lüftungskanal rund oder rechteckig zeichnen (Zu-/Ab-/Aussen-/Fortluft).', { system: 'sys_zul', typeId: 'mdt_wfr', shape: 'round', dia: 125, offset: 2500 }, ['DT']);
runCmd('mepConduit', 'Leerrohr', 'conduit', 'mepConduit', 'Elektro-Leerrohr (M20/M25 …) zeichnen, z. B. in der Decke.', { system: 'sys_lr', typeId: 'mct_krf', shape: 'round', dia: 25, offset: 2550 }, ['LR']);
runCmd('mepEarth', 'Fundament- erder', 'conduit', 'mepEarth', 'Fundament-/Ringerder bzw. Potentialausgleichsleiter (V4A Ø10) zeichnen, z. B. in der Bodenplatte.', { system: 'sys_erd', typeId: 'mct_erder', shape: 'round', dia: 10, offset: -150 });
runCmd('mepTray', 'Kabel- trasse', 'conduit', 'mepTray', 'Kabeltrasse (rechteckig) zeichnen.', { system: 'sys_kt', typeId: 'mct_trasse', shape: 'rect', w: 200, h: 60, offset: 2600 });
registerCommand({ id: 'mepRiser', label: 'Steig- leitung', icon: 'mepRiser', tip: 'Senkrechte Leitung (Steig-/Fallstrang) mit Höhe unten/oben platzieren.', run: () => { ensureMepTemplate(app.doc); startTool(new RiserTool(), 'mepRiser'); } });

// ------------------------------------------------------------ Befehle: Apparate und Symbole
const fixCmd = (id: string, label: string, icon: string, syms: FixSym[], tip: string, keys: string[] = []) =>
  registerCommand({ id, label, icon, keys, tip, run: () => { ensureMepTemplate(app.doc); startTool(new FixtureTool(id, label.replace(/- /g, ''), syms), id); } });
fixCmd('mepSocket', 'Steckdose', 'mepSocket', ['socket', 'data'], 'Steckdose / Multimedia-Dose an eine Wand setzen.', ['SD']);
fixCmd('mepSwitch', 'Schalter', 'mepSwitch', ['switch'], 'Schalter an eine Wand setzen.');
fixCmd('mepLight', 'Leuchte', 'mepLight', ['lightC', 'lightW', 'smoke'], 'Decken- oder Wandleuchte (auch Rauchmelder) platzieren.', ['LU']);
fixCmd('mepBoard', 'Verteiler Elektro', 'mepBoard', ['boardE'], 'Elektro-Verteiler (HV/UV) an eine Wand setzen.');
fixCmd('mepManifold', 'FBH- Verteiler', 'mepManifold', ['manifold'], 'Heizkreisverteiler an eine Wand setzen; Heizkreise werden automatisch angebunden.');
fixCmd('mepRadiator', 'Heiz- körper', 'mepRadiator', ['radiator'], 'Heizkörper an eine Wand setzen.');
fixCmd('mepHeatPump', 'Wärme- pumpe', 'mepHeatPump', ['heatPump'], 'Wärmepumpe (Aussen-/Innengerät) platzieren.');
fixCmd('mepVent', 'Lüftungs- ventil', 'mepVent', ['ventSup', 'ventExh'], 'Zu-/Abluftventil mit Volumenstrom platzieren.', ['VE']);
fixCmd('mepAhu', 'Lüftungs- gerät', 'mepAhu', ['ahu'], 'Lüftungsgerät (KWL mit WRG) platzieren.');
fixCmd('mepFloorDrain', 'Boden- ablauf', 'mepFloorDrain', ['floorDrain'], 'Bodenablauf platzieren.');
fixCmd('mepSanitary', 'Sanitär- apparat', 'mepSanitary', ['shower', 'bathtub', 'sinkK', 'washer', 'liftStation'], 'Dusche, Badewanne, Spültisch/Ausguss, Waschmaschine/Tumbler, Hebeanlage platzieren.');
fixCmd('mepConn', 'Anschluss- punkt', 'mepConn', ['conWC', 'conLA'], 'Anschlusspunkt WC / Lavabo (KW/WW/SW) an eine Wand setzen.');
fixCmd('mepTank', 'Speicher', 'mepTank', ['tank'], 'Warmwasserspeicher / Boiler platzieren.');
fixCmd('mepFixture', 'Apparat / Symbol', 'mepFixture', [], 'Beliebiges HLKSE-Element (alle Typen) platzieren.', ['ME']);

// ------------------------------------------------------------ Befehle: Fussbodenheizung
registerCommand({ id: 'mepFbh', label: 'Heizkreis skizzieren', icon: 'mepFbh', tip: 'Fussbodenheizkreis: Fläche skizzieren → Mäander/Schnecke mit Verlegeabstand, Kreislänge, Anbindung an den nächsten Verteiler.', run: () => { ensureMepTemplate(app.doc); startFbhSketch(); } });
registerCommand({ id: 'mepFbhRoom', label: 'Heizkreis in Raum', icon: 'mepFbhRoom', tip: 'Fussbodenheizkreis durch Klick in einen umschlossenen Raum erzeugen.', run: () => { ensureMepTemplate(app.doc); startTool(new FbhRoomTool(), 'mepFbhRoom'); } });

// ------------------------------------------------------------ Befehle: Prinzipschema
registerCommand({
  id: 'mepSchema', label: 'Prinzip- schema', icon: 'mepSchema', tip: 'Neue Zeichnungsansicht für ein Prinzipschema anlegen und Schemasymbole platzieren.',
  run: () => promptDialog('Neues Prinzipschema', 'Name', 'Prinzipschema Heizung', (name) => {
    if (!name) return; ensureMepTemplate(app.doc);
    let id = ''; app.doc.transaction('Prinzipschema', () => { id = createSchemaView(app.doc, name).id; });
    app.openView(id); app.emit('views');
    startTool(new SchemaSymbolTool(), 'schemaSymbol');
  }),
});
registerCommand({ id: 'schemaSymbol', label: 'Schema- symbol', icon: 'schemaSymbol', tip: 'Schemasymbol (Pumpe, Ventil, Mischer, Wärmepumpe, Speicher, Verteiler …) in einer Zeichnungsansicht platzieren.', run: () => startTool(new SchemaSymbolTool(), 'schemaSymbol') });
registerCommand({ id: 'schemaLine', label: 'System- leitung', icon: 'schemaLine', tip: 'Systemleitung im Schema zeichnen (Farbe/Linienart des Systems, Fangen an Anschlusspunkten).', run: () => startTool(new SchemaLineTool(), 'schemaLine') });
registerCommand({
  id: 'mepSchemaAuto', label: 'Heizschema aus Modell', icon: 'mepSchemaAuto', tip: 'Prinzipschema Heizung aus Wärmepumpe, Speicher, FBH-Verteilern und Heizkreisen des Modells erzeugen.',
  run: () => {
    ensureMepTemplate(app.doc);
    let id = ''; let n = 0;
    app.doc.transaction('Heizschema erzeugen', () => { const v = createSchemaView(app.doc, 'Prinzipschema Heizung (Modell)'); id = v.id; n = autoHeatingSchema(app.doc, id); });
    app.openView(id); app.emit('views'); app.status(`${n} Schemaelemente erzeugt.`);
  },
});

// ------------------------------------------------------------ Koordination
registerCommand({ id: 'mepPenetrations', label: 'Durchbrüche ermitteln', icon: 'mepPenetrations', tip: 'Durchdringungen von Leitungen mit Wänden und Decken ermitteln und als Kernbohrungen/Aussparungen/Futterrohre bzw. Einlegerohre an das Tragwerk übergeben.', run: penetrationDialog });
registerCommand({
  id: 'mepSlope', label: 'Gefälle anwenden', icon: 'mepSlope', tip: 'Gefälle auf gewählte, verbundene Rohre anwenden: Höhen laufen vom Stranganfang stromabwärts mit.',
  enabled: () => app.selected().some((e) => e.cat === 'pipe'),
  run: () => promptDialog('Gefälle anwenden', 'Gefälle in %', '2', (v) => {
    const s = parseFloat(v.replace(',', '.')); if (!isFinite(s)) return;
    let n = 0; app.doc.transaction('Gefälle anwenden', () => { n = applySlope(app.doc, [...app.selection], s); });
    app.status(`Gefälle ${fmtNum(s, 1)} % auf ${n} Rohr(e) angewendet.`);
  }),
});
registerCommand({
  id: 'mepRunList', label: 'Leitungs- liste', icon: 'mepList', tip: 'Bauteillisten «Rohre», «Lüftungskanäle», «Leerrohre» (Länge je System und Grösse) und «Heizkreise» anlegen.',
  run: () => { let first = ''; app.doc.transaction('Leitungslisten', () => { first = createRunSchedules(app.doc)[0]?.id ?? ''; }); app.emit('views'); if (first) app.openView(first); },
});
registerCommand({
  id: 'mepViews', label: 'HLKSE- Grundrisse', icon: 'mepViews', tip: 'Je Geschoss Grundrisse Heizung / Lüftung / Sanitär / Elektro (1:50, Architektur in Halbton, nur das jeweilige Gewerk) anlegen.',
  run: () => { let n = 0; app.doc.transaction('HLKSE-Grundrisse', () => { n = createMepPlans(app.doc).length; }); app.emit('views'); app.status(`${n} HLKSE-Grundrisse angelegt.`); },
});
registerCommand({
  id: 'mepTag', label: 'Leitungen beschriften', icon: 'mepTag', tip: 'Alle Leitungen (Ø, System, Gefälle) der aktiven Ansicht beschriften; bereits beschriftete werden übersprungen.',
  enabled: () => { const v = app.activeView(); return !!v && isPlanLike(v); },
  run: () => { const v = app.activeView(); if (!v) return; let n = 0; app.doc.transaction('Leitungen beschriften', () => { n = tagRuns(app.doc, v); }); app.status(`${n} Beschriftung(en) erstellt.`); },
});

registerCommand({
  id: 'mepFbhNumber', label: 'Heizkreise nummerieren', icon: 'mepFbh', tip: 'Heizkreise je Verteiler neu nummerieren (nach Abstand zum Verteiler; mehrere Verteiler: «HK 2.03»).',
  run: () => { let n = 0; app.doc.transaction('Heizkreise nummerieren', () => { n = numberCircuits(app.doc); }); app.status(`${n} Heizkreis(e) umbenannt.`); },
});

// ------------------------------------------------------------ Multifunktionsleiste
const T = 'Gebäudetechnik';
registerPanel(T, 'Heizung', ['mepPipeH', 'mepFbh', 'mepFbhRoom', 'mepFbhNumber', 'mepManifold', 'mepRadiator', 'mepHeatPump'], 10);
registerPanel(T, 'Lüftung', ['mepDuct', 'mepVent', 'mepAhu'], 20);
registerPanel(T, 'Sanitär', ['mepPipeS', 'mepDrain', 'mepRiser', 'mepFloorDrain', 'mepConn', 'mepSanitary', 'mepTank'], 30);
registerPanel(T, 'Elektro', ['mepConduit', 'mepTray', 'earthing', 'mepSocket', 'mepSwitch', 'mepLight', 'mepBoard', 'mepFixture'], 40);
registerPanel(T, 'Schema', ['mepSchema', 'schemaSymbol', 'schemaLine', 'mepSchemaAuto'], 50);
registerPanel(T, 'Koordination', ['mepPenetrations', 'mepSlope', 'mepTag', 'mepRunList', 'mepViews'], 60);
registerContextPanel({ cats: ['pipe'], panel: 'Rohr', items: ['mepSlope'] });
registerContextPanel({ cats: ['pipe', 'duct', 'conduit'], panel: 'Leitung', items: ['mepTag', 'mepPenetrations'] });
registerSimilar('pipe', 'mepPipeS'); registerSimilar('duct', 'mepDuct'); registerSimilar('conduit', 'mepConduit');
registerSimilar('mepFixture', 'mepFixture'); registerSimilar('fbh', 'mepFbh'); registerSimilar('earthing', 'earthing'); registerSimilar('schemaSym', 'schemaSymbol'); registerSimilar('schemaLine', 'schemaLine');

// ------------------------------------------------------------ Durchbrüche: Dialog
function penetrationDialog(): void {
  const doc = app.doc;
  const o: PenOpts & { sleeves: boolean } = { clearance: 50, merge: 100, embeds: true, sleeves: true };
  const body = h('div', { style: 'min-width:760px' });
  let list = findPenetrations(doc, o);
  const num = (label: string, get: () => number, set: (v: number) => void) => {
    const i = h('input', { type: 'number', value: String(get()), style: 'width:70px' }) as HTMLInputElement;
    i.onchange = () => { const v = parseFloat(i.value); if (isFinite(v)) { set(v); render(); } };
    return h('label', { style: 'margin-right:14px' }, label + ' ', i);
  };
  const chk = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = get();
    c.onchange = () => { set(c.checked); render(); };
    return h('label', { style: 'margin-right:14px' }, c, ' ' + label);
  };
  const render = () => {
    list = findPenetrations(doc, o);
    body.innerHTML = '';
    body.append(h('div', { class: 'form-row' },
      num('Zuschlag auf Ø (mm)', () => o.clearance!, (v) => (o.clearance = Math.max(0, v))),
      num('Zusammenfassen bis (mm)', () => o.merge!, (v) => (o.merge = Math.max(0, v))),
      chk('Futterrohre in erdberührten Aussenwänden', () => o.sleeves, (v) => (o.sleeves = v)),
      chk('Einlegerohre in Decken', () => !!o.embeds, (v) => (o.embeds = v))));
    const t = h('table', { class: 'grid', style: 'width:100%' });
    t.append(h('tr', {}, ...['Nr.', 'Art', 'Bauteil', 'Grösse', 'x / y', 'Kote', 'Leitungen', 'Status'].map((s) => h('th', {}, s))));
    for (const p of list) {
      t.append(h('tr', {},
        h('td', {}, p.label || '–'), h('td', {}, PEN_KIND_LABEL[p.kind] + (p.wet ? ' (Futterrohr)' : '')), h('td', {}, p.hostName),
        h('td', {}, penSizeText(p)), h('td', {}, `${fmtNum(p.p.x / 1000, 2)} / ${fmtNum(p.p.y / 1000, 2)}`), h('td', {}, fmtNum(p.p.z / 1000, 2)),
        h('td', {}, p.purpose), h('td', {}, p.existing ? 'vorhanden' : 'neu')));
    }
    if (!list.length) t.append(h('tr', {}, h('td', { colspan: '8' }, 'Keine Durchdringungen gefunden.')));
    body.append(h('div', { class: 'hint' }, `${list.filter((p) => p.kind !== 'embed').length} Durchbrüche, ${list.filter((p) => p.kind === 'embed').length} Einlegerohre. Erneutes Ausführen aktualisiert früher erzeugte Elemente.`), t);
  };
  render();
  modal('Durchbrüche ermitteln (HLKSE → Tragwerk)', body, [
    { label: 'Durchbrüche erstellen', primary: true, onClick: () => {
      let r = { created: [] as Id[], updated: [] as Id[], removed: 0, handedOver: 0, skipped: 0 };
      doc.transaction('Durchbrüche erstellen', () => { r = applyPenetrations(doc, list, o); });
      app.status(`Durchbrüche: ${r.created.length} neu, ${r.updated.length} aktualisiert, ${r.removed} entfernt${r.handedOver ? `, ${r.handedOver} an Module übergeben` : ''}${r.skipped ? `, ${r.skipped} übersprungen` : ''}.`);
      app.select(r.created);
    } },
    { label: 'Schliessen', onClick: () => {} },
  ], 820);
}

// ------------------------------------------------------------ Leitungslisten, HLKSE-Grundrisse, Beschriftung
/** Bauteillisten für Leitungen (Länge je System/Grösse, Summen) und Heizkreise */
export function createRunSchedules(doc: Doc): View[] {
  const mk = (cat: string, name: string, data: Record<string, any>) => doc.add<View>({ id: newId('vw'), cat: 'view', kind: 'schedule', name, scale: 1, detail: 'medium', data: { cat, filters: [], totals: true, ...data } } as View);
  const out: View[] = [];
  const runList = { fields: ['system', 'size', 'count', 'length'], sort: [{ key: 'system' }, { key: 'size' }], itemize: false, footer: true, sums: ['length'] };
  out.push(mk('pipe', 'Leitungsliste Rohre', runList));
  out.push(mk('duct', 'Leitungsliste Lüftungskanäle', runList));
  out.push(mk('conduit', 'Leitungsliste Leerrohre / Trassen', runList));
  out.push(mk('fbh', 'Heizkreise', { fields: ['name', 'room', 'area', 'spacing', 'length', 'power', 'flow', 'manifold'], sort: [{ key: 'manifold' }, { key: 'name' }], itemize: true, footer: true, header: true, sums: ['area', 'length', 'power', 'flow'] }));
  if (doc.all('earthing').length) out.push(mk('earthing', 'Fundamenterder', { fields: ['host', 'werkstoff', 'dia', 'length', 'lugs'], sort: [{ key: 'host' }], itemize: true, sums: ['length', 'lugs'] }));
  out.push(mk('mepFixture', 'HLKSE-Elemente', { fields: ['disc', 'type', 'level', 'count'], sort: [{ key: 'disc' }, { key: 'type' }, { key: 'level' }], itemize: false, sums: [] }));
  return out;
}

/** Heizkreistabelle je FBH-Verteiler (Kreis, Raum, Fläche, VA, Länge, Leistung, Volumenstrom, Summe) – zum Platzieren im Plan */
export function createHeatingTable(doc: Doc, manifoldId?: Id): View[] {
  const manis = doc.all('mepFixture').filter((f) => (doc.get(f.typeId) as any)?.sym === 'manifold' && (!manifoldId || f.id === manifoldId));
  return manis.map((m) => {
    const label = m.label ?? (doc.get(m.typeId) as any)?.label ?? 'Verteiler';
    return doc.add<View>({
      id: newId('vw'), cat: 'view', kind: 'schedule', name: `Heizkreistabelle ${label} (${doc.get(m.levelId)?.name ?? ''})`.trim(), scale: 1, detail: 'medium',
      data: { cat: 'fbh', fields: ['name', 'room', 'area', 'spacing', 'length', 'power', 'flow'], sort: [{ key: 'name' }], itemize: true, totals: true, footer: false, sums: ['area', 'length', 'power', 'flow'],
        filters: [{ key: 'manifoldId', op: 'eq', value: m.id }], labels: { name: 'Kreis', spacing: 'VA', length: 'Länge' } },
    } as View);
  });
}

const HALFTONE_CATS = ['wall', 'door', 'window', 'opening', 'floor', 'ceiling', 'roof', 'stair', 'railing', 'component', 'column', 'beam', 'foundation', 'room', 'shaft', 'roomsep'];
/** HLKSE-Grundrisse je Geschoss und Gewerk (Gewerkefilter `data.mepDisc`, Architektur halbtonig) */
export function createMepPlans(doc: Doc, discs: Disc[] = ['H', 'L', 'S', 'E'], levelIds?: Id[]): View[] {
  const out: View[] = [];
  const ls = levels(doc).filter((l) => (levelIds ? levelIds.includes(l.id) : l.story !== false));
  const cov: Record<string, { halftone: boolean }> = {};
  for (const c of HALFTONE_CATS) cov[c] = { halftone: true };
  for (const l of ls as Level[]) for (const d of discs) {
    let name = `${DISC_LABEL[d]} ${l.name}`;
    const views = doc.all<View>('view');
    if (views.some((v) => v.kind === 'plan' && v.levelId === l.id && v.data?.mepDisc === d)) continue;
    if (views.some((v) => v.name === name)) name += ' (HLKSE)';
    out.push(doc.add<View>({
      id: newId('vw'), cat: 'view', kind: 'plan', name, scale: 50, detail: 'medium', levelId: l.id, range: { ...DEFAULT_RANGE }, discipline: 'coord',
      data: { mepDisc: d }, catOverrides: { ...cov }, hiddenCats: ['rebar', 'areaRebar', 'fabricArea', 'embed', 'joint'],
    } as View));
  }
  return out;
}

/** Leitungen (und Steigleitungen) einer Grundrissansicht beschriften */
export function tagRuns(doc: Doc, view: View, cats: string[] = [...RUN_CATS, 'fbh']): number {
  const dl = buildViewDL(doc, view);
  const shown = new Set(dl.items.map((it) => it.o).filter((o): o is string => !!o));
  let n = 0;
  for (const cat of cats) for (const el of doc.all(cat)) {
    if (!shown.has(el.id) || tagsOf(doc, el.id, view.id).length) continue;
    if (cat !== 'fbh') { const ri = runInfo(doc, el); if (!ri.vertical && ri.L2 < 8 * (view.scale || 100)) continue; }
    const t = makeTag(doc, el, view, { leader: false, vertical: false });
    if (!t) continue;
    if (cat !== 'fbh') {
      const ri = runInfo(doc, el);
      // parallel zur Leitung, seitlich versetzt
      if (!ri.vertical && Math.abs(ri.d2.y) > Math.abs(ri.d2.x)) t.vertical = true;
      const s = view.scale || 100;
      t.off = ri.vertical ? { x: 4 * s, y: 4 * s } : { x: -ri.d2.y * (ri.W / 2 + 3 * s), y: ri.d2.x * (ri.W / 2 + 3 * s) };
    }
    doc.add(t); n++;
  }
  return n;
}

// ------------------------------------------------------------ Öffentliche Funktionen (Skripte/API)
export { ensureMepTemplate, addMepTemplate, systems, sysOf, DEFAULT_SYSTEMS } from './common';
export { addRunChain, addRiser, applySlope, runInfo, runZ, sizeLabel, RUN_CATS } from './runs';
export type { MepRun, RunInput, RunCat } from './runs';
export { addFixture, wallMount, fixPos, FIX_SYMBOLS } from './fixtures';
export type { Fixture, FixType, FixSym } from './fixtures';
export { addCircuit, fbhLayout, fbhPower, nearestManifold } from './fbh';
export type { FbhCircuit } from './fbh';
export { createSchemaView, addSchemaSym, addSchemaLine, autoHeatingSchema, schemaPorts, SCHEMA_KINDS } from './schema';
export { findPenetrations, applyPenetrations, coreDia } from './penetrations';
export type { Penetration, PenOpts } from './penetrations';
export type { El };
