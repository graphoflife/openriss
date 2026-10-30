// Vorlage: Materialien (falls fehlend) und Typen für Geschossdecken, Dächer, Decken, Treppen,
// Geländer und Bauteile. Läuft über den Hook 'template' (neues Projekt) bzw. 'loaded' (ältere Projekte).
import type { Doc, El } from '../../core/doc';
import { onHook } from '../../core/registry';
import type { Material } from '../../core/view';
import type { Layer } from './common';

function mat(doc: Doc, id: string, name: string, color: string, cutPattern: string, extra: Partial<Material> = {}): void {
  if (!doc.get(id)) doc.add({ id, cat: 'material', name, color, cutPattern, ...extra } as Material);
}
function type(doc: Doc, el: Record<string, any>): void { if (!doc.get(el.id)) doc.add({ cat: 'type', ...el } as El); }
const L = (m: string, t: number, fn: Layer['fn'], core = false): Layer => ({ mat: m, t, fn, core });

export function addArchTemplate(doc: Doc): void {
  // Materialien (nur ergänzen)
  mat(doc, 'm_stb', 'Stahlbeton C30/37', '#a9a9a9', 'rc', { density: 2500 });
  mat(doc, 'm_estrich', 'Zementestrich', '#d9d3c7', 'screed', { density: 2000 });
  mat(doc, 'm_daemm', 'Wärmedämmung EPS/Mineralwolle', '#f7e98e', 'insulation', { density: 30 });
  mat(doc, 'm_fliese', 'Fliesen', '#e8eef2', '', { density: 2000 });
  mat(doc, 'm_gk', 'Gipskarton', '#f4f4f4', 'gypsum', { density: 900 });
  mat(doc, 'm_dach', 'Dachziegel', '#a0522d', '', { density: 600 });
  mat(doc, 'm_kies', 'Kies', '#b0a890', 'gravel', { density: 1800 });
  mat(doc, 'm_holz', 'Holz - Nadelholz', '#c8a070', 'wood', { density: 500 });
  mat(doc, 'm_stahl', 'Stahl S235', '#7a8590', 'solid', { cutColor: '#303030', density: 7850 });
  mat(doc, 'm_bitumen', 'Abdichtung Bitumenbahn', '#3a3a3a', 'solid', { cutColor: '#202020', density: 1100 });
  mat(doc, 'm_mineralfaser', 'Mineralfaserplatte', '#f0eee6', 'sand', { density: 300 });
  mat(doc, 'm_dachaufbau', 'Dachziegel mit Lattung', '#a0522d', 'diagRev', { density: 600 });
  mat(doc, 'm_sparren', 'Sparren mit Zwischensparrendämmung', '#e9d58a', 'insulation', { density: 120 });
  mat(doc, 'm_keramik', 'Sanitärkeramik', '#fafafa', 'solid', { cutColor: '#d8d8d8', density: 2300 });
  mat(doc, 'm_moebel', 'Möbel (Holzwerkstoff)', '#d8c4a0', 'wood', { density: 650 });

  // Geschossdecken (Schichten von oben nach unten)
  type(doc, { id: 'flt_aufbau', of: 'floor', name: 'Fußbodenaufbau 15 cm + STB 20', function: 'interior', layers: [L('m_fliese', 15, 'finish'), L('m_estrich', 65, 'substrate'), L('m_daemm', 70, 'thermal'), L('m_stb', 200, 'structure', true)] });
  type(doc, { id: 'flt_stb20', of: 'floor', name: 'STB-Decke 20', function: 'interior', layers: [L('m_stb', 200, 'structure', true)] });
  type(doc, { id: 'flt_stb25', of: 'floor', name: 'STB-Decke 25', function: 'interior', layers: [L('m_stb', 250, 'structure', true)] });
  type(doc, { id: 'flt_bodenplatte', of: 'floor', name: 'Bodenplatte 25', function: 'exterior', layers: [L('m_stb', 250, 'structure', true)] });
  type(doc, { id: 'flt_bodenplatte_aufbau', of: 'floor', name: 'Fußbodenaufbau 15 cm + Bodenplatte 25', function: 'exterior', layers: [L('m_fliese', 15, 'finish'), L('m_estrich', 65, 'substrate'), L('m_daemm', 70, 'thermal'), L('m_stb', 250, 'structure', true)] });

  // Dächer (oben → unten)
  type(doc, { id: 'rft_ziegel', of: 'roof', name: 'Steildach Ziegel 30', layers: [L('m_dachaufbau', 60, 'finish'), L('m_sparren', 220, 'structure', true), L('m_gk', 20, 'finish')] });
  type(doc, { id: 'rft_flach', of: 'roof', name: 'Flachdach Warmdach 35', layers: [L('m_kies', 50, 'finish'), L('m_bitumen', 10, 'membrane'), L('m_daemm', 140, 'thermal'), L('m_stb', 150, 'structure', true)] });
  type(doc, { id: 'rft_holz', of: 'roof', name: 'Dach Holz generisch 20', layers: [L('m_holz', 200, 'structure', true)] });

  // Decken (abgehängt)
  type(doc, { id: 'clt_gk', of: 'ceiling', name: 'GK-Decke 12,5', gridX: 1250, gridY: 2000, layers: [L('m_gk', 12.5, 'finish', true)] });
  type(doc, { id: 'clt_gk2', of: 'ceiling', name: 'GK-Decke 2 x 12,5', gridX: 1250, gridY: 2000, layers: [L('m_gk', 25, 'finish', true)] });
  type(doc, { id: 'clt_raster625', of: 'ceiling', name: 'Rasterdecke 625 x 625', gridX: 625, gridY: 625, layers: [L('m_mineralfaser', 15, 'finish', true)] });
  type(doc, { id: 'clt_raster600', of: 'ceiling', name: 'Rasterdecke 600 x 600', gridX: 600, gridY: 600, layers: [L('m_mineralfaser', 15, 'finish', true)] });

  // Treppen
  type(doc, { id: 'stt_stb', of: 'stair', name: 'Ortbetontreppe', construction: 'massiv', mat: 'm_stb', waist: 160, landingThick: 200 });
  type(doc, { id: 'stt_holz', of: 'stair', name: 'Holztreppe (Wangentreppe)', construction: 'wange', mat: 'm_holz', waist: 60, landingThick: 120, treadThick: 40 });

  // Geländer
  const rl = (id: string, name: string, h: number, bal: boolean) => type(doc, { id, of: 'railing', name, height: h, postSpacing: 1000, postSize: 40, railW: 50, railH: 40, balusters: bal, balusterSpacing: 120, mat: 'm_stahl' });
  rl('rlt_900', 'Geländer 900', 900, true);
  rl('rlt_1000', 'Geländer 1000', 1000, true);
  rl('rlt_1100', 'Geländer 1100', 1100, true);
  rl('rlt_handlauf', 'Handlauf 900 (ohne Füllstäbe)', 900, false);

  // Bauteile
  const cp = (id: string, family: string, name: string, sym: string, width: number, depth: number, height: number, m = 'm_moebel') =>
    type(doc, { id, of: 'component', family, name, sym, width, depth, height, mat: m });
  cp('cpt_tisch160', 'Möbel', 'Tisch 160 x 90', 'table', 1600, 900, 750);
  cp('cpt_tisch80', 'Möbel', 'Tisch 80 x 80', 'table', 800, 800, 750);
  cp('cpt_stuhl', 'Möbel', 'Stuhl', 'chair', 450, 500, 900);
  cp('cpt_bett90', 'Möbel', 'Bett 90 x 200', 'bed', 900, 2000, 450);
  cp('cpt_bett180', 'Möbel', 'Bett 180 x 200', 'bed', 1800, 2000, 450);
  cp('cpt_schrank100', 'Möbel', 'Schrank 100 x 60', 'wardrobe', 1000, 600, 2100);
  cp('cpt_schrank200', 'Möbel', 'Schrank 200 x 60', 'wardrobe', 2000, 600, 2100);
  cp('cpt_sofa', 'Möbel', 'Sofa 3-Sitzer', 'sofa', 2100, 900, 800);
  cp('cpt_wc', 'Sanitär', 'WC wandhängend', 'wc', 380, 600, 800, 'm_keramik');
  cp('cpt_waschtisch', 'Sanitär', 'Waschtisch 60', 'basin', 600, 480, 850, 'm_keramik');
  cp('cpt_dusche', 'Sanitär', 'Dusche 90 x 90', 'shower', 900, 900, 50, 'm_keramik');
  cp('cpt_badewanne', 'Sanitär', 'Badewanne 170 x 75', 'bathtub', 1700, 750, 600, 'm_keramik');
  cp('cpt_kueche', 'Küche', 'Küchenzeile 270', 'kitchen', 2700, 600, 2200);
  cp('cpt_herd', 'Küche', 'Herd 60', 'stove', 600, 600, 900);
  cp('cpt_spuele', 'Küche', 'Spüle 100', 'sink', 1000, 600, 900);
  cp('cpt_kuehlschrank', 'Küche', 'Kühlschrank 60', 'fridge', 600, 600, 1850);
  cp('cpt_pflanze', 'Bepflanzung', 'Pflanze', 'plant', 600, 600, 1200);
  cp('cpt_baum', 'Bepflanzung', 'Baum', 'tree', 5000, 5000, 8000);
}

const CATS = ['floor', 'roof', 'ceiling', 'stair', 'railing', 'component'];
onHook('template', (doc: Doc) => addArchTemplate(doc));
// Ältere Projekte ohne diese Typen ergänzen
onHook('loaded', (doc: Doc) => {
  const have = new Set(doc.all('type').map((t) => t.of));
  if (CATS.every((c) => have.has(c))) return;
  doc.transaction('Vorlage ergänzen', () => addArchTemplate(doc));
  doc.clearHistory();
});
