// Display-Liste → SVG (Papier-mm). Basis für SVG-Export und Drucken/PDF.
import { DisplayList } from './displayList';
import { PATTERNS, DASHES, penMm, halftone, Fill, Pen } from './styles';
import { Mat2, apply, BBox, matScale, isMirror, matAngle } from '../core/geom';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

export interface SvgOpts {
  /** Ansichts-mm → Papier-mm (y nach unten) */
  xf: Mat2;
  monochrome?: boolean;
}

export class SvgBuilder {
  private defs = new Map<string, string>();
  private body: string[] = [];
  private clipN = 0;

  add(dl: DisplayList, o: SvgOpts): void {
    const P = (p: { x: number; y: number }) => apply(o.xf, p);
    const s = matScale(o.xf);
    let openClip = false;
    const col = (c: string | undefined, ht?: boolean) => {
      let x = c ?? '#000000';
      if (o.monochrome && x !== '#ffffff') x = '#000000';
      return ht ? halftone(x) : x;
    };
    const stroke = (pen: Pen | undefined, ht?: boolean) => {
      if (!pen) return 'stroke="none"';
      const d = DASHES[pen.dash ?? 'solid'];
      return `stroke="${col(pen.color, ht)}" stroke-width="${n(penMm(pen.w))}"${d.length ? ` stroke-dasharray="${d.join(' ')}"` : ''} fill="none"`;
    };
    const fillAttr = (f: Fill, ht?: boolean): string[] => {
      const out: string[] = [];
      if (f.pattern === 'solid') out.push(`fill="${col(f.patColor ?? f.color, ht)}"`);
      else {
        if (f.color && f.color !== 'none' && f.color !== 'transparent') out.push(`fill="${col(f.color, ht)}"`);
        if (f.pattern && PATTERNS[f.pattern]) out.push(`fill="url(#${this.pattern(f.pattern, col(f.patColor, ht))})"`);
      }
      return out;
    };
    const pathD = (rings: { x: number; y: number }[][]) =>
      rings.map((r) => 'M' + r.map((p) => { const q = P(p); return n(q.x) + ' ' + n(q.y); }).join('L') + 'Z').join('');

    for (const it of dl.items) {
      if (it.sel || it.inv) continue;
      switch (it.k) {
        case 'clip': {
          if (openClip) { this.body.push('</g>'); openClip = false; }
          if (it.rings) {
            const id = 'c' + this.clipN++;
            this.defs.set(id, `<clipPath id="${id}"><path d="${pathD(it.rings)}" clip-rule="evenodd"/></clipPath>`);
            this.body.push(`<g clip-path="url(#${id})">`); openClip = true;
          }
          break;
        }
        case 'line': { const a = P(it.a), b = P(it.b); this.body.push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" ${stroke(it.pen, it.ht)}/>`); break; }
        case 'poly': {
          const pts = it.pts.map((p) => { const q = P(p); return n(q.x) + ',' + n(q.y); }).join(' ');
          this.body.push(`<${it.closed ? 'polygon' : 'polyline'} points="${pts}" ${stroke(it.pen, it.ht)}/>`);
          break;
        }
        case 'fill': {
          const d = pathD(it.rings);
          for (const f of fillAttr(it.fill, it.ht)) this.body.push(`<path d="${d}" fill-rule="evenodd" ${f} stroke="none"/>`);
          if (it.pen) this.body.push(`<path d="${d}" ${stroke(it.pen, it.ht)}/>`);
          break;
        }
        case 'arc': {
          const mir = isMirror(o.xf); const rot = matAngle(o.xf);
          // in Papierkoordinaten (y unten) ist das Bild bereits gespiegelt → Winkel umrechnen
          const a0 = mir ? -(it.a0 + rot) : it.a0 + rot, a1 = mir ? -(it.a1 + rot) : it.a1 + rot;
          const c = P(it.c); const r = it.r * s;
          const p0 = { x: c.x + Math.cos(a0) * r, y: c.y + Math.sin(a0) * r };
          const p1 = { x: c.x + Math.cos(a1) * r, y: c.y + Math.sin(a1) * r };
          let sweep = it.a1 - it.a0; while (sweep < 0) sweep += Math.PI * 2;
          const large = sweep > Math.PI ? 1 : 0; const dir = mir ? 0 : 1;
          this.body.push(`<path d="M${n(p0.x)} ${n(p0.y)}A${n(r)} ${n(r)} 0 ${large} ${dir} ${n(p1.x)} ${n(p1.y)}" ${stroke(it.pen, it.ht)}/>`);
          break;
        }
        case 'circle': {
          const c = P(it.c); const r = it.r * s;
          if (it.fill) for (const f of fillAttr(it.fill, it.ht)) this.body.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}" ${f} stroke="none"/>`);
          if (it.pen) this.body.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}" ${stroke(it.pen, it.ht)}/>`);
          break;
        }
        case 'image': {
          // Einheitsquadrat (y nach unten) → Papier: linke obere Ecke, Breiten- und Höhenrichtung
          const c = Math.cos(it.rot ?? 0), sn = Math.sin(it.rot ?? 0);
          const tl = P({ x: it.p.x - it.h * sn, y: it.p.y + it.h * c }), bl = P(it.p), br = P({ x: it.p.x + it.w * c, y: it.p.y + it.w * sn });
          const op = it.ht ? 0.45 : it.alpha ?? 1;
          this.body.push(`<image href="${esc(it.src)}" x="0" y="0" width="1" height="1" preserveAspectRatio="none"${op < 1 ? ` opacity="${n(op)}"` : ''} transform="matrix(${[br.x - bl.x, br.y - bl.y, bl.x - tl.x, bl.y - tl.y, tl.x, tl.y].map((v) => String(v)).join(' ')})"/>`);
          break;
        }
        case 'text': {
          const f = it.font; const c = P(it.p);
          const mir = isMirror(o.xf);
          const rot = -((f.rot ?? 0) + matAngle(o.xf) * (mir ? -1 : 1)) * (180 / Math.PI);
          const anchor = f.ha === 'center' ? 'middle' : f.ha === 'right' ? 'end' : 'start';
          const base = f.va === 'top' ? 'hanging' : f.va === 'middle' ? 'central' : f.va === 'bottom' ? 'text-after-edge' : 'alphabetic';
          const lines = it.s.split('\n'); const lh = f.size * 1.25;
          const y0 = f.va === 'middle' ? -((lines.length - 1) * lh) / 2 : f.va === 'bottom' ? -(lines.length - 1) * lh : 0;
          const tspans = lines.map((l, j) => `<tspan x="0" y="${n(y0 + j * lh)}">${esc(l)}</tspan>`).join('');
          const deco = f.underline ? ' text-decoration="underline"' : '';
          const bg = f.opaque ? ` style="paint-order:stroke" stroke="#ffffff" stroke-width="${n(f.size * 0.3)}"` : '';
          this.body.push(`<text transform="translate(${n(c.x)} ${n(c.y)}) rotate(${n(rot)})" font-family="Arial, Helvetica, sans-serif" font-size="${n(f.size)}"${f.bold ? ' font-weight="bold"' : ''}${f.italic ? ' font-style="italic"' : ''} text-anchor="${anchor}" dominant-baseline="${base}" fill="${col(f.color, it.ht)}"${deco}${bg}>${tspans}</text>`);
          break;
        }
      }
    }
    if (openClip) this.body.push('</g>');
  }

  raw(s: string): void { this.body.push(s); }

  private pattern(name: string, color: string): string {
    const id = 'p_' + name + '_' + color.replace('#', '');
    if (this.defs.has(id)) return id;
    const def = PATTERNS[name];
    const parts: string[] = [];
    // Kachelkoordinaten y nach oben → in SVG spiegeln
    const Y = (y: number) => def.h - y;
    def.draw({
      line: (x1, y1, x2, y2, w) => parts.push(`<line x1="${n(x1)}" y1="${n(Y(y1))}" x2="${n(x2)}" y2="${n(Y(y2))}" stroke="${color}" stroke-width="${n(w ? w * 0.18 : 0.09)}"/>`),
      dot: (x, y, r) => parts.push(`<circle cx="${n(x)}" cy="${n(Y(y))}" r="${n(r)}" fill="${color}"/>`),
      tri: (x1, y1, x2, y2, x3, y3) => parts.push(`<polygon points="${n(x1)},${n(Y(y1))} ${n(x2)},${n(Y(y2))} ${n(x3)},${n(Y(y3))}" fill="none" stroke="${color}" stroke-width="0.09"/>`),
    });
    this.defs.set(id, `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(def.w)}" height="${n(def.h)}">${parts.join('')}</pattern>`);
    return id;
  }

  toString(widthMm: number, heightMm: number, background = '#ffffff'): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n(widthMm)}mm" height="${n(heightMm)}mm" viewBox="0 0 ${n(widthMm)} ${n(heightMm)}">` +
      `<defs>${[...this.defs.values()].join('')}</defs>` +
      (background ? `<rect x="0" y="0" width="${n(widthMm)}" height="${n(heightMm)}" fill="${background}"/>` : '') +
      this.body.join('\n') + '</svg>';
  }
}

/** Einzelne Ansicht als SVG in ihrem Maßstab (1:scale), Ränder in Papier-mm */
export function dlToSvg(dl: DisplayList, box: BBox, scale: number, margin = 10): string {
  const w = (box.max.x - box.min.x) / scale + margin * 2;
  const h = (box.max.y - box.min.y) / scale + margin * 2;
  const xf: Mat2 = { a: 1 / scale, b: 0, c: 0, d: -1 / scale, e: margin - box.min.x / scale, f: margin + box.max.y / scale };
  const sb = new SvgBuilder();
  sb.add(dl, { xf });
  return sb.toString(w, h);
}
