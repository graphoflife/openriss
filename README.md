# OpenRiss – BIM-Zeichnen im Browser

**OpenRiss** ist ein freies, quelloffenes BIM-Zeichenprogramm, das komplett im Browser läuft – ohne
Installation, ohne Server, ohne Konto. Bedienung, Begriffe und Tastenkürzel orientieren sich an
Autodesk Revit, damit der Umstieg leichtfällt: Wer `WA` tippt, zeichnet eine Wand, `DR` setzt eine
Tür, `DI` bemaßt, `MV` verschiebt.

> OpenRiss ist ein unabhängiges Projekt und steht in keiner Verbindung zu Autodesk. „Revit“ ist eine
> Marke der Autodesk, Inc. und wird hier nur zur Beschreibung der Bedienlogik genannt.

**Online starten:** nach dem Veröffentlichen unter `https://<benutzer>.github.io/<repository>/`

## Funktionen

**Modellieren (Architektur)**
- Wände mit Schichtaufbau (Struktur bearbeiten), Basislinie, Abhängigkeiten oben/unten, automatische
  Eck-, T- und Kreuzverbindungen, saubere Schraffur je Material, Leertaste kehrt die Außenseite um
- Türen und Fenster (Rohbaumaße, ein-/zweiflügelig, Schiebetür, Rolltor, Sektionaltor, Teleskop-Lifttür,
  Dreh-Kipp-Symbol in Ansichten), automatische Kennzeichen, Anschlag/Aufschlag umkehren
- Liftkabine im Schacht (Kabine, Tür, Gegengewicht auf allen Haltestellen, IfcTransportElement)
- Geschossdecken, Decken, Dächer (Walm-, Sattel-, Pult- und Flachdach, Wände oben fixieren),
  Treppen, Geländer, Bauteile (Möbel, Sanitär, Küche), Räume mit Fläche und Raumstempel,
  Raumtrennung, Wand- und Schachtöffnungen
- Ebenen, Raster (automatische Bezeichnung), Referenzebenen, Modell- und Detaillinien

**Tragwerk und Bewehrung**
- Tragwerksstützen, Träger, Einzel-/Streifenfundamente, Fundamentplatten
- Stabbewehrung mit Biegeformen (gerade, Winkel, Steckbügel, Bügel, Haken), Verlegung nach Anzahl oder
  Abstand, Betondeckung, Positionsnummern, Bewehrungsbeschriftung
- Flächenbewehrung und Lagermatten (Q- und R-Matten) mit Verlegeplan
- Stahlliste / Biegeliste mit Gewichten, CSV-Export

**Bewehrung nach Schweizer Usanz (SIA/SSHV)**
- SSHV-Figurenliste mit Formerkennung (z. B. Form 205), Biegerollen d3/d1 nach SIA 262, Mindestschenkelprüfung
- Positionsnummern je Bewehrungsplan, Eisenliste nach SSHV-Richtlinie (Deckblatt, Formskizzen, Spezialbewehrung)
- ABS-Export (BVBS 3.1, BF2D mit Muffenblock), Verlegebereiche mit Masskette, automatische kollisionsfreie
  Beschriftung, Lagenfilter je Ansicht, Wandabwicklungen, Treppenbewehrung
- Einlagen (Fugenblech, Rückbiegeanschluss, Muffenstab, Durchstanzbewehrung, Ankerschiene, Futterrohr,
  Einlegerohre), Arbeitsfugen und Etappen, Kernbohrungen, Dämmzonen mit Pressungen, Fertigteil-Lichtschacht
- Treppenlager für Trittschall: Schalldämmlager am Antritt, Z-Lager (Konsole + Elastomer) und Querkraftdorne an
  Decke und Podest, Podest auf Wandkonsole, Fugenplatten Lauf/Podest–Wand – in Schnitt, 3D, Liste und IFC

**Gebäudetechnik (HLKSE)**
- Heizung, Lüftung, Sanitär, Elektro: Rohre, Kanäle, Leerrohre mit Systemen und Gefälle, Apparate und
  Symbole, Fussbodenheizungskreise, Prinzipschema, Durchbrüche automatisch an das Tragwerk
- Beschriftungsformate (DN, Gefälle, System), Heizkreise mit Nummer, Länge, Leistung und Volumenstrom,
  Heizkreistabelle je Verteiler, Fundamenterder (Ring und Maschen entlang der Bodenplatte, Anschlussfahnen)

**Beschriften**
- Ausgerichtete Bemaßung (Maßketten, ganze Wände mit Öffnungen, assoziativ), lineare, Winkel- und
  Radiusbemaßung, Höhenkoten
- Text, Beschriftung nach Kategorie, Alle beschriften, Raumstempel
- Landesvorlage Schweiz: Masstexte «1.82⁵», Koten «OK +2.75» (Rohbau/Fertig, m ü. M.), Koten-Kästchen,
  Schweizer Plankopf mit Revisionstabelle
- Füllbereiche, Dämmung, Detailbauteile, Revisionswolken, Nordpfeil, grafische Massstabsleiste
- Linienstile als Projekttypen (Farbe, Stiftbreite, Strichart frei kombinierbar, Fachstile für Elektro, Abwasser,
  Kältemittel), Breitenfaktor für Schmalschriften

**Ansichten und Ausgabe**
- Grundrisse, Deckenpläne, Gebäudeansichten, Schnitte, Detailausschnitte, Zeichnungsansichten,
  Legenden, 3D-Ansicht mit Schnittbereich
- Detaillierungsgrad (grob/mittel/fein), Maßstab, Zuschneiden, Sichtbarkeit/Grafiken (VV),
  Grafiken in Ansicht überschreiben, temporär ausblenden/isolieren (HH/HI/HR), dünne Linien (TL), Unterlage
- Phasen für Umbauplanung: Bestand, Neubau, Abbruch – Bauantragsdarstellung (grau/rot/gelb)
- 3D-Ansicht mit ViewCube, Orbit (Umschalt + mittlere Maustaste), visuellen Stilen und Schnittbereich
- Pläne mit Plankopf (A0–A4), Ansichten per Drag & Drop platzieren, Bauteillisten
- Drucken, Vektor-PDF ohne Druckdialog (einzelner Plan oder „Alle Pläne als PDF“, Maßstab exakt, Schrift
  eingebettet, weitere TTF einbettbar), SVG, PNG, DXF (Export und Import, Layer je Linienstil mit Farbe), IFC4-Export
  (auch als Teilmodell je Fachbereich, z. B. nur Tragwerk), glTF/OBJ, Rasterbilder als Unterlage
- Beispielprojekt (Einfamilienhaus mit Plänen, Schnitten, Bewehrung und Türliste) unter
  *Einfügen → Beispielprojekt*

**Bedienung wie in Revit**
- Multifunktionsleiste mit kontextabhängigem Register „Ändern | …“, Eigenschaftenpalette mit
  Typenauswahl und „Typ bearbeiten“, Projektbrowser, Optionsleiste, Statusleiste
- Temporäre Bemaßungen: Wert anklicken und ändern verschiebt das Element
- Objektfang (Endpunkt, Mittelpunkt, Schnittpunkt, Lot, Zentrum …), Winkelfang, Längeneingabe beim
  Zeichnen (auch Ausdrücke wie `2,51+0,115m`)
- Ändern-Werkzeuge: Verschieben, Kopieren, Drehen, Spiegeln, Reihe, Skalieren, Ausrichten,
  Stutzen/Dehnen, Teilen, Versatz, Fixieren, Typ anpassen, Ähnliches erstellen
- Unbegrenztes Rückgängig/Wiederherstellen, Zwischenablage (auch an gleicher Position einfügen)
- Tastaturbefehle frei belegbar (KS), Import einer Revit-`KeyboardShortcuts.xml`

## Wichtige Tastenkürzel

| Kürzel | Befehl | Kürzel | Befehl |
|---|---|---|---|
| `WA` | Wand | `MV` | Verschieben |
| `DR` | Tür | `CO` / `CC` | Kopieren |
| `WN` | Fenster | `RO` | Drehen |
| `CM` | Bauteil | `MM` / `DM` | Spiegeln (Achse wählen / zeichnen) |
| `SB` | Geschossdecke | `AR` | Reihe |
| `RF` | Dach | `AL` | Ausrichten |
| `CL` | Tragwerksstütze | `TR` | Stutzen/Dehnen zu Ecke |
| `BM` | Träger | `SL` | Element teilen |
| `RB` | Stabbewehrung | `OF` | Versatz |
| `RM` | Raum | `RE` | Skalieren |
| `LL` | Ebene | `PN` / `UP` | Fixieren / Lösen |
| `GR` | Raster | `MA` | Typeigenschaften anpassen |
| `RP` | Referenzebene | `CS` | Ähnliches erstellen |
| `LI` / `DL` | Modell-/Detaillinie | `DE`, Entf | Löschen |
| `DI` | Ausgerichtete Bemaßung | `VV` / `VG` | Sichtbarkeit/Grafiken |
| `EL` | Höhenkote | `HH` / `HI` / `HR` | Temporär ausblenden / isolieren / zurücksetzen |
| `TX` | Text | `EH` / `VH` | In Ansicht ausblenden: Element / Kategorie |
| `TG` | Beschriftung nach Kategorie | `TL` | Dünne Linien |
| `RT` | Raumbeschriftung | `ZE` / `ZF` / `ZA` | Zoom Grenzen |
| `3D` | Standard-3D-Ansicht | `ZR` / `ZP` | Bereich vergrößern / vorheriger Zoom |
| `KS` | Tastaturbefehle | `SE` `SM` `SI` `SN` `SP` `SO` | Fangüberschreibungen |

Weitere: `Strg+Z/Y` Rückgängig/Wiederherstellen, `Strg+C/X/V` Zwischenablage, `Strg+S` Speichern,
`Esc` (zweimal) beendet ein Werkzeug, `Enter` wiederholt den letzten Befehl, `Tab` wechselt zwischen
überlagerten Elementen, `Leertaste` kehrt um, Pfeiltasten verschieben die Auswahl.

**Maus:** Rad = Zoom, mittlere Taste ziehen = Verschieben, Doppelklick Mausrad = Zoom Grenzen,
Umschalt + mittlere Taste = Orbit in 3D.

## Bekannte Grenzen

OpenRiss deckt die häufigsten Zeichenaufgaben ab, ist aber kein vollständiger Revit-Ersatz. Nicht
vorhanden sind u. a. Familieneditor, Gruppen, Arbeitsteilung (Worksets), Vorhangfassaden, Rampen,
Ansichtsvorlagen und DWG/RVT-Dateien (DXF und IFC dienen dem Datenaustausch). Flächen- und
Mattenbewehrung funktionieren in Decken und Platten (Grundriss), Bewehrungssätze passen sich nach
Änderungen am Bauteil über „An Bauteil anpassen“ an.

## Dateien

Projekte werden als `*.oriss` (JSON) gespeichert. Zusätzlich speichert OpenRiss den aktuellen Stand
automatisch im Browser (IndexedDB) und stellt ihn beim nächsten Öffnen wieder her.

## Skripte und Kommandozeile

OpenRiss lässt sich auch ohne Browser als Bibliothek verwenden – z. B. um ein Projekt aus Berechnungsdaten
zu erzeugen und Pläne automatisch auszugeben:

```bash
npx openriss build examples/einfamilienhaus.ts --out haus.oriss --pdf plansatz.pdf --dxf dxf --ifc haus.ifc
npx openriss export haus.oriss --pdf --svg
npx openriss check elemente.json
```

Funktionen und alle Element-Felder: [docs/API.md](docs/API.md).

## Entwicklung

```bash
npm install
npm run dev      # Entwicklungsserver auf http://localhost:5173
npm run build    # Typprüfung + Produktions-Build nach dist/
```

Architektur und Erweiterungspunkte (Kategorien, Werkzeuge, Befehle, Display-Liste, Schnitt-Engine):
siehe [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Veröffentlichen auf GitHub Pages

1. Repository auf GitHub anlegen und den Code nach `main` pushen.
2. In den Repository-Einstellungen unter **Settings → Pages → Build and deployment** als Quelle
   **GitHub Actions** wählen.
3. Der Workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) baut die Anwendung bei
   jedem Push und veröffentlicht sie. Da Vite mit `base: './'` baut, funktioniert jeder Unterpfad.

## Lizenz

[MIT](LICENSE) – frei verwendbar, auch kommerziell.

### Lizenzen Dritter

- [three.js](https://threejs.org) (MIT), [polygon-clipping](https://github.com/mfogel/polygon-clipping) (MIT),
  [fflate](https://github.com/101arrowz/fflate) (MIT, Komprimierung im PDF-Export)
- Schrift **Liberation Sans** (Regular, Bold) für den PDF-Export, eingebettet als Teilmenge:
  SIL Open Font License 1.1, Copyright © 2012 Red Hat, Inc. – siehe
  [src/modules/output/fonts/OFL.txt](src/modules/output/fonts/OFL.txt)
