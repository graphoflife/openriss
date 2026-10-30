// Vorlagen-Typen der Beschriftungen (Bemaßung, Höhenkote, Text, Beschriftung, Raumstempel,
// Füllbereich, Detailbauteil). Werden beim neuen Projekt (Hook 'template') und bei Bedarf ergänzt.
import type { Doc } from '../../core/doc';
import { onHook } from '../../core/registry';
import { addType, registerTypeMaker } from './common';

export const DIM_DEFAULT = 'dimt_s25';
export const DIM_ARROW = 'dimt_arrow';

function dimTypes(doc: Doc): void {
  const base = { tick: 'slash', tickSize: 2.5, tickW: 5, lineW: 1, color: '#000000', size: 2.5, font: 'Arial', textGap: 0.7, wGap: 1.5, wExt: 1.5, dimExt: 1.5, unit: '', dec: 2, opaque: false, bold: false };
  addType(doc, 'dimt_s25', 'dimension', 'Schrägstrich 2,5 mm Arial', base);
  addType(doc, 'dimt_s35', 'dimension', 'Schrägstrich 3,5 mm Arial', { ...base, size: 3.5, tickSize: 3 });
  addType(doc, 'dimt_m', 'dimension', 'Schrägstrich 2,5 mm Arial (m)', { ...base, unit: 'm', dec: 2 });
  addType(doc, 'dimt_cm', 'dimension', 'Schrägstrich 2,5 mm Arial (cm)', { ...base, unit: 'cm', dec: 1 });
  addType(doc, 'dimt_dot', 'dimension', 'Punkt 2,5 mm Arial', { ...base, tick: 'dot', tickSize: 2.5 });
  addType(doc, 'dimt_arrow', 'dimension', 'Pfeil 2,5 mm Arial', { ...base, tick: 'arrow', tickSize: 2.5, tickW: 1, dimExt: 0 });
}

function spotTypes(doc: Doc): void {
  const base = { symbol: 'half', symSize: 2.5, size: 2.5, prefix: '', dec: 2, color: '#000000', font: 'Arial' };
  addType(doc, 'spt_std', 'spot', 'Höhenkote', base);
  addType(doc, 'spt_okff', 'spot', 'Höhenkote OKFF (Fertigmaß)', { ...base, symbol: 'filled', prefix: 'OKFF ' });
  addType(doc, 'spt_okrd', 'spot', 'Höhenkote OKRD (Rohbaumaß)', { ...base, symbol: 'open', prefix: 'OKRD ' });
  addType(doc, 'spt_plan', 'spot', 'Höhenkote Grundriss (Kreis)', { ...base, symbol: 'circle' });
  addType(doc, 'spt_coord', 'spot', 'Koordinate (O/N)', { ...base, symbol: 'cross', dec: 3 });
}

function textTypes(doc: Doc): void {
  const base = { size: 2.5, font: 'Arial', bold: false, italic: false, underline: false, color: '#000000', opaque: false, box: false, leaderArrow: 'arrow', arrowSize: 2.5 };
  addType(doc, 'txt_25', 'text', 'Text 2,5 mm Arial', base);
  addType(doc, 'txt_35', 'text', 'Text 3,5 mm Arial', { ...base, size: 3.5 });
  addType(doc, 'txt_35b', 'text', 'Text 3,5 mm Arial fett', { ...base, size: 3.5, bold: true });
  addType(doc, 'txt_5', 'text', 'Text 5 mm Arial', { ...base, size: 5 });
}

function tagTypes(doc: Doc): void {
  const base = { shape: 'auto', content: 'auto', size: 2.5, font: 'Arial', color: '#000000', leaderArrow: 'none', arrowSize: 2 };
  addType(doc, 'tagt_std', 'tag', 'Beschriftung Standard', base);
  addType(doc, 'tagt_circle', 'tag', 'Beschriftung Kreis', { ...base, shape: 'circle' });
  addType(doc, 'tagt_rect', 'tag', 'Beschriftung Rechteck', { ...base, shape: 'rect' });
  addType(doc, 'tagt_plain', 'tag', 'Beschriftung ohne Rahmen', { ...base, shape: 'none' });
  addType(doc, 'tagt_mark', 'tag', 'Kennzeichen (Rechteck)', { ...base, shape: 'rect', content: 'mark' });
}

function roomTagTypes(doc: Doc): void {
  const base = { showName: true, showNumber: true, showArea: true, frame: true, nameSize: 3.5, size: 2.5, font: 'Arial', color: '#000000', areaPrefix: '' };
  addType(doc, 'rtt_std', 'roomtag', 'Raumstempel', base);
  addType(doc, 'rtt_free', 'roomtag', 'Raumstempel ohne Rahmen', { ...base, frame: false });
  addType(doc, 'rtt_name', 'roomtag', 'Raumname und Nummer', { ...base, frame: false, showArea: false });
}

function regionTypes(doc: Doc): void {
  const r = (id: string, name: string, pattern: string, patColor = '#000000', extra: Record<string, any> = {}) =>
    addType(doc, id, 'region', name, { pattern, patColor, bg: '', masking: false, ...extra });
  r('rgt_beton', 'Beton', 'concrete');
  r('rgt_stb', 'Stahlbeton', 'rc');
  r('rgt_mw', 'Mauerwerk', 'diag');
  r('rgt_daemm', 'Dämmung', 'insulation');
  r('rgt_erde', 'Erdreich', 'earth', '#5a4a36');
  r('rgt_kies', 'Kies', 'gravel', '#505050');
  r('rgt_grau', 'Vollfüllung grau', 'solid', '#a8a8a8');
  r('rgt_mask', 'Maskierungsbereich', '', '#000000', { bg: '#ffffff', masking: true });
}

function detailTypes(doc: Doc): void {
  addType(doc, 'dct_break', 'detail', 'Bruchlinie', { kind: 'break', zig: 3, mask: 0 });
  addType(doc, 'dct_seal', 'detail', 'Abdichtung', { kind: 'seal', thick: 5 });
  addType(doc, 'dct_l3050', 'detail', 'Holzlatte 30/50', { kind: 'batten', width: 30, height: 50 });
  addType(doc, 'dct_l4060', 'detail', 'Holzlatte 40/60', { kind: 'batten', width: 40, height: 60 });
  addType(doc, 'dct_kh60120', 'detail', 'Kantholz 60/120', { kind: 'batten', width: 60, height: 120 });
}

registerTypeMaker('dimension', dimTypes);
registerTypeMaker('spot', spotTypes);
registerTypeMaker('text', textTypes);
registerTypeMaker('tag', tagTypes);
registerTypeMaker('roomtag', roomTagTypes);
registerTypeMaker('region', regionTypes);
registerTypeMaker('detail', detailTypes);

onHook('template', (doc: Doc) => {
  dimTypes(doc); spotTypes(doc); textTypes(doc); tagTypes(doc); roomTagTypes(doc); regionTypes(doc); detailTypes(doc);
});
