// Rampe (Architektur › Erschließung): Achse wählen (Anfang → Ende), erzeugt eine Geschossdecke mit
// Gefällsprofil (ramp: true, Übergänge oben und unten mit halber Neigung) und optional Trogwände beidseitig,
// deren Unterkante auf der Rampe fixiert ist (attachBaseId) und deren Oberkante waagrecht durchläuft.
import type { Doc, Id } from '../../core/doc';
import { newId } from '../../core/doc';
import { V2, add, sub, mul, norm, perp, dist } from '../../core/geom';
import { registerCommand } from '../../core/registry';
import { levelElev, levelOptions, typesOf, TypeEl } from '../../core/view';
import { fmtNum } from '../../core/units';
import { app } from '../../app';
import { Tool, ToolEvent, OptionItem } from '../../tools/tool';
import { PREVIEW, PREVIEW_THIN } from '../../tools/drawTool';
import { placementFor, rememberProto, activeLevelId } from '../../tools/elementTools';
import { startTool } from '../../ui/commands';
import type { DisplayList } from '../../render/displayList';
import { Wall, typeThickness, WallType } from '../../elements/wall';
import type { Floor } from './floor';
import { SlopePt, slopeArrow, fmtPct } from './slope';

/** Eingabe einer Rampe */
export interface RampSpec {
  /** Achse: Anfang (Bezug der Höhe) → Ende */
  a: V2; b: V2;
  /** OK Rampe am Anfang = Ebene + offset */
  levelId: Id; offset?: number;
  /** OK Rampe am Ende = endLevelId (Standard: levelId) + endOffset */
  endLevelId?: Id; endOffset?: number;
  /** lichte Breite zwischen den Trogwänden (Standard 6000) */
  width?: number;
  /** max. Neigung % (Standard 15), Übergangsneigung % (8) und Übergangslänge (3000; 0 = ohne Übergänge) */
  maxPct?: number; transPct?: number; transLen?: number;
  /** Deckentyp */
  typeId?: Id;
  /** Trogwände beidseitig (Standard: ja) */
  walls?: boolean; wallTypeId?: Id;
  /** OK Trogwände über OK Rampenanfang (Standard 1000) */
  wallTop?: number;
  id?: Id; mark?: string;
}

/**
 * Längsprofil einer Rampe der Länge L mit Höhendifferenz dz (Ende − Anfang): Übergänge der Länge transLen mit
 * transPct an beiden Enden, dazwischen die Hauptneigung. Ohne Übergang, wenn die Rampe flacher als der Übergang ist.
 */
export function rampProfile(L: number, dz: number, transPct = 8, transLen = 3000): { prof: SlopePt[]; main: number } {
  const h = Math.abs(dz), sg = dz < 0 ? -1 : 1, gt = Math.abs(transPct) / 100, Lt = Math.max(0, transLen);
  const lin = { prof: [{ s: 0, dz: 0 }, { s: L, dz }], main: L > 0 ? h / L : 0 };
  if (!(Lt > 0) || 2 * Lt >= L - 1 || h / L <= gt) return lin;
  const gm = (h - 2 * Lt * gt) / (L - 2 * Lt);
  if (gm <= gt) return lin;
  return { prof: [{ s: 0, dz: 0 }, { s: Lt, dz: sg * Lt * gt }, { s: L - Lt, dz: sg * (h - Lt * gt) }, { s: L, dz }], main: gm };
}

const wallT = (doc: Doc, typeId?: Id): number => { const t = doc.get<WallType>(typeId); return t?.layers ? typeThickness(t) : 300; };
const firstWallType = (doc: Doc): Id | undefined => (doc.get('wt_stb30') ? 'wt_stb30' : doc.get('wt_stb25') ? 'wt_stb25' : typesOf(doc, 'wall')[0]?.id);
const firstFloorType = (doc: Doc): Id | undefined => (doc.get('flt_stb25') ? 'flt_stb25' : typesOf(doc, 'floor')[0]?.id);

/** Rampe (Geschossdecke mit Profil) und Trogwände erzeugen – in einer Transaktion aufrufen. */
export function createRamp(doc: Doc, o: RampSpec): { floor: Floor; walls: Wall[]; main: number } {
  const L = dist(o.a, o.b); const d = norm(sub(o.b, o.a)); const n = perp(d);
  const z0 = levelElev(doc, o.levelId) + (o.offset ?? 0);
  const z1 = levelElev(doc, o.endLevelId ?? o.levelId) + (o.endOffset ?? 0);
  const W = o.width ?? 6000; const withWalls = o.walls !== false;
  const wt = o.wallTypeId ?? firstWallType(doc); const T = withWalls ? wallT(doc, wt) : 0;
  const { prof, main } = rampProfile(L, z1 - z0, o.transPct ?? 8, o.transLen ?? 3000);
  const hw = W / 2 + T;
  const P = (s: number, v: number) => add(add(o.a, mul(d, s)), mul(n, v));
  const floor = doc.add<Floor>({
    id: o.id ?? newId('fl'), cat: 'floor', typeId: o.typeId ?? firstFloorType(doc), levelId: o.levelId, offset: o.offset ?? 0,
    loops: [[P(0, -hw), P(L, -hw), P(L, hw), P(0, hw)]], structural: true, ramp: true, mark: o.mark,
    slope: { a: { ...o.a }, dir: d, prof },
  } as Floor);
  const walls: Wall[] = [];
  if (withWalls) {
    const zTop = z0 + (o.wallTop ?? 1000);
    const zLow = Math.min(z0, z1);
    for (const side of [1, -1]) {
      const v = side * (W / 2 + T / 2);
      const a = side > 0 ? P(L, v) : P(0, v), b = side > 0 ? P(0, v) : P(L, v);
      walls.push(doc.add<Wall>({
        id: newId('wa'), cat: 'wall', typeId: wt, a, b, levelId: o.levelId, baseOffset: zLow - levelElev(doc, o.levelId), topLevelId: null, topOffset: 0,
        height: Math.max(100, zTop - zLow), locLine: 'center', flip: false, structural: true, attachBaseId: floor.id, comments: 'Trogwand Rampe',
      } as Wall));
    }
  }
  return { floor, walls, main };
}

// ------------------------------------------------------------ Werkzeug
const RO = { width: 6000, maxPct: 15, transPct: 8, transLen: 3000, walls: true, wallTop: 1000, wallTypeId: '' as Id, endLevelId: '' as Id, endOffset: -3000 };

class RampTool extends Tool {
  id = 'ramp'; label = 'Rampe'; kinds = ['plan'];
  private start: V2 | null = null; private cur: V2 | null = null;
  activate(): void {
    const lvl = activeLevelId();
    this.placement = placementFor('floor', { levelId: lvl, offset: 0, typeId: firstFloorType(app.doc) });
    this.placement.proto.levelId = lvl;
    if (!RO.wallTypeId || !app.doc.get(RO.wallTypeId)) RO.wallTypeId = firstWallType(app.doc) ?? '';
  }
  deactivate(): void { rememberProto(this.placement); }
  prompt(): string { return this.start ? 'Ende der Rampenachse wählen (Zahl eingeben für exakte Länge).' : 'Anfang der Rampenachse wählen (OK = Ebene + Versatz).'; }
  basePoint(): V2 | null { return this.start; }
  options(): OptionItem[] {
    const doc = app.doc;
    const wts = typesOf<TypeEl>(doc, 'wall').map((t) => [t.id, t.name] as [string, string]);
    const o: OptionItem[] = [
      { kind: 'length', key: 'width', label: 'Breite (licht)', value: RO.width, onChange: (v) => { RO.width = Math.max(500, v); app.redrawOverlay(); } },
      { kind: 'number', key: 'maxPct', label: 'max. Gefälle %', value: RO.maxPct, onChange: (v) => { RO.maxPct = v; } },
      { kind: 'number', key: 'transPct', label: 'Übergang %', value: RO.transPct, onChange: (v) => { RO.transPct = Math.max(0, v); } },
      { kind: 'length', key: 'transLen', label: 'Übergangslänge', value: RO.transLen, onChange: (v) => { RO.transLen = Math.max(0, v); } },
      { kind: 'select', key: 'endLevel', label: 'Ende: Ebene', value: RO.endLevelId, options: [['', 'wie Anfang'], ...levelOptions(doc)], onChange: (v) => { RO.endLevelId = v; } },
      { kind: 'length', key: 'endOffset', label: 'Ende: Versatz', value: RO.endOffset, onChange: (v) => { RO.endOffset = v; } },
      { kind: 'check', key: 'walls', label: 'Trogwände', value: RO.walls, onChange: (v) => { RO.walls = v; app.emit('tool'); app.redrawOverlay(); } },
    ];
    if (RO.walls) o.push(
      { kind: 'select', key: 'wallType', label: 'Wandtyp', value: RO.wallTypeId, options: wts, onChange: (v) => { RO.wallTypeId = v; app.redrawOverlay(); } },
      { kind: 'length', key: 'wallTop', label: 'OK Wand über Anfang', value: RO.wallTop, onChange: (v) => { RO.wallTop = v; } },
    );
    return o;
  }
  move(e: ToolEvent): void { this.cur = e.p; }
  escape(): boolean { if (this.start) { this.start = null; app.setPrompt(this.prompt()); return true; } return false; }
  down(e: ToolEvent): void {
    if (e.button !== 0) return;
    if (!this.start) { this.start = e.p; app.setPrompt(this.prompt()); return; }
    if (dist(this.start, e.p) < 500) { app.status('Rampe zu kurz.'); return; }
    this.create(this.start, e.p);
  }
  typedLength(len: number): void {
    if (!this.start || !this.cur || dist(this.start, this.cur) < 1) return;
    this.create(this.start, add(this.start, mul(norm(sub(this.cur, this.start)), len)));
  }
  private spec(a: V2, b: V2): RampSpec {
    const p = this.placement!.proto;
    return {
      a, b, levelId: p.levelId ?? activeLevelId(), offset: p.offset ?? 0, endLevelId: RO.endLevelId || undefined, endOffset: RO.endOffset, width: RO.width,
      maxPct: RO.maxPct, transPct: RO.transPct, transLen: RO.transLen, typeId: this.placement!.typeId, walls: RO.walls, wallTypeId: RO.wallTypeId || undefined, wallTop: RO.wallTop,
    };
  }
  private create(a: V2, b: V2): void {
    let ids: Id[] = []; let main = 0;
    app.doc.transaction('Rampe erstellen', () => { const r = createRamp(app.doc, this.spec(a, b)); main = r.main; ids = [r.floor.id, ...r.walls.map((w) => w.id)]; });
    app.select(ids);
    const msg = `Rampe: Hauptneigung ${fmtPct(main)}`;
    app.status(main * 100 > RO.maxPct + 1e-6 ? `${msg} – grösser als das zulässige Gefälle von ${fmtNum(RO.maxPct, 1)} %! Rampe verlängern.` : msg);
    this.start = null; this.cur = null;
    app.setPrompt(this.prompt());
  }
  preview(dl: DisplayList): void {
    if (!this.start || !this.cur || dist(this.start, this.cur) < 10) return;
    const d = norm(sub(this.cur, this.start)), n = perp(d), L = dist(this.start, this.cur);
    const T = RO.walls ? wallT(app.doc, RO.wallTypeId) : 0; const hw = RO.width / 2;
    const P = (s: number, v: number) => add(add(this.start!, mul(d, s)), mul(n, v));
    dl.poly([P(0, -hw), P(L, -hw), P(L, hw), P(0, hw)], PREVIEW, true);
    if (T) for (const sg of [1, -1]) dl.poly([P(0, sg * hw), P(L, sg * hw), P(L, sg * (hw + T)), P(0, sg * (hw + T))], PREVIEW_THIN, true);
    const p = this.placement!.proto; const doc = app.doc;
    const dz = levelElev(doc, RO.endLevelId || p.levelId) + RO.endOffset - (levelElev(doc, p.levelId) + (p.offset ?? 0));
    const { main } = rampProfile(L, dz, RO.transPct, RO.transLen);
    const hi = dz <= 0 ? this.start : this.cur, lo = dz <= 0 ? this.cur : this.start;
    slopeArrow(dl, hi, lo, fmtPct(main), PREVIEW);
  }
}

registerCommand({ id: 'ramp', label: 'Rampe', icon: 'ramp', tip: 'Rampe entlang einer Achse: geneigte Platte mit Übergängen (max. Gefälle, Übergangsneigung/-länge) und optional Trogwänden', run: () => startTool(new RampTool(), 'ramp') });


