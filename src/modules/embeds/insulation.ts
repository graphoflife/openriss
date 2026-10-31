// Druckfeste Dämmung unter der Bodenplatte: Material-Kennwerte σ10, σc (2 %/50 J.), f_cd; Element «Dämmzone»
// (Skizze, Produkt = Typ mit Material und Farbe, Oberkante = Unterkante der Host-Platte); farbige Darstellung im
// Schalungsplan, Legende (Beschriftungselement) mit Kennwerten und Pressungsnachweis; Pressungen aus CSV/JSON.
import type { Doc, El, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, Poly, MultiPoly, intersection, pointInPoly, bboxOf, interiorPoint, polyArea } from '../../core/geom';
import { registerCategory, GROUPS, PropDef, PlanCtx } from '../../core/registry';
import { TypeEl, Material, levelElev, levelOptions, isPlanLike, typesOf } from '../../core/view';
import { cached } from '../../core/cache';
import { prism } from '../../views/sectionEngine';
import type { DisplayList, Prim } from '../../render/displayList';
import type { View } from '../../core/view';
import { loopsArea, multiArea, transformLoops, moveLoops, loopGrips, dragLoopGrip, loopsCenter } from '../architecture/common';
import { slabInfo, slabAt, addMissing, fmtM3 } from './common';

// ------------------------------------------------------------ Material-Kennwerte
export interface InsulMaterial extends Material { sigma10?: number; sigmaC?: number; fcd?: number; Ecomp?: number }
export const MAT_KEYS: [keyof InsulMaterial & string, string][] = [['sigma10', 'σ10 (10 % Stauchung) [kPa]'], ['sigmaC', 'σc (2 % / 50 J.) [kPa]'], ['fcd', 'f_cd [kPa]'], ['Ecomp', 'E-Modul [kPa]']];

export interface InsulType extends TypeEl { of: 'insulZone'; mat?: Id; t?: number; plies?: number; color?: string; product?: string; description?: string }
export interface InsulZone extends El { cat: 'insulZone'; loops: V2[][]; levelId: Id; offset: number; hostId?: Id }

export const zoneType = (doc: Doc, el: El) => doc.get<InsulType>(el.typeId);
export const zoneMat = (doc: Doc, el: El) => doc.get<InsulMaterial>(zoneType(doc, el)?.mat);
export const zoneThick = (doc: Doc, el: El) => zoneType(doc, el)?.t ?? 160;
export const zoneColor = (doc: Doc, el: El) => zoneType(doc, el)?.color ?? zoneMat(doc, el)?.color ?? '#b9d7f2';
/** Oberkante der Dämmzone: Unterkante der Host-Platte bzw. Ebene + Versatz */
export function zoneTop(doc: Doc, el: El): number {
  const sl = el.hostId ? slabInfo(doc, doc.get(el.hostId)) : null;
  return sl ? sl.bot : levelElev(doc, el.levelId) + (el.offset ?? 0);
}
export function zoneArea(doc: Doc, el: El): MultiPoly { return el.id ? cached(doc, 'insulArea', el.id, () => loopsArea(el.loops)) : loopsArea(el.loops); }

// ------------------------------------------------------------ Grundriss: farbig, unter dem Schnittmuster der Platte
function drawZonePlan(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; const z = zoneTop(doc, el);
  if (ctx.ceiling || z > ctx.cutZ + 1 || z < ctx.depthZ - 50) return;
  const area = zoneArea(doc, el); if (!area.length) return;
  const col = zoneColor(doc, el);
  // 1) geschnittene Platte darüber: Hintergrund des Schnittmusters einfärben
  let recolored = false;
  const out: Prim[] = [];
  for (const it of dl.items) {
    out.push(it);
    if (it.k !== 'fill' || !it.fill.pattern || it.fill.pattern === 'solid' || !it.o) continue;
    const host = doc.get(it.o); if (!host || (host.cat !== 'foundationSlab' && host.cat !== 'floor')) continue;
    const sl = slabInfo(doc, host); if (!sl || Math.abs(sl.bot - z) > 5) continue;
    let hit = false;
    for (const p of area) for (const q of intersection(it.rings, p)) { out.push({ ...it, rings: q, fill: { ...it.fill, color: col }, pen: undefined }); hit = true; }
    if (hit && it.pen) out.push({ ...it, fill: { color: 'transparent' } });
    recolored ||= hit;
  }
  dl.items = out;
  // 2) sonst: Farbfläche ganz unten (unter Platten-/Wandumrissen)
  if (!recolored) {
    const at = dl.items[0]?.k === 'clip' ? 1 : 0;
    const fills: Prim[] = area.map((p) => ({ k: 'fill', rings: p, fill: { color: col }, o: el.id } as Prim));
    dl.items.splice(at, 0, ...fills);
  }
  (dl as any).boxes = null;
  // Zonengrenze und Bezeichnung
  for (const p of area) for (const r of p) dl.poly(r, { w: 1, color: shade(col, 0.55), dash: 'dash' }, true);
  const b = bboxOf(area[0][0]);
  if (el.mark && Math.min(b.max.x - b.min.x, b.max.y - b.min.y) > 8 * dl.scale) dl.text(interiorPoint(area[0]), el.mark, { size: 2.2, color: shade(col, 0.4), ha: 'center', va: 'middle' });
}
function shade(hex: string, f: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); if (!m) return '#305080';
  return '#' + [m[1], m[2], m[3]].map((h) => Math.round(parseInt(h, 16) * f).toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ Texte
const kpa = (v: number | undefined) => (v === undefined || !isFinite(v) ? '–' : String(Math.round(v)));
export function productText(doc: Doc, t: InsulType | undefined): string {
  if (!t) return '';
  const m = doc.get<InsulMaterial>(t.mat); const plies = t.plies ?? 1; const T = t.t ?? 160;
  const k: string[] = [];
  if (m?.sigmaC) k.push(`σc ≥ ${kpa(m.sigmaC)} kPa`); if (m?.fcd) k.push(`f_cd ≥ ${kpa(m.fcd)} kPa`);
  return `${t.product ?? t.name}${k.length ? ' (' + k.join(', ') + ')' : ''}, ${plies > 1 ? plies + ' × ' + Math.round(T / plies) : Math.round(T)} mm`;
}
const zoneTag = (doc: Doc, el: El) => `${el.mark ? el.mark + ' ' : ''}${zoneType(doc, el)?.product ?? zoneType(doc, el)?.name ?? 'Dämmzone'}`;

// ------------------------------------------------------------ Kategorie Dämmzone
function zoneProps(): PropDef[] {
  const g = GROUPS;
  return [
    { key: 'levelId', label: 'Ebene', group: g.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'offset', label: 'Oberkante über Ebene (ohne Host)', group: g.constraints, type: 'length', get: (e) => e.offset ?? 0, set: (_e, v) => ({ offset: v }) },
    { key: 'host', label: 'Platte (Oberkante = UK Platte)', group: g.constraints, type: 'select',
      options: (doc) => [['', '–'], ...doc.all('foundationSlab').concat(doc.all('floor')).map((s) => [s.id, (s.mark || s.id) + ' – ' + (doc.get(s.typeId)?.name ?? '')] as [string, string])],
      get: (e) => e.hostId ?? '', set: (_e, v) => ({ hostId: v || undefined }) },
    { key: 'top', label: 'Kote Oberkante', group: g.constraints, type: 'readonly', get: (e, doc) => (zoneTop(doc, e) / 1000).toFixed(3) },
    { key: 'area', label: 'Fläche', group: g.dims, type: 'area', get: (e, doc) => multiArea(zoneArea(doc, e)) },
    { key: 'vol', label: 'Volumen', group: g.dims, type: 'readonly', get: (e, doc) => fmtM3(multiArea(zoneArea(doc, e)) * zoneThick(doc, e)) },
    ...MAT_KEYS.slice(0, 3).map(([k, label]): PropDef => ({ key: 'm_' + k, label, group: 'Kennwerte (Material)', type: 'readonly', get: (e, doc) => kpa(zoneMat(doc, e)?.[k] as number | undefined) })),
    { key: 'sigmaMax', label: 'Pressung max. (Datei) [kPa]', group: 'Nachweis', type: 'readonly', get: (e, doc) => { const r = zoneCheck(doc, e); return r ? `${kpa(r.qs)} / ${kpa(r.d)}` : '–'; } },
    { key: 'eta', label: 'Ausnutzung η', group: 'Nachweis', type: 'readonly', get: (e, doc) => { const r = zoneCheck(doc, e); return !r ? '–' : r.missing ? `⚠ Kennwerte fehlen (${r.missing.join(', ')})` : r.eta.toFixed(2); } },
    { key: 'mark', label: 'Kennzeichen', group: g.identity, type: 'text', get: (e) => e.mark ?? '', set: (_e, v) => ({ mark: v }) },
    { key: 'comments', label: 'Kommentare', group: g.identity, type: 'text', get: (e) => e.comments ?? '', set: (_e, v) => ({ comments: v }) },
  ];
}
function zoneTypeProps(): PropDef[] {
  const g = GROUPS;
  const matProp = ([k, label]: [keyof InsulMaterial & string, string]): PropDef => ({
    key: 'mat_' + k, label, group: 'Kennwerte (Material)', type: 'number',
    get: (t, doc) => (doc.get<InsulMaterial>(t.mat)?.[k] as number | undefined) ?? 0,
    set: (t, v, doc) => { if (t.mat && doc.get(t.mat)) doc.update(t.mat, { [k]: v > 0 ? v : undefined }); return undefined; },
  });
  return [
    { key: 'product', label: 'Produkt', group: g.identity, type: 'text', get: (t) => t.product ?? '', set: (_t, v) => ({ product: v || undefined }) },
    { key: 'mat', label: 'Material', group: g.materials, type: 'material', get: (t) => t.mat ?? '', set: (_t, v) => ({ mat: v || undefined }) },
    { key: 't', label: 'Dicke total', group: g.dims, type: 'length', get: (t) => t.t ?? 160, set: (_t, v) => (v > 0 ? { t: v } : undefined) },
    { key: 'plies', label: 'Lagen', group: g.dims, type: 'int', get: (t) => t.plies ?? 1, set: (_t, v) => (v >= 1 ? { plies: Math.round(v) } : undefined) },
    { key: 'color', label: 'Farbe (Plan)', group: g.graphics, type: 'color', get: (t) => t.color ?? '#b9d7f2', set: (_t, v) => ({ color: v }) },
    ...MAT_KEYS.map(matProp),
    { key: 'legend', label: 'Legendentext', group: g.text, type: 'readonly', get: (t, doc) => productText(doc, t as InsulType) },
    { key: 'description', label: 'Beschreibung', group: g.identity, type: 'text', get: (t) => t.description ?? '', set: (_t, v) => ({ description: v }) },
  ];
}

registerCategory({
  cat: 'insulZone', label: 'Dämmzone', plural: 'Dämmzonen', hasTypes: true, planOrder: 80,
  drawPlan: drawZonePlan,
  solids: (el, doc) => {
    const z = zoneTop(doc, el); const T = zoneThick(doc, el); const t = zoneType(doc, el);
    return zoneArea(doc, el).map((p) => ({ faces: prism(p[0], z - T, z, p.slice(1)), mat: t?.mat, color: zoneColor(doc, el) }));
  },
  grips: (el, _doc, view) => loopGrips(el.loops, view),
  dragGrip: (el, id, p) => { const l = dragLoopGrip(el.loops, id, p); return l ? { loops: l } : undefined; },
  transform: (el, m, _doc, view) => (isPlanLike(view) ? { loops: transformLoops(el.loops, m) } : undefined),
  translate3d: (el, d) => ({ loops: moveLoops(el.loops, d), offset: (el.offset ?? 0) + d.z }),
  center: (el) => loopsCenter(el.loops),
  tagPoint: (el, doc) => { const a = zoneArea(doc, el); return a.length ? interiorPoint(a[0]) : loopsCenter(el.loops); },
  tagText: (el, doc) => zoneTag(doc, el),
  props: () => zoneProps(),
  typeProps: () => zoneTypeProps(),
  ifc: (el, doc) => {
    const t = zoneType(doc, el); const m = zoneMat(doc, el);
    const ps: Record<string, string | number | boolean> = { Produkt: t?.product ?? t?.name ?? '', Dicke_mm: zoneThick(doc, el), Lagen: t?.plies ?? 1, Flaeche_m2: Math.round(multiArea(zoneArea(doc, el)) / 1e4) / 100 };
    if (m?.sigma10) ps.Sigma10_kPa = m.sigma10; if (m?.sigmaC) ps.SigmaC_kPa = m.sigmaC; if (m?.fcd) ps.fcd_kPa = m.fcd;
    if (el.mark) ps.Zone = el.mark;
    return { entity: 'IfcCovering', predefined: 'INSULATION', name: zoneTag(doc, el), psets: { CH_Daemmzone: ps } };
  },
  scheduleFields: () => [
    { key: 'product', label: 'Produkt', get: (el, doc) => zoneType(doc, el)?.product ?? zoneType(doc, el)?.name ?? '' },
    { key: 'area', label: 'Fläche', unit: 'area', get: (el, doc) => multiArea(zoneArea(doc, el)) },
    { key: 'thick', label: 'Dicke', unit: 'len', get: (el, doc) => zoneThick(doc, el) },
    { key: 'volume', label: 'Volumen', unit: 'vol', get: (el, doc) => multiArea(zoneArea(doc, el)) * zoneThick(doc, el) },
    { key: 'sigmaC', label: 'σc [kPa]', unit: 'num', get: (el, doc) => zoneMat(doc, el)?.sigmaC ?? '' },
    { key: 'fcd', label: 'f_cd [kPa]', unit: 'num', get: (el, doc) => zoneMat(doc, el)?.fcd ?? '' },
    { key: 'eta', label: 'Ausnutzung η', unit: 'num', get: (el, doc) => { const r = zoneCheck(doc, el); return r && !r.missing ? Math.round(r.eta * 100) / 100 : r?.missing ? 'Kennwerte fehlen' : ''; } },
  ],
});

// ------------------------------------------------------------ Pressungen (Datei) – Überlagerung
/** Punktwerte [x, y, σ_qs, σ_d?] in mm/kPa; oder Raster */
export interface PressureGrid { x0: number; y0: number; dx: number; dy: number; nx: number; ny: number; v: number[]; vd?: number[] }
export interface PressureMap extends El { cat: 'pressureMap'; levelId: Id; z?: number; pts?: number[][]; grid?: PressureGrid; label?: string; values?: boolean }

/** CSV («x;y;σ[;σd]», Kopfzeile erlaubt, Koordinaten in m oder mm) oder JSON ([{x,y,v,vd}] bzw. {points}|{grid}) lesen */
export function parsePressure(text: string, unit: 'auto' | 'm' | 'mm' = 'auto'): { pts?: number[][]; grid?: PressureGrid } {
  const t = text.trim();
  const scaleOf = (xs: number[]) => (unit === 'm' ? 1000 : unit === 'mm' ? 1 : Math.max(...xs.map(Math.abs), 0) < 500 ? 1000 : 1);
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    const g = j.grid ?? (j.nx && j.ny ? j : null);
    if (g) {
      const flat = (a: any) => (Array.isArray(a?.[0]) ? (a as number[][]).flat() : (a as number[]));
      const k = scaleOf([g.x0, g.y0, g.x0 + g.dx * g.nx, g.y0 + g.dy * g.ny]);
      return { grid: { x0: g.x0 * k, y0: g.y0 * k, dx: g.dx * k, dy: g.dy * k, nx: g.nx, ny: g.ny, v: flat(g.values ?? g.v), vd: g.vd || g.values_d ? flat(g.vd ?? g.values_d) : undefined } };
    }
    const arr: any[] = Array.isArray(j) ? j : j.points ?? j.pts ?? [];
    const raw = arr.map((p) => (Array.isArray(p) ? p.map(Number) : [Number(p.x), Number(p.y), Number(p.v ?? p.sigma ?? p.s ?? p.qs), p.vd ?? p.sigma_d ?? p.d]).filter((x) => x !== undefined).map(Number)).filter((p) => p.length >= 3 && p.slice(0, 3).every(isFinite));
    const k = scaleOf(raw.flatMap((p) => [p[0], p[1]]));
    return { pts: raw.map((p) => [p[0] * k, p[1] * k, ...p.slice(2)]) };
  }
  const rows = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const sep = rows.some((l) => l.includes(';')) ? ';' : rows.some((l) => l.includes('\t')) ? '\t' : ',';
  const raw = rows.map((l) => l.split(sep).map((x) => parseFloat(x.trim().replace(sep === ';' ? ',' : '\u0000', '.')))).filter((p) => p.length >= 3 && p.slice(0, 3).every(isFinite));
  const k = scaleOf(raw.flatMap((p) => [p[0], p[1]]));
  return { pts: raw.map((p) => [p[0] * k, p[1] * k, ...p.slice(2).filter(isFinite)]) };
}

/** Alle Pressungswerte als Punkte [x, y, σ_qs, σ_d?] */
export function pressurePoints(m: El): number[][] {
  if (m.pts) return m.pts as number[][];
  const g = m.grid as PressureGrid | undefined; if (!g) return [];
  const out: number[][] = [];
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i; const v = g.v[k]; if (!isFinite(v)) continue;
    out.push([g.x0 + (i + 0.5) * g.dx, g.y0 + (j + 0.5) * g.dy, v, ...(g.vd && isFinite(g.vd[k]) ? [g.vd[k]] : [])]);
  }
  return out;
}

/** Nachweis je Zone: grösste Pressung (quasi-ständig / Bemessung) und Ausnutzung η = max(σ_qs/σc, σ_d/f_cd) */
export function zoneCheck(doc: Doc, zone: El): { qs: number; d: number; eta: number; missing?: string[] } | null {
  return cached(doc, 'insulCheck', zone.id, () => {
    const maps = doc.all('pressureMap'); if (!maps.length) return null;
    const area = zoneArea(doc, zone); const m = zoneMat(doc, zone);
    let qs = -Infinity, d = -Infinity;
    for (const pm of maps) for (const p of pressurePoints(pm)) {
      const q = { x: p[0], y: p[1] };
      if (!area.some((poly) => pointInPoly(q, poly)) || zoneAt(doc, q)?.id !== zone.id) continue;
      qs = Math.max(qs, p[2]); if (p.length > 3) d = Math.max(d, p[3]);
    }
    if (!isFinite(qs)) return null;
    // fehlende Kennwerte nicht still als η = 0 werten (z.B. Material mit Vorlagen-ID im Skript neu angelegt)
    const missing: string[] = [];
    const sc = m?.sigmaC ?? 0, fcd = m?.fcd ?? 0;
    if (!(sc > 0)) missing.push('σc');
    if (isFinite(d) && !(fcd > 0)) missing.push('f_cd');
    if (missing.length) console.warn(`Dämmzone ${zone.mark || zone.id}: Material ${m?.id ?? '?'} ohne Kennwerte ${missing.join(', ')} – kein Nachweis`);
    const eta = missing.length ? NaN : Math.max(qs / sc, isFinite(d) ? d / fcd : 0);
    return { qs, d: isFinite(d) ? d : NaN, eta, missing: missing.length ? missing : undefined };
  });
}
/** Zone unter einem Punkt (bei Überlappung: kleinste Fläche, z.B. F1 vor Randstreifen) */
export function zoneAt(doc: Doc, p: V2): El | null {
  let best: El | null = null; let ba = Infinity;
  for (const z of doc.all('insulZone')) {
    const a = zoneArea(doc, z); if (!a.some((poly) => pointInPoly(p, poly))) continue;
    const ar = multiArea(a); if (ar < ba) { ba = ar; best = z; }
  }
  return best;
}
/** Farbe nach Ausnutzung */
export const etaColor = (eta: number): string => (eta < 0.6 ? '#2e9e44' : eta < 0.8 ? '#9ccc3c' : eta < 0.9 ? '#f2b630' : eta <= 1 ? '#f07a20' : '#d01c1c');

function drawPressure(ctx: PlanCtx, el: El): void {
  const { doc, dl } = ctx; const s = dl.scale;
  // Höhe der Pressungsebene (Unterkante Platte); sichtbar, wenn sie im Ansichtsbereich liegt
  const z = levelElev(doc, el.levelId) + (el.z ?? 0);
  if (ctx.ceiling || z > ctx.cutZ + 1 || z < ctx.depthZ - 50) return;
  const pts = pressurePoints(el); if (!pts.length) return;
  const vmax = Math.max(...pts.map((p) => p[2]));
  const g = el.grid as PressureGrid | undefined;
  const ratio = (p: number[]) => {
    const zn = zoneAt(doc, { x: p[0], y: p[1] }); const m = zn ? zoneMat(doc, zn) : undefined;
    const r = Math.max(m?.sigmaC ? p[2] / m.sigmaC : 0, m?.fcd && p.length > 3 ? p[3] / m.fcd : 0);
    return r || p[2] / (vmax || 1);
  };
  // Punktdichte: mittlerer Abstand → Symbolgrösse, Werte nur bei genügend Platz (Papier-mm)
  const bb = bboxOf(pts.map((q) => ({ x: q[0], y: q[1] })));
  const spacing = Math.sqrt(Math.max(1, (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y)) / pts.length);
  const showVal = el.values !== false && spacing / s >= 9;
  const rDot = Math.min(0.9 * s, 0.28 * spacing);
  let imax = 0; pts.forEach((p, i) => { if (p[2] > pts[imax][2]) imax = i; });
  pts.forEach((p, i) => {
    const c = { x: p[0], y: p[1] }; const col = etaColor(ratio(p));
    if (g) {
      // Raster: kleines Farbquadrat je Zelle (Zeichnung bleibt lesbar), Wert daneben bei genügend Platz
      const h = Math.min(Math.min(g.dx, g.dy) * 0.18, 1.2 * s);
      dl.fill([[{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h }]], { color: col }, { w: 1, color: '#505050' }, { ns: true });
      if (showVal && Math.min(g.dx, g.dy) / s >= 8) dl.text({ x: c.x, y: c.y - h - 0.4 * s }, kpa(p[2]), { size: 1.5, ha: 'center', va: 'top', color: '#1d1d1d' });
    } else {
      dl.circle(c, rDot, rDot > 0.4 * s ? { w: 1, color: '#303030' } : undefined, { color: col }, { ns: true });
      if (showVal) dl.text({ x: c.x + rDot + 0.4 * s, y: c.y }, kpa(p[2]) + (p.length > 3 ? ' / ' + kpa(p[3]) : ''), { size: 1.6, va: 'middle', color: '#1d1d1d', opaque: true });
    }
    if (i === imax) {
      dl.circle(c, Math.max(rDot, 0.6 * s) * 1.6, { w: 3, color: '#d01c1c' }, undefined, { ns: true });
      dl.text({ x: c.x, y: c.y + 2.5 * s }, `max ${kpa(p[2])}${p.length > 3 ? ' / ' + kpa(p[3]) : ''} kPa`, { size: 2, bold: true, ha: 'center', color: '#d01c1c', opaque: true });
    }
  });
}

registerCategory({
  cat: 'pressureMap', label: 'Pressungen (Datei)', plural: 'Pressungen', planOrder: 95,
  drawPlan: drawPressure,
  center: (el) => { const p = pressurePoints(el); if (!p.length) return null; const b = bboxOf(p.map((q) => ({ x: q[0], y: q[1] }))); return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }; },
  props: () => [
    { key: 'label', label: 'Bezeichnung', group: GROUPS.identity, type: 'text', get: (e) => e.label ?? '', set: (_e, v) => ({ label: v }) },
    { key: 'levelId', label: 'Ebene', group: GROUPS.constraints, type: 'select', options: levelOptions, get: (e) => e.levelId, set: (_e, v) => ({ levelId: v }) },
    { key: 'values', label: 'Werte anzeigen', group: GROUPS.graphics, type: 'bool', get: (e) => e.values !== false, set: (_e, v) => ({ values: !!v }) },
    { key: 'n', label: 'Anzahl Werte', group: GROUPS.dims, type: 'readonly', get: (e) => String(pressurePoints(e).length) },
    { key: 'max', label: 'Maximum [kPa]', group: GROUPS.dims, type: 'readonly', get: (e) => kpa(Math.max(...pressurePoints(e).map((p) => p[2]))) },
  ],
});

/** Pressungsdatei als Element anlegen (in Transaktion) */
export function addPressureMap(doc: Doc, text: string, levelId: Id, label = 'Pressungen', unit: 'auto' | 'm' | 'mm' = 'auto'): El {
  const r = parsePressure(text, unit);
  const el = { id: newId('pm'), cat: 'pressureMap', levelId, label, ...r } as El;
  // Höhe: Unterkante der tiefsten Platte unter den Werten (sonst Ebene)
  const pts = pressurePoints(el); const L = levelElev(doc, levelId);
  if (pts.length) {
    const b = bboxOf(pts.map((q) => ({ x: q[0], y: q[1] }))); const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    const sl = slabAt(doc, c, L - 1e5, (s) => s.el.cat === 'foundationSlab' || Math.abs(s.top - L) < 600);
    el.z = (sl ? sl.bot : L) - L;
  }
  return doc.add(el);
}

// ------------------------------------------------------------ Legende (Beschriftung, dynamisch)
export interface InsulLegend extends El { cat: 'insulLegend'; viewId: Id; p: V2; title?: string; check?: boolean }
function drawLegend(dl: DisplayList, el: El, doc: Doc, _view: View): void {
  const s = dl.scale; const p = el.p as V2; const col = '#000000';
  const zones = doc.all('insulZone');
  const used = new Set(zones.map((z) => z.typeId));
  const types = typesOf<InsulType>(doc, 'insulZone').filter((t) => !zones.length || used.has(t.id));
  let y = p.y;
  dl.text({ x: p.x, y }, el.title ?? 'Legende Dämmzonen', { size: 3, bold: true, color: col, va: 'top' });
  y -= 6 * s;
  for (const t of types) {
    const c = t.color ?? '#b9d7f2';
    dl.fill([[{ x: p.x, y }, { x: p.x + 8 * s, y }, { x: p.x + 8 * s, y: y - 4 * s }, { x: p.x, y: y - 4 * s }]], { color: c }, { w: 1, color: '#303030' });
    dl.text({ x: p.x + 11 * s, y: y - 2 * s }, productText(doc, t), { size: 2.2, va: 'middle', color: col });
    y -= 6 * s;
  }
  // Nachweis je Zone (wenn Pressungen geladen)
  if (el.check === false || !doc.all('pressureMap').length) return;
  y -= 3 * s;
  dl.text({ x: p.x, y }, 'Pressung auf Dämmung', { size: 2.5, bold: true, color: col, va: 'top' });
  y -= 5 * s;
  const cols = [0, 18, 52, 80, 108]; const head = ['Zone', 'Dämmung', 'σ_qs / σc [kPa]', 'σ_d / f_cd [kPa]', 'η max'];
  const row = (cells: string[], bold = false) => { cells.forEach((c, i) => dl.text({ x: p.x + cols[i] * s, y }, c, { size: 2, bold, va: 'top', color: col })); y -= 3.6 * s; };
  row(head, true);
  dl.line({ x: p.x, y: y + 0.6 * s }, { x: p.x + 122 * s, y: y + 0.6 * s }, { w: 1, color: col });
  for (const z of zones) {
    const r = zoneCheck(doc, z); const m = zoneMat(doc, z); const t = zoneType(doc, z);
    row([z.mark || z.comments || z.id, t?.product ?? t?.name ?? '', `${r ? kpa(r.qs) : '–'} / ${kpa(m?.sigmaC)}`, `${r && isFinite(r.d) ? kpa(r.d) : '–'} / ${kpa(m?.fcd)}`, !r ? '–' : r.missing ? 'Kennwerte fehlen' : r.eta.toFixed(2)]);
  }
}
registerCategory({
  cat: 'insulLegend', label: 'Legende Dämmzonen', plural: 'Legenden Dämmzonen', annotation: true,
  drawAnnotation: drawLegend,
  transform: (el, m) => ({ p: { x: m.a * el.p.x + m.c * el.p.y + m.e, y: m.b * el.p.x + m.d * el.p.y + m.f } }),
  grips: (el) => [{ id: 'p', p: el.p, kind: 'end', tip: 'Legende verschieben' }],
  dragGrip: (_el, _id, p) => ({ p }),
  props: () => [
    { key: 'title', label: 'Titel', group: GROUPS.text, type: 'text', get: (e) => e.title ?? 'Legende Dämmzonen', set: (_e, v) => ({ title: v }) },
    { key: 'check', label: 'Pressungsnachweis zeigen', group: GROUPS.text, type: 'bool', get: (e) => e.check !== false, set: (_e, v) => ({ check: !!v }) },
  ],
});

// ------------------------------------------------------------ Vorlage
export function insulTemplate(): El[] {
  const M = (id: string, name: string, color: string, s10: number, sc: number, fcd: number, E: number): El =>
    ({ id, cat: 'material', name, color, cutPattern: 'insulation', cutColor: '#1d4f91', density: 35, sigma10: s10, sigmaC: sc, fcd, Ecomp: E } as El);
  const T = (id: string, name: string, mat: string, color: string): El => ({ id, cat: 'type', of: 'insulZone', name, product: name, mat, t: 160, plies: 2, color } as El);
  return [
    M('m_xps300', 'XPS 300 druckfest', '#c4e0fa', 300, 130, 185, 15000),
    M('m_xps500', 'XPS 500 druckfest', '#8fbbe8', 500, 180, 250, 20000),
    M('m_xps700', 'XPS 700 druckfest', '#5f97d6', 700, 250, 350, 25000),
    T('izt_xps300', 'XPS 300', 'm_xps300', '#c4e0fa'),
    T('izt_xps500', 'XPS 500', 'm_xps500', '#8fbbe8'),
    T('izt_xps700', 'XPS 700', 'm_xps700', '#5f97d6'),
  ];
}
export function addInsulTemplate(doc: Doc): void {
  // bestehende Materialien (z.B. aus älteren Projekten) bekommen fehlende Kennwerte nicht überschrieben
  for (const e of insulTemplate()) {
    const cur = doc.get(e.id);
    if (!cur) doc.add(e);
    else if (e.cat === 'material' && cur.sigmaC === undefined) doc.update(e.id, { sigma10: e.sigma10, sigmaC: e.sigmaC, fcd: e.fcd, Ecomp: e.Ecomp });
  }
}
export { addMissing, polyArea };
export type { Poly };
