// Modul: embeds – Einlagen (Fugenblech, Rückbiegeanschluss, Schraubanschluss/Muffenstab, Durchstanzbewehrung,
// Ankerschiene, Futterrohr, Einlegerohre/-kasten), Arbeitsfugen und Betonieretappen, druckfeste Dämmzonen unter
// der Bodenplatte (Kennwerte, Legende, Pressungen), Fertigteil-Lichtschacht. Kernbohrungen: modules/architecture/opening.ts.
import { app } from '../../app';
import type { Doc, El } from '../../core/doc';
import { registerCommand, registerPanel, registerContextPanel, onHook } from '../../core/registry';
import { typesOf } from '../../core/view';
import { registerIcon, ICONS } from '../../ui/icons';
import { startTool, registerSimilar } from '../../ui/commands';
import { addObjStyle, addMissing } from './common';
import { addEmbedTemplate, familyOf, Family } from './embed';
import './joint';
import './stages';
import { addInsulTemplate } from './insulation';
import { lightwellTemplate } from './lightwell';
import { EmbedTool, PunchTool, SleeveTool } from './tools';
import { JointTool, startInsulZone, LightwellTool, LegendTool, importPressure, stageVolumesDialog, insulMaterialsDialog } from './placeTools';

// ------------------------------------------------------------ Objektstile
addObjStyle('embed', 'Einlagen', 2, 3);
addObjStyle('joint', 'Arbeitsfugen', 3, 3, '#d01c1c');
addObjStyle('insulZone', 'Dämmzonen', 1, 2);
addObjStyle('pressureMap', 'Pressungen', 1);

// ------------------------------------------------------------ Symbole
const I = (name: string, body: string) => { if (!ICONS[name]) registerIcon(name, body); };
const C = '#d01c1c', B = '#1f5fd6', O = '#f08c1a', V = '#7b3fbf', M = '#d020a0', G = '#a9a9a9';
I('waterstop', `<rect x="3" y="5" width="18" height="14" fill="${G}" stroke="currentColor"/><path d="M12 3 V21" stroke="${C}" stroke-width="2.4"/>`);
I('rebarbox', `<rect x="3" y="3" width="10" height="18" fill="${G}" stroke="currentColor"/><rect x="10" y="9" width="4" height="6" fill="#fde3e3" stroke="${C}"/><path d="M14 10 H21 M14 14 H21" stroke="${C}" stroke-dasharray="2 1"/>`);
I('coupler', `<rect x="3" y="3" width="10" height="18" fill="${G}" stroke="currentColor"/><path d="M4 8 H13 M4 16 H13" stroke="#8b1a1a" stroke-width="1.6"/><rect x="11" y="6.5" width="4" height="3" fill="${O}"/><rect x="11" y="14.5" width="4" height="3" fill="${O}"/><path d="M15 8 H22 M15 16 H22" stroke="#8b1a1a" stroke-dasharray="2 1"/>`);
I('punching', `<rect x="9" y="9" width="6" height="6" fill="${G}" stroke="currentColor"/><path d="M12 2 V8 M12 16 V22 M2 12 H8 M16 12 H22 M5 5 L9 9 M19 19 L15 15 M19 5 L15 9 M5 19 L9 15" stroke="${B}"/><circle cx="12" cy="4" r="1.2" fill="${C}"/><circle cx="12" cy="20" r="1.2" fill="${C}"/><circle cx="4" cy="12" r="1.2" fill="${C}"/><circle cx="20" cy="12" r="1.2" fill="${C}"/>`);
I('anchorchannel', `<rect x="3" y="3" width="9" height="18" fill="${G}" stroke="currentColor"/><rect x="10" y="6" width="3" height="12" fill="#efe5fb" stroke="${V}" stroke-width="1.4"/><path d="M13 9 H18 M13 15 H18" stroke="${V}"/>`);
I('sleeve', `<rect x="7" y="3" width="10" height="18" fill="${G}" stroke="currentColor"/><rect x="4" y="9" width="16" height="6" fill="#fff" stroke="#1f3f9f" stroke-width="1.4"/><path d="M12 6 V18" stroke="#1f3f9f" stroke-width="2"/>`);
I('conduit', `<path d="M3 18 H10 V6 H21" fill="none" stroke="${M}" stroke-width="1.8" stroke-dasharray="3 1.5"/><circle cx="21" cy="6" r="1.6" fill="${M}"/>`);
I('embedbox', `<rect x="4" y="6" width="16" height="12" fill="#fff" stroke="currentColor"/><path d="M4 6 L20 18 M20 6 L4 18" stroke="${M}"/>`);
I('joint', `<rect x="2" y="7" width="20" height="10" fill="${G}" stroke="currentColor"/><path d="M12 5 L10 8 L14 11 L10 14 L14 17 L12 19" fill="none" stroke="${C}" stroke-width="1.6"/>`);
I('stages', `<rect x="2" y="6" width="10" height="12" fill="#9ecae1" stroke="currentColor"/><rect x="12" y="6" width="10" height="12" fill="#a1d99b" stroke="currentColor"/><text x="7" y="15" font-size="7" text-anchor="middle" fill="currentColor">1</text><text x="17" y="15" font-size="7" text-anchor="middle" fill="currentColor">2</text>`);
I('stagevol', `<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="currentColor"/><path d="M3 9 H21 M3 15 H21 M10 3 V21" stroke="currentColor" stroke-width=".8"/><rect x="4" y="10" width="5" height="4" fill="#9ecae1"/><rect x="4" y="16" width="5" height="4" fill="#a1d99b"/>`);
I('insulzone', `<rect x="2" y="4" width="20" height="6" fill="${G}" stroke="currentColor"/><rect x="2" y="12" width="9" height="8" fill="#8fbbe8" stroke="currentColor"/><rect x="11" y="12" width="11" height="8" fill="#c4e0fa" stroke="currentColor"/>`);
I('insullegend', `<rect x="3" y="4" width="5" height="4" fill="#8fbbe8" stroke="currentColor"/><rect x="3" y="11" width="5" height="4" fill="#c4e0fa" stroke="currentColor"/><path d="M10 6 H21 M10 13 H21 M3 19 H21" stroke="currentColor"/>`);
I('pressure', `<path d="M3 20 H21" stroke="currentColor"/><path d="M5 6 V17 M9 9 V17 M13 11 V17 M17 8 V17" stroke="${C}" stroke-width="1.6"/><path d="M3.5 15.5 L5 17 L6.5 15.5 M7.5 15.5 L9 17 L10.5 15.5 M11.5 15.5 L13 17 L14.5 15.5 M15.5 15.5 L17 17 L18.5 15.5" fill="none" stroke="${C}"/>`);
I('insulmat', `<rect x="3" y="8" width="18" height="8" fill="#c4e0fa" stroke="currentColor"/><path d="M3 8 L7 16 L11 8 L15 16 L19 8" fill="none" stroke="#1d4f91"/><text x="12" y="6" font-size="5" text-anchor="middle" fill="currentColor">σc</text>`);
I('lightwell', `<rect x="2" y="3" width="5" height="18" fill="${G}" stroke="currentColor"/><path d="M7 6 H20 V20 H7" fill="#fff" stroke="currentColor" stroke-width="1.4"/><path d="M8 7 H19 M8 9 H19 M8 11 H19" stroke="#707070" stroke-width=".7"/><rect x="5.5" y="9" width="2" height="2" fill="${V}"/><rect x="5.5" y="16" width="2" height="2" fill="${V}"/>`);
I('coredrill', `<rect x="3" y="3" width="18" height="18" fill="${G}" stroke="currentColor"/><circle cx="12" cy="12" r="5" fill="#fff" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 16.5 L16.5 7.5" stroke="currentColor" stroke-width="1.2"/>`);

// ------------------------------------------------------------ Befehle
const famCmd: Record<Family, string> = { waterstop: 'embedWaterstop', rebarBox: 'embedRebarBox', coupler: 'embedCoupler', punching: 'embedPunching', anchorChannel: 'embedAnchor', sleeve: 'embedSleeve', conduit: 'embedConduit', box: 'embedBox' };
const lineCmd = (f: Family, label: string, icon: string, tip: string) => registerCommand({ id: famCmd[f], label, icon, tip, run: () => startTool(new EmbedTool(f, famCmd[f]), famCmd[f]) });
lineCmd('waterstop', 'Fugen- blech', 'waterstop', 'Fugenblech/Fugenband: stehend am Wandfuss (Höhe aus Wand), liegend in Plattenfugen oder senkrecht in Wandfugen');
lineCmd('rebarBox', 'Rückbiege- anschluss', 'rebarbox', 'Rückbiegeanschluss entlang einer Wand- oder Plattenfläche (Ø/s, Bügelhöhe, Länge, Produkt). Leertaste: Betonseite');
lineCmd('coupler', 'Schraub- anschluss', 'coupler', 'Schraubanschluss/Muffenstäbe als Reihe entlang einer Stirnfläche oder als Einzelstab (Muffendaten für ABS)');
lineCmd('anchorChannel', 'Anker- schiene', 'anchorchannel', 'Ankerschiene in einer Wand-/Plattenfläche (z.B. Befestigung Lichtschacht)');
lineCmd('conduit', 'Einlege- rohr', 'conduit', 'Einlegerohr in einer Decke: Elektro M20/M25, Lüftung Ø75 (Höhe = Plattenmitte)');
lineCmd('box', 'Einlege- kasten', 'embedbox', 'Verteilkasten/Deckendose (UK bündig Platte)');
registerCommand({ id: 'embedPunching', label: 'Durchstanz- bewehrung', icon: 'punching', tip: 'Durchstanzbewehrung (z.B. Doppelkopfanker auf Schienen) radial oder orthogonal um eine gewählte Stütze', run: () => startTool(new PunchTool(), 'embedPunching') });
registerCommand({ id: 'embedSleeve', label: 'Futter- rohr', icon: 'sleeve', tip: 'Futterrohr/Mantelrohr mit Dichtflansch in einer Wand (erzeugt die runde Wandöffnung)', run: () => startTool(new SleeveTool(), 'embedSleeve') });
registerCommand({ id: 'embedSimilar', label: 'Einlage', icon: 'waterstop', run: () => {
  const el = app.selected().find((e) => e.cat === 'embed'); const f = el ? familyOf(app.doc, el) : 'waterstop';
  const id = famCmd[f]; const c = f === 'punching' ? new PunchTool() : f === 'sleeve' ? new SleeveTool() : new EmbedTool(f, id);
  startTool(c, id);
} });
registerSimilar('embed', 'embedSimilar');

registerCommand({ id: 'joint', label: 'Arbeits- fuge', icon: 'joint', tip: 'Arbeitsfuge (Betonierfuge): senkrecht in Wänden, waagrecht am Wandfuss/-kopf oder in Platten, mit Etappen und optionalem Fugenblech', run: () => startTool(new JointTool(), 'joint') });
registerSimilar('joint', 'joint');
registerCommand({
  id: 'stageColors', label: 'Etappen einfärben', icon: 'stages', tip: 'Betonieretappen in der aktiven Ansicht farbig darstellen (Ansichtseigenschaft)',
  enabled: () => !!app.activeView(), checked: () => !!app.activeView()?.stageColors,
  run: () => { const v = app.activeView(); if (!v) return; app.doc.transaction('Etappen einfärben', () => app.doc.update(v.id, { stageColors: v.stageColors ? undefined : true })); app.refreshViews(); },
});
registerCommand({ id: 'stageVolumes', label: 'Etappen- volumen', icon: 'stagevol', tip: 'Betonvolumen je Etappe', run: () => { void stageVolumesDialog(); } });

registerCommand({ id: 'insulZone', label: 'Dämm- zone', icon: 'insulzone', tip: 'Zone druckfester Dämmung unter der Bodenplatte skizzieren (Produkt = Typ, Oberkante = UK Platte)', run: startInsulZone });
registerSimilar('insulZone', 'insulZone');
registerCommand({ id: 'insulLegend', label: 'Legende Dämmung', icon: 'insullegend', tip: 'Legende der Dämmzonen (Produkte, Kennwerte, Pressungsnachweis) in der Ansicht platzieren', run: () => startTool(new LegendTool(), 'insulLegend') });
registerCommand({ id: 'pressureImport', label: 'Pressungen laden', icon: 'pressure', tip: 'Bodenpressungen aus CSV (x;y;σ[;σd]) oder JSON (Punkte oder Raster) als Überlagerung anzeigen', run: importPressure });
registerCommand({ id: 'insulMaterials', label: 'Dämmstoff- Kennwerte', icon: 'insulmat', tip: 'Kennwerte druckfester Dämmstoffe: σ10, σc (2 %/50 J.), f_cd', run: () => { void insulMaterialsDialog(); } });

registerCommand({ id: 'lightwell', label: 'Licht- schacht', icon: 'lightwell', tip: 'Fertigteil-Lichtschacht an eine Wand setzen (Breite/Tiefe/Höhe, Gitterrost, Ankerschienen)', run: () => startTool(new LightwellTool(), 'lightwell') });
registerSimilar('lightwell', 'lightwell');

// ------------------------------------------------------------ Multifunktionsleiste
registerPanel('Ingenieurbau', 'Einlagen', ['embedWaterstop', 'embedRebarBox', 'embedCoupler', 'embedPunching', 'embedAnchor', 'embedSleeve', 'embedConduit', 'embedBox', 'coreDrill'], 35);
registerPanel('Ingenieurbau', 'Fugen / Etappen', ['joint', 'stageColors', 'stageVolumes'], 36);
registerPanel('Ingenieurbau', 'Dämmung', ['insulZone', 'insulLegend', 'pressureImport', 'insulMaterials'], 37);
registerPanel('Ingenieurbau', 'Fertigteile', ['lightwell'], 38);
registerContextPanel({ cats: ['column'], panel: 'Einlagen', items: ['embedPunching'] });
registerContextPanel({ cats: ['wall'], panel: 'Einlagen', items: ['joint', 'coreDrill', 'embedSleeve', 'lightwell'] });
registerContextPanel({ cats: ['floor', 'foundationSlab'], panel: 'Einlagen', items: ['joint', 'coreDrill', 'embedConduit', 'insulZone'] });

// ------------------------------------------------------------ Vorlage
export function addEmbedsTemplate(doc: Doc): void { addEmbedTemplate(doc); addInsulTemplate(doc); addMissing(doc, lightwellTemplate()); }
onHook('template', (doc: Doc) => addEmbedsTemplate(doc));
onHook('loaded', (doc: Doc) => {
  if (['embed', 'insulZone', 'lightwell'].every((c) => typesOf(doc, c).length)) return;
  doc.transaction('Vorlage Einlagen ergänzen', () => addEmbedsTemplate(doc));
  doc.clearHistory();
});

export type { El };
