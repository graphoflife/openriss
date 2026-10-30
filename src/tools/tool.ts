// Werkzeug-Grundlagen: Ereignisse, Optionsleiste, Basisklasse.
import type { V2 } from '../core/geom';
import type { DisplayList } from '../render/displayList';
import type { View } from '../core/view';
import type { El, Id } from '../core/doc';
import type { SnapResult } from './snap';

export interface ToolEvent {
  /** gefangener Punkt (Ansichtskoordinaten) */
  p: V2;
  /** ungefangener Punkt */
  raw: V2;
  screen: V2;
  snap: SnapResult | null;
  button: number;
  shift: boolean; ctrl: boolean; alt: boolean;
  view: View;
  /** Viewport (CanvasView) */
  vp: any;
}

export type OptionItem =
  | { kind: 'label'; text: string }
  | { kind: 'number' | 'length' | 'angle'; key: string; label: string; value: number; width?: number; onChange: (v: number) => void }
  | { kind: 'text'; key: string; label: string; value: string; width?: number; onChange: (v: string) => void }
  | { kind: 'check'; key: string; label: string; value: boolean; onChange: (v: boolean) => void }
  | { kind: 'select'; key: string; label: string; value: string; options: [string, string][]; onChange: (v: string) => void }
  | { kind: 'buttons'; key: string; value: string; options: { id: string; label: string; icon?: string; tip?: string }[]; onChange: (v: string) => void }
  | { kind: 'button'; label: string; icon?: string; onClick: () => void; primary?: boolean };

/** Platzierungsvorgabe: was die Eigenschaftenpalette während des Werkzeugs anzeigt */
export interface PlacementTarget {
  cat: string;
  typeId?: Id;
  /** Vorlage für Instanzparameter (wird von der Palette bearbeitet) */
  proto: El;
  setType(id: Id): void;
}

export abstract class Tool {
  abstract id: string;
  abstract label: string;
  cursor = 'crosshair';
  /** an Ansicht gebunden: bei Ansichtswechsel beenden */
  viewBound = true;
  /** Objektfang verwenden */
  snapping = true;
  /** Ansichtsarten, in denen das Werkzeug funktioniert (leer = alle 2D) */
  kinds: string[] = [];
  /** Palette: Typ/Parameter für neue Elemente */
  placement: PlacementTarget | null = null;

  activate(): void { /* */ }
  deactivate(): void { /* */ }
  prompt(): string { return ''; }
  down(_e: ToolEvent): void { /* */ }
  move(_e: ToolEvent): void { /* */ }
  up(_e: ToolEvent): void { /* */ }
  dbl(_e: ToolEvent): void { /* */ }
  /** true = verarbeitet */
  key(_e: KeyboardEvent): boolean { return false; }
  /** Esc: true = Schritt abgebrochen, Werkzeug bleibt aktiv */
  escape(): boolean { return false; }
  /** Enter / Fertig stellen */
  enter(): boolean { return false; }
  /** Leertaste (Umkehren/Drehen) */
  space(): boolean { return false; }
  /** Vorschau (Ansichtskoordinaten) */
  preview(_dl: DisplayList, _vp: any): void { /* */ }
  /** Basispunkt für Fang (senkrecht) und Längeneingabe */
  basePoint(): V2 | null { return null; }
  /** Richtung für eingegebene Länge (Cursor relativ zum Basispunkt) */
  typedLength?(len: number, e: ToolEvent | null): void;
  options(): OptionItem[] { return []; }
  /** Ansicht unterstützt? */
  supports(view: View): boolean { return !this.kinds.length || this.kinds.includes(view.kind); }
}

export const isPlanView = (v: View) => v.kind === 'plan' || v.kind === 'ceiling';
export type { El };
