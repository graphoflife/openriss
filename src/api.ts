// OpenRiss-Skript-API: DOM-freier Einstieg für Skripte, Generatoren und die CLI (`openriss build skript.ts`).
// Alle Funktionen arbeiten auf dem aktuellen Projekt (`doc`). Feldbeschreibung: docs/API.md.
import './registerModules';
import { app } from './app';
import type { Doc, El, Id } from './core/doc';
import { newId } from './core/doc';
import { catDef, emitHook } from './core/registry';
import { newProject, createPlanViews } from './core/template';
import type { View, Level, ProjectInfo } from './core/view';
import { levels } from './core/view';
import type { V2 } from './core/geom';
import { emptyBox, extendBox, boxValid } from './core/geom';
import { sectionGeomPatch, findOrAddLineStyle, LineStyleType } from './elements/datums';
import type { DashName } from './render/styles';
import { serialize, loadData } from './io/file';
import { applyUnits } from './ui/dialogs';
import { pageOf, pageSvg } from './modules/output/common';
import { viewExtent } from './modules/output/viewports';
import { defaultDef } from './modules/output/schedules';
import { exportDxf as dxfOf } from './modules/output/dxfCommands';
import { exportIfc as ifcOf, IfcOptions } from './modules/view3d/ifc';
export type { IfcOptions } from './modules/view3d/ifc';
import { sheetsToPdfAsync, registerPdfFont as registerPdfFont0 } from './modules/output/pdf';
import { absFiles as absFilesOf } from './modules/structure/steel';
import { applyLocale as applyLocaleTo } from './modules/annotation/locale';
import { addRevision as addRevisionTo } from './modules/output/sheets';
import { createRebarTag } from './modules/structure/rebar/tag';
import { fitElevationsTo, elevationsAtTemplate } from './views/fitElevations';
import { syncStairBearings as syncBearings, hasStairJoints, stairBearingsInSync, addStairJointTemplate } from './modules/architecture/stairJoints';

export { app };
/** Das aktuelle Projektdokument */
export const doc: Doc = app.doc;
export type { Doc, El, Id, View, Level, V2 };

// Prüfung und JSON-Import (gemeinsam mit der Oberfläche)
export { validate, ApiError } from './io/jsonImport';
export type { ImportError } from './io/jsonImport';
import { validate, ApiError, importElements, mergeExisting } from './io/jsonImport';

// ------------------------------------------------------------ Projekt
/** Neues Projekt aus der Vorlage */
export function createProject(info: Partial<ProjectInfo> = {}): Doc {
  newProject(doc);
  emitHook('loaded', doc);
  if (Object.keys(info).length) doc.transaction('Projektinformationen', () => doc.update('project', info as any));
  doc.clearHistory();
  applyUnits();
  return doc;
}
/** Projekt laden (.oriss-Inhalt als Text oder Objekt) */
export function loadProject(src: string | { elements: El[] }): Doc {
  const data = typeof src === 'string' ? JSON.parse(src) : src;
  loadData(data);
  return doc;
}
/** Projekt als .oriss-Text */
export function saveProject(): string { return serialize(); }
/** Mehrere Änderungen als ein Rückgängig-Schritt */
export function transaction<T>(name: string, fn: () => T): T { return doc.transaction(name, fn); }

const firstType = (of: string): Id | undefined => doc.all<any>('type').find((t) => t.of === of)?.id;

/** Warnungen der API (z.B. vorhandene Vorlagen-ID zusammengeführt); werden auch auf der Konsole ausgegeben */
export const warnings: string[] = [];

/**
 * Element prüfen und hinzufügen (ID wird bei Bedarf erzeugt, Standardtyp ergänzt). Wirft ApiError.
 * Gibt es die ID schon (z.B. Vorlagenmaterial `m_xps500`), werden Materialien/Typen zusammengeführt (Kennwerte der
 * Vorlage bleiben), andere Elemente ersetzt – jeweils mit Warnung. `{ replace: true }` ersetzt vollständig.
 */
export function add<T extends El = El>(el: Partial<T> & { cat: string }, o: { replace?: boolean } = {}): T {
  let e = { ...el } as any;
  if (!e.id) e.id = newId(e.cat.slice(0, 2));
  if (catDef(e.cat)?.hasTypes && !e.typeId) e.typeId = firstType(e.cat);
  const errs = validate([e], doc);
  if (errs.length) throw new ApiError(errs);
  const m = mergeExisting(doc, e, o.replace);
  if (m.warning) { warnings.push(m.warning); console.warn('OpenRiss: ' + m.warning); }
  e = m.el;
  return doc.transaction('API: ' + e.cat, () => doc.add(e)) as T;
}

/** Elementliste (oder { elements } bzw. Abschnitte wie { walls: [...] }) prüfen und importieren */
export const importJson = (data: any, o: { replace?: boolean; dryRun?: boolean } = {}) => importElements(doc, data, o);

// ------------------------------------------------------------ Bequeme Erzeuger
export function addLevel(o: { name: string; elev: number; id?: Id; plans?: boolean }): Level {
  return doc.transaction('Ebene', () => {
    const l = doc.add<Level>({ id: o.id ?? newId('lv'), cat: 'level', name: o.name, elev: o.elev, story: true } as Level);
    if (o.plans !== false) createPlanViews(doc, l);
    return l;
  });
}
export const addGrid = (o: { name: string; a: V2; b: V2; id?: Id }) => add({ cat: 'grid', ...o });
export const addWall = (o: { a: V2; b: V2; levelId: Id; typeId?: Id; topLevelId?: Id | null; baseOffset?: number; topOffset?: number; height?: number; locLine?: string; flip?: boolean; structural?: boolean; id?: Id }) =>
  add({ cat: 'wall', baseOffset: 0, topOffset: 0, height: 3000, locLine: 'center', flip: false, topLevelId: null, ...o });
const opening = (cat: 'door' | 'window') => (o: { hostId: Id; t: number; typeId?: Id; sill?: number; mark?: string; flipFacing?: boolean; flipHand?: boolean; id?: Id }) => {
  const w = doc.get(o.hostId);
  const tid = o.typeId ?? firstType(cat);
  return add({ cat, levelId: w?.levelId, sill: o.sill ?? (cat === 'window' ? doc.get<any>(tid)?.sill ?? 900 : 0), ...o, typeId: tid });
};
export const addDoor = opening('door');
export const addWindow = opening('window');
export const addWallOpening = (o: { hostId: Id; t: number; width: number; height: number; sill?: number; id?: Id; [k: string]: any }) =>
  add({ cat: 'opening', levelId: doc.get(o.hostId)?.levelId, sill: 0, ...o });
export const addFloor = (o: { loops: V2[][]; levelId: Id; typeId?: Id; offset?: number; structural?: boolean; id?: Id }) => add({ cat: 'floor', offset: 0, ...o });
export const addRoof = (o: { loops: V2[][]; levelId: Id; edges?: { slope: boolean; angle: number }[][]; typeId?: Id; baseOffset?: number; id?: Id }) =>
  add({ cat: 'roof', baseOffset: 0, edges: o.edges ?? o.loops.map((l) => l.map(() => ({ slope: false, angle: 0 }))), ...o });
export const addColumn = (o: { p: V2; levelId: Id; topLevelId?: Id | null; typeId?: Id; rot?: number; baseOffset?: number; topOffset?: number; height?: number; id?: Id }) =>
  add({ cat: 'column', rot: 0, baseOffset: 0, topOffset: 0, height: 3000, ...o });
export const addBeam = (o: { a: V2; b: V2; levelId: Id; typeId?: Id; offA?: number; offB?: number; zJust?: string; id?: Id }) =>
  add({ cat: 'beam', offA: 0, offB: 0, zJust: 'top', yOff: 0, ...o });
export const addStair = (o: { p0: V2; dir: V2; levelId: Id; topLevelId?: Id | null; typeId?: Id; shape?: string; width?: number; [k: string]: any }) => {
  const s = add({ cat: 'stair', baseOffset: 0, topOffset: 0, height: 3000, shape: 'straight', turn: 1, width: 1000, maxRiser: 180, tread: 280, landing: 0, gap: 100, risers: 0, split: 0, ...o });
  if (hasStairJoints(s)) syncStairBearings(s.id);
  return s;
};
/** Treppenlager (Z-Lager, Schalldämmlager, Querkraftdorne, Fugenplatten) nach Änderung der Lagerfelder nachführen – eine oder alle Treppen */
export function syncStairBearings(id?: Id): number {
  const stairs = (id ? [doc.get(id)] : doc.all('stair')).filter((s): s is El => !!s && s.cat === 'stair');
  if (stairs.some((s) => hasStairJoints(s) || !stairBearingsInSync(doc, s))) {
    doc.transaction('Treppenlager', () => { addStairJointTemplate(doc); for (const s of stairs) syncBearings(doc, s); });
  }
  return doc.all('stairBearing').length;
}
export const addRoom = (o: { pt: V2; levelId: Id; name: string; number: string; [k: string]: any }) => add({ cat: 'room', baseOffset: 0, topOffset: 0, ...o });
export const addRebar = (o: { hostId: Id; dia: number; pts: { x: number; y: number; z: number }[]; [k: string]: any }) =>
  add({ cat: 'rebar', shape: '00', layout: 'single', count: 1, spacing: 150, display: 'first', hookA: 0, hookB: 0, ...o });
/** Bewehrungsbeschriftung (wird direkt eingefügt) */
export function addRebarTag(rebarId: Id, viewId: Id, off?: V2, fmt: any = 'std', leader = true) {
  const el = doc.get(rebarId), v = doc.get<View>(viewId);
  if (!el || !v) throw new ApiError([{ id: rebarId, cat: 'rebarTag', field: el ? 'viewId' : 'refId', msg: 'unbekannt' }]);
  return doc.transaction('Bewehrungsbeschriftung', () => createRebarTag(doc, el, v, off, fmt, leader));
}
/** Beschriftungen bei Platzierung (Türen, Fenster, Räume) in einer Ansicht erzeugen */
export function tagOnPlace(ids: Id[], viewId: Id): void {
  const v = doc.get<View>(viewId)!;
  doc.transaction('Beschriften', () => { for (const id of ids) { const e = doc.get(id); if (e) emitHook('tagOnPlace', e, v); } });
}

// ------------------------------------------------------------ Ansichten, Pläne, Listen
export const addPlanView = (o: { levelId: Id; name?: string; scale?: number; [k: string]: any }) =>
  add<View>({ cat: 'view', kind: 'plan', name: o.name ?? doc.get<any>(o.levelId)?.name ?? 'Grundriss', scale: 100, detail: 'medium', range: { top: 2300, cut: 1200, bottom: 0, depth: 0 }, ...o } as any);
export function addSection(o: { a: V2; b: V2; name: string; far?: number; z0?: number; z1?: number; scale?: number; marker?: string; [k: string]: any }): View {
  const { a, b, z0, z1, marker, ...rest } = o;
  const v: any = { id: newId('vw'), cat: 'view', kind: 'section', scale: 100, detail: 'medium', far: 5000, data: { marker: marker ?? o.name.slice(-1) },
    crop: { on: true, show: false, min: { x: 0, y: z0 ?? -1500 }, max: { x: 0, y: z1 ?? 9000 } }, ...rest };
  Object.assign(v, sectionGeomPatch(a, b, v));
  return add<View>(v);
}
export const addSheet = (o: { no: string; name: string; size?: 'A0' | 'A1' | 'A2' | 'A3' | 'A4'; portrait?: boolean; data?: any; id?: Id }) =>
  add<View>({ id: o.id, cat: 'view', kind: 'sheet', name: o.name, sheetNo: o.no, scale: 1, detail: 'medium',
    data: { size: o.size ?? 'A1', portrait: !!o.portrait, drawnBy: '', checkedBy: '', date: new Date().toLocaleDateString('de-CH'), index: '', ...(o.data ?? {}) } } as any);
/** Ansicht auf Plan platzieren (center in Papier-mm) */
export function placeView(sheetId: Id, viewId: Id, center: V2, detail?: string): El {
  const v = doc.get<View>(viewId); if (!v) throw new ApiError([{ id: viewId, cat: 'viewport', field: 'refId', msg: 'Ansicht unbekannt' }]);
  const b = viewExtent(doc, v);
  const n = doc.all<any>('viewport').filter((x) => x.viewId === sheetId).length + 1;
  return add({ cat: 'viewport', viewId: sheetId, refId: viewId, center, detail: detail ?? String(n),
    anchor: v.kind === 'schedule' ? { x: b.min.x, y: b.max.y } : { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 } });
}
/** Bauteilliste (Definition siehe docs/API.md; ohne def: Standardfelder der Kategorie) */
export const addSchedule = (o: { name: string; cat: string; def?: any; id?: Id }) =>
  add<View>({ id: o.id, cat: 'view', kind: 'schedule', name: o.name, scale: 1, detail: 'medium', data: o.def ?? defaultDef(doc, o.cat) } as any);

/** Linienstil (Projekttyp: Farbe, Stift 1–16, Strichart) anlegen – oder den vorhandenen mit gleichen Eigenschaften liefern */
export const addLineStyle = (o: { name?: string; color?: string; pen: number; dash?: DashName; id?: Id }): LineStyleType =>
  doc.transaction('API: Linienstil', () => findOrAddLineStyle(doc, o));

/** Gebäudeansichten um die Modellausdehnung legen */
export const fitElevations = (margin = 6000) => fitElevationsTo(doc, margin);

// ------------------------------------------------------------ Ausgabe
export const sheets = (): View[] => doc.all<View>('view').filter((v) => v.kind === 'sheet').sort((a, b) => (a.sheetNo ?? '').localeCompare(b.sheetNo ?? '', 'de', { numeric: true }));
/** Plan oder Ansicht als SVG (Papier-mm) */
export function exportSvg(viewId: Id): string {
  const p = pageOf(doc, doc.get<View>(viewId)!); if (!p) throw new ApiError([{ id: viewId, cat: 'view', field: 'kind', msg: 'nicht druckbar' }]);
  return pageSvg(p);
}
/** Plan oder Ansicht als DXF */
export function exportDxf(viewId: Id, version: 'R2000' | 'R12' = 'R2000'): Uint8Array {
  const r = dxfOf(doc, doc.get<View>(viewId)!, version, false);
  if (!r) throw new ApiError([{ id: viewId, cat: 'view', field: 'kind', msg: 'kein DXF möglich' }]);
  return r;
}
/** IFC4 des ganzen Modells */
export function exportIfc(fileName: string | IfcOptions = 'Projekt.ifc', opts: IfcOptions = {}): string {
  if (typeof fileName !== 'string') { opts = fileName; fileName = 'Projekt.ifc'; }
  return ifcOf(doc, fileName, new Date(), opts).text;
}

// ------------------------------------------------------------ CLI-Abschluss (Export nach dem Skript)
export interface CliOptions {
  cwd?: string; out?: string; pdf?: string; dxf?: string; svg?: string; ifc?: string; abs?: string; fitElevations?: boolean;
  /** IFC-Teilmodell: Fachbereiche, nur/ohne Kategorien */
  ifcDisc?: string[]; ifcCats?: string[]; ifcExclude?: string[];
  /** zusätzliche PDF-Schriften: Familie → TTF-Pfad (regular[,bold]) */
  fonts?: Record<string, string>;
}
/** Wird von `openriss build/export` nach dem Skript aufgerufen und schreibt die gewünschten Dateien. */
export async function finishCli(o: CliOptions): Promise<void> {
  const fs: any = await import('node:fs' as string);
  const path: any = await import('node:path' as string);
  const safe = (s: string) => s.replace(/[^\w\-.äöüÄÖÜß ]+/g, '_');
  if (o.fitElevations || elevationsAtTemplate(doc)) fitElevations();
  for (const [fam, files] of Object.entries(o.fonts ?? {})) {
    const [r, b] = files.split(',');
    registerPdfFont(fam, new Uint8Array(fs.readFileSync(r)), b ? new Uint8Array(fs.readFileSync(b)) : undefined);
  }
  syncStairBearings();
  const shs = sheets();
  if (o.out) { fs.writeFileSync(o.out, saveProject()); console.log(`Projekt: ${o.out}`); }
  if (o.svg) {
    fs.mkdirSync(o.svg, { recursive: true });
    for (const s of shs) fs.writeFileSync(path.join(o.svg, safe(`${s.sheetNo ?? ''} ${s.name}`).trim() + '.svg'), exportSvg(s.id));
    console.log(`SVG: ${shs.length} Pläne → ${o.svg}`);
  }
  if (o.dxf) {
    fs.mkdirSync(o.dxf, { recursive: true });
    for (const s of shs) fs.writeFileSync(path.join(o.dxf, safe(`${s.sheetNo ?? ''} ${s.name}`).trim() + '.dxf'), exportDxf(s.id));
    console.log(`DXF: ${shs.length} Pläne → ${o.dxf}`);
  }
  if (o.pdf) { fs.writeFileSync(o.pdf, await exportPdf(shs.map((s) => s.id))); console.log(`PDF: ${shs.length} Pläne → ${o.pdf}`); }
  if (o.ifc) {
    const io: IfcOptions = { disciplines: o.ifcDisc as any, cats: o.ifcCats, excludeCats: o.ifcExclude };
    fs.writeFileSync(o.ifc, exportIfc(path.basename(o.ifc), io));
    console.log(`IFC: ${o.ifc}${o.ifcDisc?.length ? ' (' + o.ifcDisc.join(', ') + ')' : ''}`);
  }
  if (o.abs) {
    fs.mkdirSync(o.abs, { recursive: true });
    const files = absFilesOf(doc);
    for (const f of files) fs.writeFileSync(path.join(o.abs, f.name), f.text, 'latin1');
    console.log(`ABS: ${files.length} Dateien → ${o.abs}`);
  }
}
/** Weitere TrueType-Schrift fürs PDF einbetten (z.B. «Arial Narrow»); Texte dieser Familie nutzen sie statt des Breitenfaktors */
export const registerPdfFont = (family: string, regular: Uint8Array, bold?: Uint8Array) => registerPdfFont0(family, regular, bold);
/** Vektor-PDF (eine Seite je Plan/Ansicht, Planformat exakt) */
export async function exportPdf(ids: Id[] = sheets().map((s) => s.id), monochrome = false): Promise<Uint8Array> {
  return sheetsToPdfAsync(doc, ids, { monochrome });
}

// ------------------------------------------------------------ Landesvorlage, Revisionen
/** Landesvorlage setzen (CH: Masstexte, Koten, Plankopf, Dezimalpunkt); retype stellt Standardtypen um */
export function applyLocale(loc: 'DE' | 'CH', o: { retype?: boolean; elev00?: number } = {}) {
  const r = applyLocaleTo(doc, loc, o);
  applyUnits();
  return r;
}
/** Revision zu einem Plan hinzufügen (Index wird fortgezählt) */
export const addRevision = (sheetId: Id, r: { text: string; by?: string; date?: string; index?: string }) => addRevisionTo(doc, sheetId, r);

/** Funktion mit Änderungen: öffnet selbst eine Transaktion, wenn das Skript keine offen hat (verschachtelt erlaubt) */
const tx = <F extends (...a: any[]) => any>(name: string, fn: F): F => ((...a: any[]) => doc.transaction('API: ' + name, () => fn(...a))) as F;

// ------------------------------------------------------------ Bewehrung nach Schweizer Usanz (SSHV/SIA)
import { renumberPlans as renumberPlans0, createRebarSchedule as createRebarSchedule0, createEisenliste as createEisenliste0 } from './modules/structure/steel';
import { migrateRebarPlans as migrateRebarPlans0 } from './modules/structure/rebar/norm';
export { absExport, absFiles, eisenlisteCsv } from './modules/structure/steel';
export { stahllisteCsv } from './modules/structure/schedule';
export { rebarPlans } from './modules/structure/rebar/norm';
export const renumberPlans = tx('Positionen je Plan', renumberPlans0);
export const createRebarSchedule = tx('Stahlliste', createRebarSchedule0);
export const createEisenliste = tx('Eisenliste', createEisenliste0);
export const migrateRebarPlans = tx('Bewehrungspläne', migrateRebarPlans0);

// ------------------------------------------------------------ Gebäudetechnik (HLKSE)
import * as mep from './modules/mep';
export { findPenetrations, systems } from './modules/mep';
export const addRunChain = tx('Leitung', mep.addRunChain);
export const addRiser = tx('Steigleitung', mep.addRiser);
export const applySlope = tx('Gefälle', mep.applySlope);
export const addFixture = tx('Apparat', mep.addFixture);
export const addCircuit = tx('Heizkreis', mep.addCircuit);
export const createMepPlans = tx('HLKSE-Pläne', mep.createMepPlans);
export const createRunSchedules = tx('HLKSE-Listen', mep.createRunSchedules);
export const tagRuns = tx('Leitungen beschriften', mep.tagRuns);
export const createSchemaView = tx('Prinzipschema', mep.createSchemaView);
export const addSchemaSym = tx('Schemasymbol', mep.addSchemaSym);
export const addSchemaLine = tx('Schemalinie', mep.addSchemaLine);
export const autoHeatingSchema = tx('Heizungsschema', mep.autoHeatingSchema);
export const applyPenetrations = tx('Durchbrüche', mep.applyPenetrations);
export const createHeatingTable = tx('Heizkreistabelle', mep.createHeatingTable);
export const numberCircuits = tx('Heizkreise nummerieren', mep.numberCircuits);
export const addEarthing = tx('Fundamenterder', mep.addEarthing);
