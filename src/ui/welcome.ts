// Startdialog beim ersten Aufruf: kurze Einführung für Revit-Umsteiger.
import { h, runCmd } from './shell';
import { modal } from './dialogs';
import { cmd } from '../core/registry';

export function showWelcome(force = false): void {
  if (!force && localStorage.getItem('openriss.welcomed')) return;
  localStorage.setItem('openriss.welcomed', '1');
  const body = h('div', { style: 'max-width:640px;line-height:1.5' });
  body.innerHTML = `
    <p style="margin-top:0"><b>Willkommen bei OpenRiss</b> – BIM-Zeichnen im Browser mit der Bedienung, die Sie aus Revit kennen.</p>
    <ul style="padding-left:18px;margin:6px 0">
      <li>Tastenkürzel wie gewohnt: <span class="kbd">WA</span> Wand, <span class="kbd">DR</span> Tür, <span class="kbd">WN</span> Fenster, <span class="kbd">DI</span> Bemaßung, <span class="kbd">MV</span> Verschieben, <span class="kbd">VV</span> Sichtbarkeit.</li>
      <li>Beim Zeichnen einfach eine Zahl tippen, um die Länge exakt einzugeben. <span class="kbd">Esc</span> zweimal beendet das Werkzeug, <span class="kbd">Enter</span> wiederholt den letzten Befehl.</li>
      <li>Ausgewählte Elemente zeigen temporäre Bemaßungen – Wert anklicken, ändern, Enter.</li>
      <li>Mausrad zoomt, mittlere Maustaste verschiebt, Doppelklick auf das Mausrad zeigt alles.</li>
      <li>Ihr Projekt wird automatisch im Browser zwischengespeichert; mit <span class="kbd">Strg+S</span> speichern Sie eine Datei.</li>
    </ul>`;
  const buttons: { label: string; primary?: boolean; onClick: () => void }[] = [];
  if (cmd('loadSample')) buttons.push({ label: 'Beispielprojekt öffnen', onClick: () => runCmd('loadSample') });
  buttons.push({ label: 'Projekt öffnen…', onClick: () => runCmd('open') });
  buttons.push({ label: 'Loslegen', primary: true, onClick: () => {} });
  modal('OpenRiss', body, buttons, 680);
}
