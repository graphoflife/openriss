// Zentrale Registrierung: Kategorien (Verhalten je Elementart), Befehle, Multifunktionsleiste,
// Tastenkürzel. Module (Wände, Bewehrung, Bemaßung …) melden sich hier an.
import type { El, Doc, Id } from './doc';
import type { V2, V3, Mat2, BBox } from './geom';
import type { DisplayList } from '../render/displayList';
import type { View } from './view';

// ---------------------------------------------------------------- 3D-Geometrie
/** Ebene, planare Fläche (Außenring + Löcher), Normale zeigt nach außen. */
export interface Face { pts: V3[]; holes?: V3[][]; }
export interface Solid {
  faces: Face[];
  /** Material-ID (cat 'material') – bestimmt Schnittmuster und Farbe */
  mat?: Id;
  /** Optional: Farbe für 3D, falls kein Material */
  color?: string;
  /** z.B. 'glass', 'frame', 'rebar' */
  role?: string;
  /** im Schnitt nicht schraffieren (z.B. Glas) */
  noCut?: boolean;
}

// ---------------------------------------------------------------- Ansichts-Kontext
export interface PlanCtx {
  doc: Doc;
  view: View;
  dl: DisplayList;
  level: El | undefined;   // Ebene der Ansicht
  cutZ: number;            // absolute Höhe der Schnittebene
  bottomZ: number;         // Unterkante Ansichtsbereich
  topZ: number;            // Oberkante Ansichtsbereich
  depthZ: number;          // Ansichtstiefe
  detail: 'coarse' | 'medium' | 'fine';
  ceiling: boolean;        // Deckenplan (Blick nach oben)
}

export interface SectionCtx {
  doc: Doc;
  view: View;
  dl: DisplayList;
  detail: 'coarse' | 'medium' | 'fine';
  /** Welt → Ansicht (x rechts, y oben) */
  toView(p: V3): V2;
  /** Tiefe hinter der Schnittebene (positiv = sichtbar) */
  depth(p: V3): number;
  /** Ansicht → Welt (auf der Schnittebene, Tiefe 0) */
  toWorld(p: V2, depth?: number): V3;
  origin: V3; right: V3; up: V3; dir: V3;
  far: number;
  /** Ausdehnung der gezeichneten Modellgeometrie (Ansichtskoordinaten) – für Ebenen-/Rasterlängen */
  modelBox?: BBox;
}

export interface Grip {
  id: string;
  p: V2;
  /** 'end' Punktgriff, 'arrow' Pfeil, 'flip' Umkehrsymbol (Klick), 'text' Textposition */
  kind?: 'end' | 'arrow' | 'flip' | 'text' | 'shape';
  dir?: V2;
  tip?: string;
}

/** Temporäre Bemaßung (Revit-typisch: Wert anklicken und ändern verschiebt das Element) */
export interface TempDim {
  a: V2; b: V2;            // Messpunkte (Ansichtskoordinaten)
  value: number;           // aktueller Wert (mm)
  /** Neue Länge anwenden – innerhalb einer Transaktion aufgerufen */
  apply?: (v: number) => void;
  offset?: number;         // Abstand der Maßlinie (Ansichts-mm)
  label?: string;
}

export interface PropDef {
  key: string;
  label: string;
  group: string;
  type: 'length' | 'number' | 'int' | 'text' | 'bool' | 'select' | 'angle' | 'readonly' | 'area' | 'color' | 'button' | 'level' | 'material';
  options?: [string, string][] | ((doc: Doc) => [string, string][]);
  get: (el: El, doc: Doc) => any;
  /** liefert Patch für das Element; wird in einer Transaktion angewendet */
  set?: (el: El, v: any, doc: Doc) => Partial<El> | void;
  /** für Typ-Eigenschaften: true, wenn auf Typ-Element */
  readonly?: boolean;
  /** Schaltfläche: Aktion */
  action?: (el: El, doc: Doc) => void;
}

export const GROUPS = {
  constraints: 'Abhängigkeiten',
  construction: 'Konstruktion',
  structural: 'Tragwerk',
  dims: 'Abmessungen',
  identity: 'ID-Daten',
  graphics: 'Grafiken',
  text: 'Text',
  extents: 'Grenzen',
  materials: 'Materialien und Oberflächen',
  rebar: 'Bewehrungssatz',
  other: 'Sonstige',
};

export interface CategoryDef {
  cat: string;
  /** Anzeigename (Singular / Plural) */
  label: string;
  plural: string;
  /** ansichtsspezifisch (Beschriftung) */
  annotation?: boolean;
  /** Bezugselement (Ebene, Raster, Referenzebene) */
  datum?: boolean;
  /** hat Typen (Typenauswahl) */
  hasTypes?: boolean;
  /** Reihenfolge beim Zeichnen im Grundriss (klein = zuerst) */
  planOrder?: number;

  /** Symbolische Grundrissdarstellung. Wenn nicht vorhanden, wird solids() geschnitten/projiziert. */
  drawPlan?(ctx: PlanCtx, el: El): void;
  /** Wie drawPlan, aber alle sichtbaren Elemente der Kategorie auf einmal (z.B. Wände für saubere Verbindungen) */
  drawPlanBatch?(ctx: PlanCtx, els: El[]): void;
  /** Öffnung im Host (Tür/Fenster/Wandöffnung): Bereich entlang der Host-Achse (u) und Höhe (z, absolut) */
  hostOpening?(el: El, doc: Doc): { u0: number; u1: number; z0: number; z1: number; cutsPlan?: boolean; profile?: { u: number; z: number }[] } | null;
  /** IFC-Zuordnung (Entität, vordefinierter Typ, Eigenschaftssätze) für den IFC-Export */
  ifc?(el: El, doc: Doc): { entity: string; predefined?: string; name?: string; psets?: Record<string, Record<string, string | number | boolean>> } | null;
  /** Darstellung in Schnitt/Ansicht zusätzlich oder statt Solids (z.B. Ebenenlinien) */
  drawSection?(ctx: SectionCtx, el: El): void;
  /** Ansichtsspezifische Elemente (Beschriftung) – Koordinaten in Ansichtssystem */
  drawAnnotation?(dl: DisplayList, el: El, doc: Doc, view: View): void;
  /** 3D-Körper */
  solids?(el: El, doc: Doc): Solid[];
  /** Im Schnitt: zusätzlich zur Solid-Darstellung selbst zeichnen und Solids nicht verwenden */
  sectionOnlyCustom?: boolean;

  /** Griffe für ausgewähltes Element in der Ansicht */
  grips?(el: El, doc: Doc, view: View): Grip[];
  /** Griff ziehen → Patch. Wird in Transaktion ausgeführt. */
  dragGrip?(el: El, gripId: string, p: V2, doc: Doc, view: View): Partial<El> | void;
  /** Klick auf Griff vom Typ 'flip' */
  clickGrip?(el: El, gripId: string, doc: Doc, view: View): Partial<El> | void;
  /** 2D-Transformation (Verschieben, Drehen, Spiegeln) im Koordinatensystem der Ansicht */
  transform?(el: El, m: Mat2, doc: Doc, view: View): Partial<El> | void;
  /** Verschiebung in 3D (für Bearbeitung in Schnitten/Ansichten) */
  translate3d?(el: El, d: V3, doc: Doc): Partial<El> | void;
  /** Kopie anlegen: Felder anpassen (z.B. neue Referenzen); Standard: tiefe Kopie mit neuer ID */
  onCopy?(el: El, doc: Doc, idMap: Map<Id, Id>): El | void;
  /** Temporäre Bemaßungen bei Auswahl */
  tempDims?(el: El, doc: Doc, view: View): TempDim[];
  /** Instanzeigenschaften */
  props?(el: El, doc: Doc): PropDef[];
  /** Typeigenschaften (Typ-Element) */
  typeProps?(type: El, doc: Doc): PropDef[];
  /** Für Bauteillisten: zusätzliche berechnete Felder */
  scheduleFields?(): { key: string; label: string; get: (el: El, doc: Doc) => any; unit?: 'len' | 'area' | 'vol' | 'kg' | 'num' }[];
  /** Beschriftungstext (für Beschriftungen nach Kategorie) */
  tagText?(el: El, doc: Doc, tagKind?: string): string;
  /** Position für Beschriftung im Grundriss */
  tagPoint?(el: El, doc: Doc, view: View): V2 | null;
  /** Ist das Element in dieser Ansicht sichtbar? (für Modell-Elemente, zusätzlich zur Kategorie-Sichtbarkeit) */
  visibleIn?(el: El, doc: Doc, view: View): boolean;
  /** Mittelpunkt/Referenzpunkt in der Ansicht (für Drehen-Standardzentrum, Zoom) */
  center?(el: El, doc: Doc, view: View): V2 | null;
  /** Hosts für gehostete Elemente: wenn Host bewegt wird, werden diese neu berechnet */
  hostCats?: string[];
  /** Linien-Referenzen (für Ausrichten/Versatz/Stutzen): liefert Achse in der Ansicht */
  curve?(el: El, doc: Doc, view: View): { a: V2; b: V2 } | null;
  /** Kurve ändern (Stutzen/Dehnen/Teilen) */
  setCurve?(el: El, a: V2, b: V2, doc: Doc, view: View): Partial<El> | void;
}

const cats = new Map<string, CategoryDef>();
export function registerCategory(def: CategoryDef): void { cats.set(def.cat, def); }
export function catDef(cat: string): CategoryDef | undefined { return cats.get(cat); }
export function allCats(): CategoryDef[] { return [...cats.values()]; }

// ---------------------------------------------------------------- Befehle
export interface Command {
  id: string;
  label: string;
  /** Tooltip-Beschreibung */
  tip?: string;
  /** SVG-Inhalt (24x24, ohne <svg>-Hülle) */
  icon?: string;
  /** Standard-Tastenkürzel (wie Revit) */
  keys?: string[];
  run: () => void;
  enabled?: () => boolean;
  /** aktiv (z.B. Umschalter) */
  checked?: () => boolean;
}
const commands = new Map<string, Command>();
export function registerCommand(c: Command): Command { commands.set(c.id, c); return c; }
export function cmd(id: string): Command | undefined { return commands.get(id); }
export function allCommands(): Command[] { return [...commands.values()]; }

// ---------------------------------------------------------------- Multifunktionsleiste
export interface RibbonItem { cmd: string; size?: 'large' | 'small'; }
export interface RibbonPanel { tab: string; panel: string; items: RibbonItem[]; order?: number; }
export const TABS = ['Architektur', 'Ingenieurbau', 'Einfügen', 'Beschriften', 'Ansicht', 'Verwalten', 'Ändern'];
const panels: RibbonPanel[] = [];
export function registerPanel(tab: string, panel: string, items: (string | RibbonItem)[], order = 50): void {
  const existing = panels.find((p) => p.tab === tab && p.panel === panel);
  const its = items.map((i) => (typeof i === 'string' ? { cmd: i } : i));
  if (existing) existing.items.push(...its);
  else panels.push({ tab, panel, items: its, order });
}
export function panelsOf(tab: string): RibbonPanel[] {
  return panels.filter((p) => p.tab === tab).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

// ---------------------------------------------------------------- Kontextbefehle für Auswahl
/** Zusätzliche Befehle im Register "Ändern", abhängig von der Auswahl (z.B. "Oben fixieren" für Wände). */
export interface ContextPanel { cats: string[]; panel: string; items: string[] }
const ctxPanels: ContextPanel[] = [];
export function registerContextPanel(p: ContextPanel): void { ctxPanels.push(p); }
export function contextPanelsFor(catsSel: Set<string>): ContextPanel[] {
  return ctxPanels.filter((p) => p.cats.some((c) => catsSel.has(c)));
}

// ---------------------------------------------------------------- Ansichts-Erweiterungen
/** Zusätzliche Ansichtsarten (3D, Plan, Bauteilliste) registrieren ihre Darstellung hier. */
export interface ViewportFactory {
  kinds: string[];
  create(view: View, host: HTMLElement): ViewportLike;
}
export interface ViewportLike {
  view: View;
  el: HTMLElement;
  activate(): void;
  deactivate(): void;
  invalidate(): void;
  zoomExtents(): void;
  dispose(): void;
  /** optional: Display-Liste der Ansicht (für Export) */
  displayList?(): DisplayList | null;
  onKey?(e: KeyboardEvent): boolean;
}
const vpFactories: ViewportFactory[] = [];
export function registerViewport(f: ViewportFactory): void { vpFactories.push(f); }
export function viewportFactory(kind: string): ViewportFactory | undefined { return vpFactories.find((f) => f.kinds.includes(kind)); }

/** Zusätzliche Display-Listen-Builder je Ansichtsart (z.B. Plan/Blatt) */
export type DLBuilder = (doc: Doc, view: View) => DisplayList;
const dlBuilders = new Map<string, DLBuilder>();
export function registerDLBuilder(kind: string, b: DLBuilder): void { dlBuilders.set(kind, b); }
export function dlBuilder(kind: string): DLBuilder | undefined { return dlBuilders.get(kind); }

// ---------------------------------------------------------------- Projektbrowser-Erweiterungen
export interface BrowserSection { id: string; label: string; order: number; items: (doc: Doc) => { id: Id; label: string; icon?: string }[]; onOpen?: (id: Id) => void; }
const browserSections: BrowserSection[] = [];
export function registerBrowserSection(s: BrowserSection): void { browserSections.push(s); }
export function allBrowserSections(): BrowserSection[] { return browserSections.slice().sort((a, b) => a.order - b.order); }

// ---------------------------------------------------------------- Ereignis-Hooks
type Hook = (...args: any[]) => void;
const hooks = new Map<string, Hook[]>();
export function onHook(name: string, h: Hook): void { (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(h); }
export function emitHook(name: string, ...args: any[]): void { for (const h of hooks.get(name) ?? []) { try { h(...args); } catch (e) { console.error(e); } } }
