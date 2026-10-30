// Einstiegspunkt: Module laden, Oberfläche aufbauen, Projekt wiederherstellen oder neu anlegen.
import './ui/styles.css';
import { app } from './app';
// Kernelemente, Befehle und Fachmodule
import './registerModules';
import { buildShell } from './ui/shell';
import { installKeyboard } from './ui/keyboard';
import { SelectTool } from './tools/selectTool';
import { createNew, installAutosave, restoreAutosave } from './io/file';
import { emitHook } from './core/registry';
import { showWelcome } from './ui/welcome';

async function start(): Promise<void> {
  const select = new SelectTool();
  app.defaultTool = select;
  app.tool = select;
  buildShell(document.getElementById('app')!);
  installKeyboard();
  const restored = await restoreAutosave();
  if (!restored) createNew();
  app.doc.clearHistory();
  installAutosave();
  app.setTool(null);
  emitHook('started');
  showWelcome();
}
start();
