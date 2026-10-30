// IFC-Export – STEP-Grundlagen (ISO 10303-21) und Schreibkontext: Zeichenketten/Zahlen, stabile GUIDs,
// Koordinatensysteme (Frame), Punkte/Richtungen/Platzierungen, Profile und Körper (Extrusion, Brep),
// Darstellungsstile, Materialien und Eigenschaftssätze. Ohne DOM, ohne App-Zustand.
import type { Doc, Id } from '../../core/doc';
import type { V2, V3 } from '../../core/geom';
import { cross3, dot3, sub3, signedArea } from '../../core/geom';
import type { Face } from '../../core/registry';
import type { Material } from '../../core/view';
import { faceNormal } from '../../views/sectionEngine';
import { cleanRing } from './meshes';

// ------------------------------------------------------------ Zeichenketten, Zahlen, GUIDs
/** Zeichenkette für STEP: Apostroph/Backslash maskieren, Nicht-ASCII als \X2\…\X0\ */
export function stepString(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c <= 126) { out += c === 39 ? "''" : c === 92 ? '\\\\' : s[i]; i++; continue; }
    let hex = '';
    while (i < s.length) {
      const d = s.charCodeAt(i);
      if (d >= 32 && d <= 126) break;
      hex += d.toString(16).toUpperCase().padStart(4, '0');
      i++;
    }
    out += '\\X2\\' + hex + '\\X0\\';
  }
  return out;
}
/** REAL mit Dezimalpunkt */
export function stepReal(v: number, dec = 3): string {
  if (!isFinite(v)) v = 0;
  const f = Math.pow(10, dec);
  let r = Math.round(v * f) / f;
  if (Object.is(r, -0)) r = 0;
  if (Math.abs(r) >= 1e15) return r.toExponential(8).toUpperCase().replace('E+', 'E');
  const s = String(r);
  if (s.includes('e')) { const [m, e] = s.split('e'); return (m.includes('.') ? m : m + '.') + 'E' + e.replace('+', ''); }
  return s.includes('.') ? s : s + '.';
}
export const R = stepReal;
/** optionale Zeichenkette ($ wenn leer) */
export const S = (s: string | null | undefined): string => (s === null || s === undefined || s === '' ? '$' : `'${stepString(String(s))}'`);
/** Zeichenkette (leer erlaubt) */
export const SS = (s: string | null | undefined): string => `'${stepString(String(s ?? ''))}'`;
export const ref = (n: number) => '#' + n;
export const refs = (ns: number[]) => '(' + ns.map(ref).join(',') + ')';
/** Aufzählungswert (.WERT.) aus beliebigem Text */
export const E = (v: string) => '.' + v.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '.';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** 128 Bit → komprimierte IFC-GUID (22 Zeichen) */
export function compressGuid(b: Uint8Array): string {
  const enc = (n: number, digits: number) => { let s = ''; for (let i = 0; i < digits; i++) { s = B64[n % 64] + s; n = Math.floor(n / 64); } return s; };
  let s = enc(b[0], 2);
  for (let i = 1; i < 16; i += 3) s += enc((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 4);
  return s;
}
/** Deterministischer 128-Bit-Hash (cyrb128) → stabile GUIDs bei wiederholtem Export */
export function hash128(str: string): Uint8Array {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  const out = new Uint8Array(16);
  [h1, h2, h3, h4].forEach((h, i) => { const u = h >>> 0; out[i * 4] = u >>> 24; out[i * 4 + 1] = (u >>> 16) & 255; out[i * 4 + 2] = (u >>> 8) & 255; out[i * 4 + 3] = u & 255; });
  out[6] = (out[6] & 0x0f) | 0x40; out[8] = (out[8] & 0x3f) | 0x80; // UUID v4-Kennung
  return out;
}

// ------------------------------------------------------------ Koordinatensysteme
/** Lokales Koordinatensystem in Weltkoordinaten: Ursprung o, Einheitsachsen x und z (y = z × x) */
export interface Frame { o: V3; x: V3; z: V3 }
export const X3: V3 = { x: 1, y: 0, z: 0 };
export const Y3: V3 = { x: 0, y: 1, z: 0 };
export const Z3: V3 = { x: 0, y: 0, z: 1 };
export const worldFrame = (o: V3): Frame => ({ o, x: X3, z: Z3 });
export const yAxis = (f: Frame): V3 => cross3(f.z, f.x);
/** Richtung (Welt) → lokal */
export function vecIn(f: Frame, v: V3): V3 { const y = yAxis(f); return { x: dot3(v, f.x), y: dot3(v, y), z: dot3(v, f.z) }; }
/** Punkt (Welt) → lokal */
export const ptIn = (f: Frame, p: V3): V3 => vecIn(f, sub3(p, f.o));
const isAxis = (v: V3, a: V3) => Math.abs(v.x - a.x) + Math.abs(v.y - a.y) + Math.abs(v.z - a.z) < 1e-9;

// ------------------------------------------------------------ Eigenschaften
export type PropKind = 'label' | 'text' | 'id' | 'bool' | 'real' | 'int' | 'count' | 'len' | 'plen' | 'mass' | 'area';
/** Eigenschaftswert: einfacher Wert oder Wert mit Messart (z.B. { v: 30, k: 'plen' }) */
export type PropVal = string | number | boolean | { v: string | number | boolean; k: PropKind } | null | undefined;

// ------------------------------------------------------------ Schreibkontext
export class IfcOut {
  readonly lines: string[] = [];
  private n = 0;
  private used = new Set<string>();
  OH = '$';
  /** Darstellungskontexte: Körper und Achse */
  body = 0;
  axis = 0;
  private dirs = new Map<string, number>();
  private pts2 = new Map<string, number>();
  private styles = new Map<string, number>();
  private mats = new Map<Id, number>();
  origin = 0;
  identOp = 0;

  constructor(readonly doc: Doc, private seed: string) {}

  add(s: string): number { this.lines.push(`#${++this.n}=${s};`); return this.n; }
  private memo = new Map<string, number>();
  /** einmal je Schlüssel erzeugen (Wiederverwendung gemeinsamer Elemente) */
  once(key: string, fn: () => number): number { let v = this.memo.get(key); if (v === undefined) { v = fn(); this.memo.set(key, v); } return v; }

  guid(key: string): string {
    let g = compressGuid(hash128(this.seed + '#' + key)); let i = 1;
    while (this.used.has(g)) g = compressGuid(hash128(this.seed + '#' + key + '#' + i++));
    this.used.add(g);
    return `'${g}'`;
  }

  // ---------------------------------------------------------- Geometrie-Grundelemente
  pt3(p: V3): number { return this.add(`IFCCARTESIANPOINT((${R(p.x)},${R(p.y)},${R(p.z)}))`); }
  /** 2D-Punkt (wiederverwendet, z.B. Profilpunkte) */
  pt2(p: V2): number {
    const k = R(p.x) + ',' + R(p.y);
    let id = this.pts2.get(k);
    if (!id) { id = this.add(`IFCCARTESIANPOINT((${k}))`); this.pts2.set(k, id); }
    return id;
  }
  dir3(v: V3): number {
    const k = R(v.x, 9) + ',' + R(v.y, 9) + ',' + R(v.z, 9);
    let id = this.dirs.get(k);
    if (!id) { id = this.add(`IFCDIRECTION((${k}))`); this.dirs.set(k, id); }
    return id;
  }
  dir2(v: V2): number {
    const k = R(v.x, 9) + ',' + R(v.y, 9);
    let id = this.dirs.get(k);
    if (!id) { id = this.add(`IFCDIRECTION((${k}))`); this.dirs.set(k, id); }
    return id;
  }
  /** Achsensystem: Achse z und Referenzrichtung x nur, wenn nicht Standard (beide oder keine) */
  a2p3(o: V3, z: V3 = Z3, x: V3 = X3): number {
    const loc = Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z) < 1e-9 && this.origin ? this.origin : this.pt3(o);
    const std = isAxis(z, Z3) && isAxis(x, X3);
    return this.add(`IFCAXIS2PLACEMENT3D(${ref(loc)},${std ? '$,$' : ref(this.dir3(z)) + ',' + ref(this.dir3(x))})`);
  }
  /** Objektplatzierung des Systems f relativ zur Platzierung rel (mit deren System relF) */
  placement(rel: number | null, relF: Frame | null, f: Frame): number {
    const o = relF ? ptIn(relF, f.o) : f.o;
    const z = relF ? vecIn(relF, f.z) : f.z, x = relF ? vecIn(relF, f.x) : f.x;
    return this.add(`IFCLOCALPLACEMENT(${rel ? ref(rel) : '$'},${ref(this.a2p3(o, z, x))})`);
  }

  // ---------------------------------------------------------- Profile und Körper
  /** geschlossene 2D-Polylinie (Ring ohne Schlusspunkt; Schlusspunkt wird angefügt) */
  ring2(r: V2[]): number {
    const ids: number[] = [];
    for (const p of r) { const id = this.pt2(p); if (ids[ids.length - 1] !== id) ids.push(id); }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    ids.push(ids[0]);
    return this.add(`IFCPOLYLINE(${refs(ids)})`);
  }
  /** Fläche mit optionalen Aussparungen (Außenring gegen, Löcher im Uhrzeigersinn) */
  profile(outer: V2[], holes: V2[][] = [], name?: string): number {
    const o = signedArea(outer) < 0 ? outer.slice().reverse() : outer;
    const hs = holes.filter((h) => h.length >= 3).map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h));
    if (!hs.length) return this.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${S(name)},${ref(this.ring2(o))})`);
    return this.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,${S(name)},${ref(this.ring2(o))},${refs(hs.map((h) => this.ring2(h)))})`);
  }
  /** Extrusion eines Profils (Lage pos oder Standard) um depth in Richtung dir */
  extrusion(profile: number, pos: number | null, depth: number, dir: V3 = Z3): number {
    return this.add(`IFCEXTRUDEDAREASOLID(${ref(profile)},${pos ? ref(pos) : '$'},${ref(this.dir3(dir))},${R(Math.max(depth, 0.001))})`);
  }
  shapeRep(ctx: number, ident: string, type: string, items: number[]): number {
    return this.add(`IFCSHAPEREPRESENTATION(${ref(ctx)},'${ident}','${type}',${refs(items)})`);
  }
  pds(reps: number[]): number { return this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,${refs(reps)})`); }

  /** Facettierter Körper aus ebenen Flächen; loc: Welt → lokale Koordinaten */
  brep(faces: Face[], loc: (p: V3) => V3): number | null {
    const pts = new Map<string, number>();
    const pt = (p: V3): number => {
      const q = loc(p);
      const k = R(q.x) + ',' + R(q.y) + ',' + R(q.z);
      let id = pts.get(k);
      if (!id) { id = this.add(`IFCCARTESIANPOINT((${k}))`); pts.set(k, id); }
      return id;
    };
    const loop = (r: V3[]): number | null => {
      const ids: number[] = [];
      for (const p of r) { const id = pt(p); if (ids[ids.length - 1] !== id) ids.push(id); }
      while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
      if (new Set(ids).size < 3) return null;
      return this.add(`IFCPOLYLOOP(${refs(ids)})`);
    };
    const out: number[] = [];
    for (const f of faces) {
      const outer = cleanRing(f.pts);
      if (outer.length < 3) continue;
      const n = faceNormal(outer);
      if (Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) < 0.5) continue;
      const ol = loop(outer);
      if (!ol) continue;
      const bounds = [this.add(`IFCFACEOUTERBOUND(${ref(ol)},.T.)`)];
      for (const h0 of f.holes ?? []) {
        let h = cleanRing(h0);
        if (h.length < 3) continue;
        const hn = faceNormal(h);
        if (hn.x * n.x + hn.y * n.y + hn.z * n.z > 0) h = h.slice().reverse(); // Lochring gegenläufig
        const hl = loop(h);
        if (hl) bounds.push(this.add(`IFCFACEBOUND(${ref(hl)},.T.)`));
      }
      out.push(this.add(`IFCFACE(${refs(bounds)})`));
    }
    if (!out.length) return null;
    return this.add(`IFCFACETEDBREP(${ref(this.add(`IFCCLOSEDSHELL(${refs(out)})`))})`);
  }

  // ---------------------------------------------------------- Darstellung
  style(color: string, opacity: number, name: string): number {
    const key = color + '|' + opacity;
    let s = this.styles.get(key);
    if (s) return s;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color) ?? ['', 'cc', 'cc', 'cc'];
    const ch = (h: string) => R(parseInt(h, 16) / 255, 4);
    const col = this.add(`IFCCOLOURRGB($,${ch(m[1])},${ch(m[2])},${ch(m[3])})`);
    const rend = this.add(`IFCSURFACESTYLERENDERING(${ref(col)},${R(1 - opacity, 3)},$,$,$,$,$,$,.NOTDEFINED.)`);
    s = this.add(`IFCSURFACESTYLE(${SS(name)},.BOTH.,(${ref(rend)}))`);
    this.styles.set(key, s);
    return s;
  }
  styled(item: number, color: string, opacity: number, name: string): void {
    this.add(`IFCSTYLEDITEM(${ref(item)},(${ref(this.style(color, opacity, name))}),$)`);
  }

  // ---------------------------------------------------------- Materialien
  material(id: Id | undefined): number | null {
    if (!id) return null;
    const m = this.doc.get<Material>(id);
    if (!m || m.cat !== 'material') return null;
    let e = this.mats.get(id);
    if (!e) {
      const cat = /betonstahl|bewehrung|rebar|reinforc/i.test(m.name) ? 'Steel'
        : /beton|stb|concrete/i.test(m.name) || m.cutPattern === 'rc' || m.cutPattern === 'concrete' ? 'Concrete'
        : /stahl|steel/i.test(m.name) ? 'Steel' : /holz|wood|timber/i.test(m.name) ? 'Wood'
          : /dämm|xps|eps|pur|wolle|insul/i.test(m.name) ? 'Insulation' : /mauer|ziegel|kalksand|backstein|masonry/i.test(m.name) ? 'Masonry' : '';
      e = this.add(`IFCMATERIAL(${SS(m.name)},${S(m.description)},${S(cat)})`);
      this.mats.set(id, e);
    }
    return e;
  }

  // ---------------------------------------------------------- Eigenschaften
  prop(name: string, v: PropVal): number | null {
    if (v === null || v === undefined || v === '') return null;
    let k: PropKind; let x: string | number | boolean;
    if (typeof v === 'object') { k = v.k; x = v.v; } else { x = v; k = typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'real' : 'label'; }
    if (x === '' || (typeof x === 'number' && !isFinite(x))) return null;
    let val: string;
    switch (k) {
      case 'bool': val = `IFCBOOLEAN(${x ? '.T.' : '.F.'})`; break;
      case 'real': val = `IFCREAL(${R(+x, 6)})`; break;
      case 'int': val = `IFCINTEGER(${Math.round(+x)})`; break;
      case 'count': val = `IFCCOUNTMEASURE(${Math.round(+x)})`; break;
      case 'len': val = `IFCLENGTHMEASURE(${R(+x, 3)})`; break;
      case 'plen': if (!(+x > 0)) return null; val = `IFCPOSITIVELENGTHMEASURE(${R(+x, 3)})`; break;
      case 'mass': val = `IFCMASSMEASURE(${R(+x, 3)})`; break;
      case 'area': val = `IFCAREAMEASURE(${R(+x, 6)})`; break;
      case 'text': val = `IFCTEXT(${SS(String(x))})`; break;
      case 'id': val = `IFCIDENTIFIER(${SS(String(x))})`; break;
      default: val = `IFCLABEL(${SS(String(x))})`;
    }
    return this.add(`IFCPROPERTYSINGLEVALUE(${SS(name)},$,${val},$)`);
  }
  /** Eigenschaftssatz aus Datensatz für ein oder mehrere Objekte (leere Werte entfallen) */
  pset(key: string, name: string, rec: Record<string, PropVal>, objs: number[]): number | null {
    if (!objs.length) return null;
    const ps: number[] = [];
    for (const [k, v] of Object.entries(rec)) { const p = this.prop(k, v); if (p) ps.push(p); }
    if (!ps.length) return null;
    const set = this.add(`IFCPROPERTYSET(${this.guid('pset:' + name + ':' + key)},${this.OH},${SS(name)},$,${refs(ps)})`);
    this.add(`IFCRELDEFINESBYPROPERTIES(${this.guid('relpset:' + name + ':' + key)},${this.OH},$,$,${refs(objs)},${ref(set)})`);
    return set;
  }

  text(): string[] { return this.lines; }
}
