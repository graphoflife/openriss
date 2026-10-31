// Beschriftungen nach Kategorie (Tür: Kennzeichen im Kreis, Fenster: Typ im Rechteck …),
// Raumstempel, "Alle beschriften" und automatische Beschriftung bei Platzierung (Hook 'tagOnPlace').
import { app } from '../../app';
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, perp, dist, norm, fromAngle, apply, len } from '../../core/geom';
import { registerCategory, catDef, onHook, PropDef, GROUPS, Grip, CategoryDef } from '../../core/registry';
import { View, isPlanLike, typesOf, annoViewId, annoIn } from '../../core/view';
import { DisplayList, textWidth, fontWf } from '../../render/displayList';
import type { Pen } from '../../render/styles';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { Wall, wallInfo } from '../../elements/wall';
import { modal, promptDialog } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import {
  anchorInView, fontFamily, rectPts, stadium, drawLeader, TickKind, TICK_OPTIONS, FONTS, myPlacement, previewEl,
  hostMovesToo, markCopiedWithHost, ensureTypes, MODEL_2D, tv, widthFactorProp } from './common';

export interface Tag extends El {
  cat: 'tag' | 'roomtag';
  viewId: Id;
  refId: Id;
  /** Lage relativ zum Ankerpunkt des Elements */
  off: V2;
  leader?: boolean;
  /** freies Führungslinienende relativ zum Anker (sonst am Element) */
  free?: V2;
  vertical?: boolean;
}

export function isTaggable(el: El | undefined): boolean {
  if (!el) return false;
  const def = catDef(el.cat);
  return !!def && !def.annotation && !def.datum && el.cat !== 'view' && el.cat !== 'type' && !!def.tagText;
}
const isRoom = (el: El | undefined) => !!el && el.cat === 'room';

function tagAnchor(doc: Doc, t: Tag, view: View): V2 | null {
  const ref = doc.get(t.refId); if (!ref) return null;
  return anchorInView(doc, ref, view);
}
function refHidden(view: View, ref: El): boolean { return !!(view.hiddenCats?.includes(ref.cat) || view.hiddenEls?.includes(ref.id)); }

// ------------------------------------------------------------ Beschriftung (Kategorie)
function tagLabel(doc: Doc, t: Tag): string {
  const ref = doc.get(t.refId); if (!ref) return '?';
  const content = tv<string>(doc, t, 'content', 'auto');
  switch (content) {
    case 'mark': return ref.mark || '?';
    case 'type': return doc.get(ref.typeId)?.name ?? '';
    case 'typeMark': return doc.get(ref.typeId)?.typeMark ?? doc.get(ref.typeId)?.name ?? '';
    case 'comments': return ref.comments || '–';
    default: {
      let s = '';
      try { s = catDef(ref.cat)?.tagText?.(ref, doc) ?? ''; } catch { /* */ }
      return s || ref.mark || '?';
    }
  }
}

interface TagGeo { P: V2; A: V2; ex: V2; ey: V2; hw: number; hh: number; shape: string }
function tagGeo(doc: Doc, t: Tag, view: View, scale: number): TagGeo | null {
  const A = tagAnchor(doc, t, view); if (!A) return null;
  const ref = doc.get(t.refId)!;
  const size = tv(doc, t, 'size', 2.5) * scale;
  const txt = tagLabel(doc, t); const lines = txt.split('\n');
  const wf = fontWf({ wf: tv<number | undefined>(doc, t, 'widthFactor', undefined), family: fontFamily(tv(doc, t, 'font', 'Arial')) });
  const tw = Math.max(...lines.map((l) => textWidth(l, size, wf))); const th = size * 1.25 * (lines.length - 1) + size;
  let shape = tv<string>(doc, t, 'shape', 'auto');
  if (shape === 'auto') shape = ref.cat === 'door' ? 'circle' : ref.cat === 'window' ? 'rect' : 'none';
  const pad = size * 0.45;
  const ex = fromAngle(t.vertical ? Math.PI / 2 : 0); const ey = perp(ex);
  let hw = tw / 2 + pad, hh = th / 2 + pad;
  if (shape === 'circle') { const r = Math.max(size * 0.95, th / 2 + pad * 0.8); hh = r; hw = Math.max(r, tw / 2 + pad * 1.2); }
  return { P: add(A, t.off ?? { x: 0, y: 0 }), A, ex, ey, hw, hh, shape };
}

/** Punkt auf dem Rand der Beschriftung in Richtung E */
function edgeToward(g: TagGeo, E: V2): V2 {
  const d = sub(E, g.P); const lx = d.x * g.ex.x + d.y * g.ex.y, ly = d.x * g.ey.x + d.y * g.ey.y;
  const L = len(d); if (L < 1e-9) return g.P;
  let t: number;
  if (g.shape === 'circle' && Math.abs(g.hw - g.hh) < 1e-6) t = g.hh / L;
  else t = Math.min(Math.abs(lx) > 1e-9 ? g.hw / Math.abs(lx) : Infinity, Math.abs(ly) > 1e-9 ? g.hh / Math.abs(ly) : Infinity);
  return add(g.P, mul(d, Math.min(1, t)));
}

function leaderEnd(t: Tag, g: TagGeo): V2 { return t.free ? add(g.A, t.free) : g.A; }

function drawTag(dl: DisplayList, t: Tag, doc: Doc, view: View): void {
  const ref = doc.get(t.refId); if (!ref || refHidden(view, ref)) return;
  const g = tagGeo(doc, t, view, dl.scale); if (!g) return;
  const color = tv(doc, t, 'color', '#000000'); const pen: Pen = { w: 1, color };
  const size = tv(doc, t, 'size', 2.5);
  if (g.shape === 'circle') {
    if (Math.abs(g.hw - g.hh) < 1e-6) dl.circle(g.P, g.hh, pen, { color: '#ffffff' });
    else dl.fill([stadium(g.P, g.ex, g.ey, g.hw, g.hh)], { color: '#ffffff' }, pen);
  } else if (g.shape === 'rect') dl.fill([rectPts(g.P, g.ex, g.ey, -g.hw, -g.hh, g.hw, g.hh)], { color: '#ffffff' }, pen);
  dl.text(g.P, tagLabel(doc, t), { size, rot: t.vertical ? Math.PI / 2 : 0, ha: 'center', va: 'middle', color, family: fontFamily(tv(doc, t, 'font', 'Arial')), wf: tv<number | undefined>(doc, t, 'widthFactor', undefined), opaque: g.shape === 'none' });
  if (t.leader) {
    const E = leaderEnd(t, g);
    if (dist(E, g.P) > Math.max(g.hw, g.hh) * 1.05) drawLeader(dl, [edgeToward(g, E), E], tv(doc, t, 'leaderArrow', 'none') as TickKind, tv(doc, t, 'arrowSize', 2), pen);
  }
}

// ------------------------------------------------------------ Raumstempel
function roomLines(doc: Doc, t: Tag): { s: string; size: number; bold: boolean }[] {
  const ref = doc.get(t.refId); if (!ref) return [];
  let raw = '';
  try { raw = catDef(ref.cat)?.tagText?.(ref, doc, 'room') ?? ''; } catch { /* */ }
  const [name = '', num = '', area = '', ...rest] = raw.split('\n');
  const size = tv(doc, t, 'size', 2.5), nameSize = tv(doc, t, 'nameSize', 3.5);
  const out: { s: string; size: number; bold: boolean }[] = [];
  if (tv(doc, t, 'showName', true) && name) out.push({ s: name, size: nameSize, bold: true });
  if (tv(doc, t, 'showNumber', true) && num) out.push({ s: num, size, bold: false });
  if (tv(doc, t, 'showArea', true) && area) out.push({ s: tv(doc, t, 'areaPrefix', '') + area, size, bold: false });
  for (const r of rest) if (r) out.push({ s: r, size, bold: false });
  if (!out.length) out.push({ s: name || 'Raum', size: nameSize, bold: true });
  return out;
}

function roomGeo(doc: Doc, t: Tag, view: View, scale: number): (TagGeo & { rows: { s: string; size: number; bold: boolean; y: number }[] }) | null {
  const A = tagAnchor(doc, t, view); if (!A) return null;
  const rows0 = roomLines(doc, t);
  let H = 0; let W = 0;
  const rows = rows0.map((r) => { const hh = r.size * scale; const y = H; H += hh * 1.35; W = Math.max(W, textWidth(r.s, hh, fontWf({ wf: tv<number | undefined>(doc, t, 'widthFactor', undefined), family: fontFamily(tv(doc, t, 'font', 'Arial')) })) * (r.bold ? 1.08 : 1)); return { ...r, y: y + hh / 2 }; });
  H -= rows0.length ? rows0[rows0.length - 1].size * scale * 0.35 : 0;
  const pad = 1.2 * scale;
  const ex = fromAngle(t.vertical ? Math.PI / 2 : 0); const ey = perp(ex);
  return { P: add(A, t.off ?? { x: 0, y: 0 }), A, ex, ey, hw: W / 2 + pad, hh: H / 2 + pad, shape: tv(doc, t, 'frame', true) ? 'rect' : 'none', rows: rows.map((r) => ({ ...r, y: H / 2 - r.y })) };
}

function drawRoomTag(dl: DisplayList, t: Tag, doc: Doc, view: View): void {
  const ref = doc.get(t.refId); if (!ref || refHidden(view, ref)) return;
  const g = roomGeo(doc, t, view, dl.scale); if (!g) return;
  const color = tv(doc, t, 'color', '#000000'); const pen: Pen = { w: 1, color };
  const fam = fontFamily(tv(doc, t, 'font', 'Arial'));
  if (g.shape === 'rect') dl.fill([rectPts(g.P, g.ex, g.ey, -g.hw, -g.hh, g.hw, g.hh)], { color: '#ffffff' }, pen);
  for (const r of g.rows) dl.text(add(g.P, mul(g.ey, r.y)), r.s, { size: r.size, bold: r.bold, rot: t.vertical ? Math.PI / 2 : 0, ha: 'center', va: 'middle', color, family: fam, wf: tv<number | undefined>(doc, t, 'widthFactor', undefined), opaque: g.shape !== 'rect' });
  if (t.leader) { const E = leaderEnd(t, g); if (dist(E, g.P) > Math.max(g.hw, g.hh) * 1.05) drawLeader(dl, [edgeToward(g, E), E], 'dot', 1.5, pen); }
}

// ------------------------------------------------------------ Gemeinsame Kategorie-Funktionen
function geoOf(doc: Doc, t: Tag, view: View): TagGeo | null { return t.cat === 'roomtag' ? roomGeo(doc, t, view, view.scale) : tagGeo(doc, t, view, view.scale); }

function tagCommon(): Partial<CategoryDef> {
  return {
    annotation: true, hasTypes: true,
    grips: (el, doc, view) => {
      const t = el as Tag; const g = geoOf(doc, t, view); if (!g) return [];
      const out: Grip[] = [{ id: 'pos', p: g.P, kind: 'text', tip: 'Beschriftung verschieben' }];
      if (t.leader) out.push({ id: 'le', p: leaderEnd(t, g), kind: 'end', tip: 'Führungslinienende (freies Ende)' });
      return out;
    },
    dragGrip: (el, id, p, doc, view) => {
      const t = el as Tag; const A = tagAnchor(doc, t, view); if (!A) return;
      if (id === 'pos') return { off: sub(p, A) };
      if (id === 'le') return { free: sub(p, A) };
    },
    transform: (el, m, doc, view) => {
      const t = el as Tag;
      if (hostMovesToo(t)) return;
      const A = tagAnchor(doc, t, view); if (!A) return;
      const patch: Partial<Tag> = { off: sub(apply(m, add(A, t.off ?? { x: 0, y: 0 })), A) };
      if (t.free) patch.free = sub(apply(m, add(A, t.free)), A);
      return patch;
    },
    onCopy: (el, _doc, idMap) => {
      if (el.refId && idMap.has(el.refId)) { markCopiedWithHost(el.id); return { ...el, refId: idMap.get(el.refId) }; }
    },
    center: (el, doc, view) => geoOf(doc, el as Tag, view)?.P ?? null,
    props: () => tagProps(),
  };
}

function tagProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'ref', label: 'Beschriftetes Element', group: g.identity, type: 'readonly', get: (e, doc) => { const r = doc.get(e.refId); return r ? `${catDef(r.cat)?.label ?? r.cat}${r.mark ? ' ' + r.mark : ''}${r.name ? ' ' + r.name : ''}` : ''; } },
    { key: 'leader', label: 'Führungslinie', group: g.graphics, type: 'bool', get: (e) => !!e.leader,
      set: (e, v) => (v && len(e.off ?? { x: 0, y: 0 }) < 1 ? { leader: true, off: { x: 600, y: 900 } } : { leader: v || undefined }) },
    { key: 'free', label: 'Freies Ende', group: g.graphics, type: 'bool', get: (e) => !!e.free, set: (e, v) => ({ free: v ? mul(e.off ?? { x: 0, y: 0 }, 0.5) : undefined }) },
    { key: 'vertical', label: 'Ausrichtung', group: g.graphics, type: 'select', options: [['h', 'Horizontal'], ['v', 'Vertikal']], get: (e) => (e.vertical ? 'v' : 'h'), set: (_e, v) => ({ vertical: v === 'v' || undefined }) },
  ];
}

registerCategory({
  cat: 'tag', label: 'Beschriftung', plural: 'Beschriftungen', planOrder: 88, ...tagCommon(),
  drawAnnotation: (dl, el, doc, view) => drawTag(dl, el as Tag, doc, view),
  typeProps: () => [
    { key: 'shape', label: 'Rahmen', group: GROUPS.graphics, type: 'select', options: [['auto', 'Nach Kategorie (Tür: Kreis, Fenster: Rechteck)'], ['circle', 'Kreis/Oval'], ['rect', 'Rechteck'], ['none', 'Ohne']], get: (t) => t.shape ?? 'auto', set: (_t, v) => ({ shape: v }) },
    { key: 'content', label: 'Inhalt', group: GROUPS.text, type: 'select', options: [['auto', 'Nach Kategorie'], ['mark', 'Kennzeichen'], ['type', 'Typname'], ['typeMark', 'Typkennzeichen'], ['comments', 'Kommentare']], get: (t) => t.content ?? 'auto', set: (_t, v) => ({ content: v }) },
    { key: 'size', label: 'Textgröße (mm)', group: GROUPS.text, type: 'number', get: (t) => t.size ?? 2.5, set: (_t, v) => ({ size: Math.max(0.5, v) }) },
    { key: 'font', label: 'Schriftart', group: GROUPS.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    widthFactorProp(GROUPS.text),
    { key: 'color', label: 'Farbe', group: GROUPS.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
    { key: 'leaderArrow', label: 'Führungslinie: Pfeilspitze', group: GROUPS.graphics, type: 'select', options: TICK_OPTIONS, get: (t) => t.leaderArrow ?? 'none', set: (_t, v) => ({ leaderArrow: v }) },
    { key: 'arrowSize', label: 'Pfeilgröße (mm)', group: GROUPS.graphics, type: 'number', get: (t) => t.arrowSize ?? 2, set: (_t, v) => ({ arrowSize: Math.max(0.5, v) }) },
  ],
});

registerCategory({
  cat: 'roomtag', label: 'Raumstempel', plural: 'Raumstempel', planOrder: 88, ...tagCommon(),
  drawAnnotation: (dl, el, doc, view) => drawRoomTag(dl, el as Tag, doc, view),
  typeProps: () => [
    { key: 'showName', label: 'Name anzeigen', group: GROUPS.text, type: 'bool', get: (t) => t.showName !== false, set: (_t, v) => ({ showName: v }) },
    { key: 'showNumber', label: 'Nummer anzeigen', group: GROUPS.text, type: 'bool', get: (t) => t.showNumber !== false, set: (_t, v) => ({ showNumber: v }) },
    { key: 'showArea', label: 'Fläche anzeigen', group: GROUPS.text, type: 'bool', get: (t) => t.showArea !== false, set: (_t, v) => ({ showArea: v }) },
    { key: 'areaPrefix', label: 'Präfix Fläche (z. B. „F = “)', group: GROUPS.text, type: 'text', get: (t) => t.areaPrefix ?? '', set: (_t, v) => ({ areaPrefix: v }) },
    { key: 'nameSize', label: 'Textgröße Name (mm)', group: GROUPS.text, type: 'number', get: (t) => t.nameSize ?? 3.5, set: (_t, v) => ({ nameSize: Math.max(0.5, v) }) },
    { key: 'size', label: 'Textgröße (mm)', group: GROUPS.text, type: 'number', get: (t) => t.size ?? 2.5, set: (_t, v) => ({ size: Math.max(0.5, v) }) },
    { key: 'font', label: 'Schriftart', group: GROUPS.text, type: 'select', options: FONTS, get: (t) => t.font ?? 'Arial', set: (_t, v) => ({ font: v }) },
    widthFactorProp(GROUPS.text),
    { key: 'frame', label: 'Rahmen', group: GROUPS.graphics, type: 'bool', get: (t) => t.frame !== false, set: (_t, v) => ({ frame: v }) },
    { key: 'color', label: 'Farbe', group: GROUPS.graphics, type: 'color', get: (t) => t.color ?? '#000000', set: (_t, v) => ({ color: v }) },
  ],
});

// ------------------------------------------------------------ Erzeugen
/** Vorgabe-Lage: Fenster außen, Tür auf der Aufschlagseite */
function defaultOffset(doc: Doc, el: El, view: View, leader: boolean): V2 {
  const s = view.scale; let off: V2 = { x: 0, y: 0 };
  if (isPlanLike(view) && (el.cat === 'door' || el.cat === 'window')) {
    const w = doc.get<Wall>(el.hostId);
    if (w && w.cat === 'wall') {
      const wi = wallInfo(doc, w);
      const side = el.cat === 'window' ? wi.ext : (el.flipFacing ? 1 : -1) * wi.ext;
      off = mul(wi.n, side * (wi.T / 2 + (el.cat === 'window' ? 4.5 : 4) * s));
    }
  }
  if (leader) off = add(off, len(off) > 1 ? mul(norm(off), 7 * s) : { x: 6 * s, y: 9 * s });
  return off;
}

export function makeTag(doc: Doc, el: El, view: View, o: { leader?: boolean; vertical?: boolean; typeId?: Id } = {}): Tag | null {
  if (!anchorInView(doc, el, view)) return null;
  const room = isRoom(el);
  const t: Tag = { id: newId(room ? 'rt' : 'tg'), cat: room ? 'roomtag' : 'tag', viewId: annoViewId(doc, view), refId: el.id, off: defaultOffset(doc, el, view, !!o.leader) } as Tag;
  const tid = o.typeId ?? typesOf(doc, t.cat)[0]?.id;
  if (tid) t.typeId = tid;
  if (o.leader) t.leader = true;
  if (o.vertical) t.vertical = true;
  return t;
}

/** Beschriftungen eines Elements in einer Ansicht */
export function tagsOf(doc: Doc, refId: Id, viewId: Id): El[] {
  const rid = annoViewId(doc, doc.get<View>(viewId)) || viewId; // abhängige Ansicht: Beschriftungen der Primäransicht
  return [...doc.all('tag'), ...doc.all('roomtag')].filter((t) => t.refId === refId && (t.viewId === viewId || t.viewId === rid));
}

// ------------------------------------------------------------ Werkzeuge
export class TagTool extends Tool {
  id: string; label: string; kinds: string[];
  static leader = false; static vertical = false;
  private hover: El | null = null;
  constructor(public room: boolean) {
    super();
    this.id = room ? 'roomTag' : 'tagByCat';
    this.label = room ? 'Raumstempel' : 'Beschriftung nach Kategorie';
    this.kinds = room ? ['plan', 'ceiling'] : MODEL_2D;
  }
  activate(): void { this.placement = this.room ? myPlacement('roomTag', 'roomtag', 'rtt_std') : myPlacement('tagByCat', 'tag', 'tagt_std'); }
  prompt(): string { return this.room ? 'Klicken Sie auf einen Raum, um ihn zu beschriften.' : 'Klicken Sie auf ein Element, um es zu beschriften (Tür, Fenster, Wand …).'; }
  options(): OptionItem[] {
    return [
      { kind: 'select', key: 'orient', label: '', value: TagTool.vertical ? 'v' : 'h', options: [['h', 'Horizontal'], ['v', 'Vertikal']], onChange: (v) => { TagTool.vertical = v === 'v'; } },
      { kind: 'check', key: 'leader', label: 'Führungslinie', value: TagTool.leader, onChange: (v) => { TagTool.leader = v; } },
    ];
  }
  private ok(el: El | undefined): boolean { return this.room ? isRoom(el) : isTaggable(el); }
  move(e: ToolEvent): void {
    this.hover = null;
    for (const hh of e.vp.hit(e.raw)) { const el = app.doc.get(hh.id); if (this.ok(el)) { this.hover = el!; break; } }
  }
  private make(el: El, view: View): Tag | null {
    const room = isRoom(el);
    // Raum über "Beschriftung nach Kategorie" → Raumstempel-Typ
    const typeId = room === this.room ? this.placement!.proto.typeId : typesOf(app.doc, room ? 'roomtag' : 'tag')[0]?.id;
    return makeTag(app.doc, el, view, { leader: TagTool.leader, vertical: TagTool.vertical, typeId });
  }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.hover) {
      if (this.room && !catDef('room')) app.status('Keine Räume vorhanden – zuerst Räume erstellen.');
      else app.status(this.room ? 'Kein Raum unter dem Cursor.' : 'Kein beschriftbares Element unter dem Cursor.');
      return;
    }
    if (isRoom(this.hover)) ensureTypes('roomtag');
    const t = this.make(this.hover, e.view);
    if (!t) { app.status('Für dieses Element kann in dieser Ansicht keine Beschriftung erstellt werden.'); return; }
    app.doc.transaction(this.label, () => app.doc.add(t));
  }
  preview(dl: DisplayList, vp: any): void {
    if (!this.hover) return;
    const t = this.make(this.hover, vp.view); if (t) previewEl(dl, t, vp.view);
  }
}

/** Dialog "Alle beschriften" (nicht beschriftete Elemente der aktiven Ansicht) */
export function tagAllDialog(): void {
  const doc = app.doc; const vp: any = app.active; const view = app.activeView();
  if (!view || !vp?.displayList || !MODEL_2D.includes(view.kind)) { app.status('„Alle beschriften“ ist nur in Grundrissen, Schnitten und Ansichten verfügbar.'); return; }
  ensureTypes('tag', 'roomtag');
  const dl: DisplayList = vp.displayList();
  const onlySel = app.selection.size > 0;
  const ids = new Set<Id>();
  for (const it of dl.items) if (it.o) ids.add(it.o);
  const tagged = new Set([...doc.all('tag'), ...doc.all('roomtag')].filter((t) => annoIn(doc, t, view)).map((t) => t.refId));
  const byCat = new Map<string, El[]>();
  for (const id of ids) {
    const el = doc.get(id);
    if (!el || tagged.has(id) || !(isTaggable(el) || isRoom(el))) continue;
    if (!anchorInView(doc, el, view)) continue;
    (byCat.get(el.cat) ?? byCat.set(el.cat, []).get(el.cat)!).push(el);
  }
  if (!byCat.size) { app.status('Alle sichtbaren Elemente sind bereits beschriftet.'); return; }
  const body = h('div', { style: 'min-width:440px' });
  const rows: { cat: string; cb: HTMLInputElement; sel: HTMLSelectElement }[] = [];
  const order = ['door', 'window', 'room', 'wall'];
  const cats = [...byCat.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const selOnlyCb = h('input', { type: 'checkbox' }) as HTMLInputElement; selOnlyCb.checked = onlySel; selOnlyCb.disabled = !onlySel;
  body.append(h('div', { class: 'hint' }, 'Beschriftet alle noch nicht beschrifteten Elemente der gewählten Kategorien in der aktiven Ansicht.'));
  const table = h('table', { class: 'grid' });
  table.append(h('tr', {}, h('th', {}, ''), h('th', {}, 'Kategorie'), h('th', {}, 'Anzahl'), h('th', {}, 'Beschriftungstyp')));
  for (const c of cats) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = c === 'door' || c === 'window' || c === 'room';
    const tc = c === 'room' ? 'roomtag' : 'tag';
    const sel = h('select', {}) as HTMLSelectElement;
    for (const t of typesOf(doc, tc)) sel.append(h('option', { value: t.id }, t.name));
    table.append(h('tr', {}, h('td', {}, cb), h('td', {}, catDef(c)?.plural ?? c), h('td', {}, String(byCat.get(c)!.length)), h('td', {}, sel)));
    rows.push({ cat: c, cb, sel });
  }
  body.append(table);
  const leaderCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const orient = h('select', {}) as HTMLSelectElement; orient.append(h('option', { value: 'h' }, 'Horizontal'), h('option', { value: 'v' }, 'Vertikal'));
  body.append(
    h('div', { class: 'form-row' }, h('label', {}, selOnlyCb, ' Nur ausgewählte Elemente')),
    h('div', { class: 'form-row' }, h('label', {}, leaderCb, ' Führungslinie')),
    h('div', { class: 'form-row' }, h('label', {}, 'Ausrichtung'), orient),
  );
  modal('Alle nicht beschrifteten Elemente beschriften', body, [
    { label: 'OK', primary: true, onClick: () => {
      let n = 0;
      doc.transaction('Alle beschriften', () => {
        for (const r of rows) {
          if (!r.cb.checked) continue;
          for (const el of byCat.get(r.cat)!) {
            if (selOnlyCb.checked && !app.selection.has(el.id)) continue;
            const t = makeTag(doc, el, view, { leader: leaderCb.checked, vertical: orient.value === 'v', typeId: r.sel.value || undefined });
            if (t) { doc.add(t); n++; }
          }
        }
      });
      app.status(`${n} Beschriftung(en) erstellt.`);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 520);
}

// ------------------------------------------------------------ Hooks
onHook('tagOnPlace', (el: El, view: View) => {
  if (!el || !view || !MODEL_2D.includes(view.kind)) return;
  if (el.cat !== 'door' && el.cat !== 'window' && el.cat !== 'room') return;
  const doc = app.doc;
  const cat = el.cat === 'room' ? 'roomtag' : 'tag';
  ensureTypes(cat);
  const typeId = el.cat === 'room' ? (doc.get('rtt_std') ? 'rtt_std' : undefined) : (doc.get('tagt_std') ? 'tagt_std' : undefined);
  const t = makeTag(doc, el, view, { typeId });
  if (t) doc.add(t);
});

/** Doppelklick: Kennzeichen bzw. Raumname/-nummer bearbeiten */
export function editTagValue(t: Tag): void {
  const doc = app.doc; const ref = doc.get(t.refId); if (!ref) return;
  if (t.cat === 'roomtag') {
    const nm = h('input', { type: 'text', value: ref.name ?? '' }) as HTMLInputElement;
    const nr = h('input', { type: 'text', value: ref.number ?? '' }) as HTMLInputElement;
    modal('Raum', h('div', {}, h('div', { class: 'form-row' }, h('label', {}, 'Name'), nm), h('div', { class: 'form-row' }, h('label', {}, 'Nummer'), nr)), [
      { label: 'OK', primary: true, onClick: () => { doc.transaction('Raum umbenennen', () => doc.update(ref.id, { name: nm.value, number: nr.value })); } },
      { label: 'Abbrechen', onClick: () => {} },
    ]);
    return;
  }
  const content = tv<string>(doc, t, 'content', 'auto');
  const showsType = content === 'type' || (content === 'auto' && ref.cat !== 'door' && !!ref.typeId && tagLabel(doc, t) === doc.get(ref.typeId)?.name);
  if (showsType) {
    const ty = doc.get(ref.typeId); if (!ty) return;
    promptDialog('Typname ändern (betrifft alle Exemplare dieses Typs)', 'Typname', ty.name ?? '', (v) => { if (v) doc.transaction('Typ umbenennen', () => doc.update(ty.id, { name: v })); });
    return;
  }
  promptDialog('Kennzeichen', 'Kennzeichen', ref.mark ?? '', (v) => doc.transaction('Kennzeichen ändern', () => doc.update(ref.id, { mark: v || undefined })));
}
