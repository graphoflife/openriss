// Gemeinsame Hilfen der Beschriftungen: Markierungen/Pfeile, Textumbruch, Vorschau-Einfärbung,
// Ankerpunkte für Beschriftungen, Typ-Werte und Erkennung "Host wird mitbewegt".
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import {
  V2, add, sub, mul, norm, perp, fromAngle, rotate, emptyBox, extendBox, boxValid, angleOf,
} from '../../core/geom';
import { DisplayList, textWidth } from '../../render/displayList';
import type { Pen, Fill } from '../../render/styles';
import { View, isPlanLike, isSectionLike, makeProjector, typesOf } from '../../core/view';
import { catDef } from '../../core/registry';
import { solidsOf } from '../../views/sectionEngine';
import type { PlacementTarget } from '../../tools/tool';
import { cached } from '../../core/cache';
import { normTextAngle } from '../../elements/datums';

export const PREV_COL = '#1e6fd9';
/** Alle 2D-Ansichten, in denen Beschriftungen möglich sind */
export const ANNO_KINDS = ['plan', 'ceiling', 'section', 'elevation', 'drafting', 'legend'];
export const MODEL_2D = ['plan', 'ceiling', 'section', 'elevation'];

export const FONTS: [string, string][] = [
  ['Arial', 'Arial'], ['Arial Narrow', 'Arial Narrow'], ['ISOCPEUR', 'ISOCPEUR'], ['Times New Roman', 'Times New Roman'], ['Courier New', 'Courier New'],
];
export const fontFamily = (f: string | undefined): string => `${f && f !== 'Arial' ? `"${f}", ` : ''}Arial, Helvetica, sans-serif`;
/** Breitenfaktor eines Typs: eigener Wert, sonst Vorgabe der Schrift (Schmalschrift 0.82) */
export const typeWf = (t: { widthFactor?: number; font?: string } | undefined): number | undefined => (t?.widthFactor && t.widthFactor > 0 ? t.widthFactor : undefined);
/** Typeigenschaft «Breitenfaktor» (wie in CAD: 1 = normal, 0.82 ≈ Arial Narrow) */
export const widthFactorProp = (group: string): any => ({
  key: 'widthFactor', label: 'Breitenfaktor', group, type: 'number',
  get: (t: any) => t.widthFactor ?? (/narrow|condensed|schmal/i.test(t.font ?? '') ? 0.82 : 1),
  set: (_t: any, v: number) => ({ widthFactor: v > 0.2 && v <= 3 ? v : undefined }),
});

export const solid = (color: string): Fill => ({ color, pattern: 'solid', patColor: color });

// ------------------------------------------------------------ Typwerte
/** Typ-Parameter lesen (mit Vorgabewert) */
export function tv<T>(doc: Doc, el: El, key: string, def: T): T {
  const t = doc.get(el.typeId);
  const v = t?.[key];
  return v === undefined || v === null || v === '' && typeof def !== 'string' ? def : (v as T);
}
/** Instanzwert, sonst Typwert */
export function iv<T>(doc: Doc, el: El, key: string, def: T): T {
  const v = el[key];
  return v === undefined || v === null ? tv(doc, el, key, def) : (v as T);
}

// ------------------------------------------------------------ Markierungen
export type TickKind = 'slash' | 'dot' | 'arrow' | 'arrowOpen' | 'none';
export const TICK_OPTIONS: [string, string][] = [
  ['slash', 'Schrägstrich'], ['dot', 'Punkt'], ['arrow', 'Pfeil gefüllt'], ['arrowOpen', 'Pfeil offen'], ['none', 'Keine'],
];

/**
 * Markierung am Punkt p. d = Richtung, in die ein Pfeil zeigt (Spitze bei p).
 * Für den Schrägstrich bestimmt rd (Leserichtung) die Neigung ("/").
 */
export function drawTick(dl: DisplayList, p: V2, d: V2, kind: TickKind, size: number, pen: Pen, rd?: V2): void {
  const s = dl.scale; const L = size * s; const col = pen.color ?? '#000000';
  switch (kind) {
    case 'slash': {
      const t = rotate(norm(rd ?? d), Math.PI / 4);
      dl.line(sub(p, mul(t, L / 2)), add(p, mul(t, L / 2)), pen, { ns: true });
      break;
    }
    case 'dot': dl.circle(p, Math.max(0.3, size * 0.18) * s, undefined, solid(col), { ns: true }); break;
    case 'arrow': case 'arrowOpen': {
      const u = norm(d); const n = perp(u); const back = sub(p, mul(u, L)); const hw = L * 0.27;
      const w1 = add(back, mul(n, hw)), w2 = sub(back, mul(n, hw));
      if (kind === 'arrow') dl.fill([[p, w1, w2]], solid(col), undefined, { ns: true });
      else dl.poly([w1, p, w2], { ...pen, w: Math.max(1, pen.w) }, false, { ns: true });
      break;
    }
    default: break;
  }
}

/** Führungslinie mit Endmarkierung (Pfeil an pts[last]) */
export function drawLeader(dl: DisplayList, pts: V2[], kind: TickKind, size: number, pen: Pen): void {
  if (pts.length < 2) return;
  dl.poly(pts, pen, false, { ns: true });
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  if (kind !== 'none') drawTick(dl, b, sub(b, a), kind === 'slash' ? 'dot' : kind, size, pen, sub(b, a));
}

// ------------------------------------------------------------ Text
/** Zeilenumbruch nach Breite (Ansichts-mm); maxW = null → nur harte Umbrüche */
export function wrapText(s: string, maxW: number | null, size: number): string[] {
  const out: string[] = [];
  for (const line of s.split('\n')) {
    if (!maxW) { out.push(line); continue; }
    let cur = '';
    for (const w of line.split(' ')) {
      const cand = cur ? cur + ' ' + w : w;
      if (cur && textWidth(cand, size) > maxW) { out.push(cur); cur = w; } else cur = cand;
    }
    out.push(cur);
  }
  return out;
}

/** Lesbarer Textwinkel und "oben"-Vektor zu einer Richtung */
export function readable(d: V2): { ang: number; dir: V2; up: V2 } {
  const ang = normTextAngle(angleOf(d)); const dir = fromAngle(ang);
  return { ang, dir, up: perp(dir) };
}

/** Rechteck (lokales System) → Eckpunkte */
export function rectPts(o: V2, ex: V2, ey: V2, x0: number, y0: number, x1: number, y1: number): V2[] {
  const P = (x: number, y: number) => add(o, add(mul(ex, x), mul(ey, y)));
  return [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
}

/** Langloch/Oval um einen Mittelpunkt (halbe Breite a, halbe Höhe b; a >= b) */
export function stadium(c: V2, ex: V2, ey: V2, a: number, b: number): V2[] {
  const pts: V2[] = []; const m = a - b; const n = 12;
  for (let i = 0; i <= n; i++) { const t = -Math.PI / 2 + (Math.PI * i) / n; pts.push(add(c, add(mul(ex, m + b * Math.cos(t)), mul(ey, b * Math.sin(t))))); }
  for (let i = 0; i <= n; i++) { const t = Math.PI / 2 + (Math.PI * i) / n; pts.push(add(c, add(mul(ex, -m + b * Math.cos(t)), mul(ey, b * Math.sin(t))))); }
  return pts;
}

// ------------------------------------------------------------ Vorschau
/** Grundelemente ab Index i0 einfärben (Werkzeugvorschau) */
export function tint(dl: DisplayList, i0 = 0, color = PREV_COL): void {
  for (let i = i0; i < dl.items.length; i++) {
    const it: any = dl.items[i];
    if (it.pen) it.pen = { ...it.pen, color };
    if (it.k === 'text') it.font = { ...it.font, color, opaque: false };
    if (it.k === 'fill') it.fill = it.fill.pattern === 'solid' && it.fill.patColor !== '#ffffff' ? solid(color) : { color: 'transparent' };
    if (it.k === 'circle' && it.fill) it.fill = solid(color);
    it.ns = true;
  }
}

/** Element mit einer Kategorie-Zeichenfunktion als Vorschau zeichnen */
export function previewEl(dl: DisplayList, el: El, view: View): void {
  const def = catDef(el.cat); if (!def?.drawAnnotation) return;
  const i0 = dl.items.length;
  try { def.drawAnnotation(dl, el, app.doc, view); } catch (e) { console.warn(e); }
  tint(dl, i0);
}

// ------------------------------------------------------------ Anker für Beschriftungen
/** Bezugspunkt eines Modellelements in der Ansicht (Grundriss: tagPoint; Schnitt: Mitte der Körper) */
export function anchorInView(doc: Doc, el: El, view: View): V2 | null {
  const def = catDef(el.cat);
  if (isPlanLike(view)) {
    try { return def?.tagPoint?.(el, doc, view) ?? def?.center?.(el, doc, view) ?? null; } catch { return null; }
  }
  if (isSectionLike(view)) {
    return cached(doc, 'annoAnchor', view.id + '|' + el.id, () => {
      const pr = makeProjector(view); const b = emptyBox();
      for (const s of solidsOf(doc, el)) for (const f of s.faces) for (const p of f.pts) extendBox(b, pr.toView(p));
      return boxValid(b) ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 } : null;
    });
  }
  return null;
}

// ------------------------------------------------------------ Mitbewegen mit dem Host
const copiedWithHost = new Set<Id>();
/** Kopie, deren Host im selben Vorgang mitkopiert wurde (folgt dem Host, nicht verschieben) */
export function markCopiedWithHost(id: Id): void {
  copiedWithHost.add(id);
  setTimeout(() => copiedWithHost.delete(id), 0);
}
/** Wird der Bezug (oder dessen Host) im selben Vorgang mittransformiert? */
export function hostMovesToo(el: El): boolean {
  if (copiedWithHost.has(el.id)) return true;
  if (!app.selection.has(el.id)) return false;
  let id: Id | undefined = el.refId; let n = 0;
  while (id && n++ < 6) {
    const h = app.doc.get(id);
    if (app.selection.has(id) && h && !h.pinned) return true;
    id = h?.hostId;
  }
  return false;
}

// ------------------------------------------------------------ Typen
/** Typen einer Kategorie sicherstellen (ältere Projekte ohne Beschriftungstypen) */
const typeMakers = new Map<string, (doc: Doc) => void>();
export function registerTypeMaker(cat: string, fn: (doc: Doc) => void): void { typeMakers.set(cat, fn); }
export function ensureTypes(...catsIn: string[]): void {
  const doc = app.doc;
  const missing = catsIn.filter((c) => typeMakers.has(c) && typesOf(doc, c).length === 0);
  if (!missing.length) return;
  doc.transaction('Beschriftungstypen laden', () => { for (const c of missing) typeMakers.get(c)!(doc); });
}
/** Typ mit fester ID anlegen (falls nicht vorhanden) */
export function addType(doc: Doc, id: Id, of: string, name: string, fields: Record<string, any>): void {
  if (doc.get(id)) return;
  doc.add({ id, cat: 'type', of, name, ...fields });
}
export function typeIdOr(doc: Doc, cat: string, preferred: Id): Id | undefined {
  return doc.get(preferred) ? preferred : typesOf(doc, cat)[0]?.id;
}

/** Platzierungsvorgabe (Typ + Parameter) je Werkzeug merken – unabhängig von placementFor */
const lastPl = new Map<string, El>();
export function myPlacement(key: string, cat: string, defType: Id | undefined, defaults: Record<string, any> = {}): PlacementTarget {
  const doc = app.doc;
  const prev = lastPl.get(key);
  const proto: El = { id: '', cat, ...defaults, ...(prev ?? {}) } as El;
  if (!proto.typeId || !doc.get(proto.typeId)) proto.typeId = (defType && doc.get(defType) ? defType : typesOf(doc, cat)[0]?.id);
  const t: PlacementTarget = {
    cat, proto, typeId: proto.typeId,
    setType: (id) => { proto.typeId = id; t.typeId = id; app.emit('tool'); },
  };
  lastPl.set(key, proto);
  return t;
}

export { textWidth, normTextAngle };
