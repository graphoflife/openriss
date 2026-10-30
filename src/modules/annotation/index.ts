// Modul: annotation – Bemaßungen, Höhenkoten, Text, Beschriftungen, Raumstempel, Füllbereiche,
// Dämmung, Detailbauteile, Revisionswolken und Symbole. Registriert Kategorien, Befehle und Hooks.
import { app } from '../../app';
import type { Doc, El } from '../../core/doc';
import { registerCommand, registerContextPanel, registerPanel, onHook } from '../../core/registry';
import { projectInfo, ProjectInfo } from '../../core/view';
import { parseNum } from '../../core/units';
import { registerProjectInfoField, toast } from '../../ui/dialogs';
import { startTool, registerSimilar } from '../../ui/commands';
import type { Tool, ToolEvent } from '../../tools/tool';
import './icons';
import './types';
import { ensureTypes } from './common';
import { DimTool, AngularDimTool, ArcDimTool, dimTextDialog, Dim } from './dims';
import { SpotTool } from './spots';
import { chSpotTypes } from './types';
import { applyLocale, Locale } from './locale';
import { TextTool, AddLeaderTool, editTextEl, TextEl } from './text';
import { TagTool, tagAllDialog, editTagValue, Tag } from './tags';
import { startRegionTool, startCloudTool, editSketch } from './regions';
import { InsulationTool, DetailTool, SymbolTool } from './details';

// ------------------------------------------------------------ Befehle
const toolCmd = (id: string, label: string, icon: string, keys: string[], tip: string, cats: string[], make: () => Tool) =>
  registerCommand({ id, label, icon, keys, tip, run: () => { if (cats.length) ensureTypes(...cats); startTool(make(), id); } });

toolCmd('dimAligned', 'Ausgerichtet', 'dimension', ['DI'],
  'Ausgerichtete Bemaßung: Referenzen nacheinander wählen (Wände, Linien, Raster, Punkte), dann in einen freien Bereich klicken. Tab wechselt zwischen Referenzen. Option „Ganze Wände“ erzeugt Maßketten automatisch.',
  ['dimension'], () => new DimTool(true));
toolCmd('dimLinear', 'Linear', 'dimlinear', [], 'Horizontale bzw. vertikale Bemaßung – die Richtung folgt der Cursorposition.', ['dimension'], () => new DimTool(false));
toolCmd('dimAngular', 'Winkel', 'dimangular', [], 'Winkelbemaßung zwischen zwei Linien.', ['dimension'], () => new AngularDimTool());
toolCmd('dimRadial', 'Radius', 'dimradial', [], 'Radiusbemaßung eines Bogens oder Kreises.', ['dimension'], () => new ArcDimTool('radial'));
toolCmd('dimArc', 'Bogenlänge', 'dimarc', [], 'Bogenlängenbemaßung.', ['dimension'], () => new ArcDimTool('arc'));
toolCmd('spotElevation', 'Höhenkote', 'spot', ['EL'], 'Höhenkote: im Schnitt/in der Ansicht die Höhe des gewählten Punktes, im Grundriss die Ebenenhöhe (+ Versatz).', ['spot'], () => new SpotTool('elev'));
toolCmd('spotCoordinate', 'Koordinate', 'spotcoord', [], 'Punktkoordinate (Ost/Nord) im Grundriss.', ['spot'], () => new SpotTool('coord'));
registerCommand({
  id: 'spotSlab', label: 'Koten- Kästchen', icon: 'spotbox',
  tip: 'Koten-Kästchen im Grundriss: OK/UK/Dicke der Decke bzw. Platte am gewählten Punkt (Tab wechselt zwischen übereinanderliegenden Decken).',
  run: () => {
    ensureTypes('spot');
    if (!app.doc.get('spt_box')) app.doc.transaction('Kotentypen laden', () => chSpotTypes(app.doc));
    startTool(new SpotTool('slab'), 'spotSlab');
  },
});
registerPanel('Beschriften', 'Bemaßung', ['spotSlab'], 10);
toolCmd('text', 'Text', 'text', ['TX'], 'Textnotiz: Klicken (oder Rechteck aufziehen für Umbruchbreite) und Text eingeben. Doppelklick bearbeitet vorhandenen Text.', ['text'], () => new TextTool());
toolCmd('tagByCat', 'Nach Kategorie', 'tag', ['TG'], 'Beschriftung nach Kategorie: Türen (Kennzeichen im Kreis), Fenster (Typ im Rechteck), Wände …', ['tag', 'roomtag'], () => new TagTool(false));
registerCommand({ id: 'tagAll', label: 'Alle beschriften', icon: 'tagall', tip: 'Alle nicht beschrifteten Elemente der aktiven Ansicht beschriften.', run: tagAllDialog });
toolCmd('roomTag', 'Raum beschriften', 'roomtag', ['RT'], 'Raumstempel (Name, Nummer, Fläche) platzieren.', ['roomtag'], () => new TagTool(true));
registerCommand({ id: 'filledRegion', label: 'Füllbereich', icon: 'region', tip: 'Füllbereich oder Maskierungsbereich skizzieren (geschlossene Umrisse, Löcher möglich).', run: startRegionTool });
toolCmd('insulation', 'Dämmung', 'insulation', [], 'Dämmung entlang einer Linie zeichnen (Breite in der Optionsleiste).', [], () => new InsulationTool());
toolCmd('detailComponent', 'Detailbauteil', 'detail', [], 'Detailbauteil platzieren: Bruchlinie, Abdichtung, Holzlatte/Kantholz. Leertaste dreht.', ['detail'], () => new DetailTool());
registerCommand({ id: 'revisionCloud', label: 'Revisionswolke', icon: 'cloud', tip: 'Revisionswolke skizzieren.', run: startCloudTool });
toolCmd('symbol', 'Symbol', 'symbol', [], 'Symbol platzieren: Nordpfeil oder Gefällepfeil.', [], () => new SymbolTool());

// ------------------------------------------------------------ Kontextbefehle (Register „Ändern | …“)
const sel1 = (cats: string[]): El | null => { const s = app.selected(); return s.length === 1 && cats.includes(s[0].cat) ? s[0] : null; };
registerCommand({ id: 'editSketch', label: 'Begrenzung bearbeiten', icon: 'editsketch', enabled: () => !!sel1(['region', 'cloud']), run: () => { const el = sel1(['region', 'cloud']); if (el) editSketch(el); } });
registerCommand({ id: 'textEdit', label: 'Text bearbeiten', icon: 'text', enabled: () => !!sel1(['text']), run: () => { const el = sel1(['text']); if (el) editTextEl(el as TextEl); } });
registerCommand({ id: 'textAddLeader', label: 'Führungslinie hinzufügen', icon: 'leaderadd', enabled: () => !!sel1(['text']), run: () => { const el = sel1(['text']); if (el) startTool(new AddLeaderTool(el.id), 'textAddLeader'); } });
registerCommand({ id: 'dimTextEdit', label: 'Bemaßungstext', icon: 'dimtext', enabled: () => !!sel1(['dimension']), run: () => { const el = sel1(['dimension']); if (el) dimTextDialog(el as Dim); } });
registerContextPanel({ cats: ['region', 'cloud'], panel: 'Modus', items: ['editSketch'] });
registerContextPanel({ cats: ['text'], panel: 'Text', items: ['textEdit', 'textAddLeader'] });
registerContextPanel({ cats: ['dimension'], panel: 'Bemaßung', items: ['dimTextEdit'] });

// „Ähnliches erstellen“
for (const [cat, id] of [['dimension', 'dimAligned'], ['text', 'text'], ['tag', 'tagByCat'], ['roomtag', 'roomTag'], ['region', 'filledRegion'], ['insulation', 'insulation'], ['detail', 'detailComponent'], ['cloud', 'revisionCloud'], ['spot', 'spotElevation'], ['symbol', 'symbol']] as [string, string][]) registerSimilar(cat, id);

// ------------------------------------------------------------ Doppelklick
onHook('dblclick', (el: El, e: ToolEvent) => {
  switch (el.cat) {
    case 'text': editTextEl(el as TextEl, e?.vp); break;
    case 'dimension': dimTextDialog(el as Dim); break;
    case 'region': case 'cloud': editSketch(el); break;
    case 'tag': case 'roomtag': editTagValue(el as Tag); break;
  }
});

// ------------------------------------------------------------ Projektinformationen: Landesvorlage, Höhenbezug
registerProjectInfoField({
  key: 'locale', label: 'Landesvorlage', options: [['DE', 'Deutschland (DIN)'], ['CH', 'Schweiz (SIA)']],
  get: (pi) => pi.locale ?? 'DE', set: (pi, v) => { pi.locale = v === 'CH' ? 'CH' : 'DE'; },
});
registerProjectInfoField({
  key: 'elev00', label: 'Höhenbezug ±0.00 = … m ü. M.', placeholder: 'z. B. 452.30',
  get: (pi) => (pi.elev00 === undefined ? '' : String(pi.elev00)),
  set: (pi, v) => { const n = v.trim() ? parseNum(v) : null; pi.elev00 = n === null ? undefined : n; },
});
// Landesvorlage geändert → Typen ergänzen und vorhandene Standard-Bemaßungen/-Koten umstellen
onHook('projectInfo', (doc: Doc, before: ProjectInfo) => {
  const loc: Locale = projectInfo(doc)?.locale === 'CH' ? 'CH' : 'DE';
  if ((before?.locale ?? 'DE') === loc) return;
  const r = applyLocale(doc, loc, { retype: true });
  if (typeof document !== 'undefined') toast(`Landesvorlage ${loc === 'CH' ? 'Schweiz' : 'Deutschland'}: ${r.dims} Bemaßungen und ${r.spots} Koten umgestellt.`);
});

export { applyLocale } from './locale';
