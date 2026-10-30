// "Ändern"-Werkzeug: Auswählen (Klick, Fenster, Kreuzen), Vorauswahl mit Tab-Wechsel,
// Ziehen von Elementen und Griffen, Bearbeiten temporärer Bemaßungen.
import { app } from '../app';
import { Tool, ToolEvent } from './tool';
import type { Id, El } from '../core/doc';
import { V2, dist, sub, translation } from '../core/geom';
import { catDef, emitHook, Grip } from '../core/registry';
import type { DisplayList } from '../render/displayList';
import { transformElements, copyTransform } from './ops';
import type { View } from '../core/view';

type Drag =
  | { kind: 'box'; s: V2; c: V2; additive: boolean; remove: boolean }
  | { kind: 'move'; s: V2; started: boolean; ids: Id[]; copy?: boolean }
  | { kind: 'grip'; el: El; grip: Grip; started: boolean; s: V2 };

export class SelectTool extends Tool {
  id = 'select'; label = 'Ändern'; cursor = 'default'; viewBound = false;
  private drag: Drag | null = null;
  private cycle = 0;
  private lastCands: (Id | Id[])[] = [];
  /** Filterfunktion für Auswahl (z.B. "Verknüpfungen auswählen") */
  static filter: ((el: El) => boolean) | null = null;

  wantsSnap(): boolean { return !!this.drag && this.drag.kind !== 'box'; }
  basePoint(): V2 | null { return this.drag && this.drag.kind !== 'box' ? this.drag.s : null; }
  prompt(): string { return 'Klicken Sie, um Elemente auszuwählen. Mit Strg hinzufügen, mit Umschalt entfernen. Tab wechselt zwischen überlagerten Elementen.'; }

  private candidates(e: ToolEvent): Id[] {
    const hits = e.vp.hit(e.raw, (id: Id) => {
      const el = app.doc.get(id); if (!el) return false;
      return SelectTool.filter ? SelectTool.filter(el) : true;
    });
    return hits.map((h: { id: Id }) => h.id);
  }
  /** Kandidaten inkl. Wandkette (Tab wie in Revit) */
  private cycleCands(e: ToolEvent): (Id | Id[])[] {
    const c: (Id | Id[])[] = this.candidates(e);
    const first = c.length ? app.doc.get(c[0] as Id) : undefined;
    if (first?.cat === 'wall') { const ch = wallChain(first.id); if (ch.length > 1) c.splice(1, 0, ch); }
    return c;
  }

  move(e: ToolEvent): void {
    const vp = e.vp;
    if (this.drag) { this.dragMove(e); return; }
    const g = vp.gripAt(e.screen);
    vp.over.style.cursor = g ? 'pointer' : vp.dimAt(e.screen) ? 'text' : 'default';
    const c = this.cycleCands(e);
    if (JSON.stringify(c) !== JSON.stringify(this.lastCands)) { this.cycle = 0; this.lastCands = c; }
    const cur = c[this.cycle % Math.max(1, c.length)] ?? null;
    vp.hover = Array.isArray(cur) ? cur[0] : cur;
    vp.hoverSet = Array.isArray(cur) ? new Set(cur) : null;
    if (vp.hover) {
      const el = app.doc.get(vp.hover);
      const def = el && catDef(el.cat);
      const t = el?.typeId ? app.doc.get(el.typeId)?.name : '';
      app.statusText = el ? `${def?.label ?? el.cat}${t ? ' : ' + t : ''}${el.name && el.cat !== 'type' ? ' : ' + el.name : ''}` : '';
      app.emit('status');
    }
  }

  down(e: ToolEvent): void {
    const vp = e.vp;
    const g = vp.gripAt(e.screen);
    if (g) {
      const def = catDef(g.el.cat);
      if (g.grip.kind === 'flip') {
        const patch = def?.clickGrip?.(g.el, g.grip.id, app.doc, e.view);
        app.doc.transaction('Umkehren', () => { if (patch) app.doc.update(g.el.id, patch); });
        return;
      }
      this.drag = { kind: 'grip', el: g.el, grip: g.grip, started: false, s: g.grip.p };
      return;
    }
    const dh = vp.dimAt(e.screen);
    if (dh) { vp.editTempDim(dh); return; }
    if (vp.hoverSet && vp.hoverSet.size > 1) {
      const ids = [...vp.hoverSet] as Id[];
      app.select(ids, e.ctrl ? 'add' : e.shift ? 'remove' : 'set');
      this.drag = { kind: 'move', s: e.p, started: false, ids: [...app.selection] };
      return;
    }
    const hit = vp.hover ?? this.candidates(e)[0] ?? null;
    if (hit) {
      if (e.shift) { app.select([hit], 'remove'); return; }
      // Strg+Ziehen kopiert (wie Revit); Strg+Klick fügt zur Auswahl hinzu
      if (e.ctrl) { if (!app.selection.has(hit)) app.select([hit], 'add'); this.drag = { kind: 'move', s: e.p, started: false, ids: [...app.selection], copy: true }; return; }
      if (!app.selection.has(hit)) app.select([hit]);
      this.drag = { kind: 'move', s: e.p, started: false, ids: [...app.selection] };
      return;
    }
    this.drag = { kind: 'box', s: e.raw, c: e.raw, additive: e.ctrl, remove: e.shift };
  }

  private dragMove(e: ToolEvent): void {
    const d = this.drag!;
    const doc = app.doc;
    if (d.kind === 'box') { d.c = e.raw; return; }
    const pxMoved = dist(e.vp.toScreen(d.s), e.screen);
    if (!(d as any).started) {
      if (pxMoved < 4) return;
      (d as any).started = true;
      doc.beginLive(d.kind === 'grip' ? 'Griff ziehen' : d.copy ? 'Kopieren' : 'Verschieben');
    }
    if (d.kind === 'grip') {
      doc.liveUpdate(() => {
        const el = doc.get(d.el.id); if (!el) return;
        const def = catDef(el.cat);
        const patch = def?.dragGrip?.(el, d.grip.id, e.p, doc, e.view);
        if (patch) doc.update(el.id, patch);
      });
    } else if (d.kind === 'move') {
      const delta = sub(e.p, d.s);
      doc.liveUpdate(() => {
        if (d.copy) copyTransform(d.ids.filter((id) => !app.doc.get(id)?.pinned), translation(delta.x, delta.y), e.view);
        else transformElements(d.ids, translation(delta.x, delta.y), e.view);
      });
    }
  }

  up(e: ToolEvent): void {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.kind === 'box') {
      const box = { min: { x: Math.min(d.s.x, d.c.x), y: Math.min(d.s.y, d.c.y) }, max: { x: Math.max(d.s.x, d.c.x), y: Math.max(d.s.y, d.c.y) } };
      if (dist(e.vp.toScreen(d.s), e.vp.toScreen(d.c)) < 3) { if (!d.additive && !d.remove) app.select([]); return; }
      const crossing = d.c.x < d.s.x;
      const dl: DisplayList = e.vp.displayList();
      let ids = [...dl.inBox(box, crossing)].filter((id) => {
        const el = app.doc.get(id); if (!el) return false;
        if (el.cat === 'view' && el.id === e.view.id) return false;
        return SelectTool.filter ? SelectTool.filter(el) : true;
      });
      app.select(ids, d.remove ? 'remove' : d.additive ? 'add' : 'set');
      return;
    }
    if ((d as any).started) app.doc.commitLive();
  }

  dbl(e: ToolEvent): void {
    const id = e.vp.hover ?? this.candidates(e)[0];
    if (!id) return;
    const el = app.doc.get(id); if (!el) return;
    if (el.cat === 'view') { app.openView(el.id); return; }
    emitHook('dblclick', el, e);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Tab' && this.lastCands.length > 1) {
      this.cycle++;
      const vp: any = app.active;
      if (vp) {
        const cur = this.lastCands[this.cycle % this.lastCands.length];
        vp.hover = Array.isArray(cur) ? cur[0] : cur; vp.hoverSet = Array.isArray(cur) ? new Set(cur) : null;
        vp.redrawOverlay();
        if (Array.isArray(cur)) { app.statusText = `Wandkette (${cur.length} Wände)`; app.emit('status'); }
      }
      return true;
    }
    return false;
  }

  escape(): boolean {
    if (this.drag) {
      if ((this.drag as any).started) app.doc.cancelLive();
      this.drag = null;
      return true;
    }
    return false;
  }

  space(): boolean {
    // Leertaste: ausgewählte Wände / Türen umkehren (wie Revit)
    const sel = app.selected();
    const flippable = sel.filter((el) => el.cat === 'wall' || el.cat === 'door' || el.cat === 'window');
    if (!flippable.length) return false;
    app.doc.transaction('Umkehren', () => {
      for (const el of flippable) {
        if (el.cat === 'wall') app.doc.update(el.id, { flip: !el.flip });
        else app.doc.update(el.id, { flipFacing: !el.flipFacing });
      }
    });
    return true;
  }

  preview(dl: DisplayList, vp: any): void {
    const d = this.drag;
    if (d && d.kind === 'box') {
      const crossing = d.c.x < d.s.x;
      const pts = [d.s, { x: d.c.x, y: d.s.y }, d.c, { x: d.s.x, y: d.c.y }];
      dl.fill([pts], { color: crossing ? '#2fa84f' : '#2a7be4', alpha: 0.08 }, { w: 1, color: crossing ? '#2f8f2f' : '#1e6fd9', dash: crossing ? 'dash' : 'solid' });
    }
    void vp;
  }
}

/** Über Endpunkte verbundene Wände */
export function wallChain(id: Id): Id[] {
  const walls = app.doc.all<any>('wall');
  const near = (p: V2, q: V2) => Math.abs(p.x - q.x) < 2 && Math.abs(p.y - q.y) < 2;
  const seen = new Set<Id>([id]); const stack = [id];
  while (stack.length) {
    const w = app.doc.get<any>(stack.pop()!); if (!w) continue;
    for (const o of walls) {
      if (seen.has(o.id)) continue;
      if (near(w.a, o.a) || near(w.a, o.b) || near(w.b, o.a) || near(w.b, o.b)) { seen.add(o.id); stack.push(o.id); }
    }
  }
  return [...seen];
}

export function isEditableIn(el: El, view: View): boolean { return !el.viewId || el.viewId === view.id; }
