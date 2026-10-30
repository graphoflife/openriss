// Bewehrungslisten – Datenebene (DOM-frei, für Skripte/CLI): SSHV-Figur je Bewehrungssatz, Positionen der
// Eisenliste je Bewehrungsplan (gleiche Form/Ø/Masse im selben Plan = eine Position), Zusammenfassung je Ø
// (Fix-/Lagerlängen und bearbeitet), ABS-Export (BVBS 3.1), CSV, Positionsnummern je Plan, Bauteillisten-Vorlagen.
import type { Doc, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import type { V2 } from '../../core/geom';
import { View, projectInfo } from '../../core/view';
import { cached } from '../../core/cache';
import { Rebar, Coupler, rebarGeo, hostLabel } from './rebar/rebar';
import { AreaRebar, areaGeo } from './rebar/area';
import { Figure, Roll, figureOf, checkFigure, kgNom, figurePolyline, figureText } from './rebar/sshv';
import { rebarNorm, rebarMandrel, planOf, inPlan, rebarPlans } from './rebar/norm';
import { BvbsRecord, bvbsFile, bvbsField } from './rebar/bvbs';

// ------------------------------------------------------------ Figur je Bewehrungssatz
/** SSHV-Figur (Formnummer, Aussenmasse, Biegewinkel) eines Bewehrungssatzes */
export function rebarFigure(doc: Doc, el: Rebar): Figure {
  const calc = () => figureOf(rebarGeo(doc, el).full, el.dia, rebarMandrel(doc, el), { nr: el.form, d1: el.bendRoll === 'd1' });
  return el.id.startsWith('__') ? calc() : cached(doc, 'rebarFigure', el.id, calc);
}
/** Prüfung nach Figurenliste (Mindestschenkel, Überlänge) */
export const rebarChecks = (doc: Doc, el: Rebar): string[] => checkFigure(rebarFigure(doc, el), el.dia, el.bendRoll ?? 'd3');
/** Schenkel auf mm gerundet */
const mmLegs = (f: Figure) => f.legs.map((l) => Math.round(l));
/** Länge eines Stabes für Listen/ABS: SIA = abgewickelte Länge (Σ Aussenmasse, SSHV 4.2.1), DIN = Achslänge */
export function barLength(doc: Doc, el: Rebar): number {
  return rebarNorm(doc) === 'SIA' ? mmLegs(rebarFigure(doc, el)).reduce((s, l) => s + l, 0) : Math.round(rebarGeo(doc, el).len);
}
/** Skizzenwert für Bauteillisten (Text + Polylinie mit Schenkelmassen in cm) */
export function figureSketch(f: Figure): { text: string; sketch: { pts: V2[]; labels: (string | null)[] } } {
  const pts = figurePolyline(f.legs, f.angles);
  const labels: (string | null)[] = [];
  let k = 0;
  f.legs.forEach((l, i) => { labels[k++] = String(Math.round(l / 10)); if (Math.abs(f.angles[i] ?? 0) >= 170) labels[k++] = null; });
  return { text: (f.nr ? 'Form ' : '') + figureText(f), sketch: { pts, labels } };
}

// ------------------------------------------------------------ Positionen (Eisenliste)
export interface EisenRow {
  plan: string; pos: number; n: number; dia: number;
  fig: Figure;
  /** Schenkel (Aussenmasse) mm, gerundet */
  legs: number[];
  /** Länge je Stab mm (SIA: abgewickelt; DIN: Achslänge) */
  len: number;
  total: number;
  kgEach: number; kg: number;
  mandrel: number; roll: Roll;
  coupler?: Coupler;
  /** Spezialbewehrung (Schraubbewehrung, SSHV-RL 4.2.3) */
  special: boolean;
  /** Fix-/Lagerlänge (Form 1) */
  fix: boolean;
  remarks: string[]; hosts: string[]; ids: Id[]; warn: string[];
}
const kgOf = (len: number, d: number) => (len / 1000) * kgNom(d);
const uniqPush = (a: string[], s: string | undefined) => { if (s && !a.includes(s)) a.push(s); };
export const couplerText = (c?: Coupler) => [c?.start && `Anfang ${c.start.sys} ${c.start.type}`, c?.end && `Ende ${c.end.sys} ${c.end.type}`].filter(Boolean).join(', ');
/** Bauteilbezeichnung (Kennzeichen/ID des Hosts) */
export function hostName(doc: Doc, id: Id | undefined): string {
  const h = doc.get(id); if (!h) return '';
  return h.mark || (/[A-Z-]/.test(h.id) ? h.id : hostLabel(doc, id)); // erzeugte IDs sind klein geschrieben
}

/**
 * Positionen der Eisenliste (plan angegeben: nur dieser Bewehrungsplan). Bewehrungssätze mit gleicher Position,
 * Form, Ø und Massen werden zusammengefasst; Flächenbewehrung je Lage und Stablänge. Sortiert nach Plan/Pos/Ø.
 */
export function eisenRows(doc: Doc, plan?: string, ids?: Set<Id>): EisenRow[] {
  const groups = new Map<string, EisenRow>();
  const posKey = new Map<string, string>();
  const sel = (e: { id: Id; hostId?: Id }) => !ids || ids.has(e.id) || (!!e.hostId && ids.has(e.hostId));
  for (const r of doc.all<Rebar>('rebar')) {
    if (!inPlan(r, plan) || !sel(r)) continue;
    const g = rebarGeo(doc, r); if (!g.n) continue;
    const f = rebarFigure(doc, r); const legs = mmLegs(f);
    const len = barLength(doc, r); const p = planOf(r);
    const key = [p, r.pos, r.dia, f.nr, legs.join('/'), f.angles.map((a) => Math.round(a)).join('/'), r.bendRoll ?? '', JSON.stringify(r.coupler ?? null)].join('|');
    let row = groups.get(key);
    if (!row) {
      const roll = r.bendRoll ?? 'd3', mandrel = rebarMandrel(doc, r);
      row = { plan: p, pos: r.pos ?? 0, n: 0, dia: r.dia, fig: f, legs, len, total: 0, kgEach: kgOf(len, r.dia), kg: 0, mandrel, roll, coupler: r.coupler,
        special: !!(r.coupler?.start || r.coupler?.end), fix: f.nr === '1', remarks: [], hosts: [], ids: [], warn: checkFigure(f, r.dia, roll) };
      groups.set(key, row);
      const pk = p + '|' + row.pos;
      if (posKey.has(pk) && posKey.get(pk) !== key) {
        row.warn.push('Positionsnummer mehrfach mit unterschiedlicher Form');
        for (const o of groups.values()) if (o !== row && o.plan === p && o.pos === row.pos) uniqPush(o.warn, 'Positionsnummer mehrfach mit unterschiedlicher Form');
      } else posKey.set(pk, key);
    }
    row.n += g.n; row.ids.push(r.id);
    if (r.comments && r.comments.trim() !== p) uniqPush(row.remarks, r.comments.trim());
    uniqPush(row.remarks, r.mark);
    uniqPush(row.hosts, hostName(doc, r.hostId));
  }
  for (const a of doc.all<AreaRebar>('areaRebar')) {
    if (!inPlan(a, plan) || !sel(a)) continue;
    const p = planOf(a);
    for (const l of areaGeo(doc, a).layers) {
      if (!l.n) continue;
      const byLen = new Map<number, number>();
      for (const s of l.segs) { const L = Math.round(Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y)); byLen.set(L, (byLen.get(L) ?? 0) + 1); }
      for (const [L, n] of byLen) {
        const key = `${p}|${l.pos}|${l.dia}|area|${L}`;
        let row = groups.get(key);
        if (!row) {
          const fig: Figure = { nr: '1', name: 'Gerader Stab (Fix-/Lagerlänge)', grade: 'Fix', legs: [L], angles: [], planar: true };
          row = { plan: p, pos: l.pos ?? 0, n: 0, dia: l.dia, fig, legs: [L], len: L, total: 0, kgEach: kgOf(L, l.dia), kg: 0, mandrel: rebarMandrel(doc, { dia: l.dia }), roll: 'd3',
            special: false, fix: true, remarks: [], hosts: [], ids: [], warn: checkFigure(fig, l.dia) };
          groups.set(key, row);
        }
        row.n += n; row.ids.push(a.id);
        uniqPush(row.remarks, `Flächenbewehrung ${l.label}`);
        uniqPush(row.hosts, hostName(doc, a.hostId));
      }
    }
  }
  const rows = [...groups.values()];
  for (const r of rows) {
    r.total = r.n * r.len; r.kg = kgOf(r.total, r.dia);
    if (r.special) uniqPush(r.remarks, 'Muffe: ' + couplerText(r.coupler));
    if (!r.fix) uniqPush(r.remarks, r.roll === 'd1' ? `Biegerolle d1 = ${r.mandrel} mm` : `d3 = ${r.mandrel} mm`);
  }
  return rows.sort((a, b) => a.plan.localeCompare(b.plan, 'de', { numeric: true }) || a.pos - b.pos || a.dia - b.dia || b.len - a.len);
}

export interface EisenSum { dia: number; kgm: number; fixLen: number; fixKg: number; bLen: number; bKg: number }
/** Zusammenfassung je Ø (Fix-/Lagerlängen und bearbeitet; Längen mm, Gewichte kg) – ohne Spezialbewehrung */
export function eisenSummary(rows: EisenRow[]): { perDia: EisenSum[]; fixLen: number; fixKg: number; bLen: number; bKg: number; kg: number; count: number; special: { count: number; kg: number } } {
  const m = new Map<number, EisenSum>();
  const normal = rows.filter((r) => !r.special), spec = rows.filter((r) => r.special);
  for (const r of normal) {
    const e = m.get(r.dia) ?? { dia: r.dia, kgm: kgNom(r.dia), fixLen: 0, fixKg: 0, bLen: 0, bKg: 0 };
    if (r.fix) { e.fixLen += r.total; e.fixKg += r.kg; } else { e.bLen += r.total; e.bKg += r.kg; }
    m.set(r.dia, e);
  }
  const perDia = [...m.values()].sort((a, b) => a.dia - b.dia);
  const S = (k: keyof EisenSum) => perDia.reduce((s, x) => s + (x[k] as number), 0);
  const positions = new Set(normal.map((r) => r.plan + '|' + r.pos));
  return { perDia, fixLen: S('fixLen'), fixKg: S('fixKg'), bLen: S('bLen'), bKg: S('bKg'), kg: S('fixKg') + S('bKg'), count: positions.size,
    special: { count: new Set(spec.map((r) => r.plan + '|' + r.pos)).size, kg: spec.reduce((s, r) => s + r.kg, 0) } };
}

// ------------------------------------------------------------ ABS (BVBS 3.1)
/** Planindex: Index des Plans mit dieser Plannummer (sonst '0') */
export function planIndex(doc: Doc, plan: string): string {
  const sh = doc.all<View>('view').find((v) => v.kind === 'sheet' && v.sheetNo === plan);
  const i = sh?.data?.index;
  return i !== undefined && i !== null && String(i).trim() !== '' ? String(i) : '0';
}
/** BVBS-Datensätze eines Bewehrungsplans */
export function absRecords(doc: Doc, plan: string): BvbsRecord[] {
  const pi = projectInfo(doc); const index = planIndex(doc, plan);
  return eisenRows(doc, plan).map((r) => ({
    project: pi?.number || pi?.name || '', plan, index, pos: r.pos, len: r.len, n: r.n, kgEach: r.kgEach, dia: r.dia, steel: 'B500B',
    mandrel: r.mandrel, legs: r.legs, angles: r.fig.angles, coupler: r.coupler,
  }));
}
/** ABS-Datei (BVBS 3.1, BF2D) eines Bewehrungsplans, Zeilen mit CRLF */
export const absExport = (doc: Doc, plan: string): string => bvbsFile(absRecords(doc, plan));
/** ABS-Dateien aller Bewehrungspläne: { name: 'T-205.abs', plan, text } */
export function absFiles(doc: Doc): { name: string; plan: string; text: string }[] {
  return rebarPlans(doc).map((p) => ({ name: (bvbsField(p || 'ohne_Plan').replace(/[^\w.-]+/g, '_')) + '.abs', plan: p, text: absExport(doc, p) })).filter((f) => f.text);
}

// ------------------------------------------------------------ CSV
const f2 = (v: number, d: number) => v.toFixed(d);
const q = (s: string) => (/[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
/** Eisenliste als CSV (Semikolon, Dezimalpunkt; Spalten wie SSHV-Eisenliste) */
export function eisenlisteCsv(doc: Doc, plan?: string): string {
  const L = ['Plan;Pos;Anzahl;Durchmesser_mm;Form;Schenkel_cm;Winkel_grad;L_m;Total_m;Gewicht_kg;Bauteil;Spezial;Bemerkung'];
  for (const r of eisenRows(doc, plan)) {
    L.push([q(r.plan), r.pos, r.n, r.dia, r.fig.nr, r.legs.map((l) => Math.round(l / 10)).join('/'), r.fig.angles.map((a) => String(Math.round(a * 10) / 10)).join('/'),
      f2(r.len / 1000, 2), f2(r.total / 1000, 2), f2(r.kg, 1), q(r.hosts.join(', ')), r.special ? 'Schraubbewehrung' : '', q(r.remarks.join('; '))].join(';'));
  }
  return L.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------ Positionsnummern je Plan
/**
 * Positionsnummern neu vergeben, je Bewehrungsplan ab 1 (plan angegeben: nur dieser Plan).
 * merge: gleiche Stäbe (Form, Ø, Masse) im selben Plan erhalten dieselbe Nummer. Liefert Anzahl Positionen.
 */
export function renumberPlans(doc: Doc, merge = true, plan?: string): number {
  const plans = plan === undefined ? rebarPlans(doc) : [plan];
  let total = 0;
  doc.transaction('Positionen neu nummerieren', () => {
    for (const p of plans) {
      const rebars = doc.all<Rebar>('rebar').filter((r) => planOf(r) === p).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id.localeCompare(b.id));
      const map = new Map<string, number>(); let next = 0;
      for (const r of rebars) {
        const key = merge ? rebarGeo(doc, r).sig : r.pos + '|' + rebarGeo(doc, r).sig;
        let n = map.get(key);
        if (n === undefined) { n = ++next; map.set(key, n); }
        if (r.pos !== n) doc.update(r.id, { pos: n });
      }
      for (const a of doc.all<AreaRebar>('areaRebar').filter((x) => planOf(x) === p)) {
        doc.update(a.id, { layers: a.layers.map((l) => (l.on ? { ...l, pos: ++next } : l)) });
      }
      total += next;
    }
  });
  return total;
}

// ------------------------------------------------------------ Bauteillisten-Vorlagen
const uniqueName = (doc: Doc, base: string) => { const names = new Set(doc.all<View>('view').map((v) => v.name)); let n = base, i = 2; while (names.has(n)) n = `${base} (${i++})`; return n; };
/** Definition der Vorlage «Stahlliste je Plan» (Bauteilliste Tragwerksbewehrung, je Position gruppiert, mit Formskizze) */
export function rebarScheduleDef(doc: Doc, plan?: string): Record<string, any> {
  const sia = rebarNorm(doc) === 'SIA';
  const [len, tot, kg] = sia ? ['devLen', 'devTotal', 'nomWeight'] : ['barLen', 'totalLen', 'weight'];
  return {
    cat: 'rebar', template: 'stahlliste',
    fields: ['pos', 'dia', 'formSketch', 'count', len, tot, kg, 'remarks'],
    sort: [{ key: 'pos' }, { key: 'dia' }, { key: 'sshvForm' }, { key: len }],
    totals: true, itemize: false, filters: plan ? [{ key: 'plan', op: 'eq', value: plan }] : [], sums: ['count', tot, kg],
    labels: { pos: 'Pos.', dia: 'Ø', formSketch: sia ? 'Form (Aussenmasse in cm)' : 'Biegeform (cm)', count: 'Anzahl', [len]: sia ? 'L' : 'Einzellänge', [tot]: sia ? 'Tot.' : 'Gesamtlänge', [kg]: 'Gewicht', remarks: 'Bemerkungen' },
  };
}
/** Bauteilliste «Stahlliste je Plan» anlegen (in Transaktion); liefert die Ansicht */
export function createRebarSchedule(doc: Doc, plan?: string): View {
  const v = { id: newId('sc'), cat: 'view', kind: 'schedule', name: uniqueName(doc, `Stahlliste ${plan || 'Projekt'}`), scale: 1, detail: 'medium', data: rebarScheduleDef(doc, plan) } as View;
  doc.transaction('Stahlliste je Plan', () => doc.add(v));
  return v;
}
/** Eisenliste nach SSHV als platzierbare Liste (Bauteilliste data.kind 'eisenliste'); part: Normal-/Spezialliste/alle */
export function createEisenliste(doc: Doc, plan?: string, part: 'all' | 'normal' | 'special' = 'all'): View {
  const v = { id: newId('sc'), cat: 'view', kind: 'schedule', name: uniqueName(doc, `Eisenliste ${plan || (plan === '' ? 'ohne Plan' : 'Projekt')}${part === 'special' ? ' Spezialbewehrung' : ''}`), scale: 1, detail: 'medium',
    data: { kind: 'eisenliste', plan, part, summary: part !== 'special' } } as View;
  doc.transaction('Eisenliste', () => doc.add(v));
  return v;
}
