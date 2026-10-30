// Ansichtssteuerungsleiste unten im Ansichtsfenster (Maßstab, Detaillierungsgrad, Stil, Zuschneiden, HH/HI).
import { app } from '../app';
import type { View, Detail } from '../core/view';
import { icon } from './icons';
import { getTempVis, tempActive, resetTempVis } from '../views/viewBuilder';
import { bumpTempVis } from '../views/canvasView';

export const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

export function setViewProp(view: View, patch: Partial<View>, name = 'Ansicht ändern'): void {
  app.doc.transaction(name, () => app.doc.update(view.id, patch));
  app.refreshViews();
  app.emit('view');
}

export function buildViewControlBar(vp: { view: View; bar: HTMLElement; invalidate(): void }): void {
  const bar = vp.bar;
  const render = () => {
    const v = app.doc.get<View>(vp.view.id) ?? vp.view;
    bar.innerHTML = '';
    if (v.kind === 'sheet') {
      const lbl = document.createElement('span'); lbl.className = 'vcb-label'; lbl.textContent = 'Plan'; bar.appendChild(lbl);
      return;
    }
    // Maßstab
    const sc = document.createElement('select');
    sc.className = 'vcb-scale'; sc.title = 'Maßstab der Ansicht';
    for (const s of SCALES) { const o = document.createElement('option'); o.value = String(s); o.textContent = '1 : ' + s; sc.appendChild(o); }
    if (!SCALES.includes(v.scale)) { const o = document.createElement('option'); o.value = String(v.scale); o.textContent = '1 : ' + v.scale; sc.appendChild(o); }
    sc.value = String(v.scale);
    sc.onchange = () => setViewProp(v, { scale: parseInt(sc.value, 10) }, 'Maßstab ändern');
    bar.appendChild(sc);
    // Detaillierungsgrad
    const det: [Detail, string, string][] = [['coarse', 'Grob', '▭'], ['medium', 'Mittel', '▤'], ['fine', 'Fein', '▦']];
    const dg = document.createElement('span'); dg.className = 'vcb-group';
    for (const [d, lbl, sym] of det) {
      const b = document.createElement('button');
      b.className = 'vcb-btn' + (v.detail === d ? ' on' : '');
      b.textContent = sym; b.title = 'Detaillierungsgrad: ' + lbl;
      b.onclick = () => setViewProp(v, { detail: d }, 'Detaillierungsgrad');
      dg.appendChild(b);
    }
    bar.appendChild(dg);
    // Visueller Stil (Schnitt/Ansicht)
    if (v.kind === 'elevation' || v.kind === 'section') {
      const st = document.createElement('select'); st.className = 'vcb-scale'; st.title = 'Visueller Stil';
      for (const [k, l] of [['hidden', 'Verdeckte Linie'], ['shaded', 'Schattiert']]) { const o = document.createElement('option'); o.value = k; o.textContent = l; st.appendChild(o); }
      st.value = v.style === 'shaded' ? 'shaded' : 'hidden';
      st.onchange = () => setViewProp(v, { style: st.value as any }, 'Visueller Stil');
      bar.appendChild(st);
    }
    // Zuschneiden
    if (v.kind !== 'drafting' && v.kind !== 'legend') {
      const cr = document.createElement('button');
      cr.className = 'vcb-btn' + (v.crop?.on ? ' on' : ''); cr.innerHTML = icon('crop', 16); cr.title = 'Ansicht zuschneiden';
      cr.onclick = () => {
        const crop = v.crop ?? { on: false, show: true, min: { x: -10000, y: -10000 }, max: { x: 10000, y: 10000 } };
        if (!v.crop && (vp as any).visibleBox) { const b = (vp as any).visibleBox(); crop.min = b.min; crop.max = b.max; }
        setViewProp(v, { crop: { ...crop, on: !crop.on } }, 'Zuschneiden');
      };
      bar.appendChild(cr);
      const cs = document.createElement('button');
      cs.className = 'vcb-btn' + (v.crop?.show ? ' on' : ''); cs.innerHTML = '⬚'; cs.title = 'Zuschneidebereich anzeigen/ausblenden';
      cs.onclick = () => { const crop = v.crop ?? { on: false, show: false, min: { x: -10000, y: -10000 }, max: { x: 10000, y: 10000 } }; setViewProp(v, { crop: { ...crop, show: !crop.show } }, 'Zuschneidebereich'); };
      bar.appendChild(cs);
    }
    // Temporär ausblenden/isolieren
    const ti = document.createElement('button');
    const active = tempActive(v.id);
    ti.className = 'vcb-btn' + (active ? ' on warn' : ''); ti.innerHTML = '🕶'; ti.title = 'Temporär ausblenden/isolieren (HH, HI, HR)';
    ti.onclick = (e) => tempMenu(e, v);
    bar.appendChild(ti);
    const rv = document.createElement('button');
    const tv = getTempVis(v.id);
    rv.className = 'vcb-btn' + (tv.reveal ? ' on warn' : ''); rv.innerHTML = '💡'; rv.title = 'Verdeckte Elemente anzeigen (RH)';
    rv.onclick = () => { tv.reveal = !tv.reveal; bumpTempVis(); render(); };
    bar.appendChild(rv);
    const tl = document.createElement('button');
    tl.className = 'vcb-btn' + (app.settings.thinLines ? ' on' : ''); tl.innerHTML = icon('thinlines', 16); tl.title = 'Dünne Linien (TL)';
    tl.onclick = () => { app.settings.thinLines = !app.settings.thinLines; app.saveSettings(); };
    bar.appendChild(tl);
    if (active) {
      const lbl = document.createElement('span'); lbl.className = 'vcb-temp'; lbl.textContent = 'Temporär ausblenden/isolieren aktiv';
      bar.appendChild(lbl);
    }
  };
  render();
  app.on('view', render);
  app.on('settings', render);
  app.on('views', render);
}

function tempMenu(e: MouseEvent, v: View): void {
  const items: [string, () => void][] = [
    ['Element isolieren (HI)', () => tempIsolate(v, false)],
    ['Kategorie isolieren (IC)', () => tempIsolate(v, true)],
    ['Element ausblenden (HH)', () => tempHide(v, false)],
    ['Kategorie ausblenden (HC)', () => tempHide(v, true)],
    ['Temporär ausblenden/isolieren zurücksetzen (HR)', () => { resetTempVis(v.id); bumpTempVis(); app.emit('view'); }],
  ];
  showMenu(e.clientX, e.clientY, items);
}

export function tempHide(v: View, byCat: boolean): void {
  const sel = app.selected(); if (!sel.length) { app.status('Zuerst Elemente auswählen.'); return; }
  const t = getTempVis(v.id);
  for (const e of sel) byCat ? t.hiddenCats.add(e.cat) : t.hidden.add(e.id);
  app.select([]); bumpTempVis(); app.emit('view');
}
export function tempIsolate(v: View, byCat: boolean): void {
  const sel = app.selected(); if (!sel.length) { app.status('Zuerst Elemente auswählen.'); return; }
  const t = getTempVis(v.id);
  if (byCat) t.isolateCats = new Set(sel.map((e) => e.cat));
  else t.isolate = new Set(sel.map((e) => e.id));
  bumpTempVis(); app.emit('view');
}

export function showMenu(x: number, y: number, items: ([string, () => void] | '-')[]): void {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); continue; }
    const d = document.createElement('div'); d.className = 'ctx-item'; d.textContent = it[0];
    d.onclick = () => { m.remove(); it[1](); };
    m.appendChild(d);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  setTimeout(() => {
    const close = (ev: MouseEvent) => { if (!m.contains(ev.target as Node)) { m.remove(); window.removeEventListener('mousedown', close); } };
    window.addEventListener('mousedown', close);
  }, 0);
}
