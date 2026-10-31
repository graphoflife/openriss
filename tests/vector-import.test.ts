// N11 Vektorgrafik-Import (SVG/PDF/DXF) als Detailelemente: Linien mit Linienstilen, Füllbereiche, Texte.
import assert from 'node:assert/strict';
import * as api from '../src/api';
import { importVector } from '../src/modules/output/vectorImport';
import { parseSvg } from '../src/modules/output/svgParse';
import { explodeCad } from '../src/modules/output/dxfCommands';
import { parseDxf } from '../src/modules/output/dxfParse';
import { linePen } from '../src/elements/datums';
import { pageOf } from '../src/modules/output/common';
import { zlibSync } from 'fflate';

const doc = api.createProject();
const drafting = (name: string, scale: number) => api.add<any>({ cat: 'view', kind: 'drafting', name, scale, detail: 'fine' });
const near = (a: number, b: number, t = 0.01) => Math.abs(a - b) <= t;
const P = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
const of = (vid: string, cat: string) => doc.all<any>(cat).filter((e) => e.viewId === vid);
const hasLine = (vid: string, a: { x: number; y: number }, b: { x: number; y: number }, t = 0.5) =>
  of(vid, 'line').find((l) => (near(l.a.x, a.x, t) && near(l.a.y, a.y, t) && near(l.b.x, b.x, t) && near(l.b.y, b.y, t)) || (near(l.a.x, b.x, t) && near(l.a.y, b.y, t) && near(l.b.x, a.x, t) && near(l.b.y, a.y, t)));

// ------------------------------------------------------------ (a) SVG: Transformationen, Pfadbefehle, Strichmuster, Farben
const svg = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200mm" height="100mm" viewBox="0 0 200 100">
  <style>.rot { stroke: #ff0000; stroke-width: 0.5; fill: none } #gelb { fill: #ffcc00 }</style>
  <defs><path id="kurz" d="M0,0 h5"/></defs>
  <!-- Kommentar -->
  <g transform="translate(10 20)">
    <path d="M0 0 L50 0 l0 10 h-20 v5 Z" stroke="#0000ff" stroke-width="0.25" stroke-dasharray="3 1.5" fill="none"/>
    <path class="rot" d="M100 50 a 20 20 0 0 1 40 0"/>
  </g>
  <rect x="150" y="10" width="40" height="30" fill="#33aa55" stroke="none"/>
  <rect id="gelb" x="150" y="50" width="20" height="20" style="stroke:#000000;stroke-width:0.18"/>
  <circle cx="20" cy="80" r="10" fill="none" stroke="#000" stroke-width="0.35"/>
  <g transform="rotate(90 100 50)"><line x1="90" y1="50" x2="110" y2="50" stroke="#00ff00" stroke-width="0.7" stroke-dasharray="8,1.5,1,1.5"/></g>
  <path d="M 10 95 C 20 85, 40 85, 50 95" stroke="#000" fill="none"/>
  <use xlink:href="#kurz" x="60" y="95" stroke="#000" stroke-width="0.1"/>
  <text x="100" y="90" font-size="3.5" fill="#d01010" text-anchor="middle">Pr&#252;fung &amp; &#xC4;</text>
  <text transform="translate(10 10) rotate(-90)" font-size="2.5"><tspan x="0" y="0">Zeile 1</tspan><tspan x="0" y="3.125">Zeile 2</tspan></text>
  <g style="display:none"><line x1="0" y1="0" x2="10" y2="10" stroke="#000"/></g>
  <path d="m 60 60 q 10 -10 20 0 t 20 0" stroke="#000" stroke-width="0.13" fill="none"/>
</svg>`;
const vd = parseSvg(svg);
assert.ok(near(vd.w, 200) && near(vd.h, 100), 'Seitengrösse mm');
const v1 = drafting('SVG-Import', 10);
const r1 = importVector(doc, v1.id, svg);
assert.equal(r1.regions, 2, 'zwei Füllbereiche');
assert.equal(r1.texts, 2, 'zwei Texte');
// blaue gestrichelte Linien (Papier 10/80 … → Modell ×10), Stift 4 (0,25 mm), Strich
const blue = hasLine(v1.id, { x: 100, y: 800 }, { x: 600, y: 800 });
assert.ok(blue, 'blaue Linie'); assert.deepEqual(linePen(doc, blue.style), { w: 4, color: '#0000ff', dash: 'dash' });
assert.ok(hasLine(v1.id, { x: 600, y: 800 }, { x: 600, y: 700 }) && hasLine(v1.id, { x: 400, y: 700 }, { x: 400, y: 650 }) && hasLine(v1.id, { x: 400, y: 650 }, { x: 100, y: 800 }), 'relative Befehle, Z');
assert.equal(of(v1.id, 'line').filter((l) => l.style === blue.style).length, 5);
// Bogen (relativ, sweep=1): obere Halbkreis um (1300/300), r = 200, rot 0,5 mm
const arc = of(v1.id, 'line').find((l) => l.arc && near(l.arc.r, 200, 0.01));
assert.ok(arc, 'Bogen bleibt Bogen');
assert.ok(near(arc.arc.c.x, 1300) && near(arc.arc.c.y, 300) && near(arc.arc.a0, 0, 1e-6) && near(arc.arc.a1, Math.PI, 1e-6), 'Bogen ' + JSON.stringify(arc.arc));
assert.deepEqual(linePen(doc, arc.style), { w: 6, color: '#ff0000' });
// Kreis → zwei Halbbögen, 0,35 mm = Stift 5 → «Breite Linien»
const circ = of(v1.id, 'line').filter((l) => l.arc && near(l.arc.r, 100, 0.01));
assert.equal(circ.length, 2, 'Kreis als zwei Bögen'); assert.equal(circ[0].style, 'wide');
assert.ok(near(circ[0].arc.c.x, 200) && near(circ[0].arc.c.y, 200));
// gedrehte Gruppe: senkrechte Linie, grün, Achse
const green = hasLine(v1.id, { x: 1000, y: 600 }, { x: 1000, y: 400 });
assert.ok(green, 'rotate(90 cx cy)'); assert.deepEqual(linePen(doc, green.style), { w: 7, color: '#00ff00', dash: 'center' });
// Bézierkurve aufgelöst (kein Kreisbogen), Stift 8 (1 mm Vorgabebreite)
const bez = of(v1.id, 'line').filter((l) => !l.arc && linePen(doc, l.style).w === 8);
assert.ok(bez.length >= 4, 'Kurve in Linien aufgelöst: ' + bez.length);
assert.ok(hasLine(v1.id, { x: 600, y: 50 }, { x: 650, y: 50 }), 'use mit x/y');
// Füllbereiche: Farbe → Typ, gelb mit Rand (Rand wird Begrenzungslinienstil «Mittlere Linien»)
const regs = of(v1.id, 'region');
const green2 = regs.find((r) => doc.get<any>(r.typeId).patColor === '#33aa55');
assert.ok(green2 && doc.get<any>(green2.typeId).pattern === 'solid' && green2.lineStyle === 'invisible');
assert.deepEqual(green2.loops[0].map(P).sort(), ['1500,600', '1500,900', '1900,600', '1900,900']);
const yellow = regs.find((r) => doc.get<any>(r.typeId).patColor === '#ffcc00');
assert.ok(yellow, 'CSS #id'); assert.equal(yellow.lineStyle, 'medium', 'Rand als Begrenzungslinie');
assert.ok(!hasLine(v1.id, { x: 1500, y: 500 }, { x: 1700, y: 500 }), 'Rand nicht doppelt als Detaillinie');
// Texte: Entitäten, Farbe/Höhe → Typ, Ausrichtung, Drehung, mehrzeilig
const texts = of(v1.id, 'text');
const t1 = texts.find((t) => t.s === 'Prüfung & Ä');
assert.ok(t1, 'Text: ' + texts.map((t) => t.s).join(' | '));
assert.equal(t1.ha, 'center');
const tt1 = doc.get<any>(t1.typeId); assert.equal(tt1.size, 3.5); assert.equal(tt1.color, '#d01010');
const t2 = texts.find((t) => t.s === 'Zeile 1\nZeile 2');
assert.ok(t2, 'mehrzeiliger Text'); assert.ok(near(t2.rot, Math.PI / 2, 1e-6), 'Drehung'); assert.equal(doc.get<any>(t2.typeId).size, 2.5);
// Strichmuster und Ausblenden
assert.ok(!hasLine(v1.id, { x: 0, y: 1000 }, { x: 100, y: 900 }), 'display:none');
// Q/T-Kurven: aus zwei Parabeln (je eigene Segmente), Ende bei Papier 100/40
const qs = of(v1.id, 'line').filter((l) => linePen(doc, l.style).w === 2 && !l.arc);
assert.ok(qs.length >= 4 && qs.some((l) => P(l.b) === '1000,400' || P(l.a) === '1000,400'), 'Q/T');
console.log(`  SVG: ${r1.lines} Linien (${r1.arcs} Bögen), ${r1.regions} Bereiche, ${r1.texts} Texte, ${r1.lineStyles} neue Linienstile`);

// ------------------------------------------------------------ (b) Rundlauf: Zeichnungsansicht → Plan → PDF → Import
const v2 = drafting('Rundlauf', 20);
const lsRed = api.addLineStyle({ name: 'Rot gestrichelt', color: '#d01010', pen: 3, dash: 'dash' });
const lsBlue = api.addLineStyle({ color: '#1040d0', pen: 5, dash: 'solid' });
const lsMag = api.addLineStyle({ color: '#e000e0', pen: 2, dash: 'center' });
const L = (a: [number, number], b: [number, number], style: string, arc?: any) => api.add<any>({ cat: 'line', viewId: v2.id, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, style, ...(arc ? { arc } : {}) } as any);
const orig = [
  L([0, 0], [2000, 0], lsRed.id), L([2000, 0], [2000, 1200], lsRed.id), L([0, 1500], [2400, 1500], lsBlue.id),
  L([-500, -300], [-500, 1800], lsMag.id), L([200, 200], [900, 600], 'thin'),
  L([3000, 0], [2000, 1000], lsBlue.id, { c: { x: 2000, y: 0 }, r: 1000, a0: 0, a1: Math.PI / 2 }),
];
api.transaction('Typ', () => doc.add({ id: 'rgt_test', cat: 'type', of: 'region', name: 'Test grün', pattern: 'solid', patColor: '#33aa55', bg: '', masking: false } as any));
const R1 = api.add<any>({ cat: 'region', viewId: v2.id, typeId: 'rgt_test', loops: [[{ x: 100, y: 100 }, { x: 1000, y: 100 }, { x: 1000, y: 800 }, { x: 100, y: 800 }]], lineStyle: 'thin' } as any);
const R2 = api.add<any>({ cat: 'region', viewId: v2.id, typeId: 'rgt_beton', loops: [[{ x: 1200, y: 100 }, { x: 1800, y: 100 }, { x: 1500, y: 900 }]], lineStyle: 'medium' } as any);
const T = (p: [number, number], s: string, rot?: number, typeId = 'txt_25') => api.add<any>({ cat: 'text', viewId: v2.id, typeId, p: { x: p[0], y: p[1] }, s, ...(rot ? { rot } : {}) } as any);
const texts0 = [T([0, 2000], 'Detail Öffnung – 1:20 ±5 °C'), T([0, 2400], 'Zeile A\nZeile B', 0, 'txt_35'), T([-800, 0], 'Höhe gedreht', Math.PI / 2)];
const sheet = api.addSheet({ no: 'T-1', name: 'Rundlauf', size: 'A3' });
const vp = api.placeView(sheet.id, v2.id, { x: 200, y: 150 });
const pdf = await api.exportPdf([sheet.id]);
assert.ok(pdf.length > 1000);
const v3 = drafting('PDF-Import', 20);
// Plan-mm → Ansicht: Modell = Anker + 20 · (Papier − Mitte)
const origin = { x: vp.anchor.x - 20 * vp.center.x, y: vp.anchor.y - 20 * vp.center.y };
const t0 = Date.now();
const r2 = importVector(doc, v3.id, pdf, { origin });
console.log(`  PDF-Rundlauf: ${r2.lines} Linien (${r2.arcs} Bögen), ${r2.regions} Bereiche, ${r2.texts} Texte in ${Date.now() - t0} ms`);
for (const l of orig) {
  const m = l.arc ? of(v3.id, 'line').find((x) => x.arc && near(x.arc.c.x, l.arc.c.x, 0.5) && near(x.arc.c.y, l.arc.c.y, 0.5) && near(x.arc.r, l.arc.r, 0.5)) : hasLine(v3.id, l.a, l.b, 0.5);
  assert.ok(m, 'Linie wiedergefunden: ' + JSON.stringify([l.a, l.b]));
  assert.deepEqual(linePen(doc, m.style), linePen(doc, l.style), 'Linienstil ' + l.style);
  if (l.arc) assert.ok(near(m.arc.a0, l.arc.a0, 1e-3) && near(m.arc.a1, l.arc.a1, 1e-3), 'Bogenwinkel');
}
const styled = (id: string) => of(v3.id, 'line').filter((x) => { const p = linePen(doc, x.style); const q = linePen(doc, id); return p.w === q.w && p.color === q.color && p.dash === q.dash; }).length;
assert.equal(styled(lsRed.id), 2); assert.equal(styled(lsBlue.id), 2); assert.equal(styled(lsMag.id), 1);
// Füllbereiche: Typ wiederverwendet (Farbe), Muster «Beton» wiedererkannt, Ränder als Begrenzungslinienstil
const g3 = of(v3.id, 'region').filter((r) => r.typeId === 'rgt_test');
assert.equal(g3.length, 1, 'grüner Bereich'); assert.equal(g3[0].lineStyle, 'thin');
assert.deepEqual(g3[0].loops[0].map(P).sort(), R1.loops[0].map(P).sort());
const b3 = of(v3.id, 'region').filter((r) => doc.get<any>(r.typeId).pattern === 'concrete');
assert.equal(b3.length, 1, 'Betonmuster erkannt'); assert.equal(b3[0].typeId, 'rgt_beton'); assert.equal(b3[0].lineStyle, 'medium');
assert.deepEqual(b3[0].loops[0].map(P).sort(), R2.loops[0].map(P).sort());
// Texte: Zeichenketten (ToUnicode), Höhe, Lage, Drehung, mehrzeilig
for (const t of texts0) {
  const m = of(v3.id, 'text').find((x) => x.s === t.s);
  assert.ok(m, 'Text wiedergefunden: ' + t.s + ' in ' + of(v3.id, 'text').map((x) => JSON.stringify(x.s)).join(', '));
  assert.equal(doc.get<any>(m.typeId).size, doc.get<any>(t.typeId).size, 'Texthöhe');
  assert.ok(near(m.p.x, t.p.x, 2) && near(m.p.y, t.p.y, 2), `Textlage ${t.s}: ${P(m.p)} statt ${P(t.p)}`);
  assert.ok(near(m.rot ?? 0, t.rot ?? 0, 1e-3), 'Textdrehung');
}
// nur die Zeichnung (ohne Plankopf): gleiche Anzahl Elemente
const pdfV = await api.exportPdf([v2.id]);
const pg = pageOf(doc, v2)!;
const v4 = drafting('PDF-Ansicht', 20);
const r4 = importVector(doc, v4.id, pdfV, { origin: { x: pg.box.min.x - 20 * 10, y: pg.box.max.y - 20 * (pg.h - 10) } });
assert.equal(r4.lines, orig.length, 'Linien'); assert.equal(r4.arcs, 1); assert.equal(r4.regions, 2, 'Bereiche'); assert.equal(r4.texts, texts0.length, 'Texte');
assert.ok(hasLine(v4.id, { x: 0, y: 0 }, { x: 2000, y: 0 }, 0.5), 'Lage ohne Plan');

// ------------------------------------------------------------ (c) DXF: Linientypen und Linienstärken → Linienstile
const dxf = (rows: (string | number)[][]) => rows.map(([c, v]) => `${String(c).padStart(3, ' ')}\n${v}`).join('\n') + '\n';
const ltype = (name: string, pat: number[]) => [[0, 'LTYPE'], [2, name], [70, 0], [3, name], [72, 65], [73, pat.length], [40, pat.reduce((s, v) => s + Math.abs(v), 0)], ...pat.map((v) => [49, v])];
const layer = (name: string, col: number, lt: string, lw: number) => [[0, 'LAYER'], [2, name], [70, 0], [62, col], [6, lt], [370, lw]];
const text = dxf([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$INSUNITS'], [70, 4], [9, '$LTSCALE'], [40, 1], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'TABLES'],
  [0, 'TABLE'], [2, 'LTYPE'], [70, 3], ...ltype('CONTINUOUS', []), ...ltype('STRICH', [60, -30]), ...ltype('XYZ', [160, -30, 20, -30]), [0, 'ENDTAB'],
  [0, 'TABLE'], [2, 'LAYER'], [70, 3], ...layer('0', 7, 'CONTINUOUS', -3), ...layer('Wand', 1, 'CONTINUOUS', 50), ...layer('Achsen', 5, 'XYZ', 18), [0, 'ENDTAB'],
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LINE'], [8, 'Wand'], [10, 0], [20, 0], [11, 3000], [21, 0],
  [0, 'LINE'], [8, 'Achsen'], [10, 0], [20, -500], [11, 0], [21, 2500],
  [0, 'LINE'], [8, '0'], [6, 'STRICH'], [62, 3], [370, 35], [10, 0], [20, 1000], [11, 3000], [21, 1000],
  [0, 'ARC'], [8, 'Wand'], [10, 3000], [20, 1000], [40, 1000], [50, 270], [51, 90],
  [0, 'CIRCLE'], [8, 'Achsen'], [10, 1500], [20, 500], [40, 200],
  [0, 'TEXT'], [8, '0'], [10, 100], [20, 1200], [40, 50], [1, 'Wand Ost %%c 20'],
  [0, 'SOLID'], [8, '0'], [62, 2], [10, 200], [20, 100], [11, 800], [21, 100], [12, 200], [22, 400], [13, 800], [23, 400],
  [0, 'ENDSEC'], [0, 'EOF'],
]);
const cad = parseDxf(text);
assert.equal(cad.ltypes.length, 2, 'Linientypen: ' + JSON.stringify(cad.ltypes));
assert.equal(cad.ents.find((e) => e.t === 'l' && e.L === cad.layers.indexOf('Wand'))?.w, 50, 'Linienstärke VonLayer');
const v5 = drafting('DXF-Import', 20);
const r5 = importVector(doc, v5.id, text, { format: 'dxf' });
assert.equal(r5.regions, 1); assert.equal(r5.texts, 1);
const wand = hasLine(v5.id, { x: 0, y: 0 }, { x: 3000, y: 0 });
assert.deepEqual(linePen(doc, wand.style), { w: 6, color: '#ff0000' }, 'Layer Wand: rot 0,50 mm');
const achse = hasLine(v5.id, { x: 0, y: -500 }, { x: 0, y: 2500 });
assert.deepEqual(linePen(doc, achse.style), { w: 3, color: '#0000ff', dash: 'center' }, 'Layer Achsen: Linientyp aus Muster');
const strich = hasLine(v5.id, { x: 0, y: 1000 }, { x: 3000, y: 1000 });
assert.deepEqual(linePen(doc, strich.style), { w: 5, color: '#00ff00', dash: 'dash' }, 'Element: STRICH, 0,35 mm, grün');
const arcs5 = of(v5.id, 'line').filter((l) => l.arc);
assert.equal(arcs5.length, 3, 'Bogen + Kreis (zwei Hälften)');
assert.ok(arcs5.some((l) => near(l.arc.r, 1000) && near(l.arc.c.x, 3000) && linePen(doc, l.style).w === 6));
const tx5 = of(v5.id, 'text')[0]; assert.equal(tx5.s, 'Wand Ost Ø 20'); assert.equal(doc.get<any>(tx5.typeId).size, 2.5);
assert.equal(doc.get<any>(of(v5.id, 'region')[0].typeId).patColor, '#ffff00');
// Auflösen eines CAD-Imports (Farbmodus «Beibehalten»)
const v6 = drafting('DXF-Auflösen', 20);
const ci = api.transaction('CAD', () => doc.add<any>({ id: 'ci_test', cat: 'cadimport', viewId: v6.id, name: 'test.dxf', unit: 1, offset: cad.base, rotation: 0, base: cad.base, box: cad.box, entities: cad.ents, layers: cad.layers, hiddenLayers: [], ltypes: cad.ltypes, colors: 'keep' } as any));
const r6 = explodeCad(doc, [ci.id])!;
assert.ok(!doc.get(ci.id), 'Import entfernt');
assert.equal(r6.lines, r5.lines); assert.equal(r6.regions, 1); assert.equal(r6.texts, 1);
assert.deepEqual(linePen(doc, hasLine(v6.id, { x: 0, y: -500 }, { x: 0, y: 2500 }).style), { w: 3, color: '#0000ff', dash: 'center' });
console.log(`  DXF: ${r5.lines} Linien (${r5.arcs} Bögen), ${r5.regions} Bereiche, ${r5.texts} Texte`);

// ------------------------------------------------------------ (d) PDF 1.5: Objektstrom + Querverweisstrom (PNG-Prädiktor), WinAnsi-Text
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const content = zlibSync(enc('0.5 w 1 0 0 RG 72 72 m 144 144 l S 0 0 1 rg 200 200 100 50 re f\nBT /F1 12 Tf 100 700 Td (Gr\\374\\337e) Tj ET'));
const inner = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
const ids = [1, 2, 3, 6]; let hdr = ''; let body = ''; for (let i = 0; i < inner.length; i++) { hdr += `${ids[i]} ${body.length} `; body += inner[i] + '\n'; }
const stm = zlibSync(enc(hdr + body));
const offs: number[] = []; const parts: Uint8Array[] = [enc('%PDF-1.5\n')]; let pos = parts[0].length;
const put = (b: Uint8Array) => { parts.push(b); pos += b.length; };
offs[4] = pos; put(cat([enc(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, enc('\nendstream\nendobj\n')]));
offs[5] = pos; put(cat([enc(`5 0 obj\n<< /Type /ObjStm /N 4 /First ${hdr.length} /Length ${stm.length} /Filter /FlateDecode >>\nstream\n`), stm, enc('\nendstream\nendobj\n')]));
offs[7] = pos;
// Querverweiszeilen (Typ 1 B, Feld 2: 4 B, Feld 3: 2 B), PNG-«Up»-Prädiktor
const rows: number[][] = [];
for (let i = 0; i < 8; i++) {
  const t = i === 4 || i === 5 || i === 7 ? 1 : i === 0 ? 0 : 2; const f2 = t === 1 ? offs[i] : t === 2 ? 5 : 0; const f3 = t === 2 ? ids.indexOf(i) : 0;
  rows.push([t, (f2 >>> 24) & 255, (f2 >>> 16) & 255, (f2 >>> 8) & 255, f2 & 255, (f3 >> 8) & 255, f3 & 255]);
}
const pred: number[] = []; rows.forEach((r, i) => { pred.push(2); r.forEach((v, k) => pred.push((v - (i ? rows[i - 1][k] : 0)) & 255)); });
const xs = zlibSync(new Uint8Array(pred));
put(cat([enc(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${xs.length} >>\nstream\n`), xs, enc(`\nendstream\nendobj\nstartxref\n${offs[7]}\n%%EOF\n`)]));
const pdf15 = cat(parts);
const v7 = drafting('PDF 1.5', 1);
const r7 = importVector(doc, v7.id, pdf15);
assert.equal(r7.lines, 1); assert.equal(r7.regions, 1); assert.equal(r7.texts, 1);
const K = 25.4 / 72;
assert.ok(hasLine(v7.id, { x: 72 * K, y: 72 * K }, { x: 144 * K, y: 144 * K }, 0.01), 'Linie in mm');
assert.deepEqual(linePen(doc, of(v7.id, 'line')[0].style), { w: 3, color: '#ff0000' }, '0,5 pt rot');
const tx7 = of(v7.id, 'text')[0]; assert.equal(tx7.s, 'Grüße', 'WinAnsi'); assert.equal(doc.get<any>(tx7.typeId).size, 4.23);
assert.equal(doc.get<any>(of(v7.id, 'region')[0].typeId).patColor, '#0000ff');

// ------------------------------------------------------------ (e) Zuschneiden (Polygon) und Überdecken durch spätere Füllungen
const svgClip = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
  <clipPath id="dreieck"><path d="M10 90 L90 90 L50 10 Z"/></clipPath>
  <g clip-path="url(#dreieck)" stroke="#000" stroke-width="0.1">${Array.from({ length: 20 }, (_, i) => `<line x1="0" y1="${i * 5}" x2="100" y2="${i * 5}"/>`).join('')}</g>
  <line x1="0" y1="95" x2="100" y2="95" stroke="#000" stroke-width="0.25"/>
  <rect x="40" y="92" width="20" height="6" fill="#808080"/>
</svg>`;
const v8 = drafting('Zuschneiden', 1);
importVector(doc, v8.id, svgClip);
const inTri = (p: { x: number; y: number }) => { const y = 100 - p.y; return y >= 10 - 1e-6 && y <= 90 + 1e-6 && Math.abs(p.x - 50) <= ((y - 10) / 80) * 40 + 1e-6; };
const hatch = of(v8.id, 'line').filter((l) => linePen(doc, l.style).w === 1);
assert.equal(hatch.length, 16, 'Schraffurlinien im Dreieck'); assert.ok(hatch.every((l) => inTri(l.a) && inTri(l.b)), 'auf das Dreieck zugeschnitten');
const cut = of(v8.id, 'line').filter((l) => linePen(doc, l.style).w === 4);
assert.equal(cut.length, 2, 'Linie unter späterer Füllung unterbrochen'); assert.ok(cut.every((l) => l.a.x <= 40 + 1e-6 || l.a.x >= 60 - 1e-6));
