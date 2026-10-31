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
- IFC-Teilmodell: `--ifc-disc struct` (Fachbereiche `arch`, `struct`, `mep`, `site`, kommagetrennt), `--ifc-cats wall,floor`,
  `--ifc-exclude room,component`.
- Weitere PDF-Schrift einbetten: `--font "Arial Narrow=ArialNarrow.ttf[,ArialNarrowBold.ttf]"`.

## Funktionen (`src/api.ts`)

| Funktion | Zweck |
|---|---|
| `createProject(info?)` | neues Projekt aus der Vorlage (Ebenen EG/OG, Ansichten, Typen, Materialien) |
| `loadProject(text \| objekt)`, `saveProject()` | `.oriss` laden/als Text liefern (auch `window.openriss.loadProject/saveProject`) |
| `transaction(name, fn)` | mehrere Änderungen als ein Rückgängig-Schritt |
| `add(el, { replace? })` | beliebiges Element prüfen und hinzufügen (ID und Standardtyp werden ergänzt), wirft `ApiError`. Gibt es die ID schon (z. B. Vorlagenmaterial `m_xps500`), werden Materialien/Typen **zusammengeführt** (Vorlagenwerte wie Druckkennwerte bleiben), andere Elemente ersetzt – jeweils mit Warnung in `warnings` und auf der Konsole; `replace: true` ersetzt vollständig |
| `validate(els, doc)`, `importJson(daten, { replace?, dryRun? })` | Elementlisten prüfen/importieren |
| `addLevel`, `addGrid`, `addWall`, `addDoor`, `addWindow`, `addWallOpening`, `addFloor`, `addRoof`, `addColumn`, `addBeam`, `addStair`, `addRoom`, `addRebar` | Erzeuger mit sinnvollen Vorgaben |
| `syncStairBearings(id?)` | Treppenlager (`stairBearing`) nach Änderung der Lagerfelder einer bzw. aller Treppen nachführen |
| `addRebarTag(rebarId, viewId, off?)`, `tagOnPlace(ids, viewId)` | Beschriftungen |
| `addPlanView`, `addSection`, `addSheet`, `placeView(sheetId, viewId, center, detail?, { segFrom?, segCount?, scaleBar? })`, `addSchedule` | Ansichten, Pläne, Listen (bei umbrochenen Listen: gezeigte Abschnitte; `scaleBar`: Massstabsleiste im Titel) |
| `addRamp({ a, b, levelId, offset?, endLevelId?, endOffset?, width?, maxPct?, transPct?, transLen?, typeId?, walls?, wallTypeId?, wallTop? })` | Rampe als eine geneigte Platte mit Übergängen und Trogwänden (Vorgabe 6.00 m, max. 15 %, Übergänge 8 % auf 3 m); liefert `{ floor, walls, main }` |
| `splitView(viewId, { n, dir?, overlap?, box?, margin?, matchLines?, names? })`, `addDependentView(parentId, { name?, crop? })` | Grossformat: Grundriss in abhängige Teilpläne teilen (mit Anschlusslinien) bzw. einzelne abhängige Ansicht |
| `addMatchLine(viewId, a, b, views?)`, `addKeyPlan(sheetId, { refId?, p?, size?, title? })` | Anschlusslinie, Schlüsselplan |
| `fitElevations()` | Gebäudeansichten an das Modell anpassen |
| `applyLocale('CH', { retype?, elev00? })` | Landesvorlage Schweiz: Masstexte «1.82⁵», Koten «OK +2.75», Schweizer Plankopf, Dezimalpunkt, `elev00` = ±0.00 in m ü. M. |
| `addRevision(sheetId, { text, by?, date?, index? })` | Revision im Plankopf (Index wird fortgezählt) |
| `exportSvg(viewId)`, `exportDxf(viewId)`, `exportPdf(ids?)` | Ausgabe |
| `exportIfc(name?, { disciplines?, cats?, excludeCats? })` bzw. `exportIfc({ … })` | IFC4, optional als Teilmodell (z. B. `{ disciplines: ['struct'] }`): Fachbereich je Kategorie; Wände und Decken gehören zum Tragwerk, wenn `structural` gesetzt ist oder der Kern aus Beton besteht; Türen/Fenster folgen ihrer Wand |
| `addLineStyle({ name?, color, pen, dash? })` | Linienstil als Projekttyp anlegen bzw. vorhandenen gleichen liefern |
| `registerPdfFont(familie, ttf, fettTtf?)` | weitere TrueType-Schrift im PDF einbetten (sonst Liberation Sans mit Breitenfaktor) |
| `addFixture`, `addRunChain`, `addRiser`, `addCircuit`, `applySlope`, `tagRuns`, `createMepPlans`, `createRunSchedules`, `createSchemaView`, `addSchemaSym`, `addSchemaLine`, `autoHeatingSchema`, `applyPenetrations` | Gebäudetechnik (erstes Argument `doc`); öffnen selbst eine Transaktion, wenn keine offen ist |
| `numberCircuits(doc, levelId?)`, `createHeatingTable(doc, verteilerId?)` | Heizkreise je Verteiler nummerieren, Heizkreistabelle je Verteiler |
| `addEarthing(doc, plattenId, { edge?, mesh? })` | Fundamenterder als Ring (Randabstand `edge`, 300) mit Maschen ≤ `mesh` (20 m) |
| `warnings` | Liste der Warnungen der API (z. B. zusammengeführte Vorlagen-IDs) |
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
Türarten `kind`: `single`, `double`, `sliding`, `opening` (Durchgang), `roll` (Rolltor: Wickelkasten gestrichelt, Lamellen
in der Ansicht), `sectional` (Sektionaltor: Laufschienen und geöffnetes Torblatt gestrichelt, Paneele), `lift`
(Teleskop-Lifttür). Vorlagentypen `dt_rolltor` (4500 × 2400), `dt_sektional`, `dt_lift`. Im IFC wird `OperationType`
gesetzt (`SINGLE_SWING_LEFT/RIGHT`, `DOUBLE_DOOR_SINGLE_SWING`, `SLIDING_TO_LEFT/RIGHT`, `ROLLINGUP`, Sektionaltor
`USERDEFINED` «SECTIONAL»).

### Lift `elevator`
`p` (Kabinenmitte), `rot` (Tür auf der lokalen −y-Seite), `levelId` (unterste) und `topLevelId` (oberste Haltestelle),
`cabW`, `cabD`, `cabH` (1100 × 1400 × 2200), `doorW` (900), `cw` (Gegengewicht `left`, `right`, `back`, `none`), `load` (kg),
`persons`, `label` (leer = «Lift 630 kg / 8 P.»). Grundriss auf allen Haltestellen, 3D-Kabine, Liste, IFC
`IfcTransportElement .ELEVATOR.` mit `Pset_TransportElementCommon`/`…Elevator` und `CH_Lift`.
Wandöffnung `opening`: `width`, `height`, `sill` (rechteckig) – runde Kernbohrungen siehe Modul „Einlagen“.

### Geschossdecke `floor`, Decke `ceiling`, Dach `roof`
`loops: V2[][]` (erster Umriss außen, weitere = Aussparungen), `levelId`, `offset` (Oberkante bei Decken, Unterseite bei `ceiling`).
Dach: `baseOffset` (Traufe), `edges: { slope, angle }[][]` je Umrisskante (Neigung in Grad).
Typen mit `layers` (oben → unten).

**Gefälle / Rampe** (`floor` und `foundationSlab`): `slope: { a: V2, dir: V2, prof: { s, dz }[] }` – Oberkante = Ebene +
`offset` + stückweise linear `dz` über der Station `s` (mm ab `a` in Richtung `dir`); 2 Punkte = Gefällepfeil, mehr Punkte =
Knickstellen (Übergänge). Kurzform `{ a, b, pct }` (fällt von `a` nach `b` um `pct` %). Die Stärke wird lotrecht gemessen
(Volumen = Grundfläche × Stärke); Listenfelder `slopedArea` (geneigte Fläche), `slope`, `slopeMax`. `ramp: true` → IFC
`IfcRamp .STRAIGHT_RUN_RAMP.` (sonst `IfcSlab` als Brep mit Pset `CH_Gefaelle`). Im Grundriss: Schnitt der geneigten Platte
und Gefällepfeile «15 %» je Abschnitt.

**Wand auf geneigter Platte:** `attachBaseId` (Decke/Fundamentplatte), `attachBaseTo` (`'top'` Standard, `'bottom'`),
`attachBaseMode` (`'min'` Standard: tiefster Punkt über die Wanddicke, die Wand greift in die Platte; `'max'`: höchster
Punkt). `attachTopId` folgt auch einer geneigten Unterseite. Türen auf geneigter Unterkante: Schwelle = höchste
Wandunterkante im Türbereich + `sill`. Geländer `railing` mit `hostId` auf einer Decke folgen deren Oberfläche.

### Fundamente
`foundationIsolated`: `p`, `rot`, `levelId`, `offset` (Oberkante) · `foundationWall`: `hostId` (Wand), `ecc` ·
`foundationSlab`: `loops`, `levelId`, `offset`, Typ mit `t`, `mat`.

### Stütze `column`, Träger `beam`
Stütze: `p`, `rot`, `levelId`, `baseOffset`, `topLevelId`, `topOffset`, `height`.
Träger: `a`, `b`, `levelId`, `offA`, `offB`, `zJust` (`top`), `yOff`.

### Treppe `stair`
`p0` (Antritt Mitte), `dir` (Laufrichtung), `levelId`, `baseOffset`, `topLevelId`, `topOffset`, `height`,
`shape` (`straight`, `L`, `U`), `turn` (±1), `width`, `maxRiser`, `tread`, `landing`, `gap`, `risers` (0 = automatisch), `split`.

**Trittschall / Lager** (nur Massivtreppen; ohne Angabe monolithisch):

| Feld | Werte | Bedeutung |
|---|---|---|
| `jBot` | `mono`, `pad` | Antritt auf Decke/Bodenplatte: Schalldämmlager (Elastomer) unter dem Lauf |
| `jTop` | `mono`, `z`, `dowel` | Austritt an der Decke: Z-Lager (Konsole + Elastomer-Z-Profil) oder Querkraftdorne mit Fugenplatte; die Decke wird über die Laufbreite ausgeklinkt |
| `jLand` | `mono`, `z`, `dowel` | Lauf – Podest (beide Laufenden); das Podest wird ausgespart |
| `jLandWall` | `mono`, `console`, `dowel` | Podest – Wand: Wandkonsole mit Elastomerlager oder Querkraftdorne |
| `wallPlate` | `true` | Fugenplatten zwischen Lauf/Podest und angrenzenden Wänden (Lauf wird um die Fuge schmaler) |
| `jGap`, `padT`, `consoleC` | mm | Fugenbreite (10), Lagerdicke (15), Konsolentiefe (120) |
| `dowelN`, `dowelDia` | Stk., mm | Querkraftdorne je Fuge (2), Durchmesser (20) |
| `prodZ`, `prodPad`, `prodDowel`, `prodPlate` | Text | Produktnamen für Beschriftung, Liste und IFC |

Beim Z-Lager greift das Laufende um die Konsolentiefe in Podest bzw. Decke (Stufe auf deren Höhe), dahinter folgen
Elastomer-Z-Profil und Konsole in halber Auflagerdicke. Die Lagerteile sind eigene Elemente `stairBearing`
(`hostId` = Treppe, `key`, `kind` = `zBearing`, `pad`, `dowel`, `plate`, optional `product`): Grundriss gestrichelt,
Schnitt und 3D, Bauteilliste (Art, Produkt, Lage, Anzahl, Länge, Dicke), Beschriftung, IFC als
`IfcDiscreteAccessory` (Lager), `IfcMechanicalFastener .DOWEL.` und `IfcCovering .INSULATION.` (Fugenplatten) mit
Pset `CH_Treppenlager`. `addStair` legt sie an; nach `update` der Lagerfelder `syncStairBearings(id?)` aufrufen
(die CLI gleicht vor dem Export ab, in der Oberfläche geschieht es beim Ändern der Eigenschaft bzw. mit
«Lager aktualisieren»).

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

### Linien, Linienstile, Texte, Symbole
- Detail-/Modelllinie `line`: `a`, `b`, `arc?`, `style`; Bereich `region`: `loops`, `typeId`, `lineStyle`.
- `style`/`lineStyle` ist ein eingebauter Schlüssel (`thin`, `medium`, `wide`, `extrawide`, `hidden`, `dash`, `center`, `dot`,
  `overhead`, `red`, `blue`, `green`, `invisible`) oder die ID eines **Linienstil-Typs**
  `{ cat:'type', of:'lineStyle', name, color, pen (1–16), dash ('solid'|'dash'|'hidden'|'dot'|'center'|'dashdot'|'longdash') }`.
  Die Vorlage legt die eingebauten Stile als `ls_<Schlüssel>` an (ein geänderter Typ wirkt auf alle Linien mit dem Schlüssel)
  sowie Fachstile `ls_e_haar`, `ls_e_fein`, `ls_e_duenn`, `ls_e_mittel`, `ls_e_strich` (Elektro, magenta), `ls_sw_duenn`,
  `ls_sw_mittel`, `ls_sw_breit`, `ls_sw_strich` (Abwasser, braun), `ls_kt_duenn`, `ls_kt_mittel`, `ls_kt_strich` (Kältemittel).
  Dialog *Verwalten → Linienstile*. DXF: je Linienstil ein Layer «Linien-<Name>» mit Layerfarbe (ACI und True Color),
  Linientyp und Linienstärke; die Elemente stehen auf VONLAYER.
- Texttypen (auch Bemaßungs-, Koten- und Beschriftungstypen): `widthFactor` (Breitenfaktor, z. B. 0.8); Schriften mit
  «Narrow» im Namen erhalten automatisch 0.82. Wirkt auf Bildschirm, SVG, PDF (horizontale Skalierung bzw. eigene
  Schrift über `registerPdfFont`) und DXF (TEXT Gruppe 41, MTEXT `\W`).
- Symbol `symbol` mit `kind: 'scalebar'` (Massstabsleiste): `p` (linkes Ende), `rot`, `length` (Modell-mm; leer = automatisch
  ≈ 50 mm Papier, gerundet auf 1-2-5), `div` (Felder), `sub` (Unterteilung erstes Feld, 2), `height` (Papier-mm), `unit`
  (`m`/`cm`), `showScale` («M 1:100»). In einer Ansicht platziert, stimmt sie auch im Ansichtsfenster auf dem Plan.

### Gebäudetechnik: Beschriftung, Heizkreise, Fundamenterder
- Beschriftungsformate mit Platzhaltern: je Element `tagFmt`, je Projekt `project.tagFormats[cat]`. Abschnitte zwischen
  « · », « / », «, » entfallen, wenn ihre Platzhalter leer sind.
  Leitungen (`pipe`, `duct`, `conduit`): `{sys} {system} {size} {slope} {len} {type} {werkstoff} {offset}`, Vorgabe
  `{sys} {size} {slope}` (z. B. «SW DN 110 2 %»). Heizkreis `fbh`: `{name} {room} {va} {len} {area} {power} {flow} {manifold}`,
  Vorgabe `{name} · VA {va} cm · {len} m · {power} W`.
- Heizkreis `fbh`: zusätzlich `dT` (Spreizung K, 5) → Volumenstrom l/h; Listenfelder `flow`, `manifoldId`.
- Fundamenterder `earthing`: `levelId`, `hostId` (Fundamentplatte; Lage = Unterseite + `cover` 50 mm), sonst `offset`
  über Ebene, `paths: V2[][]` (Ringe mit Anfangs- = Endpunkt), `werkstoff` (V4A), `dia` (10), `lugs: { p, label?, h? }[]`
  (Anschlussfahnen). IFC `IfcCableSegment .CONDUCTORSEGMENT.` (Fachbereich `mep`).

### Arbeitsfugen im IFC
`joint` wird als `IfcBuildingElementProxy` (USERDEFINED) mit einer 20 mm dünnen Scheibe in der Fugenebene exportiert,
Pset `CH_Arbeitsfuge` (Art, Lage, Koordinaten, Bauteil, Länge, Fläche, Etappe A/B, Fugenblech, Produkt, ID) und
`IfcRelConnectsElements` zum Fugenblech.

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
`viewId` (Plan), `refId` (platzierte Ansicht), `center` (Papier-mm), `anchor` (Ansichtspunkt in der Mitte), `detail`,
`showTitle`, `scaleBar` (grafische Massstabsleiste neben dem Titel). Bei umbrochenen Listen `segFrom` (0-basiert) und
`segCount` (Anzahl oder `'rest'`), damit dieselbe Liste auf weiteren Plänen fortgesetzt wird.
`placeView` berechnet `anchor` aus dem Zuschnitt bzw. der Ausdehnung der Ansicht.

### Grossformat-Pläne: abhängige Ansichten, Anschlusslinien, Schlüsselplan
- Abhängige Ansicht (Grundriss/Deckenplan): `parentId` (Hauptansicht) und `hostId` (= Hauptansicht, Löschen kaskadiert).
  Eigen sind `name`, `crop`, `titleOnSheet`, `data.marker`; alle übrigen Eigenschaften werden beim Schreiben
  synchronisiert (Änderung an einem Teil wirkt auf die Hauptansicht und alle Teile). Beschriftungen der Hauptansicht
  erscheinen in den Teilen (auf den Zuschnitt beschnitten); neue Beschriftungen in einem Teil gehören der Hauptansicht.
- `depFrames` (Ansicht): Rahmen der Teilpläne mit Plannummer zeigen (Übersichtsplan, z. B. Duplikat im Massstab 1:500).
- Anschlusslinie `matchline`: `viewId`, `a`, `b`, `views?: [links, rechts]`, `prefix?` – Text «ANSCHLUSS PLAN A-102.2» aus
  der Platzierung der angrenzenden Teile.
- Schlüsselplan `keyplan` (auf einem Plan): `viewId` (Plan), `refId?` (Hauptansicht), `p` (unten links, Papier-mm), `size`,
  `title?` – Gebäudeumriss mit Teilbereichen, der Teil auf diesem Plan schraffiert.

### Bauteilliste `view` mit `kind:'schedule'`
`data: { cat, fields: string[], sort: { key, desc? }[], filters: { key, op, value }[], totals, itemize, sums, labels?, header?, footer? }`.
Feldschlüssel: `type`, `mark`, `comments`, `count`, `level` sowie die Felder der Kategorie (z. B. Wand `length`, `area`;
Bewehrung `pos`, `dia`, `shape`, `barLen`, `totalLen`, `weight`). `addSchedule({ name, cat })` erzeugt Standardfelder.
**Umbruch langer Listen** (auch Eisenliste): `data.split: { maxH (Tabellenhöhe je Abschnitt, mm), cols? (Abschnitte
nebeneinander), gap?, subtotal? }` – Kopfzeile je Abschnitt, «Übertrag» am Ende und Anfang mit laufenden Summen,
optional Zwischentotal, Gesamttotal am Schluss (Eisenliste: Übertrag in kg und Positionen, Zusammenfassung je Ø am Schluss).

## Projekt aus JSON (Oberfläche)

*Einfügen → Projekt aus JSON* liest eine Elementliste (`[…]`, `{ elements: […] }` oder Abschnitte wie
`{ walls: […], openings: […], slabs: […] }`), prüft alle Elemente und importiert sie nur, wenn keine Fehler vorliegen.
Eine vollständige `.oriss`-Datei kann das aktuelle Projekt ersetzen.
