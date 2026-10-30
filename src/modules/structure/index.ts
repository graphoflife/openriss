// Modul: structure – Ingenieurbau: Tragwerksstützen, Träger, Fundamente, Stabbewehrung, Bügel,
// Flächen- und Mattenbewehrung, Bewehrungsbeschriftung, Betondeckung und Stahlliste.
import { app } from '../../app';
import type { Doc, El } from '../../core/doc';
import { registerCommand, registerContextPanel, onHook, allCats, CategoryDef } from '../../core/registry';
import { hostedBy } from '../../core/cache';
import { registerIcon, ICONS } from '../../ui/icons';
import { startTool, registerSimilar } from '../../ui/commands';
import { ColumnTool } from './column';
import { BeamTool } from './beam';
import { FoundIsoTool, FoundWallTool, startFoundationSlab } from './foundation';
import { RebarTool } from './rebar/tool';
import { RebarTagTool } from './rebar/tag';
import { startAreaRebar, startFabricArea, addFabricTypes, xfArea } from './rebar/area';
import { rebarCoverDialog } from './rebar/cover';
import { steelListDialog } from './schedule';
import { Rebar, xfRebar } from './rebar/rebar';
import { refit } from './rebar/build';
import { Xf3, xfOfView, xfTranslate } from './rebar/frame';
import { HOST_CATS, REBAR_CATS, addTemplateTypes } from './common';
import './ch';
import './rebar/filter';
import './rebar/layout';
import './development';
import './rebar/stair';

// ------------------------------------------------------------ Symbole
if (!ICONS.rebartag) registerIcon('rebartag', `<path d="M3 18 H11" stroke="#b03030" stroke-width="2.2"/><path d="M11 18 L15 9" stroke="currentColor"/><path d="M15 9 H22" stroke="currentColor"/><circle cx="18.5" cy="5.5" r="3.2" fill="#fff" stroke="currentColor"/><text x="18.5" y="7.4" font-size="5" text-anchor="middle" fill="currentColor">3</text>`);
if (!ICONS.rebarcover) registerIcon('rebarcover', `<rect x="3" y="3" width="18" height="18" fill="#dfe4e8" stroke="currentColor"/><rect x="7" y="7" width="10" height="10" fill="none" stroke="#b03030" stroke-width="1.8"/><path d="M3 12 H7" stroke="#2a6fd6" stroke-width="1.2"/><path d="M3 10.5 V13.5 M7 10.5 V13.5" stroke="#2a6fd6"/>`);
if (!ICONS.steellist) registerIcon('steellist', `<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="currentColor"/><path d="M3 8 H21 M3 13 H21 M3 18 H21 M8 3 V21" stroke="currentColor" stroke-width=".8"/><path d="M11 11 V6 H18" fill="none" stroke="#b03030" stroke-width="1.6"/><path d="M11 16 H18" stroke="#b03030" stroke-width="1.6"/>`);

// ------------------------------------------------------------ Befehle
const cmd = (id: string, label: string, icon: string, keys: string[], tip: string, run: () => void) => registerCommand({ id, label, icon, keys, tip, run });
cmd('column', 'Stütze', 'column', ['CL'], 'Tragwerksstütze platzieren (STB rechteckig/rund, Stahlprofil). Leertaste dreht um 90°, „Bei Rastern“ setzt Stützen an Rasterschnittpunkte.', () => startTool(new ColumnTool(), 'column'));
cmd('beam', 'Träger', 'beam', ['BM'], 'Träger zeichnen (Oberkante an der Platzierungsebene).', () => startTool(new BeamTool(), 'beam'));
cmd('foundationIsolated', 'Einzel- fundament', 'foundation', [], 'Einzelfundament platzieren – frei oder unter gewählten Stützen.', () => startTool(new FoundIsoTool(), 'foundationIsolated'));
cmd('foundationWall', 'Streifen- fundament', 'foundation', [], 'Streifenfundament (Wandfundament) unter Wänden erzeugen.', () => startTool(new FoundWallTool(), 'foundationWall'));
cmd('foundationSlab', 'Fundament- platte', 'floor', [], 'Fundament-/Bodenplatte skizzieren.', startFoundationSlab);
cmd('rebar', 'Stab- bewehrung', 'rebar', ['RB'], 'Stabbewehrung im Schnitt oder Grundriss: Biegeform wählen und in die Schnittfläche eines Betonbauteils klicken.', () => startTool(new RebarTool(), 'rebar'));
cmd('stirrup', 'Bügel', 'stirrup', [], 'Geschlossener Bügel (Form 51, Haken 135°) im Träger- oder Stützenquerschnitt.', () => startTool(new RebarTool('stirrup', 'Bügel', { kind: '51', dia: 10, layout: 'maxSpacing', spacing: 150 }), 'stirrup'));
cmd('areaRebar', 'Flächen- bewehrung', 'arearebar', [], 'Flächenbewehrung in Decken/Platten (Grundriss): Bereich skizzieren, Lagen unten/oben.', startAreaRebar);
cmd('fabricArea', 'Matten- bewehrung', 'fabric', [], 'Lagermatten (Q/R-Matten) verlegen: Bereich skizzieren → Mattenverlegeplan.', startFabricArea);
cmd('rebarCover', 'Beton- deckung', 'rebarcover', [], 'Betondeckung: Projektstandard und Werte je Bauteil.', rebarCoverDialog);
cmd('rebarSchedule', 'Stahlliste', 'steellist', [], 'Stahlliste / Biegeliste mit Biegeformen, Summen je Ø und Mattenliste.', steelListDialog);
cmd('rebarTag', 'Bewehrungs- beschriftung', 'rebartag', [], 'Bewehrung beschriften (Anzahl, Ø, Abstand, Positionsnummer).', () => startTool(new RebarTagTool(), 'rebarTag'));
registerCommand({
  id: 'rebarRefit', label: 'An Bauteil anpassen', icon: 'rebar', tip: 'Gewählte Bewehrung (oder alle Bewehrung gewählter Bauteile) neu in die Bauteile einpassen',
  enabled: () => app.selected().some((e) => e.cat === 'rebar' || HOST_CATS.includes(e.cat)),
  run: () => {
    const doc = app.doc; let n = 0;
    const set = new Map<string, Rebar>();
    for (const e of app.selected()) {
      if (e.cat === 'rebar') set.set(e.id, e as Rebar);
      else for (const h of hostedBy(doc, e.id)) if (h.cat === 'rebar') set.set(h.id, h as Rebar);
    }
    doc.transaction('Bewehrung anpassen', () => { for (const r of set.values()) { const p = refit(doc, r, {}); if (p.pts) { doc.update(r.id, p); n++; } } });
    app.status(n ? `${n} Bewehrungssatz/-sätze angepasst.` : 'Keine eingepasste Bewehrung gefunden (frei gezeichnete Stäbe bleiben unverändert).');
  },
});

registerContextPanel({ cats: HOST_CATS, panel: 'Bewehrung', items: ['rebar', 'stirrup', 'areaRebar', 'fabricArea', 'rebarCover', 'rebarRefit'] });
registerContextPanel({ cats: ['rebar', 'areaRebar', 'fabricArea'], panel: 'Bewehrung', items: ['rebarTag', 'rebarRefit', 'rebarSchedule'] });

for (const [c, id] of [['column', 'column'], ['beam', 'beam'], ['foundationIsolated', 'foundationIsolated'], ['foundationWall', 'foundationWall'], ['foundationSlab', 'foundationSlab'], ['rebar', 'rebar'], ['areaRebar', 'areaRebar'], ['fabricArea', 'fabricArea'], ['rebarTag', 'rebarTag']]) registerSimilar(c, id);

// ------------------------------------------------------------ Vorlage
onHook('template', (doc: Doc) => { addTemplateTypes(doc); addFabricTypes(doc); });

// ------------------------------------------------------------ Bewehrung folgt dem Host
/** Gehostete Bewehrung (auch in abgeleiteten Hosts, z. B. Streifenfundament einer Wand) mitbewegen */
function moveHosted(doc: Doc, host: El, X: Xf3, depth = 0): void {
  if (depth > 3) return;
  for (const h of hostedBy(doc, host.id)) {
    if (h.cat === 'rebar') doc.update(h.id, xfRebar(h as Rebar, X, true));
    else if (h.cat === 'areaRebar' || h.cat === 'fabricArea') doc.update(h.id, xfArea(h, X));
    else if (!h.viewId) moveHosted(doc, h, X, depth + 1);
  }
}
let wrapped = false;
function wrapHostCategories(): void {
  if (wrapped) return; wrapped = true;
  for (const def of allCats() as CategoryDef[]) {
    if (REBAR_CATS.includes(def.cat) || def.annotation || def.datum || def.cat === 'view' || def.cat === 'rebarTag') continue;
    const tf = def.transform, t3 = def.translate3d;
    if (tf) def.transform = (el, m, doc, view) => {
      const p = tf(el, m, doc, view);
      if (p) { const X = xfOfView(m, view); if (X) moveHosted(doc, el, X); }
      return p;
    };
    if (t3) def.translate3d = (el, d, doc) => {
      const p = t3(el, d, doc);
      if (p) moveHosted(doc, el, xfTranslate(d));
      return p;
    };
  }
}
onHook('started', wrapHostCategories);
