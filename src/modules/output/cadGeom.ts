// Geometrie des CAD-Imports (Element 'cadimport'): Transformation, ACI-Farben, Zerlegung in einfache Teile und
// Umwandlung ins Zwischenformat des Vektorimports (Linientyp/Linienstärke → Linienstil). DOM-frei.
import type { El, Id } from '../../core/doc';
import { V2, Mat2, apply, compose, matScale, matAngle, isMirror, rotation } from '../../core/geom';
import type { DashName } from '../../render/styles';
import { rgbOf } from './dxfWrite';
import type { CadEnt, CadLtype } from './dxfParse';
import { VecData, VPath, emptyVec, dashOfArray, VAl, HAl } from './vectorImport';

export interface CadImport extends El {
  cat: 'cadimport';
  viewId: Id;
  name: string;
  /** mm je Datei-Einheit */
  unit: number;
  /** Lage des Basispunkts in der Ansicht (mm) */
  offset: V2;
  rotation: number;
  scale?: number;
  mirror?: boolean;
  /** Basispunkt in Datei-Einheiten (gespeicherte Koordinaten sind relativ dazu) */
  base: V2;
  /** Umgrenzung relativ zum Basispunkt (Datei-Einheiten) */
  box?: { min: V2; max: V2 };
  entities: CadEnt[];
  layers: string[];
  hiddenLayers?: string[];
  /** Linientypen der Datei (CadEnt.lt) */
  ltypes?: CadLtype[];
  colors: 'bw' | 'keep' | 'ht';
}

export function cadXf(c: CadImport): Mat2 {
  const s = (c.unit || 1) * (c.scale ?? 1);
  const m: Mat2 = { a: s, b: 0, c: 0, d: c.mirror ? -s : s, e: 0, f: 0 };
  return compose({ ...rotation(c.rotation ?? 0), e: c.offset.x, f: c.offset.y }, m);
}

/** AutoCAD-Farbindex → Hex (näherungsweise vollständige Tabelle) */
export function aciHex(k: number | undefined): string {
  if (k === undefined || k === 7 || k === 0 || k === 256) return '#000000';
  if (k < 0) { const v = -k - 1; const s = '#' + v.toString(16).padStart(6, '0'); const rgb = rgbOf(s); return rgb && Math.min(...rgb) > 235 ? '#000000' : s; }
  const base: Record<number, string> = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0' };
  if (base[k]) return base[k];
  const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  if (k >= 250) { const g = [51, 91, 132, 173, 214, 0][k - 250] ?? 0; return hex(g, g, g); }
  const hue = Math.floor((k - 10) / 10) * 15; const sub = (k - 10) % 10;
  const lev = [255, 165, 127, 76, 38][Math.floor(sub / 2)];
  const f = (n: number) => { const kk = (n + hue / 60) % 6; return 1 - Math.max(0, Math.min(kk, 4 - kk, 1)); };
  let rgb = [f(5), f(3), f(1)].map((x) => x * lev);
  if (sub % 2) rgb = rgb.map((x) => x / 2 + lev / 2);
  return hex(rgb[0], rgb[1], rgb[2]);
}

function bulgeArc(p0: V2, p1: V2, b: number): { c: V2; r: number; a0: number; a1: number } | null {
  const dx = p1.x - p0.x, dy = p1.y - p0.y; const L = Math.hypot(dx, dy);
  if (L < 1e-12 || Math.abs(b) < 1e-9) return null;
  const ang = 4 * Math.atan(b);
  const r = L / (2 * Math.sin(Math.abs(ang) / 2));
  const hd = r * Math.cos(Math.abs(ang) / 2) * Math.sign(b);
  const c = { x: (p0.x + p1.x) / 2 - (dy / L) * hd, y: (p0.y + p1.y) / 2 + (dx / L) * hd };
  let a0 = Math.atan2(p0.y - c.y, p0.x - c.x), a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  if (b < 0) [a0, a1] = [a1, a0];
  return { c, r: Math.abs(r), a0, a1 };
}

/** Geometrie eines CAD-Imports als Liste einfacher Teile in Ansichtskoordinaten */
export type Part =
  | { k: 'line'; a: V2; b: V2; e: CadEnt }
  | { k: 'poly'; pts: V2[]; closed: boolean; e: CadEnt }
  | { k: 'arc'; c: V2; r: number; a0: number; a1: number; e: CadEnt }
  | { k: 'circle'; c: V2; r: number; e: CadEnt }
  | { k: 'fill'; pts: V2[]; e: CadEnt }
  | { k: 'text'; p: V2; s: string; size: number; rot: number; ha: number; va: number; e: CadEnt };

export function cadParts(c: CadImport, cb: (p: Part) => void): void {
  const m = cadXf(c); const s = matScale(m); const mir = isMirror(m); const rot = matAngle(m);
  const hidden = new Set((c.hiddenLayers ?? []).map((l) => c.layers.indexOf(l)));
  const P = (x: number, y: number) => apply(m, { x, y });
  const arc = (e: CadEnt, cc: V2, r: number, a0: number, a1: number) => {
    const [b0, b1] = mir ? [rot - a1, rot - a0] : [a0 + rot, a1 + rot];
    cb({ k: 'arc', c: apply(m, cc), r: r * s, a0: b0, a1: b1, e });
  };
  for (const e of c.entities) {
    if (e.L !== undefined && hidden.has(e.L)) continue;
    const p = e.p;
    switch (e.t) {
      case 'l': cb({ k: 'line', a: P(p[0], p[1]), b: P(p[2], p[3]), e }); break;
      case 'p': {
        const raw: V2[] = []; for (let i = 0; i + 1 < p.length; i += 2) raw.push({ x: p[i], y: p[i + 1] });
        if (!e.b) { cb({ k: 'poly', pts: raw.map((q) => apply(m, q)), closed: !!e.c, e }); break; }
        // gerade Abschnitte als Polylinie, Bulges als Bögen
        let run: V2[] = [raw[0]];
        const n = raw.length; const segs = e.c ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const q0 = raw[i], q1 = raw[(i + 1) % n]; const b = e.b[i] ?? 0;
          const a = b ? bulgeArc(q0, q1, b) : null;
          if (a) {
            if (run.length > 1) cb({ k: 'poly', pts: run.map((q) => apply(m, q)), closed: false, e });
            arc(e, a.c, a.r, a.a0, a.a1); run = [q1];
          } else run.push(q1);
        }
        if (run.length > 1) cb({ k: 'poly', pts: run.map((q) => apply(m, q)), closed: false, e });
        break;
      }
      case 'c': cb({ k: 'circle', c: P(p[0], p[1]), r: (e.r ?? 0) * s, e }); break;
      case 'a': arc(e, { x: p[0], y: p[1] }, e.r ?? 0, e.a0 ?? 0, e.a1 ?? 0); break;
      case 's': { const pts: V2[] = []; for (let i = 0; i + 1 < p.length; i += 2) pts.push(P(p[i], p[i + 1])); cb({ k: 'fill', pts, e }); break; }
      case 't': {
        const r0 = e.rot ?? 0;
        const d = { x: m.a * Math.cos(r0) + m.c * Math.sin(r0), y: m.b * Math.cos(r0) + m.d * Math.sin(r0) };
        cb({ k: 'text', p: P(p[0], p[1]), s: e.s ?? '', size: (e.h ?? 1) * s, rot: Math.atan2(d.y, d.x), ha: e.ha ?? 0, va: e.va ?? 0, e });
        break;
      }
    }
  }
}

// ------------------------------------------------------------ Linientypen → Strichart
const LT_NAMES: [RegExp, DashName][] = [
  [/^(ACHSE|CENTER|MITTE)/, 'center'], [/^(STRICHPUNKT|DASHDOT|STRICH_?PUNKT|PHANTOM|DIVIDE|BORDER|GRENZE)/, 'dashdot'],
  [/^(LANGSTRICH|LONGDASH|DASHEDX2|LONG)/, 'longdash'], [/^(VERDECKT|HIDDEN|HIDDENX?\d*$)/, 'hidden'],
  [/^(PUNKT|DOT)/, 'dot'], [/^(STRICH|DASH|GESTRICHELT)/, 'dash'],
];
/** DXF-Linientyp → Strichart: bekannte Namen, sonst Muster (Zeichnungseinheiten × k → Papier-mm) */
export function cadDash(lt: CadLtype | undefined, k: number): DashName {
  if (!lt) return 'solid';
  const n = lt.name.toUpperCase();
  const iso = /^ACAD_ISO(\d+)W/.exec(n);
  if (iso) { const k2 = +iso[1]; return k2 === 2 || k2 === 3 || k2 === 6 ? 'dash' : k2 === 7 ? 'dot' : k2 === 4 || k2 === 5 || k2 === 8 || k2 === 10 || k2 === 12 ? 'center' : 'dashdot'; }
  for (const [re, d] of LT_NAMES) if (re.test(n)) return d;
  return dashOfArray(lt.pat.map((v) => (v === 0 ? 0.2 : Math.abs(v) * k)));
}

const HA: HAl[] = ['left', 'center', 'right'];
const VA: VAl[] = ['baseline', 'bottom', 'middle', 'top'];
/**
 * CAD-Import → Zwischenformat in Ansichts-mm (Farben je nach Farbmodus, Linienstärke 370 → Stift, Linientyp → Strichart).
 * viewScale: Massstab der Zielansicht (Textgrösse und Strichmuster auf Papier).
 */
export function cadToVec(c: CadImport, viewScale: number, keepColors = c.colors === 'keep'): VecData {
  const d = emptyVec();
  const k = ((c.unit || 1) * (c.scale ?? 1)) / (viewScale || 1);
  const col = (e: CadEnt) => (keepColors ? aciHex(e.k) : '#000000');
  const stroke = (e: CadEnt) => ({ color: col(e), width: e.w ? e.w / 100 : 0, dashName: cadDash(e.lt !== undefined ? c.ltypes?.[e.lt] : undefined, k) });
  const layer = (e: CadEnt) => (e.L !== undefined ? c.layers[e.L] : undefined);
  const path = (e: CadEnt, p: Omit<VPath, 'layer'>) => d.paths.push({ ...p, layer: layer(e) });
  const end = (cc: V2, r: number, a: number) => ({ x: cc.x + Math.cos(a) * r, y: cc.y + Math.sin(a) * r });
  cadParts(c, (q) => {
    switch (q.k) {
      case 'line': path(q.e, { subs: [{ p0: q.a, segs: [{ p: q.b }], closed: false }], stroke: stroke(q.e) }); break;
      case 'poly': path(q.e, { subs: [{ p0: q.pts[0], segs: q.pts.slice(1).map((p) => ({ p })), closed: q.closed }], stroke: stroke(q.e) }); break;
      case 'arc': path(q.e, { subs: [{ p0: end(q.c, q.r, q.a0), segs: [{ p: end(q.c, q.r, q.a1), arc: { c: q.c, r: q.r, ccw: true } }], closed: false }], stroke: stroke(q.e) }); break;
      case 'circle': {
        const a = end(q.c, q.r, 0), b = end(q.c, q.r, Math.PI); const arc = { c: q.c, r: q.r, ccw: true };
        path(q.e, { subs: [{ p0: a, segs: [{ p: b, arc }, { p: a, arc }], closed: true }], stroke: stroke(q.e) });
        break;
      }
      case 'fill': path(q.e, { subs: [{ p0: q.pts[0], segs: q.pts.slice(1).map((p) => ({ p })), closed: true }], fill: { color: col(q.e), pattern: 'solid' } }); break;
      case 'text': d.texts.push({ p: q.p, s: q.s, size: q.size, rot: q.rot, color: col(q.e), ha: HA[q.ha] ?? 'left', va: VA[q.va] ?? 'baseline', layer: layer(q.e) }); break;
    }
  });
  d.layers = c.layers.slice();
  return d;
}
