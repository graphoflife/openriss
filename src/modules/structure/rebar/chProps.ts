// Bewehrung – zusätzliche Eigenschaften und Listenfelder (Bewehrungsplan, SSHV-Form, Biegerolle d1/d3,
// Prüfung Mindestschenkel, Schraubanschluss) für Stab-, Flächen- und Mattenbewehrung. Erweitert die
// registrierten Kategorien, ohne deren Definition zu ändern.
import type { Doc, El } from '../../../core/doc';
import { catDef, GROUPS, PropDef } from '../../../core/registry';
import { fmtLen } from '../../../core/units';
import { Rebar, CouplerEnd, assignPos, rebarGeo } from './rebar';
import { SSHV_FORMS, GRADE_LABELS, kgNom } from './sshv';
import { planOf, rebarMandrel, diaOptions, rebarNorm } from './norm';
import { rebarFigure, rebarChecks, barLength, figureSketch, couplerText } from '../steel';

const g = GROUPS.rebar;
const ceText = (c?: CouplerEnd) => (c ? `${c.sys}; ${c.type}` : '');
const ceParse = (v: string): CouplerEnd | undefined => {
  const s = String(v ?? '').trim(); if (!s) return undefined;
  const [sys, type] = s.split(';').map((x) => x.trim());
  return { sys: sys || 'Muffe', type: type ?? '' };
};
const couplerProp = (key: 'start' | 'end', label: string): PropDef => ({
  key: 'coupler_' + key, label, group: g, type: 'text',
  get: (e) => ceText(e.coupler?.[key]),
  set: (e, v) => { const c = { ...(e.coupler ?? {}), [key]: ceParse(v) }; return { coupler: c.start || c.end ? c : undefined }; },
});
const FORM_OPTIONS = (): [string, string][] => [['', '(automatisch)'], ...SSHV_FORMS.map((f) => [f.nr, `${f.nr} – ${f.name}`] as [string, string])];

/** Bewehrungsplan: Änderung vergibt die Positionsnummer im neuen Plan */
const planProp = (cat: string): PropDef => ({
  key: 'plan', label: 'Bewehrungsplan', group: cat === 'rebar' ? g : GROUPS.identity, type: 'text',
  get: (e) => planOf(e),
  set: (e, v, doc) => {
    const plan = String(v ?? '').trim();
    if (cat !== 'rebar') return { plan };
    const tmp = { ...(e as Rebar), plan } as Rebar;
    return { plan, pos: assignPos(doc, tmp) };
  },
});

function rebarExtra(): PropDef[] {
  return [
    planProp('rebar'),
    { key: 'sshvForm', label: 'Form (SSHV)', group: g, type: 'readonly', get: (e, doc) => {
      const f = rebarFigure(doc, e as Rebar);
      return `${f.nr ? 'Form ' + f.nr : 'Sonderform'}: ${f.legs.map((l) => Math.round(l / 10)).join('/')} cm${f.nr ? ' – ' + f.name : ''}`;
    } },
    { key: 'form', label: 'Form manuell (SSHV-Nr.)', group: g, type: 'select', options: FORM_OPTIONS, get: (e) => e.form ?? '', set: (_e, v) => ({ form: v || undefined }) },
    { key: 'sshvGrade', label: 'Bearbeitungsgrad', group: g, type: 'readonly', get: (e, doc) => GRADE_LABELS[rebarFigure(doc, e as Rebar).grade] },
    { key: 'bendRoll', label: 'Biegerolle', group: g, type: 'select', options: [['d3', 'd3 (Standard 4 Ø / 7 Ø)'], ['d1', 'd1 = 15 Ø']], get: (e) => e.bendRoll ?? 'd3', set: (_e, v) => ({ bendRoll: v === 'd1' ? 'd1' : undefined }) },
    { key: 'sshvCheck', label: 'Prüfung Figurenliste', group: g, type: 'readonly', get: (e, doc) => { const w = rebarChecks(doc, e as Rebar); return w.length ? '⚠ ' + w.join('; ') : 'OK'; } },
    { key: 'devLen', label: 'Abgewickelte Länge (Σ Aussenmasse)', group: GROUPS.dims, type: 'readonly', get: (e, doc) => (rebarFigure(doc, e as Rebar).legs.reduce((s, l) => s + Math.round(l), 0) / 1000).toFixed(2) + ' m' },
    couplerProp('start', 'Muffe Anfang (System; Typ)'),
    couplerProp('end', 'Muffe Ende (System; Typ)'),
  ];
}

/** Grundeigenschaften anpassen: Ø-Reihe je Norm, Biegerollendurchmesser je Norm/Biegerolle */
function adapt(p: PropDef): PropDef {
  if (p.key === 'dia' && p.type === 'select') return { ...p, options: (doc: Doc) => diaOptions(doc) };
  if (p.key === 'mandrel') return { ...p, label: 'Biegerollendurchmesser', get: (e, doc) => fmtLen(rebarMandrel(doc, e as Rebar)) + ' mm (' + (rebarNorm(doc) === 'SIA' ? 'SIA 262' : 'DIN EN 1992-1-1/NA') + ')' };
  return p;
}

let done = false;
/** Kategorien erweitern (einmalig; nach dem Registrieren von rebar/areaRebar/fabricArea aufrufen) */
export function extendRebarCategories(): void {
  if (done) return; done = true;
  const rb = catDef('rebar');
  if (rb) {
    const props = rb.props, fields = rb.scheduleFields;
    rb.props = (el: El, doc: Doc) => {
      const base = (props?.(el, doc) ?? []).map(adapt);
      const extra = rebarExtra().filter((x) => !base.some((b) => b.key === x.key));
      const i = base.findIndex((b) => b.key === 'mandrel');
      return i >= 0 ? [...base.slice(0, i + 1), ...extra, ...base.slice(i + 1)] : [...base, ...extra];
    };
    rb.scheduleFields = () => [
      ...(fields?.() ?? []),
      { key: 'plan', label: 'Bewehrungsplan', get: (el) => planOf(el) },
      { key: 'sshvForm', label: 'Form (SSHV)', get: (el, doc) => rebarFigure(doc, el as Rebar).nr },
      { key: 'formSketch', label: 'Formskizze', get: (el, doc) => figureSketch(rebarFigure(doc, el as Rebar)) },
      { key: 'legsCm', label: 'Schenkel [cm]', get: (el, doc) => rebarFigure(doc, el as Rebar).legs.map((l) => Math.round(l / 10)).join('/') },
      { key: 'devLen', label: 'Abgewickelte Länge', unit: 'len', get: (el, doc) => barLength(doc, el as Rebar) },
      { key: 'devTotal', label: 'Totallänge', unit: 'len', get: (el, doc) => barLength(doc, el as Rebar) * rebarGeo(doc, el as Rebar).n },
      { key: 'nomWeight', label: 'Gewicht (Nennmasse)', unit: 'kg', get: (el, doc) => (barLength(doc, el as Rebar) * rebarGeo(doc, el as Rebar).n / 1000) * kgNom(el.dia) },
      { key: 'remarks', label: 'Bemerkungen', get: (el) => [el.comments && el.comments.trim() !== planOf(el) ? el.comments.trim() : '', el.mark ?? '', el.coupler ? 'Muffe: ' + couplerText(el.coupler) : ''].filter(Boolean).join('; ') },
    ];
  }
  for (const c of ['areaRebar', 'fabricArea']) {
    const d = catDef(c); if (!d) continue;
    const props = d.props, fields = d.scheduleFields;
    d.props = (el: El, doc: Doc) => { const base = props?.(el, doc) ?? []; return base.some((b) => b.key === 'plan') ? base : [planProp(c), ...base]; };
    d.scheduleFields = () => [...(fields?.() ?? []), { key: 'plan', label: 'Bewehrungsplan', get: (el) => planOf(el) }];
  }
}
