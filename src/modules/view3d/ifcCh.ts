// IFC-Export – Schweizer Tragwerksangaben (SIA 262 / SN EN 206, NPK): Betonsorte, Expositionsklassen,
// NPK-Sorte, Überdeckung, WU. Quelle der Reihe nach: Element → Typ → Material → Text (Kommentare, Typname,
// Beschreibung, Materialname). Zusätzlich optionale Typ-Eigenschaften zum Erfassen (additiv angehängt).
import type { Doc, El, Id } from '../../core/doc';
import { catDef, GROUPS, PropDef } from '../../core/registry';
import type { Material } from '../../core/view';

/** Kategorien mit Betonangaben (Tragwerksbauteile) */
export const CONCRETE_CATS = ['wall', 'floor', 'column', 'beam', 'stair', 'foundationIsolated', 'foundationWall', 'foundationSlab'];

export interface ConcreteData {
  /** Festigkeitsklasse, z.B. «C30/37» */
  grade?: string;
  /** Expositionsklassen, z.B. «XC4(CH), XF1(CH)» */
  exposure?: string;
  /** NPK-Betonsorte, z.B. «NPK C» */
  npk?: string;
  /** Bewehrungsüberdeckung c_nom (mm) */
  cover?: number;
  /** wasserundurchlässig */
  wu?: boolean;
  /** Herstellung: Ortbeton / Fertigteil */
  method?: string;
}

const RX_GRADE = /\b(L?C\d{2,3}\/\d{2,3})\b/;
const RX_EXPO = /\bX(?:0|C[1-4]|D[1-3]|S[1-3]|F[1-4]|A[1-3]|M[1-3])(?:\s*\(CH\))?/g;
const RX_NPK = /\bNPK\s*([A-G])\b/;

/** Kernmaterial eines Bauteils (Schichttyp: tragende Schicht, sonst Typ-/Elementmaterial) */
export function coreMaterialId(doc: Doc, el: El): Id | undefined {
  const t = doc.get(el.typeId);
  const layers: { mat: Id; core?: boolean }[] | undefined = t?.layers;
  if (layers?.length) return (layers.find((l) => l.core) ?? layers[0]).mat;
  return t?.mat ?? el.mat;
}

export function isConcreteMat(m: Material | undefined): boolean {
  return !!m && (m.cutPattern === 'rc' || m.cutPattern === 'concrete' || /beton|stb\b|concrete/i.test(m.name));
}

const str = (v: any): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Betonangaben eines Bauteils (null: kein Betonbauteil und keine Angaben) */
export function concreteData(doc: Doc, el: El, cover?: number): ConcreteData | null {
  const t = doc.get(el.typeId);
  const m = doc.get<Material>(coreMaterialId(doc, el));
  const mat = m?.cat === 'material' ? m : undefined;
  const field = (k: string): string | undefined => str(el[k]) ?? str(t?.[k]) ?? str((mat as any)?.[k]);
  const texts = [el.comments, el.mark, t?.name, t?.description, mat?.name, mat?.description].filter((s): s is string => typeof s === 'string');
  const parse = (rx: RegExp): string | undefined => { for (const s of texts) { const r = rx.exec(s); if (r) return r[1] ?? r[0]; } return undefined; };
  const grade = field('concreteGrade') ?? parse(RX_GRADE);
  let exposure = field('exposure');
  if (!exposure) {
    for (const s of texts) { const all = s.match(RX_EXPO); if (all?.length) { exposure = [...new Set(all.map((x) => x.replace(/\s+/g, '')))].join(', '); break; } }
  }
  let npk = field('npk');
  if (!npk) { const r = parse(RX_NPK); if (r) npk = 'NPK ' + r; }
  const conc = isConcreteMat(mat) || !!grade || !!npk;
  if (!conc) return null;
  const wuF = el.wu ?? t?.wu;
  const wu = typeof wuF === 'boolean' ? wuF : texts.some((s) => /\bWU\b|wasserundurchl/i.test(s));
  const method = str(el.construction) ?? str(t?.construction);
  return { grade, exposure, npk, cover, wu, method: method && /fertig|precast/i.test(method) ? 'Precast' : 'In-Situ' };
}

/** Betonsorte als Text (NPK-Sorte mit Festigkeits- und Expositionsklassen) */
export function concreteLabel(c: ConcreteData): string {
  const parts = [c.grade, c.exposure].filter(Boolean).join(', ');
  return c.npk ? c.npk + (parts ? ': ' + parts : '') : parts;
}

// ------------------------------------------------------------ Typ-Eigenschaften (optional, additiv)
const wrapped = new Set<string>();
/** Betonangaben als Typ-Eigenschaften der Tragwerkskategorien anbieten (idempotent) */
export function installConcreteTypeProps(): void {
  for (const cat of CONCRETE_CATS) {
    const def = catDef(cat);
    if (!def || wrapped.has(cat) || !def.typeProps) continue;
    wrapped.add(cat);
    const orig = def.typeProps;
    const g = GROUPS.structural;
    const txt = (key: string, label: string): PropDef => ({ key, label, group: g, type: 'text', get: (t) => t[key] ?? '', set: (_t, v) => ({ [key]: String(v).trim() || undefined }) });
    // nur bei Betontypen (Kernmaterial Beton) oder bereits erfassten Werten
    def.typeProps = (type, doc) => {
      const base = orig(type, doc);
      const m = doc.get<Material>(coreMaterialId(doc, type));
      if (!isConcreteMat(m) && !type.concreteGrade && !type.exposure && !type.npk) return base;
      return [...base, txt('concreteGrade', 'Betonfestigkeitsklasse (z.B. C30/37)'), txt('exposure', 'Expositionsklassen (z.B. XC4(CH), XF1(CH))'), txt('npk', 'NPK-Betonsorte (z.B. NPK C)')];
    };
  }
}
