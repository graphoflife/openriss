// Dialoge: Typ bearbeiten, Wandschichten, Sichtbarkeit/Grafiken, Tastaturbefehle, Projektinformationen,
// Projekteinheiten, Materialien, Objektstile, Auswahlfilter, Ansichtsbereich.
import { app } from '../app';
import { catDef, allCats, onHook, emitHook, PropDef, allCommands } from '../core/registry';
import type { El, Id } from '../core/doc';
import { newId } from '../core/doc';
import { typesOf, TypeEl, Material, materialOptions, View, projectInfo, ProjectInfo, ViewRange, DEFAULT_RANGE } from '../core/view';
import { fmtLen, parseLen, unitSettings, LengthUnit, fmtNum, parseNum } from '../core/units';
import { OBJECT_STYLES, patternOptions, PEN_MM } from '../render/styles';
import { h } from './shell';
import type { WallType, WallLayer } from '../elements/wall';
import { typeThickness } from '../elements/wall';
import { getShortcuts, setShortcut, resetShortcuts, exportShortcuts, importShortcuts } from './keyboard';

export function modal(title: string, body: HTMLElement, buttons: { label: string; primary?: boolean; onClick: () => boolean | void }[], width?: number): { close: () => void; el: HTMLElement } {
  const back = h('div', { class: 'modal-back' });
  const m = h('div', { class: 'modal', style: width ? `width:${width}px` : '' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const x = h('button', { html: '×' }); x.onclick = close;
  m.append(h('div', { class: 'modal-title' }, h('span', {}, title), x));
  const b = h('div', { class: 'modal-body' }); b.append(body); m.append(b);
  const foot = h('div', { class: 'modal-foot' });
  for (const bt of buttons) {
    const e = h('button', { class: 'btn' + (bt.primary ? ' primary' : '') }, bt.label);
    e.onclick = () => { if (bt.onClick() !== false) close(); };
    foot.append(e);
  }
  m.append(foot);
  back.append(m);
  document.body.append(back);
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'SELECT') {
      const p = buttons.find((x) => x.primary); if (p && p.onClick() !== false) close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => (m.querySelector('input,select,textarea') as HTMLElement | null)?.focus(), 0);
  return { close, el: m };
}

export function promptDialog(title: string, label: string, value: string, ok: (v: string) => void): void {
  const i = h('input', { type: 'text', value }) as HTMLInputElement;
  modal(title, h('div', { class: 'form-row' }, h('label', {}, label), i), [
    { label: 'OK', primary: true, onClick: () => ok(i.value.trim()) },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
  setTimeout(() => i.select(), 10);
}

export function toast(s: string, ms = 2500): void {
  const t = h('div', { class: 'toast' }, s); document.body.append(t); setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------ Typ bearbeiten
export function editTypeDialog(type0: TypeEl, onChangeType?: (id: Id) => void): void {
  const doc = app.doc;
  let type = type0;
  const body = h('div', { style: 'min-width:460px' });
  const render = () => {
    type = doc.get<TypeEl>(type.id) ?? type;
    body.innerHTML = '';
    const types = typesOf(doc, type.of);
    const sel = h('select', {}) as HTMLSelectElement;
    for (const t of types) sel.append(h('option', { value: t.id }, t.name));
    sel.value = type.id;
    sel.onchange = () => { type = doc.get<TypeEl>(sel.value)!; render(); };
    const dup = h('button', { class: 'btn small' }, 'Duplizieren…');
    dup.onclick = () => promptDialog('Name', 'Name', type.name + ' 2', (name) => {
      if (!name) return;
      const c = JSON.parse(JSON.stringify(type)); c.id = newId('ty'); c.name = name;
      doc.transaction('Typ duplizieren', () => doc.add(c));
      type = c; render();
    });
    const ren = h('button', { class: 'btn small' }, 'Umbenennen…');
    ren.onclick = () => promptDialog('Umbenennen', 'Name', type.name, (name) => { if (name) { doc.transaction('Typ umbenennen', () => doc.update(type.id, { name })); render(); } });
    body.append(
      h('div', { class: 'form-row' }, h('label', {}, 'Familie:'), h('b', {}, `Systemfamilie: ${catDef(type.of)?.label ?? type.of}`)),
      h('div', { class: 'form-row' }, h('label', {}, 'Typ:'), sel, dup, ren),
      h('div', { class: 'hint' }, 'Änderungen an Typeigenschaften wirken sich auf alle Exemplare dieses Typs aus.'),
    );
    const props = catDef(type.of)?.typeProps?.(type, doc) ?? [];
    const table = h('table', { class: 'grid' });
    table.append(h('tr', {}, h('th', { style: 'width:45%' }, 'Parameter'), h('th', {}, 'Wert')));
    let group = '';
    for (const p of props) {
      if (p.group !== group) { group = p.group; table.append(h('tr', {}, h('td', { colspan: '2', style: 'background:#e9edf1;font-weight:600' }, group))); }
      table.append(h('tr', {}, h('td', {}, p.label), h('td', {}, typeEditor(p, type, render))));
    }
    body.append(table);
  };
  render();
  modal('Typeigenschaften', body, [{ label: 'OK', primary: true, onClick: () => { onChangeType?.(type.id); } }], 560);
}

function typeEditor(p: PropDef, type: El, rerender: () => void): HTMLElement {
  const doc = app.doc;
  const val = p.get(type, doc);
  const apply = (v: any) => { const patch = p.set?.(type, v, doc); if (patch) doc.transaction('Typ ändern', () => doc.update(type.id, patch)); rerender(); };
  if (p.type === 'button') { const b = h('button', { class: 'btn small' }, String(val)); b.onclick = () => p.action?.(type, doc); return b; }
  if (!p.set || p.type === 'readonly') return h('span', {}, String(val ?? ''));
  if (p.type === 'bool') { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = !!val; c.onchange = () => apply(c.checked); return c; }
  if (p.type === 'select' || p.type === 'material') {
    const s = h('select', {}) as HTMLSelectElement;
    const opts = p.type === 'material' ? [['', '<Nach Kategorie>'] as [string, string], ...materialOptions(doc)] : typeof p.options === 'function' ? p.options(doc) : p.options ?? [];
    for (const [k, l] of opts) s.append(h('option', { value: k }, l));
    s.value = String(val ?? ''); s.onchange = () => apply(s.value); return s;
  }
  if (p.type === 'color') { const c = h('input', { type: 'color', value: val ?? '#000000' }) as HTMLInputElement; c.onchange = () => apply(c.value); return c; }
  const i = h('input', { type: 'text', value: p.type === 'length' ? fmtLen(val ?? 0) : String(val ?? '') }) as HTMLInputElement;
  i.onchange = () => {
    const v = p.type === 'length' ? parseLen(i.value) : p.type === 'number' || p.type === 'int' ? parseNum(i.value) : i.value;
    if (v === null) return; apply(v);
  };
  return i;
}

// ------------------------------------------------------------ Wandschichten (Struktur bearbeiten)
const FN_LABELS: [WallLayer['fn'], string][] = [['structure', 'Tragende Schicht [1]'], ['substrate', 'Unterkonstruktion [2]'], ['thermal', 'Dämmung/Luftschicht [3]'], ['finish', 'Fertigteil [4]'], ['membrane', 'Abdichtung'], ['air', 'Luftschicht']];
onHook('editWallLayers', (type: WallType) => editWallLayers(type));
export function editWallLayers(type: WallType): void {
  const doc = app.doc;
  let layers: WallLayer[] = JSON.parse(JSON.stringify(type.layers));
  let sel = 0;
  const body = h('div', { style: 'min-width:560px' });
  const render = () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'form-row' }, h('label', {}, 'Typ:'), h('b', {}, type.name)),
      h('div', { class: 'form-row' }, h('label', {}, 'Gesamtdicke:'), h('b', {}, fmtLen(layers.reduce((s, l) => s + l.t, 0)))));
    const t = h('table', { class: 'grid' });
    t.append(h('tr', {}, h('th', {}, ''), h('th', {}, 'Funktion'), h('th', {}, 'Material'), h('th', { style: 'width:90px' }, 'Dicke'), h('th', { style: 'width:60px' }, 'Kern'), h('th', { style: 'width:120px', title: 'Schicht über die Deckenstirn bis OK der oberen Ebene durchziehen' }, 'Über Decke')));
    t.append(h('tr', {}, h('td', { colspan: '6', style: 'text-align:center;color:#666' }, '— AUSSENSEITE —')));
    layers.forEach((l, i) => {
      const fn = h('select', {}) as HTMLSelectElement; for (const [k, v] of FN_LABELS) fn.append(h('option', { value: k }, v)); fn.value = l.fn; fn.onchange = () => (l.fn = fn.value as any);
      const m = h('select', {}) as HTMLSelectElement; for (const [k, v] of materialOptions(doc)) m.append(h('option', { value: k }, v)); m.value = l.mat; m.onchange = () => (l.mat = m.value);
      const th = h('input', { type: 'text', value: fmtLen(l.t) }) as HTMLInputElement; th.onchange = () => { const v = parseLen(th.value); if (v !== null && v >= 0) l.t = v; render(); };
      const core = h('input', { type: 'checkbox' }) as HTMLInputElement; core.checked = !!l.core; core.onchange = () => (l.core = core.checked);
      const wr = h('select', {}) as HTMLSelectElement;
      for (const [k, v] of [['', 'Typvorgabe'], ['1', 'Ja'], ['0', 'Nein']]) wr.append(h('option', { value: k }, v));
      wr.value = l.wrap === undefined ? '' : l.wrap ? '1' : '0';
      wr.onchange = () => { if (wr.value === '') delete l.wrap; else l.wrap = wr.value === '1'; };
      const tr = h('tr', { class: i === sel ? 'sel' : '' }, h('td', {}, String(i + 1)), h('td', {}, fn), h('td', {}, m), h('td', {}, th), h('td', { style: 'text-align:center' }, core), h('td', {}, wr));
      tr.onclick = (e) => { if ((e.target as HTMLElement).tagName === 'TD') { sel = i; render(); } };
      t.append(tr);
    });
    t.append(h('tr', {}, h('td', { colspan: '6', style: 'text-align:center;color:#666' }, '— INNENSEITE —')));
    body.append(t);
    const btn = (label: string, fn: () => void) => { const b = h('button', { class: 'btn small' }, label); b.onclick = () => { fn(); render(); }; return b; };
    body.append(h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
      btn('Einfügen', () => { layers.splice(sel, 0, { mat: layers[sel]?.mat ?? 'm_putz', t: 10, fn: 'finish' }); }),
      btn('Löschen', () => { if (layers.length > 1) { layers.splice(sel, 1); sel = Math.max(0, sel - 1); } }),
      btn('Nach oben', () => { if (sel > 0) { [layers[sel - 1], layers[sel]] = [layers[sel], layers[sel - 1]]; sel--; } }),
      btn('Nach unten', () => { if (sel < layers.length - 1) { [layers[sel + 1], layers[sel]] = [layers[sel], layers[sel + 1]]; sel++; } }),
    ));
  };
  render();
  modal('Struktur bearbeiten', body, [
    { label: 'OK', primary: true, onClick: () => { doc.transaction('Wandstruktur', () => doc.update(type.id, { layers })); } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 640);
}

// ------------------------------------------------------------ Sichtbarkeit/Grafiken (VV)
export function visibilityDialog(view: View): void {
  const hidden = new Set(view.hiddenCats ?? []);
  const body = h('div', { style: 'min-width:420px' });
  body.append(h('div', { class: 'hint' }, `Sichtbarkeit/Grafiken für ${view.name}. Haken entfernen, um eine Kategorie in dieser Ansicht auszublenden.`));
  const t = h('table', { class: 'grid' });
  t.append(h('tr', {}, h('th', { style: 'width:30px' }, ''), h('th', {}, 'Kategorie'), h('th', {}, 'Art')));
  const entries: [string, string, string][] = [];
  for (const d of allCats()) {
    if (['type', 'material', 'project'].includes(d.cat)) continue;
    if (d.cat === 'view') { entries.push(['section', 'Schnitte', 'Beschriftung'], ['elevation', 'Ansichtssymbole', 'Beschriftung']); continue; }
    entries.push([d.cat, d.plural, d.annotation ? 'Beschriftung' : d.datum ? 'Bezug' : 'Modell']);
  }
  entries.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1], 'de'));
  for (const [cat, label, kind] of entries) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = !hidden.has(cat);
    cb.onchange = () => (cb.checked ? hidden.delete(cat) : hidden.add(cat));
    t.append(h('tr', {}, h('td', {}, cb), h('td', {}, label), h('td', { style: 'color:#666' }, kind)));
  }
  body.append(h('div', { style: 'max-height:55vh;overflow:auto' }, t));
  const hiddenEls = view.hiddenEls ?? [];
  if (hiddenEls.length) {
    const b = h('button', { class: 'btn small', style: 'margin-top:8px' }, `In Ansicht ausgeblendete Elemente wieder einblenden (${hiddenEls.length})`);
    b.onclick = () => { app.doc.transaction('Einblenden', () => app.doc.update(view.id, { hiddenEls: [] })); app.refreshViews(); b.remove(); };
    body.append(b);
  }
  modal('Sichtbarkeit/Grafiken', body, [
    { label: 'OK', primary: true, onClick: () => { app.doc.transaction('Sichtbarkeit/Grafiken', () => app.doc.update(view.id, { hiddenCats: [...hidden] })); app.refreshViews(); } },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}

// ------------------------------------------------------------ Ansichtsbereich
export function viewRangeDialog(view: View): void {
  const r: ViewRange = { ...DEFAULT_RANGE, ...(view.range ?? {}) };
  const body = h('div', {});
  const row = (label: string, key: keyof ViewRange) => {
    const i = h('input', { type: 'text', value: fmtLen(r[key]) }) as HTMLInputElement;
    i.onchange = () => { const v = parseLen(i.value); if (v !== null) r[key] = v; };
    return h('div', { class: 'form-row' }, h('label', {}, label), i);
  };
  body.append(h('div', { class: 'hint' }, 'Werte relativ zur zugehörigen Ebene.'), row('Oben', 'top'), row('Schnittebene', 'cut'), row('Unten', 'bottom'), row('Ansichtstiefe', 'depth'));
  modal('Ansichtsbereich', body, [
    { label: 'OK', primary: true, onClick: () => { app.doc.transaction('Ansichtsbereich', () => app.doc.update(view.id, { range: r })); app.refreshViews(); } },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}

// ------------------------------------------------------------ Tastaturbefehle (KS)
export function shortcutsDialog(): void {
  const body = h('div', { style: 'min-width:560px' });
  let q = '';
  const search = h('input', { type: 'text', placeholder: 'Befehl oder Kürzel suchen…', style: 'width:100%;height:26px;margin-bottom:6px' }) as HTMLInputElement;
  search.oninput = () => { q = search.value.toLowerCase(); render(); };
  const list = h('div', { style: 'max-height:55vh;overflow:auto' });
  body.append(h('div', { class: 'hint' }, 'Kürzel wie in Revit: Buchstabenfolgen ohne Strg (z. B. WA, DR, MV). Mehrere Kürzel durch Leerzeichen trennen.'), search, list);
  const render = () => {
    list.innerHTML = '';
    const sc = getShortcuts();
    const t = h('table', { class: 'grid' });
    t.append(h('tr', {}, h('th', {}, 'Befehl'), h('th', { style: 'width:160px' }, 'Kürzel')));
    for (const c of allCommands().sort((a, b) => a.label.localeCompare(b.label, 'de'))) {
      const keys = sc[c.id] ?? [];
      if (q && !c.label.toLowerCase().includes(q) && !keys.join(' ').toLowerCase().includes(q)) continue;
      const i = h('input', { type: 'text', value: keys.join(' ') }) as HTMLInputElement;
      i.onchange = () => { setShortcut(c.id, i.value.toUpperCase().split(/[\s,;]+/).filter(Boolean)); };
      t.append(h('tr', {}, h('td', {}, c.label), h('td', {}, i)));
    }
    list.append(t);
  };
  render();
  modal('Tastaturbefehle', body, [
    { label: 'Exportieren…', onClick: () => { exportShortcuts(); return false; } },
    { label: 'Importieren…', onClick: () => { importShortcuts(render); return false; } },
    { label: 'Standard wiederherstellen', onClick: () => { if (confirm('Alle Kürzel auf Standard zurücksetzen?')) { resetShortcuts(); render(); } return false; } },
    { label: 'OK', primary: true, onClick: () => {} },
  ], 640);
}

// ------------------------------------------------------------ Projektinformationen
export function projectInfoDialog(): void {
  const pi = { ...projectInfo(app.doc) };
  const body = h('div', {});
  const fields: [keyof ProjectInfo, string][] = [['name', 'Projektname'], ['number', 'Projektnummer'], ['client', 'Bauherr'], ['address', 'Projektadresse'], ['author', 'Verfasser'], ['status', 'Projektstatus'], ['date', 'Ausgabedatum']];
  for (const [k, l] of fields) {
    const i = h('input', { type: 'text', value: String(pi[k] ?? '') }) as HTMLInputElement;
    i.onchange = () => ((pi as any)[k] = i.value);
    body.append(h('div', { class: 'form-row' }, h('label', {}, l), i));
  }
  // Zusatzfelder der Module (Landesvorlage, Höhenbezug, Plankopf-Vorlage …)
  for (const f of piFields) {
    let i: HTMLInputElement | HTMLSelectElement;
    if (f.options) { i = h('select', {}) as HTMLSelectElement; for (const [k, l] of f.options) i.append(h('option', { value: k }, l)); }
    else i = h('input', { type: 'text', placeholder: f.placeholder ?? '' }) as HTMLInputElement;
    i.value = f.get(pi);
    const inp = i; inp.onchange = () => f.set(pi, inp.value);
    body.append(h('div', { class: 'form-row' }, h('label', {}, f.label), inp));
  }
  modal('Projektinformationen', body, [
    { label: 'OK', primary: true, onClick: () => {
      const before = { ...projectInfo(app.doc) };
      app.doc.transaction('Projektinformationen', () => { app.doc.update('project', pi); emitHook('projectInfo', app.doc, before); });
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 480);
}
/** Zusatzfeld im Dialog «Projektinformationen» (Wert als Text; options = Auswahlliste) */
export interface ProjectInfoField { key: string; label: string; options?: [string, string][]; placeholder?: string; get: (pi: ProjectInfo) => string; set: (pi: ProjectInfo, v: string) => void }
const piFields: ProjectInfoField[] = [];
/** Module ergänzen Felder; nach OK folgt Hook 'projectInfo' (doc, vorher) in derselben Transaktion */
export function registerProjectInfoField(f: ProjectInfoField): void { if (!piFields.some((x) => x.key === f.key)) piFields.push(f); }

// ------------------------------------------------------------ Projekteinheiten (UN)
export function unitsDialog(): void {
  const body = h('div', {});
  const u = h('select', {}) as HTMLSelectElement;
  for (const [k, l] of [['mm', 'Millimeter (mm)'], ['cm', 'Zentimeter (cm)'], ['m', 'Meter (m)']]) u.append(h('option', { value: k }, l));
  u.value = unitSettings.length;
  const d = h('input', { type: 'text', value: String(unitSettings.lengthDecimals) }) as HTMLInputElement;
  const s5 = h('input', { type: 'checkbox' }) as HTMLInputElement; s5.checked = unitSettings.superscriptFive;
  body.append(
    h('div', { class: 'form-row' }, h('label', {}, 'Länge'), u),
    h('div', { class: 'form-row' }, h('label', {}, 'Nachkommastellen'), d),
    h('div', { class: 'form-row' }, h('label', {}, 'Hochgestellte 5 (Rohbaumaß)'), s5),
    h('div', { class: 'hint' }, 'Eingaben ohne Einheit werden in der Projekteinheit interpretiert. Sie können immer auch „mm“, „cm“ oder „m“ anhängen und rechnen (z. B. 2,51+0,115m).'),
  );
  modal('Projekteinheiten', body, [
    { label: 'OK', primary: true, onClick: () => {
      const units = { length: u.value as LengthUnit, decimals: Math.max(0, Math.min(4, parseInt(d.value, 10) || 0)), superscriptFive: s5.checked };
      app.doc.transaction('Projekteinheiten', () => app.doc.update('project', { units }));
      applyUnits();
      app.refreshViews(); app.emit('selection');
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}
export function applyUnits(): void {
  const u = projectInfo(app.doc)?.units as any;
  unitSettings.length = u?.length ?? 'mm';
  unitSettings.lengthDecimals = u?.decimals ?? (unitSettings.length === 'm' ? 2 : unitSettings.length === 'cm' ? 1 : 0);
  unitSettings.superscriptFive = !!u?.superscriptFive;
  // Schweizer Projekte: Dezimalpunkt (±0.00, 2.75)
  unitSettings.decimalSep = (projectInfo(app.doc) as any)?.locale === 'CH' ? '.' : ',';
}
onHook('projectInfo', () => { applyUnits(); app.refreshViews(); });

// ------------------------------------------------------------ Materialien
export function materialsDialog(): void {
  const doc = app.doc;
  let selId = doc.all<Material>('material')[0]?.id;
  const body = h('div', { style: 'display:flex;gap:10px;min-width:640px;height:60vh' });
  const render = () => {
    body.innerHTML = '';
    const mats = doc.all<Material>('material').sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const list = h('div', { style: 'width:240px;overflow:auto;border:1px solid #ddd' });
    for (const m of mats) {
      const row = h('div', { class: 'tree-node' + (m.id === selId ? ' sel' : '') }, h('span', { style: `display:inline-block;width:14px;height:14px;background:${m.color};border:1px solid #888` }), ' ' + m.name);
      row.onclick = () => { selId = m.id; render(); };
      list.append(row);
    }
    const m = doc.get<Material>(selId);
    const edit = h('div', { style: 'flex:1' });
    if (m) {
      const upd = (patch: Partial<Material>) => { doc.transaction('Material ändern', () => doc.update(m.id, patch)); render(); };
      const name = h('input', { type: 'text', value: m.name }) as HTMLInputElement; name.onchange = () => upd({ name: name.value });
      const col = h('input', { type: 'color', value: m.color }) as HTMLInputElement; col.onchange = () => upd({ color: col.value });
      const pat = h('select', {}) as HTMLSelectElement; for (const [k, l] of patternOptions()) pat.append(h('option', { value: k }, l)); pat.value = m.cutPattern ?? ''; pat.onchange = () => upd({ cutPattern: pat.value || undefined });
      const pc = h('input', { type: 'color', value: m.cutColor ?? '#000000' }) as HTMLInputElement; pc.onchange = () => upd({ cutColor: pc.value });
      const tr = h('input', { type: 'text', value: String(Math.round((m.transparency ?? 0) * 100)) }) as HTMLInputElement; tr.onchange = () => upd({ transparency: (parseNum(tr.value) ?? 0) / 100 });
      const de = h('input', { type: 'text', value: String(m.density ?? '') }) as HTMLInputElement; de.onchange = () => upd({ density: parseNum(de.value) ?? undefined });
      edit.append(
        h('div', { class: 'form-row' }, h('label', {}, 'Name'), name),
        h('div', { class: 'form-row' }, h('label', {}, 'Schattierung (Farbe)'), col),
        h('div', { class: 'form-row' }, h('label', {}, 'Schnittmuster'), pat),
        h('div', { class: 'form-row' }, h('label', {}, 'Farbe Schnittmuster'), pc),
        h('div', { class: 'form-row' }, h('label', {}, 'Transparenz %'), tr),
        h('div', { class: 'form-row' }, h('label', {}, 'Rohdichte kg/m³'), de),
      );
    }
    const nb = h('button', { class: 'btn small' }, 'Neues Material'); nb.onclick = () => {
      const id = newId('m'); doc.transaction('Material erstellen', () => doc.add({ id, cat: 'material', name: 'Neues Material', color: '#cccccc' } as any)); selId = id; render();
    };
    const db = h('button', { class: 'btn small' }, 'Duplizieren'); db.onclick = () => {
      if (!m) return; const id = newId('m'); doc.transaction('Material duplizieren', () => doc.add({ ...JSON.parse(JSON.stringify(m)), id, name: m.name + ' (2)' })); selId = id; render();
    };
    edit.append(h('div', { style: 'display:flex;gap:6px;margin-top:10px' }, nb, db));
    body.append(list, edit);
  };
  render();
  modal('Materialbrowser', body, [{ label: 'Schließen', primary: true, onClick: () => { app.refreshViews(); } }], 720);
}

// ------------------------------------------------------------ Objektstile
export function objectStylesDialog(): void {
  const pi = projectInfo(app.doc);
  const ov: Record<string, any> = JSON.parse(JSON.stringify(pi.objStyles ?? {}));
  const body = h('div', { style: 'max-height:60vh;overflow:auto;min-width:480px' });
  const t = h('table', { class: 'grid' });
  t.append(h('tr', {}, h('th', {}, 'Kategorie'), h('th', {}, 'Projektion'), h('th', {}, 'Schnitt'), h('th', {}, 'Farbe')));
  const penSel = (v: number | undefined, on: (n: number) => void) => {
    const s = h('select', {}) as HTMLSelectElement;
    for (let i = 1; i <= 16; i++) s.append(h('option', { value: String(i) }, `${i} (${PEN_MM[i]} mm)`));
    s.value = String(v ?? 1); s.onchange = () => on(parseInt(s.value, 10)); return s;
  };
  for (const [cat, st] of Object.entries(OBJECT_STYLES)) {
    const o = ov[cat] ?? {};
    const col = h('input', { type: 'color', value: o.color ?? st.color ?? '#000000' }) as HTMLInputElement;
    col.onchange = () => { ov[cat] = { ...ov[cat], color: col.value }; };
    t.append(h('tr', {}, h('td', {}, st.label),
      h('td', {}, penSel(o.proj ?? st.proj, (n) => (ov[cat] = { ...ov[cat], proj: n }))),
      h('td', {}, st.cut !== undefined ? penSel(o.cut ?? st.cut, (n) => (ov[cat] = { ...ov[cat], cut: n })) : ''),
      h('td', {}, col)));
  }
  body.append(t);
  modal('Objektstile', body, [
    { label: 'OK', primary: true, onClick: () => { app.doc.transaction('Objektstile', () => app.doc.update('project', { objStyles: ov })); app.refreshViews(); } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 560);
}

// ------------------------------------------------------------ Auswahlfilter
export function selectionFilterDialog(): void {
  const sel = app.selected();
  const counts = new Map<string, number>();
  for (const e of sel) counts.set(e.cat, (counts.get(e.cat) ?? 0) + 1);
  const keep = new Set(counts.keys());
  const body = h('div', {});
  for (const [cat, n] of counts) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = true;
    cb.onchange = () => (cb.checked ? keep.add(cat) : keep.delete(cat));
    body.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:240px' }, cb, ' ' + (catDef(cat)?.plural ?? cat)), h('span', {}, String(n))));
  }
  body.append(h('div', { class: 'hint' }, `Ausgewählte Elemente insgesamt: ${sel.length}`));
  modal('Filter', body, [
    { label: 'OK', primary: true, onClick: () => app.select(sel.filter((e) => keep.has(e.cat)).map((e) => e.id)) },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}

export function helpDialog(): void {
  const body = h('div', { style: 'max-width:640px;line-height:1.5', html: `
    <p><b>OpenRiss</b> ist ein freies BIM-Zeichenprogramm im Browser, dessen Bedienung sich an Revit orientiert.</p>
    <p><b>Navigation:</b> Mausrad = Zoom, mittlere Maustaste ziehen = Verschieben, Doppelklick Mausrad = Zoom Grenzen (ZE/ZF). In 3D: Umschalt + mittlere Maustaste = Orbit.</p>
    <p><b>Auswahl:</b> Klick wählt, Strg+Klick fügt hinzu, Umschalt+Klick entfernt. Fenster von links nach rechts = vollständig enthalten, von rechts nach links = kreuzend. Tab wechselt zwischen überlagerten Elementen. Esc hebt auf.</p>
    <p><b>Zeichnen:</b> Während des Zeichnens eine Zahl tippen, um eine exakte Länge einzugeben (Ausdrücke wie <span class="kbd">2,5m+115</span> sind erlaubt). Leertaste kehrt die Ausrichtung um. Esc beendet die Kette, ein zweites Esc das Werkzeug. Enter wiederholt den letzten Befehl.</p>
    <p><b>Temporäre Bemaßungen:</b> Ausgewählte Wände, Türen und Fenster zeigen blaue Maße – Wert anklicken und ändern, um das Element zu verschieben.</p>
    <p><b>Wichtige Kürzel:</b> <span class="kbd">WA</span> Wand, <span class="kbd">DR</span> Tür, <span class="kbd">WN</span> Fenster, <span class="kbd">DI</span> Bemaßung, <span class="kbd">TX</span> Text, <span class="kbd">MV</span> Verschieben, <span class="kbd">CO</span> Kopieren, <span class="kbd">RO</span> Drehen, <span class="kbd">MM</span> Spiegeln, <span class="kbd">AL</span> Ausrichten, <span class="kbd">TR</span> Stutzen, <span class="kbd">SL</span> Teilen, <span class="kbd">OF</span> Versatz, <span class="kbd">VV</span> Sichtbarkeit, <span class="kbd">HH/HI/HR</span> Ausblenden/Isolieren, <span class="kbd">ZE</span> Zoom Grenzen. Alle Kürzel: <span class="kbd">KS</span>.</p>
    <p class="hint">Projektdateien (*.oriss) sind JSON-Dateien. Das Projekt wird zusätzlich automatisch im Browser zwischengespeichert.</p>` });
  modal('Hilfe', body, [{ label: 'OK', primary: true, onClick: () => {} }], 680);
}

export { fmtNum, typeThickness };

// ------------------------------------------------------------ Grafiken in Ansicht überschreiben
export function overrideDialog(view: View, ids: Id[]): void {
  const cur = { ...((view.elOverrides ?? {})[ids[0]] ?? {}) } as any;
  const body = h('div', {});
  const col = h('input', { type: 'color', value: cur.color ?? '#000000' }) as HTMLInputElement;
  const useCol = h('input', { type: 'checkbox' }) as HTMLInputElement; useCol.checked = !!cur.color;
  const pen = h('select', {}) as HTMLSelectElement; pen.append(h('option', { value: '' }, '<Keine Überschreibung>'));
  for (let i = 1; i <= 16; i++) pen.append(h('option', { value: String(i) }, `${i} (${PEN_MM[i]} mm)`));
  pen.value = cur.w ? String(cur.w) : '';
  const dash = h('select', {}) as HTMLSelectElement;
  for (const [k, l] of [['', '<Keine Überschreibung>'], ['solid', 'Durchgezogen'], ['dash', 'Strich'], ['hidden', 'Verdeckt'], ['center', 'Strichpunkt'], ['dot', 'Punkt']]) dash.append(h('option', { value: k }, l));
  dash.value = cur.dash ?? '';
  const fill = h('input', { type: 'color', value: cur.fillColor ?? '#cccccc' }) as HTMLInputElement;
  const useFill = h('input', { type: 'checkbox' }) as HTMLInputElement; useFill.checked = !!cur.fillColor;
  const ht = h('input', { type: 'checkbox' }) as HTMLInputElement; ht.checked = !!cur.halftone;
  body.append(
    h('div', { class: 'hint' }, `${ids.length} Element(e) in Ansicht „${view.name}“`),
    h('div', { class: 'form-row' }, h('label', {}, useCol, ' Linienfarbe'), col),
    h('div', { class: 'form-row' }, h('label', {}, 'Linienstärke'), pen),
    h('div', { class: 'form-row' }, h('label', {}, 'Linienmuster'), dash),
    h('div', { class: 'form-row' }, h('label', {}, useFill, ' Füllfarbe (Schnitt)'), fill),
    h('div', { class: 'form-row' }, h('label', {}, ht, ' Halbton')),
  );
  const apply = (o: any | null) => {
    const all = { ...(view.elOverrides ?? {}) } as Record<string, any>;
    for (const id of ids) { if (o) all[id] = o; else delete all[id]; }
    app.doc.transaction('Grafiken überschreiben', () => app.doc.update(view.id, { elOverrides: all }));
    app.refreshViews();
  };
  modal('Grafiken in Ansicht nach Element', body, [
    { label: 'Zurücksetzen', onClick: () => apply(null) },
    { label: 'OK', primary: true, onClick: () => apply({ color: useCol.checked ? col.value : undefined, w: pen.value ? parseInt(pen.value, 10) : undefined, dash: dash.value || undefined, fillColor: useFill.checked ? fill.value : undefined, halftone: ht.checked || undefined }) },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}

// ------------------------------------------------------------ Nicht verwendete bereinigen
export function purgeDialog(): void {
  const doc = app.doc;
  const usedTypes = new Set(doc.all().map((e) => e.typeId).filter(Boolean));
  const usedMats = new Set<string>();
  for (const e of doc.all()) {
    for (const v of Object.values(e)) if (typeof v === 'string' && v.startsWith('m_')) usedMats.add(v);
    if (Array.isArray(e.layers)) for (const l of e.layers) if (l?.mat) usedMats.add(l.mat);
    for (const k of ['mat', 'glassMat', 'material']) if (e[k]) usedMats.add(e[k]);
  }
  const unusedTypes = doc.all<TypeEl>('type').filter((t) => !usedTypes.has(t.id));
  // je Kategorie mindestens einen Typ behalten
  const byOf = new Map<string, TypeEl[]>();
  for (const t of unusedTypes) { const l = byOf.get(t.of) ?? []; l.push(t); byOf.set(t.of, l); }
  const removable: El[] = [];
  for (const [of, list] of byOf) {
    const anyUsed = doc.all<TypeEl>('type').some((t) => t.of === of && usedTypes.has(t.id));
    removable.push(...(anyUsed ? list : list.slice(1)));
  }
  const unusedMats = doc.all<Material>('material').filter((m) => !usedMats.has(m.id));
  removable.push(...unusedMats);
  const body = h('div', { style: 'max-height:55vh;overflow:auto;min-width:420px' });
  const checks = new Map<string, HTMLInputElement>();
  if (!removable.length) body.append(h('div', {}, 'Keine nicht verwendeten Elemente gefunden.'));
  for (const e of removable) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = true; checks.set(e.id, cb);
    body.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:360px' }, cb, ` ${e.cat === 'type' ? (catDef((e as TypeEl).of)?.label ?? '') + ': ' : 'Material: '}${e.name}`)));
  }
  modal('Nicht verwendete bereinigen', body, [
    { label: 'OK', primary: true, onClick: () => { const ids = [...checks].filter(([, c]) => c.checked).map(([id]) => id); if (ids.length) doc.transaction('Bereinigen', () => { for (const id of ids) doc.remove(id); }); toast(`${ids.length} Element(e) entfernt.`); } },
    { label: 'Abbrechen', onClick: () => {} },
  ]);
}
