// Das Projektdokument: alle Elemente (Modell, Ansichten, Typen, Materialien …) in einer
// einzigen Tabelle. Änderungen laufen über Transaktionen, die Undo/Redo ermöglichen.
import type { V2 } from './geom';

export type Id = string;

/** Basis aller Elemente. Kategorie-spezifische Felder kommen in den Unterschnittstellen dazu. */
export interface El {
  id: Id;
  cat: string;
  typeId?: Id;
  levelId?: Id;
  /** Ansichtsspezifische Elemente (Beschriftung, Detaillinien …) gehören zu genau einer Ansicht. */
  viewId?: Id;
  pinned?: boolean;
  mark?: string;      // Kennzeichen
  comments?: string;  // Kommentare
  /** Freie Parameter (Projektparameter) */
  params?: Record<string, string | number | boolean>;
  [k: string]: any;
}

export interface ChangeSet {
  added: Set<Id>;
  modified: Set<Id>;
  removed: Set<Id>;
}

interface Txn { name: string; before: Map<Id, El | null>; }
interface UndoEntry { name: string; before: Map<Id, El | null>; after: Map<Id, El | null>; }

type Listener = (cs: ChangeSet, origin: 'edit' | 'undo' | 'redo' | 'load') => void;

const clone = <T>(o: T): T => (o === null || o === undefined ? o : JSON.parse(JSON.stringify(o)));

let idCounter = 0;
export function newId(prefix = 'e'): Id {
  idCounter++;
  return prefix + Date.now().toString(36) + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export class Doc {
  private els = new Map<Id, El>();
  private byCat = new Map<string, Set<Id>>();
  private txn: Txn | null = null;
  private txnDepth = 0;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private listeners: Listener[] = [];
  private pending: ChangeSet = { added: new Set(), modified: new Set(), removed: new Set() };
  /** Wird bei jeder Änderung erhöht – für Caches. */
  version = 0;
  dirty = false;

  // ------------------------------------------------------------ Lesen
  get<T extends El = El>(id: Id | undefined | null): T | undefined {
    return id ? (this.els.get(id) as T | undefined) : undefined;
  }
  has(id: Id): boolean { return this.els.has(id); }
  all<T extends El = El>(cat?: string): T[] {
    if (!cat) return [...this.els.values()] as T[];
    const s = this.byCat.get(cat);
    if (!s) return [];
    const out: T[] = [];
    for (const id of s) out.push(this.els.get(id) as T);
    return out;
  }
  count(cat: string): number { return this.byCat.get(cat)?.size ?? 0; }
  /** Elemente, die ein anderes Element als Host haben (Türen in Wänden, Bewehrung in Bauteilen …). */
  hosted(hostId: Id): El[] {
    const out: El[] = [];
    for (const e of this.els.values()) if (e.hostId === hostId) out.push(e);
    return out;
  }

  // ------------------------------------------------------------ Schreiben
  /** Führt fn als eine rückgängig machbare Transaktion aus. Verschachtelung ist erlaubt. */
  transaction<R>(name: string, fn: () => R): R {
    const outer = this.txnDepth === 0;
    if (outer) this.txn = { name, before: new Map() };
    this.txnDepth++;
    let ok = false;
    try {
      const r = fn();
      ok = true;
      return r;
    } finally {
      this.txnDepth--;
      if (outer) {
        const t = this.txn!;
        this.txn = null;
        if (!ok) {
          // Rollback
          for (const [id, b] of t.before) this.rawSet(id, b);
          this.pending = { added: new Set(), modified: new Set(), removed: new Set() };
        } else if (t.before.size) {
          const after = new Map<Id, El | null>();
          for (const id of t.before.keys()) after.set(id, clone(this.els.get(id) ?? null));
          this.undoStack.push({ name: t.name, before: t.before, after });
          if (this.undoStack.length > 200) this.undoStack.shift();
          this.redoStack = [];
          this.flush('edit');
        }
      }
    }
  }

  private record(id: Id): void {
    if (!this.txn) throw new Error('Änderung außerhalb einer Transaktion: ' + id);
    if (!this.txn.before.has(id)) this.txn.before.set(id, clone(this.els.get(id) ?? null));
  }

  add<T extends El>(el: T): T {
    if (!el.id) el.id = newId(el.cat.slice(0, 2));
    this.record(el.id);
    this.rawSet(el.id, el);
    this.pending.added.add(el.id);
    return el;
  }

  /** Teiländerung eines Elements (flaches Merge). */
  update<T extends El>(id: Id, patch: Partial<T>): T | undefined {
    const el = this.els.get(id);
    if (!el) return undefined;
    this.record(id);
    const n = { ...el, ...clone(patch) } as T;
    for (const k of Object.keys(patch)) if ((patch as any)[k] === undefined) delete (n as any)[k];
    this.rawSet(id, n);
    this.pending.modified.add(id);
    return n;
  }

  /** Löscht Element inkl. abhängiger (gehosteter / referenzierender) Elemente. */
  remove(id: Id): void {
    const el = this.els.get(id);
    if (!el) return;
    this.record(id);
    this.rawSet(id, null);
    this.pending.removed.add(id);
    for (const dep of this.dependents(id)) this.remove(dep);
  }

  /** Elemente, die mit dem Element gelöscht werden müssen. */
  dependents(id: Id): Id[] {
    const out: Id[] = [];
    for (const e of this.els.values()) {
      if (e.hostId === id || e.viewId === id || e.refId === id) out.push(e.id);
      else if (Array.isArray(e.refs) && e.refs.length && e.refs.some((r: any) => r && r.id === id) && e.cat === 'dimension') {
        // Bemaßungen mit weniger als 2 gültigen Referenzen entfallen
        const remaining = e.refs.filter((r: any) => !r.id || (r.id !== id && this.els.has(r.id)));
        if (remaining.length < 2) out.push(e.id);
      }
    }
    return out;
  }

  private rawSet(id: Id, el: El | null): void {
    const old = this.els.get(id);
    if (old) this.byCat.get(old.cat)?.delete(id);
    if (el) {
      this.els.set(id, el);
      let s = this.byCat.get(el.cat);
      if (!s) { s = new Set(); this.byCat.set(el.cat, s); }
      s.add(id);
    } else {
      this.els.delete(id);
    }
    this.version++;
  }

  private flush(origin: 'edit' | 'undo' | 'redo' | 'load'): void {
    const cs = this.pending;
    this.pending = { added: new Set(), modified: new Set(), removed: new Set() };
    this.dirty = origin !== 'load';
    for (const l of this.listeners) {
      try { l(cs, origin); } catch (e) { console.error(e); }
    }
  }

  on(l: Listener): () => void {
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter((x) => x !== l); };
  }

  // ------------------------------------------------------------ Live-Transaktionen (Vorschau beim Ziehen)
  private live = false;
  /** Startet eine Transaktion, deren Änderungen sofort sichtbar sind und beliebig oft zurückgesetzt werden können. */
  beginLive(name: string): void {
    if (this.txnDepth > 0) throw new Error('Live-Transaktion innerhalb einer Transaktion');
    this.txn = { name, before: new Map() };
    this.txnDepth = 1;
    this.live = true;
  }
  isLive(): boolean { return this.live; }
  /** Setzt die Live-Änderungen zurück und führt fn neu aus. */
  liveUpdate(fn: () => void): void {
    if (!this.live || !this.txn) return;
    this.restoreLive();
    try { fn(); } catch (e) { console.error(e); }
    this.flush('edit');
  }
  private restoreLive(): void {
    const t = this.txn!;
    for (const [id, b] of t.before) {
      const had = this.els.has(id);
      this.rawSet(id, clone(b));
      if (b && !had) this.pending.added.add(id); else if (!b && had) this.pending.removed.add(id); else this.pending.modified.add(id);
    }
  }
  commitLive(): void {
    if (!this.live || !this.txn) return;
    const t = this.txn;
    this.live = false; this.txn = null; this.txnDepth = 0;
    // nur echte Änderungen behalten
    const after = new Map<Id, El | null>();
    for (const id of [...t.before.keys()]) {
      const a = clone(this.els.get(id) ?? null);
      if (JSON.stringify(a) === JSON.stringify(t.before.get(id))) t.before.delete(id); else after.set(id, a);
    }
    if (t.before.size) {
      this.undoStack.push({ name: t.name, before: t.before, after });
      this.redoStack = [];
      this.dirty = true;
    }
    this.flush('edit');
  }
  cancelLive(): void {
    if (!this.live || !this.txn) return;
    this.restoreLive();
    this.live = false; this.txn = null; this.txnDepth = 0;
    this.flush('edit');
  }
  clearHistory(): void { this.undoStack = []; this.redoStack = []; this.dirty = false; }

  // ------------------------------------------------------------ Undo / Redo
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undoName(): string { return this.undoStack[this.undoStack.length - 1]?.name ?? ''; }
  redoName(): string { return this.redoStack[this.redoStack.length - 1]?.name ?? ''; }

  undo(): void {
    if (this.live) this.cancelLive();
    const u = this.undoStack.pop();
    if (!u) return;
    this.applyStates(u.before);
    this.redoStack.push(u);
    this.flush('undo');
  }
  redo(): void {
    const u = this.redoStack.pop();
    if (!u) return;
    this.applyStates(u.after);
    this.undoStack.push(u);
    this.flush('redo');
  }
  private applyStates(states: Map<Id, El | null>): void {
    for (const [id, st] of states) {
      const had = this.els.has(id);
      this.rawSet(id, clone(st));
      if (st && !had) this.pending.added.add(id);
      else if (!st && had) this.pending.removed.add(id);
      else this.pending.modified.add(id);
    }
  }

  // ------------------------------------------------------------ Serialisierung
  toJSON(): { format: string; version: number; elements: El[] } {
    return { format: 'openriss', version: 1, elements: [...this.els.values()] };
  }
  load(data: { elements: El[] }): void {
    this.els.clear();
    this.byCat.clear();
    this.undoStack = [];
    this.redoStack = [];
    for (const e of data.elements) this.rawSet(e.id, e);
    for (const e of data.elements) this.pending.added.add(e.id);
    this.flush('load');
    this.dirty = false;
  }
}

/** Hilfsfunktion: Schreibzugriff auf Punkte eines Elements bequem kopieren. */
export const P = (p: V2): V2 => ({ x: p.x, y: p.y });
