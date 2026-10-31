// Zeichnet eine Display-Liste auf ein Canvas.
import { DisplayList, Prim, fontWf } from './displayList';
import { PATTERNS, DASHES, penMm, halftone, Pen, Fill, TileCtx } from './styles';
import { Mat2, apply, BBox, boxOverlap } from '../core/geom';

export interface PaintOpts {
  /** Bildschirm-Pixel je Papier-mm */
  pxPerPaperMm: number;
  thin?: boolean;
  /** nur Grundelemente, für die filter true liefert */
  filter?: (it: Prim) => boolean;
  /** alle Farben überschreiben (Markierung) */
  color?: string;
  /** zusätzliche Linienbreite in px (Markierung) */
  boost?: number;
  /** auch "nur bei Auswahl sichtbare" Elemente zeichnen */
  showSel?: boolean;
  /** sichtbarer Bereich in Ansichts-mm (für Culling) */
  visible?: BBox;
  dpr?: number;
  /** Füllungen weglassen (für Markierung) */
  noFill?: boolean;
  background?: string;
}

const tileCache = new Map<string, HTMLCanvasElement>();

// Rasterbilder (Daten-URL → Bild); nach dem Laden wird 'openriss-image' ausgelöst (Neuzeichnen)
const imgCache = new Map<string, HTMLImageElement>();
function cachedImage(src: string): HTMLImageElement | null {
  let im = imgCache.get(src);
  if (!im) {
    if (imgCache.size > 60) imgCache.delete(imgCache.keys().next().value as string);
    im = new Image();
    im.onload = () => window.dispatchEvent(new Event('openriss-image'));
    im.src = src; imgCache.set(src, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

function makeTile(name: string, color: string, res: number): HTMLCanvasElement | null {
  const def = PATTERNS[name];
  if (!def || def.solid) return null;
  const key = name + '|' + color + '|' + res.toFixed(2);
  const hit = tileCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(def.w * res));
  c.height = Math.max(1, Math.round(def.h * res));
  const sx = c.width / def.w, sy = c.height / def.h;
  const g = c.getContext('2d')!;
  g.setTransform(sx, 0, 0, -sy, 0, c.height); // y nach oben
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = Math.max(0.6 / sx, 0.1);
  const t: TileCtx = {
    line(x1, y1, x2, y2, w) { g.lineWidth = Math.max(0.6 / sx, (w ? w * 0.18 : 0.1)); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); },
    dot(x, y, r) { g.beginPath(); g.arc(x, y, Math.max(r, 0.5 / sx), 0, Math.PI * 2); g.fill(); },
    tri(x1, y1, x2, y2, x3, y3) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.closePath(); g.stroke(); },
  };
  def.draw(t);
  if (tileCache.size > 300) tileCache.clear();
  tileCache.set(key, c);
  return c;
}

export function paint(ctx: CanvasRenderingContext2D, dl: DisplayList, xf: Mat2, o: PaintOpts): void {
  const k = o.pxPerPaperMm;
  const scaleXf = Math.hypot(xf.a, xf.b); // px je Ansichts-mm
  const dpr = o.dpr ?? 1;
  let clipped = false;
  const P = (p: { x: number; y: number }) => apply(xf, p);

  const strokeSetup = (pen: Pen, ht: boolean | undefined) => {
    const w = o.thin ? 1 : Math.min(8, Math.max(1, penMm(pen.w) * k));
    ctx.lineWidth = (w + (o.boost ?? 0)) * dpr;
    let col = o.color ?? pen.color ?? '#000000';
    if (ht && !o.color) col = halftone(col);
    ctx.strokeStyle = col;
    const d = DASHES[pen.dash ?? 'solid'];
    ctx.setLineDash(d && d.length ? d.map((x) => Math.max(1, x * k) * dpr) : []);
  };

  const fillWith = (fill: Fill, ht: boolean | undefined, path: () => void) => {
    if (o.noFill) return;
    const pat = fill.pattern;
    if (fill.alpha !== undefined) ctx.globalAlpha = fill.alpha;
    if (pat === 'solid') {
      ctx.fillStyle = o.color ?? (ht ? halftone(fill.patColor ?? fill.color) : fill.patColor ?? fill.color);
      path(); ctx.fill('evenodd');
    } else {
      if (fill.color && fill.color !== 'none' && fill.color !== 'transparent') {
        ctx.fillStyle = o.color ?? (ht ? halftone(fill.color) : fill.color);
        path(); ctx.fill('evenodd');
      }
      if (pat && PATTERNS[pat]) {
        const res = Math.min(24, Math.max(2, k * dpr));
        const tile = makeTile(pat, o.color ?? (ht ? halftone(fill.patColor ?? '#000000') : fill.patColor ?? '#000000'), res);
        if (tile && k > 0.15) {
          const cp = ctx.createPattern(tile, 'repeat');
          if (cp) {
            const def = PATTERNS[pat];
            // Kachel (Papier-mm) auf Bildschirm: Ursprung = Ansichtsursprung
            const s = (k * dpr * def.w) / tile.width;
            const org = apply(xf, { x: 0, y: 0 });
            cp.setTransform(new DOMMatrix([s, 0, 0, s, org.x * dpr, org.y * dpr]));
            ctx.fillStyle = cp;
            path(); ctx.fill('evenodd');
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  };

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  for (let i = 0; i < dl.items.length; i++) {
    const it = dl.items[i];
    if (it.k === 'clip') {
      if (clipped) { ctx.restore(); clipped = false; }
      if (it.rings) {
        ctx.save(); clipped = true;
        ctx.beginPath();
        for (const r of it.rings) { r.forEach((p, j) => { const q = P(p); j ? ctx.lineTo(q.x * dpr, q.y * dpr) : ctx.moveTo(q.x * dpr, q.y * dpr); }); ctx.closePath(); }
        ctx.clip('evenodd');
      }
      continue;
    }
    if (it.sel && !o.showSel) continue;
    if (it.inv) continue;
    if (o.filter && !o.filter(it)) continue;
    if (o.visible) { const bb = dl.boxOf(i); if (bb && !boxOverlap(bb, o.visible)) continue; }
    switch (it.k) {
      case 'line': {
        strokeSetup(it.pen, it.ht);
        const a = P(it.a), b = P(it.b);
        ctx.beginPath(); ctx.moveTo(a.x * dpr, a.y * dpr); ctx.lineTo(b.x * dpr, b.y * dpr); ctx.stroke();
        break;
      }
      case 'poly': {
        strokeSetup(it.pen, it.ht);
        ctx.beginPath();
        it.pts.forEach((p, j) => { const q = P(p); j ? ctx.lineTo(q.x * dpr, q.y * dpr) : ctx.moveTo(q.x * dpr, q.y * dpr); });
        if (it.closed) ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'fill': {
        const path = () => {
          ctx.beginPath();
          for (const r of it.rings) { r.forEach((p, j) => { const q = P(p); j ? ctx.lineTo(q.x * dpr, q.y * dpr) : ctx.moveTo(q.x * dpr, q.y * dpr); }); ctx.closePath(); }
        };
        fillWith(it.fill, it.ht, path);
        if (it.pen) { strokeSetup(it.pen, it.ht); path(); ctx.stroke(); }
        break;
      }
      case 'arc': {
        strokeSetup(it.pen, it.ht);
        const c = P(it.c); const flip = xf.a * xf.d - xf.b * xf.c < 0; const rot = Math.atan2(xf.b, xf.a);
        ctx.beginPath();
        if (flip) ctx.arc(c.x * dpr, c.y * dpr, it.r * scaleXf * dpr, -(it.a0 + rot), -(it.a1 + rot), true);
        else ctx.arc(c.x * dpr, c.y * dpr, it.r * scaleXf * dpr, it.a0 + rot, it.a1 + rot, false);
        ctx.stroke();
        break;
      }
      case 'circle': {
        const c = P(it.c);
        const path = () => { ctx.beginPath(); ctx.arc(c.x * dpr, c.y * dpr, Math.max(0.5, it.r * scaleXf * dpr), 0, Math.PI * 2); };
        if (it.fill) fillWith(it.fill, it.ht, path);
        if (it.pen) { strokeSetup(it.pen, it.ht); path(); ctx.stroke(); }
        break;
      }
      case 'image': {
        const im = cachedImage(it.src);
        const c = Math.cos(it.rot ?? 0), sn = Math.sin(it.rot ?? 0);
        const o0 = P({ x: it.p.x - it.h * sn, y: it.p.y + it.h * c }); // linke obere Ecke
        const ux = P({ x: it.p.x + it.w * c, y: it.p.y + it.w * sn }), p0 = P(it.p);
        const ex = { x: ux.x - p0.x, y: ux.y - p0.y }, ey = { x: p0.x - o0.x, y: p0.y - o0.y };
        ctx.save();
        if (!im || o.color || o.noFill) {
          ctx.strokeStyle = o.color ?? '#808080'; ctx.lineWidth = (1 + (o.boost ?? 0)) * dpr; ctx.setLineDash([]);
          ctx.setTransform(ex.x * dpr, ex.y * dpr, ey.x * dpr, ey.y * dpr, o0.x * dpr, o0.y * dpr);
          ctx.beginPath(); ctx.rect(0, 0, 1, 1); ctx.restore(); ctx.save(); ctx.stroke();
        } else {
          ctx.globalAlpha = it.ht ? 0.45 : it.alpha ?? 1;
          ctx.setTransform((ex.x / im.naturalWidth) * dpr, (ex.y / im.naturalWidth) * dpr, (ey.x / im.naturalHeight) * dpr, (ey.y / im.naturalHeight) * dpr, o0.x * dpr, o0.y * dpr);
          ctx.drawImage(im, 0, 0);
        }
        ctx.restore();
        break;
      }
      case 'text': {
        const f = it.font; const px = f.size * k * dpr;
        if (px < 1.2) break;
        const c = P(it.p);
        const flip = xf.a * xf.d - xf.b * xf.c < 0;
        const rot = (f.rot ?? 0) + Math.atan2(xf.b, xf.a) * (flip ? -1 : 1);
        ctx.save();
        ctx.translate(c.x * dpr, c.y * dpr);
        ctx.rotate(flip ? -rot : rot);
        const wf = fontWf(f);
        if (wf !== 1) ctx.scale(wf, 1);
        const fam = wf !== 1 && !f.wf ? (f.family ?? '').replace(/"[^"]*(narrow|condensed|schmal)[^"]*",\s*/i, '') : f.family;
        ctx.font = `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${px}px ${fam || 'Arial, Helvetica, sans-serif'}`;
        ctx.textAlign = f.ha ?? 'left';
        const lines = it.s.split('\n'); const lh = px * 1.25;
        const va = f.va ?? 'baseline';
        let y0 = 0;
        if (va === 'top') { ctx.textBaseline = 'top'; }
        else if (va === 'middle') { ctx.textBaseline = 'middle'; y0 = -((lines.length - 1) * lh) / 2; }
        else if (va === 'bottom') { ctx.textBaseline = 'bottom'; y0 = -(lines.length - 1) * lh; }
        else { ctx.textBaseline = 'alphabetic'; }
        let col = o.color ?? f.color ?? '#000000';
        if (it.ht && !o.color) col = halftone(col);
        if (f.opaque || f.box) {
          const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
          const x0 = f.ha === 'center' ? -w / 2 : f.ha === 'right' ? -w : 0;
          const top = va === 'top' ? 0 : va === 'middle' ? y0 - px / 2 : va === 'bottom' ? y0 - px : -px * 0.85;
          const h = lh * (lines.length - 1) + px;
          if (f.opaque && !o.color) { ctx.fillStyle = o.background ?? '#ffffff'; ctx.fillRect(x0 - px * 0.2, top - px * 0.15, w + px * 0.4, h + px * 0.3); }
          if (f.box) { ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, 0.18 * k) * dpr; ctx.setLineDash([]); ctx.strokeRect(x0 - px * 0.3, top - px * 0.25, w + px * 0.6, h + px * 0.5); }
        }
        ctx.fillStyle = col;
        lines.forEach((l, j) => ctx.fillText(l, 0, y0 + j * lh));
        if (f.underline) {
          const w = ctx.measureText(lines[0]).width; const x0 = f.ha === 'center' ? -w / 2 : f.ha === 'right' ? -w : 0;
          ctx.fillRect(x0, y0 + px * 0.15, w, Math.max(1, px * 0.06));
        }
        ctx.restore();
        break;
      }
    }
  }
  if (clipped) ctx.restore();
  ctx.restore();
}
