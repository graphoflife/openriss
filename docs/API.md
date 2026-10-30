# OpenRiss – Skript-API und Kommandozeile

OpenRiss lässt sich ohne Browser als Bibliothek nutzen: Ein Skript baut ein Projekt auf, die CLI
speichert es als `.oriss` und exportiert Pläne (PDF, SVG, DXF) und das Modell (IFC).
Alle Längen in **Millimetern**, X = Ost, Y = Nord, Z = oben. Punkte: `{ x, y }` bzw. `{ x, y, z }`.

## Kommandozeile

```bash
npx openriss build skript.ts --out projekt.oriss --pdf plansatz.pdf --dxf dxf/ --svg svg/ --ifc modell.ifc -- arg1 arg2
npx openriss export projekt.oriss --pdf --dxf --ifc
npx openriss check elemente.json        # Elementliste prüfen (Fehler mit Element-ID und Feld, Exit-Code 2)
```

- `build` bündelt das Skript (TypeScript oder JavaScript) selbst, führt es aus und schreibt danach die
  gewünschten Dateien. Argumente nach `--` landen im Skript in `process.argv[2…]`.
- Im Skript wird die API mit `import { … } from 'openriss'` geladen; direkte Importe aus `src/…` funktionieren ebenfalls.
- Von außerhalb des Repos: `node "<Pfad>/Revit Klon/bin/openriss.mjs" build …` oder `npm link` im Repo.
- Gebäudeansichten, die noch an der Vorlagenposition liegen, werden am Ende automatisch um das Modell gelegt
  (`--fit-elevations` erzwingt das).

## Funktionen (`src/api.ts`)

| Funktion | Zweck |
|---|---|
| `createProject(info?)` | neues Projekt aus der Vorlage (Ebenen EG/OG, Ansichten, Typen, Materialien) |
| `loadProject(text \| objekt)`, `saveProject()` | `.oriss` laden/als Text liefern (auch `window.openriss.loadProject/saveProject`) |
| `transaction(name, fn)` | mehrere Änderungen als ein Rückgängig-Schritt |
| `add(el)` | beliebiges Element prüfen und hinzufügen (ID und Standardtyp werden ergänzt), wirft `ApiError` |
| `validate(els, doc)`, `importJson(daten, { replace?, dryRun? })` | Elementlisten prüfen/importieren |
| `addLevel`, `addGrid`, `addWall`, `addDoor`, `addWindow`, `addWallOpening`, `addFloor`, `addRoof`, `addColumn`, `addBeam`, `addStair`, `addRoom`, `addRebar` | Erzeuger mit sinnvollen Vorgaben |
| `addRebarTag(rebarId, viewId, off?)`, `tagOnPlace(ids, viewId)` | Beschriftungen |
| `addPlanView`, `addSection`, `addSheet`, `placeView(sheetId, viewId, center)`, `addSchedule` | Ansichten, Pläne, Listen |
| `fitElevations()` | Gebäudeansichten an das Modell anpassen |
| `applyLocale('CH', { retype?, elev00? })` | Landesvorlage Schweiz: Masstexte «1.82⁵», Koten «OK +2.75», Schweizer Plankopf, Dezimalpunkt, `elev00` = ±0.00 in m ü. M. |
| `addRevision(sheetId, { text, by?, date?, index? })` | Revision im Plankopf (Index wird fortgezählt) |
| `exportSvg(viewId)`, `exportDxf(viewId)`, `exportIfc()`, `exportPdf(ids?)` | Ausgabe |
| `doc`, `app`, `sheets()` | Zugriff auf Dokument/Pläne (`doc.all('wall')`, `doc.get(id)`, `doc.update(id, patch)` in Transaktion) |

Fehler bei `add`/`importJson` enthalten Element-ID, Kategorie, Feld und Meldung, z. B.
`door d1: hostId – verweist auf unbekanntes Element „w9“`.

## Elemente

Gemeinsame Felder: `id`, `cat`, `typeId` (Typ-Element `cat:'type', of:<cat>`), `levelId` (Ebene), `mark` (Kennzeichen),
`comments`, `phase` (`'existing' | 'demolished'`, leer = Neubau), `pinned`.

### Ebene `level`
`name`, `elev` (Höhe absolut), `story`. `addLevel` legt Grundriss und Deckenplan an.

### Wand `wall`
| Feld | Bedeutung |
|---|---|
| `a`, `b` | Basislinie (Start/Ende) |
| `levelId`, `baseOffset` | Basisabhängigkeit, Versatz unten |
| `topLevelId`, `topOffset` | obere Abhängigkeit (`null` = nicht verbunden → `height`) |
| `height` | nicht verbundene Höhe |
| `locLine` | `center`, `coreCenter`, `finishExt`, `finishInt`, `coreExt`, `coreInt` |
| `flip` | Außenseite rechts statt links (Standard: links der Zeichenrichtung → Außenwände im Uhrzeigersinn zeichnen) |
| `structural`, `roomBounding`, `noJoinA`, `noJoinB`, `attachTopId` (Dach/Decke, Wand oben fixieren) | |

Wandtyp (`of:'wall'`): `layers: { mat, t, fn, core?, wrap? }[]` von außen nach innen, `function`,
`wrapExterior` (Außenschichten über die Deckenstirn bis OK der oberen Ebene durchziehen; `wrap` je Schicht übersteuert).

### Öffnungen `door`, `window`, `opening`
`hostId` (Wand), `t` (Mitte entlang der Basislinie ab `a`), `sill` (Brüstung/Schwelle über Wandbasis),
`flipFacing`, `flipHand`. Tür-/Fenstertyp: `width`, `height`, `kind`, `frame`, `leafT` bzw. `frameDepth`, `sillDepth`, `sill`.
Wandöffnung `opening`: `width`, `height`, `sill` (rechteckig) – runde Kernbohrungen siehe Modul „Einlagen“.

### Geschossdecke `floor`, Decke `ceiling`, Dach `roof`
`loops: V2[][]` (erster Umriss außen, weitere = Aussparungen), `levelId`, `offset` (Oberkante bei Decken, Unterseite bei `ceiling`).
Dach: `baseOffset` (Traufe), `edges: { slope, angle }[][]` je Umrisskante (Neigung in Grad).
Typen mit `layers` (oben → unten).

### Fundamente
`foundationIsolated`: `p`, `rot`, `levelId`, `offset` (Oberkante) · `foundationWall`: `hostId` (Wand), `ecc` ·
`foundationSlab`: `loops`, `levelId`, `offset`, Typ mit `t`, `mat`.

### Stütze `column`, Träger `beam`
Stütze: `p`, `rot`, `levelId`, `baseOffset`, `topLevelId`, `topOffset`, `height`.
Träger: `a`, `b`, `levelId`, `offA`, `offB`, `zJust` (`top`), `yOff`.

### Treppe `stair`
`p0` (Antritt Mitte), `dir` (Laufrichtung), `levelId`, `baseOffset`, `topLevelId`, `topOffset`, `height`,
`shape` (`straight`, `L`, `U`), `turn` (±1), `width`, `maxRiser`, `tread`, `landing`, `gap`, `risers` (0 = automatisch), `split`.

### Raum `room`
`name`, `number`, `pt` (Raumpunkt), `levelId`, `baseOffset`, `topLevelId`, `topOffset`, `floorFinish`, `wallFinish`, `ceilingFinish`.
Fläche und Umriss werden aus raumbegrenzenden Wänden und Raumtrennungen (`roomsep`: `a`, `b`, `levelId`) berechnet.

### Bewehrung `rebar`
| Feld | Bedeutung |
|---|---|
| `hostId` | Bauteil (Wand, Decke, Stütze, Träger, Fundament, Treppe) |
| `pos` | Positionsnummer |
| `dia` | Durchmesser mm |
| `shape` | interne Biegeform `00` gerade, `11` Winkel, `21` U, `51` Bügel, `99` frei |
| `pts` | Schenkel-Polylinie des ersten Stabs (Welt, Stabachse) |
| `hookA`, `hookB`, `hookNA`, `hookNB` | Haken (Winkel °, Biegerichtung) |
| `dir`, `span` | Verlegerichtung und -länge |
| `layout` | `single`, `count`, `maxSpacing`, `numberSpacing` mit `count`, `spacing` |
| `display` | `first` (erster Stab + Verteilungslinie), `all`, `firstLast`, `middle` |
| `coverUsed` | verwendete Betondeckung |

Beschriftung `rebarTag`: `viewId`, `refId` (Bewehrung), `off`, `fmt`, `leader` – am einfachsten mit `addRebarTag`.

### Ansicht `view`
`kind`: `plan`, `ceiling`, `elevation`, `section`, `drafting`, `legend`, `3d`, `sheet`, `schedule`.
Gemeinsam: `name`, `scale`, `detail` (`coarse`/`medium`/`fine`), `hiddenCats`, `hiddenEls`, `crop: { on, show, min, max }`,
`phaseMode`, `discipline`.
Grundriss: `levelId`, `range: { top, cut, bottom, depth }` (relativ zur Ebene), `underlayLevelId`.
Schnitt: `lineA`, `lineB` (Blick nach links der Linie), `far`, `crop.min.y/max.y` (Höhen); am einfachsten `addSection`.
Ansicht: `origin`, `dir`, `far`.

### Plan `view` mit `kind:'sheet'`
`sheetNo`, `name`, `data: { size: 'A0'…'A4', portrait, drawnBy, checkedBy, date, index, … }`.

### Ansichtsfenster `viewport`
`viewId` (Plan), `refId` (platzierte Ansicht), `center` (Papier-mm), `anchor` (Ansichtspunkt in der Mitte), `detail`.
`placeView` berechnet `anchor` aus dem Zuschnitt bzw. der Ausdehnung der Ansicht.

### Bauteilliste `view` mit `kind:'schedule'`
`data: { cat, fields: string[], sort: { key, desc? }[], filters: { key, op, value }[], totals, itemize, sums, labels?, header?, footer? }`.
Feldschlüssel: `type`, `mark`, `comments`, `count`, `level` sowie die Felder der Kategorie (z. B. Wand `length`, `area`;
Bewehrung `pos`, `dia`, `shape`, `barLen`, `totalLen`, `weight`). `addSchedule({ name, cat })` erzeugt Standardfelder.

## Projekt aus JSON (Oberfläche)

*Einfügen → Projekt aus JSON* liest eine Elementliste (`[…]`, `{ elements: […] }` oder Abschnitte wie
`{ walls: […], openings: […], slabs: […] }`), prüft alle Elemente und importiert sie nur, wenn keine Fehler vorliegen.
Eine vollständige `.oriss`-Datei kann das aktuelle Projekt ersetzen.
