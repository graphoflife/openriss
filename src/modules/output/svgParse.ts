// SVG-Leser für den Vektorimport (ohne DOM): eigener kleiner XML-Parser; Pfade (M L H V C S Q T A Z, absolut/relativ),
// rect, circle, ellipse, line, polyline, polygon, text/tspan, g/svg/a/use/symbol mit Transformationen
// (matrix/translate/scale/rotate/skewX/skewY), Stile aus style-Attribut, Präsentationsattributen und einfachen
// <style>-Regeln (Element, .Klasse, #id), clip-path, Einheiten (mm, cm, in, pt, pc, px = 1/96 in).
// Ergebnis in Papier-mm, y nach oben, Ursprung links unten.
import { V2, Mat2, BBox, apply, compose, emptyBox, extendBox, boxValid } from '../../core/geom';
import { PATTERNS } from '../../render/styles';
import { textWidth } from '../../render/displayList';
import { VecData, VPath, VFill, VText, HAl, VAl, PathBuilder, emptyVec, skip, cssColor, subPoints, fontOf } from './vectorImport';

// ------------------------------------------------------------ XML
export interface XNode { name: string; attrs: Record<string, string>; kids: (XNode | string)[]; parent?: XNode }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEnt = (s: string) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Minimaler XML-Parser (Elemente, Attribute, Text, CDATA; Kommentare/PI/DOCTYPE werden übersprungen) */
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, kids: [] };
  let cur = root; let i = 0; const n = src.length;
  const text = (s: string) => { if (s) cur.kids.push(decodeEnt(s)); };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); cur.kids.push(src.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) {
      let j = lt + 2, depth = 0;
      for (; j < n; j++) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt); const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      let x: XNode | undefined = cur; while (x && x.name !== name) x = x.parent;
      if (x?.parent) cur = x.parent;
      i = e < 0 ? n : e + 1; continue;
    }
    let j = lt + 1;
    while (j < n) { const c = src.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++; }
    const el: XNode = { name: src.slice(lt + 1, j), attrs: {}, kids: [], parent: cur };
    let open = false;
    for (;;) {
      while (j < n && isWs(src.charCodeAt(j))) j++;
      if (j >= n) break;
      if (src[j] === '>') { j++; open = true; break; }
      if (src[j] === '/' && src[j + 1] === '>') { j += 2; break; }
      let k = j;
      while (k < n) { const c = src.charCodeAt(k); if (isWs(c) || c === 61 || c === 47 || c === 62) break; k++; }
      const an = src.slice(j, k); j = k;
      while (j < n && isWs(src.charCodeAt(j))) j++;
      if (src[j] === '=') {
        j++; while (j < n && isWs(src.charCodeAt(j))) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); el.attrs[an] = decodeEnt(src.slice(j + 1, e < 0 ? n : e)); j = e < 0 ? n : e + 1; }
        else { let e = j; while (e < n && !isWs(src.charCodeAt(e)) && src[e] !== '>') e++; el.attrs[an] = decodeEnt(src.slice(j, e)); j = e; }
      } else if (an) el.attrs[an] = '';
      else j++;
    }
    cur.kids.push(el);
    if (open) cur = el;
    i = j;
  }
  return root;
}

// ------------------------------------------------------------ Zahlen, Längen, Transformationen
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = (s: string | undefined): number[] => (s ? (s.match(NUM) ?? []).map(Number) : []);
const PX: Record<string, number> = { '': 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6 };
/** Länge in Benutzereinheiten (1 px); em relativ zur Schriftgrösse, % relativ zu ref */
function len(s: string | undefined, def = 0, em = 16, ref = 0): number {
  if (s === undefined || s === '') return def;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)/.exec(s);
  if (!m) return def;
  const v = parseFloat(m[1]); const u = m[2].toLowerCase();
  if (u === 'em') return v * em;
  if (u === 'ex') return v * em * 0.5;
  if (u === '%') return (v / 100) * ref;
  return v * (PX[u] ?? 1);
}
const deg = Math.PI / 180;
export function parseTransform(s: string | undefined): Mat2 {
  let m: Mat2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const v = nums(r[2]); let t: Mat2;
    switch (r[1]) {
      case 'matrix': t = { a: v[0] ?? 1, b: v[1] ?? 0, c: v[2] ?? 0, d: v[3] ?? 1, e: v[4] ?? 0, f: v[5] ?? 0 }; break;
      case 'translate': t = { a: 1, b: 0, c: 0, d: 1, e: v[0] ?? 0, f: v[1] ?? 0 }; break;
      case 'scale': t = { a: v[0] ?? 1, b: 0, c: 0, d: v[1] ?? v[0] ?? 1, e: 0, f: 0 }; break;
      case 'rotate': {
        const a = (v[0] ?? 0) * deg, cs = Math.cos(a), sn = Math.sin(a), cx = v[1] ?? 0, cy = v[2] ?? 0;
        t = { a: cs, b: sn, c: -sn, d: cs, e: cx - cs * cx + sn * cy, f: cy - sn * cx - cs * cy }; break;
      }
      case 'skewX': t = { a: 1, b: 0, c: Math.tan((v[0] ?? 0) * deg), d: 1, e: 0, f: 0 }; break;
      default: t = { a: 1, b: Math.tan((v[0] ?? 0) * deg), c: 0, d: 1, e: 0, f: 0 };
    }
    m = compose(m, t);
  }
  return m;
}
const similar = (m: Mat2) => { const sx = m.a * m.a + m.b * m.b, sy = m.c * m.c + m.d * m.d; return Math.abs(sx - sy) <= 1e-6 * Math.max(sx, sy) && Math.abs(m.a * m.c + m.b * m.d) <= 1e-6 * Math.max(sx, sy); };
const det = (m: Mat2) => m.a * m.d - m.b * m.c;

// ------------------------------------------------------------ Stile
const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'opacity', 'display', 'visibility', 'font-size', 'font-weight',
  'font-style', 'font-family', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'clip-path', 'stop-color', 'font'];
const INHERIT = new Set(['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'visibility', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-anchor', 'dominant-baseline']);
type Sty = Record<string, string>;
interface Rule { sel: string; spec: number; decl: Sty; order: number }
function parseDecl(s: string): Sty {
  const o: Sty = {};
  for (const part of s.split(';')) { const i = part.indexOf(':'); if (i > 0) o[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/!important/i, '').trim(); }
  return o;
}
function parseCss(css: string, rules: Rule[]): void {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^}]*)\}/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const decl = parseDecl(m[2]);
    for (const sel0 of m[1].split(',')) {
      const sel = sel0.trim();
      if (!/^([a-zA-Z][\w-]*)?(\.[\w-]+)*(#[\w-]+)?$/.test(sel) || !sel) continue; // nur einfache Selektoren
      const spec = (sel.match(/#/g)?.length ?? 0) * 100 + (sel.match(/\./g)?.length ?? 0) * 10 + (/^[a-zA-Z]/.test(sel) ? 1 : 0);
      rules.push({ sel, spec, decl, order: rules.length });
    }
  }
}
function matches(sel: string, el: XNode): boolean {
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)(#[\w-]+)?$/.exec(sel); if (!m) return false;
  if (m[1] && m[1] !== el.name.replace(/^svg:/, '')) return false;
  if (m[3] && el.attrs.id !== m[3].slice(1)) return false;
  if (m[2]) { const cls = (el.attrs.class ?? '').split(/\s+/); for (const c of m[2].split('.').filter(Boolean)) if (!cls.includes(c)) return false; }
  return true;
}

// ------------------------------------------------------------ Hauptfunktion
interface Ctx { m: Mat2; st: Sty; clip: BBox | null; clipPolys?: V2[][][] | null; layer?: string; depth: number }

/** SVG-Text → Zwischenformat (Papier-mm, y nach oben) */
export function parseSvg(src: string, o: { tol?: number } = {}): VecData {
  const doc = parseXml(src);
  const d = emptyVec();
  const tol = o.tol ?? 0.05;
  const findSvg = (n: XNode): XNode | null => { for (const k of n.kids) if (typeof k !== 'string') { if (k.name.replace(/^svg:/, '') === 'svg') return k; const r = findSvg(k); if (r) return r; } return null; };
  const svg = findSvg(doc); if (!svg) throw new Error('SVG: kein <svg>-Element gefunden');
  const ids = new Map<string, XNode>(); const rules: Rule[] = [];
  const index = (n: XNode) => {
    for (const k of n.kids) {
      if (typeof k === 'string') continue;
      if (k.attrs.id) ids.set(k.attrs.id, k);
      if (tag(k) === 'style') parseCss(k.kids.filter((x) => typeof x === 'string').join(''), rules);
      index(k);
    }
  };
  index(svg);
  rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
  // Seitengrösse und Grundtransformation (Benutzereinheiten → Papier-mm, y nach oben)
  const vb = nums(svg.attrs.viewBox);
  const MM = 25.4 / 96;
  const wAttr = svg.attrs.width && !/%/.test(svg.attrs.width) ? len(svg.attrs.width) : 0, hAttr = svg.attrs.height && !/%/.test(svg.attrs.height) ? len(svg.attrs.height) : 0;
  let W: number, H: number, root: Mat2;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    W = (wAttr || (hAttr ? (hAttr * vb[2]) / vb[3] : vb[2])) * MM; H = (hAttr || (wAttr ? (wAttr * vb[3]) / vb[2] : vb[3])) * MM;
    let kx = W / vb[2], ky = H / vb[3]; let ox = 0, oy = 0;
    if (!/none/.test(svg.attrs.preserveAspectRatio ?? '')) { const k = Math.min(kx, ky); ox = (W - vb[2] * k) / 2; oy = (H - vb[3] * k) / 2; kx = ky = k; }
    root = { a: kx, b: 0, c: 0, d: -ky, e: ox - kx * vb[0], f: H - oy + ky * vb[1] };
  } else {
    W = wAttr * MM; H = hAttr * MM;
    root = { a: MM, b: 0, c: 0, d: -MM, e: 0, f: H };
  }
  d.w = W; d.h = H;
  const layers = new Set<string>();

  const styleOf = (el: XNode, parent: Sty): Sty => {
    const own: Sty = {};
    for (const p of PROPS) if (el.attrs[p] !== undefined) own[p] = el.attrs[p].trim();
    for (const r of rules) if (matches(r.sel, el)) Object.assign(own, r.decl);
    if (el.attrs.style) Object.assign(own, parseDecl(el.attrs.style));
    if (own.font) { const f = own.font; const sz = /([\d.]+(?:px|pt|mm|em)?)\s*(?:\/[\d.]+\w*)?\s+\S/.exec(f); if (sz && !own['font-size']) own['font-size'] = sz[1]; if (/bold/.test(f) && !own['font-weight']) own['font-weight'] = 'bold'; if (/italic|oblique/.test(f) && !own['font-style']) own['font-style'] = 'italic'; }
    const st: Sty = {};
    for (const k of INHERIT) if (parent[k] !== undefined) st[k] = parent[k];
    for (const [k, v] of Object.entries(own)) {
      if (v === 'inherit') { if (parent[k] !== undefined) st[k] = parent[k]; continue; }
      if (k === 'font-size' && /em|%/.test(v)) { st[k] = String(len(v, 16, len(parent['font-size'], 16), len(parent['font-size'], 16))); continue; }
      st[k] = v;
    }
    return st;
  };

  const fillOf = (st: Sty): VFill | undefined => {
    const f = st.fill ?? '#000000';
    if (parseFloat(st['fill-opacity'] ?? '1') <= 0.001) return undefined;
    const u = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/.exec(f);
    if (u) {
      const ref = ids.get(u[1]);
      const t = ref ? tag(ref) : '';
      if (t === 'pattern') {
        const m = /^p_([A-Za-z]+)_([0-9a-fA-F]{6})$/.exec(u[1]);
        if (m && PATTERNS[m[1]]) return { color: '#' + m[2].toLowerCase(), pattern: m[1] };
        return { color: '#000000', pattern: 'diag' };
      }
      if (t === 'linearGradient' || t === 'radialGradient') {
        const stop = gradStop(ref!);
        const c = cssColor(stop); return c && c.a > 0 ? { color: c.hex, pattern: 'solid' } : undefined;
      }
      const c = cssColor(u[2] || 'none'); return c ? { color: c.hex, pattern: 'solid' } : undefined;
    }
    const c = cssColor(f);
    return c && c.a > 0.001 ? { color: c.hex, pattern: 'solid' } : undefined;
  };
  const gradStop = (g: XNode): string | undefined => {
    let n: XNode | undefined = g;
    for (let k = 0; n && k < 5; k++) {
      const s = n.kids.find((x): x is XNode => typeof x !== 'string' && tag(x) === 'stop');
      if (s) { const st = styleOf(s, {}); return st['stop-color'] ?? '#000000'; }
      const href: string | undefined = n.attrs.href ?? n.attrs['xlink:href'];
      n = href ? ids.get(href.replace(/^#/, '')) : undefined;
    }
    return undefined;
  };
  const strokeOf = (st: Sty, m: Mat2) => {
    const c = cssColor(st.stroke ?? 'none');
    if (!c || c.a <= 0.001 || parseFloat(st['stroke-opacity'] ?? '1') <= 0.001) return undefined;
    const k = Math.sqrt(Math.abs(det(m)));
    const w = len(st['stroke-width'], 1, len(st['font-size'], 16)) * k;
    const da = st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' ? nums(st['stroke-dasharray']).map((v) => v * k) : undefined;
    return { color: c.hex, width: w, dash: da };
  };
  /** Zuschneidebereich setzen: Rechteck als clip, sonst zusätzlich als Polygon */
  const clipOf = (el: XNode, st: Sty, ctx: Ctx): void => {
    const cp = st['clip-path'];
    const u = cp && /url\(\s*['"]?#([^'")]+)/.exec(cp);
    const ref = u ? ids.get(u[1]) : undefined;
    if (!ref) return;
    const pb = new PathBuilder(tol); const bb = emptyBox();
    const m = compose(ctx.m, parseTransform(ref.attrs.transform));
    const walk = (n: XNode, mm: Mat2) => { for (const k of n.kids) if (typeof k !== 'string') { const m2 = compose(mm, parseTransform(k.attrs.transform)); if (tag(k) === 'g') walk(k, m2); else shape(k, m2, pb, styleOf(k, {})); } };
    walk(ref, m);
    const subs = pb.take(); const rings = subs.map((s) => subPoints(s, tol)).filter((r) => r.length >= 3);
    for (const r of rings) for (const q of r) extendBox(bb, q);
    if (!boxValid(bb)) return;
    ctx.clip = ctx.clip ? { min: { x: Math.max(bb.min.x, ctx.clip.min.x), y: Math.max(bb.min.y, ctx.clip.min.y) }, max: { x: Math.min(bb.max.x, ctx.clip.max.x), y: Math.min(bb.max.y, ctx.clip.max.y) } } : bb;
    const rect = rings.length === 1 && rings[0].length === 4 && rings[0].every((p, i) => { const q = rings[0][(i + 1) % 4]; return Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6; });
    if (!rect) ctx.clipPolys = [...(ctx.clipPolys ?? []), rings];
  };

  /** Grundform als Pfad in den Builder (Papier-mm); false = keine Form */
  const shape = (el: XNode, m: Mat2, pb: PathBuilder, st: Sty): boolean => {
    const a = el.attrs; const P = (x: number, y: number) => apply(m, { x, y });
    const em = len(st['font-size'], 16);
    switch (tag(el)) {
      case 'path': pathData(a.d ?? '', m, pb); return true;
      case 'rect': {
        const x = len(a.x, 0, em, W / MM), y = len(a.y, 0, em, H / MM), w = len(a.width, 0, em, W / MM), h = len(a.height, 0, em, H / MM);
        if (!(w > 0 && h > 0)) return false;
        pb.move(P(x, y)); pb.line(P(x + w, y)); pb.line(P(x + w, y + h)); pb.line(P(x, y + h)); pb.close();
        return true;
      }
      case 'circle': case 'ellipse': {
        const cx = len(a.cx, 0, em), cy = len(a.cy, 0, em);
        const rx = tag(el) === 'circle' ? len(a.r, 0, em) : len(a.rx, 0, em), ry = tag(el) === 'circle' ? rx : len(a.ry ?? a.rx, 0, em);
        if (!(rx > 0 && ry > 0)) return false;
        ellipse(cx, cy, rx, ry, m, pb);
        return true;
      }
      case 'line': pb.move(P(len(a.x1, 0, em), len(a.y1, 0, em))); pb.line(P(len(a.x2, 0, em), len(a.y2, 0, em))); return true;
      case 'polyline': case 'polygon': {
        const v = nums(a.points); if (v.length < 4) return false;
        pb.move(P(v[0], v[1])); for (let i = 2; i + 1 < v.length; i += 2) pb.line(P(v[i], v[i + 1]));
        if (tag(el) === 'polygon') pb.close();
        return true;
      }
    }
    return false;
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, m: Mat2, pb: PathBuilder) => {
    const P = (x: number, y: number) => apply(m, { x, y });
    if (Math.abs(rx - ry) < 1e-9 * rx && similar(m)) {
      const c = P(cx, cy); const r = rx * Math.sqrt(Math.abs(det(m)));
      pb.move(P(cx + rx, cy)); pb.arc(P(cx - rx, cy), c, r, true); pb.arc(P(cx + rx, cy), c, r, true);
      pb.cur!.closed = true; return;
    }
    const k = Math.sqrt(Math.abs(det(m))) * Math.max(rx, ry);
    const n = Math.max(16, Math.min(720, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - tol / Math.max(k, tol))))));
    pb.move(P(cx + rx, cy));
    for (let i = 1; i < n; i++) { const t = (2 * Math.PI * i) / n; pb.line(P(cx + rx * Math.cos(t), cy + ry * Math.sin(t))); }
    pb.close();
  };
  /** Pfaddaten (SVG 1.1, F.6.5 für Bögen) */
  const pathData = (s: string, m: Mat2, pb: PathBuilder) => {
    const P = (x: number, y: number) => apply(m, { x, y });
    let i = 0; const n = s.length;
    const ws = () => { while (i < n) { const c = s.charCodeAt(i); if (isWs(c) || c === 44) i++; else break; } };
    const num = (): number | null => {
      ws(); NUM.lastIndex = i; const r = NUM.exec(s);
      if (!r || r.index !== i) return null;
      i += r[0].length; return parseFloat(r[0]);
    };
    const flag = (): number | null => { ws(); const c = s[i]; if (c === '0' || c === '1') { i++; return c === '1' ? 1 : 0; } return null; };
    let cx = 0, cy = 0, sx = 0, sy = 0; let lcx = 0, lcy = 0; let prev = '';
    const sim = similar(m); const sc = Math.sqrt(Math.abs(det(m))); const mir = det(m) < 0;
    let cmd = '';
    while (i < n) {
      ws(); if (i >= n) break;
      const ch = s[i];
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { cmd = ch; i++; }
      else if (!cmd || cmd === 'Z' || cmd === 'z') { i++; continue; }
      const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
      if (C === 'Z') { pb.close(); cx = sx; cy = sy; prev = 'Z'; cmd = ''; continue; }
      const start = i;
      switch (C) {
        case 'M': {
          const x = num(), y = num(); if (x === null || y === null) { i = start + 1; break; }
          cx = (rel ? cx : 0) + x; cy = (rel ? cy : 0) + y; sx = cx; sy = cy; pb.move(P(cx, cy));
          cmd = rel ? 'l' : 'L'; break;
        }
        case 'L': { const x = num(), y = num(); if (x === null || y === null) { i = start + 1; break; } cx = (rel ? cx : 0) + x; cy = (rel ? cy : 0) + y; pb.line(P(cx, cy)); break; }
        case 'H': { const x = num(); if (x === null) { i = start + 1; break; } cx = (rel ? cx : 0) + x; pb.line(P(cx, cy)); break; }
        case 'V': { const y = num(); if (y === null) { i = start + 1; break; } cy = (rel ? cy : 0) + y; pb.line(P(cx, cy)); break; }
        case 'C': case 'S': {
          let x1: number, y1: number;
          if (C === 'C') { const a = num(), b = num(); if (a === null || b === null) { i = start + 1; break; } x1 = (rel ? cx : 0) + a; y1 = (rel ? cy : 0) + b; }
          else if (prev === 'C' || prev === 'S') { x1 = 2 * cx - lcx; y1 = 2 * cy - lcy; } else { x1 = cx; y1 = cy; }
          const a2 = num(), b2 = num(), a3 = num(), b3 = num(); if (a2 === null || b2 === null || a3 === null || b3 === null) { i = start + 1; break; }
          const x2 = (rel ? cx : 0) + a2, y2 = (rel ? cy : 0) + b2, x = (rel ? cx : 0) + a3, y = (rel ? cy : 0) + b3;
          pb.cubic(P(x1, y1), P(x2, y2), P(x, y)); lcx = x2; lcy = y2; cx = x; cy = y; prev = C; continue;
        }
        case 'Q': case 'T': {
          let x1: number, y1: number;
          if (C === 'Q') { const a = num(), b = num(); if (a === null || b === null) { i = start + 1; break; } x1 = (rel ? cx : 0) + a; y1 = (rel ? cy : 0) + b; }
          else if (prev === 'Q' || prev === 'T') { x1 = 2 * cx - lcx; y1 = 2 * cy - lcy; } else { x1 = cx; y1 = cy; }
          const a3 = num(), b3 = num(); if (a3 === null || b3 === null) { i = start + 1; break; }
          const x = (rel ? cx : 0) + a3, y = (rel ? cy : 0) + b3;
          pb.quad(P(x1, y1), P(x, y)); lcx = x1; lcy = y1; cx = x; cy = y; prev = C; continue;
        }
        case 'A': {
          const rx0 = num(), ry0 = num(), phi0 = num(), fa = flag(), fs = flag(), a3 = num(), b3 = num();
          if (rx0 === null || ry0 === null || phi0 === null || fa === null || fs === null || a3 === null || b3 === null) { i = start + 1; break; }
          const x = (rel ? cx : 0) + a3, y = (rel ? cy : 0) + b3;
          arcTo(cx, cy, Math.abs(rx0), Math.abs(ry0), phi0 * deg, fa, fs, x, y, m, pb, sim, sc, mir, P);
          cx = x; cy = y; break;
        }
      }
      prev = C;
    }
  };
  const arcTo = (x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number, m: Mat2, pb: PathBuilder, sim: boolean, sc: number, mir: boolean, P: (x: number, y: number) => V2) => {
    if (Math.hypot(x2 - x1, y2 - y1) < 1e-12) return;
    if (rx < 1e-12 || ry < 1e-12) { pb.line(P(x2, y2)); return; }
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    if (fa === fs) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const ccx = cp * cxp - sp * cyp + (x1 + x2) / 2, ccy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
    if (Math.abs(rx - ry) < 1e-9 * rx && sim) {
      // Kreisbogen bleibt Bogen (Drehsinn: positiver Winkel in Benutzerkoordinaten, gespiegelt durch die Seitentransformation)
      pb.arc(P(x2, y2), P(ccx, ccy), rx * sc, (dt > 0) !== mir);
      return;
    }
    const k = sc * Math.max(rx, ry);
    const nseg = Math.max(2, Math.min(720, Math.ceil(Math.abs(dt) / (2 * Math.acos(Math.max(0, 1 - tol / Math.max(k, tol)))))));
    for (let j = 1; j <= nseg; j++) {
      const t = t1 + (dt * j) / nseg; const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      pb.line(j === nseg ? P(x2, y2) : P(cp * ex - sp * ey + ccx, sp * ex + cp * ey + ccy));
    }
  };

  // ---------------------------------------------------------- Texte
  const textEl = (el: XNode, ctx: Ctx, st: Sty) => {
    interface Chunk { x: number; y: number; s: string; st: Sty }
    const chunks: Chunk[] = [];
    const first = (v: string | undefined) => len(v?.trim().split(/[\s,]+/)[0], 0);
    let px = first(el.attrs.x), py = first(el.attrs.y);
    px += nums(el.attrs.dx)[0] ?? 0; py += nums(el.attrs.dy)[0] ?? 0;
    const walk = (n: XNode, s0: Sty) => {
      for (const k of n.kids) {
        if (typeof k === 'string') {
          const t = k.replace(/[\n\r\t]/g, ' ').replace(/ {2,}/g, ' ');
          if (!t.trim()) { if (chunks.length && t) px += textWidth(' ', len(s0['font-size'], 16)); continue; }
          chunks.push({ x: px, y: py, s: t, st: s0 });
          px += textWidth(t, len(s0['font-size'], 16));
        } else if (tag(k) === 'tspan' || tag(k) === 'a') {
          const s1 = styleOf(k, s0);
          if (s1.display === 'none') continue;
          const xs = nums(k.attrs.x), ys = nums(k.attrs.y);
          if (xs.length) px = xs[0]; if (ys.length) py = ys[0];
          px += nums(k.attrs.dx)[0] ?? 0; py += nums(k.attrs.dy)[0] ?? 0;
          walk(k, s1);
        }
      }
    };
    walk(el, st);
    // Zeilen: Stücke gleicher y-Lage zusammenfassen; mehrzeilig bei gleichem x und Zeilenabstand ≈ 1,25 × Grösse
    interface Line { x: number; y: number; s: string; st: Sty }
    const lines: Line[] = [];
    for (const c of chunks) {
      const l = lines[lines.length - 1];
      if (l && Math.abs(l.y - c.y) < 1e-6 && same(l.st, c.st)) l.s += c.s; else lines.push({ ...c });
    }
    const groups: Line[][] = [];
    for (const l of lines) {
      const g = groups[groups.length - 1]; const q = g?.[g.length - 1];
      const fs = len(l.st['font-size'], 16);
      if (q && same(q.st, l.st) && Math.abs(q.x - l.x) < fs * 0.05 && Math.abs(l.y - q.y - fs * 1.25) < fs * 0.15) g.push(l); else groups.push([l]);
    }
    for (const g of groups) {
      const s0 = g[0].st; const fs = len(s0['font-size'], 16);
      const fill = fillOf(s0); const color = fill?.pattern === 'solid' ? fill.color : '#000000';
      const anchor = s0['text-anchor'] ?? 'start';
      const ha: HAl = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
      const b = s0['dominant-baseline'] ?? s0['alignment-baseline'] ?? '';
      const va: VAl = /hanging|text-before-edge|before-edge|text-top/.test(b) ? 'top' : /central|middle/.test(b) ? 'middle' : /text-after-edge|after-edge|ideographic|text-bottom/.test(b) ? 'bottom' : 'baseline';
      const nl = g.length; const lh = fs * 1.25;
      const ay = g[0].y + (va === 'middle' ? ((nl - 1) * lh) / 2 : va === 'bottom' ? (nl - 1) * lh : 0);
      const m = ctx.m; const p = apply(m, { x: g[0].x, y: ay });
      const ux = { x: m.a, y: m.b }; const vy = { x: m.c, y: m.d };
      const size = fs * Math.hypot(vy.x, vy.y);
      const w = s0['font-weight'] ?? ''; const bold = /bold|bolder/.test(w) || parseInt(w, 10) >= 600;
      const t: VText = { p, s: g.map((l) => l.s.trim()).join('\n'), size, rot: Math.atan2(ux.y, ux.x), color, ha, va, font: fontOf(s0['font-family']), clip: ctx.clip, layer: ctx.layer };
      if (bold) t.bold = true; if (/italic|oblique/.test(s0['font-style'] ?? '')) t.italic = true;
      if (t.s.trim()) d.texts.push(t);
    }
  };
  const same = (a: Sty, b: Sty) => a === b || (a['font-size'] === b['font-size'] && a.fill === b.fill && a['font-weight'] === b['font-weight'] && a['text-anchor'] === b['text-anchor']);

  // ---------------------------------------------------------- Baum durchlaufen
  const NOREND = new Set(['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'linearGradient', 'radialGradient', 'style', 'title', 'desc', 'metadata', 'script', 'filter', 'foreignObject', 'font', 'font-face', 'namedview']);
  const visit = (el: XNode, ctx: Ctx, viaUse = false) => {
    const t = tag(el);
    if (NOREND.has(t) && !(viaUse && t === 'symbol')) return;
    const st = styleOf(el, ctx.st);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity ?? '1') <= 0.001) return;
    let m = compose(ctx.m, parseTransform(el.attrs.transform));
    let layer = ctx.layer;
    if (t === 'g' && (el.attrs['inkscape:groupmode'] === 'layer' || ctx.depth === 0)) { const nm = el.attrs['inkscape:label'] ?? el.attrs.id; if (nm) { layer = nm; layers.add(nm); } }
    const sub: Ctx = { m, st, clip: ctx.clip, clipPolys: ctx.clipPolys, layer, depth: ctx.depth + 1 };
    clipOf(el, st, sub);
    if (ctx.depth > 40) return;
    switch (t) {
      case 'g': case 'a': case 'switch': case 'symbol':
        for (const k of el.kids) if (typeof k !== 'string') visit(k, sub);
        return;
      case 'svg': {
        if (el !== svg) {
          m = compose(m, { a: 1, b: 0, c: 0, d: 1, e: len(el.attrs.x), f: len(el.attrs.y) });
          const v = nums(el.attrs.viewBox); const w = len(el.attrs.width), h = len(el.attrs.height);
          if (v.length === 4 && w > 0 && h > 0) { const k = Math.min(w / v[2], h / v[3]); m = compose(m, { a: k, b: 0, c: 0, d: k, e: -k * v[0], f: -k * v[1] }); }
          sub.m = m;
        }
        for (const k of el.kids) if (typeof k !== 'string') visit(k, sub);
        return;
      }
      case 'use': {
        const href = el.attrs.href ?? el.attrs['xlink:href'];
        const ref = href ? ids.get(href.replace(/^#/, '')) : undefined;
        if (!ref || ctx.depth > 30) { skip(d, 'use ohne Ziel'); return; }
        sub.m = compose(m, { a: 1, b: 0, c: 0, d: 1, e: len(el.attrs.x), f: len(el.attrs.y) });
        visit(ref, sub, true);
        return;
      }
      case 'text': textEl(el, sub, st); return;
      case 'image': skip(d, 'Bild'); return;
    }
    const pb = new PathBuilder(tol);
    if (!shape(el, m, pb, st)) { if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(t)) skip(d, '<' + t + '>'); return; }
    const subs = pb.take(); if (!subs.length) return;
    const p: VPath = { subs, clip: sub.clip, clipPolys: sub.clipPolys, layer };
    if (t !== 'line' && t !== 'polyline' || st.fill !== undefined) { const f = t === 'line' ? undefined : fillOf(st); if (f) p.fill = f; }
    const s = strokeOf(st, m); if (s) p.stroke = s;
    if (p.fill || p.stroke) d.paths.push(p);
  };
  const base: Ctx = { m: root, st: styleOf(svg, {}), clip: null, depth: 0 };
  for (const k of svg.kids) if (typeof k !== 'string') visit(k, base);
  d.layers = [...layers];
  return d;
}
const tag = (n: XNode) => { const i = n.name.indexOf(':'); return i >= 0 && n.name.slice(0, i) !== 'sodipodi' ? n.name.slice(i + 1) : n.name.replace(/^sodipodi:/, ''); };
