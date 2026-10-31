// IFC4-Export (STEP-Datei nach ISO 10303-21): Projekt (mm), Grundstück, Gebäude, ein Geschoss je Ebene.
// Rohbauteile (Wand, Decke, Fundament, Stütze, Träger) ungeschnitten als IfcExtrudedAreaSolid mit Öffnungen
// (IfcOpeningElement/IfcRelVoidsElement, Türen/Fenster über IfcRelFillsElement) und Schichtaufbau
// (IfcMaterialLayerSetUsage); übrige Bauteile als IfcFacetedBrep aus den Solids. Bewehrung stabweise
// (ifcRebar.ts), Schweizer Betonangaben (ifcCh.ts), Zuordnung je Kategorie über CategoryDef.ifc.
import type { Doc, El, Id } from '../../core/doc';
import { allCats, catDef, onHook, Discipline } from '../../core/registry';
import { levels, projectInfo, Level, Material, TypeEl } from '../../core/view';
import { solidsOf } from '../../views/sectionEngine';
import { coverFor } from '../structure/rebar/build';
import { catFamily, solidLook } from './meshes';
import { IfcOut, Frame, worldFrame, R, S, SS, E, ref, refs, PropVal } from './ifcStep';
import { bodyPlan, ifcHook, isPureOpening, IfcMapping, BodyPlan } from './ifcBody';
import { writeRebar, rebarPlan, Prod, StoreyRec } from './ifcRebar';
import { concreteData, concreteLabel, installConcreteTypeProps } from './ifcCh';

export { stepString, stepReal, compressGuid } from './ifcStep';

// Betonangaben als Typ-Eigenschaften anbieten (jetzt registrierte Kategorien; nach dem Start alle übrigen)
installConcreteTypeProps();
onHook('started', installConcreteTypeProps);

// ------------------------------------------------------------ Zuordnung Kategorie → IFC-Klasse
/** nicht als eigenes Bauteil exportiert (Öffnungen/Schächte erscheinen als IfcOpeningElement, Bewehrung stabweise) */
const SKIP_CATS = new Set(['view', 'type', 'material', 'project', 'level', 'grid', 'refplane', 'line', 'opening', 'shaft', 'area', 'rebar', 'areaRebar', 'fabricArea', 'rebarset']);

interface IfcClass { ent: string; pt: string; pset?: string }
function num(v: any): number | null { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; }

function ifcClass(el: El): IfcClass {
  const c = el.cat, fam = catFamily(c);
  if (c === 'wall') return { ent: 'IFCWALL', pt: '.NOTDEFINED.', pset: 'Pset_WallCommon' };
  if (c === 'door') return { ent: 'IFCDOOR', pt: '.DOOR.', pset: 'Pset_DoorCommon' };
  if (c === 'window') return { ent: 'IFCWINDOW', pt: '.WINDOW.', pset: 'Pset_WindowCommon' };
  if (c === 'foundationSlab') return { ent: 'IFCSLAB', pt: '.BASESLAB.', pset: 'Pset_SlabCommon' };
  if (fam === 'floor') return { ent: 'IFCSLAB', pt: '.FLOOR.', pset: 'Pset_SlabCommon' };
  if (fam === 'roof') return { ent: 'IFCROOF', pt: '.NOTDEFINED.', pset: 'Pset_RoofCommon' };
  if (c === 'ceiling') return { ent: 'IFCCOVERING', pt: '.CEILING.', pset: 'Pset_CoveringCommon' };
  if (fam === 'column') return { ent: 'IFCCOLUMN', pt: '.COLUMN.', pset: 'Pset_ColumnCommon' };
  if (fam === 'beam') return { ent: 'IFCBEAM', pt: '.BEAM.', pset: 'Pset_BeamCommon' };
  if (fam === 'stair') return { ent: 'IFCSTAIR', pt: '.NOTDEFINED.', pset: 'Pset_StairCommon' };
  if (fam === 'railing') return { ent: 'IFCRAILING', pt: '.NOTDEFINED.', pset: 'Pset_RailingCommon' };
  if (c.startsWith('ramp')) return { ent: 'IFCRAMP', pt: '.NOTDEFINED.', pset: 'Pset_RampCommon' };
  if (c.startsWith('curtain')) return { ent: 'IFCCURTAINWALL', pt: '.NOTDEFINED.', pset: 'Pset_CurtainWallCommon' };
  if (c.startsWith('topo')) return { ent: 'IFCGEOGRAPHICELEMENT', pt: '.TERRAIN.' };
  if (c === 'furniture') return { ent: 'IFCFURNITURE', pt: '.NOTDEFINED.' };
  if (fam === 'foundation') return { ent: 'IFCFOOTING', pt: /wall|strip/i.test(c) ? '.STRIP_FOOTING.' : '.PAD_FOOTING.', pset: 'Pset_FootingCommon' };
  return { ent: 'IFCBUILDINGELEMENTPROXY', pt: '.NOTDEFINED.', pset: 'Pset_BuildingElementProxyCommon' };
}
/** Common-Pset zur Entität (für Hook-Entitäten) */
const COMMON_PSET: Record<string, string> = {
  IFCWALL: 'Pset_WallCommon', IFCSLAB: 'Pset_SlabCommon', IFCFOOTING: 'Pset_FootingCommon', IFCCOLUMN: 'Pset_ColumnCommon', IFCBEAM: 'Pset_BeamCommon',
  IFCDOOR: 'Pset_DoorCommon', IFCWINDOW: 'Pset_WindowCommon', IFCBUILDINGELEMENTPROXY: 'Pset_BuildingElementProxyCommon', IFCMEMBER: 'Pset_MemberCommon', IFCPLATE: 'Pset_PlateCommon', IFCRAMP: 'Pset_RampCommon',
};
/** Entitäten ohne PredefinedType */
const NO_PT = new Set(['IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWFITTING', 'IFCFLOWCONTROLLER', 'IFCFLOWMOVINGDEVICE', 'IFCFLOWSTORAGEDEVICE', 'IFCFLOWTREATMENTDEVICE',
  'IFCENERGYCONVERSIONDEVICE', 'IFCDISTRIBUTIONELEMENT', 'IFCDISTRIBUTIONFLOWELEMENT', 'IFCDISTRIBUTIONCONTROLELEMENT', 'IFCCIVILELEMENT', 'IFCVIRTUALELEMENT', 'IFCFURNISHINGELEMENT', 'IFCELEMENTCOMPONENT']);
/** Zusatzattribute nach Tag: [Anzahl, Index des PredefinedType] */
const TAIL: Record<string, [number, number]> = {
  IFCDOOR: [5, 2], IFCWINDOW: [5, 2], IFCMECHANICALFASTENER: [3, 2], IFCELEMENTASSEMBLY: [2, 1], IFCSTAIRFLIGHT: [5, 4], IFCREINFORCINGMESH: [10, 9],
  IFCREINFORCINGBAR: [6, 4], IFCTENDON: [9, 1], IFCTENDONANCHOR: [2, 1],
};
function tailFor(ent: string, pt: string, el: El, doc: Doc): string {
  if (NO_PT.has(ent)) return '';
  const spec = TAIL[ent];
  if (!spec) return ',' + pt;
  const a = new Array(spec[0]).fill('$');
  a[spec[1]] = pt;
  if (ent === 'IFCDOOR' || ent === 'IFCWINDOW') {
    const t = doc.get<TypeEl>(el.typeId) as any;
    const h = num(el.height ?? t?.height), w = num(el.width ?? t?.width);
    a[0] = h ? R(h) : '$'; a[1] = w ? R(w) : '$'; a[3] = '.NOTDEFINED.';
    if (ent === 'IFCDOOR') {
      // Bedienungsart nach Bauart und Anschlag
      const left = !el.flipHand;
      const op: Record<string, string> = {
        single: left ? 'SINGLE_SWING_LEFT' : 'SINGLE_SWING_RIGHT', double: 'DOUBLE_DOOR_SINGLE_SWING', sliding: left ? 'SLIDING_TO_LEFT' : 'SLIDING_TO_RIGHT',
        roll: 'ROLLINGUP', lift: left ? 'SLIDING_TO_LEFT' : 'SLIDING_TO_RIGHT', sectional: 'USERDEFINED',
      };
      const k = op[t?.kind ?? ''];
      if (k) a[3] = '.' + k + '.';
      if (t?.kind === 'sectional') a[4] = SS('SECTIONAL');
    }
  }
  return ',' + a.join(',');
}
const entName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ------------------------------------------------------------ Fachbereiche (Teilmodelle)
const MEP_CATS = new Set(['pipe', 'duct', 'conduit', 'fbh', 'mepFixture', 'earthing']);
const SITE_CATS = new Set(['topo', 'excavation']);
const STRUCT_CATS = new Set(['column', 'beam', 'foundationIsolated', 'foundationWall', 'foundationSlab', 'rebar', 'areaRebar', 'fabricArea',
  'embed', 'joint', 'insulZone', 'lightwell', 'stair', 'stairBearing']);
/** Fachbereich eines Bauteils: Kategorie-Vorgabe, sonst Standardzuordnung; Wände/Decken nach «Tragwerk» */
export function disciplineOf(el: El, doc: Doc): Discipline {
  const d = catDef(el.cat)?.discipline;
  if (d) return typeof d === 'function' ? d(el, doc) : d;
  if (MEP_CATS.has(el.cat) || el.cat.startsWith('mep')) return 'mep';
  if (SITE_CATS.has(el.cat) || el.cat.startsWith('topo')) return 'site';
  if (STRUCT_CATS.has(el.cat)) return 'struct';
  // Wände/Decken: «Tragwerk» gesetzt oder Kern aus Beton (z.B. Magerbeton, nicht tragende Betonwand)
  if (el.cat === 'wall' || el.cat === 'floor') return el.structural || concreteCore(doc, el) ? 'struct' : 'arch';
  // Türen/Fenster füllen die Öffnungen ihrer Wand → gleicher Fachbereich wie der Host
  if ((el.cat === 'door' || el.cat === 'window') && el.hostId) { const h = doc.get(el.hostId); if (h) return disciplineOf(h, doc); }
  // gehostete Elemente (Einlagen in Fugen, Bewehrung …) folgen ihrem Host, wenn nichts anderes gilt
  return 'arch';
}

const CONCRETE_PATTERNS = new Set(['concrete', 'rc']);
function concreteCore(doc: Doc, el: El): boolean {
  const layers: { mat?: Id; core?: boolean; fn?: string }[] = (doc.get<TypeEl>(el.typeId) as any)?.layers ?? [];
  const core = layers.filter((l) => l.core || l.fn === 'structure');
  return core.length > 0 && core.every((l) => { const m = doc.get<Material>(l.mat); return !!m && (CONCRETE_PATTERNS.has(m.cutPattern ?? '') || /^m_(beton|stb|mb)/.test(m.id)); });
}

/** Teilmodell: Fachbereiche und/oder Kategorien ein-/ausschließen */
export interface IfcOptions {
  /** nur diese Fachbereiche ('arch' | 'struct' | 'mep' | 'site') */
  disciplines?: Discipline[];
  /** nur diese Kategorien */
  cats?: string[];
  /** diese Kategorien weglassen */
  excludeCats?: string[];
}
export function ifcFilter(doc: Doc, opts: IfcOptions = {}): (el: El) => boolean {
  const discs = opts.disciplines?.length ? new Set<string>(opts.disciplines) : null;
  const inc = opts.cats?.length ? new Set(opts.cats) : null;
  const exc = new Set(opts.excludeCats ?? []);
  return (el) => (!inc || inc.has(el.cat)) && !exc.has(el.cat) && (!discs || discs.has(disciplineOf(el, doc)));
}

/** Elemente, die als Bauteil exportiert werden (Modellelemente mit Geometrie; Räume immer) */
export function ifcElements(doc: Doc, opts: IfcOptions = {}): El[] {
  const out: El[] = [];
  const keep = ifcFilter(doc, opts);
  for (const def of allCats()) {
    if (def.annotation || def.datum || SKIP_CATS.has(def.cat)) continue;
    for (const el of doc.all(def.cat)) if (!el.viewId && keep(el)) out.push(el);
  }
  return out;
}

// ------------------------------------------------------------ Export
export interface IfcResult {
  text: string;
  /** exportierte Bauteile (inkl. Bewehrungsstäbe) */
  count: number;
  /** Bewehrungsstäbe / -sätze, Öffnungen */
  bars?: number; sets?: number; openings?: number;
}

export function exportIfc(doc: Doc, fileName = 'Projekt.ifc', nowOrOpts: Date | IfcOptions = new Date(), opts: IfcOptions = {}): IfcResult {
  const now = nowOrOpts instanceof Date ? nowOrOpts : new Date();
  if (!(nowOrOpts instanceof Date)) opts = { ...nowOrOpts, ...opts };
  const keep = ifcFilter(doc, opts);
  const pi = projectInfo(doc) ?? ({ name: 'Projekt', number: '', author: '', client: '', address: '', status: '' } as any);
  // Projektschlüssel für stabile GUIDs
  const seed = [pi.name, pi.number, pi.date, ...doc.all('view').map((v) => v.id).sort().slice(0, 3)].join('|');
  const o = new IfcOut(doc, seed);
  const guid = (k: string) => o.guid(k);

  // Eigentümer / Anwendung
  const author = pi.author || 'OpenRiss';
  const person = o.add(`IFCPERSON($,${S(author)},$,$,$,$,$,$)`);
  const devOrg = o.add(`IFCORGANIZATION($,'OpenRiss',$,$,$)`);
  const pao = o.add(`IFCPERSONANDORGANIZATION(${ref(person)},${ref(devOrg)},$)`);
  const appl = o.add(`IFCAPPLICATION(${ref(devOrg)},'0.1','OpenRiss','OpenRiss')`);
  const ts = Math.floor(now.getTime() / 1000);
  o.OH = ref(o.add(`IFCOWNERHISTORY(${ref(pao)},${ref(appl)},$,.ADDED.,${ts},${ref(pao)},${ref(appl)},${ts})`));
  const OH = o.OH;

  // Einheiten (Länge mm, Fläche m², Volumen m³, Winkel rad, Masse kg)
  const units = o.add(`IFCUNITASSIGNMENT(${refs([
    o.add(`IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`), o.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`), o.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`),
    o.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`), o.add(`IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)`),
  ])})`);

  // Geometrischer Kontext
  o.origin = o.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const wcs = o.add(`IFCAXIS2PLACEMENT3D(${ref(o.origin)},${ref(o.dir3({ x: 0, y: 0, z: 1 }))},${ref(o.dir3({ x: 1, y: 0, z: 0 }))})`);
  const ctx = o.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ref(wcs)},${ref(o.dir2({ x: 0, y: 1 }))})`);
  o.body = o.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ref(ctx)},$,.MODEL_VIEW.,$)`);
  o.axis = o.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ref(ctx)},$,.GRAPH_VIEW.,$)`);
  const ident = o.add(`IFCAXIS2PLACEMENT3D(${ref(o.origin)},$,$)`);

  // Räumliche Struktur
  const project = o.add(`IFCPROJECT(${guid('project')},${OH},${S(pi.number || pi.name)},${S(pi.address)},$,${S(pi.name)},${S(pi.status)},(${ref(ctx)}),${ref(units)})`);
  const sitePl = o.add(`IFCLOCALPLACEMENT($,${ref(ident)})`);
  const refElev = typeof pi.elev00 === 'number' && isFinite(pi.elev00) ? R(pi.elev00 * 1000) : '$';
  const site = o.add(`IFCSITE(${guid('site')},${OH},${SS('Grundstück')},$,$,${ref(sitePl)},$,$,.ELEMENT.,$,$,${refElev},$,$)`);
  const bldPl = o.add(`IFCLOCALPLACEMENT(${ref(sitePl)},${ref(ident)})`);
  const bld = o.add(`IFCBUILDING(${guid('building')},${OH},${SS(pi.name || 'Gebäude')},$,$,${ref(bldPl)},$,$,.ELEMENT.,$,$,$)`);
  o.add(`IFCRELAGGREGATES(${guid('agg-project')},${OH},$,$,${ref(project)},(${ref(site)}))`);
  o.add(`IFCRELAGGREGATES(${guid('agg-site')},${OH},$,$,${ref(site)},(${ref(bld)}))`);
  // Grundstück als «Geschoss» für Gelände/Aushub (absolute Höhen, Platzierung relativ zum Grundstück)
  const siteRec: StoreyRec = { lv: { id: '_site', name: 'Grundstück', elev: 0 }, id: site, pl: sitePl, frame: worldFrame({ x: 0, y: 0, z: 0 }), elems: [], spaces: [] };

  // Geschosse
  const allLv = levels(doc);
  let stLv: { id: Id; name: string; elev: number }[] = allLv.filter((l) => l.story !== false);
  if (!stLv.length) stLv = allLv;
  if (!stLv.length) stLv = [{ id: '_ebene0', name: 'Ebene 0', elev: 0 }];
  const storeys: StoreyRec[] = stLv.map((l) => {
    const frame = worldFrame({ x: 0, y: 0, z: l.elev });
    const pl = o.placement(bldPl, null, frame);
    const id = o.add(`IFCBUILDINGSTOREY(${guid('storey:' + l.id)},${OH},${SS(l.name)},$,$,${ref(pl)},$,$,.ELEMENT.,${R(l.elev)})`);
    return { lv: l, id, pl, frame, elems: [], spaces: [] };
  });
  o.add(`IFCRELAGGREGATES(${guid('agg-building')},${OH},$,$,${ref(bld)},${refs(storeys.map((s) => s.id))})`);

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

  // Bewehrung je Wirtbauteil: Pläne, Überdeckungen, Stahlsorten (für Bauteil-Psets)
  const reinf = new Map<Id, { plans: Set<string>; covers: Set<number>; grades: Set<string> }>();
  for (const c of ['rebar', 'areaRebar', 'fabricArea']) for (const r of doc.all(c)) {
    if (r.viewId || !r.hostId) continue;
    const s = reinf.get(r.hostId) ?? reinf.set(r.hostId, { plans: new Set(), covers: new Set(), grades: new Set() }).get(r.hostId)!;
    const p = rebarPlan(r); if (p) s.plans.add(p);
    const cv = r.coverUsed ?? r.cover; if (cv > 0) s.covers.add(Math.round(cv));
    s.grades.add(String(r.steelGrade ?? 'B500B'));
  }

  const prod = new Map<Id, Prod>();
  const matAssoc = new Map<string, { def: number; objs: number[] }>();
  const assoc = (m: { key: string; id: number }, obj: number) => { const a = matAssoc.get(m.key) ?? matAssoc.set(m.key, { def: m.id, objs: [] }).get(m.key)!; a.objs.push(obj); };
  const fills: { opening: number; el: Id }[] = [];
  let count = 0, nOpen = 0;

  /** Öffnungen eines Bauteils schreiben (Platzierung relativ zum Bauteil) */
  const writeOpenings = (host: number, hostPl: number, frame: Frame, plan: BodyPlan) => {
    for (const sp of plan.openings) {
      const pl = o.placement(hostPl, frame, frame);
      const rep = o.pds([o.shapeRep(o.body, 'Body', 'SweptSolid', sp.items)]);
      const pure = !!sp.el && !sp.filler;
      const hk = pure ? ifcHook(sp.el!, doc) : null;
      const pt = hk?.predefined ? E(hk.predefined) : '.OPENING.';
      const op = o.add(`IFCOPENINGELEMENT(${guid(pure && sp.el!.cat !== 'shaft' ? 'el:' + sp.el!.id : 'opening:' + sp.key)},${OH},${SS(hk?.name || sp.name)},${S(sp.desc)},$,${ref(pl)},${ref(rep)},${S(sp.el?.id ?? '')},${pt})`);
      o.add(`IFCRELVOIDSELEMENT(${guid('voids:' + sp.key)},${OH},$,$,${ref(host)},${ref(op)})`);
      nOpen++;
      if (sp.filler) fills.push({ opening: op, el: sp.filler.id });
      if (pure && sp.el) {
        const ps = basePsets(sp.el, catDef(sp.el.cat)?.label ?? sp.el.cat, '');
        mergeHook(ps, hk);
        writePsets(sp.key, ps, op);
      }
    }
  };
  /** Pset_OpenRiss (Typ, Material, Kennzeichen, Kategorie, ID, Kommentare, Ebene, Projektparameter) */
  const basePsets = (el: El, label: string, matNames: string): Map<string, Record<string, PropVal>> => {
    const type = doc.get<TypeEl>(el.typeId);
    const rec: Record<string, PropVal> = {
      Typ: type?.name, Material: matNames, Kennzeichen: el.mark, Kategorie: label, 'OpenRiss-ID': { v: el.id, k: 'id' },
      Kommentare: el.comments ? { v: el.comments, k: 'text' } : undefined,
    };
    const lvl = doc.get<Level>(el.levelId);
    if (lvl?.cat === 'level') rec.Ebene = lvl.name;
    for (const [k, v] of Object.entries(el.params ?? {})) {
      if (k in rec) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') rec[k] = v;
    }
    return new Map([['Pset_OpenRiss', rec]]);
  };
  const mergeHook = (ps: Map<string, Record<string, PropVal>>, hk: IfcMapping | null) => {
    for (const [n, r] of Object.entries(hk?.psets ?? {})) ps.set(n, { ...(ps.get(n) ?? {}), ...r });
  };
  const writePsets = (key: string, ps: Map<string, Record<string, PropVal>>, obj: number) => {
    for (const [n, r] of ps) o.pset(key, n, r, [obj]);
  };

  // ---------------------------------------------------------- Bauteile
  for (const el of ifcElements(doc, opts)) {
    const def = catDef(el.cat);
    const host = el.hostId ? doc.get(el.hostId) : undefined;
    // reine Öffnungen in Wänden erscheinen als IfcOpeningElement des Hosts
    if (def?.hostOpening && host?.cat === 'wall' && isPureOpening(el, doc)) continue;
    const isRoom = el.cat === 'room';
    const hk = isRoom ? null : ifcHook(el, doc);
    const type = doc.get<TypeEl>(el.typeId);
    const typeName = type?.name ?? '';
    const name = hk?.name || typeName || el.name || def?.label || el.cat;

    // Körper: Extrusion (bekannte Rohbauteile) oder Brep aus Solids
    let plan: BodyPlan | null = null;
    try { plan = isRoom ? null : bodyPlan(o, doc, el); } catch (e) { console.warn('IFC-Körper', el.cat, el.id, e); plan = null; }
    let frame: Frame, reps: number[], st: StoreyRec, matNames = '';
    let mat: { key: string; id: number } | undefined;
    if (plan) {
      st = storeyFor(el, plan.z?.[0] ?? plan.frame.o.z);
      frame = plan.frame; reps = plan.reps; mat = plan.mat;
      const t: any = type;
      matNames = t?.layers?.length ? t.layers.map((l: any) => doc.get<Material>(l.mat)?.name ?? l.mat).join(', ') : (doc.get<Material>(t?.mat)?.name ?? '');
    } else {
      let solids = solidsOf(doc, el);
      if (def?.ifcSolids) { try { solids = def.ifcSolids(el, doc); } catch (e) { console.warn('IFC-Körper', el.cat, el.id, e); solids = []; } }
      if (!solids.length && !isRoom) continue;
      let minZ = Infinity;
      for (const s of solids) for (const f of s.faces) for (const p of f.pts) if (p.z < minZ) minZ = p.z;
      const sr = def?.ifcSite ? siteRec : storeyFor(el, minZ);
      st = sr; frame = sr.frame;
      const items: number[] = [];
      let tess = false;
      for (const s of solids) {
        const loc = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y, z: p.z - sr.lv.elev });
        // große Netze (Gelände) als Dreiecksnetz statt Brep
        const big = s.faces.length > 400;
        const b = big ? o.triMesh(s.faces, loc) : o.brep(s.faces, loc);
        if (big && b) tess = true;
        if (!b) continue;
        const lk = solidLook(doc, el, s);
        o.styled(b, lk.color, lk.opacity, lk.name);
        items.push(b);
      }
      if (!items.length && !isRoom) continue;
      reps = items.length ? [o.shapeRep(o.body, 'Body', tess ? 'Tessellation' : 'Brep', items)] : [];
      // Materialien aus den Solids (eines oder Bestandteile)
      const mats = [...new Set(solids.map((s) => s.mat).filter((m): m is Id => !!m && !!o.material(m)))];
      matNames = mats.map((m) => doc.get<Material>(m)?.name ?? m).join(', ');
      if (mats.length === 1) mat = { key: 'mat:' + mats[0], id: o.material(mats[0])! };
      else if (mats.length > 1) {
        const key = 'cset:' + mats.join('+');
        mat = { key, id: o.once(key, () => {
          const cons = mats.map((m) => o.add(`IFCMATERIALCONSTITUENT($,$,${ref(o.material(m)!)},$,$)`));
          return o.add(`IFCMATERIALCONSTITUENTSET(${SS(typeName || matNames.replace(/, /g, ' / '))},$,${refs(cons)})`);
        }) };
      }
    }
    const rep = reps.length ? ref(o.pds(reps)) : '$';
    const pl = o.placement(st.pl, st.frame, frame);
    const g = guid('el:' + el.id);
    let obj: number;
    if (isRoom) {
      const nr = el.number ?? el.mark ?? '';
      obj = o.add(`IFCSPACE(${g},${OH},${SS(nr || el.name || 'Raum')},${S(el.comments)},$,${ref(pl)},${rep},${S(el.name)},.ELEMENT.,.INTERNAL.,$)`);
      st.spaces.push(obj);
    } else {
      const c = ifcClass(el);
      const baseEnt = plan?.ent ?? c.ent, basePt = plan?.predefined ?? c.pt;
      const ent = hk?.entity ? entName(hk.entity) : baseEnt;
      const pt = hk?.predefined ? E(hk.predefined) : ent === baseEnt ? basePt : '.NOTDEFINED.';
      const head = `${g},${OH},${SS(name)},${S(el.comments)},${S(typeName || def?.label)},${ref(pl)},${rep}`;
      obj = ent === 'IFCANNOTATION' ? o.add(`IFCANNOTATION(${head})`) : o.add(`${ent}(${head},${SS(el.mark || el.id)}${tailFor(ent, pt, el, doc)})`);
      st.elems.push(obj);
      prod.set(el.id, { ent: obj, pl, frame, storey: st, tag: el.mark || el.id });
      // Eigenschaften
      const ps = basePsets(el, def?.label ?? el.cat, matNames);
      const cp = ent === c.ent ? c.pset : COMMON_PSET[ent];
      if (cp) {
        const rec: Record<string, PropVal> = { Reference: { v: typeName || name, k: 'id' } };
        const ext = type ? (type as any).function === 'exterior' : undefined;
        const fam = catFamily(el.cat);
        if (el.cat === 'wall' || fam === 'floor') { rec.IsExternal = !!ext; rec.LoadBearing = !!el.structural; }
        else if (el.cat === 'foundationSlab') { rec.IsExternal = true; rec.LoadBearing = el.structural !== false; }
        else if (['column', 'beam', 'foundation'].includes(fam)) rec.LoadBearing = el.structural !== false;
        else if (host?.cat === 'wall' && (el.cat === 'door' || el.cat === 'window')) rec.IsExternal = (doc.get(host.typeId) as any)?.function === 'exterior';
        if (fam === 'beam' && el.a && el.b) rec.Span = { v: Math.hypot(el.b.x - el.a.x, el.b.y - el.a.y), k: 'plen' };
        ps.set(cp, rec);
      }
      // Beton (Schweiz): Festigkeitsklasse, Exposition, NPK, Überdeckung, Bewehrungspläne
      const isHost = !!plan || ['wall', 'floor', 'column', 'beam'].includes(el.cat) || el.cat.startsWith('foundation');
      const cd = concreteData(doc, el, isHost ? coverFor(doc, el) : undefined);
      if (cd) {
        const ri = reinf.get(el.id);
        const plans = [...(ri?.plans ?? [])].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
        // Überdeckung: Bauteilwert, sonst grösste der eingelegten Bewehrung, sonst Projektvorgabe
        const covers = [...(ri?.covers ?? [])].sort((a, b) => a - b);
        const cover = el.rebarCover > 0 ? el.rebarCover : covers.length ? covers[covers.length - 1] : cd.cover;
        ps.set('Pset_ConcreteElementGeneral', {
          StrengthClass: cd.grade, ExposureClass: cd.exposure, ConstructionMethod: cd.method,
          ReinforcementStrengthClass: ri ? [...ri.grades].join(', ') : undefined,
          ConcreteCover: cover && ri ? { v: cover, k: 'plen' } : undefined,
        });
        ps.set('CH_Tragwerk', {
          BauteilID: el.mark || el.id, Betonsorte: concreteLabel(cd) || undefined, Festigkeitsklasse: cd.grade, NPK: cd.npk, Expositionsklasse: cd.exposure,
          Ueberdeckung: cover ? { v: cover, k: 'plen' } : undefined,
          Ueberdeckung_Bewehrung: covers.length > 1 ? 'c_nom ' + covers.join(' / ') + ' mm' : undefined, WU: cd.wu,
          OK_Rohbau: plan?.z ? { v: plan.z[1], k: 'len' } : undefined, UK_Rohbau: plan?.z ? { v: plan.z[0], k: 'len' } : undefined,
          Bewehrungsplan: plans.join(', ') || undefined,
        });
      }
      mergeHook(ps, hk);
      writePsets(el.id, ps, obj);
      if (plan) writeOpenings(obj, pl, frame, plan);
    }
    count++;
    if (mat) assoc(mat, obj);
  }

  // ---------------------------------------------------------- Bewehrung
  const rb = writeRebar(o, doc, prod, storeyAt, keep);
  for (const [hid, bars] of rb.byHost) {
    const hp = prod.get(hid);
    if (hp && bars.length) o.add(`IFCRELAGGREGATES(${guid('agg-rebar:' + hid)},${OH},$,$,${ref(hp.ent)},${refs(bars)})`);
  }
  count += rb.bars;

  // ---------------------------------------------------------- Beziehungen
  // Einlagen in Arbeitsfugen (Fugenblech): Bezug Fuge → Einlage
  for (const e of doc.all('embed')) {
    const host = e.hostId ? doc.get(e.hostId) : undefined;
    if (host?.cat !== 'joint') continue;
    const a = prod.get(host.id), b = prod.get(e.id);
    if (a && b) o.add(`IFCRELCONNECTSELEMENTS(${guid('conn:' + host.id + ':' + e.id)},${OH},'Fugenblech',$,$,${ref(a.ent)},${ref(b.ent)})`);
  }
  for (const f of fills) {
    const p = prod.get(f.el);
    if (p) o.add(`IFCRELFILLSELEMENT(${guid('fills:' + f.el)},${OH},$,$,${ref(f.opening)},${ref(p.ent)})`);
  }
  if (siteRec.elems.length) o.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contained:site')},${OH},$,$,${refs(siteRec.elems)},${ref(site)})`);
  for (const s of storeys) {
    if (s.elems.length) o.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contained:' + s.lv.id)},${OH},$,$,${refs(s.elems)},${ref(s.id)})`);
    if (s.spaces.length) o.add(`IFCRELAGGREGATES(${guid('agg-storey:' + s.lv.id)},${OH},$,$,${ref(s.id)},${refs(s.spaces)})`);
  }
  for (const [key, a] of matAssoc) if (a.objs.length) o.add(`IFCRELASSOCIATESMATERIAL(${guid('mat:' + key)},${OH},$,$,${refs(a.objs)},${ref(a.def)})`);

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
  const text = [...head, ...o.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  return { text, count, bars: rb.bars, sets: rb.sets, openings: nOpen };
}
