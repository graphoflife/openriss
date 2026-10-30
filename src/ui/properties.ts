// Eigenschaftenpalette: Typenauswahl + Instanzeigenschaften für Auswahl, Platzierung oder aktive Ansicht.
import { app } from '../app';
import { catDef, PropDef } from '../core/registry';
import type { El, Id } from '../core/doc';
import { typesOf, TypeEl, materialOptions, levelOptions, View } from '../core/view';
import { fmtLen, parseLen, parseNum, fmtArea, fmtNum, parseAngle } from '../core/units';
import { h, attachTip } from './shell';
import { icon } from './icons';
import { editTypeDialog } from './dialogs';
import { setViewProp } from './viewControlBar';

let filterCat: string | null = null;
const closedGroups = new Set<string>();
export let browserSelView: Id | null = null;
export function setBrowserSel(id: Id | null): void { browserSelView = id; renderProps(); }

let root: HTMLElement;
export function buildProperties(el: HTMLElement): void {
  root = el;
  app.on('selection', () => { filterCat = null; renderProps(); });
  app.on('tool', renderProps);
  app.on('view', renderProps);
  let pending = 0;
  app.doc.on(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => { if (!root.contains(document.activeElement)) renderProps(); }); });
  renderProps();
}

const iconFor: Record<string, string> = { wall: 'wall', door: 'door', window: 'window', floor: 'floor', roof: 'roof', ceiling: 'ceiling', column: 'column', beam: 'beam', stair: 'stair', railing: 'railing', component: 'component', room: 'room', grid: 'grid', level: 'level', view: 'plan', rebar: 'rebar', foundation: 'foundation', dimension: 'dimension', text: 'text', tag: 'tag', line: 'line' };

export function renderProps(): void {
  if (!root) return;
  root.innerHTML = '';
  const title = h('div', { class: 'palette-title' }, 'Eigenschaften');
  root.append(title);
  const body = h('div', { class: 'palette-body' });
  root.append(body);
  const doc = app.doc;

  // Ziel bestimmen
  const pl = app.tool && app.tool !== app.defaultTool ? app.tool.placement : null;
  let els: El[] = [];
  let mode: 'placement' | 'sel' | 'view' | 'none' = 'none';
  let cat = '';
  if (pl) { mode = 'placement'; cat = pl.cat; els = [pl.proto]; }
  else if (app.selection.size) {
    mode = 'sel';
    const all = app.selected();
    const cats = [...new Set(all.map((e) => e.cat))];
    if (filterCat && !cats.includes(filterCat)) filterCat = null;
    cat = filterCat ?? (cats.length === 1 ? cats[0] : '');
    els = cat ? all.filter((e) => e.cat === cat) : all;
    if (cats.length > 1) {
      const head = h('div', { class: 'props-head' });
      const s = h('select', {}) as HTMLSelectElement;
      s.append(h('option', { value: '' }, `Allgemein (${all.length})`));
      for (const c of cats) s.append(h('option', { value: c }, `${catDef(c)?.plural ?? c} (${all.filter((e) => e.cat === c).length})`));
      s.value = filterCat ?? '';
      s.onchange = () => { filterCat = s.value || null; renderProps(); };
      head.append(s);
      body.append(head);
    }
  } else {
    const v = (browserSelView && doc.get<View>(browserSelView)) || app.activeView();
    if (v) { mode = 'view'; cat = 'view'; els = [v]; }
  }
  if (mode === 'none') { body.append(h('div', { class: 'props-empty' }, 'Keine Auswahl.')); return; }

  const def = cat ? catDef(cat) : undefined;
  // Typenauswahl
  if (def?.hasTypes) {
    const types = typesOf(doc, cat);
    const ts = h('div', { class: 'typesel' });
    ts.append(h('div', { class: 'ticon', html: icon(iconFor[cat] ?? 'component', 30) }));
    const info = h('div', { class: 'tinfo' });
    const sel = h('select', {}) as HTMLSelectElement;
    const cur = els.every((e) => e.typeId === els[0].typeId) ? els[0].typeId ?? '' : '';
    if (!cur) sel.append(h('option', { value: '' }, '<verschiedene>'));
    for (const t of types) sel.append(h('option', { value: t.id }, t.name));
    sel.value = cur;
    sel.onchange = () => {
      if (mode === 'placement') pl!.setType(sel.value);
      else doc.transaction('Typ ändern', () => { for (const e of els) doc.update(e.id, { typeId: sel.value }); });
      renderProps();
    };
    info.append(h('div', { class: 'tcat' }, def.label), sel);
    ts.append(info);
    body.append(ts);
  } else if (mode === 'view' || els.length === 1) {
    const ts = h('div', { class: 'typesel' });
    ts.append(h('div', { class: 'ticon', html: icon(iconFor[cat] ?? 'component', 30) }));
    const e0 = els[0] as any;
    ts.append(h('div', { class: 'tinfo' }, h('div', { class: 'tcat' }, def?.label ?? cat), h('div', { class: 'tname' }, e0.name ?? def?.label ?? '')));
    body.append(ts);
  }
  // Kopf: Anzahl + Typ bearbeiten
  const head = h('div', { class: 'props-head' });
  const what = mode === 'placement' ? `Neu: ${def?.label ?? cat}` : mode === 'view' ? `${def?.label ?? 'Ansicht'}: ${(els[0] as any).name}` : `${cat ? def?.plural ?? cat : 'Elemente'} (${els.length})`;
  head.append(h('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, what));
  if (def?.hasTypes && def.typeProps) {
    const tid = els[0]?.typeId;
    const b = h('button', {}, 'Typ bearbeiten');
    b.onclick = () => { const t = doc.get<TypeEl>(tid); if (t) editTypeDialog(t, (newId) => { if (mode === 'placement') pl!.setType(newId); }); };
    b.disabled = !tid || !els.every((e) => e.typeId === tid);
    head.append(b);
  }
  body.append(head);

  // Eigenschaften
  let props: PropDef[] = [];
  if (def?.props) { try { props = def.props(els[0], doc); } catch (e) { console.error(e); } }
  else if (!cat) props = commonProps();
  const table = h('table', { class: 'props' });
  let group = '';
  let groupRow: HTMLTableRowElement | null = null;
  for (const p of props) {
    if (p.group !== group) {
      group = p.group;
      const g = group;
      groupRow = h('tr', { class: 'grp' + (closedGroups.has(g) ? ' closed' : '') }, h('td', { colspan: '2' }, g));
      groupRow.onclick = () => { closedGroups.has(g) ? closedGroups.delete(g) : closedGroups.add(g); renderProps(); };
      table.append(groupRow);
    }
    if (closedGroups.has(group)) continue;
    const tr = h('tr', {});
    const k = h('td', { class: 'k' }, p.label);
    attachTip(k, () => `<b>${p.label}</b>`);
    const v = h('td', { class: 'v' });
    v.append(editor(p, els, mode, pl?.proto));
    tr.append(k, v);
    table.append(tr);
  }
  body.append(table);
}

function commonProps(): PropDef[] {
  return [
    { key: 'comments', label: 'Kommentare', group: 'ID-Daten', type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
    { key: 'mark', label: 'Kennzeichen', group: 'ID-Daten', type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
  ];
}

function editor(p: PropDef, els: El[], mode: string, proto?: El): HTMLElement {
  const doc = app.doc;
  let vals: any[] = [];
  try { vals = els.map((e) => p.get(e, doc)); } catch { vals = ['']; }
  const same = vals.every((x) => JSON.stringify(x) === JSON.stringify(vals[0]));
  const val = same ? vals[0] : undefined;
  const ro = !p.set || p.type === 'readonly' || p.type === 'area';
  const apply = (v: any) => {
    if (!p.set) return;
    if (mode === 'placement' && proto) {
      const patch = p.set(proto, v, doc);
      if (patch) Object.assign(proto, patch);
      app.emit('tool');
      return;
    }
    doc.transaction(p.label + ' ändern', () => {
      for (const e of els) {
        const cur = doc.get(e.id); if (!cur) continue;
        const patch = p.set!(cur, v, doc);
        if (patch) doc.update(e.id, patch);
      }
    });
    if (mode === 'view') { app.refreshViews(); app.emit('view'); }
    renderProps();
  };
  if (p.type === 'button') {
    const b = h('button', {}, String(val ?? '…'));
    b.onclick = () => p.action?.(els[0], doc);
    return b;
  }
  if (ro) {
    let s = val === undefined ? '' : String(val);
    if (p.type === 'area' && typeof val === 'number') s = fmtArea(val);
    return h('div', { class: 'ro' }, s);
  }
  switch (p.type) {
    case 'bool': {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = !!val; cb.indeterminate = !same;
      cb.onchange = () => apply(cb.checked);
      return cb;
    }
    case 'select': case 'material': case 'level': {
      const s = h('select', {}) as HTMLSelectElement;
      const opts = p.type === 'material' ? [['', '<Nach Kategorie>'] as [string, string], ...materialOptions(doc)] : p.type === 'level' ? levelOptions(doc) : typeof p.options === 'function' ? p.options(doc) : p.options ?? [];
      if (!same) s.append(h('option', { value: '__mixed' }, ''));
      for (const [k, l] of opts) s.append(h('option', { value: k }, l));
      s.value = same ? String(val ?? '') : '__mixed';
      s.onchange = () => { if (s.value !== '__mixed') apply(s.value); };
      return s;
    }
    case 'color': {
      const c = h('input', { type: 'color', value: val ?? '#000000' }) as HTMLInputElement;
      c.onchange = () => apply(c.value);
      return c;
    }
    default: {
      const fmt = (x: any) => {
        if (x === undefined || x === null) return '';
        if (p.type === 'length') return fmtLen(Number(x));
        if (p.type === 'angle') return fmtNum((Number(x) * 180) / Math.PI, 2) + '°';
        if (p.type === 'number') return fmtNum(Number(x), 2).replace(/,00$/, '');
        return String(x);
      };
      const i = h('input', { type: 'text', value: same ? fmt(val) : '' }) as HTMLInputElement;
      const commit = () => {
        let v: any = i.value;
        if (p.type === 'length') v = parseLen(i.value);
        else if (p.type === 'number') v = parseNum(i.value);
        else if (p.type === 'int') { v = parseNum(i.value); if (v !== null) v = Math.round(v); }
        else if (p.type === 'angle') v = parseAngle(i.value);
        if (v === null || (typeof v === 'number' && isNaN(v))) { i.value = same ? fmt(val) : ''; return; }
        if (same && JSON.stringify(v) === JSON.stringify(val)) return;
        apply(v);
      };
      i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { commit(); i.blur(); } if (e.key === 'Escape') { i.value = same ? fmt(val) : ''; i.blur(); } };
      i.onblur = commit;
      return i;
    }
  }
}

export { setViewProp };
