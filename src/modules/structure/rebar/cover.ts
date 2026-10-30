// Dialog „Betondeckung“: Projektstandard + Überschreibungen je Bauteil; eingepasste Bewehrung wird
// auf Wunsch neu eingepasst (wie in Revit an die Deckung gebunden).
import { app } from '../../../app';
import type { El, Id } from '../../../core/doc';
import { catDef } from '../../../core/registry';
import { projectInfo } from '../../../core/view';
import { hostedBy } from '../../../core/cache';
import { modal } from '../../../ui/dialogs';
import { h } from '../../../ui/shell';
import { fmtLen, parseLen } from '../../../core/units';
import { HOST_CATS, isConcrete } from '../common';
import { refit } from './build';
import type { Rebar } from './rebar';

function hostIsConcrete(e: El): boolean {
  const t = app.doc.get(e.typeId);
  if (e.cat === 'wall' || e.cat === 'floor') {
    const conc = (id: Id) => { const m = app.doc.get(id); return !!m && (m.cutPattern === 'rc' || m.cutPattern === 'concrete' || /beton/i.test(m.name ?? '')); };
    return !!e.structural || !!t?.layers?.some((l: any) => conc(l.mat)) || (!t?.layers && e.cat === 'floor');
  }
  return !t?.mat || isConcrete(app.doc, t.mat);
}

export function rebarCoverDialog(): void {
  const doc = app.doc; const pi = projectInfo(doc);
  const body = h('div', { style: 'min-width:600px' });
  const def = h('input', { type: 'text', value: fmtLen(pi?.rebarCover ?? 30) }) as HTMLInputElement;
  body.append(
    h('div', { class: 'form-row' }, h('label', {}, 'Standard-Betondeckung c_nom (mm)'), def),
    h('div', { class: 'hint' }, 'Abstand Bauteiloberfläche → Staboberfläche (äußerste Lage, i. d. R. Bügel). Bauteile ohne eigenen Wert verwenden den Projektstandard.'),
  );
  const selHosts = app.selected().filter((e) => HOST_CATS.includes(e.cat));
  let onlySel = selHosts.length > 0;
  const edits = new Map<Id, number | undefined>();
  const tableBox = h('div', { style: 'max-height:50vh;overflow:auto;margin-top:6px' });
  const render = () => {
    tableBox.innerHTML = '';
    const t = h('table', { class: 'grid' });
    t.append(h('tr', {}, h('th', {}, 'Bauteil'), h('th', {}, 'Typ / Kennzeichen'), h('th', {}, 'Ebene'), h('th', { style: 'width:70px' }, 'Bewehrung'), h('th', { style: 'width:120px' }, 'Deckung (mm)')));
    const hosts = (onlySel ? selHosts : HOST_CATS.flatMap((c) => doc.all(c))).filter((e) => !e.viewId && hostIsConcrete(e));
    for (const e of hosts) {
      const cur = edits.has(e.id) ? edits.get(e.id) : e.rebarCover;
      const inp = h('input', { type: 'text', value: cur ? fmtLen(cur) : '', placeholder: 'Standard' }) as HTMLInputElement;
      inp.onchange = () => { const v = inp.value.trim() ? parseLen(inp.value) : 0; edits.set(e.id, v && v > 0 ? v : undefined); };
      const nReb = hostedBy(doc, e.id).filter((x) => x.cat === 'rebar' || x.cat === 'areaRebar' || x.cat === 'fabricArea').length;
      const lvl = doc.get(e.levelId ?? doc.get(e.hostId)?.levelId);
      t.append(h('tr', {}, h('td', {}, catDef(e.cat)?.label ?? e.cat), h('td', {}, (doc.get(e.typeId)?.name ?? '') + (e.mark ? ' (' + e.mark + ')' : '')), h('td', {}, lvl?.name ?? ''), h('td', {}, String(nReb)), h('td', {}, inp)));
    }
    if (!hosts.length) t.append(h('tr', {}, h('td', { colspan: '5', style: 'color:#777' }, 'Keine Betonbauteile vorhanden.')));
    tableBox.append(t);
  };
  if (selHosts.length) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = onlySel;
    cb.onchange = () => { onlySel = cb.checked; render(); };
    body.append(h('div', { class: 'form-row' }, h('label', {}, cb, ` Nur ausgewählte Bauteile (${selHosts.length})`)));
  }
  body.append(tableBox);
  const adapt = h('input', { type: 'checkbox' }) as HTMLInputElement; adapt.checked = true;
  body.append(h('div', { class: 'form-row' }, h('label', { style: 'min-width:0' }, adapt, ' Vorhandene eingepasste Stabbewehrung an die neue Deckung anpassen')));
  render();
  modal('Betondeckung (Bewehrungsüberdeckung)', body, [
    { label: 'OK', primary: true, onClick: () => {
      const v = parseLen(def.value);
      if (v === null || v < 0) { alert('Ungültige Deckung'); return false; }
      const projChanged = v !== (pi?.rebarCover ?? 30);
      let n = 0;
      doc.transaction('Betondeckung', () => {
        if (projChanged) doc.update('project', { rebarCover: v });
        for (const [id, c] of edits) if (doc.get(id) && doc.get(id)!.rebarCover !== c) doc.update(id, { rebarCover: c });
        if (!adapt.checked) return;
        for (const r of doc.all<Rebar>('rebar')) {
          if (!r.fit || r.cover) continue;
          if (!projChanged && !edits.has(r.hostId)) continue;
          const p = refit(doc, r, {});
          if (p.pts) { doc.update(r.id, p); n++; }
        }
      });
      app.status(`Betondeckung gespeichert${n ? ` – ${n} Bewehrungssatz/-sätze angepasst` : ''}.`);
    } },
    { label: 'Abbrechen', onClick: () => {} },
  ], 680);
}
