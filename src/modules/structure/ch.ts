// Bewehrung nach Schweizer Usanz – Befehle und Dialoge: Bewehrungseinstellungen (Norm DIN / SIA, Bewehrungsplan
// für neue Bewehrung, Übernahme der Plannummern aus Kommentaren), Eisenliste nach SSHV, ABS-Export (BVBS) je Plan.
import { app } from '../../app';
import { registerCommand, registerPanel, registerContextPanel } from '../../core/registry';
import { registerIcon, ICONS } from '../../ui/icons';
import { modal } from '../../ui/dialogs';
import { h } from '../../ui/shell';
import { download } from '../../io/file';
import { extendRebarCategories } from './rebar/chProps';
import './eisenliste';
import { steelListDialog } from './schedule';
import { absExport } from './steel';
import { Norm } from './rebar/sshv';
import { rebarPlans, rebarNorm, NORM_LABELS, currentPlan, migrateRebarPlans, planOf, REBAR_EL_CATS } from './rebar/norm';

extendRebarCategories();

if (!ICONS.absfile) registerIcon('absfile', `<path d="M5 2 H14 L19 7 V22 H5 Z" fill="#fff" stroke="currentColor"/><text x="12" y="17" font-size="6" font-weight="bold" text-anchor="middle" fill="#b03030">ABS</text>`);
if (!ICONS.rebarnorm) registerIcon('rebarnorm', `<rect x="3" y="4" width="18" height="16" rx="2" fill="#fff" stroke="currentColor"/><path d="M7 15 V9 H17 V15" fill="none" stroke="#b03030" stroke-width="1.8"/><text x="12" y="19.2" font-size="4.5" text-anchor="middle" fill="currentColor">SIA</text>`);

// ------------------------------------------------------------ Einstellungen
export function rebarSettingsDialog(): void {
  const doc = app.doc;
  const norm = h('select', {}) as HTMLSelectElement;
  for (const [k, l] of NORM_LABELS) norm.append(h('option', { value: k }, l));
  norm.value = rebarNorm(doc);
  const plan = h('input', { type: 'text', value: currentPlan(doc), placeholder: 'z. B. T-205', list: 'rebar-plans' }) as HTMLInputElement;
  const dl = h('datalist', { id: 'rebar-plans' });
  for (const p of rebarPlans(doc)) if (p) dl.append(h('option', { value: p }));
  const legacy = REBAR_EL_CATS.flatMap((c) => doc.all(c)).filter((e) => !e.plan && planOf(e)).length;
  const mig = h('input', { type: 'checkbox' }) as HTMLInputElement; mig.checked = legacy > 0;
  const body = h('div', { style: 'min-width:520px' },
    h('div', { class: 'form-row' }, h('label', {}, 'Bewehrungsnorm'), norm),
    h('div', { class: 'hint' }, 'SIA (CH): Biegerollen d3 = 4 Ø (Ø ≤ 16) / 7 Ø (Ø > 16), d1 = 15 Ø wählbar, Ø-Reihe 6 … 40, Formnummern und Eisenliste nach SSHV-Richtlinie, Länge = Summe der Aussenmasse. DIN: Biegerollen nach DIN EN 1992-1-1/NA.'),
    h('div', { class: 'form-row' }, h('label', {}, 'Bewehrungsplan für neue Bewehrung'), plan, dl),
    h('div', { class: 'hint' }, 'Positionsnummern zählen je Bewehrungsplan ab 1 (Eigenschaft «Bewehrungsplan» je Bewehrungssatz).'),
  );
  if (legacy) body.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:0' }, mig, ` Plannummer aus «Kommentare» übernehmen (${legacy} Elemente)`)));
  modal('Bewehrungseinstellungen', body, [
    { label: 'OK', primary: true, onClick: () => {
      let n = 0;
      doc.transaction('Bewehrungseinstellungen', () => {
        doc.update('project', { rebarNorm: norm.value as Norm, rebarPlan: plan.value.trim() || undefined });
        if (legacy && mig.checked) n = migrateRebarPlans(doc);
      });
      app.status(`Bewehrungsnorm ${norm.value}${n ? `, ${n} Plannummern übernommen` : ''}.`);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 560);
}

// ------------------------------------------------------------ ABS-Export
export function exportAbsDialog(): void {
  const doc = app.doc;
  const plans = rebarPlans(doc).filter((p) => absExport(doc, p));
  if (!plans.length) { app.status('Keine Stabbewehrung für den ABS-Export vorhanden.'); return; }
  const save = (ps: string[]) => {
    for (const p of ps) download(`${(p || 'ohne_Plan').replace(/[^\w.-]+/g, '_')}.abs`, absExport(doc, p), 'text/plain;charset=us-ascii');
    app.status(`${ps.length} ABS-Datei(en) nach BVBS 3.1 exportiert.`);
  };
  if (plans.length === 1) { save(plans); return; }
  const selPlan = planOf(app.selected()[0]);
  const boxes = plans.map((p) => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = !selPlan || p === selPlan; c.dataset.plan = p; return c; });
  const body = h('div', { style: 'min-width:340px' }, h('div', { class: 'hint' }, 'Eine ABS-Datei (BVBS 3.1, BF2D) je Bewehrungsplan:'),
    ...boxes.map((c) => h('div', { class: 'form-row' }, h('label', { style: 'min-width:0' }, c, ' ' + (c.dataset.plan || '(ohne Plan)')))));
  modal('ABS-Datei (BVBS)', body, [
    { label: 'Exportieren', primary: true, onClick: () => save(boxes.filter((c) => c.checked).map((c) => c.dataset.plan ?? '')) },
    { label: 'Abbrechen', onClick: () => {} },
  ], 380);
}

// ------------------------------------------------------------ Befehle
registerCommand({ id: 'eisenliste', label: 'Eisenliste (SSHV)', icon: 'steellist', tip: 'Eisenliste nach SSHV-Richtlinie je Bewehrungsplan: Deckblatt, Liste mit Formskizzen, Spezialbewehrung; Druck, CSV, ABS, als Bauteilliste platzieren.',
  run: () => steelListDialog({ format: 'sshv' }) });
registerCommand({ id: 'exportAbs', label: 'ABS-Datei (BVBS)', icon: 'absfile', tip: 'Produktionsdatei für Biegemaschinen nach BVBS 3.1 (BF2D), eine Datei je Bewehrungsplan.', run: exportAbsDialog });
registerCommand({ id: 'rebarSettings', label: 'Bewehrungs- einstellungen', icon: 'rebarnorm', tip: 'Bewehrungsnorm (DIN / SIA), Bewehrungsplan (Nummernkreis) für neue Bewehrung.', run: rebarSettingsDialog });
registerPanel('Ingenieurbau', 'Bewehrung', [{ cmd: 'eisenliste', size: 'small' }, { cmd: 'exportAbs', size: 'small' }, { cmd: 'rebarSettings', size: 'small' }]);
registerContextPanel({ cats: ['rebar', 'areaRebar', 'fabricArea'], panel: 'Bewehrungslisten', items: ['eisenliste', 'exportAbs', 'rebarSettings'] });
