// Modul: view3d – 3D-Ansicht (three.js) mit Revit-Navigation, ViewCube, visuellen Stilen,
// Schnittbereich sowie IFC4-, glTF- und OBJ-Export.
import { app } from '../../app';
import { newId } from '../../core/doc';
import type { El } from '../../core/doc';
import { registerCommand, registerViewport, registerPanel, registerContextPanel, catDef, allCats, onHook, GROUPS, PropDef } from '../../core/registry';
import { View, projectInfo } from '../../core/view';
import { registerIcon } from '../../ui/icons';
import { visibilityDialog, toast } from '../../ui/dialogs';
import { download } from '../../io/file';
import { View3D, STYLE_LABELS } from './viewport3d';
import { VIEWCUBE_CSS } from './viewcube';
import { SECTIONBOX_CSS } from './sectionbox';
import { exportIfc } from './ifc';
import { exportScene, toGlb, toObj, disposeScene } from './export3d';
import { elements3d } from './meshes';
import { solidsOf } from '../../views/sectionEngine';

// ------------------------------------------------------------ Stile & Symbole
const style = document.createElement('style');
style.textContent = VIEWCUBE_CSS + SECTIONBOX_CSS + `
.v3d .v3d-canvas { cursor: default; outline: none; }
.v3d-pivot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: rgba(40,170,60,.85); border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.35); pointer-events: none; z-index: 5; }
.v3d-rect { position: absolute; border: 1px solid #1e6fd9; background: rgba(30,111,217,.08); pointer-events: none; z-index: 5; }
.v3d-rect.crossing { border-style: dashed; border-color: #2a9a40; background: rgba(40,160,60,.08); }
.v3d-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #5d6873; padding: 24px; text-align: center; }
`;
document.head.appendChild(style);

const B = '#2a6fd6';
registerIcon('sectionbox', `<path d="M4 8 L12 4 L20 8 L20 17 L12 21 L4 17 Z" fill="#eef3f9" stroke="currentColor"/><path d="M4 8 L12 12 L20 8 M12 12 V21" stroke="currentColor" stroke-dasharray="2 1.5"/><path d="M12 7.5 V1.8 M10 3.6 L12 1.5 L14 3.6" stroke="${B}" stroke-width="1.6"/>`);
registerIcon('selectionbox', `<path d="M4 8 L12 4 L20 8 L20 17 L12 21 L4 17 Z" fill="#eef3f9" stroke="${B}" stroke-dasharray="2.5 1.5"/><rect x="8.5" y="10" width="7" height="6" fill="#c8a878" stroke="currentColor"/>`);
registerIcon('persp3d', `<path d="M3 9 L9 10.5 V13.5 L3 15 Z" fill="#dfe8f2" stroke="currentColor"/><path d="M9 10.5 L21 5 V19 L9 13.5" fill="none" stroke="${B}"/>`);
registerIcon('glb', `<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z" fill="#dfe8f2" stroke="currentColor"/><path d="M4 7.5 L12 12 L20 7.5 M12 12 V21" stroke="currentColor"/><path d="M15 2 H21 V8 M21 2 L15.5 7.5" stroke="${B}" stroke-width="1.6"/>`);

// ------------------------------------------------------------ Ansichtsfenster
registerViewport({ kinds: ['3d'], create: (view, host) => new View3D(view, host) });

const active3d = (): View3D | null => (app.active instanceof View3D ? app.active : null);
const vpFor = (id: string): View3D | null => { const v = app.viewports.get(id); return v instanceof View3D ? v : null; };

/** Standard-3D-Ansicht {3D} suchen oder anlegen */
export function default3dView(): View {
  let v = app.doc.all<View>('view').find((x) => x.kind === '3d' && x.name === '{3D}');
  if (!v) {
    app.doc.transaction('Standard-3D-Ansicht', () => {
      v = app.doc.add<View>({ id: newId('vw'), cat: 'view', kind: '3d', name: '{3D}', scale: 100, detail: 'medium', style: 'shaded' } as View);
    });
  }
  return v!;
}

// ------------------------------------------------------------ Befehle
registerCommand({
  id: 'default3d', label: '3D-Ansicht', icon: 'view3d', keys: ['3D'],
  tip: 'Standard-3D-Ansicht {3D} öffnen. Mausrad = Zoom, Mitteltaste = Verschieben, Umschalt+Mitteltaste (oder rechte Maustaste ziehen) = Orbit, Doppelklick Mitteltaste = Zoom Grenzen.',
  run: () => app.openView(default3dView().id),
});

registerCommand({
  id: 'sectionBox3d', label: 'Schnittbereich', icon: 'sectionbox',
  tip: 'Schnittbereich der aktiven 3D-Ansicht ein-/ausschalten. Griffe auf den Seitenflächen ziehen, um ihn anzupassen.',
  enabled: () => !!active3d(), checked: () => !!active3d()?.view.data?.sectionBox?.on,
  run: () => active3d()?.toggleBox(),
});

registerCommand({
  id: 'selectionBox', label: 'Auswahlrahmen', icon: 'selectionbox', keys: ['BX'],
  tip: 'Schnittbereich um die ausgewählten Elemente legen (öffnet bei Bedarf die Standard-3D-Ansicht).',
  enabled: () => app.selection.size > 0,
  run: () => {
    const sel = app.selected().filter((e) => e.cat !== 'view' && solidsOf(app.doc, e).length);
    if (!sel.length) { app.status('Zuerst Modellelemente auswählen.'); return; }
    let vp = active3d();
    if (!vp) { app.openView(default3dView().id); vp = active3d(); }
    vp?.boxToSelection();
  },
});

const projName = () => (projectInfo(app.doc)?.name || 'Projekt').replace(/[^\w\-äöüÄÖÜß ]+/g, '_').trim() || 'Projekt';

registerCommand({
  id: 'exportIfc', label: 'IFC', icon: 'ifc',
  tip: 'Modell als IFC4-Datei (*.ifc) exportieren – Geschosse aus Ebenen, Bauteile mit Geometrie, Materialien und Eigenschaften.',
  run: () => {
    try {
      const name = projName() + '.ifc';
      const r = exportIfc(app.doc, name);
      download(name, r.text, 'application/x-step');
      toast(`IFC exportiert: ${r.count} Elemente.`);
    } catch (e) { console.error(e); alert('IFC-Export fehlgeschlagen: ' + (e as Error).message); }
  },
});

/** Ansicht für 3D-Export: aktive 3D-Ansicht, sonst {3D}, sonst alles */
function exportView(): View {
  const a = active3d()?.view ?? app.doc.all<View>('view').find((x) => x.kind === '3d' && x.name === '{3D}');
  return a ?? ({ id: '_export3d', cat: 'view', kind: '3d', name: '3D', scale: 100, detail: 'medium' } as View);
}

registerCommand({
  id: 'exportGltf', label: 'glTF (GLB)', icon: 'glb',
  tip: 'Sichtbare Modellgeometrie der 3D-Ansicht als glTF-Binärdatei (*.glb) exportieren (Meter, Y oben).',
  run: async () => {
    const root = exportScene(app.doc, exportView(), projName());
    try { download(projName() + '.glb', new Blob([await toGlb(root)], { type: 'model/gltf-binary' })); toast('glTF exportiert.'); }
    catch (e) { console.error(e); alert('glTF-Export fehlgeschlagen: ' + (e as Error).message); }
    finally { disposeScene(root); }
  },
});

registerCommand({
  id: 'exportObj', label: 'OBJ', icon: 'export',
  tip: 'Sichtbare Modellgeometrie der 3D-Ansicht als OBJ mit Materialdatei (*.obj, *.mtl) exportieren (Meter, Y oben).',
  run: async () => {
    const root = exportScene(app.doc, exportView(), projName());
    try {
      const { obj, mtl } = await toObj(root, projName() + '.mtl');
      download(projName() + '.obj', obj, 'text/plain');
      setTimeout(() => download(projName() + '.mtl', mtl, 'text/plain'), 300);
      toast('OBJ exportiert.');
    } catch (e) { console.error(e); alert('OBJ-Export fehlgeschlagen: ' + (e as Error).message); }
    finally { disposeScene(root); }
  },
});

registerPanel('Ansicht', '3D-Ansicht', ['sectionBox3d', 'selectionBox', { cmd: 'exportIfc', size: 'small' }, { cmd: 'exportGltf', size: 'small' }, { cmd: 'exportObj', size: 'small' }], 25);

// „Auswahlrahmen“ im Kontextregister für alle Modellkategorien (nach dem Laden aller Module)
onHook('started', () => {
  const cats = allCats().filter((d) => !d.annotation && !d.datum && d.solids && d.cat !== 'view').map((d) => d.cat);
  if (cats.length) registerContextPanel({ cats, panel: '3D', items: ['selectionBox'] });
});

// ------------------------------------------------------------ Eigenschaften der 3D-Ansicht
const viewDef = catDef('view');
if (viewDef) {
  const base = viewDef.props;
  viewDef.props = (el: El, doc) => {
    const p = base ? base(el, doc) : [];
    const v = el as View;
    if (v.kind !== '3d') return p;
    const g = GROUPS;
    const pre: PropDef[] = [
      { key: 'detail', label: 'Detaillierungsgrad', group: g.graphics, type: 'select', options: [['coarse', 'Grob'], ['medium', 'Mittel'], ['fine', 'Fein']], get: (e) => e.detail, set: (_e, x) => ({ detail: x }) },
      { key: 'style', label: 'Visueller Stil', group: g.graphics, type: 'select', options: STYLE_LABELS.map(([k, l]) => [k, l] as [string, string]), get: (e) => e.style ?? 'shaded', set: (_e, x) => ({ style: x }) },
      { key: 'vv', label: 'Sichtbarkeit/Grafiken überschreiben', group: g.graphics, type: 'button', get: () => 'Bearbeiten…', action: (e) => visibilityDialog(e as View) },
    ];
    const post: PropDef[] = [
      {
        key: 'sectionBox', label: 'Schnittbereich', group: g.extents, type: 'bool', get: (e) => !!e.data?.sectionBox?.on,
        set: (e, x) => {
          const cur = e.data?.sectionBox;
          let sb = cur && cur.min && cur.max ? { ...cur, on: !!x } : null;
          if (!sb) { const b = modelBounds(e as View); sb = { on: !!x, min: b.min, max: b.max }; }
          return { data: { ...(e.data ?? {}), sectionBox: sb } };
        },
      },
      { key: 'sectionBoxEdit', label: 'Schnittbereich bearbeiten', group: g.extents, type: 'button', get: () => 'Bearbeiten…', action: (e) => { if (app.activeView()?.id !== e.id) app.openView(e.id); vpFor(e.id)?.showBoxPanel(true); } },
      {
        key: 'persp', label: 'Perspektivisch', group: 'Kamera', type: 'bool', get: (e) => !!e.data?.camera?.persp,
        set: (e, x) => ({ data: { ...(e.data ?? {}), camera: { ...(e.data?.camera ?? {}), persp: !!x } } }),
      },
    ];
    return [...pre, ...p, ...post];
  };
}

/** Modellgrenzen der Ansicht (für neuen Schnittbereich ohne geöffnetes Fenster) */
function modelBounds(view: View): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const el of elements3d(app.doc, view)) for (const s of solidsOf(app.doc, el)) for (const f of s.faces) for (const p of f.pts) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  if (min.x > max.x) return { min: { x: -5000, y: -5000, z: -1000 }, max: { x: 15000, y: 10000, z: 8000 } };
  const m = 300;
  return { min: { x: min.x - m, y: min.y - m, z: min.z - m }, max: { x: max.x + m, y: max.y + m, z: max.z + m } };
}
