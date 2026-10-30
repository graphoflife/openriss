// Aufbau der Oberfläche: Titelleiste mit Schnellzugriff, Multifunktionsleiste, Optionsleiste,
// Eigenschaften/Projektbrowser links, Ansichtsregister, Statusleiste.
import { app } from '../app';
import { TABS, panelsOf, cmd, Command, contextPanelsFor, catDef } from '../core/registry';
import { icon } from './icons';
import { keyLabel } from './keyboard';
import type { OptionItem } from '../tools/tool';
import { fmtLen, parseLen, parseNum, fmtNum } from '../core/units';
import { buildProperties } from './properties';
import { buildBrowser } from './browser';
import type { View } from '../core/view';
import { projectInfo } from '../core/view';

let activeTab = 'Architektur';
let ctxTabActive = false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') (e as any)[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
}

// ------------------------------------------------------------ Tooltip
let tipEl: HTMLDivElement | null = null; let tipTimer = 0;
export function attachTip(el: HTMLElement, fn: () => string): void {
  el.addEventListener('mouseenter', () => {
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => {
      tipEl?.remove();
      tipEl = h('div', { class: 'tooltip', html: fn() });
      document.body.appendChild(tipEl);
      const r = el.getBoundingClientRect();
      const tr = tipEl.getBoundingClientRect();
      tipEl.style.left = Math.min(r.left, window.innerWidth - tr.width - 6) + 'px';
      tipEl.style.top = (r.bottom + 4 + tr.height > window.innerHeight ? r.top - tr.height - 4 : r.bottom + 4) + 'px';
    }, 450);
  });
  const hide = () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; };
  el.addEventListener('mouseleave', hide);
  el.addEventListener('mousedown', hide);
}
export function cmdTip(c: Command): string {
  const keys = keyLabel(c.id);
  return `<b>${c.label}${keys ? ` <span class="tk">(${keys})</span>` : ''}</b>${c.tip ?? ''}`;
}

export function runCmd(id: string): void {
  const c = cmd(id);
  if (!c) { console.warn('Unbekannter Befehl', id); return; }
  if (c.enabled && !c.enabled()) return;
  try { c.run(); } catch (e) { console.error(e); app.status('Fehler: ' + (e as Error).message); }
}

// ------------------------------------------------------------ Aufbau
export function buildShell(root: HTMLElement): void {
  const title = h('div', { id: 'titlebar' });
  const ribbonTabs = h('div', { id: 'ribbon-tabs' });
  const ribbon = h('div', { id: 'ribbon' });
  const options = h('div', { id: 'optionsbar' });
  const main = h('div', { id: 'main' });
  const status = h('div', { id: 'statusbar' });
  root.append(title, ribbonTabs, ribbon, options, main, status);

  // Titelleiste
  const fileBtn = h('button', { id: 'filebtn', onclick: () => runCmd('fileMenu') }, 'Datei');
  title.append(fileBtn);
  for (const id of ['open', 'save', 'undo', 'redo', '-', 'measure', 'dimAligned', 'text', '-', 'default3d', 'section', 'thinLines', 'closeInactive']) {
    if (id === '-') { title.append(h('span', { style: 'width:8px' })); continue; }
    const b = h('button', { class: 'qat-btn', 'data-cmd': id, html: '' });
    b.onclick = () => runCmd(id);
    attachTip(b, () => { const c = cmd(id); return c ? cmdTip(c) : id; });
    title.append(b);
  }
  const titleText = h('div', { id: 'title' });
  title.append(titleText);
  const right = h('div', { class: 'tb-right' });
  for (const id of ['keyboardShortcuts', 'help']) {
    const b = h('button', { class: 'qat-btn', 'data-cmd': id });
    b.onclick = () => runCmd(id);
    attachTip(b, () => { const c = cmd(id); return c ? cmdTip(c) : id; });
    right.append(b);
  }
  title.append(right);

  // Hauptbereich
  const left = h('div', { id: 'left' });
  const propsPal = h('div', { class: 'palette', id: 'props' });
  const browserPal = h('div', { class: 'palette', id: 'browser' });
  const spH = h('div', { class: 'splitter-h' });
  left.append(propsPal, spH, browserPal);
  const spV = h('div', { class: 'splitter-v' });
  const center = h('div', { id: 'center' });
  const tabs = h('div', { id: 'viewtabs' });
  const host = h('div', { id: 'viewhost' });
  center.append(tabs, host);
  main.append(left, spV, center);
  app.viewHost = host;
  splitter(spV, 'x', (d) => { const w = Math.max(180, Math.min(600, left.getBoundingClientRect().width + d)); main.style.setProperty('--leftw', w + 'px'); });
  splitter(spH, 'y', (d) => { const r = left.getBoundingClientRect(); const ph = propsPal.getBoundingClientRect().height + d; main.style.setProperty('--propsh', Math.max(120, Math.min(r.height - 120, ph)) + 'px'); left.style.setProperty('--propsh', Math.max(120, Math.min(r.height - 120, ph)) + 'px'); });

  buildProperties(propsPal);
  buildBrowser(browserPal);

  // Statusleiste
  const prompt = h('div', { id: 'status-prompt' });
  const msg = h('div', { id: 'status-msg' });
  const keys = h('div', { id: 'status-keys', title: 'Tastenkürzel-Eingabe' });
  const snapBtn = h('button', { class: 'sb-btn', title: 'Objektfang ein/aus (SO = einmalig aus)' }, 'Fang');
  snapBtn.onclick = () => { app.settings.snaps = !app.settings.snaps; app.saveSettings(); };
  const selInfo = h('div', { id: 'status-sel' });
  status.append(prompt, msg, keys, snapBtn, selInfo);

  const renderTitle = () => {
    const pi = projectInfo(app.doc);
    const v = app.activeView();
    titleText.textContent = `OpenRiss – ${pi?.name ?? 'Projekt'}${app.doc.dirty ? ' *' : ''}${v ? ' – ' + viewTitle(v) : ''}`;
    for (const b of title.querySelectorAll<HTMLButtonElement>('.qat-btn')) {
      const c = cmd(b.dataset.cmd!); if (!c) continue;
      if (!b.innerHTML) b.innerHTML = icon(c.icon, 18);
      b.disabled = !!(c.enabled && !c.enabled());
    }
  };
  const renderStatus = () => {
    prompt.textContent = app.promptText;
    msg.textContent = app.statusText;
    snapBtn.className = 'sb-btn' + (app.settings.snaps ? ' on' : '');
    selInfo.innerHTML = '';
    if (app.selection.size) {
      const fb = h('button', { class: 'sb-btn', html: icon('filter', 14) + ' ' + app.selection.size, title: 'Filter – Auswahl nach Kategorie einschränken' });
      fb.onclick = () => runCmd('selectionFilter');
      selInfo.append(fb);
    }
    renderTitle();
  };
  app.on('prompt', renderStatus); app.on('status', renderStatus); app.on('selection', renderStatus); app.on('settings', renderStatus); app.on('view', renderTitle);

  // Multifunktionsleiste
  const renderRibbon = () => {
    ribbonTabs.innerHTML = '';
    const sel = app.selected();
    const cats = new Set(sel.map((e) => e.cat));
    const ctxLabel = sel.length ? 'Ändern | ' + (cats.size === 1 ? (catDef([...cats][0])?.plural ?? [...cats][0]) : 'Mehrfachauswahl') : '';
    const toolCtx = app.tool && app.tool !== app.defaultTool ? 'Ändern | ' + app.tool.label + ' platzieren' : '';
    for (const t of TABS) {
      if (t === 'Ändern' && (ctxLabel || toolCtx)) continue;
      const tab = h('div', { class: 'rtab' + (t === activeTab && !ctxTabActive ? ' on' : '') }, t);
      tab.onclick = () => { activeTab = t; ctxTabActive = false; renderRibbon(); };
      ribbonTabs.append(tab);
    }
    if (ctxLabel || toolCtx) {
      const tab = h('div', { class: 'rtab ctx' + (ctxTabActive ? ' on' : '') }, toolCtx || ctxLabel);
      tab.onclick = () => { ctxTabActive = true; renderRibbon(); };
      ribbonTabs.append(tab);
    } else if (ctxTabActive) { ctxTabActive = false; }
    ribbon.innerHTML = '';
    const panels = ctxTabActive ? [...contextPanelsFor(cats).map((p) => ({ tab: '', panel: p.panel, items: p.items.map((c) => ({ cmd: c, size: 'large' as const })) })), ...panelsOf('Ändern')] : panelsOf(activeTab);
    for (const p of panels) {
      const pan = h('div', { class: 'rpanel' });
      const items = h('div', { class: 'rpanel-items' });
      let col: HTMLDivElement | null = null;
      for (const it of p.items) {
        const c = cmd(it.cmd); if (!c) continue;
        const on = c.checked?.() || app.tool?.id === c.id;
        const dis = !!(c.enabled && !c.enabled());
        if (it.size === 'small') {
          if (!col || col.childElementCount >= 3) { col = h('div', { class: 'rsmall-col' }); items.append(col); }
          const b = h('button', { class: 'rbtn-s' + (on ? ' on' : ''), html: icon(c.icon, 16) + `<span>${c.label}</span>`, disabled: dis });
          b.onclick = () => runCmd(c.id); attachTip(b, () => cmdTip(c));
          col.append(b);
        } else {
          col = null;
          const b = h('button', { class: 'rbtn' + (on ? ' on' : ''), html: icon(c.icon, 30) + `<span class="lbl">${c.label}</span>`, disabled: dis });
          b.onclick = () => runCmd(c.id); attachTip(b, () => cmdTip(c));
          items.append(b);
        }
      }
      pan.append(items, h('div', { class: 'rpanel-title' }, p.panel));
      ribbon.append(pan);
    }
  };
  app.on('selection', () => { ctxTabActive = app.selection.size > 0; renderRibbon(); });
  app.on('tool', () => { renderRibbon(); renderOptions(options); });
  app.on('view', renderRibbon);
  (window as any).__renderRibbon = renderRibbon;
  renderRibbon();

  // Ansichtsregister
  const renderTabs = () => {
    tabs.innerHTML = '';
    for (const id of app.openOrder) {
      const v = app.doc.get<View>(id); if (!v) continue;
      const t = h('div', { class: 'vtab' + (app.activeView()?.id === id ? ' on' : '') }, viewTitle(v));
      const x = h('button', { class: 'x', html: '×', title: 'Ansicht schließen' });
      x.onclick = (e) => { e.stopPropagation(); app.closeView(id); };
      t.append(x);
      t.onclick = () => app.openView(id);
      t.onauxclick = (e) => { if (e.button === 1) app.closeView(id); };
      tabs.append(t);
    }
    host.querySelector('.view-empty')?.remove();
    if (!app.openOrder.length) host.append(h('div', { class: 'view-empty', html: 'Keine Ansicht geöffnet.<br><span class="hint">Doppelklick auf eine Ansicht im Projektbrowser öffnet sie.</span>' }));
  };
  app.on('views', renderTabs); app.on('view', renderTabs);
  renderTabs();
  renderOptions(options);
  renderStatus();
  app.doc.on(() => { renderTitle(); });
}

export function viewTitle(v: View): string {
  const kinds: Record<string, string> = { plan: 'Grundriss', ceiling: 'Deckenplan', elevation: 'Ansicht', section: 'Schnitt', '3d': '3D-Ansicht', drafting: 'Zeichnungsansicht', sheet: 'Plan', schedule: 'Bauteilliste', legend: 'Legende' };
  if (v.kind === 'sheet') return `${kinds.sheet}: ${v.sheetNo ?? ''} - ${v.name}`;
  if (v.kind === 'section' || v.kind === 'elevation' || v.kind === '3d' || v.kind === 'schedule' || v.kind === 'drafting') return v.name;
  return `${kinds[v.kind] ?? v.kind}: ${v.name}`;
}

function splitter(el: HTMLElement, axis: 'x' | 'y', onDelta: (d: number) => void): void {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let last = axis === 'x' ? e.clientX : e.clientY;
    const mv = (ev: MouseEvent) => { const c = axis === 'x' ? ev.clientX : ev.clientY; onDelta(c - last); last = c; };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
}

// ------------------------------------------------------------ Optionsleiste
export function renderOptions(bar: HTMLElement = document.getElementById('optionsbar')!): void {
  bar.innerHTML = '';
  const t = app.tool;
  if (!t) return;
  bar.append(h('span', { class: 'ob-title' }, t === app.defaultTool ? (app.selection.size ? 'Ändern | Auswahl' : 'Ändern') : 'Ändern | ' + t.label));
  let opts: OptionItem[] = [];
  try { opts = t.options(); } catch (e) { console.error(e); }
  for (const o of opts) bar.append(optionControl(o));
  if (t !== app.defaultTool) {
    const done = h('button', { class: 'ob-btn', title: 'Werkzeug beenden (Esc Esc)' }, 'Abbrechen');
    done.onclick = () => app.setTool(null);
    bar.append(h('span', { style: 'flex:1' }), done);
  }
}

export function optionControl(o: OptionItem): HTMLElement {
  switch (o.kind) {
    case 'label': return h('span', {}, o.text);
    case 'check': {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = o.value;
      cb.onchange = () => o.onChange(cb.checked);
      return h('label', {}, cb, o.label);
    }
    case 'select': {
      const s = h('select', {}) as HTMLSelectElement;
      for (const [v, l] of o.options) s.append(h('option', { value: v }, l));
      s.value = o.value; s.onchange = () => o.onChange(s.value);
      return h('label', {}, o.label ? o.label + ':' : '', s);
    }
    case 'buttons': {
      const g = h('span', { class: 'ob-btns' });
      for (const b of o.options) {
        const btn = h('button', { class: b.id === o.value ? 'on' : '', html: b.icon ? icon(b.icon, 18) : b.label });
        attachTip(btn, () => `<b>${b.tip ?? b.label}</b>`);
        btn.onclick = () => { o.onChange(b.id); renderOptions(); };
        g.append(btn);
      }
      return g;
    }
    case 'button': {
      const b = h('button', { class: 'ob-btn' + (o.primary ? ' primary' : ''), html: (o.icon ? icon(o.icon, 16) : '') + o.label });
      b.onclick = o.onClick; return b;
    }
    case 'text': {
      const i = h('input', { type: 'text', value: o.value, style: o.width ? `width:${o.width}px` : '' }) as HTMLInputElement;
      i.onchange = () => o.onChange(i.value);
      i.onkeydown = (e) => e.stopPropagation();
      return h('label', {}, o.label + ':', i);
    }
    default: {
      const fmt = (v: number) => (o.kind === 'length' ? fmtLen(v) : fmtNum(v, o.kind === 'angle' ? 2 : 0).replace(/,0+$/, ''));
      const i = h('input', { type: 'text', value: fmt(o.value), style: o.width ? `width:${o.width}px` : '' }) as HTMLInputElement;
      const apply = () => {
        const v = o.kind === 'length' ? parseLen(i.value) : parseNum(i.value);
        if (v === null) { i.value = fmt(o.value); return; }
        o.onChange(v); o.value = v; i.value = fmt(v);
      };
      i.onchange = apply;
      i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { apply(); i.blur(); } };
      return h('label', {}, o.label ? o.label + ':' : '', i);
    }
  }
}
