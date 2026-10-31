// IFC-Export – Bewehrung: jeder Stab eines Bewehrungssatzes als IfcReinforcingBar (IfcSweptDiskSolid entlang
// der ausgerundeten Stabachse, gleiche Stäbe über IfcRepresentationMap/IfcMappedItem wiederverwendet),
// Stabtyp je Position (IfcReinforcingBarType mit Biegeform), Gruppen je Bauteil/Position und je Bewehrungsplan,
// Aggregation unter dem Wirtbauteil, Eigenschaftssatz CH_Bewehrung je Satz. Flächen- und Mattenbewehrung als Einzelstäbe.
import type { Doc, El, Id } from '../../core/doc';
import { V3, add3, sub3, mul3, len3 } from '../../core/geom';
import { rebarGeo, Rebar, SHAPE_NAMES } from '../structure/rebar/rebar';
import { areaGeo, fabricGeo, AreaRebar, FabricArea } from '../structure/rebar/area';
import { planOf } from '../structure/rebar/norm';
import { kgNom } from '../structure/rebar/sshv';
import { rebarFigure, barLength } from '../structure/steel';
import { REBAR_COLOR } from '../structure/common';
import { IfcOut, Frame, worldFrame, R, S, SS, E, ref, refs, PropVal } from './ifcStep';

/** Exportiertes Bauteil (für Platzierung/Aggregation der Bewehrung) */
export interface Prod { ent: number; pl: number; frame: Frame; storey: StoreyRec; tag: string }
export interface StoreyRec { lv: { id: Id; name: string; elev: number }; id: number; pl: number; frame: Frame; elems: number[]; spaces: number[] }

/** Ein Satz gleicher Stäbe (Achse des ersten Stabes in Weltkoordinaten + Verschiebungen) */
interface BarSet {
  key: string; el: El; host: El | undefined; pos?: number; dia: number; code: string; shapeName: string;
  path: V3[]; shifts: V3[];
  /** Stablänge (SIA: abgewickelt = Σ Aussenmasse, sonst Achslänge) */
  len: number;
  /** Aussenmasse der Schenkel und Ablenkwinkel (°) der Biegeform */
  legs?: number[]; angles?: number[];
  kind: string; plan: string; grade: string; cover?: number; note?: string;
}

/** Bewehrungsplan eines Satzes (Feld plan, sonst Kommentar, falls er wie eine Plannummer aussieht) */
export const rebarPlan = (el: El): string => planOf(el);
/** Stahlsorte (Element → Typ → Vorgabe B500B) */
const steelGrade = (doc: Doc, el: El): string => String(el.steelGrade ?? el.grade ?? doc.get(el.typeId)?.steelGrade ?? 'B500B');

/** Vordefinierter Stabtyp aus Biegeform und Bezeichnung (MAIN/SHEAR/LIGATURE/EDGE/…) */
export function barKind(code: string, text: string): string {
  const t = text.toLowerCase();
  if (/durchstanz|punch/.test(t)) return 'PUNCHING';
  if (code === '51') return 'LIGATURE';
  if (/abstandhalter|spacer/.test(t)) return 'SPACEBAR';
  if (code === '21') return /rand|leibung|steckbügel|edge|stoss|stoß|sturz/.test(t) ? 'EDGE' : 'SHEAR';
  if (/bügel|stirrup|schub/.test(t)) return 'SHEAR';
  if (/anschluss|anker|anchor|rückbieg/.test(t)) return 'ANCHORING';
  return 'MAIN';
}

function cleanPath(p: V3[]): V3[] {
  const out: V3[] = [];
  for (const q of p) if (!out.length || len3(sub3(q, out[out.length - 1])) > 0.05) out.push(q);
  return out;
}

function collectSets(doc: Doc, keep?: (el: El) => boolean): BarSet[] {
  const out: BarSet[] = [];
  for (const el of doc.all<Rebar>('rebar')) {
    if (el.viewId || (keep && !keep(el))) continue;
    let g;
    try { g = rebarGeo(doc, el); } catch { continue; }
    const path = cleanPath(g.path);
    if (path.length < 2 || !g.n) continue;
    const dir = el.dir ?? { x: 0, y: 0, z: 1 };
    const host = doc.get(el.hostId);
    // SSHV-Figur (Formnummer, Aussenmasse, Winkel) und Listenlänge aus dem Tragwerksmodul
    let fig: ReturnType<typeof rebarFigure> | undefined, len = g.len;
    try { fig = rebarFigure(doc, el); len = barLength(doc, el) || g.len; } catch { fig = undefined; }
    out.push({
      key: el.id, el, host, pos: el.pos, dia: el.dia, code: fig ? fig.nr || 'Sonderform' : el.shape ?? '00', shapeName: fig?.name || SHAPE_NAMES[el.shape] || '',
      path, shifts: g.offs.map((t) => mul3(dir, t)), len, legs: fig?.legs ?? g.legs, angles: fig?.angles,
      kind: barKind(el.shape, `${el.mark ?? ''} ${el.comments ?? ''}`), plan: rebarPlan(el), grade: steelGrade(doc, el), cover: el.coverUsed ?? el.cover, note: el.mark,
    });
  }
  const flat = (el: El, layers: { key: string; label: string; dia: number; z: number; segs: [{ x: number; y: number }, { x: number; y: number }][]; pos?: number }[], fabric: boolean) => {
    const host = doc.get(el.hostId);
    for (const l of layers) {
      // je Stablänge ein Satz (gleiche Geometrie → gleiche Darstellung)
      const byLen = new Map<string, BarSet>();
      for (const [a, b] of l.segs) {
        const A = { x: a.x, y: a.y, z: l.z }, B = { x: b.x, y: b.y, z: l.z };
        const v = sub3(B, A); const k = R(v.x, 1) + ',' + R(v.y, 1);
        let s = byLen.get(k);
        if (!s) {
          s = {
            key: `${el.id}:${l.key}:${byLen.size}`, el, host, pos: l.pos || undefined, dia: l.dia, code: '00', shapeName: SHAPE_NAMES['00'],
            path: [{ x: 0, y: 0, z: 0 }, v], shifts: [], len: len3(v), kind: 'MAIN', plan: rebarPlan(el), grade: steelGrade(doc, el),
            cover: el.cover, note: (fabric ? 'Matte ' + (doc.get(el.typeId)?.name ?? '') + ', ' : '') + l.label,
          };
          byLen.set(k, s);
        }
        s.shifts.push(A);
      }
      out.push(...byLen.values());
    }
  };
  for (const el of doc.all<AreaRebar>('areaRebar')) { if (!el.viewId && (!keep || keep(el))) { try { flat(el, areaGeo(doc, el).layers, false); } catch { /* ungültige Fläche */ } } }
  for (const el of doc.all<FabricArea>('fabricArea')) { if (!el.viewId && (!keep || keep(el))) { try { flat(el, fabricGeo(doc, el).layers, true); } catch { /* ungültige Fläche */ } } }
  return out;
}

/** bars: Anzahl Stäbe, sets: Sätze, maps: verschiedene Stabformen, byHost: Stäbe je Wirtbauteil (Element-ID) */
export interface RebarResult { bars: number; sets: number; maps: number; byHost: Map<Id, number[]> }

/**
 * Bewehrung schreiben. prod: exportierte Bauteile (Element-ID → IFC), storeyAt: Geschoss für Stäbe ohne exportierten Host.
 * Liefert die Stäbe je Wirtbauteil (für IfcRelAggregates); Stäbe ohne Host werden dem Geschoss zugeordnet.
 */
export function writeRebar(o: IfcOut, doc: Doc, prod: Map<Id, Prod>, storeyAt: (z: number) => StoreyRec, keep?: (el: El) => boolean): RebarResult {
  const sets = collectSets(doc, keep);
  const res: RebarResult = { bars: 0, sets: sets.length, maps: 0, byHost: new Map() };
  if (!sets.length) return res;
  const OH = o.OH;
  // gemeinsame Elemente: Abbildungsursprung, Identitätsoperator, Material
  const mapOrigin = o.a2p3({ x: 0, y: 0, z: 0 });
  const op = o.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,${ref(o.origin)},$,$)`);
  let steel = o.material(doc.get('m_betonstahl') ? 'm_betonstahl' : undefined);
  if (!steel) steel = o.add(`IFCMATERIAL('Betonstahl B500B',$,'Steel')`);
  const maps = new Map<string, number>();
  const types = new Map<string, { id: number; bars: number[] }>();
  const groups = new Map<string, { name: string; desc: string; plan: string; bars: number[] }>();
  const allBars: number[] = [];

  for (const s of sets) {
    const p0 = s.path[0];
    const rel = s.path.map((p) => sub3(p, p0));
    // Darstellung (je Ø und Stabform einmal)
    const mk = s.dia + '|' + rel.map((p) => R(p.x, 1) + ',' + R(p.y, 1) + ',' + R(p.z, 1)).join(';');
    let map = maps.get(mk);
    if (!map) {
      const poly = o.add(`IFCPOLYLINE(${refs(rel.map((p, i) => (i ? o.pt3(p) : o.origin)))})`);
      const sd = o.add(`IFCSWEPTDISKSOLID(${ref(poly)},${R(s.dia / 2)},$,$,$)`);
      o.styled(sd, REBAR_COLOR, 1, 'Betonstahl');
      const rep = o.shapeRep(o.body, 'Body', 'AdvancedSweptSolid', [sd]);
      map = o.add(`IFCREPRESENTATIONMAP(${ref(mapOrigin)},${ref(rep)})`);
      maps.set(mk, map);
    }
    // Stabtyp je Position
    const tk = `${s.plan}|${s.pos ?? s.key}|${s.dia}|${s.code}`;
    let ty = types.get(tk);
    if (!ty) {
      const params = s.legs?.length ? `(${[...s.legs.map((l) => `IFCLENGTHMEASURE(${R(l, 1)})`), ...(s.angles ?? []).map((a) => `IFCPLANEANGLEMEASURE(${R((a * Math.PI) / 180, 6)})`)].join(',')})` : '$';
      const tname = (s.plan ? s.plan + ' ' : '') + (s.pos ? `Pos ${s.pos} ` : '') + `Ø${s.dia} ${s.grade}`;
      ty = {
        id: o.add(`IFCREINFORCINGBARTYPE(${o.guid('bartype:' + tk)},${OH},${SS(tname)},${S(s.shapeName)},$,$,$,${S(s.pos ? String(s.pos) : '')},$,${E(s.kind)},${R(s.dia)},${R(Math.PI * (s.dia / 2000) ** 2, 10)},${s.legs ? R(s.len, 1) : '$'},.TEXTURED.,${S(s.code)},${s.legs?.length ? params : '$'})`),
        bars: [],
      };
      types.set(tk, ty);
    }
    // Wirtbauteil und Platzierung
    const hp = s.host ? prod.get(s.host.id) : undefined;
    const hostTag = hp?.tag ?? s.host?.mark ?? s.host?.id ?? '';
    const zMin = Math.min(...s.path.map((p) => p.z));
    const st = hp?.storey ?? storeyAt(zMin);
    const relPl = hp?.pl ?? st.pl, relF = hp?.frame ?? st.frame;
    const name = (s.pos ? `Pos ${s.pos} ` : '') + `Ø${s.dia}`;
    const tag = hostTag + (s.pos ? '/' + s.pos : '');
    const area = R(Math.PI * (s.dia / 2000) ** 2, 10);
    const barIds: number[] = [];
    s.shifts.forEach((sh, k) => {
      const pl = o.placement(relPl, relF, worldFrame(add3(p0, sh)));
      const mi = o.add(`IFCMAPPEDITEM(${ref(map!)},${ref(op)})`);
      const pds = o.pds([o.shapeRep(o.body, 'Body', 'MappedRepresentation', [mi])]);
      const bar = o.add(`IFCREINFORCINGBAR(${o.guid('bar:' + s.key + ':' + k)},${OH},${SS(name)},${S(s.note)},$,${ref(pl)},${ref(pds)},${S(tag)},${SS(s.grade)},${R(s.dia)},${area},${R(s.len, 1)},${E(s.kind)},.TEXTURED.)`);
      barIds.push(bar);
    });
    res.bars += barIds.length;
    allBars.push(...barIds);
    ty.bars.push(...barIds);
    if (hp && s.host) { const l = res.byHost.get(s.host.id) ?? []; l.push(...barIds); res.byHost.set(s.host.id, l); }
    else st.elems.push(...barIds);
    // Gruppe je Bauteil/Position
    const gk = `${s.plan}|${hostTag}|${s.pos ?? s.key}`;
    let g = groups.get(gk);
    if (!g) {
      g = { name: `${hostTag ? hostTag + ' ' : ''}${s.pos ? 'Pos ' + s.pos : name}`, desc: `Ø${s.dia} ${s.grade}${s.plan ? ', Plan ' + s.plan : ''}`, plan: s.plan, bars: [] };
      groups.set(gk, g);
    }
    g.bars.push(...barIds);
    // Eigenschaften je Satz (ein Satz für alle Stäbe)
    const n = barIds.length;
    const total = s.len * n;
    const rec: Record<string, PropVal> = {
      Bauteil: hostTag,
      Position: s.pos ? { v: s.pos, k: 'int' } : undefined,
      Positionsnummer: s.pos ? String(s.pos) : undefined,
      Bewehrungsplan: s.plan,
      Durchmesser: { v: s.dia, k: 'plen' },
      Stahlsorte: s.grade,
      Biegeform_SSHV: s.code,
      Schenkel: s.legs?.length ? s.legs.map((l) => Math.round(l)).join('/') : undefined,
      Biegeform: s.shapeName,
      Anzahl_Staebe: { v: n, k: 'count' },
      Einzellaenge: { v: s.len, k: 'plen' },
      Gesamtlaenge: { v: total, k: 'plen' },
      Gewicht_kg: { v: Math.round((total / 1000) * kgNom(s.dia) * 10) / 10, k: 'mass' },
      Ueberdeckung: s.cover ? { v: s.cover, k: 'plen' } : undefined,
      Abstand: s.el.layout && s.el.layout !== 'single' && n > 1 ? { v: len3(sub3(s.shifts[1], s.shifts[0])), k: 'plen' } : undefined,
      Lage: s.note,
      'OpenRiss-ID': { v: s.el.id, k: 'id' },
    };
    o.pset(s.key, 'CH_Bewehrung', rec, barIds);
  }

  // Typen, Material, Gruppen
  for (const [tk, t] of types) if (t.bars.length) o.add(`IFCRELDEFINESBYTYPE(${o.guid('reltype:' + tk)},${o.OH},$,$,${refs(t.bars)},${ref(t.id)})`);
  if (allBars.length) o.add(`IFCRELASSOCIATESMATERIAL(${o.guid('mat:rebar')},${o.OH},$,$,${refs([...allBars, ...[...types.values()].map((t) => t.id)])},${ref(steel)})`);
  const planGroups = new Map<string, number[]>();
  for (const [gk, g] of groups) {
    const gid = o.add(`IFCGROUP(${o.guid('grp:' + gk)},${o.OH},${SS(g.name)},${S(g.desc)},'Bewehrungsposition')`);
    o.add(`IFCRELASSIGNSTOGROUP(${o.guid('relgrp:' + gk)},${o.OH},$,$,${refs(g.bars)},$,${ref(gid)})`);
    if (g.plan) (planGroups.get(g.plan) ?? planGroups.set(g.plan, []).get(g.plan)!).push(gid);
  }
  for (const [plan, gs] of planGroups) {
    const pid = o.add(`IFCGROUP(${o.guid('plan:' + plan)},${o.OH},${SS('Bewehrungsplan ' + plan)},$,'Bewehrungsplan')`);
    o.add(`IFCRELASSIGNSTOGROUP(${o.guid('relplan:' + plan)},${o.OH},$,$,${refs(gs)},$,${ref(pid)})`);
  }
  res.maps = maps.size;
  return res;
}
