# OpenRiss – Architektur

OpenRiss ist eine reine Browser-Anwendung (TypeScript + Vite, keine Server-Komponente). Alle
Modellkoordinaten sind **Millimeter**; X = Ost, Y = Nord, Z = oben. Die Oberfläche ist deutsch.

## Verzeichnisse

```
src/
  app.ts                 Zentrale App: Dokument, Auswahl, aktives Werkzeug, geöffnete Ansichten
  main.ts                Start: lädt alle Module, baut Oberfläche
  core/
    geom.ts              Vektoren (V2/V3), Linien, Polygone, Mat2 (2D-Affin), Polygon-Boolesche Ops
    doc.ts               Doc: Elementtabelle, Transaktionen, Undo/Redo, Live-Transaktionen
    registry.ts          Registrierung: Kategorien, Befehle, Multifunktionsleiste, Hooks, Viewports
    view.ts              View/Level/TypeEl/Material/ProjectInfo + Hilfen (levels, typesOf …)
    units.ts             Formatieren/Parsen von Längen (deutsch, Dezimalkomma, Ausdrücke)
    cache.ts             Versionsgebundene Caches, hostedBy()
    template.ts          Projektvorlage (Materialien, Typen, Ebenen, Ansichten), Hook 'template'
  render/
    displayList.ts       Display-Liste (2D-Grundelemente je Ansicht) + Treffertest + Fangpunkte
    canvasPainter.ts     Display-Liste → Canvas
    svgPainter.ts        Display-Liste → SVG (Export/Druck)
    styles.ts            Stifte (Revit-Stiftnummern 1..16), Linienmuster, Füllmuster, Objektstile
  views/
    viewBuilder.ts       baut Display-Liste je Ansicht (Grundriss / Schnitt / Ansicht / Zeichnung)
    sectionEngine.ts     schneidet/projiziert 3D-Solids; Helfer prism/box3/extrudeProfile
    canvasView.ts        2D-Ansichtsfenster (Zoom, Pan, Overlay, Griffe, temporäre Maße)
  elements/              Kernkategorien: wall, openings (door/window), datums (level, grid, refplane, line, view-Symbole)
  tools/                 Werkzeuge (tool.ts Basis, drawTool.ts Linienzeichnen, selectTool, modifyTools, elementTools, snap, ops)
  ui/                    Oberfläche (shell, properties, browser, dialogs, keyboard, commands, icons, viewControlBar)
  io/file.ts             Speichern/Öffnen (.oriss JSON), Autosave (IndexedDB), download()
  modules/<name>/index.ts  Fachmodule – werden in main.ts importiert
```

## Dokument und Elemente

Alles ist ein **Element** (`El` in `core/doc.ts`): Modellelemente, Beschriftungen, Ansichten
(`cat: 'view'`), Typen (`cat: 'type'`, Feld `of` = Kategorie), Materialien (`cat: 'material'`),
Ebenen (`cat: 'level'`), Projektinformationen (`id: 'project'`). Elemente sind reine JSON-Objekte.

- Lesen: `doc.get(id)`, `doc.all('wall')`, `hostedBy(doc, hostId)` (core/cache.ts)
- Schreiben **nur in Transaktionen**: `doc.transaction('Name', () => { doc.add(el); doc.update(id, patch); doc.remove(id); })`
- `doc.remove` löscht abhängige Elemente mit (`hostId`, `viewId`, `refId` zeigen auf das gelöschte Element).
- Ansichtsspezifische Elemente (Beschriftung, Detaillinien) haben `viewId`; ihre Koordinaten sind
  **Ansichtskoordinaten** (Grundriss = Welt-XY; Schnitt/Ansicht: x entlang der Ansichtsebene, y = Höhe Z).
- Gehostete Elemente haben `hostId` (Tür → Wand, Bewehrung → Bauteil).
- IDs: `newId('xx')`.
- Abgeleitete Daten cachen mit `cached(doc, space, key, fn)` – wird bei jeder Doc-Version verworfen.

## Kategorien (`registerCategory`)

Siehe `CategoryDef` in `core/registry.ts`. Wichtigste Felder:

| Feld | Zweck |
|---|---|
| `cat, label, plural` | Schlüssel und deutsche Namen |
| `annotation` | ansichtsspezifisch; wird über `drawAnnotation(dl, el, doc, view)` gezeichnet |
| `hasTypes`, `typeProps` | Typenauswahl + Typeigenschaften (Typ-Elemente `cat:'type', of:<cat>`) |
| `drawPlan(ctx, el)` / `drawPlanBatch(ctx, els)` | symbolische Grundrissdarstellung (`ctx.cutZ`, `ctx.depthZ`, `ctx.detail` beachten). `planOrder` < 0 wird vor allgemeinen Körpern gezeichnet |
| `solids(el, doc)` | 3D-Körper (`Solid { faces: Face[], mat?, color?, role?, noCut? }`). Ohne `drawPlan` werden Solids im Grundriss automatisch geschnitten/projiziert. Schnitte/Ansichten/3D nutzen immer Solids |
| `drawSection(ctx, el)` | zusätzliche Symbolik in Schnitt/Ansicht (`SectionCtx` mit `toView`, `depth`, `dir`, `modelBox`) |
| `grips`, `dragGrip`, `clickGrip` | Griffe des ausgewählten Elements |
| `transform(el, m, doc, view)` | 2D-Transformation (Verschieben/Drehen/Spiegeln/Skalieren) in Ansichtskoordinaten → Patch |
| `translate3d(el, d, doc)` | Verschieben in Schnitt/Ansicht |
| `curve` / `setCurve` | Achse für Stutzen/Teilen/Versatz/Ausrichten |
| `tempDims` | temporäre Bemaßungen (Wert klicken → `apply(v)`) |
| `props(el, doc)` | Instanzeigenschaften (`PropDef`: key, label, group (GROUPS), type, get, set → Patch) |
| `scheduleFields()` | zusätzliche Felder für Bauteillisten |
| `tagText`, `tagPoint` | für Beschriftungen nach Kategorie |
| `hostOpening(el, doc)` | Öffnung in der Host-Wand (`u0,u1` entlang Wandachse, `z0,z1` absolut) |
| `visibleIn(el, doc, view)` | zusätzliche Sichtbarkeitsregel |

Hilfen für Körper: `prism(ring, z0, z1, holes)`, `box3(o, u, v, w)`, `extrudeProfile(...)` in `views/sectionEngine.ts`.
Schnittpolygone eines Elements in einer Ansicht: `cutPolysOfElement(doc, el, projector)`.

## Display-Liste (`render/displayList.ts`)

Jede 2D-Ansicht wird in Grundelemente übersetzt (`line`, `poly`, `fill`, `arc`, `circle`, `text`, `clip`).
Geometrie in Ansichts-mm; **Linienstärken (`Pen.w` = Revit-Stiftnummer 1..16) und Textgrößen (`Font.size`)
in Papier-mm** – Symbolgrößen deshalb mit `dl.scale` (Ansichtsmaßstab) multiplizieren (z. B. Radius `4 * view.scale`).
`dl.begin(el.id)` setzt den Eigentümer für Auswahl/Fang. Optionen pro Grundelement: `ns` (kein Fang),
`sel` (nur bei Auswahl sichtbar), `inv` (unsichtbar, nur Fang/Treffer), `sub` (Unterreferenz).
Füllmuster: `PATTERNS` in `render/styles.ts` (z. B. `rc` Stahlbeton, `concrete`, `diag`, `insulation`).

## Werkzeuge (`tools/tool.ts`)

`Tool` mit `down/move/up/dbl/key/escape/enter/space/preview/options/basePoint/typedLength`.
`ToolEvent.p` ist bereits gefangen (Objektfang), `e.raw` ungefangen, `e.vp` das Ansichtsfenster
(`vp.hit(p)`, `vp.displayList()`, `vp.toScreen()`), `e.view` die Ansicht.
- Linienartige Werkzeuge: von `LineDrawTool` (tools/drawTool.ts) ableiten und `createSegment(a, b, arc?)` implementieren
  (Modi Linie/Rechteck/Linien wählen/Bogen/Kreis, Kette, Versatz, Längeneingabe gratis).
- `placement` (siehe `placementFor(cat, defaults)` in tools/elementTools.ts) zeigt Typenauswahl und Parameter in der Palette.
- `kinds` beschränkt die Ansichtsarten. Vorschau in `preview(dl, vp)` mit `PREVIEW`-Stift.
- Live-Vorschau beim Ziehen: `doc.beginLive(name)`, `doc.liveUpdate(fn)`, `doc.commitLive()`/`cancelLive()`.
- Starten: `startTool(new MyTool(), 'cmdId')` aus `ui/commands.ts`.

## Befehle und Multifunktionsleiste

`registerCommand({ id, label, icon, keys: ['WA'], tip, run, enabled?, checked? })` – Kürzel wie Revit.
Die Panels sind in `ui/commands.ts` vorbelegt und referenzieren Befehls-IDs. Ein Modul muss nur den
Befehl mit der vereinbarten ID registrieren; nicht registrierte IDs werden ausgeblendet. Weitere Panels:
`registerPanel(tab, panel, items, order)`. Kontextpanels (Register „Ändern | …“ bei Auswahl):
`registerContextPanel({ cats, panel, items })`. Symbole: `registerIcon(name, svgBody)` (ui/icons.ts, 24×24).

## Hooks (`onHook` / `emitHook`)

| Hook | Argumente | Zweck |
|---|---|---|
| `template` | doc | Typen/Materialien beim Anlegen eines Projekts ergänzen (läuft in Transaktion) |
| `loaded` | doc | nach Laden/Neu |
| `tagOnPlace` | el, view | Beschriftung bei Platzierung (Tür/Fenster/Raum) |
| `dblclick` | el, event | Doppelklick auf Element (z. B. Text bearbeiten) |
| `canvasDrop` | vp, dataTransfer, p | Drop auf Ansichtsfenster (Ansicht auf Plan ziehen) |
| `contextmenu` | vp, MouseEvent | Rechtsklick im Zeichenbereich |
| `newSheet` | – | Projektbrowser „Neuer Plan…“ |
| `createInstanceOfType` | type | Projektbrowser „Instanz erstellen“ |
| `editWallLayers` | type | Wandschichten-Dialog |
| `beforePaint` | vp, ctx | vor dem Zeichnen (z. B. Bildunterlage) |

Weitere Erweiterungspunkte: `registerViewport({ kinds, create })` (eigene Ansichtsarten, z. B. 3D/Bauteilliste),
`registerDLBuilder(kind, fn)` (Display-Liste für z. B. Pläne), `registerBrowserSection(...)`,
`registerWallTopProvider(fn)` (Wand oben an Dach fixieren).

## Fachmodule (`src/modules/`)

| Modul | Inhalt |
|---|---|
| `annotation` | Bemaßungen (ausgerichtet, linear, Winkel, Radius, Bogenlänge), Höhenkoten, Text, Beschriftungen, Raumstempel, Füllbereiche, Dämmung, Detailbauteile, Revisionswolken, Symbole |
| `architecture` | Geschossdecken, Decken, Dächer (inkl. Wände oben fixieren), Treppen, Geländer, Bauteile/Möbel, Räume, Raumtrennung, Wand-/Schacht-/Deckenöffnungen |
| `structure` | Stützen, Träger, Fundamente, Stabbewehrung, Bügel, Flächen- und Mattenbewehrung, Betondeckung, Stahlliste |
| `output` | Pläne mit Plankopf, Ansichtsfenster, Bauteillisten, Drucken/PDF, SVG/PNG/DXF-Export, DXF-Import, Bilder, Detailausschnitte |
| `view3d` | 3D-Ansicht (three.js), ViewCube, Schnittbereich, IFC4-, glTF- und OBJ-Export |
| `sample` | Beispielprojekt |

Module kommunizieren ausschließlich über die Registry, Hooks und gemeinsame Elementfelder.
