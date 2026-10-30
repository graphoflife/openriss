// Linienstärken, Linienmuster, Füllmuster und Objektstile (wie "Objektstile" in Revit).

/** Revit-Stiftnummern 1..16 → Papierstärke in mm */
export const PEN_MM = [0, 0.1, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4];
export const penMm = (w: number) => PEN_MM[Math.max(1, Math.min(16, Math.round(w)))] ?? 0.18;

export type DashName = 'solid' | 'dash' | 'hidden' | 'dot' | 'center' | 'dashdot' | 'longdash';
/** Strichmuster in Papier-mm (Strich, Lücke, …) */
export const DASHES: Record<DashName, number[]> = {
  solid: [],
  dash: [3, 1.5],
  hidden: [1.5, 1],
  dot: [0.2, 1],
  center: [8, 1.5, 1, 1.5],
  dashdot: [4, 1.2, 0.3, 1.2],
  longdash: [8, 2],
};
export const DASH_LABELS: Record<DashName, string> = {
  solid: 'Durchgezogen', dash: 'Strich', hidden: 'Verdeckt', dot: 'Punkt', center: 'Strichpunkt (Achse)', dashdot: 'Strich-Punkt', longdash: 'Langer Strich',
};

export interface Pen {
  /** Stiftnummer 1..16 */
  w: number;
  color?: string;
  dash?: DashName;
}
export interface Fill {
  color: string;
  pattern?: string;     // Name eines Füllmusters; leer = Vollfüllung
  patColor?: string;
  alpha?: number;
}

// ---------------------------------------------------------------- Füllmuster
// Muster sind periodische Kacheln in Papier-mm. Gezeichnet über eine kleine Zeichenschnittstelle,
// damit Canvas, SVG und PDF exakt das gleiche Muster bekommen.
export interface TileCtx {
  line(x1: number, y1: number, x2: number, y2: number, w?: number): void;
  dot(x: number, y: number, r: number): void;
  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
}
export interface PatternDef { label: string; w: number; h: number; draw: (t: TileCtx) => void; solid?: boolean }

const diag = (s: number, rev = false): PatternDef => ({
  label: '', w: s * Math.SQRT2, h: s * Math.SQRT2,
  draw: (t) => {
    const w = s * Math.SQRT2;
    if (!rev) { t.line(0, 0, w, w); t.line(-w / 2, w / 2, w / 2, w * 1.5); t.line(w / 2, -w / 2, w * 1.5, w / 2); }
    else { t.line(0, w, w, 0); t.line(-w / 2, w / 2, w / 2, -w / 2); t.line(w / 2, w * 1.5, w * 1.5, w / 2); }
  },
});

export const PATTERNS: Record<string, PatternDef> = {
  solid: { label: 'Vollfüllung', w: 1, h: 1, draw: () => {}, solid: true },
  diag: { ...diag(1.6), label: 'Schraffur 45° (Mauerwerk)' },
  diagWide: { ...diag(3), label: 'Schraffur 45° weit' },
  diagDense: { ...diag(0.8), label: 'Schraffur 45° dicht' },
  diagRev: { ...diag(1.6, true), label: 'Schraffur -45°' },
  cross: {
    label: 'Kreuzschraffur', w: 2 * Math.SQRT2, h: 2 * Math.SQRT2,
    draw: (t) => { diag(2).draw(t); diag(2, true).draw(t); },
  },
  horiz: { label: 'Horizontal', w: 4, h: 1.5, draw: (t) => t.line(-1, 0.75, 5, 0.75) },
  vert: { label: 'Vertikal', w: 1.5, h: 4, draw: (t) => t.line(0.75, -1, 0.75, 5) },
  grid: { label: 'Raster', w: 3, h: 3, draw: (t) => { t.line(0, 0, 3, 0); t.line(0, 0, 0, 3); } },
  concrete: {
    label: 'Beton', w: 7, h: 7,
    draw: (t) => {
      t.dot(1, 1.3, 0.12); t.dot(4.6, 0.8, 0.1); t.dot(2.4, 4.1, 0.12); t.dot(6.1, 5.3, 0.1); t.dot(0.7, 6.2, 0.1);
      t.dot(3.6, 2.6, 0.08); t.dot(5.3, 3.4, 0.08); t.dot(1.9, 5.5, 0.08);
      t.tri(5.5, 1.6, 6.4, 1.9, 5.8, 2.6); t.tri(1.2, 2.9, 1.9, 2.5, 2.0, 3.4); t.tri(3.9, 5.5, 4.8, 5.8, 4.1, 6.5);
    },
  },
  rc: {
    label: 'Stahlbeton', w: 2 * Math.SQRT2 * 2, h: 2 * Math.SQRT2 * 2,
    draw: (t) => {
      const s = 2 * Math.SQRT2 * 2; // zwei Linien je Kachel
      t.line(0, 0, s, s); t.line(-s / 2, s / 2, s / 2, s * 1.5); t.line(s / 2, -s / 2, s * 1.5, s / 2);
      t.dot(s * 0.25, s * 0.7, 0.12); t.dot(s * 0.75, s * 0.2, 0.12); t.tri(s * 0.62, s * 0.62, s * 0.8, s * 0.7, s * 0.66, s * 0.8);
    },
  },
  insulation: {
    label: 'Dämmung', w: 3, h: 3,
    draw: (t) => { t.line(0, 0, 1.5, 3, 0.6); t.line(1.5, 3, 3, 0, 0.6); },
  },
  wood: {
    label: 'Holz', w: 8, h: 3,
    draw: (t) => { t.line(0, 0.5, 8, 0.5); t.line(0, 1.6, 3, 1.4); t.line(3, 1.4, 8, 1.7); t.line(0, 2.6, 5, 2.8); t.line(5, 2.8, 8, 2.6); },
  },
  earth: {
    label: 'Erdreich', w: 6, h: 6,
    draw: (t) => { t.line(0, 6, 6, 0); t.line(1.2, 6, 6, 1.2); t.line(0, 4.8, 4.8, 0); t.dot(4.5, 4.5, 0.12); },
  },
  gravel: {
    label: 'Kies', w: 4, h: 4,
    draw: (t) => { t.dot(1, 1, 0.45); t.dot(3, 2.8, 0.35); t.dot(0.9, 3.2, 0.25); },
  },
  gypsum: {
    label: 'Gipskarton', w: 1.2, h: 1.2,
    draw: (t) => t.dot(0.6, 0.6, 0.09),
  },
  screed: {
    label: 'Estrich', w: 3, h: 1.5,
    draw: (t) => { t.line(0, 0.75, 1.5, 0.75); },
  },
  sand: {
    label: 'Sand', w: 2.5, h: 2.5,
    draw: (t) => { t.dot(0.5, 0.5, 0.07); t.dot(1.8, 1.1, 0.07); t.dot(0.9, 2.0, 0.07); },
  },
};
export const patternOptions = () => [['', 'Keine'] as [string, string], ...Object.entries(PATTERNS).map(([k, p]) => [k, p.label] as [string, string])];

// ---------------------------------------------------------------- Objektstile
export interface ObjStyle {
  label: string;
  proj: number;        // Stift Projektion
  cut?: number;        // Stift Schnitt
  color?: string;
  dash?: DashName;
}
/** Voreinstellungen je Kategorie – überschreibbar in Verwalten > Objektstile (Projekt-Element). */
export const OBJECT_STYLES: Record<string, ObjStyle> = {
  wall: { label: 'Wände', proj: 2, cut: 5 },
  door: { label: 'Türen', proj: 2, cut: 3 },
  window: { label: 'Fenster', proj: 2, cut: 3 },
  floor: { label: 'Geschossdecken', proj: 2, cut: 5 },
  ceiling: { label: 'Decken', proj: 1, cut: 3 },
  roof: { label: 'Dächer', proj: 2, cut: 5 },
  column: { label: 'Stützen', proj: 2, cut: 5 },
  beam: { label: 'Tragwerksträger', proj: 2, cut: 5 },
  foundation: { label: 'Fundamente', proj: 2, cut: 5 },
  stair: { label: 'Treppen', proj: 2, cut: 4 },
  railing: { label: 'Geländer', proj: 1, cut: 3 },
  component: { label: 'Bauteile / Möbel', proj: 1, cut: 2 },
  room: { label: 'Räume', proj: 1 },
  grid: { label: 'Raster', proj: 2, dash: 'center', color: '#000000' },
  level: { label: 'Ebenen', proj: 2, dash: 'center' },
  refplane: { label: 'Referenzebenen', proj: 1, dash: 'dash', color: '#2f8f2f' },
  line: { label: 'Linien', proj: 2 },
  rebar: { label: 'Tragwerksbewehrung', proj: 3, cut: 3, color: '#000000' },
  dimension: { label: 'Bemaßungen', proj: 1 },
  text: { label: 'Text', proj: 1 },
  tag: { label: 'Beschriftungen', proj: 1 },
  section: { label: 'Schnitte', proj: 4 },
  elevation: { label: 'Ansichtssymbole', proj: 2 },
  opening: { label: 'Öffnungen', proj: 2, cut: 2 },
};

export const SEL_COLOR = '#1e6fd9';
export const HOVER_COLOR = '#2f8ff0';
export const HALFTONE = '#a0a0a0';

/** Farbe zu Halbton mischen */
export function halftone(c: string | undefined): string {
  const col = c ?? '#000000';
  const m = col.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return HALFTONE;
  const f = (h: string) => Math.round(parseInt(h, 16) * 0.4 + 255 * 0.6).toString(16).padStart(2, '0');
  return '#' + f(m[1]) + f(m[2]) + f(m[3]);
}
