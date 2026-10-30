// Tragwerk – gemeinsame Hilfen: Profile, Typen der Vorlage, Grundrissdarstellung (Schnitt/verdeckt),
// Bounding-Boxen von Körpern, Beton-Erkennung.
import type { Doc, El, Id } from '../../core/doc';
import { V2, V3, fromAngle, signedArea } from '../../core/geom';
import { GROUPS, PlanCtx, PropDef } from '../../core/registry';
import { TypeEl, levelAbove, materialOf, typesOf } from '../../core/view';
import { cached } from '../../core/cache';
import { catPen, cutFill, solidsOf } from '../../views/sectionEngine';
import { mat } from '../../core/template';
import { fmtNum } from '../../core/units';

/** Kategorien, die Bewehrung aufnehmen können (Host) */
export const HOST_CATS = ['wall', 'floor', 'column', 'beam', 'foundationIsolated', 'foundationWall', 'foundationSlab'];
/** Eigene Bewehrungskategorien (folgen ihrem Host) */
export const REBAR_CATS = ['rebar', 'areaRebar', 'fabricArea'];
export const REBAR_COLOR = '#8b1a1a';

// ------------------------------------------------------------ Profile
export type ProfShape = 'rect' | 'round' | 'I';
/** Querschnittstyp (Stütze, Träger): b = Breite (lokal x), h = Höhe (lokal y), rund: Durchmesser = b */
export interface ProfType extends TypeEl { shape: ProfShape; b: number; h: number; tw?: number; tf?: number; mat?: Id; description?: string }

export const SHAPE_LABELS: [string, string][] = [['rect', 'Rechteck (Beton)'], ['round', 'Rund (Beton)'], ['I', 'I-Profil (Stahl)']];

/** Querschnitt als Ring (gegen den Uhrzeigersinn), zentriert */
export function profileRing(t: Partial<ProfType> | undefined): V2[] {
  const shape = t?.shape ?? 'rect';
  const b = t?.b ?? 300, h = shape === 'round' ? b : t?.h ?? 300;
  if (shape === 'round') {
    const n = 32; const out: V2[] = [];
    for (let i = 0; i < n; i++) out.push(fromAngle((i / n) * Math.PI * 2, b / 2));
    return out;
  }
  if (shape === 'I') {
    const tw = t?.tw ?? b * 0.05, tf = t?.tf ?? h * 0.07;
    const x = b / 2, y = h / 2, w = tw / 2;
    return [
      { x: -x, y: -y }, { x, y: -y }, { x, y: -y + tf }, { x: w, y: -y + tf }, { x: w, y: y - tf }, { x, y: y - tf },
      { x, y }, { x: -x, y }, { x: -x, y: y - tf }, { x: -w, y: y - tf }, { x: -w, y: -y + tf }, { x: -x, y: -y + tf },
    ];
  }
  return [{ x: -b / 2, y: -h / 2 }, { x: b / 2, y: -h / 2 }, { x: b / 2, y: h / 2 }, { x: -b / 2, y: h / 2 }];
}
export function profileArea(t: Partial<ProfType> | undefined): number { return Math.abs(signedArea(profileRing(t))); }

export function profTypeProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'shape', label: 'Querschnittsform', group: g.construction, type: 'select', options: SHAPE_LABELS, get: (t) => t.shape ?? 'rect', set: (_t, v) => ({ shape: v }) },
    { key: 'b', label: 'b (Breite / Ø)', group: g.dims, type: 'length', get: (t) => t.b, set: (_t, v) => (v > 0 ? { b: v } : undefined) },
    { key: 'h', label: 'h (Höhe)', group: g.dims, type: 'length', get: (t) => t.h, set: (_t, v) => (v > 0 ? { h: v } : undefined) },
    { key: 'tw', label: 'Stegdicke', group: g.dims, type: 'length', get: (t) => t.tw ?? 0, set: (_t, v) => ({ tw: v }) },
    { key: 'tf', label: 'Flanschdicke', group: g.dims, type: 'length', get: (t) => t.tf ?? 0, set: (_t, v) => ({ tf: v }) },
    { key: 'mat', label: 'Tragwerksmaterial', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 'area', label: 'Querschnittsfläche', group: g.dims, type: 'readonly', get: (t) => fmtNum(profileArea(t as ProfType) / 100, 1) + ' cm²' },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

export function identityProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}

// ------------------------------------------------------------ Material
export function isConcrete(doc: Doc, id: Id | undefined): boolean {
  if (!id) return true;
  const m = materialOf(doc, id);
  if (!m) return true;
  return m.cutPattern === 'rc' || m.cutPattern === 'concrete' || /beton|stb/i.test(m.name);
}
export const fmtM3 = (mm3: number) => fmtNum(mm3 / 1e9, 3) + ' m³';
export const fmtKg = (kg: number) => fmtNum(kg, 1) + ' kg';

// ------------------------------------------------------------ Grundriss
export interface PlanOpts {
  /** Darstellung unterhalb der Schnittebene */
  below: 'proj' | 'hidden';
  /** unterhalb nur bis zu dieser Höhe (absolut) zeigen */
  belowLimit?: number;
  /** oberhalb der Schnittebene gestrichelt bis zu dieser Höhe */
  aboveLimit?: number;
}

/** Grundrissdarstellung eines Tragwerkselements: Schnitt (Materialmuster) oder Umriss (sichtbar/verdeckt) */
export function drawStructPlan(ctx: PlanCtx, styleCat: string, polys: V2[][][], z0: number, z1: number, matId: Id | undefined, o: PlanOpts): boolean {
  const { dl, doc } = ctx;
  if (z0 <= ctx.cutZ && z1 > ctx.cutZ) {
    const m = materialOf(doc, matId);
    const fill = cutFill(m?.cutPattern, m?.cutColor, ctx.detail);
    const pen = catPen(doc, styleCat, true);
    for (const p of polys) dl.fill(p, fill, pen);
    return true;
  }
  const proj = catPen(doc, styleCat, false);
  if (z1 <= ctx.cutZ) {
    if (z1 < (o.belowLimit ?? ctx.depthZ) - 1) return false;
    const pen = o.below === 'hidden' ? { ...proj, dash: 'hidden' as const } : proj;
    for (const p of polys) for (const r of p) dl.poly(r, pen, true);
    return true;
  }
  if (o.aboveLimit !== undefined && z0 < o.aboveLimit) {
    const pen = { ...proj, dash: 'hidden' as const };
    for (const p of polys) for (const r of p) dl.poly(r, pen, true);
    return true;
  }
  return false;
}

/** Oberkante des Geschosses der Grundrissansicht (für Unterzüge oberhalb der Schnittebene) */
export function storyTop(ctx: PlanCtx): number {
  const above = levelAbove(ctx.doc, ctx.view.levelId);
  return Math.max(ctx.topZ, (above?.elev ?? ctx.topZ) + 1);
}

// ------------------------------------------------------------ Körper
export interface Box3 { min: V3; max: V3 }
/** Bounding-Box aller Körper eines Elements (gecacht) */
export function solidBox(doc: Doc, el: El, matFilter?: Id | null): Box3 | null {
  return cached(doc, 'stSolidBox', el.id + '|' + (matFilter ?? '*'), () => {
    const b: Box3 = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    for (const s of solidsOf(doc, el)) {
      if (matFilter !== undefined && matFilter !== null && s.mat !== matFilter) continue;
      for (const f of s.faces) for (const p of f.pts) {
        if (p.x < b.min.x) b.min.x = p.x; if (p.y < b.min.y) b.min.y = p.y; if (p.z < b.min.z) b.min.z = p.z;
        if (p.x > b.max.x) b.max.x = p.x; if (p.y > b.max.y) b.max.y = p.y; if (p.z > b.max.z) b.max.z = p.z;
      }
    }
    return isFinite(b.min.x) ? b : null;
  });
}

// ------------------------------------------------------------ Vorlage (Typen, Material)
type TypeSpec = Partial<El> & { id: string; of: string; name: string };
function typeSpecs(): TypeSpec[] {
  const stb = 'm_stb', st = 'm_stahl';
  const col = (id: string, name: string, shape: ProfShape, b: number, h: number, m: string, tw?: number, tf?: number): TypeSpec => ({ id, of: 'column', name, shape, b, h, mat: m, tw, tf });
  const bm = (id: string, name: string, shape: ProfShape, b: number, h: number, m: string, tw?: number, tf?: number): TypeSpec => ({ id, of: 'beam', name, shape, b, h, mat: m, tw, tf });
  return [
    col('ct_stb2525', 'STB rechteckig 25 x 25', 'rect', 250, 250, stb),
    col('ct_stb3030', 'STB rechteckig 30 x 30', 'rect', 300, 300, stb),
    col('ct_stb3050', 'STB rechteckig 30 x 50', 'rect', 300, 500, stb),
    col('ct_stbr30', 'STB rund Ø30', 'round', 300, 300, stb),
    col('ct_stbr40', 'STB rund Ø40', 'round', 400, 400, stb),
    col('ct_heb200', 'Stahl HEB 200', 'I', 200, 200, st, 9, 15),
    col('ct_heb240', 'Stahl HEB 240', 'I', 240, 240, st, 10, 17),
    col('ct_ipe300', 'Stahl IPE 300', 'I', 150, 300, st, 7.1, 10.7),
    bm('bt_stb3050', 'STB 30/50', 'rect', 300, 500, stb),
    bm('bt_stb2540', 'STB 25/40', 'rect', 250, 400, stb),
    bm('bt_stb3060', 'STB 30/60', 'rect', 300, 600, stb),
    bm('bt_ipe300', 'Stahl IPE 300', 'I', 150, 300, st, 7.1, 10.7),
    bm('bt_heb300', 'Stahl HEB 300', 'I', 300, 300, st, 11, 19),
    { id: 'fi_808040', of: 'foundationIsolated', name: '80 x 80 x 40', b: 800, l: 800, t: 400, mat: stb },
    { id: 'fi_10010050', of: 'foundationIsolated', name: '100 x 100 x 50', b: 1000, l: 1000, t: 500, mat: stb },
    { id: 'fi_12012060', of: 'foundationIsolated', name: '120 x 120 x 60', b: 1200, l: 1200, t: 600, mat: stb },
    { id: 'fi_15015070', of: 'foundationIsolated', name: '150 x 150 x 70', b: 1500, l: 1500, t: 700, mat: stb },
    { id: 'fw_5040', of: 'foundationWall', name: 'Streifenfundament 50 x 40', b: 500, t: 400, mat: stb },
    { id: 'fw_6040', of: 'foundationWall', name: 'Streifenfundament 60 x 40', b: 600, t: 400, mat: stb },
    { id: 'fw_8050', of: 'foundationWall', name: 'Streifenfundament 80 x 50', b: 800, t: 500, mat: stb },
    { id: 'fs_250', of: 'foundationSlab', name: 'Bodenplatte 25 cm', t: 250, mat: stb },
    { id: 'fs_300', of: 'foundationSlab', name: 'Bodenplatte 30 cm', t: 300, mat: stb },
    { id: 'fs_400', of: 'foundationSlab', name: 'Fundamentplatte 40 cm', t: 400, mat: stb },
    { id: 'fs_600', of: 'foundationSlab', name: 'Fundamentplatte 60 cm', t: 600, mat: stb },
  ];
}

/** Betonstahl-Material anlegen (in Transaktion aufrufen) */
export function ensureRebarMaterial(doc: Doc): void {
  if (!doc.get('m_betonstahl')) mat(doc, 'm_betonstahl', 'Betonstahl B500B', REBAR_COLOR, 'solid', { cutColor: '#000000', density: 7850, description: 'Betonstahl B500B nach DIN 488' });
}

/** Vorlagentypen ergänzen, falls für eine Kategorie noch keine Typen existieren (in Transaktion) */
export function addTemplateTypes(doc: Doc, onlyCat?: string): void {
  ensureRebarMaterial(doc);
  const specs = typeSpecs();
  const cats = [...new Set(specs.map((s) => s.of))].filter((c) => !onlyCat || c === onlyCat);
  for (const c of cats) {
    if (typesOf(doc, c).length) continue;
    for (const s of specs) if (s.of === c && !doc.get(s.id)) doc.add({ ...s, cat: 'type' } as El);
  }
}

/** Für Werkzeuge: Typen bei Bedarf in eigener Transaktion anlegen */
export function ensureTypes(doc: Doc, cat: string): void {
  if (typesOf(doc, cat).length && doc.get('m_betonstahl')) return;
  doc.transaction('Tragwerkstypen ergänzen', () => addTemplateTypes(doc, cat));
}
