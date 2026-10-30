// Zentrale Anwendung: Dokument, Auswahl, aktives Werkzeug, geöffnete Ansichten.
import { Doc, El, Id, newId } from './core/doc';
import type { View } from './core/view';
import { catDef, ViewportLike, viewportFactory, emitHook } from './core/registry';
import type { Tool } from './tools/tool';
import type { V2 } from './core/geom';
import { glob } from './core/env';

type Ev = 'selection' | 'tool' | 'view' | 'views' | 'status' | 'settings' | 'prompt';

export interface Settings {
  thinLines: boolean;
  snaps: boolean;
  /** einzelne Fangarten */
  snapKinds: Record<string, boolean>;
  background: string;
  /** Beschriftung bei Platzierung (Türen/Fenster/Räume) */
  tagOnPlace: boolean;
  autosave: boolean;
}

export class App {
  doc = new Doc();
  selection = new Set<Id>();
  tool!: Tool;
  defaultTool!: Tool;
  viewports = new Map<Id, ViewportLike>();
  openOrder: Id[] = [];
  active: ViewportLike | null = null;
  lastCommand: string | null = null;
  clipboard: { els: El[]; viewId: Id; levelId?: Id } | null = null;
  /** Vorgabe für einmalige Fangüberschreibung (SE, SM, …) */
  snapOverride: string | null = null;
  settings: Settings = {
    thinLines: false, snaps: true, background: '#ffffff', tagOnPlace: true, autosave: true,
    snapKinds: { end: true, mid: true, int: true, center: true, quad: true, near: true, perp: true, angle: true, length: true },
  };
  /** DOM-Container für Ansichten (von der Oberfläche gesetzt) */
  viewHost!: HTMLElement;
  private listeners = new Map<Ev, (() => void)[]>();
  statusText = '';
  promptText = '';

  constructor() {
    try {
      const s = localStorage.getItem('openriss.settings');
      if (s) this.settings = { ...this.settings, ...JSON.parse(s), snapKinds: { ...this.settings.snapKinds, ...JSON.parse(s).snapKinds } };
    } catch { /* ignorieren */ }
    this.doc.on((cs, origin) => {
      // Auswahl bereinigen
      let changed = false;
      for (const id of [...this.selection]) if (!this.doc.has(id)) { this.selection.delete(id); changed = true; }
      // gelöschte Ansichten schließen
      for (const id of [...this.viewports.keys()]) if (!this.doc.has(id)) this.closeView(id);
      for (const vp of this.viewports.values()) vp.invalidate();
      if (changed) this.emit('selection');
      if (origin === 'load') this.emit('views');
      this.emit('status');
    });
  }

  on(ev: Ev, fn: () => void): void { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)!).push(fn); }
  emit(ev: Ev): void { for (const f of this.listeners.get(ev) ?? []) { try { f(); } catch (e) { console.error(e); } } }

  saveSettings(): void {
    try { localStorage.setItem('openriss.settings', JSON.stringify(this.settings)); } catch { /* */ }
    for (const vp of this.viewports.values()) vp.invalidate();
    this.emit('settings');
  }

  // ------------------------------------------------------------ Werkzeuge
  setTool(t: Tool | null, cmdId?: string): void {
    const next = t ?? this.defaultTool;
    if (this.tool) { try { this.tool.deactivate(); } catch (e) { console.error(e); } }
    if (this.doc.isLive()) this.doc.cancelLive();
    this.tool = next;
    if (cmdId && next !== this.defaultTool) this.lastCommand = cmdId;
    next.activate();
    this.setPrompt(next.prompt());
    this.emit('tool');
    for (const vp of this.viewports.values()) vp.invalidate();
  }
  /** Esc: Werkzeug-Schritt abbrechen, beim zweiten Mal zum Ändern-Werkzeug */
  escape(): void {
    if (this.tool !== this.defaultTool) {
      if (!this.tool.escape()) this.setTool(null);
      else { this.setPrompt(this.tool.prompt()); this.redrawOverlay(); }
    } else if (!this.tool.escape()) {
      this.select([]);
    }
  }
  setPrompt(s: string): void { this.promptText = s; this.emit('prompt'); }

  // ------------------------------------------------------------ Auswahl
  select(ids: Iterable<Id>, mode: 'set' | 'add' | 'remove' | 'toggle' = 'set'): void {
    if (mode === 'set') this.selection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'add') this.selection.add(id);
      else if (mode === 'remove') this.selection.delete(id);
      else if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    }
    this.emit('selection');
    this.redrawOverlay();
  }
  selected<T extends El = El>(): T[] { return [...this.selection].map((id) => this.doc.get<T>(id)).filter(Boolean) as T[]; }

  // ------------------------------------------------------------ Ansichten
  activeView(): View | null { return this.active?.view ?? null; }
  openView(id: Id): void {
    const v = this.doc.get<View>(id);
    if (!v) return;
    let vp = this.viewports.get(id);
    if (!vp) {
      const f = viewportFactory(v.kind);
      if (!f) { alert('Diese Ansichtsart ist noch nicht verfügbar: ' + v.kind); return; }
      vp = f.create(v, this.viewHost);
      this.viewports.set(id, vp);
      this.openOrder.push(id);
      setTimeout(() => vp!.zoomExtents(), 0);
    }
    if (this.active && this.active !== vp) this.active.deactivate();
    this.active = vp;
    this.openOrder = [...this.openOrder.filter((x) => x !== id), id];
    vp.activate();
    // Werkzeuge, die an eine Ansicht gebunden sind, abbrechen
    if (this.tool && this.tool !== this.defaultTool && this.tool.viewBound) this.setTool(null);
    this.emit('view');
    this.emit('views');
  }
  closeView(id: Id): void {
    const vp = this.viewports.get(id);
    if (!vp) return;
    vp.dispose();
    this.viewports.delete(id);
    this.openOrder = this.openOrder.filter((x) => x !== id);
    if (this.active === vp) {
      this.active = null;
      const next = this.openOrder[this.openOrder.length - 1];
      if (next) this.openView(next);
    }
    this.emit('views');
    this.emit('view');
  }
  /** aktualisierte View-Daten aus dem Dokument in die Viewports übernehmen */
  refreshViews(): void {
    for (const [id, vp] of this.viewports) { const v = this.doc.get<View>(id); if (v) vp.view = v; vp.invalidate(); }
  }
  redrawOverlay(): void { for (const vp of this.viewports.values()) (vp as any).redrawOverlay?.(); }

  // ------------------------------------------------------------ Bearbeitung
  deleteSelection(): void {
    const act = this.activeView()?.id;
    const ids = [...this.selection].filter((id) => !this.doc.get(id)?.pinned && id !== act);
    if (!ids.length) { if (this.selection.size) this.status('Fixierte Elemente können nicht gelöscht werden.'); return; }
    const views = ids.map((id) => this.doc.get(id)).filter((e) => e?.cat === 'view');
    if (views.length && !confirm(`${views.length} Ansicht(en) werden mit allen Beschriftungen gelöscht. Fortfahren?`)) return;
    this.doc.transaction('Löschen', () => { for (const id of ids) this.doc.remove(id); });
    this.select([]);
  }
  status(s: string): void { this.statusText = s; this.emit('status'); setTimeout(() => { if (this.statusText === s) { this.statusText = ''; this.emit('status'); } }, 4000); }

  /** Elemente kopieren inkl. gehosteter Elemente; liefert neue IDs (in laufender Transaktion aufrufen) */
  duplicate(ids: Id[], withHosted = true): Map<Id, Id> {
    const doc = this.doc;
    const all = new Set(ids);
    if (withHosted) for (const e of doc.all()) if (e.hostId && all.has(e.hostId) && e.cat !== 'view') all.add(e.id);
    const idMap = new Map<Id, Id>();
    for (const id of all) idMap.set(id, newId(doc.get(id)?.cat.slice(0, 2) ?? 'e'));
    for (const id of all) {
      const src = doc.get(id); if (!src) continue;
      let copy: El = JSON.parse(JSON.stringify(src));
      copy.id = idMap.get(id)!;
      if (copy.hostId && idMap.has(copy.hostId)) copy.hostId = idMap.get(copy.hostId);
      if (copy.refId && idMap.has(copy.refId)) copy.refId = idMap.get(copy.refId);
      if (copy.cat === 'door' && copy.mark) copy.mark = undefined;
      const def = catDef(copy.cat);
      if (def?.onCopy) { const r = def.onCopy(copy, doc, idMap); if (r) copy = r; }
      doc.add(copy);
    }
    emitHook('duplicated', idMap);
    return idMap;
  }
}

export const app = new App();
glob.openriss = app;
export type { V2 };
