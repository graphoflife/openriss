// Projektbrowser: Ansichten (nach Art), Legenden, Bauteillisten, Pläne, Familien (Typen).
import { app } from '../app';
import type { Id } from '../core/doc';
import { newId } from '../core/doc';
import { View, levels, typesOf, TypeEl, VIEW_KIND_LABEL } from '../core/view';
import { allBrowserSections, catDef, allCats, emitHook } from '../core/registry';
import { h } from './shell';
import { icon } from './icons';
import { showMenu } from './viewControlBar';
import { setBrowserSel } from './properties';
import { editTypeDialog, promptDialog } from './dialogs';

const closed = new Set<string>(['fam']);
let root: HTMLElement; let treeEl: HTMLElement; let filter = '';
let selId: Id | null = null;

export function buildBrowser(el: HTMLElement): void {
  root = el;
  root.append(h('div', { class: 'palette-title' }, 'Projektbrowser'));
  const search = h('input', { class: 'browser-search', type: 'text', placeholder: 'Suchen…' }) as HTMLInputElement;
  search.oninput = () => { filter = search.value.toLowerCase(); render(); };
  search.onkeydown = (e) => e.stopPropagation();
  treeEl = h('div', { class: 'palette-body tree' });
  root.append(search, treeEl);
  let raf = 0;
  app.doc.on(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });
  app.on('views', render); app.on('view', render);
  render();
}

interface Node { id: string; label: string; icon?: string; children?: Node[]; viewId?: Id; typeId?: Id; open?: () => void; menu?: () => ([string, () => void] | '-')[]; draggable?: boolean }

function viewNodes(kind: View['kind'], ic: string): Node[] {
  const vs = app.doc.all<View>('view').filter((v) => v.kind === kind);
  const lv = new Map(levels(app.doc).map((l, i) => [l.id, i]));
  vs.sort((a, b) => (kind === 'plan' || kind === 'ceiling' ? (lv.get(a.levelId!) ?? 0) - (lv.get(b.levelId!) ?? 0) : 0) || a.name.localeCompare(b.name, 'de', { numeric: true }));
  return vs.map((v) => ({ id: v.id, label: kind === 'sheet' ? `${v.sheetNo ?? ''} - ${v.name}` : v.name, icon: ic, viewId: v.id, draggable: true, menu: () => viewMenu(v) }));
}

function viewMenu(v: View): ([string, () => void] | '-')[] {
  const items: ([string, () => void] | '-')[] = [
    ['Öffnen', () => app.openView(v.id)],
    ['Umbenennen…', () => renameView(v)],
  ];
  if (v.kind !== 'sheet' && v.kind !== 'schedule') {
    items.push(['Duplizieren', () => duplicateView(v, false)]);
    items.push(['Mit Detaillierung duplizieren', () => duplicateView(v, true)]);
  }
  items.push('-', ['Löschen', () => {
    if (!confirm(`Ansicht „${v.name}“ löschen?`)) return;
    app.doc.transaction('Ansicht löschen', () => app.doc.remove(v.id));
  }]);
  return items;
}

export function renameView(v: View): void {
  promptDialog('Ansicht umbenennen', 'Name', v.name, (name) => {
    if (!name) return;
    app.doc.transaction('Umbenennen', () => app.doc.update(v.id, { name }));
    // Grundriss umbenennen → Ebene ebenfalls umbenennen (wie Revit, mit Rückfrage)
    if ((v.kind === 'plan') && v.levelId && app.doc.get(v.levelId)?.name === v.name && confirm('Soll die zugehörige Ebene ebenfalls umbenannt werden?')) {
      app.doc.transaction('Ebene umbenennen', () => app.doc.update(v.levelId!, { name }));
    }
    app.refreshViews(); app.emit('views');
  });
}

export function duplicateView(v: View, withDetail: boolean): Id {
  const doc = app.doc;
  let nid = '';
  doc.transaction('Ansicht duplizieren', () => {
    const copy = JSON.parse(JSON.stringify(v)) as View;
    copy.id = newId('vw');
    let n = 1; let name = `${v.name} - Kopie ${n}`;
    const names = new Set(doc.all<View>('view').map((x) => x.name));
    while (names.has(name)) name = `${v.name} - Kopie ${++n}`;
    copy.name = name;
    if (copy.data?.marker) copy.data = { ...copy.data, marker: copy.data.marker + "'" };
    doc.add(copy);
    nid = copy.id;
    if (withDetail) for (const e of doc.all()) if (e.viewId === v.id && e.cat !== 'view') {
      const c = JSON.parse(JSON.stringify(e)); c.id = newId(e.cat.slice(0, 2)); c.viewId = copy.id; doc.add(c);
    }
  });
  app.emit('views');
  return nid;
}

function build(): Node[] {
  const nodes: Node[] = [];
  const kinds: [View['kind'], string, string][] = [
    ['plan', 'Grundrisse', 'plan'], ['ceiling', 'Deckenpläne', 'ceiling'], ['3d', '3D-Ansichten', 'view3d'],
    ['elevation', 'Ansichten (Gebäudeansicht)', 'elevation'], ['section', 'Schnitte (Gebäudeschnitt)', 'section'], ['drafting', 'Zeichnungsansichten (Detail)', 'drafting'],
  ];
  const viewsGroup: Node = { id: 'views', label: 'Ansichten (alle)', children: [] };
  for (const [k, l, ic] of kinds) {
    const ch = viewNodes(k, ic);
    if (ch.length || k === 'plan') viewsGroup.children!.push({ id: 'k_' + k, label: l, children: ch });
  }
  nodes.push(viewsGroup);
  nodes.push({ id: 'k_legend', label: 'Legenden', children: viewNodes('legend', 'legend') });
  nodes.push({ id: 'k_schedule', label: 'Bauteillisten/Mengen', children: viewNodes('schedule', 'schedule') });
  nodes.push({ id: 'k_sheet', label: 'Pläne (alle)', children: viewNodes('sheet', 'sheet'), menu: () => [['Neuer Plan…', () => emitHook('newSheet')]] });
  for (const s of allBrowserSections()) {
    nodes.push({ id: 'sec_' + s.id, label: s.label, children: s.items(app.doc).map((i) => ({ id: i.id, label: i.label, icon: i.icon, open: () => s.onOpen?.(i.id) })) });
  }
  // Familien
  const fam: Node = { id: 'fam', label: 'Familien', children: [] };
  for (const def of allCats()) {
    if (!def.hasTypes) continue;
    const ts = typesOf(app.doc, def.cat);
    if (!ts.length) continue;
    fam.children!.push({
      id: 'fam_' + def.cat, label: def.plural,
      children: ts.map((t) => ({ id: t.id, label: t.name, typeId: t.id, open: () => editTypeDialog(t as TypeEl), menu: () => typeMenu(t as TypeEl) })),
    });
  }
  nodes.push(fam);
  return nodes;
}

function typeMenu(t: TypeEl): ([string, () => void] | '-')[] {
  return [
    ['Typeigenschaften…', () => editTypeDialog(t)],
    ['Instanz erstellen', () => emitHook('createInstanceOfType', t)],
    ['Alle Exemplare auswählen', () => { app.select(app.doc.all().filter((e) => e.typeId === t.id).map((e) => e.id)); }],
    '-',
    ['Löschen', () => {
      const n = app.doc.all().filter((e) => e.typeId === t.id).length;
      if (typesOf(app.doc, t.of).length <= 1) { alert('Der letzte Typ einer Kategorie kann nicht gelöscht werden.'); return; }
      if (n && !confirm(`${n} Exemplar(e) verwenden diesen Typ und werden ebenfalls gelöscht. Fortfahren?`)) return;
      app.doc.transaction('Typ löschen', () => { for (const e of app.doc.all()) if (e.typeId === t.id) app.doc.remove(e.id); app.doc.remove(t.id); });
    }],
  ];
}

function matches(n: Node): boolean {
  if (!filter) return true;
  if (n.label.toLowerCase().includes(filter)) return true;
  return !!n.children?.some(matches);
}

function render(): void {
  if (!treeEl) return;
  const scroll = treeEl.scrollTop;
  treeEl.innerHTML = '';
  const activeId = app.activeView()?.id;
  const add = (n: Node, parent: HTMLElement) => {
    if (!matches(n)) return;
    const isGroup = !!n.children;
    const row = h('div', { class: 'tree-node' + (n.viewId && n.viewId === activeId ? ' active' : '') + (selId === n.id ? ' sel' : '') });
    const tw = h('span', { class: 'tw' }, isGroup ? (closed.has(n.id) && !filter ? '▸' : '▾') : '');
    row.append(tw);
    if (n.icon) row.append(h('span', { class: 'ti', html: icon(n.icon, 14) }));
    row.append(h('span', {}, n.label));
    parent.append(row);
    if (n.draggable && n.viewId) {
      row.draggable = true;
      row.ondragstart = (e) => { e.dataTransfer?.setData('text/openriss-view', n.viewId!); e.dataTransfer?.setData('text/plain', n.viewId!); };
    }
    row.onclick = () => {
      if (isGroup) { closed.has(n.id) ? closed.delete(n.id) : closed.add(n.id); render(); return; }
      selId = n.id;
      if (n.viewId) setBrowserSel(n.viewId);
      render();
    };
    row.ondblclick = () => { if (n.viewId) app.openView(n.viewId); else n.open?.(); };
    row.oncontextmenu = (e) => { e.preventDefault(); const m = n.menu?.(); if (m?.length) showMenu(e.clientX, e.clientY, m); };
    if (isGroup) {
      const ch = h('div', { class: 'tree-children' + (closed.has(n.id) && !filter ? ' closed' : '') });
      parent.append(ch);
      for (const c of n.children!) add(c, ch);
    }
  };
  for (const n of build()) add(n, treeEl);
  treeEl.scrollTop = scroll;
}

export { VIEW_KIND_LABEL, catDef };
