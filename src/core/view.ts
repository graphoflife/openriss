// Ansichten: Grundriss, Deckenplan, Ansicht, Schnitt, 3D, Zeichnungsansicht, Plan (Blatt), Bauteilliste.
import type { El, Doc, Id } from './doc';
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
}

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
