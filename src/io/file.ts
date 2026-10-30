// Speichern/Öffnen (.oriss = JSON), automatische Zwischenspeicherung im Browser (IndexedDB).
import { app } from '../app';
import { newProject } from '../core/template';
import { projectInfo, View } from '../core/view';
import { applyUnits, toast } from '../ui/dialogs';
import { emitHook } from '../core/registry';

let fileHandle: any = null;
const DB = 'openriss'; const STORE = 'autosave';

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(key: string, val: any): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(val, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
async function idbGet(key: string): Promise<any> {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE, 'readonly'); const r = t.objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export function serialize(): string {
  const data = app.doc.toJSON() as any;
  data.ui = { open: app.openOrder, active: app.activeView()?.id };
  return JSON.stringify(data);
}

export function loadData(data: any): void {
  if (!data || !Array.isArray(data.elements)) throw new Error('Keine gültige OpenRiss-Datei');
  for (const id of [...app.viewports.keys()]) app.closeView(id);
  app.select([]);
  app.doc.load(data);
  applyUnits();
  emitHook('loaded', app.doc);
  const open: string[] = (data.ui?.open ?? []).filter((id: string) => app.doc.has(id));
  if (!open.length) {
    const first = app.doc.all<View>('view').find((v) => v.kind === 'plan');
    if (first) open.push(first.id);
  }
  for (const id of open) app.openView(id);
  if (data.ui?.active && app.doc.has(data.ui.active)) app.openView(data.ui.active);
  app.emit('views');
}

export function createNew(): void {
  if (app.doc.dirty && !confirm('Ungespeicherte Änderungen verwerfen und neues Projekt beginnen?')) return;
  for (const id of [...app.viewports.keys()]) app.closeView(id);
  app.select([]);
  fileHandle = null;
  newProject(app.doc);
  app.doc.clearHistory();
  applyUnits();
  emitHook('loaded', app.doc);
  const first = app.doc.all<View>('view').find((v) => v.kind === 'plan');
  if (first) app.openView(first.id);
  app.emit('views');
}

export async function saveProject(as = false): Promise<void> {
  const json = serialize();
  const name = (projectInfo(app.doc)?.name || 'Projekt').replace(/[^\w\-äöüÄÖÜß ]+/g, '_') + '.oriss';
  const w = window as any;
  try {
    if (w.showSaveFilePicker) {
      if (!fileHandle || as) fileHandle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'OpenRiss-Projekt', accept: { 'application/json': ['.oriss'] } }] });
      const ws = await fileHandle.createWritable(); await ws.write(json); await ws.close();
    } else download(name, json, 'application/json');
    app.doc.dirty = false;
    app.emit('status');
    toast('Projekt gespeichert.');
  } catch (e) {
    if ((e as any)?.name !== 'AbortError') { console.error(e); alert('Speichern fehlgeschlagen: ' + (e as Error).message); }
  }
}

export async function openProject(): Promise<void> {
  if (app.doc.dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
  const w = window as any;
  try {
    let text = '';
    if (w.showOpenFilePicker) {
      const [h] = await w.showOpenFilePicker({ types: [{ description: 'OpenRiss-Projekt', accept: { 'application/json': ['.oriss', '.json'] } }] });
      fileHandle = h; text = await (await h.getFile()).text();
    } else {
      text = await pickFileText('.oriss,.json');
      fileHandle = null;
    }
    loadData(JSON.parse(text));
    toast('Projekt geöffnet.');
  } catch (e) {
    if ((e as any)?.name !== 'AbortError') alert('Öffnen fehlgeschlagen: ' + (e as Error).message);
  }
}

export function pickFileText(accept: string): Promise<string> {
  return new Promise((res, rej) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = async () => { const f = i.files?.[0]; if (!f) return rej(new Error('Keine Datei')); res(await f.text()); };
    i.click();
  });
}
export function download(name: string, content: string | Blob, mime = 'text/plain'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------ Autosave
let saveTimer = 0;
export function installAutosave(): void {
  app.doc.on((_cs, origin) => {
    if (!app.settings.autosave || origin === 'load') return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { idbPut('current', serialize()).catch((e) => console.warn('Autosave fehlgeschlagen', e)); }, 1500);
  });
  window.addEventListener('beforeunload', (e) => {
    if (app.settings.autosave) { try { idbPut('current', serialize()); } catch { /* */ } }
    if (app.doc.dirty && !app.settings.autosave) { e.preventDefault(); e.returnValue = ''; }
  });
}
export async function restoreAutosave(): Promise<boolean> {
  try {
    const s = await idbGet('current');
    if (!s) return false;
    loadData(JSON.parse(s));
    return true;
  } catch (e) { console.warn('Wiederherstellung fehlgeschlagen', e); return false; }
}
