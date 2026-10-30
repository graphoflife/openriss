// Ansichtsfenster auf Plänen: Beschriftungselement 'viewport' (viewId = Plan, refId = Ansicht).
// Zeichnet die Display-Liste der Ansicht im Maßstab 1:scale (Plan-mm = Ansichts-mm / scale) plus Ansichtstitel.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, registerContextPanel, onHook, GROUPS, dlBuilder } from '../../core/registry';
import { View, cropBox, VIEW_KIND_LABEL } from '../../core/view';
import { DisplayList, Prim, transformPrim, textWidth } from '../../render/displayList';
import { V2, BBox, Mat2, apply, add, sub, boxValid, boxCorners } from '../../core/geom';
import { buildViewDL } from '../../views/viewBuilder';
import { Tool, ToolEvent } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { SCALES } from '../../ui/viewControlBar';
import { isSheet, contentBox } from './common';

export interface Viewport extends El {
  cat: 'viewport';
  viewId: Id;        // Plan
  refId: Id;         // platzierte Ansicht (Löschen der Ansicht entfernt das Ansichtsfenster)
  center: V2;        // Plan-mm: Lage des Ankers
  anchor: V2;        // Ansichts-mm: Punkt der Ansicht, der auf center liegt
  detail: string;    // Detailnummer
  showTitle?: boolean;
  titleOff?: V2;     // Verschiebung des Titels (Plan-mm)
}

/** Ansichten, die mehrfach platziert werden dürfen (wie Revit: Legenden, Bauteillisten) */
export const multiPlace = (v: View) => v.kind === 'legend' || v.kind === 'schedule';
export const viewportsOf = (doc: Doc, viewId: Id) => doc.all<Viewport>('viewport').filter((vp) => vp.refId === viewId);

/** Fehlermeldung, falls die Ansicht nicht auf den Plan darf */
export function placementError(doc: Doc, sheet: View, v: View): string | null {
  if (v.kind === 'sheet') return 'Pläne können nicht auf Pläne platziert werden.';
  if (v.kind === '3d' && !dlBuilder('3d')) return '3D-Ansichten können noch nicht auf Pläne platziert werden.';
  if (multiPlace(v)) return null;
  const vp = viewportsOf(doc, v.id)[0];
  if (vp) {
    const s = doc.get<View>(vp.viewId);
    return `Die Ansicht „${v.name}“ ist bereits auf dem Plan ${s?.sheetNo ?? ''} - ${s?.name ?? ''} platziert. Eine Ansicht kann nur auf einem Plan platziert werden (Ausnahme: Legenden und Bauteillisten).`;
  }
  void sheet;
  return null;
}

// ------------------------------------------------------------ Geometrie
// Display-Listen der platzierten Ansichten zwischenspeichern; Änderungen nur an Ansichtsfenstern
// (z.B. Verschieben auf dem Plan) erfordern keinen Neuaufbau der Ansichten.
const innerCache = new Map<Id, DisplayList>();
app.doc.on((cs, origin) => {
  const ids = [...cs.added, ...cs.modified, ...cs.removed];
  const onSheet = (id: Id) => {
    const e = app.doc.get(id); if (!e) return false;
    if (e.cat === 'viewport' || (e.cat === 'view' && e.kind === 'sheet')) return true;
    return !!e.viewId && app.doc.get<View>(e.viewId)?.kind === 'sheet';
  };
  if (origin !== 'load' && ids.length && ids.every(onSheet)) return;
  innerCache.clear();
});
function innerDL(doc: Doc, v: View): DisplayList {
  if (doc !== app.doc) return buildViewDL(doc, v);
  let dl = innerCache.get(v.id);
  if (!dl) { dl = buildViewDL(doc, v); innerCache.set(v.id, dl); }
  return dl;
}
const viewScale = (v: View) => (v.kind === 'schedule' ? 1 : v.scale || 100);

/** Ausdehnung der Ansicht (Ansichts-mm): Zuschneidebereich oder Umfang der Display-Liste */
export function viewExtent(doc: Doc, v: View): BBox {
  const c = cropBox(v);
  if (c) return c;
  const b = contentBox(innerDL(doc, v));
  return boxValid(b) ? b : { min: { x: -1000, y: -1000 }, max: { x: 1000, y: 1000 } };
}

export function vpXf(vp: Viewport, v: View): Mat2 {
  const k = 1 / viewScale(v);
  return { a: k, b: 0, c: 0, d: k, e: vp.center.x - vp.anchor.x * k, f: vp.center.y - vp.anchor.y * k };
}
/** Umriss des Ansichtsfensters auf dem Plan */
export function vpBox(doc: Doc, vp: Viewport, v: View): BBox {
  const b = viewExtent(doc, v); const m = vpXf(vp, v);
  return { min: apply(m, b.min), max: apply(m, b.max) };
}

const titleShown = (vp: Viewport, v: View) => vp.showTitle !== false && v.kind !== 'schedule';
function titlePos(doc: Doc, vp: Viewport, v: View): V2 {
  const b = vpBox(doc, vp, v);
  return add({ x: b.min.x, y: b.min.y - 9 }, vp.titleOff ?? { x: 0, y: 0 });
}
export const scaleLabel = (v: View) => 'M 1 : ' + v.scale;

function drawViewport(dl: DisplayList, el: El, doc: Doc): void {
  const vp = el as Viewport; const v = doc.get<View>(vp.refId);
  if (!v) return;
  const xf = vpXf(vp, v);
  const src = innerDL(doc, v);
  const out = new DisplayList(1);
  for (const it of src.items) {
    if (it.sel || it.inv) continue;
    const t: Prim = transformPrim(it, xf);
    if (t.k !== 'clip') {
      const cat = it.o ? doc.get(it.o)?.cat : undefined;
      t.o = vp.id; t.sub = cat ? 'cat:' + cat : undefined;
    }
    out.items.push(t);
  }
  dl.append(out);
  dl.clip(null);
  const box = vpBox(doc, vp, v);
  // Umriss (nur bei Auswahl sichtbar, für Treffer)
  dl.poly(boxCorners(box), { w: 1, color: '#1e6fd9', dash: 'dash' }, true, { sel: true, ns: true });
  if (!titleShown(vp, v)) return;
  // Ansichtstitel: Detailnummer im Kreis, Name über kräftiger Linie, Maßstab darunter
  const t0 = titlePos(doc, vp, v); const r = 4.5;
  const c = { x: t0.x + r, y: t0.y };
  const name = v.titleOnSheet || v.name;
  const x1 = t0.x + 2 * r + 2;
  const L = Math.max(textWidth(name, 3.5 * 1.08), textWidth(scaleLabel(v), 2.5)) + 4;
  dl.line({ x: t0.x + 2 * r, y: t0.y }, { x: x1 + L, y: t0.y }, { w: 5 }, { ns: true });
  dl.circle(c, r, { w: 3 }, { color: '#ffffff' }, { ns: true });
  dl.text(c, vp.detail ?? '', { size: 3, ha: 'center', va: 'middle', bold: true });
  dl.text({ x: x1, y: t0.y + 1.2 }, name, { size: 3.5, bold: true });
  if (v.kind !== 'legend') dl.text({ x: x1, y: t0.y - 1.2 }, scaleLabel(v), { size: 2.5, va: 'top' });
}

// ------------------------------------------------------------ Kategorie
registerCategory({
  cat: 'viewport', label: 'Ansichtsfenster', plural: 'Ansichtsfenster', annotation: true, planOrder: 10,
  drawAnnotation: (dl, el, doc) => drawViewport(dl, el, doc),
  transform: (el, m) => ({ center: apply(m, el.center) }),
  center: (el) => el.center,
  // Kopieren: Modellansichten werden dupliziert (eine Ansicht nur auf einem Plan)
  onCopy: (el, doc) => {
    const v = doc.get<View>(el.refId);
    const copy = { ...el, detail: nextDetail(doc, el.viewId ?? '') } as Viewport;
    if (!v || multiPlace(v)) return copy;
    const nv = JSON.parse(JSON.stringify(v)) as View;
    nv.id = newId('vw');
    const names = new Set(doc.all<View>('view').map((x) => x.name));
    let i = 1; do { nv.name = `${v.name} - Kopie ${i++}`; } while (names.has(nv.name));
    doc.add(nv);
    copy.refId = nv.id;
    return copy;
  },
  grips: (el, doc) => {
    const vp = el as Viewport; const v = doc.get<View>(vp.refId);
    if (!v || !titleShown(vp, v)) return [];
    return [{ id: 'title', p: titlePos(doc, vp, v), kind: 'text', tip: 'Ansichtstitel verschieben' }];
  },
  dragGrip: (el, id, p, doc) => {
    const vp = el as Viewport; const v = doc.get<View>(vp.refId);
    if (id !== 'title' || !v) return;
    const b = vpBox(doc, vp, v);
    return { titleOff: sub(p, { x: b.min.x, y: b.min.y - 9 }) };
  },
  props: (el, doc) => {
    const g = GROUPS; const vp = el as Viewport; const v = doc.get<View>(vp.refId);
    const setView = (patch: Partial<View>) => { if (v) doc.update<View>(v.id, patch); };
    const p: import('../../core/registry').PropDef[] = [
      { key: 'view', label: 'Ansicht', group: g.identity, type: 'readonly', get: () => (v ? `${VIEW_KIND_LABEL[v.kind]}: ${v.name}` : '') },
      { key: 'sheet', label: 'Plan', group: g.identity, type: 'readonly', get: (e, d) => { const s = d.get<View>(e.viewId); return s ? `${s.sheetNo ?? ''} - ${s.name}` : ''; } },
      { key: 'detail', label: 'Detailnummer', group: g.identity, type: 'text', get: (e) => e.detail ?? '', set: (e, x, d) => {
        const s = String(x).trim();
        if (!s) return;
        if (d.all<Viewport>('viewport').some((o) => o.viewId === e.viewId && o.id !== e.id && o.detail === s)) { alert(`Die Detailnummer „${s}“ ist auf diesem Plan bereits vergeben.`); return; }
        return { detail: s };
      } },
      { key: 'titleOnSheet', label: 'Titel auf Plan', group: g.identity, type: 'text', get: () => v?.titleOnSheet ?? '', set: (_e, x) => { setView({ titleOnSheet: x }); } },
      { key: 'showTitle', label: 'Titel anzeigen', group: g.graphics, type: 'bool', get: (e) => e.showTitle !== false, set: (_e, x) => ({ showTitle: !!x }) },
    ];
    if (v && v.kind !== 'schedule' && v.kind !== '3d') {
      p.push({ key: 'scale', label: 'Ansichtsmaßstab', group: g.graphics, type: 'select', options: SCALES.map((s) => [String(s), '1 : ' + s] as [string, string]), get: () => String(v.scale), set: (_e, x) => { setView({ scale: parseInt(x, 10) }); } });
      p.push({ key: 'vdetail', label: 'Detaillierungsgrad', group: g.graphics, type: 'select', options: [['coarse', 'Grob'], ['medium', 'Mittel'], ['fine', 'Fein']], get: () => v.detail, set: (_e, x) => { setView({ detail: x }); } });
    }
    p.push({ key: 'open', label: 'Ansicht', group: g.other, type: 'button', get: () => 'Öffnen', action: (e) => app.openView(e.refId) });
    return p;
  },
});

// ------------------------------------------------------------ Platzieren
export function nextDetail(doc: Doc, sheetId: Id): string {
  let n = 0;
  for (const vp of doc.all<Viewport>('viewport')) if (vp.viewId === sheetId) { const k = parseInt(vp.detail, 10); if (isFinite(k)) n = Math.max(n, k); }
  return String(n + 1);
}

/** Ansicht auf Plan platzieren (eigene Transaktion). p = Mittelpunkt auf dem Plan */
export function placeView(sheet: View, v: View, p: V2): Id | null {
  const doc = app.doc;
  const err = placementError(doc, sheet, v);
  if (err) { alert(err); return null; }
  const b = viewExtent(doc, v);
  const vp: Viewport = {
    id: newId('vp'), cat: 'viewport', viewId: sheet.id, refId: v.id, center: { ...p },
    anchor: { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }, detail: nextDetail(doc, sheet.id),
  };
  if (v.kind === 'schedule') {
    // Bauteilliste: linke obere Ecke am Klickpunkt ausrichten
    vp.anchor = { x: b.min.x, y: b.max.y };
  }
  doc.transaction('Ansicht auf Plan platzieren', () => doc.add(vp));
  app.select([vp.id]);
  app.emit('views');
  toast(`„${v.name}“ auf Plan ${sheet.sheetNo ?? ''} platziert.`);
  return vp.id;
}

class PlaceViewTool extends Tool {
  id = 'placeView'; label = 'Ansicht platzieren'; kinds = ['sheet']; snapping = true;
  private cur: V2 | null = null;
  constructor(private viewIdToPlace: Id) { super(); }
  prompt() { return 'Klicken Sie, um die Ansicht auf dem Plan zu platzieren.'; }
  move(e: ToolEvent) { this.cur = e.p; }
  down(e: ToolEvent) {
    const v = app.doc.get<View>(this.viewIdToPlace);
    if (v) placeView(e.view, v, e.p);
    app.setTool(null);
  }
  preview(dl: DisplayList) {
    const v = app.doc.get<View>(this.viewIdToPlace);
    if (!v || !this.cur) return;
    const b = viewExtent(app.doc, v); const k = 1 / viewScale(v);
    const w = (b.max.x - b.min.x) * k, hh = (b.max.y - b.min.y) * k;
    const c = this.cur;
    const box = v.kind === 'schedule' ? { min: { x: c.x, y: c.y - hh }, max: { x: c.x + w, y: c.y } } : { min: { x: c.x - w / 2, y: c.y - hh / 2 }, max: { x: c.x + w / 2, y: c.y + hh / 2 } };
    dl.poly(boxCorners(box), { w: 2, color: '#1e6fd9', dash: 'dash' }, true);
  }
}

/** Auswahl einer Ansicht (wie Revit „Ansichten“-Dialog) */
function placeViewDialog(): void {
  const sheet = app.activeView();
  if (!sheet || !isSheet(sheet)) { app.status('Bitte zuerst einen Plan öffnen.'); return; }
  const doc = app.doc;
  const cands = doc.all<View>('view').filter((v) => v.kind !== 'sheet' && !placementError(doc, sheet, v))
    .sort((a, b) => VIEW_KIND_LABEL[a.kind].localeCompare(VIEW_KIND_LABEL[b.kind], 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  if (!cands.length) { alert('Alle Ansichten sind bereits auf Plänen platziert.'); return; }
  const list = h('select', { size: '16', style: 'width:100%' }) as HTMLSelectElement;
  for (const v of cands) list.append(h('option', { value: v.id }, `${VIEW_KIND_LABEL[v.kind]}: ${v.name}`));
  list.selectedIndex = 0;
  const go = () => { const id = list.value; if (id) startTool(new PlaceViewTool(id), 'placeView'); };
  list.ondblclick = () => { m.close(); go(); };
  const body = h('div', {}, h('div', { class: 'hint' }, 'Ansichten, die noch auf keinem Plan platziert sind:'), list);
  const m = modal('Ansichten', body, [{ label: 'Ansicht zu Plan hinzufügen', primary: true, onClick: go }, { label: 'Abbrechen', onClick: () => {} }], 420);
}

registerCommand({ id: 'placeView', label: 'Ansicht platzieren', icon: 'placeview', tip: 'Ansicht, Legende oder Bauteilliste auf dem aktiven Plan platzieren (oder aus dem Projektbrowser auf den Plan ziehen)', enabled: () => isSheet(app.activeView()), run: placeViewDialog });
registerCommand({ id: 'vpOpenView', label: 'Ansicht öffnen', icon: 'plan', enabled: () => app.selected().some((e) => e.cat === 'viewport'), run: () => { const vp = app.selected().find((e) => e.cat === 'viewport'); if (vp) app.openView(vp.refId); } });
registerContextPanel({ cats: ['viewport'], panel: 'Ansichtsfenster', items: ['vpOpenView'] });

// Ziehen aus dem Projektbrowser auf einen Plan
onHook('canvasDrop', (vp: any, dt: DataTransfer | null, p: V2) => {
  const id = dt?.getData('text/openriss-view');
  const sheet: View | undefined = vp?.view;
  if (!id || !sheet || !isSheet(sheet)) return;
  const v = app.doc.get<View>(id);
  if (!v || v.id === sheet.id) return;
  placeView(app.doc.get<View>(sheet.id) ?? sheet, v, p);
});

// Doppelklick auf Ansichtsfenster öffnet die Ansicht
onHook('dblclick', (el: El) => { if (el?.cat === 'viewport' && app.doc.get(el.refId)) app.openView(el.refId); });
