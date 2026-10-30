// Ausschnitt (Detail-Callout): Rechteck in Grundriss/Schnitt/Ansicht → neue Ansicht gleicher Art mit Zuschnitt,
// Symbol (Rechteck + Kopf mit Detail-/Plannummer) als Beschriftung der Elternansicht. Grundriss für Ebene erstellen.
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, catDef, onHook, GROUPS, PropDef } from '../../core/registry';
import { View, Level, levels, isPlanLike, DEFAULT_RANGE, VIEW_KIND_LABEL } from '../../core/view';
import { DisplayList } from '../../render/displayList';
import { V2, BBox, add, sub, mul, norm, dist, dot, apply, arcPoints } from '../../core/geom';
import { sectionGeomPatch, sheetRefOf } from '../../elements/datums';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import { modal, toast } from '../../ui/dialogs';
import { h } from '../../ui/shell';

export interface CalloutEl extends El {
  cat: 'callout';
  viewId: Id;   // Elternansicht
  refId: Id;    // Ausschnittsansicht
  /** Kopf relativ zur rechten oberen Ecke (Papier-mm) */
  head?: V2;
}

const SCALE_OPTS: [string, string][] = [['5', '1 : 5'], ['10', '1 : 10'], ['20', '1 : 20'], ['25', '1 : 25'], ['50', '1 : 50']];

// ------------------------------------------------------------ Geometrie Elternansicht ↔ Ausschnitt
const sectionDir = (v: View) => norm(sub(v.lineB!, v.lineA!));

/** Rechteck des Ausschnitts in Koordinaten der Elternansicht */
export function calloutRect(child: View, parent: View): BBox | null {
  if (!child.crop) return null;
  if (child.kind === 'section' && parent.lineA && parent.lineB && child.lineA && child.lineB) {
    const d = sectionDir(parent);
    const x0 = dot(sub(child.lineA, parent.lineA), d);
    return { min: { x: x0, y: child.crop.min.y }, max: { x: x0 + dist(child.lineA, child.lineB), y: child.crop.max.y } };
  }
  return { min: { ...child.crop.min }, max: { ...child.crop.max } };
}
/** Patch für die Ausschnittsansicht aus einem Rechteck der Elternansicht */
export function calloutPatch(child: View, parent: View, r: BBox): Partial<View> {
  const min = { x: Math.min(r.min.x, r.max.x), y: Math.min(r.min.y, r.max.y) }, max = { x: Math.max(r.min.x, r.max.x), y: Math.max(r.min.y, r.max.y) };
  const crop = { on: true, show: child.crop?.show ?? true, min, max };
  if (child.kind === 'section' && parent.lineA && parent.lineB) {
    const d = sectionDir(parent);
    const A = add(parent.lineA, mul(d, min.x)), B = add(parent.lineA, mul(d, max.x));
    return sectionGeomPatch(A, B, { ...child, crop } as View);
  }
  return { crop };
}

// ------------------------------------------------------------ Darstellung
function drawCallout(dl: DisplayList, el: El, doc: Doc, view: View): void {
  const c = el as CalloutEl; const child = doc.get<View>(c.refId);
  if (!child) return;
  const r = calloutRect(child, view); if (!r) return;
  const s = view.scale || 100;
  // Rechteck mit abgerundeten Ecken
  const rad = Math.min(2.5 * s, (r.max.x - r.min.x) / 4, (r.max.y - r.min.y) / 4);
  const pts: V2[] = [
    ...arcPoints({ x: r.max.x - rad, y: r.min.y + rad }, rad, -Math.PI / 2, 0, 8),
    ...arcPoints({ x: r.max.x - rad, y: r.max.y - rad }, rad, 0, Math.PI / 2, 8),
    ...arcPoints({ x: r.min.x + rad, y: r.max.y - rad }, rad, Math.PI / 2, Math.PI, 8),
    ...arcPoints({ x: r.min.x + rad, y: r.min.y + rad }, rad, Math.PI, Math.PI * 1.5, 8),
  ];
  dl.poly(pts, { w: 3 }, true, { sub: 'callout' });
  // Kopf
  const hc = headPos(c, r, s); const R = 5 * s;
  const corner = { x: r.max.x, y: r.max.y };
  const dd = sub(corner, hc); const L = Math.hypot(dd.x, dd.y);
  if (L > R) dl.line(add(hc, mul(dd, R / L)), corner, { w: 2 }, { ns: true });
  dl.circle(hc, R, { w: 2 }, { color: '#ffffff' }, { ns: true });
  const ref = sheetRefOf(doc, child);
  if (ref) {
    dl.line({ x: hc.x - R, y: hc.y }, { x: hc.x + R, y: hc.y }, { w: 1 }, { ns: true });
    dl.text({ x: hc.x, y: hc.y + R * 0.45 }, ref.detail, { size: 3, ha: 'center', va: 'middle', bold: true });
    dl.text({ x: hc.x, y: hc.y - R * 0.45 }, ref.sheet, { size: 2.2, ha: 'center', va: 'middle' });
  } else dl.text(hc, child.data?.marker ?? '', { size: 3.5, ha: 'center', va: 'middle', bold: true });
}
const headPos = (c: CalloutEl, r: BBox, s: number): V2 => add({ x: r.max.x, y: r.max.y }, mul(c.head ?? { x: 7, y: 7 }, s));

const parentOf = (doc: Doc, c: El) => doc.get<View>(c.viewId);

registerCategory({
  cat: 'callout', label: 'Ausschnitt', plural: 'Ausschnitte', annotation: true, planOrder: 70,
  drawAnnotation: (dl, el, doc, view) => drawCallout(dl, el, doc, view),
  grips: (el, doc, view) => {
    const child = doc.get<View>(el.refId); const r = child && calloutRect(child, view);
    if (!r) return [];
    return [
      { id: 'min', p: r.min, kind: 'end', tip: 'Ausschnitt ändern' }, { id: 'max', p: r.max, kind: 'end', tip: 'Ausschnitt ändern' },
      { id: 'xmin', p: { x: r.min.x, y: r.max.y }, kind: 'end' }, { id: 'xmax', p: { x: r.max.x, y: r.min.y }, kind: 'end' },
      { id: 'head', p: headPos(el as CalloutEl, r, view.scale || 100), kind: 'text', tip: 'Kopf verschieben' },
    ];
  },
  dragGrip: (el, id, p, doc, view) => {
    const child = doc.get<View>(el.refId); const r = child && calloutRect(child, view);
    if (!child || !r) return;
    if (id === 'head') return { head: mul(sub(p, { x: r.max.x, y: r.max.y }), 1 / (view.scale || 100)) };
    const n: BBox = { min: { ...r.min }, max: { ...r.max } };
    if (id === 'min') n.min = p; else if (id === 'max') n.max = p;
    else if (id === 'xmin') { n.min.x = p.x; n.max.y = p.y; } else if (id === 'xmax') { n.max.x = p.x; n.min.y = p.y; }
    if (Math.abs(n.max.x - n.min.x) < 10 || Math.abs(n.max.y - n.min.y) < 10) return;
    doc.update<View>(child.id, calloutPatch(child, view, n));
    return { head: (el as CalloutEl).head };
  },
  transform: (el, m, doc, view) => {
    const child = doc.get<View>(el.refId); const r = child && calloutRect(child, view);
    if (!child || !r) return;
    const a = apply(m, r.min), b = apply(m, r.max);
    doc.update<View>(child.id, calloutPatch(child, view, { min: a, max: b }));
    return { head: (el as CalloutEl).head };
  },
  center: (el, doc, view) => { const child = doc.get<View>(el.refId); const r = child && calloutRect(child, view); return r ? { x: (r.min.x + r.max.x) / 2, y: (r.min.y + r.max.y) / 2 } : null; },
  props: (el, doc) => {
    const g = GROUPS; const child = doc.get<View>(el.refId);
    const setChild = (patch: Partial<View>) => { if (child) doc.update<View>(child.id, patch); };
    const p: PropDef[] = [
      { key: 'view', label: 'Ausschnittsansicht', group: g.identity, type: 'readonly', get: () => child?.name ?? '' },
      { key: 'name', label: 'Ansichtsname', group: g.identity, type: 'text', get: () => child?.name ?? '', set: (_e, x) => { if (x) setChild({ name: x }); } },
      { key: 'marker', label: 'Symbolbeschriftung', group: g.identity, type: 'text', get: () => child?.data?.marker ?? '', set: (_e, x) => { if (child) setChild({ data: { ...(child.data ?? {}), marker: x } }); } },
      { key: 'scale', label: 'Maßstab', group: g.graphics, type: 'select', options: SCALE_OPTS, get: () => String(child?.scale ?? 20), set: (_e, x) => { setChild({ scale: parseInt(x, 10) }); } },
      { key: 'open', label: 'Ansicht', group: g.other, type: 'button', get: () => 'Öffnen', action: (e) => app.openView(e.refId) },
    ];
    return p;
  },
});

// Doppelklick auf Ausschnitt öffnet die Ansicht
onHook('dblclick', (el: El) => { if (el?.cat === 'callout' && app.doc.get(el.refId)) app.openView(el.refId); });

// Ausschnitte von Schnitten/Ansichten erscheinen nicht als eigene Symbole im Grundriss
{
  const vd = catDef('view');
  const orig = vd?.visibleIn;
  if (vd && orig) vd.visibleIn = (el, doc, view) => (el.data?.calloutOf ? false : orig(el, doc, view));
}

// ------------------------------------------------------------ Werkzeug
function nextMarker(doc: Doc): string {
  let n = 0;
  for (const v of doc.all<View>('view')) if (v.data?.calloutOf) { const k = parseInt(v.data?.marker ?? '', 10); if (isFinite(k)) n = Math.max(n, k); }
  return String(n + 1);
}

let lastScale = 20;
class CalloutTool extends Tool {
  id = 'callout'; label = 'Ausschnitt'; kinds = ['plan', 'ceiling', 'section', 'elevation'];
  private a: V2 | null = null; private cur: V2 | null = null;
  prompt() { return this.a ? 'Gegenüberliegende Ecke des Ausschnitts klicken' : 'Erste Ecke des Ausschnitts klicken'; }
  basePoint() { return this.a; }
  options(): OptionItem[] {
    return [{ kind: 'select', key: 'scale', label: 'Maßstab', value: String(lastScale), options: SCALE_OPTS, onChange: (v) => (lastScale = parseInt(v, 10)) }];
  }
  move(e: ToolEvent) { this.cur = e.p; }
  escape() { if (this.a) { this.a = null; return true; } return false; }
  down(e: ToolEvent) {
    if (!this.a) { this.a = e.p; return; }
    const a = this.a, b = e.p; this.a = null;
    if (Math.abs(a.x - b.x) < 50 || Math.abs(a.y - b.y) < 50) { app.status('Der Ausschnitt ist zu klein.'); return; }
    createCallout(e.view, { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } }, lastScale);
  }
  preview(dl: DisplayList) {
    if (!this.a || !this.cur) return;
    const a = this.a, c = this.cur;
    dl.poly([a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }], { w: 2, color: '#1e6fd9', dash: 'dash' }, true);
  }
}

export function createCallout(parent0: View, r: BBox, scale: number): Id {
  const doc = app.doc;
  const parent = doc.get<View>(parent0.id) ?? parent0;
  const marker = nextMarker(doc);
  const kids = doc.all<View>('view').filter((v) => v.data?.calloutOf === parent.id).length;
  const name = isPlanLike(parent) ? `${parent.name} - Ausschnitt ${kids + 1}` : `Detail ${marker}`;
  const child: View = JSON.parse(JSON.stringify(parent));
  child.id = newId('vw');
  child.name = uniqueName(doc, name);
  child.scale = scale; child.detail = 'fine';
  child.titleOnSheet = undefined;
  child.data = { ...(parent.data ?? {}), marker, calloutOf: parent.id };
  child.crop = { on: true, show: true, min: r.min, max: r.max };
  Object.assign(child, calloutPatch(child, parent, r));
  const mk: CalloutEl = { id: newId('co'), cat: 'callout', viewId: parent.id, refId: child.id };
  child.hostId = mk.id; // Löschen des Symbols löscht die Ansicht (und umgekehrt über refId)
  doc.transaction('Ausschnitt erstellen', () => { doc.add(child); doc.add(mk); });
  app.select([mk.id]);
  app.emit('views');
  toast(`Ausschnittsansicht „${child.name}“ erstellt (Doppelklick auf den Kopf öffnet sie).`, 3500);
  return child.id;
}
function uniqueName(doc: Doc, base: string, kind?: string): string {
  const names = new Set(doc.all<View>('view').filter((v) => !kind || v.kind === kind).map((v) => v.name));
  let n = base, i = 2; while (names.has(n)) n = `${base} (${i++})`;
  return n;
}

registerCommand({ id: 'callout', label: 'Ausschnitt', icon: 'callout', tip: 'Detail-Ausschnitt (Callout) als Rechteck aufziehen – erzeugt eine neue Ansicht mit eigenem Maßstab', run: () => startTool(new CalloutTool(), 'callout') });

// ------------------------------------------------------------ Grundriss für Ebene erstellen
function planViewDialog(): void {
  const doc = app.doc;
  const kind = h('select', {}) as HTMLSelectElement;
  kind.append(h('option', { value: 'plan' }, 'Grundriss'), h('option', { value: 'ceiling' }, 'Deckenplan'));
  const dup = h('input', { type: 'checkbox' }) as HTMLInputElement; dup.checked = true;
  const scale = h('select', {}) as HTMLSelectElement;
  for (const s of [50, 100, 200]) scale.append(h('option', { value: String(s) }, '1 : ' + s));
  scale.value = '100';
  const list = h('select', { multiple: true, size: '10', style: 'width:100%' }) as HTMLSelectElement;
  const fill = () => {
    list.innerHTML = '';
    const has = new Set(doc.all<View>('view').filter((v) => v.kind === kind.value && !v.data?.calloutOf).map((v) => v.levelId));
    for (const l of levels(doc)) if (!dup.checked || !has.has(l.id)) list.append(h('option', { value: l.id }, l.name));
    if (!list.options.length) list.append(h('option', { value: '', disabled: true }, '(alle Ebenen haben bereits Ansichten)'));
  };
  kind.onchange = fill; dup.onchange = fill; fill();
  const body = h('div', {},
    h('div', { class: 'form-row' }, h('label', {}, 'Typ'), kind),
    h('div', { class: 'hint' }, 'Ebenen (Mehrfachauswahl mit Strg/Umschalt):'), list,
    h('div', { class: 'form-row' }, h('label', {}, dup, ' Keine doppelten Ansichten erstellen')),
    h('div', { class: 'form-row' }, h('label', {}, 'Maßstab'), scale),
  );
  modal(`Neuer ${VIEW_KIND_LABEL.plan}`, body, [
    { label: 'OK', primary: true, onClick: () => {
      const ids = [...list.selectedOptions].map((o) => o.value).filter(Boolean);
      if (!ids.length) { alert('Bitte mindestens eine Ebene wählen.'); return false; }
      const k = kind.value as 'plan' | 'ceiling'; let first = '';
      doc.transaction('Grundriss erstellen', () => {
        for (const id of ids) {
          const l = doc.get<Level>(id); if (!l) continue;
          const vid = newId('vw'); if (!first) first = vid;
          doc.add<View>({
            id: vid, cat: 'view', kind: k, name: uniqueName(doc, l.name, k), scale: parseInt(scale.value, 10), detail: 'medium', levelId: l.id,
            range: k === 'ceiling' ? { top: 3000, cut: 2300, bottom: 2300, depth: 3000 } : { ...DEFAULT_RANGE }, discipline: 'arch',
          } as View);
        }
      });
      app.emit('views');
      if (first) app.openView(first);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 380);
}
registerCommand({ id: 'planView', label: 'Grundriss', icon: 'planview', tip: 'Grundriss oder Deckenplan für Ebenen ohne Ansicht erstellen', run: planViewDialog });
