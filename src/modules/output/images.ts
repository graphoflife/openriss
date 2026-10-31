// Rasterbilder als Unterlage (ansichtsspezifisch): Einfügen, Ecken ziehen, Skalieren über zwei Referenzpunkte.
import { app } from '../../app';
import type { El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { registerCategory, registerCommand, registerContextPanel, GROUPS, PropDef } from '../../core/registry';
import { View, annoViewId } from '../../core/view';
import { DisplayList, imageCorners } from '../../render/displayList';
import { V2, apply, matAngle, matScale, sub, add, dist, rotate, mid } from '../../core/geom';
import { fmtLen, parseLen } from '../../core/units';
import { Tool, ToolEvent } from '../../tools/tool';
import { startTool } from '../../ui/commands';
import { promptDialog, toast } from '../../ui/dialogs';

export interface ImageEl extends El {
  cat: 'image';
  viewId: Id;
  name?: string;
  dataUrl: string;
  /** linke untere Ecke (Ansichts-mm) */
  origin: V2;
  width: number;
  height: number;
  rotation?: number;
  /** Vordergrund statt Hintergrund (unter dem Modell) */
  front?: boolean;
  halftone?: boolean;
  /** Deckkraft 0..1 */
  opacity?: number;
  /** Seitenverhältnis sperren (Standard ja) */
  lockAspect?: boolean;
}

// Neuzeichnen, sobald ein Bild geladen ist (Canvas-Zeichner löst das Ereignis aus)
if (typeof window !== 'undefined') window.addEventListener('openriss-image', () => { for (const vp of app.viewports.values()) vp.invalidate(); });

const corners = (e: ImageEl) => imageCorners({ p: e.origin, w: e.width, h: e.height, rot: e.rotation ?? 0 });
/** Punkt in Bildkoordinaten (relativ zur linken unteren Ecke, ungedreht) */
const toLocal = (e: ImageEl, p: V2) => rotate(sub(p, e.origin), -(e.rotation ?? 0));
const toView = (e: ImageEl, q: V2) => add(e.origin, rotate(q, e.rotation ?? 0));

registerCategory({
  cat: 'image', label: 'Rasterbild', plural: 'Rasterbilder', annotation: true, planOrder: -100,
  drawAnnotation: (dl, el, _doc, view) => {
    const e = el as ImageEl;
    if (!e.dataUrl) return;
    // Hintergrund: unter allen bisherigen Grundelementen (auf Plänen über dem Papier)
    dl.image(e.origin, e.width, e.height, e.dataUrl, e.rotation ?? 0, { ht: !!e.halftone, alpha: e.opacity ?? 1, ns: true }, !e.front && view.kind !== 'sheet');
    dl.poly(corners(e), { w: 1, color: '#808080', dash: 'dash' }, true, { sel: true, ns: true });
  },
  grips: (el) => corners(el as ImageEl).map((p, i) => ({ id: 'c' + i, p, kind: 'end' as const, tip: 'Größe ändern' })),
  dragGrip: (el, id, p) => {
    const e = el as ImageEl; const i = parseInt(id.slice(1), 10);
    const loc = [{ x: 0, y: 0 }, { x: e.width, y: 0 }, { x: e.width, y: e.height }, { x: 0, y: e.height }];
    const fixed = loc[(i + 2) % 4]; const q = toLocal(e, p);
    let w = Math.abs(q.x - fixed.x), hh = Math.abs(q.y - fixed.y);
    if (w < 1 || hh < 1) return;
    if (e.lockAspect !== false) hh = (w * e.height) / e.width;
    const sx = q.x >= fixed.x ? 1 : -1, sy = q.y >= fixed.y ? 1 : -1;
    const minLocal = { x: sx > 0 ? fixed.x : fixed.x - w, y: sy > 0 ? fixed.y : fixed.y - hh };
    return { origin: toView(e, minLocal), width: w, height: hh };
  },
  transform: (el, m) => {
    const e = el as ImageEl; const s = matScale(m);
    return { origin: apply(m, e.origin), width: e.width * s, height: e.height * s, rotation: (e.rotation ?? 0) + matAngle(m) };
  },
  center: (el) => { const c = corners(el as ImageEl); return mid(c[0], c[2]); },
  props: () => {
    const g = GROUPS;
    const p: PropDef[] = [
      { key: 'width', label: 'Breite', group: g.dims, type: 'length', get: (e) => e.width, set: (e, x) => (x > 0 ? { width: x, ...(e.lockAspect !== false ? { height: (x * e.height) / e.width } : {}) } : undefined) },
      { key: 'height', label: 'Höhe', group: g.dims, type: 'length', get: (e) => e.height, set: (e, x) => (x > 0 ? { height: x, ...(e.lockAspect !== false ? { width: (x * e.width) / e.height } : {}) } : undefined) },
      { key: 'lockAspect', label: 'Seitenverhältnis sperren', group: g.dims, type: 'bool', get: (e) => e.lockAspect !== false, set: (_e, x) => ({ lockAspect: !!x }) },
      { key: 'rotation', label: 'Drehung', group: g.dims, type: 'angle', get: (e) => e.rotation ?? 0, set: (_e, x) => ({ rotation: x }) },
      { key: 'front', label: 'Darstellungsreihenfolge', group: g.graphics, type: 'select', options: [['back', 'Hintergrund'], ['front', 'Vordergrund']], get: (e) => (e.front ? 'front' : 'back'), set: (_e, x) => ({ front: x === 'front' }) },
      { key: 'halftone', label: 'Halbton', group: g.graphics, type: 'bool', get: (e) => !!e.halftone, set: (_e, x) => ({ halftone: !!x }) },
      { key: 'opacity', label: 'Deckkraft (%)', group: g.graphics, type: 'int', get: (e) => Math.round((e.opacity ?? 1) * 100), set: (_e, x) => ({ opacity: Math.max(5, Math.min(100, x)) / 100 }) },
      { key: 'name', label: 'Datei', group: g.identity, type: 'readonly', get: (e) => e.name ?? '' },
      { key: 'scaleRef', label: 'Skalieren', group: g.other, type: 'button', get: () => 'Über zwei Punkte…', action: (e) => { app.select([e.id]); startTool(new ImageScaleTool(e.id), 'imageScale'); } },
    ];
    return p;
  },
});

// ------------------------------------------------------------ Einfügen
function readImage(): Promise<{ name: string; url: string; w: number; h: number }> {
  return new Promise((res, rej) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml';
    i.onchange = () => {
      const f = i.files?.[0]; if (!f) return rej(new Error('Keine Datei'));
      const fr = new FileReader();
      fr.onerror = () => rej(fr.error);
      fr.onload = () => {
        const url = String(fr.result);
        const img = new Image();
        img.onerror = () => rej(new Error('Bild konnte nicht gelesen werden'));
        img.onload = () => {
          let w = img.naturalWidth || 800, h = img.naturalHeight || 600;
          const MAX = 4000;
          // sehr große Bilder verkleinern (Projektgröße)
          if (Math.max(w, h) > MAX && !/svg/.test(f.type)) {
            const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k);
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d')!.drawImage(img, 0, 0, w, h);
            return res({ name: f.name, url: c.toDataURL(f.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9), w, h });
          }
          res({ name: f.name, url, w, h });
        };
        img.src = url;
      };
      fr.readAsDataURL(f);
    };
    i.click();
  });
}

class ImagePlaceTool extends Tool {
  id = 'importImage'; label = 'Bild platzieren'; kinds = ['plan', 'ceiling', 'elevation', 'section', 'drafting', 'legend', 'sheet'];
  private cur: V2 | null = null;
  constructor(private img: { name: string; url: string; w: number; h: number }, private w: number, private hh: number) { super(); }
  prompt() { return 'Klicken Sie, um die Mitte des Bildes zu platzieren.'; }
  move(e: ToolEvent) { this.cur = e.p; }
  down(e: ToolEvent) {
    const el: ImageEl = { id: newId('im'), cat: 'image', viewId: annoViewId(app.doc, e.view), name: this.img.name, dataUrl: this.img.url, origin: { x: e.p.x - this.w / 2, y: e.p.y - this.hh / 2 }, width: this.w, height: this.hh };
    app.doc.transaction('Bild einfügen', () => app.doc.add(el));
    app.setTool(null);
    app.select([el.id]);
    toast('Bild eingefügt. Maßstab anpassen: „Skalieren über zwei Punkte“ in den Eigenschaften.', 4000);
  }
  preview(dl: DisplayList) {
    if (!this.cur) return;
    const o = { x: this.cur.x - this.w / 2, y: this.cur.y - this.hh / 2 };
    dl.image(o, this.w, this.hh, this.img.url, 0, { alpha: 0.6 });
    dl.poly(imageCorners({ p: o, w: this.w, h: this.hh }), { w: 1, color: '#1e6fd9', dash: 'dash' }, true);
  }
}

async function importImageCmd(): Promise<void> {
  const v = app.activeView();
  if (!v || v.kind === '3d' || v.kind === 'schedule') { app.status('Bilder können nur in 2D-Ansichten und Plänen eingefügt werden.'); return; }
  let img;
  try { img = await readImage(); } catch (e) { if ((e as Error).message !== 'Keine Datei') alert((e as Error).message); return; }
  // Größe: 72 dpi auf Papier, im Ansichtsmaßstab (wie Revit)
  const s = (v as View).kind === 'sheet' ? 1 : v.scale || 100;
  let w = (img.w / 72) * 25.4 * s, hh = (img.h / 72) * 25.4 * s;
  const vb = (app.active as any)?.visibleBox?.();
  if (vb) { const k = Math.min(1, ((vb.max.x - vb.min.x) * 0.8) / w, ((vb.max.y - vb.min.y) * 0.8) / hh); w *= k; hh *= k; }
  startTool(new ImagePlaceTool(img, w, hh), 'importImage');
}
registerCommand({ id: 'importImage', label: 'Bild', icon: 'image', tip: 'Rasterbild (PNG, JPG …) als Unterlage in die aktive Ansicht einfügen', run: () => { importImageCmd(); } });

// ------------------------------------------------------------ Skalieren über zwei Referenzpunkte
class ImageScaleTool extends Tool {
  id = 'imageScale'; label = 'Bild skalieren'; kinds = [];
  private a: V2 | null = null; private cur: V2 | null = null;
  constructor(private imgId: Id) { super(); }
  prompt() { return this.a ? 'Zweiten Referenzpunkt auf dem Bild klicken' : 'Ersten Referenzpunkt auf dem Bild klicken (bleibt fest)'; }
  basePoint() { return this.a; }
  move(e: ToolEvent) { this.cur = e.p; }
  escape() { if (this.a) { this.a = null; return true; } return false; }
  down(e: ToolEvent) {
    if (!this.a) { this.a = e.p; return; }
    const a = this.a, b = e.p; const d0 = dist(a, b);
    if (d0 < 1e-6) return;
    app.setTool(null);
    promptDialog('Bild skalieren', 'Tatsächlicher Abstand der Punkte', fmtLen(d0), (s) => {
      const L = parseLen(s); const el = app.doc.get<ImageEl>(this.imgId);
      if (!L || L <= 0 || !el) return;
      const k = L / d0;
      app.doc.transaction('Bild skalieren', () => app.doc.update<ImageEl>(el.id, { origin: add(a, { x: (el.origin.x - a.x) * k, y: (el.origin.y - a.y) * k }), width: el.width * k, height: el.height * k }));
      app.select([el.id]);
    });
  }
  preview(dl: DisplayList) { if (this.a && this.cur) dl.line(this.a, this.cur, { w: 2, color: '#1e6fd9' }); }
}
registerCommand({
  id: 'imageScale', label: 'Skalieren (2 Punkte)', icon: 'imgscale', tip: 'Bild über zwei Referenzpunkte und den tatsächlichen Abstand skalieren',
  enabled: () => app.selected().some((e) => e.cat === 'image'),
  run: () => { const im = app.selected().find((e) => e.cat === 'image'); if (im) startTool(new ImageScaleTool(im.id), 'imageScale'); },
});
registerContextPanel({ cats: ['image'], panel: 'Bild', items: ['imageScale'] });
