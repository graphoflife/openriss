// DXF-Export einer Display-Liste: ASCII-DXF AutoCAD 2000 (AC1015, mit Handles/Objekten) oder R12 (AC1009).
// LINE, LWPOLYLINE/POLYLINE, CIRCLE, ARC, TEXT, MTEXT, HATCH (Vollfüllung) bzw. SOLID (R12).
// Rein funktional (ohne DOM) – auch in Node testbar.
import type { DisplayList, Prim, Font } from '../../render/displayList';
import { penMm, DASHES, DashName, halftone, Pen } from '../../render/styles';
import { V2, BBox, emptyBox, extendBox, boxValid, boxOverlap, boxContains, intersection, arcPoints } from '../../core/geom';

export interface DxfWriteOpts {
  version: 'R2000' | 'R12';
  /** Ansichtsmaßstab: Papier-mm × scale = Zeichnungseinheiten (Texthöhen, Linientypen) */
  scale: number;
  /** Layername je Grundelement */
  layerOf: (it: Prim) => string;
  /** Layerfarbe (ACI), Standard 7 */
  layerColor?: (name: string) => number;
  /** alle Farben schwarz/VONLAYER */
  mono?: boolean;
}

// ------------------------------------------------------------ Farben (ACI)
const ACI_BASE: [number, number, number, number][] = [
  [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [8, 128, 128, 128], [9, 192, 192, 192],
  [30, 255, 127, 0], [40, 255, 191, 0], [50, 255, 255, 0], [70, 127, 255, 0], [110, 0, 255, 127], [130, 0, 255, 255], [150, 0, 127, 255], [170, 0, 0, 255],
  [190, 127, 0, 255], [210, 255, 0, 255], [230, 255, 0, 127], [14, 127, 0, 0], [34, 127, 63, 0], [54, 127, 127, 0], [94, 0, 127, 0], [134, 0, 127, 127],
  [174, 0, 0, 127], [214, 127, 0, 127], [250, 51, 51, 51], [251, 91, 91, 91], [252, 132, 132, 132], [253, 173, 173, 173], [254, 214, 214, 214],
];
export function rgbOf(c: string | undefined): [number, number, number] | null {
  const m = (c ?? '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
export function nearestAci(r: number, g: number, b: number): number {
  if (Math.max(r, g, b) < 40) return 7; // schwarz → weiß/schwarz (7)
  if (Math.min(r, g, b) > 235) return 7;
  let best = 7, bd = Infinity;
  for (const [i, R, G, B] of ACI_BASE) { const d = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwOf = (pen: Pen) => { const v = penMm(pen.w) * 100; let best = 0; for (const l of LW) if (Math.abs(l - v) < Math.abs(best - v)) best = l; return best; };
const LTYPE_NAMES: Record<DashName, string> = { solid: 'CONTINUOUS', dash: 'STRICH', hidden: 'VERDECKT', dot: 'PUNKT', center: 'ACHSE', dashdot: 'STRICHPUNKT', longdash: 'LANGSTRICH' };

// ------------------------------------------------------------ Zuschneiden (Rechteck)
function clipSeg(a: V2, b: V2, r: BBox | null): [V2, V2] | null {
  if (!r) return [a, b];
  let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy], q = [a.x - r.min.x, r.max.x - a.x, a.y - r.min.y, r.max.y - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }];
}
/** Polylinie am Rechteck zuschneiden → Teilstücke */
function clipPoly(pts: V2[], closed: boolean, r: BBox | null): { pts: V2[]; closed: boolean }[] {
  if (!r || pts.every((p) => boxContains(r, p))) return [{ pts, closed }];
  const P = closed ? [...pts, pts[0]] : pts;
  const out: { pts: V2[]; closed: boolean }[] = [];
  let cur: V2[] = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const s = clipSeg(P[i], P[i + 1], r);
    if (!s) { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = []; continue; }
    const last = cur[cur.length - 1];
    if (last && Math.hypot(last.x - s[0].x, last.y - s[0].y) < 1e-9) cur.push(s[1]);
    else { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = [s[0], s[1]]; }
    if (Math.hypot(s[1].x - P[i + 1].x, s[1].y - P[i + 1].y) > 1e-9) { out.push({ pts: cur, closed: false }); cur = []; }
  }
  if (cur.length > 1) out.push({ pts: cur, closed: false });
  return out;
}

// ------------------------------------------------------------ Writer
const num = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0.0' : Number.isInteger(r) ? r.toFixed(1) : String(r); };

interface LayerInfo { color: number }

export function writeDxf(dl: DisplayList, o: DxfWriteOpts): Uint8Array<ArrayBuffer> {
  const r12 = o.version === 'R12';
  let hseed = 0x20;
  const nh = () => (hseed++).toString(16).toUpperCase();
  const H = {
    vportT: nh(), ltypeT: nh(), layerT: nh(), styleT: nh(), viewT: nh(), ucsT: nh(), appidT: nh(), dimT: nh(), brT: nh(),
    vport: nh(), ltBB: nh(), ltBL: nh(), ltC: nh(), style: nh(), appid: nh(), dim: nh(), brM: nh(), brP: nh(),
    blkM: nh(), endM: nh(), blkP: nh(), endP: nh(), dict: nh(), group: nh(),
  };
  const layers = new Map<string, LayerInfo>();
  const ltypes = new Set<DashName>();
  const ext = emptyBox();
  const E: string[] = [];
  const g = (arr: string[], code: number, v: string | number) => { arr.push(String(code).padStart(3, ' '), typeof v === 'number' ? (Number.isInteger(v) && code >= 60 && code < 100 || code >= 270 && code < 400 || code === 62 || code === 420 ? String(v) : num(v)) : v); };
  const layerName = (n: string) => {
    let s = n || '0';
    if (r12) s = s.toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS').replace(/[^A-Z0-9_$-]+/g, '_').slice(0, 31) || '0';
    else s = s.replace(/[<>/\\":;?*|=`]+/g, '_');
    if (!layers.has(s)) layers.set(s, { color: o.layerColor?.(n) ?? 7 });
    return s;
  };
  const xp = (p: V2) => { extendBox(ext, p); return p; };

  const head = (type: string, it: Prim, pen?: Pen, sub = '') => {
    g(E, 0, type);
    if (!r12) { g(E, 5, nh()); g(E, 330, H.brM); g(E, 100, 'AcDbEntity'); }
    g(E, 8, layerName(o.layerOf(it)));
    const dash = pen?.dash ?? 'solid';
    if (pen && dash !== 'solid' && DASHES[dash]?.length) { ltypes.add(dash); g(E, 6, LTYPE_NAMES[dash]); }
    const col = pen?.color ?? (it.k === 'text' ? it.font.color : it.k === 'fill' ? it.fill.patColor ?? it.fill.color : undefined);
    if (!o.mono) {
      const c = it.ht ? halftone(col) : col;
      const rgb = rgbOf(c);
      if (rgb && !(rgb[0] < 40 && rgb[1] < 40 && rgb[2] < 40)) {
        g(E, 62, it.ht ? 8 : nearestAci(...rgb));
        if (!r12) g(E, 420, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
      } else if (it.ht) g(E, 62, 8);
    }
    if (!r12 && pen) g(E, 370, lwOf(pen));
    if (!r12 && sub) g(E, 100, sub);
  };
  const line = (it: Prim, a: V2, b: V2, pen: Pen) => {
    head('LINE', it, pen, 'AcDbLine');
    xp(a); xp(b);
    g(E, 10, a.x); g(E, 20, a.y); g(E, 30, 0); g(E, 11, b.x); g(E, 21, b.y); g(E, 31, 0);
  };
  const poly = (it: Prim, pts: V2[], closed: boolean, pen: Pen) => {
    if (pts.length < 2) return;
    if (pts.length === 2 && !closed) { line(it, pts[0], pts[1], pen); return; }
    if (r12) {
      head('POLYLINE', it, pen); g(E, 66, 1); g(E, 10, 0); g(E, 20, 0); g(E, 30, 0); g(E, 70, closed ? 1 : 0);
      const lay = layerName(o.layerOf(it));
      for (const p of pts) { xp(p); g(E, 0, 'VERTEX'); g(E, 8, lay); g(E, 10, p.x); g(E, 20, p.y); g(E, 30, 0); }
      g(E, 0, 'SEQEND'); g(E, 8, lay);
      return;
    }
    head('LWPOLYLINE', it, pen, 'AcDbPolyline');
    g(E, 90, pts.length); g(E, 70, closed ? 1 : 0); g(E, 43, 0);
    for (const p of pts) { xp(p); g(E, 10, p.x); g(E, 20, p.y); }
  };
  const solidFill = (it: Prim, rings: V2[][]) => {
    const rs = rings.filter((r) => r.length >= 3);
    if (!rs.length) return;
    if (r12) {
      // SOLID nur für Drei-/Vierecke
      for (const r of rs) {
        if (r.length > 4) continue;
        const q = r.length === 3 ? [r[0], r[1], r[2], r[2]] : [r[0], r[1], r[3], r[2]];
        head('SOLID', it);
        q.forEach((p, i) => { xp(p); g(E, 10 + i, p.x); g(E, 20 + i, p.y); g(E, 30 + i, 0); });
      }
      return;
    }
    head('HATCH', it, undefined, 'AcDbHatch');
    g(E, 10, 0); g(E, 20, 0); g(E, 30, 0); g(E, 210, 0); g(E, 220, 0); g(E, 230, 1);
    g(E, 2, 'SOLID'); g(E, 70, 1); g(E, 71, 0); g(E, 91, rs.length);
    rs.forEach((r, i) => {
      g(E, 92, i === 0 ? 3 : 2); g(E, 72, 0); g(E, 73, 1); g(E, 93, r.length);
      for (const p of r) { xp(p); g(E, 10, p.x); g(E, 20, p.y); }
      g(E, 97, 0);
    });
    g(E, 75, 1); g(E, 76, 1); g(E, 98, 0);
  };
  const text = (it: Prim, p: V2, s: string, f: Font) => {
    const hgt = f.size * o.scale; const rot = ((f.rot ?? 0) * 180) / Math.PI;
    const ha = f.ha === 'center' ? 1 : f.ha === 'right' ? 2 : 0;
    const va = f.va === 'top' ? 3 : f.va === 'middle' ? 2 : f.va === 'bottom' ? 1 : 0;
    const lines = s.split('\n');
    xp(p);
    if (lines.length > 1 && !r12) {
      // Grundlinie der ersten Zeile → MTEXT oben ausgerichtet, um die Schrifthöhe nach oben versetzt
      const base = !f.va || f.va === 'baseline';
      const att = (f.va === 'top' || base ? 0 : f.va === 'middle' ? 3 : 6) + ha + 1;
      const a0 = f.rot ?? 0;
      const q = base ? { x: p.x - Math.sin(a0) * hgt, y: p.y + Math.cos(a0) * hgt } : p;
      head('MTEXT', it, undefined, 'AcDbMText');
      g(E, 10, q.x); g(E, 20, q.y); g(E, 30, 0); g(E, 40, hgt); g(E, 41, 0); g(E, 71, att); g(E, 72, 1);
      let t = lines.map((l) => l.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => '\\' + c)).join('\\P');
      while (t.length > 250) { g(E, 3, t.slice(0, 250)); t = t.slice(250); }
      g(E, 1, t); g(E, 7, 'STANDARD');
      const a = f.rot ?? 0; g(E, 11, Math.cos(a)); g(E, 21, Math.sin(a)); g(E, 31, 0);
      return;
    }
    const lh = hgt * 1.25; const a = f.rot ?? 0;
    const n0 = va === 2 ? (lines.length - 1) / 2 : va === 1 ? lines.length - 1 : 0;
    lines.forEach((l, i) => {
      if (!l) return;
      const off = (n0 - i) * lh;
      const q = { x: p.x - Math.sin(a) * off, y: p.y + Math.cos(a) * off };
      head('TEXT', it, undefined, 'AcDbText');
      g(E, 10, q.x); g(E, 20, q.y); g(E, 30, 0); g(E, 40, hgt); g(E, 1, (f.underline ? '%%u' : '') + l);
      if (rot) g(E, 50, rot);
      g(E, 7, 'STANDARD');
      if (ha || va) { g(E, 72, ha); g(E, 11, q.x); g(E, 21, q.y); g(E, 31, 0); }
      if (!r12) g(E, 100, 'AcDbText');
      if (va) g(E, 73, va);
    });
  };

  let clip: BBox | null = null;
  for (const it of dl.items) {
    if (it.sel || it.inv) continue;
    if (it.k === 'clip') { clip = it.rings && it.rings.length ? boxOfRings(it.rings) : null; continue; }
    switch (it.k) {
      case 'line': { const s = clipSeg(it.a, it.b, clip); if (s) line(it, s[0], s[1], it.pen); break; }
      case 'poly': for (const pc of clipPoly(it.pts, !!it.closed, clip)) poly(it, pc.pts, pc.closed, it.pen); break;
      case 'fill': {
        let polys: V2[][][] = [it.rings];
        if (clip) {
          const bb = boxOfRings(it.rings);
          if (!boxOverlap(bb, clip)) break;
          if (!(boxContains(clip, bb.min) && boxContains(clip, bb.max))) polys = intersection([it.rings[0], ...it.rings.slice(1)], [[clip.min, { x: clip.max.x, y: clip.min.y }, clip.max, { x: clip.min.x, y: clip.max.y }]]);
        }
        for (const pg of polys) {
          if (it.fill.pattern === 'solid') solidFill(it, pg);
          if (it.pen) for (const r of pg) poly(it, r, true, it.pen);
        }
        break;
      }
      case 'arc': {
        if (clip && !boxOverlap(arcBox(it.c, it.r), clip)) break;
        head('ARC', it, it.pen, 'AcDbCircle');
        xp({ x: it.c.x - it.r, y: it.c.y - it.r }); xp({ x: it.c.x + it.r, y: it.c.y + it.r });
        g(E, 10, it.c.x); g(E, 20, it.c.y); g(E, 30, 0); g(E, 40, it.r);
        if (!r12) g(E, 100, 'AcDbArc');
        g(E, 50, deg(it.a0)); g(E, 51, deg(it.a1));
        break;
      }
      case 'circle': {
        if (clip && !boxOverlap(arcBox(it.c, it.r), clip)) break;
        if (it.fill?.pattern === 'solid') solidFill(it, [arcPoints(it.c, it.r, 0, Math.PI * 2 - 1e-6, 32).slice(0, -1)]);
        if (it.pen) {
          head('CIRCLE', it, it.pen, 'AcDbCircle');
          xp({ x: it.c.x - it.r, y: it.c.y - it.r }); xp({ x: it.c.x + it.r, y: it.c.y + it.r });
          g(E, 10, it.c.x); g(E, 20, it.c.y); g(E, 30, 0); g(E, 40, it.r);
        }
        break;
      }
      case 'text': if (!clip || boxContains(clip, it.p)) text(it, it.p, it.s, it.font); break;
      default: break;
    }
  }
  if (!boxValid(ext)) { extendBox(ext, { x: 0, y: 0 }); extendBox(ext, { x: 1, y: 1 }); }
  return encode(assemble());

  // ---------------------------------------------------------- Dateiaufbau
  function assemble(): string {
    const S: string[] = [];
    const sec = (name: string) => { g(S, 0, 'SECTION'); g(S, 2, name); };
    const end = () => g(S, 0, 'ENDSEC');
    // Tabellenkopf/-eintrag
    const table = (name: string, handle: string, count: number, extra?: () => void) => {
      g(S, 0, 'TABLE'); g(S, 2, name);
      if (!r12) { g(S, 5, handle); g(S, 330, '0'); g(S, 100, 'AcDbSymbolTable'); }
      g(S, 70, count);
      extra?.();
    };
    const rec = (type: string, handle: string, owner: string, sub: string, hcode = 5) => {
      g(S, 0, type);
      if (!r12) { g(S, hcode, handle); g(S, 330, owner); g(S, 100, 'AcDbSymbolTableRecord'); g(S, 100, sub); }
    };
    const ltUsed = [...ltypes].filter((d) => d !== 'solid');
    const pattern = (d: DashName) => DASHES[d].map((v, i) => (i % 2 ? -v : v) * o.scale);
    // HEADER
    sec('HEADER');
    g(S, 9, '$ACADVER'); g(S, 1, r12 ? 'AC1009' : 'AC1015');
    if (!r12) { g(S, 9, '$DWGCODEPAGE'); g(S, 3, 'ANSI_1252'); }
    g(S, 9, '$INSBASE'); g(S, 10, 0); g(S, 20, 0); g(S, 30, 0);
    g(S, 9, '$EXTMIN'); g(S, 10, ext.min.x); g(S, 20, ext.min.y); g(S, 30, 0);
    g(S, 9, '$EXTMAX'); g(S, 10, ext.max.x); g(S, 20, ext.max.y); g(S, 30, 0);
    g(S, 9, '$LIMMIN'); g(S, 10, ext.min.x); g(S, 20, ext.min.y);
    g(S, 9, '$LIMMAX'); g(S, 10, ext.max.x); g(S, 20, ext.max.y);
    g(S, 9, '$LTSCALE'); g(S, 40, 1);
    if (!r12) {
      g(S, 9, '$INSUNITS'); g(S, 70, 4);
      g(S, 9, '$MEASUREMENT'); g(S, 70, 1);
      g(S, 9, '$LWDISPLAY'); g(S, 290, 1);
      g(S, 9, '$HANDSEED'); g(S, 5, '@HANDSEED@');
    }
    end();
    if (!r12) { sec('CLASSES'); end(); }
    // TABLES
    sec('TABLES');
    const cx = (ext.min.x + ext.max.x) / 2, cy = (ext.min.y + ext.max.y) / 2, vh = Math.max(ext.max.y - ext.min.y, (ext.max.x - ext.min.x) / 1.5, 1) * 1.1;
    table('VPORT', H.vportT, 1);
    rec('VPORT', H.vport, H.vportT, 'AcDbViewportTableRecord');
    g(S, 2, '*ACTIVE'); g(S, 70, 0); g(S, 10, 0); g(S, 20, 0); g(S, 11, 1); g(S, 21, 1); g(S, 12, cx); g(S, 22, cy);
    g(S, 13, 0); g(S, 23, 0); g(S, 14, 10); g(S, 24, 10); g(S, 15, 10); g(S, 25, 10); g(S, 16, 0); g(S, 26, 0); g(S, 36, 1);
    g(S, 17, 0); g(S, 27, 0); g(S, 37, 0); g(S, 40, vh); g(S, 41, 1.5); g(S, 42, 50); g(S, 43, 0); g(S, 44, 0); g(S, 50, 0); g(S, 51, 0);
    g(S, 71, 0); g(S, 72, 100); g(S, 73, 1); g(S, 74, 3); g(S, 75, 0); g(S, 76, 0); g(S, 77, 0); g(S, 78, 0);
    g(S, 0, 'ENDTAB');
    table('LTYPE', H.ltypeT, (r12 ? 1 : 3) + ltUsed.length);
    if (!r12) {
      for (const [hd, nm] of [[H.ltBB, 'BYBLOCK'], [H.ltBL, 'BYLAYER']]) { rec('LTYPE', hd, H.ltypeT, 'AcDbLinetypeTableRecord'); g(S, 2, nm); g(S, 70, 0); g(S, 3, ''); g(S, 72, 65); g(S, 73, 0); g(S, 40, 0); }
    }
    rec('LTYPE', H.ltC, H.ltypeT, 'AcDbLinetypeTableRecord'); g(S, 2, 'CONTINUOUS'); g(S, 70, 0); g(S, 3, 'Durchgezogen'); g(S, 72, 65); g(S, 73, 0); g(S, 40, 0);
    for (const d of ltUsed) {
      const pat = pattern(d);
      rec('LTYPE', nh(), H.ltypeT, 'AcDbLinetypeTableRecord'); g(S, 2, LTYPE_NAMES[d]); g(S, 70, 0); g(S, 3, LTYPE_NAMES[d]); g(S, 72, 65);
      g(S, 73, pat.length); g(S, 40, pat.reduce((s, v) => s + Math.abs(v), 0));
      for (const v of pat) { g(S, 49, v); if (!r12) g(S, 74, 0); }
    }
    g(S, 0, 'ENDTAB');
    if (!layers.has('0')) layers.set('0', { color: 7 });
    table('LAYER', H.layerT, layers.size);
    for (const [name, li] of layers) {
      rec('LAYER', nh(), H.layerT, 'AcDbLayerTableRecord'); g(S, 2, name); g(S, 70, 0); g(S, 62, li.color); g(S, 6, 'CONTINUOUS');
      if (!r12) g(S, 370, -3);
    }
    g(S, 0, 'ENDTAB');
    table('STYLE', H.styleT, 1);
    rec('STYLE', H.style, H.styleT, 'AcDbTextStyleTableRecord');
    g(S, 2, 'STANDARD'); g(S, 70, 0); g(S, 40, 0); g(S, 41, 1); g(S, 50, 0); g(S, 71, 0); g(S, 42, 2.5); g(S, 3, r12 ? 'txt' : 'arial.ttf'); g(S, 4, '');
    g(S, 0, 'ENDTAB');
    table('VIEW', H.viewT, 0); g(S, 0, 'ENDTAB');
    table('UCS', H.ucsT, 0); g(S, 0, 'ENDTAB');
    table('APPID', H.appidT, 1);
    rec('APPID', H.appid, H.appidT, 'AcDbRegAppTableRecord'); g(S, 2, 'ACAD'); g(S, 70, 0);
    g(S, 0, 'ENDTAB');
    table('DIMSTYLE', H.dimT, 1, () => { if (!r12) { g(S, 100, 'AcDbDimStyleTable'); g(S, 71, 0); } });
    rec('DIMSTYLE', H.dim, H.dimT, 'AcDbDimStyleTableRecord', 105); g(S, 2, 'STANDARD'); g(S, 70, 0);
    g(S, 0, 'ENDTAB');
    if (!r12) {
      table('BLOCK_RECORD', H.brT, 2);
      rec('BLOCK_RECORD', H.brM, H.brT, 'AcDbBlockTableRecord'); g(S, 2, '*MODEL_SPACE');
      rec('BLOCK_RECORD', H.brP, H.brT, 'AcDbBlockTableRecord'); g(S, 2, '*PAPER_SPACE');
      g(S, 0, 'ENDTAB');
    }
    end();
    // BLOCKS
    sec('BLOCKS');
    if (!r12) {
      for (const [bh, eh, br, nm, ps] of [[H.blkM, H.endM, H.brM, '*MODEL_SPACE', false], [H.blkP, H.endP, H.brP, '*PAPER_SPACE', true]] as [string, string, string, string, boolean][]) {
        g(S, 0, 'BLOCK'); g(S, 5, bh); g(S, 330, br); g(S, 100, 'AcDbEntity'); if (ps) g(S, 67, 1); g(S, 8, '0'); g(S, 100, 'AcDbBlockBegin');
        g(S, 2, nm); g(S, 70, 0); g(S, 10, 0); g(S, 20, 0); g(S, 30, 0); g(S, 3, nm); g(S, 1, '');
        g(S, 0, 'ENDBLK'); g(S, 5, eh); g(S, 330, br); g(S, 100, 'AcDbEntity'); if (ps) g(S, 67, 1); g(S, 8, '0'); g(S, 100, 'AcDbBlockEnd');
      }
    }
    end();
    sec('ENTITIES'); for (const x of E) S.push(x); end();
    if (!r12) {
      sec('OBJECTS');
      g(S, 0, 'DICTIONARY'); g(S, 5, H.dict); g(S, 330, '0'); g(S, 100, 'AcDbDictionary'); g(S, 281, 1); g(S, 3, 'ACAD_GROUP'); g(S, 350, H.group);
      g(S, 0, 'DICTIONARY'); g(S, 5, H.group); g(S, 330, H.dict); g(S, 100, 'AcDbDictionary'); g(S, 281, 1);
      end();
    }
    g(S, 0, 'EOF');
    const seed = (hseed + 1).toString(16).toUpperCase();
    return S.map((x) => (x === '@HANDSEED@' ? seed : x)).join('\r\n') + '\r\n';
  }
}

const deg = (r: number) => { let d = (r * 180) / Math.PI; d %= 360; if (d < 0) d += 360; return d; };
const arcBox = (c: V2, r: number): BBox => ({ min: { x: c.x - r, y: c.y - r }, max: { x: c.x + r, y: c.y + r } });
function boxOfRings(rs: V2[][]): BBox { const b = emptyBox(); for (const r of rs) for (const p of r) extendBox(b, p); return b; }

/** Windows-1252/Latin-1; andere Zeichen als \U+XXXX */
export function encode(s: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (c === 0x20ac) out.push(0x80);
    else for (const x of '\\U+' + c.toString(16).toUpperCase().padStart(4, '0')) out.push(x.charCodeAt(0));
  }
  return new Uint8Array(out);
}
