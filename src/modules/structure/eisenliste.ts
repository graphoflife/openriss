// Eisenliste nach SSHV/SIA-Richtlinie Betonstahlverarbeitung: Deckblatt (Zusammenfassung je Ø: Fix-/Lagerlängen
// und bearbeitet, Gesamtgewicht, Anzahl Positionen), Liste (Pos., Stückzahl, Ø, abgewickelte Länge, Totallänge,
// Formskizze mit Aussenmassen in cm, Bemerkungen) und separate Liste Spezialbewehrung (Schraubbewehrung).
// Als HTML (Dialog/Druck) und als platzierbare Liste auf Plänen (Bauteilliste data.kind 'eisenliste').
// Alles hier ist DOM-frei (Zeichenketten bzw. Display-Liste).
import type { Doc } from '../../core/doc';
import type { V2 } from '../../core/geom';
import { View, projectInfo } from '../../core/view';
import { registerScheduleKind, GROUPS, PropDef, SchedSplit, SchedSeg, paginate } from '../../core/registry';
import { DisplayList, textWidth } from '../../render/displayList';
import { Figure, figurePolyline, kgNom } from './rebar/sshv';
import { rebarNorm, rebarPlans } from './rebar/norm';
import { fabricRows, FabricArea } from './rebar/area';
import { planOf } from './rebar/norm';
import { EisenRow, eisenRows, eisenSummary, eisenlisteCsv } from './steel';

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const m2 = (mm: number) => (mm / 1000).toFixed(2);
const cmT = (mm: number) => String(Math.round(mm / 10));

/** Titel des Bewehrungsplans (Name des Plans mit dieser Plannummer) */
export function planTitle(doc: Doc, plan: string): string {
  return doc.all<View>('view').find((v) => v.kind === 'sheet' && v.sheetNo === plan)?.name ?? '';
}
const planDate = (doc: Doc, plan: string) => doc.all<View>('view').find((v) => v.kind === 'sheet' && v.sheetNo === plan)?.data?.date || projectInfo(doc)?.date || new Date().toLocaleDateString('de-CH');
const normLine = (doc: Doc) => rebarNorm(doc) === 'SIA'
  ? 'Stahl B500B (SIA 262) · Biegerollen d3 = 4 Ø (Ø ≤ 16) / 7 Ø (Ø > 16) gem. SSHV-Richtlinie · Masse Aussenmasse in cm'
  : 'Stahl B500B · Biegerollen nach DIN EN 1992-1-1/NA (4 Ø / 7 Ø) · Masse Aussenmasse in cm';

// ------------------------------------------------------------ Formskizze (Geometrie)
interface SketchGeo { lines: V2[][]; texts: { p: V2; s: string; ha: 'left' | 'center' | 'right'; va: 'top' | 'middle' | 'bottom' }[] }
/** Skizze in ein Feld w × h (y nach oben, Ursprung unten links); flache Formen werden für die Lesbarkeit gestreckt */
export function sketchGeo(f: Figure, w: number, h: number, txt: number): SketchGeo {
  const out: SketchGeo = { lines: [], texts: [] };
  if (f.legs.length === 1) {
    const y = h * 0.4;
    out.lines.push([{ x: 4, y }, { x: w - 4, y }]);
    out.texts.push({ p: { x: w / 2, y: y + txt * 0.5 }, s: cmT(f.legs[0]), ha: 'center', va: 'bottom' });
    return out;
  }
  const pts = figurePolyline(f.legs, f.angles);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const sx = x1 - x0 || 1e-3, sy = y1 - y0 || 1e-3;
  const k = Math.min((w - 5 * txt) / sx, (h - 3.6 * txt) / sy);
  const kx = sx * k < 4 ? 4 / sx : k, ky = sy * k < 4 ? 4 / sy : k;
  const ox = (w - sx * kx) / 2 - x0 * kx, oy = (h - sy * ky) / 2 - y0 * ky;
  const P = pts.map((p) => ({ x: ox + p.x * kx, y: oy + p.y * ky }));
  out.lines.push(P);
  const c = P.reduce((s, q) => ({ x: s.x + q.x / P.length, y: s.y + q.y / P.length }), { x: 0, y: 0 });
  // Segment → Schenkel (180° hat ein zusätzliches Stegsegment)
  let leg = 0;
  for (let i = 0; i + 1 < P.length && leg < f.legs.length; i++) {
    const a = P[i], b = P[i + 1]; const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    if ((m.x - c.x) * nx + (m.y - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    const d = txt * 0.45;
    out.texts.push({ p: { x: m.x + nx * d, y: m.y + ny * d }, s: cmT(f.legs[leg]), ha: Math.abs(nx) > 0.7 ? (nx > 0 ? 'left' : 'right') : 'center', va: Math.abs(ny) > 0.7 ? (ny > 0 ? 'bottom' : 'top') : 'middle' });
    const ang = f.angles[leg];
    if (ang !== undefined && Math.abs(ang) >= 170) i++; // Stegsegment überspringen
    else if (ang !== undefined && Math.abs(Math.abs(ang) - 90) > 0.5) out.texts.push({ p: { x: b.x + txt * 0.3, y: b.y + txt * 0.3 }, s: `${Math.round(Math.abs(ang))}°`, ha: 'left', va: 'bottom' });
    leg++;
  }
  return out;
}
/** Formskizze als SVG (Pixel, y nach unten) */
export function figureSvg(f: Figure, W = 230, H = 56): string {
  const g = sketchGeo(f, W, H, 10);
  const Y = (y: number) => (H - y).toFixed(1);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const l of g.lines) s += `<polyline points="${l.map((p) => p.x.toFixed(1) + ',' + Y(p.y)).join(' ')}" fill="none" stroke="#000" stroke-width="1.8" stroke-linejoin="round"/>`;
  for (const t of g.texts) {
    const anchor = t.ha === 'left' ? 'start' : t.ha === 'right' ? 'end' : 'middle';
    const dy = t.va === 'bottom' ? -1 : t.va === 'top' ? 8 : 3.5;
    s += `<text x="${t.p.x.toFixed(1)}" y="${(H - t.p.y + dy).toFixed(1)}" font-size="9.5" font-family="Arial" text-anchor="${anchor}">${esc(t.s)}</text>`;
  }
  return s + '</svg>';
}

// ------------------------------------------------------------ HTML (Dialog, Druck)
export interface EisenlisteOpts { plan?: string; ids?: Set<string>; cover?: boolean }
function headHtml(doc: Doc, plan: string, title: string, count: number): string {
  const pi = projectInfo(doc);
  const box = (l: string, v: string) => `<td class="el-box"><div class="el-lab">${esc(l)}</div><div class="el-val">${esc(v)}</div></td>`;
  return `<table class="el-head"><tr><td rowspan="2" class="el-tit"><div class="el-h1">${esc(title)}</div>
    <div>${esc([pi?.name, pi?.address].filter(Boolean).join(' – '))}</div>
    ${planTitle(doc, plan) ? `<div>Bauteil: ${esc(planTitle(doc, plan))}</div>` : ''}
    <div class="el-sm">${esc([pi?.author, pi?.number ? 'Projekt-Nr. ' + pi.number : ''].filter(Boolean).join(' · '))}</div>
    <div class="el-xs">${esc(normLine(doc))}</div></td>${box('Zu Plan Nr.', plan || '–')}${box('Liste Nr.', plan ? plan + '.1' : '–')}</tr>
    <tr>${box('Datum', planDate(doc, plan))}${box('Positionen', String(count))}</tr></table>`;
}
function listHtml(rows: EisenRow[]): string {
  let s = `<table class="el-list"><tr><th style="width:40px">Pos.</th><th style="width:50px">Anzahl</th><th style="width:34px">Ø</th><th style="width:56px">L [m]</th><th style="width:64px">Tot. [m]</th><th>Form (Aussenmasse in cm)</th><th style="width:170px">Bemerkungen</th></tr>`;
  for (const r of rows) {
    const warn = r.warn.length ? ` <span class="el-warn" title="${esc(r.warn.join('\n'))}">⚠</span>` : '';
    s += `<tr><td class="r"><b>${r.pos}</b>${warn}</td><td class="r">${r.n}</td><td class="r">${r.dia}</td><td class="r">${m2(r.len)}</td><td class="r">${m2(r.total)}</td>`
      + `<td><div class="el-fn">${r.fig.nr ? 'Form ' + r.fig.nr : esc(r.fig.name)}</div>${figureSvg(r.fig, 230, r.fix ? 26 : 56)}</td>`
      + `<td class="el-rem">${r.remarks.map(esc).join('<br>')}${r.warn.length ? `<br><span class="el-warn">${r.warn.map(esc).join('<br>')}</span>` : ''}</td></tr>`;
  }
  if (!rows.length) s += `<tr><td colspan="7" style="color:#777">Keine Positionen.</td></tr>`;
  return s + '</table>';
}
function coverHtml(doc: Doc, rows: EisenRow[], plan: string | undefined): string {
  const z = eisenSummary(rows);
  let s = `<h3>Zusammenfassung der Betonstahlliste (B500B)</h3><table class="el-sum"><tr><th>Ø mm</th><th>kg/m</th><th>Fix/Lager L [m]</th><th>Fix/Lager [kg]</th><th>bearbeitet L [m]</th><th>bearbeitet [kg]</th><th>Total [kg]</th></tr>`;
  for (const x of z.perDia) s += `<tr><td class="c">${x.dia}</td><td class="r">${x.kgm.toFixed(3)}</td><td class="r">${m2(x.fixLen)}</td><td class="r">${x.fixKg.toFixed(1)}</td><td class="r">${m2(x.bLen)}</td><td class="r">${x.bKg.toFixed(1)}</td><td class="r">${(x.fixKg + x.bKg).toFixed(1)}</td></tr>`;
  s += `<tr class="tot"><td class="c">Total</td><td></td><td class="r">${m2(z.fixLen)}</td><td class="r">${z.fixKg.toFixed(1)}</td><td class="r">${m2(z.bLen)}</td><td class="r">${z.bKg.toFixed(1)}</td><td class="r">${z.kg.toFixed(1)}</td></tr></table>`;
  s += `<p class="el-big">Anzahl Positionen: ${z.count} &nbsp;&nbsp; Gesamtgewicht: ${z.kg.toFixed(1)} kg</p>`;
  if (z.special.count) s += `<p>Separate Liste Spezialbewehrung (Schraubbewehrung, SSHV-RL 4.2.3): ${z.special.count} Position${z.special.count > 1 ? 'en' : ''}, ${z.special.kg.toFixed(1)} kg.</p>`;
  const fabrics = doc.all<FabricArea>('fabricArea').filter((f) => plan === undefined || planOf(f) === plan);
  const mats = fabricRows(doc, fabrics);
  if (mats.length) {
    s += `<h4>Netze / Matten (separat bestellen)</h4><table class="el-sum"><tr><th>Typ</th><th>Anzahl</th><th>kg/Stk</th><th>Gewicht [kg]</th></tr>`;
    for (const m of mats) s += `<tr><td>${esc(m.type)}</td><td class="r">${m.n}</td><td class="r">${m.kgEach.toFixed(1)}</td><td class="r">${m.kg.toFixed(1)}</td></tr>`;
    s += '</table>';
  }
  s += `<table class="el-foot"><tr><td><b>Unternehmer (Bewehrungslieferant):</b><div class="el-sig"></div></td><td><b>Bemerkungen:</b><ul>
    <li>Stähle Ø ≤ 16 werden in geraden Stückzahlen produziert (SSHV-Richtlinie).</li><li>Toleranzen gem. SIA 262; Formen mit Aussenmassen, Winkel in °.</li>
    ${plan ? `<li>Produktionsdatei (ABS, BVBS 3.1): ${esc(plan)}.abs</li>` : ''}<li>Lieferung je Bauteil/Etappe gem. Abruf Bauunternehmung.</li></ul></td></tr></table>`;
  return s;
}
export const EISEN_CSS = `
.el-doc{font:12px Arial,Helvetica,sans-serif;color:#000}
.el-doc table{border-collapse:collapse}.el-doc th,.el-doc td{border:1px solid #000;padding:2px 5px;vertical-align:middle}
.el-doc th{background:#e6e6e6;text-align:left}.el-doc td.r{text-align:right}.el-doc td.c{text-align:center}
.el-head{width:100%;margin-bottom:8px}.el-head td{border:1.5px solid #000}.el-tit{line-height:1.45}.el-h1{font-size:17px;font-weight:bold}
.el-sm{font-size:11px}.el-xs{font-size:9.5px}.el-box{width:110px;vertical-align:top}.el-lab{font-size:9px;color:#666}.el-val{font-size:15px;font-weight:bold}
.el-list{width:100%}.el-fn{font-size:9px;color:#777}.el-rem{font-size:10.5px}.el-warn{color:#c03030}
.el-sum tr.tot td{font-weight:bold;border-top:2px solid #000}.el-big{font-size:14px;font-weight:bold}
.el-foot{width:100%;margin-top:14px}.el-foot td{border:none;vertical-align:top;width:50%}.el-sig{border:1px solid #000;height:90px;margin-top:4px}
.el-page{page-break-before:always}.el-doc h3{margin:12px 0 4px}`;

/** Eisenliste als HTML-Fragment (Deckblatt, Liste, Spezialbewehrung) */
export function eisenlisteHtml(doc: Doc, o: EisenlisteOpts = {}): string {
  const plan = o.plan;
  const rows = eisenRows(doc, plan, o.ids);
  const normal = rows.filter((r) => !r.special), special = rows.filter((r) => r.special);
  const plans = plan === undefined ? [...new Set(rows.map((r) => r.plan))] : [plan];
  let s = `<div class="el-doc">`;
  plans.forEach((p, i) => {
    const pn = normal.filter((r) => r.plan === p), ps = special.filter((r) => r.plan === p);
    const cnt = new Set([...pn, ...ps].map((r) => r.pos)).size;
    if (o.cover !== false) s += `<div class="${i ? 'el-page' : ''}">${headHtml(doc, p, 'Betonstahlliste – Deckblatt', cnt)}${coverHtml(doc, [...pn, ...ps], p)}</div>`;
    s += `<div class="${o.cover !== false || i ? 'el-page' : ''}">${headHtml(doc, p, 'Betonstahlliste', cnt)}${listHtml(pn)}</div>`;
    if (ps.length) s += `<div class="el-page">${headHtml(doc, p, 'Liste Spezialbewehrung (Schraubbewehrung)', cnt)}${listHtml(ps)}</div>`;
  });
  if (!plans.length) s += '<p>Keine Bewehrung vorhanden.</p>';
  return s + '</div>';
}
/** Vollständiges HTML-Dokument (zum Drucken / Speichern) */
export function eisenlisteDocument(doc: Doc, o: EisenlisteOpts = {}): string {
  return `<!doctype html><html lang="de-CH"><head><meta charset="utf-8"><title>Eisenliste ${esc(o.plan ?? '')}</title><style>body{margin:12mm}${EISEN_CSS}@media print{body{margin:8mm}}</style></head><body>${eisenlisteHtml(doc, o)}</body></html>`;
}

// ------------------------------------------------------------ Display-Liste (Liste auf dem Plan)
const COLS: [string, number, 'l' | 'r' | 'c'][] = [['Pos.', 12, 'r'], ['Anzahl', 14, 'r'], ['Ø', 10, 'r'], ['L [m]', 16, 'r'], ['Tot. [m]', 18, 'r'], ['Form (Aussenmasse in cm)', 72, 'l'], ['Bemerkungen', 44, 'l']];
const thin = { w: 1 }, mid = { w: 2 }, bold = { w: 3 };
function drawFigure(dl: DisplayList, f: Figure, x: number, y: number, w: number, h: number): void {
  const g = sketchGeo(f, w, h, 2);
  for (const l of g.lines) dl.poly(l.map((p) => ({ x: x + p.x, y: y + p.y })), bold, false, { ns: true });
  for (const t of g.texts) dl.text({ x: x + t.p.x, y: y + t.p.y }, t.s, { size: 2, ha: t.ha, va: t.va });
}
function rect(dl: DisplayList, x0: number, y0: number, x1: number, y1: number, pen = thin, fill?: string): void {
  const r = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (fill) dl.fill([r], { color: fill });
  dl.poly(r, pen, true, { ns: true });
}
/** Teil der Liste auf dem Plan: Höhe, mit dem folgenden zusammenhalten, Abschnitt (normal/spezial) und Position */
interface ElItem { h: number; keep?: boolean; sec?: 'normal' | 'special'; row?: EisenRow; draw(dl: DisplayList, y: number): void }
/** Bausteine der Eisenliste: Kopf (Titel), Kopfzeile, Positionen, Zusammenfassung je Ø */
function eisenParts(doc: Doc, view: View): { W: number; items: ElItem[]; head(dl: DisplayList, cont: boolean): void; colHead(dl: DisplayList, y: number): void } {
  const d = view.data ?? {};
  const plan: string | undefined = typeof d.plan === 'string' ? d.plan : undefined;
  const part: string = d.part ?? 'all';
  const rows = eisenRows(doc, plan);
  const W = COLS.reduce((s, c) => s + c[1], 0);
  const pi = projectInfo(doc);
  const head = (dl: DisplayList, cont: boolean) => {
    rect(dl, 0, -14, W, 0, bold);
    dl.text({ x: 2, y: -4.5 }, (part === 'special' ? 'Liste Spezialbewehrung (Schraubbewehrung)' : 'Betonstahlliste (Eisenliste nach SSHV)') + (cont ? ' – Fortsetzung' : ''), { size: 3.5, bold: true, va: 'middle' });
    dl.text({ x: 2, y: -10 }, [plan ? `Plan ${plan}` : 'alle Pläne', planTitle(doc, plan ?? ''), pi?.number ? 'Projekt-Nr. ' + pi.number : ''].filter(Boolean).join(' · '), { size: 2, va: 'middle' });
    dl.text({ x: W - 2, y: -10 }, normLine(doc).split(' · ').slice(0, 2).join(' · '), { size: 1.6, ha: 'right', va: 'middle' });
  };
  const colHead = (dl: DisplayList, y: number) => {
    rect(dl, 0, y - 6, W, y, mid, '#e6e6e6');
    let x = 0;
    for (const [t, w] of COLS) { dl.text({ x: x + 1, y: y - 3 }, t, { size: 2.2, bold: true, va: 'middle' }); x += w; }
  };
  const drawRow = (dl: DisplayList, r: EisenRow, y: number) => {
    const rh = r.fix ? 9 : 17;
    rect(dl, 0, y - rh, W, y);
    const vals = [String(r.pos), String(r.n), String(r.dia), m2(r.len), m2(r.total)];
    let x = 0;
    COLS.forEach(([, w], i) => {
      if (i < 5) dl.text({ x: x + w - 1.5, y: y - rh / 2 }, vals[i], { size: 2.5, ha: 'right', va: 'middle', bold: i === 0 });
      if (i < COLS.length - 1) dl.line({ x: x + w, y }, { x: x + w, y: y - rh }, thin, { ns: true });
      x += w;
    });
    const fx = COLS.slice(0, 5).reduce((s, c) => s + c[1], 0), fw = COLS[5][1];
    dl.text({ x: fx + 1, y: y - 0.8 }, r.fig.nr ? 'Form ' + r.fig.nr : 'Sonderform', { size: 1.7, va: 'top', color: '#707070' });
    drawFigure(dl, r.fig, fx, y - rh, fw, rh - 1.5);
    const rem = [...r.remarks, ...r.warn.map((w2) => '⚠ ' + w2)];
    const bx = fx + fw + 1, bw = COLS[6][1] - 2;
    let ty = y - 1;
    for (const line of rem.slice(0, Math.floor(rh / 2.1))) {
      let s = line; while (s.length > 3 && textWidth(s, 1.75) > bw) s = s.slice(0, -2);
      dl.text({ x: bx, y: ty }, s === line ? s : s + '…', { size: 1.75, va: 'top' }); ty -= 2.1;
    }
  };
  const items: ElItem[] = [];
  const section = (list: EisenRow[], sec: 'normal' | 'special', title?: string) => {
    if (title) items.push({ h: 6, keep: true, draw: (dl, y) => { rect(dl, 0, y - 6, W, y, mid); dl.text({ x: 2, y: y - 3 }, title, { size: 2.5, bold: true, va: 'middle' }); } });
    items.push({ h: 6, keep: true, draw: colHead });
    for (const r of list) items.push({ h: r.fix ? 9 : 17, sec, row: r, draw: (dl, y) => drawRow(dl, r, y) });
    if (!list.length) items.push({ h: 7, draw: (dl, y) => { rect(dl, 0, y - 7, W, y); dl.text({ x: 2, y: y - 3.5 }, 'Keine Positionen', { size: 2.5, va: 'middle', color: '#707070' }); } });
  };
  const normal = rows.filter((r) => !r.special), special = rows.filter((r) => r.special);
  if (part !== 'special') section(normal, 'normal');
  if (part !== 'normal' && special.length) section(special, 'special', part === 'special' ? undefined : 'Spezialbewehrung (Schraubbewehrung, SSHV-RL 4.2.3)');
  // Zusammenfassung je Ø (nur am Ende der Liste)
  if (d.summary !== false && part !== 'special') {
    const z = eisenSummary(rows);
    items.push({ h: 21.5 + 5 * (z.perDia.length + 1), draw: (dl, y) => {
      y -= 4;
      const sc: [string, number][] = [['Ø mm', 16], ['kg/m', 18], ['Fix/Lager L [m]', 28], ['Fix/Lager [kg]', 28], ['bearbeitet L [m]', 28], ['bearbeitet [kg]', 28], ['Total [kg]', 26]];
      const SW = sc.reduce((s, c) => s + c[1], 0);
      dl.text({ x: 0, y: y - 2.5 }, 'Zusammenfassung (B500B)', { size: 2.8, bold: true, va: 'middle' });
      y -= 5;
      rect(dl, 0, y - 5.5, SW, y, mid, '#e6e6e6');
      let x = 0; for (const [t, w] of sc) { dl.text({ x: x + 1, y: y - 2.75 }, t, { size: 2, bold: true, va: 'middle' }); x += w; }
      y -= 5.5;
      const line = (vals: string[], b = false) => {
        rect(dl, 0, y - 5, SW, y, b ? mid : thin);
        let xx = 0; vals.forEach((v, i) => { if (v) dl.text({ x: xx + sc[i][1] - 1.2, y: y - 2.5 }, v, { size: 2.2, ha: 'right', va: 'middle', bold: b }); xx += sc[i][1]; });
        y -= 5;
      };
      for (const p of z.perDia) line([String(p.dia), p.kgm.toFixed(3), m2(p.fixLen), p.fixKg.toFixed(1), m2(p.bLen), p.bKg.toFixed(1), (p.fixKg + p.bKg).toFixed(1)]);
      line(['Total', '', m2(z.fixLen), z.fixKg.toFixed(1), m2(z.bLen), z.bKg.toFixed(1), z.kg.toFixed(1)], true);
      y -= 2;
      dl.text({ x: 0, y: y - 2.5 }, `Anzahl Positionen: ${z.count}   Gesamtgewicht: ${z.kg.toFixed(1)} kg${z.special.count ? `   Spezialbewehrung: ${z.special.count} Pos., ${z.special.kg.toFixed(1)} kg` : ''}`, { size: 2.5, bold: true, va: 'middle' });
    } });
  }
  void kgNom;
  return { W, items, head, colHead };
}

/** Liste als Display-Liste (Papier-mm, Ursprung oben links, y nach oben) */
export function eisenlisteDL(doc: Doc, view: View): DisplayList {
  const { items, head } = eisenParts(doc, view);
  const dl = new DisplayList(1);
  head(dl, false);
  let y = -14;
  for (const it of items) { it.draw(dl, y); y -= it.h; }
  return dl;
}

/** Übertrags-/Zwischentotalzeile: Gewicht in kg (nie Meter über verschiedene Ø) */
const CARRY_H = 6;
function carryRow(dl: DisplayList, W: number, y: number, label: string, kg: number, n: number, first: boolean): void {
  rect(dl, 0, y - CARRY_H, W, y, first ? mid : thin, '#f2f2f2');
  if (!first) dl.line({ x: 0, y: y - CARRY_H }, { x: W, y: y - CARRY_H }, mid, { ns: true });
  dl.text({ x: 2, y: y - CARRY_H / 2 }, label, { size: 2.5, bold: true, italic: true, va: 'middle' });
  const fx = COLS.slice(0, 5).reduce((s, c) => s + c[1], 0);
  dl.text({ x: fx - 1.5, y: y - CARRY_H / 2 }, `${n} Pos.`, { size: 2.2, ha: 'right', va: 'middle', italic: true });
  dl.text({ x: fx + COLS[5][1] - 1.5, y: y - CARRY_H / 2 }, `Gewicht ${kg.toFixed(1)} kg`, { size: 2.5, bold: true, ha: 'right', va: 'middle' });
}

/**
 * Umbruch der Eisenliste in Abschnitte der Höhe ≤ maxH: Kopf in jedem Abschnitt, Kopfzeile und «Übertrag» (Gewicht kg)
 * am Anfang eines fortgesetzten Abschnitts, «Übertrag» am Ende, optional Zwischentotal; Zusammenfassung nur im letzten.
 */
export function eisenlisteLayout(doc: Doc, view: View, sp: SchedSplit): SchedSeg[] {
  const { W, items, head, colHead } = eisenParts(doc, view);
  const sub = sp.subtotal ? CARRY_H : 0;
  const segs = paginate(items.map((i) => i.h), items.map((i) => !!i.keep), sp.maxH, 14 + sub, 14 + 6 + sub, CARRY_H, CARRY_H);
  // Abschnitte, in denen Positionen eines Listenteils stehen (Zwischentotal nur bei umbrochenen Teilen)
  const spans = new Map<string, Set<number>>();
  segs.forEach(([a, b], k) => { for (let i = a; i < b; i++) { const s = items[i].sec; if (s && items[i].row) (spans.get(s) ?? spans.set(s, new Set()).get(s)!).add(k); } });
  type Run = { kg: number; pos: Set<string> };
  const run = new Map<string, Run>();
  return segs.map(([a, b], k) => {
    const dl = new DisplayList(1);
    head(dl, k > 0);
    let y = -14;
    const f = items[a];
    if (k > 0 && f?.row && f.sec) {
      colHead(dl, y); y -= 6;
      const r = run.get(f.sec) ?? { kg: 0, pos: new Set() };
      carryRow(dl, W, y, 'Übertrag', r.kg, r.pos.size, true); y -= CARRY_H;
    }
    const segRun = new Map<string, Run>();
    for (let i = a; i < b; i++) {
      const it = items[i];
      it.draw(dl, y); y -= it.h;
      if (!it.row || !it.sec) continue;
      const s = it.sec;
      for (const m of [run, segRun]) { const r = m.get(s) ?? { kg: 0, pos: new Set() }; r.kg += it.row.kg; r.pos.add(it.row.plan + '|' + it.row.pos); m.set(s, r); }
      const next = items[i + 1];
      if (next?.row && next.sec === s && i + 1 < b) continue; // Listenteil geht in diesem Abschnitt weiter
      if (sub && (spans.get(s)?.size ?? 0) > 1) { const r = segRun.get(s)!; carryRow(dl, W, y, 'Zwischentotal', r.kg, r.pos.size, false); y -= CARRY_H; }
      if (i + 1 === b && next?.row && next.sec === s) { const r = run.get(s)!; carryRow(dl, W, y, 'Übertrag', r.kg, r.pos.size, false); y -= CARRY_H; }
    }
    return { dl, w: W, h: -y };
  });
}

// ------------------------------------------------------------ Sonderliste registrieren
const partOpts: [string, string][] = [['all', 'Liste + Spezialbewehrung'], ['normal', 'nur Liste'], ['special', 'nur Spezialbewehrung']];
registerScheduleKind('eisenliste', {
  label: 'Eisenliste (SSHV)',
  dl: eisenlisteDL,
  layout: eisenlisteLayout,
  html: (doc, view) => `<style>${EISEN_CSS}</style>` + eisenlisteHtml(doc, { plan: typeof view.data?.plan === 'string' ? view.data.plan : undefined, cover: view.data?.part !== 'special' }),
  csv: (doc, view) => eisenlisteCsv(doc, typeof view.data?.plan === 'string' ? view.data.plan : undefined),
  count: (doc, view) => new Set(eisenRows(doc, typeof view.data?.plan === 'string' ? view.data.plan : undefined).map((r) => r.plan + '|' + r.pos)).size,
  props: (_v, doc): PropDef[] => [
    { key: 'elPlan', label: 'Bewehrungsplan', group: GROUPS.identity, type: 'select', options: () => [['*', '(alle)'], ...rebarPlans(doc).map((p) => [p, p || '(ohne Plan)'] as [string, string])],
      get: (e) => (typeof e.data?.plan === 'string' ? e.data.plan : '*'), set: (e, v) => ({ data: { ...(e.data ?? {}), plan: v === '*' ? undefined : v } }) },
    { key: 'elPart', label: 'Umfang', group: GROUPS.identity, type: 'select', options: partOpts, get: (e) => e.data?.part ?? 'all', set: (e, v) => ({ data: { ...(e.data ?? {}), part: v } }) },
    { key: 'elSum', label: 'Zusammenfassung je Ø', group: GROUPS.identity, type: 'bool', get: (e) => e.data?.summary !== false, set: (e, v) => ({ data: { ...(e.data ?? {}), summary: !!v } }) },
  ],
});
