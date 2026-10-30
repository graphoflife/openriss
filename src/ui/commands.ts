// Kernbefehle mit Revit-Tastenkürzeln, Aufbau der Multifunktionsleiste und Kontextmenüs.
import { app } from '../app';
import { registerCommand, registerPanel, registerContextPanel, cmd, catDef, onHook, emitHook, GROUPS, PropDef } from '../core/registry';
import type { Id, El } from '../core/doc';
import { newId } from '../core/doc';
import { View, isPlanLike, isSectionLike, levelOptions, typesOf, VIEW_KIND_LABEL } from '../core/view';
import { SelectTool } from '../tools/selectTool';
import { WallTool, StructuralWallTool, LinesTool, GridTool, RefPlaneTool, LevelTool, SectionTool, ElevationTool, OpeningTool, placementFor } from '../tools/elementTools';
import { MoveTool, CopyTool, RotateTool, MirrorTool, ArrayTool, ScaleTool, AlignTool, TrimTool, TrimSingleTool, SplitTool, OffsetTool, MatchTool, MeasureTool, PasteTool, copyToClipboard, pasteAt } from '../tools/modifyTools';
import { Tool, ToolEvent } from '../tools/tool';
import type { DisplayList } from '../render/displayList';
import { visibilityDialog, shortcutsDialog, projectInfoDialog, unitsDialog, materialsDialog, objectStylesDialog, selectionFilterDialog, helpDialog, viewRangeDialog, promptDialog } from './dialogs';
import { getTempVis, resetTempVis } from '../views/viewBuilder';
import { bumpTempVis } from '../views/canvasView';
import { tempHide, tempIsolate, showMenu, SCALES } from './viewControlBar';
import { createNew, openProject, saveProject } from '../io/file';
import { h, runCmd } from './shell';
import { icon } from './icons';
import { duplicateView, renameView } from './browser';
import { renderProps } from './properties';
import { PHASE_MODES } from '../core/phases';

/** Werkzeug starten (mit Prüfung der Ansichtsart) */
export function startTool(t: Tool, id: string): void {
  const v = app.activeView();
  if (!v) { app.status('Bitte zuerst eine Ansicht öffnen.'); return; }
  if (!t.supports(v)) {
    const kinds = t.kinds.map((k) => VIEW_KIND_LABEL[k as keyof typeof VIEW_KIND_LABEL] ?? k).join(', ');
    app.status(`„${t.label}“ ist nur in folgenden Ansichten verfügbar: ${kinds}.`);
    return;
  }
  app.setTool(t, id);
}
const tool = (id: string, label: string, make: () => Tool, keys: string[] = [], ic = '', tip = '') =>
  registerCommand({ id, label, keys, icon: ic, tip, run: () => startTool(make(), id) });

const vp = (): any => app.active;
const hasSel = () => app.selection.size > 0;
const view2d = () => { const v = app.activeView(); return !!v && v.kind !== '3d' && v.kind !== 'schedule'; };

// ------------------------------------------------------------ Datei
registerCommand({ id: 'new', label: 'Neu', icon: 'new', tip: 'Neues Projekt aus der Vorlage', run: createNew });
registerCommand({ id: 'open', label: 'Öffnen', icon: 'open', tip: 'Projektdatei (*.oriss) öffnen', run: () => openProject() });
registerCommand({ id: 'save', label: 'Speichern', icon: 'save', tip: 'Projekt speichern (Strg+S)', run: () => saveProject(false) });
registerCommand({ id: 'saveAs', label: 'Speichern unter', icon: 'save', run: () => saveProject(true) });
registerCommand({ id: 'undo', label: 'Rückgängig', icon: 'undo', tip: 'Strg+Z', enabled: () => app.doc.canUndo(), run: () => { app.doc.undo(); app.status('Rückgängig: ' + app.doc.redoName()); app.refreshViews(); } });
registerCommand({ id: 'redo', label: 'Wiederherstellen', icon: 'redo', tip: 'Strg+Y', enabled: () => app.doc.canRedo(), run: () => { app.doc.redo(); app.refreshViews(); } });
registerCommand({ id: 'help', label: 'Hilfe', icon: 'help', keys: ['F1'], run: helpDialog });
registerCommand({ id: 'fileMenu', label: 'Datei', run: fileMenu });

function fileMenu(): void {
  document.querySelectorAll('.file-menu').forEach((m) => m.remove());
  const m = h('div', { class: 'file-menu' });
  const item = (id: string, key = '') => {
    const c = cmd(id); if (!c) return;
    const it = h('div', { class: 'fm-item', html: icon(c.icon, 22) + `<span>${c.label}</span>` + (key ? `<span class="fm-key">${key}</span>` : '') });
    it.onclick = () => { m.remove(); runCmd(id); };
    m.append(it);
  };
  item('new', 'Strg+N'); item('open', 'Strg+O'); item('save', 'Strg+S'); item('saveAs', 'Strg+Umschalt+S');
  m.append(h('div', { class: 'fm-sep' }), h('div', { class: 'fm-head' }, 'Exportieren / Drucken'));
  for (const id of ['print', 'exportPdf', 'exportSvg', 'exportPng', 'exportDxf', 'exportIfc', 'exportCsv']) item(id);
  m.append(h('div', { class: 'fm-sep' }), h('div', { class: 'fm-head' }, 'Einfügen'));
  for (const id of ['importDxf', 'importImage', 'loadSample']) item(id);
  m.append(h('div', { class: 'fm-sep' }));
  item('projectInfo'); item('keyboardShortcuts'); item('help');
  document.body.append(m);
  setTimeout(() => { const close = (e: MouseEvent) => { if (!m.contains(e.target as Node)) { m.remove(); window.removeEventListener('mousedown', close); } }; window.addEventListener('mousedown', close); }, 0);
}

// ------------------------------------------------------------ Zwischenablage & Auswahl
registerCommand({ id: 'clipCopy', label: 'In Zwischenablage kopieren', icon: 'copy', tip: 'Strg+C', run: copyToClipboard });
registerCommand({ id: 'clipCut', label: 'Ausschneiden', icon: 'copy', tip: 'Strg+X', run: () => { copyToClipboard(); app.deleteSelection(); } });
registerCommand({ id: 'clipPaste', label: 'Einfügen', icon: 'copy', tip: 'Aus Zwischenablage einfügen (Strg+V)', enabled: () => !!app.clipboard, run: () => startTool(new PasteTool(), 'clipPaste') });
registerCommand({ id: 'pasteSame', label: 'An gleicher Position einfügen', icon: 'copy', tip: 'Ausgerichtet an gleicher Position; Ebenen werden auf die aktive Ebene übertragen', enabled: () => !!app.clipboard, run: () => pasteAt({ x: 0, y: 0 }) });
registerCommand({ id: 'selectAll', label: 'Alles auswählen', run: () => { const d: DisplayList | undefined = vp()?.displayList?.(); if (d) app.select([...new Set(d.items.map((i) => i.o).filter((o): o is string => !!o && app.doc.has(o) && o !== app.activeView()?.id))]); } });
registerCommand({ id: 'select', label: 'Ändern', icon: 'select', tip: 'Auswahlwerkzeug (Esc)', run: () => app.setTool(null) });
registerCommand({ id: 'properties', label: 'Eigenschaften', icon: 'info', keys: ['PP', 'VP'], run: () => { const p = document.getElementById('props'); if (p) p.style.display = p.style.display === 'none' ? '' : 'none'; } });
registerCommand({ id: 'delete', label: 'Löschen', icon: 'delete', keys: ['DE'], enabled: hasSel, run: () => app.deleteSelection() });
registerCommand({ id: 'selectionFilter', label: 'Filter', icon: 'filter', enabled: hasSel, run: selectionFilterDialog });
registerCommand({ id: 'pin', label: 'Fixieren', icon: 'pin', keys: ['PN'], enabled: hasSel, run: () => app.doc.transaction('Fixieren', () => { for (const id of app.selection) app.doc.update(id, { pinned: true }); }) });
registerCommand({ id: 'unpin', label: 'Lösen', icon: 'unpin', keys: ['UP'], enabled: hasSel, run: () => app.doc.transaction('Lösen', () => { for (const id of app.selection) app.doc.update(id, { pinned: false }); }) });
registerCommand({ id: 'selectInstances', label: 'Alle Exemplare auswählen', keys: ['SA'], enabled: () => app.selected().some((e) => e.typeId), run: () => {
  const types = new Set(app.selected().map((e) => e.typeId).filter(Boolean));
  app.select(app.doc.all().filter((e) => e.typeId && types.has(e.typeId) && e.cat !== 'type').map((e) => e.id));
} });

// ------------------------------------------------------------ Ändern
tool('move', 'Verschieben', () => new MoveTool(), ['MV'], 'move', 'Ausgewählte Elemente verschieben');
tool('copy', 'Kopieren', () => new CopyTool(), ['CO', 'CC'], 'copy', 'Ausgewählte Elemente kopieren');
tool('rotate', 'Drehen', () => new RotateTool(), ['RO'], 'rotate', 'Ausgewählte Elemente um einen Punkt drehen');
tool('mirrorPick', 'Spiegeln - Achse wählen', () => new MirrorTool(false), ['MM'], 'mirror');
tool('mirrorDraw', 'Spiegeln - Achse zeichnen', () => new MirrorTool(true), ['DM'], 'mirrordraw');
tool('array', 'Reihe', () => new ArrayTool(), ['AR'], 'array', 'Lineare Reihe von Kopien');
tool('scale', 'Skalieren', () => new ScaleTool(), ['RE'], 'scale');
tool('align', 'Ausrichten', () => new AlignTool(), ['AL'], 'align', 'Elemente an einer Referenz ausrichten');
tool('trim', 'Stutzen/Dehnen zu Ecke', () => new TrimTool(), ['TR'], 'trim');
tool('trimSingle', 'Stutzen/Dehnen einzelnes Element', () => new TrimSingleTool(), [], 'trim1');
tool('split', 'Element teilen', () => new SplitTool(), ['SL'], 'split');
tool('offset', 'Versatz', () => new OffsetTool(), ['OF'], 'offset');
tool('match', 'Typeigenschaften anpassen', () => new MatchTool(), ['MA'], 'match');
tool('measure', 'Messen', () => new MeasureTool(), ['ME'], 'measure', 'Zwischen zwei Punkten messen');
registerCommand({ id: 'createSimilar', label: 'Ähnliches erstellen', icon: 'copy', keys: ['CS'], enabled: () => app.selection.size === 1, run: createSimilar });

const SIMILAR: Record<string, string> = { wall: 'wall', door: 'door', window: 'window', line: 'detailLine', grid: 'grid', level: 'level', refplane: 'refplane' };
export function registerSimilar(cat: string, cmdId: string): void { SIMILAR[cat] = cmdId; }
function createSimilar(): void {
  const el = app.selected()[0]; if (!el) return;
  const c = SIMILAR[el.cat]; if (!c) { app.status('Für diese Kategorie nicht verfügbar.'); return; }
  if (el.cat === 'line' && !el.viewId) runCmd('modelLine'); else runCmd(c);
  if (el.typeId && app.tool.placement) app.tool.placement.setType(el.typeId);
  if (el.cat === 'line' && (app.tool as any).style !== undefined) (app.tool as any).style = el.style;
  app.emit('tool');
}
onHook('createInstanceOfType', (t: El) => { const c = SIMILAR[t.of]; if (c) { runCmd(c); app.tool.placement?.setType(t.id); } });

// ------------------------------------------------------------ Architektur
tool('wall', 'Wand', () => new WallTool(), ['WA'], 'wall', 'Wand zeichnen. Leertaste kehrt die Außenseite um, Zahl tippen für exakte Länge.');
tool('wallStruct', 'Tragende Wand', () => new StructuralWallTool(), [], 'wall', 'Tragende Wand zeichnen');
tool('door', 'Tür', () => new OpeningTool('door'), ['DR'], 'door', 'Tür in eine Wand einsetzen. Die Aufschlagseite folgt dem Cursor, Leertaste wechselt den Anschlag.');
tool('window', 'Fenster', () => new OpeningTool('window'), ['WN'], 'window', 'Fenster in eine Wand einsetzen');
tool('modelLine', 'Modelllinie', () => new LinesTool(false), ['LI'], 'line', 'Linie im Modell (in allen Ansichten der Ebene sichtbar)');
tool('level', 'Ebene', () => new LevelTool(), ['LL'], 'level', 'Ebene in einem Schnitt oder einer Ansicht zeichnen');
tool('grid', 'Raster', () => new GridTool(), ['GR'], 'grid', 'Rasterlinie zeichnen; die Bezeichnung wird automatisch fortgezählt');
tool('refplane', 'Referenzebene', () => new RefPlaneTool(), ['RP'], 'refplane');
tool('detailLine', 'Detaillinie', () => new LinesTool(true), ['DL'], 'detailline', 'Linie nur in der aktuellen Ansicht');

registerPanel('Architektur', 'Erstellen', ['wall', 'door', 'window', 'component', 'column', 'roof', 'ceiling', 'floor', 'curtainWall'], 10);
registerPanel('Architektur', 'Erschließung', ['stair', 'railing', 'ramp'], 20);
registerPanel('Architektur', 'Modell', ['modelLine', 'modelText', 'modelGroup'], 30);
registerPanel('Architektur', 'Raum und Fläche', ['room', 'roomSeparator', 'roomTag', 'areaPlan'], 40);
registerPanel('Architektur', 'Öffnung', ['wallOpening', 'shaft', 'verticalOpening'], 50);
registerPanel('Architektur', 'Bezug', ['level', 'grid', 'refplane'], 60);

registerPanel('Ingenieurbau', 'Tragwerk', ['beam', 'wallStruct', 'column', 'floorStruct'], 10);
registerPanel('Ingenieurbau', 'Fundament', ['foundationIsolated', 'foundationWall', 'foundationSlab'], 20);
registerPanel('Ingenieurbau', 'Bewehrung', ['rebar', 'stirrup', 'areaRebar', 'fabricArea', 'rebarCover', 'rebarSchedule'], 30);
registerPanel('Ingenieurbau', 'Bezug', ['level', 'grid', 'refplane'], 60);

registerPanel('Einfügen', 'Verknüpfen / Importieren', ['importDxf', 'importImage', 'loadSample'], 10);

registerPanel('Beschriften', 'Bemaßung', ['dimAligned', 'dimLinear', 'dimAngular', 'dimRadial', 'dimArc', 'spotElevation', 'spotCoordinate'], 10);
registerPanel('Beschriften', 'Detail', ['detailLine', 'filledRegion', 'detailComponent', 'insulation', 'revisionCloud'], 20);
registerPanel('Beschriften', 'Text', ['text'], 30);
registerPanel('Beschriften', 'Beschriftung', ['tagByCat', 'tagAll', 'roomTag', 'rebarTag', 'symbol'], 40);

// ------------------------------------------------------------ Ansicht
registerCommand({ id: 'vv', label: 'Sichtbarkeit/ Grafiken', icon: 'vv', keys: ['VV', 'VG'], enabled: () => !!app.activeView(), run: () => visibilityDialog(app.activeView()!) });
registerCommand({ id: 'thinLines', label: 'Dünne Linien', icon: 'thinlines', keys: ['TL'], checked: () => app.settings.thinLines, run: () => { app.settings.thinLines = !app.settings.thinLines; app.saveSettings(); (window as any).__renderRibbon?.(); } });
registerCommand({ id: 'tempHide', label: 'Element temporär ausblenden', icon: 'hide', keys: ['HH'], enabled: hasSel, run: () => tempHide(app.activeView()!, false) });
registerCommand({ id: 'tempIsolate', label: 'Element temporär isolieren', icon: 'isolate', keys: ['HI'], enabled: hasSel, run: () => tempIsolate(app.activeView()!, false) });
registerCommand({ id: 'tempHideCat', label: 'Kategorie temporär ausblenden', icon: 'hide', keys: ['HC'], enabled: hasSel, run: () => tempHide(app.activeView()!, true) });
registerCommand({ id: 'tempIsolateCat', label: 'Kategorie temporär isolieren', icon: 'isolate', keys: ['IC'], enabled: hasSel, run: () => tempIsolate(app.activeView()!, true) });
registerCommand({ id: 'tempReset', label: 'Temporär ausblenden zurücksetzen', icon: 'vv', keys: ['HR'], run: () => { const v = app.activeView(); if (v) { resetTempVis(v.id); bumpTempVis(); app.emit('view'); } } });
registerCommand({ id: 'revealHidden', label: 'Verdeckte Elemente anzeigen', icon: 'vv', keys: ['RH'], run: () => { const v = app.activeView(); if (v) { const t = getTempVis(v.id); t.reveal = !t.reveal; bumpTempVis(); app.emit('view'); } } });
registerCommand({ id: 'hideEl', label: 'In Ansicht ausblenden: Elemente', icon: 'hide', keys: ['EH'], enabled: hasSel, run: () => hideInView(false) });
registerCommand({ id: 'hideCat', label: 'In Ansicht ausblenden: Kategorie', icon: 'hide', keys: ['VH'], enabled: hasSel, run: () => hideInView(true) });
registerCommand({ id: 'unhideEl', label: 'In Ansicht einblenden: Elemente', icon: 'vv', keys: ['EU'], enabled: hasSel, run: () => {
  const v = app.activeView(); if (!v) return; const sel = new Set(app.selection);
  app.doc.transaction('Einblenden', () => app.doc.update(v.id, { hiddenEls: (v.hiddenEls ?? []).filter((id) => !sel.has(id)) })); app.refreshViews();
} });
function hideInView(byCat: boolean): void {
  const v = app.activeView(); if (!v) return;
  const sel = app.selected();
  app.doc.transaction('In Ansicht ausblenden', () => {
    if (byCat) app.doc.update(v.id, { hiddenCats: [...new Set([...(v.hiddenCats ?? []), ...sel.map((e) => e.cat)])] });
    else app.doc.update(v.id, { hiddenEls: [...new Set([...(v.hiddenEls ?? []), ...sel.map((e) => e.id)])] });
  });
  app.select([]); app.refreshViews();
}

registerCommand({ id: 'zoomExtents', label: 'Zoom Grenzen', icon: 'zoom', keys: ['ZE', 'ZF', 'ZA', 'ZX'], run: () => vp()?.zoomExtents() });
registerCommand({ id: 'zoomOut', label: 'Verkleinern (2x)', icon: 'zoom', keys: ['ZO', 'ZV'], run: () => vp()?.zoomBy?.(0.5) });
registerCommand({ id: 'zoomIn', label: 'Vergrößern (2x)', icon: 'zoom', keys: ['ZI'], run: () => vp()?.zoomBy?.(2) });
registerCommand({ id: 'zoomPrevious', label: 'Vorheriger Zoom', icon: 'zoom', keys: ['ZP'], run: () => vp()?.zoomPrevious?.() });
registerCommand({ id: 'zoomRegion', label: 'Bereich vergrößern', icon: 'zoom', keys: ['ZR', 'ZZ'], enabled: view2d, run: () => startTool(new ZoomRegionTool(), 'zoomRegion') });
registerCommand({ id: 'closeInactive', label: 'Inaktive Ansichten schließen', icon: 'close', run: () => { const a = app.activeView()?.id; for (const id of [...app.viewports.keys()]) if (id !== a) app.closeView(id); } });
registerCommand({ id: 'section', label: 'Schnitt', icon: 'section', keys: ['SEC'], run: () => startTool(new SectionTool(), 'section') });
registerCommand({ id: 'elevation', label: 'Ansicht', icon: 'elevation', run: () => startTool(new ElevationTool(), 'elevation') });
registerCommand({ id: 'draftingView', label: 'Zeichnungsansicht', icon: 'drafting', tip: 'Neue 2D-Zeichnungsansicht für Details', run: () => {
  promptDialog('Neue Zeichnungsansicht', 'Name', 'Detail ' + (app.doc.all<View>('view').filter((v) => v.kind === 'drafting').length + 1), (name) => {
    if (!name) return; const id = newId('vw');
    app.doc.transaction('Zeichnungsansicht', () => app.doc.add({ id, cat: 'view', kind: 'drafting', name, scale: 10, detail: 'fine' } as View));
    app.openView(id);
  });
} });
registerCommand({ id: 'legendView', label: 'Legende', icon: 'legend', run: () => {
  promptDialog('Neue Legende', 'Name', 'Legende ' + (app.doc.all<View>('view').filter((v) => v.kind === 'legend').length + 1), (name) => {
    if (!name) return; const id = newId('vw');
    app.doc.transaction('Legende', () => app.doc.add({ id, cat: 'view', kind: 'legend', name, scale: 50, detail: 'medium' } as View));
    app.openView(id);
  });
} });
registerCommand({ id: 'duplicateView', label: 'Ansicht duplizieren', icon: 'copy', enabled: () => !!app.activeView(), run: () => { const v = app.activeView(); if (v) app.openView(duplicateView(v, false)); } });
registerCommand({ id: 'viewRange', label: 'Ansichtsbereich', icon: 'plan', enabled: () => !!app.activeView() && isPlanLike(app.activeView()!), run: () => viewRangeDialog(app.activeView()!) });

registerPanel('Ansicht', 'Grafik', ['vv', 'thinLines', 'tempReset', 'revealHidden'], 10);
registerPanel('Ansicht', 'Erstellen', ['default3d', 'section', 'elevation', 'callout', 'planView', 'draftingView', 'legendView', 'schedule', 'duplicateView'], 20);
registerPanel('Ansicht', 'Plankomposition', ['sheet', 'placeView', 'titleblock', 'revisions'], 30);
registerPanel('Ansicht', 'Fenster', ['closeInactive', 'tileViews', 'zoomExtents', 'zoomRegion'], 40);

// ------------------------------------------------------------ Verwalten
registerCommand({ id: 'projectInfo', label: 'Projekt- informationen', icon: 'info', run: projectInfoDialog });
registerCommand({ id: 'units', label: 'Projekt- einheiten', icon: 'measure', keys: ['UN'], run: unitsDialog });
registerCommand({ id: 'materials', label: 'Materialien', icon: 'material', keys: ['MAT'], run: materialsDialog });
registerCommand({ id: 'objectStyles', label: 'Objektstile', icon: 'thinlines', run: objectStylesDialog });
registerCommand({ id: 'keyboardShortcuts', label: 'Tastatur- befehle', icon: 'keyboard', keys: ['KS'], run: shortcutsDialog });
registerCommand({ id: 'snapsDialog', label: 'Fang', icon: 'settings', run: snapDialog });
registerPanel('Verwalten', 'Einstellungen', ['materials', 'objectStyles', 'snapsDialog', 'projectInfo', 'units', 'keyboardShortcuts'], 10);

// Fangüberschreibungen (wie Revit)
const snapCmd = (id: string, key: string, kind: string, label: string) => registerCommand({ id, label, keys: [key], run: () => { app.snapOverride = kind; app.status('Fang: ' + label); } });
snapCmd('snapEnd', 'SE', 'end', 'Endpunkte'); snapCmd('snapMid', 'SM', 'mid', 'Mittelpunkte'); snapCmd('snapInt', 'SI', 'int', 'Schnittpunkte');
snapCmd('snapNear', 'SN', 'near', 'Nächster'); snapCmd('snapPerp', 'SP', 'perp', 'Lotrecht'); snapCmd('snapCenter', 'SC', 'center', 'Zentren'); snapCmd('snapQuad', 'SQ', 'quad', 'Quadranten');
snapCmd('snapOff', 'SO', 'off', 'Aus');
registerCommand({ id: 'snapReset', label: 'Fangüberschreibung aus', keys: ['SS'], run: () => { app.snapOverride = null; app.status('Fang: Standard'); } });
app.on('tool', () => { app.snapOverride = null; });

function snapDialog(): void {
  import('./dialogs').then(({ modal }) => {
    const body = h('div', {});
    const kinds: [string, string][] = [['end', 'Endpunkte'], ['mid', 'Mittelpunkte'], ['int', 'Schnittpunkte'], ['center', 'Zentren'], ['quad', 'Quadranten'], ['perp', 'Lotrecht'], ['near', 'Nächster'], ['angle', 'Winkelinkremente (15°)'], ['length', 'Längeninkremente (zoomabhängig)']];
    const all = h('input', { type: 'checkbox' }) as HTMLInputElement; all.checked = app.settings.snaps; all.onchange = () => (app.settings.snaps = all.checked);
    body.append(h('div', { class: 'form-row' }, h('label', {}, all, ' Objektfang aktiv')));
    for (const [k, l] of kinds) {
      const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = app.settings.snapKinds[k] !== false;
      c.onchange = () => (app.settings.snapKinds[k] = c.checked);
      body.append(h('div', { class: 'form-row' }, h('label', {}, c, ' ' + l)));
    }
    body.append(h('div', { class: 'hint' }, 'Einmalige Überschreibung: SE, SM, SI, SN, SP, SC, SQ – SO schaltet den Fang für den nächsten Klick aus.'));
    modal('Fang', body, [{ label: 'OK', primary: true, onClick: () => app.saveSettings() }]);
  });
}

// ------------------------------------------------------------ Ändern-Register
registerPanel('Ändern', 'Auswählen', [{ cmd: 'select', size: 'large' }], 5);
registerPanel('Ändern', 'Eigenschaften', [{ cmd: 'properties', size: 'large' }], 6);
registerPanel('Ändern', 'Zwischenablage', [{ cmd: 'clipPaste', size: 'large' }, { cmd: 'clipCopy', size: 'small' }, { cmd: 'clipCut', size: 'small' }, { cmd: 'pasteSame', size: 'small' }], 7);
registerPanel('Ändern', 'Ändern', [
  { cmd: 'align', size: 'small' }, { cmd: 'offset', size: 'small' }, { cmd: 'mirrorPick', size: 'small' },
  { cmd: 'move', size: 'small' }, { cmd: 'copy', size: 'small' }, { cmd: 'rotate', size: 'small' },
  { cmd: 'trim', size: 'small' }, { cmd: 'split', size: 'small' }, { cmd: 'trimSingle', size: 'small' },
  { cmd: 'array', size: 'small' }, { cmd: 'scale', size: 'small' }, { cmd: 'mirrorDraw', size: 'small' },
  { cmd: 'pin', size: 'small' }, { cmd: 'unpin', size: 'small' }, { cmd: 'delete', size: 'small' },
], 10);
registerPanel('Ändern', 'Messen', [{ cmd: 'measure', size: 'large' }], 20);
registerPanel('Ändern', 'Erstellen', [{ cmd: 'createSimilar', size: 'large' }, { cmd: 'match', size: 'large' }], 30);
registerPanel('Ändern', 'Ansicht', [{ cmd: 'tempHide', size: 'small' }, { cmd: 'tempIsolate', size: 'small' }, { cmd: 'hideEl', size: 'small' }], 40);

// Kontextpanels
registerCommand({ id: 'flipWall', label: 'Ausrichtung umkehren', icon: 'flip', tip: 'Leertaste', run: () => app.tool.space() || app.defaultTool.space() });
registerCommand({ id: 'wallDisallowJoin', label: 'Verbindung nicht zulassen', icon: 'split', tip: 'Wandverbindungen an beiden Enden der ausgewählten Wände lösen bzw. wieder zulassen', enabled: () => app.selected().some((e) => e.cat === 'wall'), run: () => {
  const ws = app.selected().filter((e) => e.cat === 'wall');
  const off = !ws.every((w) => w.noJoinA && w.noJoinB);
  app.doc.transaction('Wandverbindung', () => { for (const w of ws) app.doc.update(w.id, { noJoinA: off, noJoinB: off }); });
  app.status(off ? 'Wandverbindungen gelöst.' : 'Wandverbindungen zugelassen.');
} });
registerContextPanel({ cats: ['wall'], panel: 'Wand', items: ['flipWall', 'wallAttachTop', 'wallDetachTop', 'wallDisallowJoin', 'wallEditProfile'] });
registerContextPanel({ cats: ['door', 'window'], panel: 'Öffnung', items: ['flipWall'] });
registerCommand({ id: 'openView', label: 'Ansicht öffnen', icon: 'plan', enabled: () => app.selected().some((e) => e.cat === 'view'), run: () => { const v = app.selected().find((e) => e.cat === 'view'); if (v) app.openView(v.id); } });
registerContextPanel({ cats: ['view'], panel: 'Ansicht', items: ['openView'] });

// ------------------------------------------------------------ Bereich vergrößern
class ZoomRegionTool extends Tool {
  id = 'zoomRegion'; label = 'Bereich vergrößern'; snapping = false;
  private a: { x: number; y: number } | null = null; private c: { x: number; y: number } | null = null;
  prompt() { return this.a ? 'Zweite Ecke klicken' : 'Erste Ecke des Bereichs klicken'; }
  down(e: ToolEvent) {
    if (!this.a) { this.a = e.raw; return; }
    e.vp.fitBox({ min: { x: Math.min(this.a.x, e.raw.x), y: Math.min(this.a.y, e.raw.y) }, max: { x: Math.max(this.a.x, e.raw.x), y: Math.max(this.a.y, e.raw.y) } });
    app.setTool(null);
  }
  move(e: ToolEvent) { this.c = e.raw; }
  preview(dl: DisplayList) { if (this.a && this.c) dl.poly([this.a, { x: this.c.x, y: this.a.y }, this.c, { x: this.a.x, y: this.c.y }], { w: 1, color: '#1e6fd9', dash: 'dash' }, true); }
}

// ------------------------------------------------------------ Kontextmenü im Zeichenbereich
onHook('contextmenu', (v: any, e: MouseEvent) => {
  const items: ([string, () => void] | '-')[] = [];
  if (app.tool !== app.defaultTool) items.push(['Abbrechen', () => app.setTool(null)]);
  const last = app.lastCommand ? cmd(app.lastCommand) : null;
  if (last) items.push([`Wiederholen [${last.label}]`, () => runCmd(last.id)]);
  if (app.selection.size === 1) items.push(['Ähnliches erstellen', () => runCmd('createSimilar')]);
  if (app.selection.size) {
    items.push('-', ['Alle Exemplare auswählen', () => runCmd('selectInstances')]);
    items.push(['In Ansicht ausblenden: Elemente', () => runCmd('hideEl')], ['In Ansicht ausblenden: Kategorie', () => runCmd('hideCat')]);
    items.push(['Löschen', () => app.deleteSelection()]);
  }
  items.push('-', ['Zoom Grenzen', () => v.zoomExtents()], ['Vorheriger Zoom', () => v.zoomPrevious()], ['Verkleinern (2x)', () => v.zoomBy(0.5)]);
  items.push('-', ['Eigenschaften', () => runCmd('properties')]);
  showMenu(e.clientX, e.clientY, items);
});

// ------------------------------------------------------------ Ansichtseigenschaften (Palette ohne Auswahl)
const viewDef = catDef('view')!;
viewDef.props = (el: El) => {
  const v = el as View; const g = GROUPS;
  const p: PropDef[] = [];
  if (v.kind !== 'sheet' && v.kind !== 'schedule' && v.kind !== '3d') {
    p.push({ key: 'scale', label: 'Ansichtsmaßstab', group: g.graphics, type: 'select', options: SCALES.map((s) => [String(s), '1 : ' + s] as [string, string]), get: (e) => String(e.scale), set: (_e, x) => ({ scale: parseInt(x, 10) }) });
    p.push({ key: 'detail', label: 'Detaillierungsgrad', group: g.graphics, type: 'select', options: [['coarse', 'Grob'], ['medium', 'Mittel'], ['fine', 'Fein']], get: (e) => e.detail, set: (_e, x) => ({ detail: x }) });
    p.push({ key: 'vv', label: 'Sichtbarkeit/Grafiken überschreiben', group: g.graphics, type: 'button', get: () => 'Bearbeiten…', action: (e) => visibilityDialog(e as View) });
  }
  if (v.kind === 'plan' || v.kind === 'ceiling') {
    p.push({ key: 'underlay', label: 'Unterlage', group: g.graphics, type: 'select', options: (doc) => [['', 'Keine'], ...levelOptions(doc)], get: (e) => e.underlayLevelId ?? '', set: (_e, x) => ({ underlayLevelId: x || null }) });
    p.push({ key: 'level', label: 'Zugeordnete Ebene', group: g.identity, type: 'readonly', get: (e, doc) => doc.get(e.levelId)?.name ?? '' });
    p.push({ key: 'range', label: 'Ansichtsbereich', group: g.extents, type: 'button', get: () => 'Bearbeiten…', action: (e) => viewRangeDialog(e as View) });
    p.push({ key: 'discipline', label: 'Disziplin', group: g.graphics, type: 'select', options: [['arch', 'Architektur'], ['struct', 'Tragwerk'], ['coord', 'Koordination']], get: (e) => e.discipline ?? 'arch', set: (_e, x) => ({ discipline: x }) });
  }
  if (v.kind !== 'drafting' && v.kind !== 'sheet' && v.kind !== 'schedule' && v.kind !== 'legend' && v.kind !== '3d') {
    p.push({ key: 'cropOn', label: 'Zuschneiden', group: g.extents, type: 'bool', get: (e) => !!e.crop?.on, set: (e, x) => ({ crop: { ...(e.crop ?? { show: true, min: { x: -10000, y: -10000 }, max: { x: 10000, y: 10000 } }), on: x } }) });
    p.push({ key: 'cropShow', label: 'Zuschneidebereich sichtbar', group: g.extents, type: 'bool', get: (e) => !!e.crop?.show, set: (e, x) => ({ crop: { ...(e.crop ?? { on: false, min: { x: -10000, y: -10000 }, max: { x: 10000, y: 10000 } }), show: x } }) });
  }
  if (v.kind === 'section' || v.kind === 'elevation') {
    p.push({ key: 'far', label: 'Ansichtstiefe (Begrenzung)', group: g.extents, type: 'length', get: (e) => e.far ?? 0, set: (_e, x) => ({ far: x }) });
    if (v.crop) {
      p.push({ key: 'cropBottom', label: 'Zuschnitt unten (Höhe)', group: g.extents, type: 'length', get: (e) => e.crop?.min.y ?? 0, set: (e, x) => ({ crop: { ...e.crop, min: { ...e.crop.min, y: x } } }) });
      p.push({ key: 'cropTop', label: 'Zuschnitt oben (Höhe)', group: g.extents, type: 'length', get: (e) => e.crop?.max.y ?? 0, set: (e, x) => ({ crop: { ...e.crop, max: { ...e.crop.max, y: x } } }) });
    }
  }
  if (v.kind !== 'sheet' && v.kind !== 'schedule' && v.kind !== 'drafting' && v.kind !== 'legend') {
    p.push({ key: 'phaseMode', label: 'Phasenfilter', group: 'Phasen', type: 'select', options: PHASE_MODES as [string, string][], get: (e) => e.phaseMode ?? 'all', set: (_e, x) => ({ phaseMode: x }) });
  }
  p.push({ key: 'name', label: 'Ansichtsname', group: g.identity, type: 'text', get: (e) => e.name, set: (_e, x) => (x ? { name: x } : undefined) });
  if (v.kind === 'section' || v.kind === 'elevation') p.push({ key: 'marker', label: 'Symbolbeschriftung', group: g.identity, type: 'text', get: (e) => e.data?.marker ?? '', set: (e, x) => ({ data: { ...(e.data ?? {}), marker: x } }) });
  p.push({ key: 'titleOnSheet', label: 'Titel auf Plan', group: g.identity, type: 'text', get: (e) => e.titleOnSheet ?? '', set: (_e, x) => ({ titleOnSheet: x }) });
  return p;
};

export { renameView, renderProps, isSectionLike, typesOf, placementFor };
