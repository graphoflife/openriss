// Baut die Display-Liste einer Ansicht: Grundriss (symbolisch + Schnitt), Schnitt/Ansicht
// (Schnitt-Engine), Zeichnungsansicht (nur Beschriftung). Pläne & Listen registrieren eigene Builder.
import type { Doc, El, Id } from '../core/doc';
import { catDef, allCats, dlBuilder, PlanCtx, SectionCtx } from '../core/registry';
import { View, Level, makeProjector, isPlanLike, isSectionLike, DEFAULT_RANGE, cropBox, levelAbove } from '../core/view';
import { DisplayList } from '../render/displayList';
import { drawSolids, Projector, catPen } from './sectionEngine';
import { boxCorners } from '../core/geom';

// ------------------------------------------------------------ Temporär ausblenden/isolieren (HH, HI …)
export interface TempVis { hidden: Set<Id>; isolate: Set<Id> | null; hiddenCats: Set<string>; isolateCats: Set<string> | null; reveal?: boolean }
const tempVis = new Map<Id, TempVis>();
export function getTempVis(viewId: Id): TempVis {
  let t = tempVis.get(viewId);
  if (!t) { t = { hidden: new Set(), isolate: null, hiddenCats: new Set(), isolateCats: null }; tempVis.set(viewId, t); }
  return t;
}
export function tempActive(viewId: Id): boolean {
  const t = tempVis.get(viewId);
  return !!t && (t.hidden.size > 0 || !!t.isolate || t.hiddenCats.size > 0 || !!t.isolateCats);
}
export function resetTempVis(viewId: Id): void { tempVis.delete(viewId); }

export function isVisibleInView(doc: Doc, view: View, el: El, ignoreTemp = false): boolean {
  if (view.hiddenCats?.includes(el.cat)) return false;
  if (view.hiddenEls?.includes(el.id)) return false;
  if (!ignoreTemp) {
    const t = tempVis.get(view.id);
    if (t && !t.reveal) {
      if (t.hidden.has(el.id) || t.hiddenCats.has(el.cat)) return false;
      if (t.isolate && !t.isolate.has(el.id)) return false;
      if (t.isolateCats && !t.isolateCats.has(el.cat)) return false;
    }
  }
  const def = catDef(el.cat);
  if (def?.visibleIn && !def.visibleIn(el, doc, view)) return false;
  return true;
}

/** Elemente, die in Ansichten gezeichnet werden (Modell + Bezug + Beschriftung dieser Ansicht) */
export function viewElements(doc: Doc, view: View): { model: El[]; annos: El[] } {
  const model: El[] = []; const annos: El[] = [];
  for (const def of allCats()) {
    if (def.cat === 'type' || def.cat === 'material' || def.cat === 'project') continue;
    if (def.cat === 'view') {
      // Schnitt-/Ansichtssymbole erscheinen in Grundrissen
      if (isPlanLike(view)) for (const v of doc.all<View>('view')) if ((v.kind === 'section' || v.kind === 'elevation') && isVisibleInView(doc, view, v)) model.push(v);
      continue;
    }
    for (const el of doc.all(def.cat)) {
      if (def.annotation) { if (el.viewId === view.id && isVisibleInView(doc, view, el)) annos.push(el); continue; }
      if (el.viewId && el.viewId !== view.id) continue; // ansichtsspezifisch (z.B. Detailbauteil)
      if (el.viewId === view.id) { if (isVisibleInView(doc, view, el)) annos.push(el); continue; }
      if (isVisibleInView(doc, view, el)) model.push(el);
    }
  }
  return { model, annos };
}

export function planRange(doc: Doc, view: View) {
  const lvl = doc.get<Level>(view.levelId);
  const elev = lvl?.elev ?? 0;
  const r = view.range ?? DEFAULT_RANGE;
  const above = levelAbove(doc, view.levelId);
  if (view.kind === 'ceiling') {
    const top = above ? above.elev - elev : 3000;
    return { level: lvl, cutZ: elev + (r.cut ?? 2300), bottomZ: elev + (r.cut ?? 2300), topZ: elev + Math.max(r.top ?? top, top), depthZ: elev + Math.max(r.top ?? top, top) };
  }
  return { level: lvl, cutZ: elev + r.cut, bottomZ: elev + r.bottom, topZ: elev + r.top, depthZ: elev + r.depth };
}

export interface BuildOpts { halftone?: boolean; noAnnotations?: boolean; noCrop?: boolean }

export function buildViewDL(doc: Doc, view: View, o: BuildOpts = {}): DisplayList {
  const custom = dlBuilder(view.kind);
  if (custom) return custom(doc, view);
  const dl = new DisplayList(view.scale || 100);
  dl.halftone = !!o.halftone;
  if (isPlanLike(view)) buildPlan(doc, view, dl, o);
  else if (isSectionLike(view)) buildSection(doc, view, dl, o);
  else {
    // Zeichnungsansicht / Legende: nur ansichtsspezifische Elemente
    const { annos } = viewElements(doc, view);
    drawAnnos(doc, view, dl, annos);
  }
  return dl;
}

function sortByOrder(els: El[]): El[] {
  return els.slice().sort((a, b) => (catDef(a.cat)?.planOrder ?? 50) - (catDef(b.cat)?.planOrder ?? 50));
}

function drawAnnos(doc: Doc, view: View, dl: DisplayList, annos: El[]): void {
  for (const el of sortByOrder(annos)) {
    const def = catDef(el.cat);
    dl.begin(el.id);
    try {
      if (def?.drawAnnotation) def.drawAnnotation(dl, el, doc, view);
    } catch (e) { console.warn('Zeichenfehler', el.cat, e); }
  }
  dl.begin(null);
}

function buildPlan(doc: Doc, view: View, dl: DisplayList, o: BuildOpts): void {
  const r = planRange(doc, view);
  const crop = o.noCrop ? null : cropBox(view);
  // Unterlage
  if (view.underlayLevelId && !o.halftone) {
    const under = doc.all<View>('view').find((v) => v.kind === 'plan' && v.levelId === view.underlayLevelId);
    if (under) {
      const udl = buildViewDL(doc, { ...under, underlayLevelId: null, hiddenCats: view.hiddenCats }, { halftone: true, noAnnotations: true, noCrop: true });
      for (const it of udl.items) if (it.k !== 'clip') dl.items.push({ ...it, o: null, ht: true, ns: false });
    }
  }
  if (crop) dl.clip([boxCorners(crop)]);
  const { model, annos } = viewElements(doc, view);
  const ctx: PlanCtx = { doc, view, dl, level: r.level, cutZ: r.cutZ, bottomZ: r.bottomZ, topZ: r.topZ, depthZ: r.depthZ, detail: view.detail, ceiling: view.kind === 'ceiling' };
  const sorted = sortByOrder(model);
  const generic: El[] = [];
  const batches = new Map<string, El[]>();
  const done = new Set<string>();
  const drawSym = (el: El) => {
    const def = catDef(el.cat)!;
    if (def.drawPlanBatch) {
      if (done.has(def.cat)) return;
      done.add(def.cat);
      try { def.drawPlanBatch(ctx, batches.get(def.cat) ?? []); } catch (e) { console.warn('Grundriss-Zeichenfehler', el.cat, e); }
      return;
    }
    dl.begin(el.id);
    try { def.drawPlan!(ctx, el); } catch (e) { console.warn('Grundriss-Zeichenfehler', el.cat, e); }
  };
  const symbolic = (el: El) => { const d = catDef(el.cat); return !!(d?.drawPlan || d?.drawPlanBatch); };
  for (const el of sorted) {
    const def = catDef(el.cat);
    if (!def) continue;
    if (def.drawPlanBatch) { const l = batches.get(def.cat) ?? []; l.push(el); batches.set(def.cat, l); }
    if (!symbolic(el) && def.solids) generic.push(el);
  }
  // 1) Symbolische Elemente mit planOrder < 0 (z.B. Geschossdecken unten)
  for (const el of sorted) if (symbolic(el) && (catDef(el.cat)!.planOrder ?? 50) < 0) drawSym(el);
  // 2) Allgemeine Körper: Schnitt bei cutZ, Projektion nach unten bis Ansichtstiefe
  if (generic.length) {
    const ceiling = view.kind === 'ceiling';
    const pr: Projector = {
      origin: { x: 0, y: 0, z: r.cutZ },
      dir: { x: 0, y: 0, z: ceiling ? 1 : -1 },
      toView: (p) => ({ x: p.x, y: p.y }),
      depth: (p) => (ceiling ? p.z - r.cutZ : r.cutZ - p.z),
    };
    drawSolids(doc, generic, pr, dl, {
      cut: true, far: ceiling ? r.topZ - r.cutZ : r.cutZ - r.depthZ, detail: view.detail, crop,
    });
  }
  // 3) übrige symbolische Elemente
  for (const el of sorted) if (symbolic(el) && (catDef(el.cat)!.planOrder ?? 50) >= 0) drawSym(el);
  dl.begin(null);
  if (crop) dl.clip(null);
  if (!o.noAnnotations) drawAnnos(doc, view, dl, annos);
  if (crop && view.crop?.show) {
    dl.begin(view.id);
    dl.poly(boxCorners(crop), { w: 1, color: '#000000' }, true, { ns: true, sub: 'crop' });
    dl.begin(null);
  }
}

export function sectionCtx(doc: Doc, view: View, dl: DisplayList): SectionCtx {
  const p = makeProjector(view);
  return { doc, view, dl, detail: view.detail, ...p, far: view.far ?? 1e7 };
}

function buildSection(doc: Doc, view: View, dl: DisplayList, o: BuildOpts): void {
  const ctx = sectionCtx(doc, view, dl);
  const crop = o.noCrop ? null : cropBox(view);
  if (crop) dl.clip([boxCorners(crop)]);
  const { model, annos } = viewElements(doc, view);
  const solidEls: El[] = []; const custom: El[] = [];
  for (const el of model) {
    const def = catDef(el.cat);
    if (!def) continue;
    if (def.solids && !def.sectionOnlyCustom) solidEls.push(el);
    if (def.drawSection) custom.push(el);
  }
  const pr: Projector = { origin: ctx.origin, dir: ctx.dir, toView: ctx.toView, depth: ctx.depth };
  drawSolids(doc, solidEls, pr, dl, { cut: true, far: ctx.far, detail: view.detail, crop, style: view.style === 'shaded' ? 'shaded' : 'hidden' });
  ctx.modelBox = crop ?? dl.bbox();
  if (crop) dl.clip(null);
  for (const el of sortByOrder(custom)) {
    dl.begin(el.id);
    try { catDef(el.cat)!.drawSection!(ctx, el); } catch (e) { console.warn('Schnitt-Zeichenfehler', el.cat, e); }
  }
  dl.begin(null);
  if (!o.noAnnotations) drawAnnos(doc, view, dl, annos);
  if (crop && view.crop?.show) {
    dl.begin(view.id);
    dl.poly(boxCorners(crop), { w: 1 }, true, { ns: true, sub: 'crop' });
    dl.begin(null);
  }
}

export { catPen };
