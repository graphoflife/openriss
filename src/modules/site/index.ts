// Modul: site – Gelände und Baugrube. Geländeoberfläche (TIN aus Messpunkten/Höhenlinien, Erdkörper, Höhenlinien,
// Geländelinie in Schnitten/Ansichten), Aushub/Baugrube (Sohle, Arbeitsraum, Böschungen 1:n, Bermen, Verbau; exakte
// Volumen Aushub/Hinterfüllung), IFC im Grundstück (IfcGeographicElement TERRAIN bzw. «Aushub»).
import { app } from '../../app';
import type { Doc, El } from '../../core/doc';
import { registerCommand, registerPanel, registerContextPanel, onHook } from '../../core/registry';
import { registerIcon, ICONS } from '../../ui/icons';
import { registerSimilar } from '../../ui/commands';
import { addObjStyle, addMissing } from '../embeds/common';
import './topo';
import './excavation';
import { startTopoPoints, importTopoDialog, startExcavation, editExcavation, excVolumesDialog } from './tools';

export { excavationVolumes, slopeText } from './excavation';
export type { ExcVolumes } from './excavation';
export { fmtHeight, topoInfo } from './topo';
export { parsePoints, pointsFromCad, applyPoints } from './tools';
export { siteGeom, excSite, siteZ, terrainZ, earthSolid, cutSolid, buildingVolume, domainOf, topoOf, excsOf } from './site';
export type { Topo, SiteGeom } from './site';
export type { Excavation, ExcEdge, Berm, BottomProfile } from './pit';
export { buildTin, tinZ } from './tin';

// ------------------------------------------------------------ Objektstile
addObjStyle('topo', 'Gelände', 1, 5, '#000000');
addObjStyle('excavation', 'Aushub / Baugrube', 2, 5, '#000000');

// ------------------------------------------------------------ Symbole
const I = (name: string, body: string) => { if (!ICONS[name]) registerIcon(name, body); };
const BR = '#8a7356', DK = '#5a4a36';
I('topopoints', `<path d="M2 18 L8 11 L13 14 L22 6" fill="none" stroke="${DK}" stroke-width="1.6"/><path d="M2 21 H22" stroke="${BR}"/><circle cx="8" cy="11" r="1.6" fill="${DK}"/><circle cx="13" cy="14" r="1.6" fill="${DK}"/><circle cx="22" cy="6" r="1.4" fill="${DK}"/>`);
I('topoimport', `<path d="M3 17 Q8 12 12 14 T21 10" fill="none" stroke="${DK}" stroke-width="1.6"/><path d="M3 21 Q9 17 13 19 T21 16" fill="none" stroke="${BR}"/><path d="M12 2 V9 M9 6 L12 9 L15 6" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
I('excavation', `<path d="M1 7 H6 L9 16 H15 L18 7 H23" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1 7 H6 L9 16 H15 L18 7 H23 V21 H1 Z" fill="${BR}" opacity=".35"/><path d="M6.5 9 L8 9 M7.2 11.5 L8.6 11.5 M15.4 11.5 L16.8 11.5 M16 9 L17.5 9" stroke="currentColor"/>`);
I('excedit', `<path d="M2 8 H7 L10 16 H14 L17 8 H22" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M14 3 L21 10 L18 13 L11 6 Z" fill="#fde3a7" stroke="currentColor"/>`);
I('excvolume', `<path d="M3 6 H7 L9 13 H15 L17 6 H21" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 17 H20 M4 20 H14" stroke="${DK}" stroke-width="1.4"/><text x="12" y="11" font-size="5" text-anchor="middle" fill="currentColor">m³</text>`);

// ------------------------------------------------------------ Befehle
registerCommand({ id: 'topoPoints', label: 'Gelände aus Punkten', icon: 'topopoints', tip: 'Geländepunkte im Grundriss klicken (Höhe in der Optionsleiste) – erzeugt eine Geländeoberfläche (TIN) oder ergänzt die gewählte', run: startTopoPoints });
registerCommand({ id: 'topoImport', label: 'Gelände importieren', icon: 'topoimport', tip: 'Punkte aus Text/CSV («x y z» oder «Nr E N H» in LV95, m ü. M.) bzw. Höhentexte eines CAD-Imports übernehmen', run: () => { void importTopoDialog(); } });
registerCommand({ id: 'excavation', label: 'Aushub', icon: 'excavation', tip: 'Baugrube skizzieren: Umriss der Sohle (oder Gebäudeumriss mit Arbeitsraum), Sohlenkote, Böschung 1:n, Verbau', run: startExcavation });
registerCommand({ id: 'excavationEdit', label: 'Umriss bearbeiten', icon: 'excedit', tip: 'Umriss der gewählten Baugrube neu skizzieren', enabled: () => app.selected().some((e) => e.cat === 'excavation'), run: editExcavation });
registerCommand({ id: 'excVolumes', label: 'Aushub- volumen', icon: 'excvolume', tip: 'Aushub, Hinterfüllung, Sohlen-, Böschungs- und Verbauflächen aller Baugruben', run: () => { void excVolumesDialog(); } });
registerSimilar('topo', 'topoPoints');
registerSimilar('excavation', 'excavation');

// ------------------------------------------------------------ Multifunktionsleiste
registerPanel('Grundstück', 'Gelände', ['topoPoints', 'topoImport'], 10);
registerPanel('Grundstück', 'Baugrube', ['excavation', 'excVolumes'], 20);
registerContextPanel({ cats: ['topo'], panel: 'Gelände', items: ['topoPoints', 'topoImport'] });
registerContextPanel({ cats: ['excavation'], panel: 'Baugrube', items: ['excavationEdit', 'excVolumes'] });

// ------------------------------------------------------------ Vorlage
export function siteTemplate(): El[] {
  return [
    { id: 'm_erde', cat: 'material', name: 'Erdreich', color: '#8a7356', cutPattern: 'earth', density: 1800 } as El,
    { id: 'm_hinterfuellung', cat: 'material', name: 'Hinterfüllung (Kies-Sand)', color: '#c9b98f', cutPattern: 'gravel', cutColor: '#5a4a36', density: 2000 } as El,
  ];
}
onHook('template', (doc: Doc) => addMissing(doc, siteTemplate()));
onHook('loaded', (doc: Doc) => {
  if (siteTemplate().every((e) => doc.get(e.id))) return;
  doc.transaction('Vorlage Gelände ergänzen', () => addMissing(doc, siteTemplate()));
  doc.clearHistory();
});
