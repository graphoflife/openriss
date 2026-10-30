// Tastatur: Revit-artige Buchstaben-Kürzel (z.B. WA, DR, MV), Strg-Kombinationen,
// Esc/Enter/Leertaste/Tab/Entf und Längeneingabe beim Zeichnen.
import { app } from '../app';
import { allCommands, cmd } from '../core/registry';

const LS_KEY = 'openriss.shortcuts';
let overrides: Record<string, string[]> = {};
try { overrides = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { overrides = {}; }

export function getShortcuts(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of allCommands()) out[c.id] = overrides[c.id] ?? c.keys ?? [];
  return out;
}
export function setShortcut(id: string, keys: string[]): void { overrides[id] = keys; localStorage.setItem(LS_KEY, JSON.stringify(overrides)); rebuild(); }
export function resetShortcuts(): void { overrides = {}; localStorage.removeItem(LS_KEY); rebuild(); }
export function keyLabel(id: string): string { return (getShortcuts()[id] ?? []).join(', '); }
export function exportShortcuts(): void {
  const blob = new Blob([JSON.stringify(getShortcuts(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'openriss-tastaturbefehle.json'; a.click();
}
export function importShortcuts(done: () => void): void {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,.xml';
  i.onchange = async () => {
    const f = i.files?.[0]; if (!f) return;
    const txt = await f.text();
    try {
      if (txt.trim().startsWith('<')) importRevitXml(txt);
      else { const o = JSON.parse(txt); for (const [k, v] of Object.entries(o)) if (Array.isArray(v)) overrides[k] = v as string[]; }
      localStorage.setItem(LS_KEY, JSON.stringify(overrides)); rebuild(); done();
    } catch (e) { alert('Datei konnte nicht gelesen werden: ' + (e as Error).message); }
  };
  i.click();
}

/** Revit-KeyboardShortcuts.xml: Befehle anhand des Namens zuordnen (soweit bekannt) */
const REVIT_NAMES: Record<string, string> = {
  'wall': 'wall', 'wand': 'wall', 'door': 'door', 'tür': 'door', 'window': 'window', 'fenster': 'window', 'component': 'component', 'bauteil': 'component',
  'move': 'move', 'verschieben': 'move', 'copy': 'copy', 'kopieren': 'copy', 'rotate': 'rotate', 'drehen': 'rotate', 'align': 'align', 'ausrichten': 'align',
  'offset': 'offset', 'versatz': 'offset', 'split element': 'split', 'element teilen': 'split', 'trim/extend to corner': 'trim', 'array': 'array', 'reihe': 'array',
  'aligned dimension': 'dimAligned', 'ausgerichtete bemaßung': 'dimAligned', 'text': 'text', 'tag by category': 'tagByCat', 'level': 'level', 'ebene': 'level',
  'grid': 'grid', 'raster': 'grid', 'reference plane': 'refplane', 'referenzebene': 'refplane', 'detail line': 'detailLine', 'detaillinie': 'detailLine',
  'model line': 'modelLine', 'modelllinie': 'modelLine', 'room': 'room', 'raum': 'room', 'floor': 'floor', 'geschossdecke': 'floor', 'beam': 'beam', 'träger': 'beam',
  'structural column': 'column', 'tragwerksstütze': 'column', 'visibility/ graphics': 'vv', 'sichtbarkeit/grafiken': 'vv', 'delete': 'delete', 'löschen': 'delete',
  'mirror - pick axis': 'mirrorPick', 'spiegeln - achse wählen': 'mirrorPick', 'mirror - draw axis': 'mirrorDraw', 'scale': 'scale', 'skalieren': 'scale',
  'pin': 'pin', 'fixieren': 'pin', 'unpin': 'unpin', 'lösen': 'unpin', 'match type properties': 'match', 'thin lines': 'thinLines', 'dünne linien': 'thinLines',
};
function importRevitXml(xml: string): void {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  let n = 0;
  doc.querySelectorAll('ShortcutItem').forEach((it) => {
    const name = (it.getAttribute('CommandName') ?? '').toLowerCase().replace(/[:&]/g, '').trim();
    const sc = it.getAttribute('Shortcuts'); if (!sc) return;
    const id = REVIT_NAMES[name] ?? Object.entries(REVIT_NAMES).find(([k]) => name.endsWith(k))?.[1];
    if (id && cmd(id)) { overrides[id] = sc.split('#').map((s) => s.toUpperCase()); n++; }
  });
  alert(`${n} Tastaturbefehle aus Revit übernommen.`);
}

// ------------------------------------------------------------ Puffer für Buchstabenfolgen
let map = new Map<string, string>(); // Kürzel → Befehl
let buffer = '';
let timer = 0;
function rebuild(): void {
  map = new Map();
  for (const [id, keys] of Object.entries(getShortcuts())) for (const k of keys) map.set(k.toUpperCase(), id);
}
function showBuffer(): void { const el = document.getElementById('status-keys'); if (el) el.textContent = buffer; }

function feed(ch: string): void {
  buffer += ch.toUpperCase();
  clearTimeout(timer);
  const exact = map.get(buffer);
  const longer = [...map.keys()].some((k) => k.length > buffer.length && k.startsWith(buffer));
  if (exact && !longer) { fire(exact); return; }
  if (!exact && !longer) {
    // keine Übereinstimmung: mit letztem Zeichen neu beginnen
    buffer = ch.toUpperCase();
    const e2 = map.get(buffer); const l2 = [...map.keys()].some((k) => k.length > 1 && k.startsWith(buffer));
    if (e2 && !l2) { fire(e2); return; }
    if (!e2 && !l2) { buffer = ''; }
  }
  showBuffer();
  timer = window.setTimeout(() => { const ex = map.get(buffer); if (ex) fire(ex); else { buffer = ''; showBuffer(); } }, exact ? 650 : 1800);
}
function fire(id: string): void {
  buffer = ''; showBuffer(); clearTimeout(timer);
  const c = cmd(id); if (!c) return;
  if (c.enabled && !c.enabled()) { app.status(`„${c.label}“ ist hier nicht verfügbar.`); return; }
  try { c.run(); } catch (e) { console.error(e); }
}

export function installKeyboard(): void {
  rebuild();
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-back')) return;
    const vp: any = app.active;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      const k = e.key.toLowerCase();
      const ctrlMap: Record<string, string> = { z: 'undo', y: 'redo', s: e.shiftKey ? 'saveAs' : 'save', o: 'open', n: 'new', c: 'clipCopy', x: 'clipCut', v: 'clipPaste', p: 'print', a: 'selectAll' };
      if (k === 'z' && e.shiftKey) { e.preventDefault(); fire('redo'); return; }
      if (ctrlMap[k]) { e.preventDefault(); fire(ctrlMap[k]); return; }
      if (k === '1') { e.preventDefault(); fire('properties'); return; }
      return;
    }
    if (e.altKey) return;
    if (vp?.onKey?.(e)) { e.preventDefault(); return; }
    switch (e.key) {
      case 'Escape': e.preventDefault(); buffer = ''; showBuffer(); app.escape(); return;
      case 'Enter':
        e.preventDefault();
        if (buffer) { const ex = map.get(buffer); if (ex) fire(ex); return; }
        if (!app.tool.enter() && app.tool === app.defaultTool && app.lastCommand) fire(app.lastCommand);
        app.setPrompt(app.tool.prompt());
        return;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (app.tool === app.defaultTool) app.deleteSelection(); else app.tool.key(e);
        return;
      case ' ':
        e.preventDefault(); app.tool.space(); app.redrawOverlay(); return;
      case 'Tab':
        e.preventDefault(); app.tool.key(e); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        if (app.tool === app.defaultTool && app.selection.size) { e.preventDefault(); nudge(e.key, e.shiftKey); }
        return;
    }
    if (app.tool.key(e)) { e.preventDefault(); return; }
    // Zahleneingabe beim Zeichnen → Längeneingabe
    if (/^[0-9.,\-=]$/.test(e.key) && app.tool.typedLength && app.tool.basePoint() && vp?.startTypedLength) {
      e.preventDefault(); vp.startTypedLength(e.key); return;
    }
    if (/^[a-zA-Z0-9]$/.test(e.key)) { e.preventDefault(); feed(e.key); }
  });
}

function nudge(key: string, big: boolean): void {
  const vp: any = app.active; if (!vp?.zoom) return;
  const px = big ? 20 : 2;
  const d = px / vp.zoom;
  const v = { ArrowLeft: { x: -d, y: 0 }, ArrowRight: { x: d, y: 0 }, ArrowUp: { x: 0, y: d }, ArrowDown: { x: 0, y: -d } }[key]!;
  import('../tools/ops').then(({ moveElements }) => {
    app.doc.transaction('Verschieben', () => moveElements([...app.selection], v, vp.view));
  });
}
