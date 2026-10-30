// Prüfung und Import von Elementlisten (JSON) – genutzt von Skript-API, CLI und „Einfügen → Projekt aus JSON“.
import { Doc, El, newId } from '../core/doc';
import { catDef } from '../core/registry';
import { loadData } from './file';

export interface ImportError { id: string; cat: string; field: string; msg: string }
export class ApiError extends Error {
  constructor(public errors: ImportError[]) { super(errors.map((e) => `${e.cat} ${e.id}: ${e.field} – ${e.msg}`).join('\n')); }
}

const SPECIAL = new Set(['type', 'material', 'project', 'view', 'level']);
const isNum = (v: any) => typeof v === 'number' && isFinite(v);
const isV2 = (v: any) => !!v && isNum(v.x) && isNum(v.y);
const isV3 = (v: any) => isV2(v) && isNum(v.z);
const V2_FIELDS = ['a', 'b', 'p', 'pt', 'p0', 'center', 'line', 'dir', 'anchor', 'lineA', 'lineB', 'off'];
const NUM_FIELDS = ['t', 'sill', 'elev', 'height', 'offset', 'baseOffset', 'topOffset', 'dia', 'count', 'spacing', 'span', 'scale', 'rot', 'width', 'far'];
const REQUIRED: Record<string, string[]> = {
  wall: ['a', 'b', 'levelId'], door: ['hostId', 't'], window: ['hostId', 't'], opening: ['hostId', 't'],
  floor: ['loops', 'levelId'], ceiling: ['loops', 'levelId'], roof: ['loops', 'levelId'], foundationSlab: ['loops', 'levelId'], shaft: ['loops'],
  column: ['p', 'levelId'], foundationIsolated: ['p', 'levelId'], beam: ['a', 'b', 'levelId'], foundationWall: ['hostId'],
  stair: ['p0', 'dir', 'levelId'], room: ['pt', 'levelId'], rebar: ['hostId', 'dia', 'pts'],
  grid: ['a', 'b', 'name'], refplane: ['a', 'b'], level: ['elev', 'name'], viewport: ['viewId', 'refId', 'center'],
  view: ['kind', 'name'], type: ['of', 'name'], material: ['name'],
};

/** Elemente prüfen (gegen das Dokument und die übrigen Elemente der Liste). Liefert alle Fehler mit Element-ID und Feld. */
export function validate(els: El[], d: Doc): ImportError[] {
  const errs: ImportError[] = [];
  const batch = new Map<string, El>();
  for (const e of els) if (e && typeof e.id === 'string') batch.set(e.id, e);
  const get = (id: any): El | undefined => (typeof id === 'string' ? batch.get(id) ?? d.get(id) : undefined);
  const seen = new Set<string>();
  for (const e of els) {
    const id = String(e?.id ?? '?'), cat = String(e?.cat ?? '?');
    const err = (field: string, msg: string) => errs.push({ id, cat, field, msg });
    if (!e || typeof e !== 'object') { err('', 'kein Objekt'); continue; }
    if (typeof e.id !== 'string' || !e.id) err('id', 'fehlt');
    else if (seen.has(e.id)) err('id', 'doppelt in der Liste'); else seen.add(e.id);
    if (typeof e.cat !== 'string') { err('cat', 'fehlt'); continue; }
    const def = catDef(e.cat);
    if (!def && !SPECIAL.has(e.cat)) { err('cat', `unbekannte Kategorie „${e.cat}“`); continue; }
    for (const f of REQUIRED[e.cat] ?? []) if (e[f] === undefined || e[f] === null || e[f] === '') err(f, 'Pflichtfeld fehlt');
    const geomEl = !['type', 'material', 'project'].includes(e.cat); // Typen haben freie Parameter (z.B. b = Breite)
    if (geomEl) for (const f of V2_FIELDS) if (e[f] !== undefined && e[f] !== null && !isV2(e[f])) err(f, 'Punkt {x, y} mit Zahlen erwartet');
    if (geomEl) for (const f of NUM_FIELDS) if (e[f] !== undefined && e[f] !== null && !isNum(e[f])) err(f, 'Zahl erwartet');
    if (e.cat === 'wall' && isV2(e.a) && isV2(e.b) && Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) < 1) err('b', 'Wand kürzer als 1 mm');
    if (Array.isArray(e.loops)) e.loops.forEach((l: any, i: number) => {
      if (!Array.isArray(l) || l.length < 3 || !l.every(isV2)) err(`loops[${i}]`, 'Umriss mit mindestens 3 Punkten {x, y} erwartet');
    }); else if (e.loops !== undefined) err('loops', 'Liste von Umrissen erwartet');
    if (e.cat === 'rebar' && e.pts !== undefined && (!Array.isArray(e.pts) || e.pts.length < 2 || !e.pts.every(isV3))) err('pts', 'mindestens 2 Punkte {x, y, z} erwartet');
    const ref = (f: string, cats?: string[]) => {
      const v = e[f]; if (v === undefined || v === null || v === '') return;
      const t = get(v);
      if (!t) err(f, `verweist auf unbekanntes Element „${v}“`);
      else if (cats && !cats.includes(t.cat)) err(f, `verweist auf ${t.cat}, erwartet ${cats.join('/')}`);
    };
    ref('levelId', ['level']); ref('topLevelId', ['level']); ref('viewId', ['view']); ref('refId');
    ref('hostId', e.cat === 'door' || e.cat === 'window' || e.cat === 'opening' ? ['wall'] : undefined);
    if (e.typeId !== undefined && e.cat !== 'type') {
      const t = get(e.typeId);
      if (!t) err('typeId', `unbekannter Typ „${e.typeId}“`);
      else if (t.cat !== 'type' || (t.of && t.of !== e.cat && !(def?.hasTypes === false))) err('typeId', `Typ „${e.typeId}“ gehört zu „${t.of}“, nicht zu „${e.cat}“`);
    }
    if (e.cat === 'view' && e.kind === 'plan') ref('levelId', ['level']);
    if (e.cat === 'view' && e.kind === 'section' && (!isV2(e.lineA) || !isV2(e.lineB))) err('lineA', 'Schnittlinie lineA/lineB fehlt');
  }
  return errs;
}


const firstType = (doc: Doc, of: string) => doc.all<any>('type').find((t) => t.of === of)?.id;

/** Elementliste prüfen und importieren (replace: Projekt ersetzen, dryRun: nur prüfen) */
export function importElements(doc: Doc, data: any, o: { replace?: boolean; dryRun?: boolean } = {}): { added: number; errors: ImportError[] } {
  const els = normalizeImport(data);
  for (const e of els) {
    if (!e.id) e.id = newId(String(e.cat ?? 'el').slice(0, 2));
    if (!o.replace && catDef(e.cat)?.hasTypes && !e.typeId) e.typeId = firstType(doc, e.cat);
  }
  if (o.replace) {
    const errs = validate(els, new Doc());
    if (errs.length || o.dryRun) return { added: 0, errors: errs };
    loadData({ elements: els });
    return { added: els.length, errors: [] };
  }
  const errors = validate(els, doc);
  if (errors.length || o.dryRun) return { added: 0, errors };
  doc.transaction('Projekt aus JSON', () => { for (const e of els) doc.add(e); });
  return { added: els.length, errors: [] };
}

const SECTION_CAT: Record<string, string> = {
  walls: 'wall', partitions: 'wall', doors: 'door', windows: 'window', openings: '', slabs: 'floor', floors: 'floor', roofs: 'roof',
  ceilings: 'ceiling', columns: 'column', beams: 'beam', stairs: 'stair', railings: 'railing', rooms: 'room', grids: 'grid',
  levels: 'level', rebar: 'rebar', views: 'view', sheets: 'view', types: 'type', materials: 'material', components: 'component',
};
/** Eingabe vereinheitlichen: Liste, { elements } oder Abschnitte ({ walls: [...], openings: [...] }) */
export function normalizeImport(data: any): any[] {
  if (Array.isArray(data)) return data.map((x) => ({ ...x }));
  if (Array.isArray(data?.elements)) return data.elements.map((x: any) => ({ ...x }));
  const out: any[] = [];
  for (const [k, list] of Object.entries(data ?? {})) {
    if (!Array.isArray(list) || !(k in SECTION_CAT)) continue;
    for (const it of list as any[]) {
      if (!it || typeof it !== 'object') continue;
      let cat = it.cat ?? SECTION_CAT[k];
      if (!cat && k === 'openings') cat = it.kind === 'door' ? 'door' : it.kind === 'window' ? 'window' : 'opening';
      if (!cat) continue;
      out.push({ ...it, cat });
    }
  }
  return out;
}
