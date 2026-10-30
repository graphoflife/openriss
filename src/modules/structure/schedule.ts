// Stahlliste / Biegeliste: je Position Anzahl, Ø, Biegeform (Skizze mit Schenkellängen in cm),
// Einzel-/Gesamtlänge, Gewicht; Summen je Durchmesser; Mattenliste. Je Bewehrungsplan filterbar, wahlweise als
// Eisenliste nach SSHV (CH). CSV-, ABS-Export, Druck, Vorlagen «Stahlliste je Plan» / «Eisenliste» als Bauteilliste.
import { app } from '../../app';
import type { Doc, Id } from '../../core/doc';
import { V2, V3, sub3, dot3, cross3, norm3, len3 } from '../../core/geom';
import { projectInfo } from '../../core/view';
import { modal } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { fmtNum } from '../../core/units';
import { Rebar, rebarGeo, SHAPE_NAMES, hostLabel } from './rebar/rebar';
import { kgPerM } from './rebar/math';
import { AreaRebar, FabricArea, areaRows, fabricRows } from './rebar/area';
import { planOf, inPlan, rebarPlans, isSia } from './rebar/norm';
import { rebarFigure, renumberPlans, eisenlisteCsv, absExport, absFiles, createRebarSchedule, createEisenliste } from './steel';
import { eisenlisteHtml, eisenlisteDocument, EISEN_CSS } from './eisenliste';

export { eisenlisteCsv };
export interface SteelRow { plan: string; pos: number; n: number; dia: number; code: string; form: string; full: V3[]; legs: number[]; len: number | null; lenText: string; total: number; kg: number; hosts: string[]; ids: Id[]; warn?: boolean }

const n2 = (v: number) => fmtNum(v, 2);
const cmI = (mm: number) => String(Math.round(mm / 10));

/** Zeilen der Stahlliste (getrennt je Bewehrungsplan) */
export function steelRows(doc: Doc, rebars: Rebar[], areas: AreaRebar[], merge: boolean): SteelRow[] {
  const groups = new Map<string, SteelRow>();
  const posSig = new Map<string, string>();
  for (const r of rebars) {
    const g = rebarGeo(doc, r); const plan = planOf(r);
    const key = plan + '|' + (merge ? g.sig : r.pos + '|' + g.sig);
    let row = groups.get(key);
    if (!row) {
      row = { plan, pos: r.pos, n: 0, dia: r.dia, code: g.code, form: rebarFigure(doc, r).nr, full: g.full, legs: g.legs, len: g.len, lenText: n2(g.len / 1000), total: 0, kg: 0, hosts: [], ids: [] };
      groups.set(key, row);
    }
    row.pos = Math.min(row.pos, r.pos);
    row.n += g.n; row.total += g.len * g.n; row.kg += (g.len * g.n / 1000) * kgPerM(r.dia); row.ids.push(r.id);
    const hl = hostLabel(doc, r.hostId); if (!row.hosts.includes(hl)) row.hosts.push(hl);
    const pk = plan + '|' + r.pos; const ps = posSig.get(pk);
    if (ps && ps !== g.sig) row.warn = true; else posSig.set(pk, g.sig);
  }
  const rows = [...groups.values()];
  for (const a of areaRows(doc, areas)) {
    const lmin = Math.min(...a.lens), lmax = Math.max(...a.lens);
    const same = lmax - lmin < 10;
    rows.push({ plan: planOf(doc.get(a.elId)), pos: a.pos, n: a.n, dia: a.dia, code: '00', form: '1', full: [{ x: 0, y: 0, z: 0 }, { x: lmax, y: 0, z: 0 }], legs: [lmax], len: same ? lmax : null,
      lenText: same ? n2(lmax / 1000) : `${n2(lmin / 1000)}…${n2(lmax / 1000)}`, total: a.total, kg: a.kg, hosts: [hostLabel(doc, a.hostId) + ' – ' + a.label], ids: [] });
  }
  return rows.sort((a, b) => a.plan.localeCompare(b.plan, 'de', { numeric: true }) || a.pos - b.pos || a.dia - b.dia);
}
/** Zeilen und Matten eines Plans (plan undefined = alle) */
export function steelData(doc: Doc, plan?: string, merge = true, sel?: (e: { id: Id; hostId?: Id }) => boolean) {
  const ok = (e: any) => inPlan(e, plan) && (!sel || sel(e));
  return {
    rows: steelRows(doc, doc.all<Rebar>('rebar').filter(ok), doc.all<AreaRebar>('areaRebar').filter(ok), merge),
    mats: fabricRows(doc, doc.all<FabricArea>('fabricArea').filter(ok)),
  };
}

// ------------------------------------------------------------ Biegeform-Skizze
/** Polylinie in ihre Ebene projizieren (2D, mm) */
export function flatten(full: V3[]): V2[] {
  if (full.length < 2) return [];
  const p0 = full[0];
  const u = norm3(sub3(full[1], full[0]));
  let n: V3 = { x: 0, y: 0, z: 0 };
  for (let i = 1; i + 1 < full.length; i++) { const c = cross3(sub3(full[i], p0), sub3(full[i + 1], p0)); if (len3(c) > len3(n)) n = c; }
  if (len3(n) < 1e-6) return full.map((p) => ({ x: dot3(sub3(p, p0), u), y: 0 }));
  n = norm3(n);
  const v = cross3(n, u);
  return full.map((p) => ({ x: dot3(sub3(p, p0), u), y: dot3(sub3(p, p0), v) }));
}

export function shapeSvg(full: V3[], legs: number[], W = 150, H = 54): string {
  const pts = flatten(full);
  if (pts.length < 2) return '';
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const pad = 14; const w = Math.max(x1 - x0, 1), hh = Math.max(y1 - y0, 1);
  const k = Math.min((W - 2 * pad) / w, (H - 2 * pad) / hh);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const P = (p: V2) => ({ x: W / 2 + (p.x - cx) * k, y: H / 2 - (p.y - cy) * k });
  const sp = pts.map(P);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${sp.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' ')}" fill="none" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/>`;
  // Schenkelmaße (cm) – kurze Hakenenden weglassen, wenn eng
  const mx = sp.reduce((a, q) => ({ x: a.x + q.x / sp.length, y: a.y + q.y / sp.length }), { x: 0, y: 0 });
  for (let i = 0; i + 1 < sp.length && i < legs.length; i++) {
    const a = sp[i], b = sp[i + 1]; const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 8 && sp.length > 2) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nx = -(b.y - a.y) / (L || 1), ny = (b.x - a.x) / (L || 1);
    if ((m.x - mx.x) * nx + (m.y - mx.y) * ny < 0) { nx = -nx; ny = -ny; }
    if (sp.length === 2) { nx = 0; ny = -1; }
    s += `<text x="${(m.x + nx * 7).toFixed(1)}" y="${(m.y + ny * 7 + 3).toFixed(1)}" font-size="9" font-family="Arial" text-anchor="middle">${cmI(legs[i])}</text>`;
  }
  return s + '</svg>';
}

// ------------------------------------------------------------ Dialog
export interface SteelListOpts { plan?: string; format?: 'din' | 'sshv' }
export function steelListDialog(o: SteelListOpts = {}): void {
  const doc = app.doc;
  let merge = true;
  const selIds = new Set(app.selection);
  const hasSel = [...selIds].some((id) => { const e = doc.get(id); return !!e && (e.cat === 'rebar' || e.cat === 'areaRebar' || e.cat === 'fabricArea' || doc.all().some((x) => x.hostId === id)); });
  let onlySel = false;
  const plans = rebarPlans(doc);
  let plan: string | undefined = o.plan ?? (plans.length > 1 && plans.includes(planOf(app.selected()[0])) ? planOf(app.selected()[0]) : undefined);
  let fmt: 'din' | 'sshv' = o.format ?? (isSia(doc) ? 'sshv' : 'din');
  const body = h('div', { style: 'min-width:820px' });
  const sel = (e: { id: Id; hostId?: Id }) => !onlySel || selIds.has(e.id) || (!!e.hostId && selIds.has(e.hostId));
  const data = () => steelData(doc, plan, merge, sel);
  const idsOf = () => (onlySel ? new Set([...doc.all('rebar'), ...doc.all('areaRebar')].filter(sel).map((e) => e.id)) : undefined);
  const render = () => {
    body.innerHTML = '';
    const opts = h('div', { class: 'form-row', style: 'gap:14px;flex-wrap:wrap' });
    if (plans.length > 1 || (plans.length === 1 && plans[0])) {
      const ps = h('select', {}) as HTMLSelectElement;
      ps.append(h('option', { value: '*' }, 'Alle Pläne'));
      for (const p of plans) ps.append(h('option', { value: p }, p || '(ohne Plan)'));
      ps.value = plan === undefined ? '*' : plan; ps.onchange = () => { plan = ps.value === '*' ? undefined : ps.value; render(); };
      opts.append(h('label', { style: 'min-width:0' }, 'Bewehrungsplan ', ps));
    }
    const fs = h('select', {}) as HTMLSelectElement;
    fs.append(h('option', { value: 'din' }, 'Stahlliste / Biegeliste'), h('option', { value: 'sshv' }, 'Eisenliste nach SSHV (CH)'));
    fs.value = fmt; fs.onchange = () => { fmt = fs.value as 'din' | 'sshv'; render(); };
    opts.append(h('label', { style: 'min-width:0' }, 'Format ', fs));
    if (fmt === 'din') { const cbM = h('input', { type: 'checkbox' }) as HTMLInputElement; cbM.checked = merge; cbM.onchange = () => { merge = cbM.checked; render(); }; opts.append(h('label', { style: 'min-width:0' }, cbM, ' Positionen zusammenfassen (gleiche Stäbe)')); }
    if (hasSel) { const cbS = h('input', { type: 'checkbox' }) as HTMLInputElement; cbS.checked = onlySel; cbS.onchange = () => { onlySel = cbS.checked; render(); }; opts.append(h('label', { style: 'min-width:0' }, cbS, ' Nur Auswahl')); }
    body.append(opts);
    if (fmt === 'sshv') body.append(h('div', { style: 'max-height:62vh;overflow:auto', html: `<style>${EISEN_CSS}</style>` + eisenlisteHtml(doc, { plan, ids: idsOf() }) }));
    else { const { rows, mats } = data(); body.append(h('div', { style: 'max-height:62vh;overflow:auto', html: htmlTables(doc, rows, mats, true) })); }
  };
  render();
  const exportAbs = () => {
    const files = plan !== undefined ? [{ name: (plan || 'ohne_Plan') + '.abs', text: absExport(doc, plan) }] : absFiles(doc);
    if (!files.some((f) => f.text)) { app.status('Keine Positionen für den ABS-Export.'); return; }
    for (const f of files) if (f.text) download(f.name, f.text, 'text/plain;charset=us-ascii');
    app.status(`${files.length} ABS-Datei(en) exportiert (BVBS 3.1).`);
  };
  modal('Stahlliste / Eisenliste', body, [
    { label: 'Neu nummerieren', onClick: () => { renumber(doc, merge, plan); render(); return false; } },
    { label: 'CSV exportieren', onClick: () => {
      const csv = fmt === 'sshv' ? eisenlisteCsv(doc, plan) : stahllisteCsv(doc, plan, merge);
      download(fileBase(doc) + (plan ? '_' + plan : '') + (fmt === 'sshv' ? '_Eisenliste.csv' : '_Stahlliste.csv'), '﻿' + csv, 'text/csv;charset=utf-8'); return false;
    } },
    { label: 'ABS (BVBS)', onClick: () => { exportAbs(); return false; } },
    { label: 'Als Bauteilliste', onClick: () => {
      const v = fmt === 'sshv' ? createEisenliste(doc, plan) : createRebarSchedule(doc, plan);
      app.emit('views'); app.openView(v.id); app.status(`Bauteilliste „${v.name}“ erstellt – kann auf Pläne gezogen werden.`);
    } },
    { label: 'Drucken', onClick: () => { if (fmt === 'sshv') printHtml(eisenlisteDocument(doc, { plan, ids: idsOf() })); else { const d = data(); printList(doc, d.rows, d.mats); } return false; } },
    { label: 'Schließen', primary: true, onClick: () => {} },
  ], 900);
}

const fileBase = (doc: Doc) => (projectInfo(doc)?.name || 'Projekt').replace(/[^\wäöüÄÖÜß-]+/g, '_');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function perDia(rows: SteelRow[]): { dia: number; total: number; kg: number }[] {
  const m = new Map<number, { dia: number; total: number; kg: number }>();
  for (const r of rows) { const x = m.get(r.dia) ?? { dia: r.dia, total: 0, kg: 0 }; x.total += r.total; x.kg += r.kg; m.set(r.dia, x); }
  return [...m.values()].sort((a, b) => a.dia - b.dia);
}

export function htmlTables(doc: Doc, rows: SteelRow[], mats: ReturnType<typeof fabricRows>, screen: boolean): string {
  const th = (s: string, w = '') => `<th style="${w ? 'width:' + w + ';' : ''}text-align:center">${s}</th>`;
  const td = (s: string, right = false) => `<td style="${right ? 'text-align:right;' : ''}vertical-align:middle">${s}</td>`;
  const multi = new Set(rows.map((r) => r.plan)).size > 1;
  let html = `<table class="grid" style="width:100%;border-collapse:collapse"><tr>${multi ? th('Plan', '50px') : ''}${th('Pos.', '40px')}${th('Anzahl', '50px')}${th('Ø<br>[mm]', '40px')}${th('Biegeform', '170px')}${th('Einzellänge<br>[m]', '80px')}${th('Gesamtlänge<br>[m]', '85px')}${th('Gewicht<br>[kg]', '75px')}${th('Bauteil')}</tr>`;
  for (const r of rows) {
    const form = `<div style="display:flex;align-items:center;gap:4px"><span style="min-width:22px;font-weight:600" title="SSHV-Form ${r.form || '–'}">${r.code}</span>${shapeSvg(r.full, r.legs)}</div>`;
    html += `<tr>${multi ? td(esc(r.plan)) : ''}${td(`<b>${r.pos}</b>${r.warn ? ' <span title="Positionsnummer mehrfach mit unterschiedlicher Form vergeben" style="color:#c03030">⚠</span>' : ''}`)}${td(String(r.n), true)}${td(String(r.dia), true)}${td(form)}${td(r.lenText, true)}${td(n2(r.total / 1000), true)}${td(n2(r.kg), true)}${td(`<span style="font-size:11px;color:#444">${esc(r.hosts.slice(0, 3).join('; '))}${r.hosts.length > 3 ? ' …' : ''}</span><br><span style="font-size:10px;color:#888">${esc(SHAPE_NAMES[r.code] ?? '')}${r.form ? ' · SSHV-Form ' + r.form : ''}</span>`)}</tr>`;
  }
  if (!rows.length) html += `<tr><td colspan="${multi ? 9 : 8}" style="color:#777">Keine Stabbewehrung vorhanden.</td></tr>`;
  html += '</table>';
  // Zusammenstellung je Ø
  const sums = perDia(rows);
  const total = sums.reduce((s, x) => s + x.kg, 0);
  html += `<h4 style="margin:10px 0 4px">Zusammenstellung je Durchmesser (Betonstahl B500B)</h4><table class="grid" style="border-collapse:collapse"><tr>${th('Ø [mm]', '60px')}${th('kg/m', '60px')}${th('Länge [m]', '90px')}${th('Gewicht [kg]', '90px')}</tr>`;
  for (const x of sums) html += `<tr>${td(String(x.dia), true)}${td(fmtNum(kgPerM(x.dia), 3), true)}${td(n2(x.total / 1000), true)}${td(n2(x.kg), true)}</tr>`;
  html += `<tr><td colspan="3" style="text-align:right"><b>Summe Stabstahl</b></td>${td(`<b>${n2(total)}</b>`, true)}</tr></table>`;
  // Mattenliste
  if (mats.length) {
    const mt = mats.reduce((s, x) => s + x.kg, 0);
    html += `<h4 style="margin:10px 0 4px">Mattenliste (Lagermatten)</h4><table class="grid" style="border-collapse:collapse"><tr>${th('Mattentyp', '90px')}${th('Anzahl', '60px')}${th('kg/Matte', '70px')}${th('Fläche [m²]', '80px')}${th('Gewicht [kg]', '90px')}</tr>`;
    for (const m of mats) html += `<tr>${td(`<b>${m.type}</b>`)}${td(String(m.n), true)}${td(fmtNum(m.kgEach, 1), true)}${td(n2(m.area / 1e6), true)}${td(n2(m.kg), true)}</tr>`;
    html += `<tr><td colspan="4" style="text-align:right"><b>Summe Matten</b></td>${td(`<b>${n2(mt)}</b>`, true)}</tr></table>`;
    html += `<p style="margin:8px 0"><b>Gesamtgewicht Bewehrung: ${n2(total + mt)} kg</b></p>`;
  } else html += `<p style="margin:8px 0"><b>Gesamtgewicht Bewehrung: ${n2(total)} kg</b></p>`;
  void screen; void doc;
  return html;
}

function csv(rows: SteelRow[], mats: ReturnType<typeof fabricRows>): string {
  const L: string[] = ['Plan;Pos.;Anzahl;Ø [mm];Biegeform;SSHV-Form;Schenkel [cm];Einzellänge [m];Gesamtlänge [m];Gewicht [kg];Bauteil'];
  for (const r of rows) L.push([r.plan, r.pos, r.n, r.dia, r.code, r.form, r.legs.map(cmI).join('/'), r.lenText, n2(r.total / 1000), n2(r.kg), '"' + r.hosts.join('; ').replace(/"/g, "'") + '"'].join(';'));
  L.push('', 'Ø [mm];Länge [m];Gewicht [kg]');
  for (const x of perDia(rows)) L.push([x.dia, n2(x.total / 1000), n2(x.kg)].join(';'));
  L.push(['Summe', '', n2(rows.reduce((s, r) => s + r.kg, 0))].join(';'));
  if (mats.length) {
    L.push('', 'Mattentyp;Anzahl;kg/Matte;Gewicht [kg]');
    for (const m of mats) L.push([m.type, m.n, fmtNum(m.kgEach, 1), n2(m.kg)].join(';'));
  }
  return L.join('\r\n');
}
/** Stahlliste als CSV (Semikolon, Dezimalkomma; plan undefined = alle Pläne) */
export function stahllisteCsv(doc: Doc, plan?: string, merge = true): string {
  const d = steelData(doc, plan, merge);
  return csv(d.rows, d.mats) + '\r\n';
}

function printHtml(html: string): void {
  const w = window.open('', '_blank');
  if (!w) { alert('Druckfenster wurde blockiert.'); return; }
  w.document.write(html); w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}
function printList(doc: Doc, rows: SteelRow[], mats: ReturnType<typeof fabricRows>): void {
  const pi = projectInfo(doc);
  printHtml(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Stahlliste – ${esc(pi?.name ?? '')}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;font-size:12px;margin:15mm}h1{font-size:18px;margin:0 0 4px}
    table{border-collapse:collapse}th,td{border:1px solid #000;padding:2px 5px}th{background:#eee}
    .head{display:flex;justify-content:space-between;border-bottom:2px solid #000;margin-bottom:8px;padding-bottom:4px}
    @media print{body{margin:10mm}}</style></head><body>
    <div class="head"><div><h1>Stahlliste / Biegeliste${rows.length && new Set(rows.map((r) => r.plan)).size === 1 && rows[0].plan ? ' – Plan ' + esc(rows[0].plan) : ''}</h1>Betonstahl B500B · Biegerollendurchmesser nach ${isSia(doc) ? 'SIA 262' : 'DIN EN 1992-1-1/NA'}</div>
    <div style="text-align:right">${esc(pi?.name ?? '')}<br>Projekt-Nr. ${esc(pi?.number ?? '')}<br>${new Date().toLocaleDateString('de-DE')}</div></div>
    ${htmlTables(doc, rows, mats, false)}</body></html>`);
}

/** Positionsnummern neu vergeben – je Bewehrungsplan ab 1 (plan angegeben: nur dieser); gleiche Stäbe gleiche Nummer bei „zusammenfassen“ */
export function renumber(doc: Doc, merge: boolean, plan?: string): void {
  const n = renumberPlans(doc, merge, plan);
  app.status(`${n} Positionen vergeben${plan !== undefined ? ` (Plan ${plan || 'ohne Nummer'})` : ' (je Bewehrungsplan ab 1)'}.`);
}
