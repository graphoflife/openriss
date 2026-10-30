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
import { sectionGeomPatch } from './elements/datums';
import { serialize, loadData } from './io/file';
import { applyUnits } from './ui/dialogs';
import { pageOf, pageSvg } from './modules/output/common';
import { viewExtent } from './modules/output/viewports';
import { defaultDef } from './modules/output/schedules';
import { exportDxf as dxfOf } from './modules/output/dxfCommands';
import { exportIfc as ifcOf } from './modules/view3d/ifc';
import { sheetsToPdfAsync } from './modules/output/pdf';
import { absFiles as absFilesOf } from './modules/structure/steel';
import { applyLocale as applyLocaleTo } from './modules/annotation/locale';
import { addRevision as addRevisionTo } from './modules/output/sheets';
import { createRebarTag } from './modules/structure/rebar/tag';
import { fitElevationsTo, elevationsAtTemplate } from './views/fitElevations';

export { app };
/** Das aktuelle Projektdokument */
export const doc: Doc = app.doc;
export type { Doc, El, Id, View, Level, V2 };

// Prüfung und JSON-Import (gemeinsam mit der Oberfläche)
export { validate, ApiError } from './io/jsonImport';
export type { ImportError } from './io/jsonImport';
import { validate, ApiError, importElements } from './io/jsonImport';

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

/** Element prüfen und hinzufügen (ID wird bei Bedarf erzeugt, Standardtyp ergänzt). Wirft ApiError. */
export function add<T extends El = El>(el: Partial<T> & { cat: string }): T {
  const e = { ...el } as any;
  if (!e.id) e.id = newId(e.cat.slice(0, 2));
  if (catDef(e.cat)?.hasTypes && !e.typeId) e.typeId = firstType(e.cat);
  const errs = validate([e], doc);
  if (errs.length) throw new ApiError(errs);
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
export const addStair = (o: { p0: V2; dir: V2; levelId: Id; topLevelId?: Id | null; typeId?: Id; shape?: string; width?: number; [k: string]: any }) =>
  add({ cat: 'stair', baseOffset: 0, topOffset: 0, height: 3000, shape: 'straight', turn: 1, width: 1000, maxRiser: 180, tread: 280, landing: 0, gap: 100, risers: 0, split: 0, ...o });
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
export function exportIfc(fileName = 'Projekt.ifc'): string { return ifcOf(doc, fileName).text; }

// ------------------------------------------------------------ CLI-Abschluss (Export nach dem Skript)
export interface CliOptions { cwd?: string; out?: string; pdf?: string; dxf?: string; svg?: string; ifc?: string; abs?: string; fitElevations?: boolean }
/** Wird von `openriss build/export` nach dem Skript aufgerufen und schreibt die gewünschten Dateien. */
export async function finishCli(o: CliOptions): Promise<void> {
  const fs: any = await import('node:fs' as string);
  const path: any = await import('node:path' as string);
  const safe = (s: string) => s.replace(/[^\w\-.äöüÄÖÜß ]+/g, '_');
  if (o.fitElevations || elevationsAtTemplate(doc)) fitElevations();
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
  if (o.ifc) { fs.writeFileSync(o.ifc, exportIfc(path.basename(o.ifc))); console.log(`IFC: ${o.ifc}`); }
  if (o.abs) {
    fs.mkdirSync(o.abs, { recursive: true });
    const files = absFilesOf(doc);
    for (const f of files) fs.writeFileSync(path.join(o.abs, f.name), f.text, 'latin1');
    console.log(`ABS: ${files.length} Dateien → ${o.abs}`);
  }
}
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

// ------------------------------------------------------------ Bewehrung nach Schweizer Usanz (SSHV/SIA)
export { absExport, absFiles, renumberPlans, createRebarSchedule, createEisenliste, eisenlisteCsv } from './modules/structure/steel';
export { stahllisteCsv } from './modules/structure/schedule';
export { migrateRebarPlans, rebarPlans } from './modules/structure/rebar/norm';
