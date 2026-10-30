// Landesvorlage (Deutschland / Schweiz): Vorgaben für Bemaßungstyp, Höhenkoten und Plankopf.
// DOM-frei – auch für Skripte: applyLocale(doc, 'CH', { retype: true, elev00: 452.30 }).
import type { Doc, Id } from '../../core/doc';
import { projectInfo } from '../../core/view';
import { chDimTypes, chSpotTypes } from './types';

export type Locale = 'DE' | 'CH';

/** Typzuordnung der Standardtypen beim Umstellen vorhandener Bemaßungen/Koten */
const RETYPE: Record<Locale, Record<Id, Id>> = {
  CH: {
    dimt_s25: 'dimt_ch', dimt_m: 'dimt_ch', dimt_cm: 'dimt_ch', dimt_dot: 'dimt_ch', dimt_s35: 'dimt_ch35',
    spt_std: 'spt_ch_roh', spt_okrd: 'spt_ch_roh', spt_okff: 'spt_ch_fertig', spt_box: 'spt_ch_box',
  },
  DE: {
    dimt_ch: 'dimt_s25', dimt_ch35: 'dimt_s35',
    spt_ch_roh: 'spt_okrd', spt_ch_uk: 'spt_std', spt_ch_fertig: 'spt_okff', spt_ch_box: 'spt_box',
  },
};

export interface LocaleOpts {
  /** vorhandene Bemaßungen/Koten mit Standardtypen auf die Typen der Landesvorlage umstellen */
  retype?: boolean;
  /** Höhenbezug ±0.00 = … m ü. M. setzen */
  elev00?: number;
}

/**
 * Landesvorlage setzen: ProjectInfo.locale, fehlende Typen (CH-Bemaßung «1.82⁵», CH-Koten, Koten-Kästchen)
 * ergänzen, optional vorhandene Elemente umstellen. Plankopf und Werkzeug-Vorgaben folgen der Landesvorlage
 * automatisch (ProjectInfo.titleBlock überschreibt den Plankopf). Läuft in einer (ggf. verschachtelten) Transaktion.
 */
export function applyLocale(doc: Doc, loc: Locale, opts: LocaleOpts = {}): { dims: number; spots: number } {
  return doc.transaction('Landesvorlage', () => {
    const pi = projectInfo(doc);
    const patch: Record<string, any> = {};
    if ((pi?.locale ?? 'DE') !== loc) patch.locale = loc;
    if (opts.elev00 !== undefined && pi?.elev00 !== opts.elev00) patch.elev00 = opts.elev00;
    if (pi && Object.keys(patch).length) doc.update('project', patch);
    chDimTypes(doc); chSpotTypes(doc);
    let dims = 0, spots = 0;
    if (opts.retype) {
      const map = RETYPE[loc];
      for (const cat of ['dimension', 'spot']) for (const el of doc.all(cat)) {
        const to = el.typeId ? map[el.typeId] : undefined;
        if (!to || !doc.get(to)) continue;
        // Präfix des alten Typs (z. B. «OKRD ») entfällt mit dem neuen Typ
        doc.update(el.id, { typeId: to });
        if (cat === 'dimension') dims++; else spots++;
      }
    }
    return { dims, spots };
  });
}
