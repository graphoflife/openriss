// Bewehrung – Projekteinstellungen und Nummernkreise: Bewehrungsnorm (DIN / SIA), Biegerolle je Satz,
// Bewehrungsplan («Nummernkreis», z. B. T-205) je Bewehrungssatz, Flächen- und Mattenbewehrung.
// DOM-frei; ohne Abhängigkeit von rebar.ts (wird von dort importiert).
import type { Doc, El } from '../../../core/doc';
import { projectInfo } from '../../../core/view';
import { Norm, Roll, mandrelOf, DIAS_CH } from './sshv';
import { DIAS } from './math';

/** Projektfelder (Projektinformationen, id 'project') */
export interface RebarProjectFields {
  /** Bewehrungsnorm; fehlt = 'SIA' bei Landesvorlage CH, sonst 'DIN' (bestehende Projekte) */
  rebarNorm?: Norm;
  /** Bewehrungsplan für neue Bewehrung (Nummernkreis) */
  rebarPlan?: string;
}
const pf = (doc: Doc): RebarProjectFields & { locale?: string } => (projectInfo(doc) ?? {}) as any;

export function rebarNorm(doc: Doc): Norm {
  const p = pf(doc);
  return p.rebarNorm === 'SIA' || p.rebarNorm === 'DIN' ? p.rebarNorm : p.locale === 'CH' ? 'SIA' : 'DIN';
}
export const isSia = (doc: Doc) => rebarNorm(doc) === 'SIA';
export const NORM_LABELS: [Norm, string][] = [['DIN', 'DIN EN 1992-1-1/NA (DE)'], ['SIA', 'SIA 262 / SSHV-Richtlinie (CH)']];

/** Biegerollendurchmesser eines Bewehrungssatzes (mm) */
export const rebarMandrel = (doc: Doc, el: { dia: number; bendRoll?: Roll }) => mandrelOf(rebarNorm(doc), el.dia, el.bendRoll ?? 'd3');
/** Durchmesserreihe je Norm; im Projekt verwendete Durchmesser bleiben wählbar */
export function diasFor(doc: Doc, cur?: number): number[] {
  const s = new Set(isSia(doc) ? DIAS_CH : DIAS);
  for (const r of doc.all('rebar')) if (r.dia > 0) s.add(r.dia);
  for (const a of doc.all('areaRebar')) for (const l of a.layers ?? []) if (l.dia > 0) s.add(l.dia);
  if (cur && cur > 0) s.add(cur);
  return [...s].sort((a, b) => a - b);
}
export const diaOptions = (doc: Doc, cur?: number): [string, string][] => diasFor(doc, cur).map((d) => [String(d), 'Ø ' + d + ' mm']);

// ------------------------------------------------------------ Bewehrungsplan (Nummernkreis)
/** sieht aus wie eine Plannummer (z. B. «T-205», «B12», «T-205a») */
export const PLAN_RE = /^[A-Z]{1,3}[- ]?\d{1,4}[a-z]?(\.\d{1,2})?$/;
/**
 * Bewehrungsplan eines Elements. Migration: ist `plan` leer und sieht `comments` wie eine Plannummer aus
 * (früherer Behelf), gilt dieser Wert.
 */
export function planOf(el: El | undefined | null): string {
  if (!el) return '';
  if (typeof el.plan === 'string' && el.plan.trim()) return el.plan.trim();
  const c = typeof el.comments === 'string' ? el.comments.trim() : '';
  return PLAN_RE.test(c) ? c : '';
}
export const REBAR_EL_CATS = ['rebar', 'areaRebar', 'fabricArea'];
/** Alle verwendeten Bewehrungspläne, natürlich sortiert ('' = ohne Plan, falls vorhanden) */
export function rebarPlans(doc: Doc): string[] {
  const s = new Set<string>();
  for (const c of REBAR_EL_CATS) for (const e of doc.all(c)) s.add(planOf(e));
  const cur = pf(doc).rebarPlan; if (cur) s.add(cur);
  return [...s].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'de', { numeric: true })));
}
/** Bewehrungsplan für neu erzeugte Bewehrung */
export const currentPlan = (doc: Doc): string => pf(doc).rebarPlan ?? '';
/** Gehört das Element zum Plan? plan undefined = alle */
export const inPlan = (el: El, plan: string | undefined) => plan === undefined || planOf(el) === plan;

/** Migration: `plan` aus `comments` übernehmen, wo leer (in einer Transaktion aufrufen). Liefert Anzahl. */
export function migrateRebarPlans(doc: Doc): number {
  let n = 0;
  for (const c of REBAR_EL_CATS) for (const e of doc.all(c)) {
    if (e.plan) continue;
    const p = planOf(e);
    if (p) { doc.update(e.id, { plan: p }); n++; }
  }
  return n;
}
