// Gebäudetechnik (HLKSE): gemeinsame Grundlagen – Systemtypen (Heizung, Lüftung, Sanitär, Elektro) mit
// Farbe, Linienart und Kürzel, Leitungs-/Apparatetypen der Vorlage, Höhenband der Grundrisse, 3D-Hilfen.
import type { Doc, El, Id } from '../../core/doc';
import { registerCategory, onHook, GROUPS, PropDef, Face, PlanCtx } from '../../core/registry';
import { TypeEl, typesOf, levelElev, levelAbove, View } from '../../core/view';
import { V2, V3, add3, sub3, mul3, dot3, cross3, norm3, len3, signedArea } from '../../core/geom';
import { DASH_LABELS, DashName, OBJECT_STYLES, Pen } from '../../render/styles';
import { fmtNum } from '../../core/units';

// ------------------------------------------------------------ Gewerke und Systeme
export type Disc = 'H' | 'L' | 'S' | 'E';
export const DISC_LABEL: Record<Disc, string> = { H: 'Heizung', L: 'Lüftung', S: 'Sanitär', E: 'Elektro' };
export const DISC_OPTIONS: [string, string][] = Object.entries(DISC_LABEL) as [string, string][];

/** Systemtyp (Typ-Element `of: 'mepSystem'`): projektweit, bestimmt Farbe/Linienart/Kürzel der Leitungen */
export interface MepSystem extends TypeEl {
  of: 'mepSystem';
  abbr: string;
  disc: Disc;
  color: string;
  dash: DashName;
  /** Stift (Einstrichdarstellung) */
  pen?: number;
  /** Fliessrichtungspfeile zeichnen */
  flow?: boolean;
  /** IfcDistributionSystemEnum */
  ifc?: string;
  description?: string;
}

/** Vorgabe-Systeme (Farben nach Schweizer Planungspraxis, wie Pläne H/L/S/E-1xx «Hausbau 1») */
export const DEFAULT_SYSTEMS: [Id, string, string, Disc, string, DashName, boolean, string][] = [
  ['sys_hvl', 'Heizung Vorlauf', 'VL', 'H', '#e02020', 'solid', true, 'HEATING'],
  ['sys_hrl', 'Heizung Rücklauf', 'RL', 'H', '#1f4fd8', 'solid', true, 'HEATING'],
  ['sys_fbh', 'Fussbodenheizung Heizkreis', 'FBH', 'H', '#e02020', 'solid', false, 'HEATING'],
  ['sys_zul', 'Lüftung Zuluft', 'ZU', 'L', '#1a9a3a', 'solid', true, 'VENTILATION'],
  ['sys_abl', 'Lüftung Abluft', 'AB', 'L', '#f08000', 'solid', true, 'EXHAUST'],
  ['sys_aul', 'Lüftung Aussenluft', 'AUL', 'L', '#0a9ab0', 'solid', true, 'VENTILATION'],
  ['sys_fol', 'Lüftung Fortluft', 'FOL', 'L', '#8b5a2b', 'solid', true, 'EXHAUST'],
  ['sys_kw', 'Sanitär Kaltwasser', 'KW', 'S', '#1a9a3a', 'solid', true, 'DOMESTICCOLDWATER'],
  ['sys_ww', 'Sanitär Warmwasser', 'WW', 'S', '#e02020', 'solid', true, 'DOMESTICHOTWATER'],
  ['sys_zi', 'Sanitär Zirkulation', 'ZI', 'S', '#e02020', 'dashdot', true, 'DOMESTICHOTWATER'],
  ['sys_sw', 'Sanitär Schmutzwasser', 'SW', 'S', '#8b4513', 'solid', true, 'WASTEWATER'],
  ['sys_rw', 'Sanitär Regenwasser', 'RW', 'S', '#2f7fd0', 'dash', true, 'RAINWATER'],
  ['sys_lr', 'Elektro Leerrohr', 'LR', 'E', '#d0209c', 'dash', false, 'ELECTRICAL'],
  ['sys_kt', 'Elektro Kabeltrasse', 'KT', 'E', '#d0209c', 'solid', false, 'ELECTRICAL'],
  ['sys_erd', 'Elektro Erdung / Fundamenterder', 'ERD', 'E', '#2e7d32', 'dashdot', false, 'EARTHING'],
];

const FALLBACK: MepSystem = { id: '', cat: 'type', of: 'mepSystem', name: 'Ohne System', abbr: '', disc: 'S', color: '#404040', dash: 'solid' };
/** Vorgabe-System je Kategorie (falls ein Element kein gültiges System hat) */
export const DEFAULT_SYS: Record<string, Id> = { pipe: 'sys_kw', duct: 'sys_zul', conduit: 'sys_lr', fbh: 'sys_fbh' };

export function systems(doc: Doc): MepSystem[] { return typesOf<MepSystem>(doc, 'mepSystem'); }
export function systemOptions(doc: Doc, disc?: Disc | Disc[]): [string, string][] {
  const ds = disc ? (Array.isArray(disc) ? disc : [disc]) : null;
  const all = systems(doc);
  const list = ds ? all.filter((s) => ds.includes(s.disc)) : all;
  return (list.length ? list : all).map((s) => [s.id, s.name]);
}
/** System eines Elements (Feld `system`) – mit Rückfall auf das Vorgabesystem der Kategorie */
export function sysOf(doc: Doc, el: El): MepSystem {
  return doc.get<MepSystem>(el.system) ?? doc.get<MepSystem>(DEFAULT_SYS[el.cat]) ?? systems(doc)[0] ?? FALLBACK;
}
export function sysPen(sys: MepSystem, w?: number, dash?: DashName): Pen {
  return { w: w ?? sys.pen ?? 3, color: sys.color, dash: dash ?? sys.dash };
}
/** Gewerke, für die Kategorien Systeme anbieten */
export const CAT_DISC: Record<string, Disc[]> = { pipe: ['H', 'S'], duct: ['L'], conduit: ['E'], fbh: ['H'] };

// ------------------------------------------------------------ Kategorie «Systemtyp» (nur Typen)
function systemTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'abbr', label: 'Kürzel', group: g.identity, type: 'text', get: (t) => t.abbr ?? '', set: (_t, v) => ({ abbr: v }) },
    { key: 'disc', label: 'Gewerk', group: g.identity, type: 'select', options: DISC_OPTIONS, get: (t) => t.disc ?? 'S', set: (_t, v) => ({ disc: v }) },
    { key: 'color', label: 'Farbe', group: g.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    { key: 'dash', label: 'Linienmuster', group: g.graphics, type: 'select', options: Object.entries(DASH_LABELS) as [string, string][], get: (t) => t.dash ?? 'solid', set: (_t, v) => ({ dash: v }) },
    { key: 'pen', label: 'Linienstärke (Stift)', group: g.graphics, type: 'int', get: (t) => t.pen ?? 3, set: (_t, v) => ({ pen: Math.max(1, Math.min(16, Math.round(v))) }) },
    { key: 'flow', label: 'Fliessrichtung anzeigen', group: g.graphics, type: 'bool', get: (t) => !!t.flow, set: (_t, v) => ({ flow: v }) },
    { key: 'ifc', label: 'IFC-Systemart', group: g.other, type: 'text', get: (t) => t.ifc ?? '', set: (_t, v) => ({ ifc: v }) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}
registerCategory({
  // Reine Definitionskategorie (wie ein Bezug): keine Exemplare, nur Typen → nicht in Listen/IFC/Beschriftung
  cat: 'mepSystem', label: 'Systemtyp', plural: 'Systemtypen (HLKSE)', hasTypes: true, datum: true,
  visibleIn: () => false,
  typeProps: () => systemTypeProps(),
});

// Objektstile (Verwalten › Objektstile) der HLKSE-Kategorien
Object.assign(OBJECT_STYLES, {
  pipe: OBJECT_STYLES.pipe ?? { label: 'Rohre', proj: 1, cut: 2 },
  duct: OBJECT_STYLES.duct ?? { label: 'Lüftungskanäle', proj: 1, cut: 2 },
  conduit: OBJECT_STYLES.conduit ?? { label: 'Leerrohre / Kabeltrassen', proj: 1, cut: 2 },
  fbh: OBJECT_STYLES.fbh ?? { label: 'Fussbodenheizkreise', proj: 1 },
  mepFixture: OBJECT_STYLES.mepFixture ?? { label: 'HLKSE-Apparate und -Symbole', proj: 1, cut: 2 },
  schemaSym: OBJECT_STYLES.schemaSym ?? { label: 'Schema-Symbole', proj: 2 },
  schemaLine: OBJECT_STYLES.schemaLine ?? { label: 'Schema-Leitungen', proj: 3 },
});

// ------------------------------------------------------------ Vorlage (Systeme, Leitungs- und Apparatetypen)
const templateFns: ((doc: Doc, has: (id: Id) => boolean) => void)[] = [];
/** Weitere Vorlagen-Typen der Untermodule (Apparate …) */
export function registerMepTemplate(fn: (doc: Doc, has: (id: Id) => boolean) => void): void { templateFns.push(fn); }

export function addType(doc: Doc, has: (id: Id) => boolean, t: Partial<TypeEl> & { id: Id; of: string; name: string }): void {
  if (!has(t.id)) doc.add({ cat: 'type', ...t } as El);
}

export function addMepTemplate(doc: Doc): void {
  const has = (id: Id) => !!doc.get(id);
  for (const [id, name, abbr, disc, color, dash, flow, ifc] of DEFAULT_SYSTEMS) addType(doc, has, { id, of: 'mepSystem', name, abbr, disc, color, dash, flow, ifc, pen: 3 } as any);
  // Rohrtypen
  const pt = (id: Id, name: string, werkstoff: string, dia: number, extra: Record<string, any> = {}) => addType(doc, has, { id, of: 'pipe', name, werkstoff, dia, ...extra } as any);
  pt('mpt_mvr', 'Mehrschichtverbundrohr', 'PE-Xc/Al/PE-Xc', 20, { system: 'sys_kw' });
  pt('mpt_pe', 'PE-HD Abwasser', 'PE-HD', 110, { system: 'sys_sw', sizePrefix: 'DN ' });
  pt('mpt_pexa', 'PE-Xa (FBH)', 'PE-Xa', 16, { system: 'sys_fbh', flexible: true });
  pt('mpt_stahl', 'Stahlrohr', 'Stahl', 28, { system: 'sys_hvl' });
  pt('mpt_cu', 'Kupferrohr', 'Cu', 22, { system: 'sys_hvl' });
  // Lüftungskanäle
  const dt = (id: Id, name: string, werkstoff: string, shape: 'round' | 'rect', dims: Record<string, number>, extra: Record<string, any> = {}) => addType(doc, has, { id, of: 'duct', name, werkstoff, shape, ...dims, ...extra } as any);
  dt('mdt_wfr', 'Wickelfalzrohr verzinkt', 'Stahlblech verzinkt', 'round', { dia: 125 });
  dt('mdt_kanal', 'Rechteckkanal Stahlblech', 'Stahlblech verzinkt', 'rect', { w: 300, h: 200 });
  dt('mdt_einlege', 'Einlegerohr Kunststoff', 'PE', 'round', { dia: 75 }, { flexible: true });
  // Leerrohre / Kabeltrassen
  const ct = (id: Id, name: string, werkstoff: string, shape: 'round' | 'rect', dims: Record<string, number>, extra: Record<string, any> = {}) => addType(doc, has, { id, of: 'conduit', name, werkstoff, shape, ...dims, ...extra } as any);
  ct('mct_krf', 'Leerrohr KRF (flexibel)', 'PE', 'round', { dia: 25 }, { flexible: true });
  ct('mct_kir', 'Leerrohr KIR (starr)', 'PVC', 'round', { dia: 20 });
  ct('mct_trasse', 'Kabeltrasse Stahl verzinkt', 'Stahl verzinkt', 'rect', { w: 200, h: 60 }, { system: 'sys_kt' });
  ct('mct_erder', 'Fundamenterder V4A Ø10', 'Stahl V4A (1.4571)', 'round', { dia: 10 }, { system: 'sys_erd', sizePrefix: 'Ø' });
  for (const f of templateFns) f(doc, has);
}

onHook('template', (doc: Doc) => addMepTemplate(doc));
// Ältere Projekte (ohne HLKSE-Typen) ergänzen
onHook('loaded', (doc: Doc) => {
  if (doc.get('sys_erd') && doc.get('mpt_mvr') && doc.get('mft_pas')) return;
  if (!doc.get('project')) return;
  doc.transaction('Vorlage HLKSE ergänzen', () => addMepTemplate(doc));
  doc.clearHistory();
});
/** Vorlage sicherstellen (vor dem Erzeugen von Elementen, z. B. über die API) */
export function ensureMepTemplate(doc: Doc): void {
  if (doc.get('sys_erd') && doc.get('mpt_mvr') && doc.get('mft_pas')) return;
  doc.transaction('Vorlage HLKSE ergänzen', () => addMepTemplate(doc));
}

// ------------------------------------------------------------ Grundriss: Höhenband
/** Höhenbereich, in dem HLKSE-Elemente im Grundriss erscheinen: ganzes Geschoss (Ebene bis nächste Ebene) */
export function planBand(ctx: PlanCtx): [number, number] {
  const lvl = ctx.level;
  const above = lvl ? levelAbove(ctx.doc, lvl.id) : undefined;
  const lo = Math.min(ctx.bottomZ, ctx.depthZ, lvl?.elev ?? ctx.bottomZ);
  const hi = Math.max(ctx.topZ, ctx.cutZ, above ? above.elev - 1 : ctx.topZ);
  return [lo, hi];
}
/** Gewerkefilter einer Ansicht (HLKSE-Grundriss «Heizung EG» zeigt nur Gewerk H) */
export function discVisible(view: View, disc: Disc): boolean {
  const f = view.data?.mepDisc as string | undefined;
  return !f || f.includes(disc);
}
export const levelZ = (doc: Doc, id: Id | undefined): number => levelElev(doc, id);

// ------------------------------------------------------------ Format
export const fmtMm = (v: number) => fmtNum(Math.round(v * 10) / 10, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1);
export const fmtM = (mm: number, d = 1) => fmtNum(mm / 1000, d) + ' m';

// ------------------------------------------------------------ 3D-Hilfen: Profil entlang Polylinie
const ZV: V3 = { x: 0, y: 0, z: 1 };
/** Lokales Profilsystem zur Richtung d: u = links (horizontal), v = oben, u × v = d */
export function frameOf(d: V3): { u: V3; v: V3 } {
  if (Math.hypot(d.x, d.y) < 1e-6 * Math.max(1, len3(d))) { const u = { x: 1, y: 0, z: 0 }; return { u, v: cross3(d, u) }; }
  const u = norm3(cross3(ZV, d)); return { u, v: cross3(d, u) };
}
export function circleProfile(r: number, n = 12): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) { const a = (i * 2 * Math.PI) / n; out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r }); }
  return out;
}
export function rectProfile(w: number, h: number): V2[] { return [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]; }

/** Profil (u = links, v = oben) entlang eines 3D-Pfads ziehen; Gehrungen an den Knicken. Flächen nach aussen orientiert. */
export function sweep(path: V3[], profile: V2[], caps: [boolean, boolean] = [true, true]): Face[] {
  const P: V3[] = [];
  for (const p of path) if (!P.length || len3(sub3(p, P[P.length - 1])) > 0.01) P.push(p);
  if (P.length < 2 || profile.length < 3) return [];
  const prof = signedArea(profile) > 0 ? profile : profile.slice().reverse();
  const dirs: V3[] = [];
  for (let i = 0; i + 1 < P.length; i++) dirs.push(norm3(sub3(P[i + 1], P[i])));
  const { u, v } = frameOf(dirs[0]);
  let ring = prof.map((q) => add3(P[0], add3(mul3(u, q.x), mul3(v, q.y))));
  const rings = [ring];
  for (let k = 0; k < dirs.length; k++) {
    const d = dirs[k], q = P[k + 1];
    let n = k + 1 < dirs.length ? add3(d, dirs[k + 1]) : d;
    n = len3(n) < 1e-6 ? d : norm3(n);
    const dn = dot3(d, n);
    ring = ring.map((r) => add3(r, mul3(d, dot3(sub3(q, r), n) / (Math.abs(dn) < 1e-3 ? 1e-3 : dn))));
    rings.push(ring);
  }
  const faces: Face[] = [];
  const m = prof.length;
  for (let k = 0; k + 1 < rings.length; k++) {
    const r0 = rings[k], r1 = rings[k + 1];
    for (let j = 0; j < m; j++) { const j1 = (j + 1) % m; faces.push({ pts: [r0[j], r0[j1], r1[j1], r1[j]] }); }
  }
  if (caps[0]) faces.push({ pts: rings[0].slice().reverse() });
  if (caps[1]) faces.push({ pts: rings[rings.length - 1].slice() });
  return faces;
}

/** Quader (Boden-Rechteck in Weltkoordinaten, z0..z1) */
export function boxFaces(ring: V2[], z0: number, z1: number): Face[] {
  const ccw = signedArea(ring) > 0 ? ring : ring.slice().reverse();
  const faces: Face[] = [
    { pts: ccw.map((p) => ({ x: p.x, y: p.y, z: z1 })) },
    { pts: ccw.slice().reverse().map((p) => ({ x: p.x, y: p.y, z: z0 })) },
  ];
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    faces.push({ pts: [{ x: a.x, y: a.y, z: z0 }, { x: b.x, y: b.y, z: z0 }, { x: b.x, y: b.y, z: z1 }, { x: a.x, y: a.y, z: z1 }] });
  }
  return faces;
}

export { dot3, sub3, add3, mul3, norm3, len3, cross3 };
