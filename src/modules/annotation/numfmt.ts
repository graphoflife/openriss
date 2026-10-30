// Zahlenformate der Beschriftungen (ohne DOM): Maßtexte je Bemaßungstyp (mm / cm / m / Schweiz-Auto,
// Dezimaltrennzeichen, hochgestellte mm-Stelle) und Höhenkoten (relativ ±0.00 oder m ü. M.).
import { unitSettings, LengthUnit } from '../../core/units';

/** Einheit eines Bemaßungstyps: '' = Projekteinstellung, 'ch' = < 1 m in cm, sonst m mit 2 Stellen */
export type DimUnit = '' | 'mm' | 'cm' | 'm' | 'ch';
/** Hochgestellte mm-Stelle: keine / nur 5 (auf 5 mm gerundet) / jede Ziffer */
export type SupMode = 'none' | '5' | 'all';
export type DecSep = ',' | '.';

const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const FACTOR: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000 };

/** Zahl mit fester Stellenzahl und Trennzeichen (ohne "-0") */
export function fmtDec(v: number, dec: number, sep: DecSep = ','): string {
  const s = v.toFixed(Math.max(0, dec)).replace(/^-(0(\.0+)?)$/, '$1');
  return sep === ',' ? s.replace('.', ',') : s;
}

/**
 * Länge formatieren. unit 'ch': Werte < 1 m in cm, sonst m mit zwei Dezimalen; die mm-Stelle hochgestellt
 * («1.82⁵», «12⁵»). Bei mm gibt es keine Hochstellung.
 */
export function fmtDimLen(mm: number, unit: DimUnit, dec: number, sep: DecSep = ',', sup: SupMode = 'none'): string {
  const sign = mm < 0 ? '-' : ''; let a = Math.abs(mm);
  let u: LengthUnit; let d = dec;
  if (unit === 'ch') {
    // erst auf die kleinste Stelle runden, dann Einheit wählen (997,5 mm → «1.00», nicht «100»)
    a = sup === 'none' ? Math.round(a / 10) * 10 : sup === '5' ? Math.round(a / 5) * 5 : Math.round(a);
    u = a < 1000 - 1e-6 ? 'cm' : 'm'; d = u === 'cm' ? 0 : 2;
  } else {
    u = unit || unitSettings.length;
    if (!unit) d = unitSettings.lengthDecimals;
  }
  const f = FACTOR[u];
  if (sup === 'none' || u === 'mm') { const s = fmtDec(a / f, d, sep); return (s.replace(/[0.,]/g, '') ? sign : '') + s; }
  // Schritt der letzten regulären Stelle und der hochgestellten Stelle (mm)
  const step = f * Math.pow(10, -d); const sub = step / 10;
  const q = sup === '5' ? Math.round(a / (sub * 5)) * 5 : Math.round(a / sub);
  const base = Math.floor((q + 1e-9) / 10); const digit = Math.round(q - base * 10);
  const s = fmtDec((base * step) / f, d, sep) + (digit ? SUP[digit] : '');
  return (q ? sign : '') + s;
}

/** Höhenangabe einer Kote */
export type ElevMode = 'rel' | 'abs' | 'both';
/** Höhe in m mit Vorzeichen (±0.00 / +2.75 / -0.34) */
export function fmtElevSigned(mm: number, dec: number, sep: DecSep = ','): string {
  const v = mm / 1000; const lim = 0.5 * Math.pow(10, -dec);
  return (v >= lim ? '+' : v <= -lim ? '-' : '±') + fmtDec(Math.abs(v), dec, sep);
}
/** Absolute Höhe (m ü. M.) aus relativer Höhe z (mm) und Bezug ±0.00 (m) */
export function fmtElevAbs(mm: number, elev00: number, dec: number, sep: DecSep = ','): string {
  return fmtDec(elev00 + mm / 1000, dec, sep);
}
/** Kote je Modus: relativ «+2.75», absolut «455.05», beides «+2.75 (455.05)» */
export function fmtElevMode(mm: number, mode: ElevMode, elev00: number | undefined, dec: number, sep: DecSep = ','): string {
  const rel = fmtElevSigned(mm, dec, sep);
  if (mode === 'rel') return rel;
  const abs = fmtElevAbs(mm, elev00 ?? 0, dec, sep);
  return mode === 'abs' ? abs : `${rel} (${abs})`;
}
