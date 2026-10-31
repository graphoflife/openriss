// Projektvorlage: Materialien, Wand-/Tür-/Fenstertypen, Ebenen und Standardansichten.
// Module (Decken, Bewehrung …) ergänzen ihre Typen über den Hook 'template'.
import { Doc, El, newId } from './doc';
import { emitHook } from './registry';
import type { View, Level, Material, ProjectInfo } from './view';
import { DEFAULT_RANGE } from './view';

export function mat(doc: Doc, id: string, name: string, color: string, cutPattern?: string, extra: Partial<Material> = {}): Material {
  return doc.add<Material>({ id, cat: 'material', name, color, cutPattern, ...extra } as Material);
}

export function createPlanViews(doc: Doc, lvl: Level, discipline: 'arch' | 'struct' = 'arch'): View[] {
  const v1 = doc.add<View>({
    id: newId('vw'), cat: 'view', kind: 'plan', name: lvl.name, scale: 100, detail: 'medium', levelId: lvl.id,
    range: { ...DEFAULT_RANGE }, discipline,
  } as View);
  const v2 = doc.add<View>({
    id: newId('vw'), cat: 'view', kind: 'ceiling', name: lvl.name, scale: 100, detail: 'medium', levelId: lvl.id,
    range: { top: 3000, cut: 2300, bottom: 2300, depth: 3000 }, discipline,
  } as View);
  return [v1, v2];
}

export function newProject(doc: Doc): void {
  doc.load({ elements: [] });
  doc.transaction('Neues Projekt', () => {
    doc.add<ProjectInfo>({
      id: 'project', cat: 'project', name: 'Neues Projekt', number: '0001', client: 'Bauherr', address: '', author: '',
      status: 'Entwurf', date: new Date().toLocaleDateString('de-DE'), rebarCover: 30,
    } as ProjectInfo);
    // Materialien
    mat(doc, 'm_beton', 'Beton - Ortbeton C25/30', '#bdbdbd', 'concrete', { density: 2400 });
    mat(doc, 'm_stb', 'Stahlbeton C30/37', '#a9a9a9', 'rc', { density: 2500 });
    mat(doc, 'm_ks', 'Kalksandstein', '#e3dccf', 'diag', { density: 1800 });
    mat(doc, 'm_ziegel', 'Mauerwerk Ziegel', '#c97a5b', 'diag', { density: 1400 });
    mat(doc, 'm_porenbeton', 'Porenbeton', '#e8e8e8', 'diagWide', { density: 500 });
    mat(doc, 'm_daemm', 'Wärmedämmung EPS/Mineralwolle', '#f7e98e', 'insulation', { density: 30 });
    mat(doc, 'm_putz', 'Putz', '#f2efe6', 'sand', { density: 1600 });
    mat(doc, 'm_gk', 'Gipskarton', '#f4f4f4', 'gypsum', { density: 900 });
    mat(doc, 'm_estrich', 'Zementestrich', '#d9d3c7', 'screed', { density: 2000 });
    mat(doc, 'm_holz', 'Holz - Nadelholz', '#c8a070', 'wood', { density: 500 });
    mat(doc, 'm_stahl', 'Stahl S235', '#7a8590', 'solid', { cutColor: '#303030', density: 7850 });
    mat(doc, 'm_glas', 'Glas', '#a8d0e8', '', { transparency: 0.6, density: 2500 });
    mat(doc, 'm_kies', 'Kies', '#b0a890', 'gravel', { density: 1800 });
    mat(doc, 'm_erde', 'Erdreich', '#8a7356', 'earth', { density: 1800 });
    mat(doc, 'm_dach', 'Dachziegel', '#a0522d', '', { density: 600 });
    mat(doc, 'm_fliese', 'Fliesen', '#e8eef2', '', { density: 2000 });
    mat(doc, 'm_kunststoff', 'Kunststoff weiß', '#f6f6f6', 'solid', { cutColor: '#d0d0d0' });
    mat(doc, 'm_alu', 'Aluminium', '#c0c4c8', 'solid', { cutColor: '#909090' });

    // Wandtypen (Schichten von außen nach innen)
    const wt = (id: string, name: string, layers: [string, number, string, boolean?][], fn: string = 'exterior', extra: Partial<El> = {}) =>
      doc.add({ id, cat: 'type', of: 'wall', name, function: fn, layers: layers.map(([m, t, f, core]) => ({ mat: m, t, fn: f, core: !!core })), ...extra });
    wt('wt_aw365', 'AW 36,5 Ziegel verputzt', [['m_putz', 20, 'finish'], ['m_ziegel', 365, 'structure', true], ['m_putz', 15, 'finish']]);
    wt('wt_awwdvs', 'AW 17,5 KS + 16 WDVS', [['m_putz', 10, 'finish'], ['m_daemm', 160, 'thermal'], ['m_ks', 175, 'structure', true], ['m_putz', 15, 'finish']]);
    wt('wt_stb25', 'STB 25', [['m_stb', 250, 'structure', true]], 'exterior');
    wt('wt_stb20', 'STB 20', [['m_stb', 200, 'structure', true]], 'interior');
    wt('wt_iw24', 'IW 24 KS', [['m_putz', 10, 'finish'], ['m_ks', 240, 'structure', true], ['m_putz', 10, 'finish']], 'interior');
    wt('wt_iw175', 'IW 17,5 KS', [['m_putz', 10, 'finish'], ['m_ks', 175, 'structure', true], ['m_putz', 10, 'finish']], 'interior');
    wt('wt_iw115', 'IW 11,5 KS', [['m_putz', 10, 'finish'], ['m_ks', 115, 'structure', true], ['m_putz', 10, 'finish']], 'interior');
    wt('wt_gk100', 'GK 100 Ständerwand', [['m_gk', 12.5, 'finish'], ['m_daemm', 75, 'thermal', true], ['m_gk', 12.5, 'finish']], 'interior');
    wt('wt_basic200', 'Basiswand 20', [['m_beton', 200, 'structure', true]], 'exterior');

    // Türtypen (Rohbaumaße)
    const dt = (id: string, name: string, width: number, height: number, kind: string, extra: Partial<El> = {}) =>
      doc.add({ id, cat: 'type', of: 'door', name, width, height, kind, frame: 50, leafT: 40, mat: 'm_holz', ...extra });
    dt('dt_885', 'Tür 885 x 2010', 885, 2010, 'single');
    dt('dt_1010', 'Tür 1010 x 2135', 1010, 2135, 'single');
    dt('dt_760', 'Tür 760 x 2010', 760, 2010, 'single');
    dt('dt_1760', 'Tür zweiflügelig 1760 x 2135', 1760, 2135, 'double');
    dt('dt_schiebe', 'Schiebetür 1010 x 2135', 1010, 2135, 'sliding');
    dt('dt_durchgang', 'Durchgang 1010 x 2135', 1010, 2135, 'opening');
    dt('dt_rolltor', 'Rolltor 4500 x 2400', 4500, 2400, 'roll', { frame: 80, leafT: 60, mat: 'm_stahl' });
    dt('dt_sektional', 'Sektionaltor 2500 x 2125', 2500, 2125, 'sectional', { frame: 80, leafT: 45, mat: 'm_stahl' });
    dt('dt_lift', 'Lifttür Teleskop 900 x 2100', 900, 2100, 'lift', { frame: 60, leafT: 30, mat: 'm_stahl' });

    // Fenstertypen
    const ft = (id: string, name: string, width: number, height: number, sill: number, kind: string) =>
      doc.add({ id, cat: 'type', of: 'window', name, width, height, sill, kind, frame: 70, frameDepth: 80, sillDepth: 200, mat: 'm_kunststoff', glassMat: 'm_glas' });
    ft('ft_1010', 'Fenster 1010 x 1385', 1010, 1385, 885, 'single');
    ft('ft_1260', 'Fenster 1260 x 1385', 1260, 1385, 885, 'double');
    ft('ft_885', 'Fenster 885 x 1135', 885, 1135, 1010, 'single');
    ft('ft_2010', 'Fenster 2010 x 1385', 2010, 1385, 885, 'triple');
    ft('ft_tuer', 'Fenstertür 1010 x 2260', 1010, 2260, 0, 'single');
    ft('ft_fest', 'Festverglasung 1500 x 1500', 1500, 1500, 750, 'fixed');

    // Ebenen
    const eg = doc.add<Level>({ id: 'lvl_eg', cat: 'level', name: 'Erdgeschoss', elev: 0, story: true } as Level);
    const og = doc.add<Level>({ id: 'lvl_og', cat: 'level', name: '1. Obergeschoss', elev: 3000, story: true } as Level);
    createPlanViews(doc, eg);
    createPlanViews(doc, og);

    // Ansichten (Gebäudeansichten) um den Ursprung
    const elev = (name: string, ox: number, oy: number, dx: number, dy: number, marker: string) =>
      doc.add<View>({
        id: newId('vw'), cat: 'view', kind: 'elevation', name, scale: 100, detail: 'coarse',
        origin: { x: ox, y: oy, z: 0 }, dir: { x: dx, y: dy }, far: 60000,
        crop: { on: false, show: false, min: { x: -20000, y: -2000 }, max: { x: 20000, y: 12000 } }, data: { marker },
      } as View);
    elev('Süd', 5000, -6000, 0, 1, 'S');
    elev('Nord', 5000, 16000, 0, -1, 'N');
    elev('Ost', 18000, 5000, -1, 0, 'O');
    elev('West', -8000, 5000, 1, 0, 'W');
    doc.add<View>({ id: newId('vw'), cat: 'view', kind: '3d', name: '{3D}', scale: 100, detail: 'medium', style: 'shaded' } as View);
    emitHook('template', doc);
  });
}
