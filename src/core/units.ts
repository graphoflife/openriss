// Einheiten: intern immer Millimeter. Anzeige je nach Projekteinstellung (mm, cm, m).
// Deutsches Zahlenformat mit Dezimalkomma.

export type LengthUnit = 'mm' | 'cm' | 'm';

export const unitSettings = {
  length: 'mm' as LengthUnit,
  lengthDecimals: 0,
  areaDecimals: 2,
  angleDecimals: 2,
  /** Hochgestellte 5 (Rohbaumaß-Schreibweise 3,65⁵) – nur bei m/cm relevant */
  superscriptFive: false,
};

const factor: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000 };

export function fmtNum(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return s.replace('.', ',').replace(/^-0(,0+)?$/, '0$1');
}

/** Länge formatieren (ohne Einheitenzeichen, wie in Revit-Bemaßungen). */
export function fmtLen(mm: number, unit: LengthUnit = unitSettings.length, decimals = unitSettings.lengthDecimals): string {
  const v = mm / factor[unit];
  if (unitSettings.superscriptFive && unit !== 'mm') {
    const d = unit === 'm' ? 2 : 0;
    const base = Math.floor((v + 1e-9) * Math.pow(10, d)) / Math.pow(10, d);
    const rest = Math.round((v - base) * Math.pow(10, d + 1));
    return fmtNum(base, d) + (rest === 5 ? '⁵' : '');
  }
  return fmtNum(v, decimals);
}
export function fmtLenUnit(mm: number): string { return fmtLen(mm) + ' ' + unitSettings.length; }
export function fmtArea(mm2: number): string { return fmtNum(mm2 / 1e6, unitSettings.areaDecimals) + ' m²'; }
export function fmtVolume(mm3: number): string { return fmtNum(mm3 / 1e9, 3) + ' m³'; }
export function fmtAngle(radians: number): string { return fmtNum((radians * 180) / Math.PI, unitSettings.angleDecimals) + '°'; }
export function fmtElev(mm: number): string {
  const v = mm / 1000;
  const s = fmtNum(Math.abs(v), 2);
  return (v > 0.0005 ? '+' : v < -0.0005 ? '-' : '±') + s;
}

/**
 * Längeneingabe parsen. Erlaubt: "365", "3,65 m", "36,5cm", "2500+365", "=3000/2".
 * Ohne Einheit gilt die Projekteinheit.
 */
export function parseLen(input: string, unit: LengthUnit = unitSettings.length): number | null {
  let s = input.trim().toLowerCase().replace(/^=/, '').replace(/,/g, '.').replace(/\s+/g, '');
  if (!s) return null;
  let u = unit;
  const m = s.match(/(mm|cm|m)$/);
  if (m) { u = m[1] as LengthUnit; s = s.slice(0, -m[1].length); }
  const v = evalExpr(s);
  if (v === null || !isFinite(v)) return null;
  return v * factor[u];
}
export function parseNum(input: string): number | null {
  const v = evalExpr(input.trim().replace(/^=/, '').replace(/,/g, '.'));
  return v === null || !isFinite(v) ? null : v;
}
export function parseAngle(input: string): number | null {
  const v = parseNum(input.replace('°', ''));
  return v === null ? null : (v * Math.PI) / 180;
}

/** Kleiner, sicherer Ausdrucksparser für + - * / und Klammern. */
export function evalExpr(s: string): number | null {
  let i = 0;
  const peek = () => s[i];
  const num = (): number | null => {
    if (peek() === '(') { i++; const v = expr(); if (peek() === ')') i++; return v; }
    if (peek() === '-') { i++; const v = num(); return v === null ? null : -v; }
    const m = s.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/);
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number | null => {
    let v = num();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = s[i++]; const r = num(); if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = s[i++]; const r = term(); if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  return i === s.length ? v : null;
}
