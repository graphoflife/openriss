// IFC4-Export (STEP-Datei nach ISO 10303-21): Projekt (mm), Grundstück, Gebäude, ein Geschoss je
// Ebene, Bauteile nach Kategorie (IfcWall, IfcSlab, IfcDoor …) mit Geometrie als IfcFacetedBrep
// aus den Solids, Farben (IfcStyledItem), Materialzuordnung und Eigenschaftensatz „Pset_OpenRiss“.
import type { Doc, El, Id } from '../../core/doc';
import { allCats, catDef } from '../../core/registry';
import type { Solid } from '../../core/registry';
import { levels, projectInfo, Level, Material, TypeEl } from '../../core/view';
import type { V3 } from '../../core/geom';
import { solidsOf, faceNormal } from '../../views/sectionEngine';
import { cleanRing, solidLook, catFamily } from './meshes';

// ------------------------------------------------------------ STEP-Grundlagen
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
const S = (s: string | null | undefined): string => (s === null || s === undefined || s === '' ? '$' : `'${stepString(String(s))}'`);
const SS = (s: string | null | undefined): string => `'${stepString(String(s ?? ''))}'`;
/** REAL mit Dezimalpunkt */
export function stepReal(v: number, dec = 3): string {
  if (!isFinite(v)) v = 0;
  const f = Math.pow(10, dec);
  let r = Math.round(v * f) / f;
  if (Object.is(r, -0)) r = 0;
  if (Math.abs(r) >= 1e15) return r.toExponential(8).toUpperCase().replace('E+', 'E');
  const s = String(r);
  return s.includes('.') || s.includes('e') ? s.toUpperCase() : s + '.';
}
const R = stepReal;
const ref = (n: number) => '#' + n;
const refs = (ns: number[]) => '(' + ns.map(ref).join(',') + ')';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** 128 Bit → komprimierte IFC-GUID (22 Zeichen) */
export function compressGuid(b: Uint8Array): string {
  const enc = (n: number, digits: number) => { let s = ''; for (let i = 0; i < digits; i++) { s = B64[n % 64] + s; n = Math.floor(n / 64); } return s; };
  let s = enc(b[0], 2);
  for (let i = 1; i < 16; i += 3) s += enc((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 4);
  return s;
}
/** Deterministischer 128-Bit-Hash (cyrb128) → stabile GUIDs bei wiederholtem Export */
function hash128(str: string): Uint8Array {
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

class StepWriter {
  lines: string[] = [];
  private n = 0;
  add(s: string): number { this.lines.push(`#${++this.n}=${s};`); return this.n; }
}

// ------------------------------------------------------------ Zuordnung Kategorie → IFC-Klasse
interface IfcClass { ent: string; tail: string; pset?: string }

const SKIP_CATS = new Set(['view', 'type', 'material', 'project', 'level', 'grid', 'refplane', 'line', 'opening', 'shaft', 'area']);
const REBAR_CATS = new Set(['rebar', 'stirrup', 'arearebar', 'pathrebar', 'rebarset']);

function num(v: any): number | null { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; }

function ifcClass(doc: Doc, el: El): IfcClass {
  const c = el.cat;
  const t = doc.get<TypeEl>(el.typeId) as any;
  const fam = catFamily(c);
  if (c === 'wall') return { ent: 'IFCWALL', tail: '.NOTDEFINED.', pset: 'Pset_WallCommon' };
  if (c === 'door' || c === 'window') {
    const h = num(el.height ?? t?.height), w = num(el.width ?? t?.width);
    const dims = `${h ? R(h) : '$'},${w ? R(w) : '$'}`;
    return c === 'door'
      ? { ent: 'IFCDOOR', tail: `${dims},.DOOR.,.NOTDEFINED.,$`, pset: 'Pset_DoorCommon' }
      : { ent: 'IFCWINDOW', tail: `${dims},.WINDOW.,.NOTDEFINED.,$`, pset: 'Pset_WindowCommon' };
  }
  if (fam === 'floor') return { ent: 'IFCSLAB', tail: '.FLOOR.', pset: 'Pset_SlabCommon' };
  if (fam === 'roof') return { ent: 'IFCROOF', tail: '.NOTDEFINED.', pset: 'Pset_RoofCommon' };
  if (c === 'ceiling') return { ent: 'IFCCOVERING', tail: '.CEILING.', pset: 'Pset_CoveringCommon' };
  if (fam === 'column') return { ent: 'IFCCOLUMN', tail: '.COLUMN.', pset: 'Pset_ColumnCommon' };
  if (fam === 'beam') return { ent: 'IFCBEAM', tail: '.BEAM.', pset: 'Pset_BeamCommon' };
  if (fam === 'stair') return { ent: 'IFCSTAIR', tail: '.NOTDEFINED.', pset: 'Pset_StairCommon' };
  if (fam === 'railing') return { ent: 'IFCRAILING', tail: '.NOTDEFINED.', pset: 'Pset_RailingCommon' };
  if (c.startsWith('ramp')) return { ent: 'IFCRAMP', tail: '.NOTDEFINED.', pset: 'Pset_RampCommon' };
  if (c.startsWith('curtain')) return { ent: 'IFCCURTAINWALL', tail: '.NOTDEFINED.', pset: 'Pset_CurtainWallCommon' };
  if (c.startsWith('topo')) return { ent: 'IFCGEOGRAPHICELEMENT', tail: '.TERRAIN.' };
  if (c === 'furniture') return { ent: 'IFCFURNITURE', tail: '.NOTDEFINED.' };
  if (fam === 'foundation') {
    const k = (c + ' ' + (el.kind ?? '') + ' ' + (t?.kind ?? '')).toLowerCase();
    const pt = /strip|streifen|wall/.test(k) ? '.STRIP_FOOTING.' : /isol|pad|einzel|single/.test(k) ? '.PAD_FOOTING.' : '.NOTDEFINED.';
    return { ent: 'IFCFOOTING', tail: pt, pset: 'Pset_FootingCommon' };
  }
  if (fam === 'rebar' || REBAR_CATS.has(c)) {
    const d = num(el.diameter ?? el.dia ?? t?.diameter ?? t?.dia);
    return { ent: 'IFCREINFORCINGBAR', tail: `$,${d ? R(d) : '$'},$,$,.NOTDEFINED.,$` };
  }
  return { ent: 'IFCBUILDINGELEMENTPROXY', tail: '.NOTDEFINED.', pset: 'Pset_BuildingElementProxyCommon' };
}

/** Elemente, die exportiert werden (Modellelemente mit Geometrie; Räume immer) */
export function ifcElements(doc: Doc): El[] {
  const out: El[] = [];
  for (const def of allCats()) {
    if (def.annotation || def.datum || SKIP_CATS.has(def.cat)) continue;
    for (const el of doc.all(def.cat)) if (!el.viewId) out.push(el);
  }
  return out;
}

// ------------------------------------------------------------ Export
export interface IfcResult { text: string; count: number }

export function exportIfc(doc: Doc, fileName = 'Projekt.ifc', now = new Date()): IfcResult {
  const w = new StepWriter();
  const pi = projectInfo(doc) ?? ({ name: 'Projekt', number: '', author: '', client: '', address: '', status: '' } as any);
  // Projektschlüssel für stabile GUIDs
  const seed = [pi.name, pi.number, pi.date, ...doc.all('view').map((v) => v.id).sort().slice(0, 3)].join('|');
  const used = new Set<string>();
  const guid = (key: string): string => {
    let g = compressGuid(hash128(seed + '#' + key)); let i = 1;
    while (used.has(g)) g = compressGuid(hash128(seed + '#' + key + '#' + i++));
    used.add(g);
    return `'${g}'`;
  };

  // Eigentümer / Anwendung
  const author = pi.author || 'OpenRiss';
  const person = w.add(`IFCPERSON($,${S(author)},$,$,$,$,$,$)`);
  const devOrg = w.add(`IFCORGANIZATION($,'OpenRiss',$,$,$)`);
  const pao = w.add(`IFCPERSONANDORGANIZATION(${ref(person)},${ref(devOrg)},$)`);
  const appl = w.add(`IFCAPPLICATION(${ref(devOrg)},'0.1','OpenRiss','OpenRiss')`);
  const ts = Math.floor(now.getTime() / 1000);
  const oh = w.add(`IFCOWNERHISTORY(${ref(pao)},${ref(appl)},$,.ADDED.,${ts},${ref(pao)},${ref(appl)},${ts})`);
  const OH = ref(oh);

  // Einheiten
  const uLen = w.add(`IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`);
  const uArea = w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const uVol = w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const uAng = w.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`);
  const units = w.add(`IFCUNITASSIGNMENT(${refs([uLen, uArea, uVol, uAng])})`);

  // Geometrischer Kontext
  const origin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const axisZ = w.add(`IFCDIRECTION((0.,0.,1.))`);
  const axisX = w.add(`IFCDIRECTION((1.,0.,0.))`);
  const wcs = w.add(`IFCAXIS2PLACEMENT3D(${ref(origin)},${ref(axisZ)},${ref(axisX)})`);
  const north = w.add(`IFCDIRECTION((0.,1.))`);
  const ctx = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ref(wcs)},${ref(north)})`);
  const body = w.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ref(ctx)},$,.MODEL_VIEW.,$)`);
  const ident = w.add(`IFCAXIS2PLACEMENT3D(${ref(origin)},$,$)`);

  // Räumliche Struktur
  const project = w.add(`IFCPROJECT(${guid('project')},${OH},${S(pi.number || pi.name)},${S(pi.address)},$,${S(pi.name)},${S(pi.status)},(${ref(ctx)}),${ref(units)})`);
  const sitePl = w.add(`IFCLOCALPLACEMENT($,${ref(ident)})`);
  const site = w.add(`IFCSITE(${guid('site')},${OH},${SS('Grundstück')},$,$,${ref(sitePl)},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = w.add(`IFCLOCALPLACEMENT(${ref(sitePl)},${ref(ident)})`);
  const bld = w.add(`IFCBUILDING(${guid('building')},${OH},${SS(pi.name || 'Gebäude')},$,$,${ref(bldPl)},$,$,.ELEMENT.,$,$,$)`);
  w.add(`IFCRELAGGREGATES(${guid('agg-project')},${OH},$,$,${ref(project)},(${ref(site)}))`);
  w.add(`IFCRELAGGREGATES(${guid('agg-site')},${OH},$,$,${ref(site)},(${ref(bld)}))`);

  // Geschosse
  const allLv = levels(doc);
  let stLv: { id: Id; name: string; elev: number }[] = allLv.filter((l) => l.story !== false);
  if (!stLv.length) stLv = allLv;
  if (!stLv.length) stLv = [{ id: '_ebene0', name: 'Ebene 0', elev: 0 }];
  const storeys = stLv.map((l) => {
    const pt = w.add(`IFCCARTESIANPOINT((0.,0.,${R(l.elev)}))`);
    const ax = w.add(`IFCAXIS2PLACEMENT3D(${ref(pt)},$,$)`);
    const pl = w.add(`IFCLOCALPLACEMENT(${ref(bldPl)},${ref(ax)})`);
    const id = w.add(`IFCBUILDINGSTOREY(${guid('storey:' + l.id)},${OH},${SS(l.name)},$,$,${ref(pl)},$,$,.ELEMENT.,${R(l.elev)})`);
    return { lv: l, id, pl, elems: [] as number[], spaces: [] as number[] };
  });
  w.add(`IFCRELAGGREGATES(${guid('agg-building')},${OH},$,$,${ref(bld)},${refs(storeys.map((s) => s.id))})`);

  const storeyAt = (z: number) => { let best = storeys[0]; for (const s of storeys) if (s.lv.elev <= z + 1) best = s; return best; };
  const storeyFor = (el: El, minZ: number) => {
    let lid: Id | undefined = el.levelId;
    if (!lid && el.hostId) lid = doc.get(el.hostId)?.levelId;
    const direct = storeys.find((s) => s.lv.id === lid);
    if (direct) return direct;
    const lvl = doc.get<Level>(lid);
    if (lvl && lvl.cat === 'level') return storeyAt(lvl.elev);
    return storeyAt(isFinite(minZ) ? minZ : 0);
  };

  // Farben (Oberflächenstile)
  const styles = new Map<string, number>();
  const styleFor = (color: string, opacity: number, name: string): number => {
    const key = color + '|' + opacity;
    let s = styles.get(key);
    if (s) return s;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color) ?? ['', 'cc', 'cc', 'cc'];
    const ch = (h: string) => R(parseInt(h, 16) / 255, 4);
    const col = w.add(`IFCCOLOURRGB($,${ch(m[1])},${ch(m[2])},${ch(m[3])})`);
    const rend = w.add(`IFCSURFACESTYLERENDERING(${ref(col)},${R(1 - opacity, 3)},$,$,$,$,$,$,.NOTDEFINED.)`);
    s = w.add(`IFCSURFACESTYLE(${SS(name)},.BOTH.,(${ref(rend)}))`);
    styles.set(key, s);
    return s;
  };

  // Materialien
  const matEnt = new Map<Id, number>();
  const materialOf = (id: Id): number | null => {
    const m = doc.get<Material>(id);
    if (!m || m.cat !== 'material') return null;
    let e = matEnt.get(id);
    if (!e) { e = w.add(`IFCMATERIAL(${SS(m.name)},${S(m.description)},$)`); matEnt.set(id, e); }
    return e;
  };
  const matAssoc = new Map<string, { def: number; objs: number[] }>();

  // Eigenschaften
  const prop = (name: string, v: string | number | boolean, kind: 'label' | 'text' | 'id' = 'label') => {
    let val: string;
    if (typeof v === 'boolean') val = `IFCBOOLEAN(${v ? '.T.' : '.F.'})`;
    else if (typeof v === 'number') val = `IFCREAL(${R(v, 6)})`;
    else val = kind === 'text' ? `IFCTEXT(${SS(v)})` : kind === 'id' ? `IFCIDENTIFIER(${SS(v)})` : `IFCLABEL(${SS(v)})`;
    return w.add(`IFCPROPERTYSINGLEVALUE(${SS(name)},$,${val},$)`);
  };
  const pset = (key: string, name: string, props: number[], obj: number) => {
    if (!props.length) return;
    const ps = w.add(`IFCPROPERTYSET(${guid('pset:' + name + ':' + key)},${OH},${SS(name)},$,${refs(props)})`);
    w.add(`IFCRELDEFINESBYPROPERTIES(${guid('relpset:' + name + ':' + key)},${OH},$,$,(${ref(obj)}),${ref(ps)})`);
  };

  // Geometrie
  const writeBreps = (solids: Solid[], el: El, elev: number): number[] => {
    const pts = new Map<string, number>();
    const pt = (p: V3): number => {
      const x = R(p.x), y = R(p.y), z = R(p.z - elev);
      const k = x + ',' + y + ',' + z;
      let id = pts.get(k);
      if (!id) { id = w.add(`IFCCARTESIANPOINT((${x},${y},${z}))`); pts.set(k, id); }
      return id;
    };
    const loop = (r: V3[]): number | null => {
      const ids: number[] = [];
      for (const p of r) { const id = pt(p); if (ids[ids.length - 1] !== id) ids.push(id); }
      while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
      if (new Set(ids).size < 3) return null;
      return w.add(`IFCPOLYLOOP(${refs(ids)})`);
    };
    const items: number[] = [];
    for (const s of solids) {
      const faces: number[] = [];
      for (const f of s.faces) {
        const outer = cleanRing(f.pts);
        if (outer.length < 3) continue;
        const n = faceNormal(outer);
        if (Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) < 0.5) continue;
        const ol = loop(outer);
        if (!ol) continue;
        const bounds = [w.add(`IFCFACEOUTERBOUND(${ref(ol)},.T.)`)];
        for (const h0 of f.holes ?? []) {
          let h = cleanRing(h0);
          if (h.length < 3) continue;
          const hn = faceNormal(h);
          if (hn.x * n.x + hn.y * n.y + hn.z * n.z > 0) h = h.slice().reverse(); // Lochring gegenläufig
          const hl = loop(h);
          if (hl) bounds.push(w.add(`IFCFACEBOUND(${ref(hl)},.T.)`));
        }
        faces.push(w.add(`IFCFACE(${refs(bounds)})`));
      }
      if (!faces.length) continue;
      const shell = w.add(`IFCCLOSEDSHELL(${refs(faces)})`);
      const brep = w.add(`IFCFACETEDBREP(${ref(shell)})`);
      const look = solidLook(doc, el, s);
      w.add(`IFCSTYLEDITEM(${ref(brep)},(${ref(styleFor(look.color, look.opacity, look.name))}),$)`);
      items.push(brep);
    }
    return items;
  };

  // Bauteile
  let count = 0;
  for (const el of ifcElements(doc)) {
    const isRoom = el.cat === 'room';
    const solids = solidsOf(doc, el);
    if (!solids.length && !isRoom) continue;
    let minZ = Infinity;
    for (const s of solids) for (const f of s.faces) for (const p of f.pts) if (p.z < minZ) minZ = p.z;
    const st = storeyFor(el, minZ);
    const items = writeBreps(solids, el, st.lv.elev);
    if (!items.length && !isRoom) continue;
    let rep = '$';
    if (items.length) {
      const sr = w.add(`IFCSHAPEREPRESENTATION(${ref(body)},'Body','Brep',${refs(items)})`);
      rep = ref(w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${ref(sr)}))`));
    }
    const pl = w.add(`IFCLOCALPLACEMENT(${ref(st.pl)},${ref(ident)})`);
    const type = doc.get<TypeEl>(el.typeId);
    const def = catDef(el.cat);
    const typeName = type?.name ?? '';
    const name = typeName || el.name || def?.label || el.cat;
    const g = guid('el:' + el.id);
    let obj: number;
    if (isRoom) {
      const nr = el.number ?? el.mark ?? '';
      obj = w.add(`IFCSPACE(${g},${OH},${SS(nr || el.name || 'Raum')},${S(el.comments)},$,${ref(pl)},${rep},${S(el.name)},.ELEMENT.,.INTERNAL.,$)`);
      st.spaces.push(obj);
    } else {
      const c = ifcClass(doc, el);
      obj = w.add(`${c.ent}(${g},${OH},${SS(name)},${S(el.comments)},${S(typeName || def?.label)},${ref(pl)},${rep},${SS(el.id)},${c.tail})`);
      st.elems.push(obj);
      if (c.pset) {
        const ps = [prop('Reference', typeName || name, 'id')];
        if (el.cat === 'wall') ps.push(prop('IsExternal', (type as any)?.function === 'exterior'));
        pset(el.id, c.pset, ps, obj);
      }
    }
    count++;
    // Materialien
    const mats = [...new Set(solids.map((s) => s.mat).filter((m): m is Id => !!m && !!materialOf(m)))];
    if (mats.length) {
      const key = mats.join('+');
      let a = matAssoc.get(key);
      if (!a) {
        let def: number;
        if (mats.length === 1) def = materialOf(mats[0])!;
        else {
          const cons = mats.map((m) => w.add(`IFCMATERIALCONSTITUENT($,$,${ref(materialOf(m)!)},$,$)`));
          def = w.add(`IFCMATERIALCONSTITUENTSET(${SS(typeName || mats.map((m) => doc.get<Material>(m)?.name ?? m).join(' / '))},$,${refs(cons)})`);
        }
        a = { def, objs: [] };
        matAssoc.set(key, a);
      }
      a.objs.push(obj);
    }
    // Pset_OpenRiss
    const ps: number[] = [
      prop('Typ', typeName),
      prop('Material', mats.map((m) => doc.get<Material>(m)?.name ?? m).join(', ')),
      prop('Kennzeichen', el.mark ?? ''),
      prop('Kategorie', def?.label ?? el.cat),
      prop('OpenRiss-ID', el.id, 'id'),
    ];
    if (el.comments) ps.push(prop('Kommentare', el.comments, 'text'));
    const lvl = doc.get<Level>(el.levelId);
    if (lvl?.cat === 'level') ps.push(prop('Ebene', lvl.name));
    for (const [k, v] of Object.entries(el.params ?? {})) {
      if (['Typ', 'Material', 'Kennzeichen', 'Kategorie', 'OpenRiss-ID', 'Kommentare', 'Ebene'].includes(k)) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ps.push(prop(k, v));
    }
    pset(el.id, 'Pset_OpenRiss', ps, obj);
  }

  // Beziehungen
  for (const s of storeys) {
    if (s.elems.length) w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contained:' + s.lv.id)},${OH},$,$,${refs(s.elems)},${ref(s.id)})`);
    if (s.spaces.length) w.add(`IFCRELAGGREGATES(${guid('agg-storey:' + s.lv.id)},${OH},$,$,${ref(s.id)},${refs(s.spaces)})`);
  }
  for (const [key, a] of matAssoc) w.add(`IFCRELASSOCIATESMATERIAL(${guid('mat:' + key)},${OH},$,$,${refs(a.objs)},${ref(a.def)})`);

  const iso = now.toISOString().slice(0, 19);
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');`,
    `FILE_NAME(${SS(fileName)},'${iso}',(${SS(author)}),('OpenRiss'),'OpenRiss IFC-Export','OpenRiss 0.1','');`,
    `FILE_SCHEMA(('IFC4'));`,
    'ENDSEC;',
    'DATA;',
  ];
  const text = [...head, ...w.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  return { text, count };
}
