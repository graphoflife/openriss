// Ansichten: Grundriss, Deckenplan, Ansicht, Schnitt, 3D, Zeichnungsansicht, Plan (Blatt), Bauteilliste.
import type { El, Doc, Id } from './doc';
import { onCommit } from './doc';
import { V2, V3, add3, mul3, cross3, norm3, dot3, sub3, BBox } from './geom';

export type ViewKind = 'plan' | 'ceiling' | 'elevation' | 'section' | '3d' | 'drafting' | 'sheet' | 'schedule' | 'legend';
export type Detail = 'coarse' | 'medium' | 'fine';

export interface ViewRange { top: number; cut: number; bottom: number; depth: number }

export interface View extends El {
  cat: 'view';
  kind: ViewKind;
  name: string;
  scale: number;
  detail: Detail;
  /** Grundriss/Deckenplan */
  levelId?: Id;
  range?: ViewRange;
  underlayLevelId?: Id | null;
  /** Zuschneidebereich in Ansichtskoordinaten */
  crop?: { on: boolean; show: boolean; min: V2; max: V2 } | null;
  /** Schnitt/Ansicht */
  origin?: V3;        // Punkt auf der Schnittebene (Welt)
  dir?: V2;           // Blickrichtung (horizontal, normiert)
  far?: number;       // Tiefe (Ansichtsbegrenzung)
  /** Schnittlinie im Grundriss (für Schnitt): a → b, Blick nach links (dir = perp) */
  lineA?: V2; lineB?: V2;
  /** Sichtbarkeit */
  hiddenCats?: string[];
  hiddenEls?: Id[];
  catOverrides?: Record<string, { color?: string; w?: number; halftone?: boolean; pattern?: string }>;
  /** Visueller Stil (3D/Ansichten) */
  style?: 'wire' | 'hidden' | 'shaded' | 'consistent' | 'realistic';
  /** Plan / Blatt */
  sheetNo?: string;
  /** Unterteilung im Projektbrowser */
  discipline?: 'arch' | 'struct' | 'coord';
  /** Beschriftung auf Plan */
  titleOnSheet?: string;
  /** Freie Felder je Ansichtsart (3D-Kamera, Bauteillisten-Definition …) */
  data?: any;
  /** Abhängige Ansicht (Revit «Abhängige Ansicht duplizieren»): Primäransicht; alle Felder ausser DEP_OWN folgen ihr */
  parentId?: Id;
  /** Grundriss: Rahmen der Teilpläne (abhängige Ansichten derselben Ebene) mit Plannummern anzeigen */
  depFrames?: boolean;
}

// ---------------------------------------------------------------- Abhängige Ansichten
/** Eigene Felder einer abhängigen Ansicht; alle übrigen werden beim Schreiben mit der Primäransicht abgeglichen */
export const DEP_OWN = new Set(['id', 'cat', 'name', 'crop', 'hostId', 'titleOnSheet', 'parentId', 'depFrames', 'pinned', 'mark', 'comments']);
/** eigene Felder in data */
export const DEP_OWN_DATA = new Set(['marker']);
/** Primäransicht (Wurzel) einer Ansicht – die Ansicht selbst, wenn sie nicht abhängig ist */
export function rootView<T extends View | undefined>(doc: Doc, v: T): T {
  let r: View | undefined = v; let n = 0;
  while (r?.parentId && n++ < 8) { const p = doc.get<View>(r.parentId); if (!p) break; r = p; }
  return r as T;
}
/** Ansicht, der neue Beschriftungen gehören (bei abhängigen Ansichten die Primäransicht) */
export function annoViewId(doc: Doc, v: View | null | undefined): Id {
  return v ? rootView(doc, v).id : '';
}
/** Beschriftung gehört zur Ansicht (direkt oder über die Primäransicht einer abhängigen Ansicht) */
export const annoIn = (doc: Doc, el: El, v: View): boolean => !!el.viewId && (el.viewId === v.id || (!!v.parentId && el.viewId === annoViewId(doc, v)));
/** Abhängige Ansichten einer Primäransicht */
export const dependentsOf = (doc: Doc, id: Id): View[] => doc.all<View>('view').filter((v) => v.parentId === id);

const jsonEq = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const ownData = (d: any) => { const o: any = {}; for (const k of DEP_OWN_DATA) if (d?.[k] !== undefined) o[k] = d[k]; return o; };
const sharedData = (d: any) => { if (!d) return undefined; const o: any = {}; for (const k of Object.keys(d)) if (!DEP_OWN_DATA.has(k)) o[k] = d[k]; return Object.keys(o).length ? o : undefined; };
/** Patch: geerbte Felder von src übernehmen (eigene Felder von dst bleiben) */
export function inheritPatch(src: View, dst: View): Partial<View> {
  const patch: any = {};
  for (const k of new Set([...Object.keys(src), ...Object.keys(dst)])) {
    if (DEP_OWN.has(k) || k === 'data') continue;
    if (!jsonEq((src as any)[k], (dst as any)[k])) patch[k] = (src as any)[k];
  }
  if (!jsonEq(sharedData(src.data), sharedData(dst.data))) {
    const d = { ...(sharedData(src.data) ?? {}), ...ownData(dst.data) };
    patch.data = Object.keys(d).length ? d : undefined;
  }
  return patch;
}
/** Kopie einer Ansicht unabhängig machen (Duplizieren, Ansichtsfenster kopieren) */
export function detachView(copy: View, src: View): View {
  if (src.parentId) { delete copy.parentId; if (copy.hostId === src.parentId) delete copy.hostId; }
  return copy;
}

/**
 * Abgleich beim Schreiben (am Ende jeder Transaktion, gleicher Rückgängig-Schritt): Änderungen geerbter Felder einer
 * abhängigen Ansicht gehen an die Primäransicht, die Primäransicht überträgt ihre Felder auf alle abhängigen.
 */
export function syncDependents(doc: Doc, before: ReadonlyMap<Id, El | null>): void {
  const touched: View[] = [];
  for (const id of [...before.keys()]) { const v = doc.get<View>(id); if (v?.cat === 'view') touched.push(v); }
  if (!touched.length) return;
  const roots = new Set<Id>();
  for (const v of touched) {
    if (!v.parentId) { roots.add(v.id); continue; }
    const p = rootView(doc, v); if (p === v) continue;
    const b = before.get(v.id) as View | null | undefined;
    if (b) {
      const up = inheritPatch(v, b);         // geänderte geerbte Felder der abhängigen Ansicht
      const patch: any = {};
      for (const k of Object.keys(up)) if (k !== 'data') patch[k] = (v as any)[k];
      if ('data' in up) patch.data = (() => { const d = { ...(sharedData(v.data) ?? {}), ...ownData(p.data) }; return Object.keys(d).length ? d : undefined; })();
      for (const k of Object.keys(patch)) if (jsonEq(patch[k], (p as any)[k])) delete patch[k];
      if (Object.keys(patch).length) doc.update<View>(p.id, patch);
    }
    roots.add(p.id);
  }
  for (const rid of roots) {
    const r = doc.get<View>(rid); if (!r) continue;
    for (const d of dependentsOf(doc, rid)) { const patch = inheritPatch(r, d); if (Object.keys(patch).length) doc.update<View>(d.id, patch); }
  }
}
onCommit(syncDependents);

export const VIEW_KIND_LABEL: Record<ViewKind, string> = {
  plan: 'Grundriss', ceiling: 'Deckenplan', elevation: 'Ansicht', section: 'Schnitt', '3d': '3D-Ansicht',
  drafting: 'Zeichnungsansicht', sheet: 'Plan', schedule: 'Bauteilliste', legend: 'Legende',
};

export const DEFAULT_RANGE: ViewRange = { top: 2300, cut: 1200, bottom: 0, depth: 0 };

export function isModelView(v: View): boolean { return v.kind === 'plan' || v.kind === 'ceiling' || v.kind === 'elevation' || v.kind === 'section' || v.kind === '3d'; }
export function isPlanLike(v: View): boolean { return v.kind === 'plan' || v.kind === 'ceiling'; }
export function isSectionLike(v: View): boolean { return v.kind === 'section' || v.kind === 'elevation'; }
export function is2DView(v: View): boolean { return v.kind !== '3d' && v.kind !== 'schedule'; }

/** Achsen einer Schnitt-/Ansichtsdarstellung. right = Blickrichtung × oben. */
export function sectionAxes(v: View): { origin: V3; right: V3; up: V3; dir: V3 } {
  const d = v.dir ?? { x: 0, y: 1 };
  const dir = norm3({ x: d.x, y: d.y, z: 0 });
  const up = { x: 0, y: 0, z: 1 };
  const right = norm3(cross3(dir, up));
  return { origin: v.origin ?? { x: 0, y: 0, z: 0 }, right, up, dir };
}
export function makeProjector(v: View) {
  const ax = sectionAxes(v);
  return {
    ...ax,
    toView: (p: V3): V2 => { const q = sub3(p, ax.origin); return { x: dot3(q, ax.right), y: dot3(q, ax.up) }; },
    depth: (p: V3): number => dot3(sub3(p, ax.origin), ax.dir),
    toWorld: (p: V2, depth = 0): V3 => add3(add3(add3(ax.origin, mul3(ax.right, p.x)), mul3(ax.up, p.y)), mul3(ax.dir, depth)),
  };
}

// ---------------------------------------------------------------- Ebenen
export interface Level extends El { cat: 'level'; name: string; elev: number; /** Ebene ist Geschoss */ story?: boolean; }
export function levels(doc: Doc): Level[] { return doc.all<Level>('level').sort((a, b) => a.elev - b.elev); }
export function levelElev(doc: Doc, id: Id | undefined | null): number { return doc.get<Level>(id ?? '')?.elev ?? 0; }
export function levelAbove(doc: Doc, id: Id | undefined): Level | undefined {
  const ls = levels(doc); const i = ls.findIndex((l) => l.id === id); return i >= 0 ? ls[i + 1] : undefined;
}
export function levelBelow(doc: Doc, id: Id | undefined): Level | undefined {
  const ls = levels(doc); const i = ls.findIndex((l) => l.id === id); return i > 0 ? ls[i - 1] : undefined;
}
export function nearestLevel(doc: Doc, z: number): Level | undefined {
  let best: Level | undefined; let bd = Infinity;
  for (const l of levels(doc)) { const d = z - l.elev; if (d >= -1 && d < bd) { bd = d; best = l; } }
  return best ?? levels(doc)[0];
}
export const levelOptions = (doc: Doc): [string, string][] => levels(doc).map((l) => [l.id, l.name]);

// ---------------------------------------------------------------- Typen & Materialien
export interface TypeEl extends El { cat: 'type'; of: string; name: string; }
export function typesOf<T extends TypeEl = TypeEl>(doc: Doc, of: string): T[] {
  return doc.all<T>('type').filter((t) => t.of === of).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
export function typeOf<T extends TypeEl = TypeEl>(doc: Doc, el: El): T | undefined { return doc.get<T>(el.typeId); }

export interface Material extends El {
  cat: 'material'; name: string;
  color: string;           // Schattierungsfarbe (3D)
  cutPattern?: string;     // Schnittmuster
  cutColor?: string;
  surfPattern?: string;
  transparency?: number;   // 0..1
  density?: number;        // kg/m³
  description?: string;
}
export function materialOf(doc: Doc, id: Id | undefined): Material | undefined { return doc.get<Material>(id); }
export const materialOptions = (doc: Doc): [string, string][] =>
  doc.all<Material>('material').sort((a, b) => a.name.localeCompare(b.name, 'de')).map((m) => [m.id, m.name]);

export interface ProjectInfo extends El {
  cat: 'project';
  name: string; number: string; client: string; address: string; author: string; status: string; date: string;
  units?: { length: 'mm' | 'cm' | 'm'; decimals: number };
  /** Projektweite Objektstil-Überschreibungen */
  objStyles?: Record<string, { proj?: number; cut?: number; color?: string }>;
  /** Beschriftungsformate je Kategorie (Platzhalter in {…}, z.B. fbh: '{name} · VA {va} cm · {len} m · {power} W') */
  tagFormats?: Record<string, string>;
  /** Bewehrungsüberdeckung (mm) */
  rebarCover?: number;
  /** Landesvorlage: Vorgaben für Bemaßungstyp, Höhenkoten, Plankopf (fehlt = 'DE') */
  locale?: 'DE' | 'CH';
  /** Höhenbezug: ±0.00 = … m ü. M. (Meter) */
  elev00?: number;
  /** Projekt-Basispunkt in Landeskoordinaten (LV95, m): Modellursprung (0,0) = (E, N) – für Importe von Geländepunkten */
  basePoint?: { E: number; N: number };
  /** Plankopf-Vorlage als Projektvorgabe (fehlt = nach Landesvorlage) */
  titleBlock?: string;
}
export function projectInfo(doc: Doc): ProjectInfo { return doc.get<ProjectInfo>('project')!; }

export function cropBox(v: View): BBox | null {
  if (!v.crop || !v.crop.on) return null;
  if (v.kind === 'section' && v.lineA && v.lineB) {
    const len = Math.hypot(v.lineB.x - v.lineA.x, v.lineB.y - v.lineA.y);
    return { min: { x: 0, y: v.crop.min.y }, max: { x: len, y: v.crop.max.y } };
  }
  return { min: v.crop.min, max: v.crop.max };
}
