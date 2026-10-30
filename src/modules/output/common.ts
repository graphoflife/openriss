// Gemeinsame Hilfen für Pläne, Bauteillisten, Druck und Export.
import { app } from '../../app';
import type { Doc, El } from '../../core/doc';
import { catDef, PropDef } from '../../core/registry';
import { View, cropBox } from '../../core/view';
import { DisplayList } from '../../render/displayList';
import { SvgBuilder } from '../../render/svgPainter';
import { BBox, Mat2, boxValid, emptyBox, extendBox } from '../../core/geom';
import { buildViewDL } from '../../views/viewBuilder';

// ------------------------------------------------------------ Papierformate (DIN 476, quer: Breite > Höhe)
export const DIN: Record<string, [number, number]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };
export const SHEET_FORMATS: [string, string][] = Object.keys(DIN).flatMap((k) => [[k + 'q', k + ' quer'], [k + 'h', k + ' hoch']] as [string, string][]);

export function sheetSize(v: View): { w: number; h: number } {
  const s = DIN[v.data?.size ?? 'A1'] ?? DIN.A1;
  return v.data?.portrait ? { w: s[1], h: s[0] } : { w: s[0], h: s[1] };
}
export const formatKey = (v: View) => (v.data?.size ?? 'A1') + (v.data?.portrait ? 'h' : 'q');
export function parseFormat(k: string): { size: string; portrait: boolean } {
  return { size: DIN[k.slice(0, 2)] ? k.slice(0, 2) : 'A1', portrait: k.endsWith('h') };
}

// ------------------------------------------------------------ CSS des Moduls (einmalig)
const cssDone = new Set<string>();
export function injectCss(id: string, css: string): void {
  if (cssDone.has(id)) return;
  cssDone.add(id);
  const s = document.createElement('style'); s.dataset.module = 'output-' + id; s.textContent = css;
  document.head.append(s);
}

// ------------------------------------------------------------ Ansichtseigenschaften je Ansichtsart erweitern
const extraProps = new Map<string, (v: View, doc: Doc, base: PropDef[]) => PropDef[]>();
let wrapped = false;
/** Ergänzt/ersetzt die Eigenschaften der Kategorie 'view' für eine Ansichtsart (Ergebnis des Kerns bleibt erhalten). */
export function extendViewProps(kind: string, fn: (v: View, doc: Doc, base: PropDef[]) => PropDef[]): void {
  extraProps.set(kind, fn);
  if (wrapped) return;
  const def = catDef('view');
  if (!def) return;
  wrapped = true;
  const orig = def.props;
  def.props = (el: El, doc: Doc) => {
    const base = orig ? orig(el, doc) : [];
    const f = extraProps.get((el as View).kind);
    return f ? f(el as View, doc, base) : base;
  };
}

/** Ansicht, die gerade bearbeitet wird */
export const activeView = (): View | null => app.activeView();
export const isSheet = (v: View | null | undefined): boolean => v?.kind === 'sheet';
/** 2D-Ansichten, die gedruckt/exportiert werden können */
export const printable = (v: View | null | undefined): boolean => !!v && v.kind !== '3d';

/** Umfang der sichtbaren Grundelemente (ohne „nur bei Auswahl“/unsichtbare) */
export function contentBox(dl: DisplayList): BBox {
  const b = emptyBox();
  dl.items.forEach((it, i) => {
    if (it.sel || it.inv) return;
    const bb = dl.boxOf(i); if (bb) { extendBox(b, bb.min); extendBox(b, bb.max); }
  });
  return b;
}

// ------------------------------------------------------------ Druck-/Exportseite einer Ansicht
export interface Page {
  view: View;
  dl: DisplayList;
  /** Papiergröße mm */
  w: number; h: number;
  /** Ansichts-mm → Papier-mm (y nach unten) */
  xf: Mat2;
  /** Ausschnitt in Ansichtskoordinaten */
  box: BBox;
}

export function pageOf(doc: Doc, view: View, margin = 10): Page | null {
  if (view.kind === '3d') return null;
  const full = buildViewDL(doc, view);
  if (view.kind === 'sheet') {
    const { w, h } = sheetSize(view);
    const dl = new DisplayList(1);
    dl.items = full.items.filter((it) => it.sub !== 'paperEdge');
    return { view, dl, w, h, xf: { a: 1, b: 0, c: 0, d: -1, e: 0, f: h }, box: { min: { x: 0, y: 0 }, max: { x: w, y: h } } };
  }
  const s = view.kind === 'schedule' ? 1 : view.scale || 100;
  let box = cropBox(view) ?? contentBox(full);
  if (!boxValid(box)) box = { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } };
  const w = (box.max.x - box.min.x) / s + margin * 2, h = (box.max.y - box.min.y) / s + margin * 2;
  const xf: Mat2 = { a: 1 / s, b: 0, c: 0, d: -1 / s, e: margin - box.min.x / s, f: margin + box.max.y / s };
  return { view, dl: full, w, h, xf, box };
}

export function pageSvg(p: Page, monochrome = false): string {
  const sb = new SvgBuilder();
  sb.add(p.dl, { xf: p.xf, monochrome });
  return sb.toString(p.w, p.h);
}

/** Dateiname aus Ansicht */
export function fileBase(v: View): string {
  const n = v.kind === 'sheet' ? `${v.sheetNo ?? ''} - ${v.name}` : v.name;
  return n.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Ansicht';
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
