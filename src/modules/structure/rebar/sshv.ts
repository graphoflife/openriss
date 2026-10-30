// Schweizer Bewehrung nach SSHV/SIA-Richtlinie Betonstahlverarbeitung (Figurenliste) und SIA 262 – rein
// rechnerisch (ohne App-/DOM-Abhängigkeiten, in Node testbar):
// Formkatalog als Daten (Nr. 1, 101–105, 181–186, 201–282, 301–384, 401–486, 501–585, 631–648, erweiterbar
// über registerSshvForm), Biegerollen d3/d1, Mindestschenkel, Nennmassen, Zuordnung einer Schenkelpolylinie
// zu einer Formnummer (Aussenmasse, Biegewinkel mit Vorzeichen wie BVBS) und Skizzen-Polylinie.
import { V2, V3, sub3, len3, dot3, cross3, norm3, cross, dot, sub, dist } from '../../../core/geom';

export type Norm = 'DIN' | 'SIA';
/** Biegerolle: d3 = Regelfall (4 Ø / 7 Ø), d1 = 15 Ø (vom Ingenieur speziell zu bezeichnen) */
export type Roll = 'd3' | 'd1';
/** Bearbeitungsgrad der Figurenliste */
export type Grade = 'Fix' | '1' | '2' | 'S';

/**
 * Figur der Figurenliste. pat = Abfolge der Biegungen (Ablenkwinkel) als Muster, leer = gerade:
 * Vorzeichen '+'/'-' relativ zur ersten vorzeichenbehafteten Biegung, '*' = beliebig;
 * Betrag '90', '135', '180' (Haken/Umlenkung), 'o' = Abbiegung < 90° (stumpf), 'a' = Abbiegung > 90° (spitz), 'x' = beliebig.
 * Figuren ohne Muster werden nicht automatisch erkannt (nur manuell wählbar).
 */
export interface SshvForm {
  nr: string; name: string; grade: Grade; bends: number;
  pat?: string;
  /** nur mit Biegerolle d1 */
  d1?: boolean;
  /** räumliche Figur */
  is3d?: boolean;
  /** Zusatzbedingung (Aussenmasse L in mm, Ablenkwinkel A in ° mit Vorzeichen) */
  cond?: (L: number[], A: number[]) => boolean;
}

const gradeOf = (n: number): Grade => {
  if (n === 1) return 'Fix';
  const g = Math.floor(n / 100), r = n % 100;
  if (g >= 6 || r >= 80) return 'S';
  if (g === 1) return '1';
  if (g === 5) return r <= 1 ? '1' : '2';
  return r >= 31 ? '2' : '1';
};
const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t;
const sum180 = (A: number[]) => near(Math.abs(A[0] + A[1]), 180, 3);

// Nr., Bezeichnung, Muster, Zusatzangaben – Reihenfolge = Priorität der automatischen Zuordnung
const CATALOG: [number, string?, string?, Partial<SshvForm>?][] = [
  [1, 'Gerader Stab (Fix-/Lagerlänge)', ''],
  // 1 Biegung
  [101, 'Stab mit Endhaken 180°', '+180', { cond: (L) => L[1] < 0.5 * L[0] }],
  [102, 'Winkel 90° (Variante)'],
  [103, 'Winkel 90°', '+90'],
  [104, 'Winkel stumpf (Abbiegung < 90°)', '+o'],
  [105, 'Winkel spitz (Abbiegung > 90°)', '+a'],
  [181, 'Winkel spitz, Biegerolle d1', '+a', { d1: true }],
  [182, 'Bogen'],
  [183, 'Stab mit Umlenkung 180°, Biegerolle d1', '+180', { d1: true }],
  [184, 'Haarnadel (Umlenkung 180°)', '+180'],
  [185, 'Wendel / Spirale'],
  [186, 'Ring'],
  // 2 Biegungen
  [201, 'Stab mit Endhaken beidseitig (gleichseitig)', '+180 +180'],
  [202, 'Winkel 90° mit Endhaken', '+90 +180'],
  [203, 'Winkel 90° mit Endhaken (gegenseitig)', '+90 -180'],
  [205, 'U-Bügel / Steckbügel gleichschenklig', '+90 +90', { cond: (L) => near(L[0], L[2], 10) }],
  [206, 'U-Bügel ungleichschenklig', '+90 +90'],
  [207, 'Endhaken und schräger Schenkel', '+180 +o'],
  [208, 'Schräger Schenkel mit Endhaken', '+o *180'],
  [209, 'Aufbiegung / Kröpfung schräg', '+o -o', { cond: (L) => L[1] < Math.max(L[0], L[2]) }],
  [210, 'Stab mit schräg abgebogenen Enden (gegensinnig)', '+o -o'],
  [211, 'Mulde (beidseitig schräg abgebogen)', '+o +o'],
  [212, 'U mit einem schrägen Schenkel', '+90 +o'],
  [213, 'Kröpfung 90° / schräg', '+90 -o'],
  [214, 'Dreieckform', '+90 +a'],
  [215, 'U mit schrägem Steg', '+x +x', { cond: (_L, A) => sum180(A) && A.every((a) => near(Math.abs(a), 90, 15)) }],
  [216, 'Endhaken und spitzer Schenkel', '*180 +a'],
  [218, 'S-Haken (Endhaken gegenseitig)', '+180 -180'],
  [219, 'Endhaken und schräger Schenkel (gegenseitig)', '+180 -o'],
  [221, 'Mulde steil'],
  [231, 'Kröpfung rechtwinklig (Z)', '+90 -90'],
  [232, 'U mit parallelen schrägen Schenkeln', '+x +x', { cond: (_L, A) => sum180(A) }],
  [233, 'Z-Form spitz'],
  [281, 'Schlaufe, Biegerolle d1'],
  [282, 'Räumliche Figur (2 Biegungen)', undefined, { is3d: true }],
  // 3 Biegungen
  [301, 'Winkel 90° mit Endhaken beidseitig', '*180 +90 *180'],
  [302, 'U-Bügel mit Endhaken', '+90 +90 *180'],
  [303, 'U-Bügel ungleichschenklig mit Endhaken'],
  [305, 'Aufbiegung mit Endhaken', '*180 +o -o'],
  [306, 'Winkel 90° mit Aufbiegung', '+90 +o -o'],
  [307, 'Mulde mit Endhaken', '*180 +o +o'],
  [308, 'Mulde mit Flansch', '+o -o -o'],
  [309], [310], [311], [312],
  [313, 'Bügel offen (3 × 90°)', '+90 +90 +90'],
  [314], [316],
  [331, 'Doppelkröpfung (Treppenform)', '+90 -90 +90'],
  [332], [333],
  [334, 'U mit Flansch', '+90 -90 -90'],
  [335], [336], [337], [338], [339], [340], [341], [342],
  [343, 'Doppelte Haarnadel'],
  [344], [345], [381], [382], [383], [384],
  // 4 Biegungen
  [401, 'U-Bügel mit Endhaken beidseitig', '*180 +90 +90 *180'],
  [402, 'Bügel offen mit Endhaken', '*180 +90 +90 +90'],
  [403, 'Bügel offen mit Endhaken am langen Schenkel'],
  [404, 'Bügel mit Schliessschenkeln (offen)', '+90 +90 +90 +90', { cond: (L) => L[0] + L[4] < L[2] - 10 }],
  [405, 'Bügel geschlossen mit Übergriff', '+90 +90 +90 +90'],
  [406], [407], [408], [409],
  ...[431, 432, 433, 434, 435, 436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 450, 451, 452, 453, 454, 455,
    457, 458, 460, 461, 462, 463, 464, 465, 467, 468, 469, 470, 471].map((n): [number] => [n]),
  [481, '', undefined, { is3d: true }], [482, '', undefined, { is3d: true }], [483, '', undefined, { is3d: true }],
  [484], [485], [486],
  // 5 Biegungen
  [501, 'Bügel geschlossen, Enden 90° abgebogen', '+90 +90 +90 +90 +90'],
  ...Array.from({ length: 34 }, (_, i): [number] => [531 + i]).filter(([n]) => n !== 553),
  [553, 'Bügel geschlossen mit Haken 135°', '*135 +90 +90 +90 *135'],
  [581], [582], [583], [584], [585],
  // 6 Biegungen (Bearbeitungsgrad S)
  ...[631, 632, 633, 634, 635, 636, 637, 638, 639, 640, 641, 642, 643, 644, 646, 647, 648].map((n): [number] => [n]),
];

/** Formkatalog (Reihenfolge = Priorität der automatischen Zuordnung) */
export const SSHV_FORMS: SshvForm[] = [];
const byNr = new Map<string, SshvForm>();
/** Form ergänzen oder ersetzen (Katalog ist erweiterbar, z. B. für Firmenfiguren) */
export function registerSshvForm(f: Partial<SshvForm> & { nr: string }): SshvForm {
  const n = parseInt(f.nr, 10);
  const bends = f.bends ?? (n === 1 ? 0 : Math.floor(n / 100));
  const full: SshvForm = { name: '', grade: isFinite(n) ? gradeOf(n) : 'S', bends, ...f } as SshvForm;
  if (!full.name) full.name = full.is3d ? `Räumliche Figur (${bends} Biegungen)` : `Figur mit ${bends} Biegungen`;
  const old = byNr.get(full.nr);
  if (old) SSHV_FORMS.splice(SSHV_FORMS.indexOf(old), 1, full); else SSHV_FORMS.push(full);
  byNr.set(full.nr, full);
  return full;
}
for (const [n, name, pat, extra] of [...CATALOG].sort((a, b) => a[0] - b[0])) registerSshvForm({ nr: String(n), name: name ?? '', pat, ...extra });
export const sshvForm = (nr: string | undefined): SshvForm | undefined => (nr ? byNr.get(nr) : undefined);
export const GRADE_LABELS: Record<Grade, string> = { Fix: 'Fix', '1': 'Bearbeitungsgrad 1', '2': 'Bearbeitungsgrad 2', S: 'Bearbeitungsgrad S' };

// ------------------------------------------------------------ Biegerollen, Mindestschenkel, Massen
/** Biegerollendurchmesser (Innenmass, mm). SIA 262 / SSHV: d3 = 4 Ø (Ø ≤ 16) bzw. 7 Ø (Ø > 16); DIN EN 1992-1-1/NA: 4 Ø (Ø < 20) bzw. 7 Ø; d1 = 15 Ø */
export function mandrelOf(norm: Norm, d: number, roll: Roll = 'd3'): number {
  if (roll === 'd1') return 15 * d;
  return norm === 'SIA' ? (d <= 16 ? 4 : 7) * d : (d < 20 ? 4 : 7) * d;
}
/**
 * Mindestschenkel (Aussenmass, cm) für Biegerolle d3 nach Figurenliste: A = Anfangs-/Endschenkel, B = Mittelschenkel.
 * Ø 6 extrapoliert; Ø ohne Tabellenwert → nächstgrösserer Ø.
 */
export const MIN_LEGS: [number, number, number][] = [
  [6, 6, 5], [8, 8, 6], [10, 10, 7], [12, 12, 10], [14, 14, 12], [16, 16, 13], [18, 22, 17], [20, 24, 18],
  [22, 32, 25], [26, 37, 29], [30, 42, 33], [34, 56, 35], [40, 64, 44],
];
/** Mindestschenkel in mm; bei d1 um die grössere Biegerolle erhöht ((15 Ø − d3)/2 je gebogenes Ende) */
export function minLegs(d: number, roll: Roll = 'd3'): { A: number; B: number } {
  const row = MIN_LEGS.find((r) => r[0] >= d) ?? MIN_LEGS[MIN_LEGS.length - 1];
  const extra = roll === 'd1' ? (15 * d - mandrelOf('SIA', d)) / 2 : 0;
  return { A: row[1] * 10 + extra, B: row[2] * 10 + 2 * extra };
}
/** Nennmasse kg/m (SN EN 10080); sonst 0,00617 · Ø² */
export const KG_NOM: Record<number, number> = { 6: 0.222, 8: 0.395, 10: 0.617, 12: 0.888, 14: 1.21, 16: 1.58, 18: 2.0, 20: 2.47, 22: 2.98, 25: 3.85, 26: 4.17, 28: 4.83, 30: 5.55, 32: 6.31, 34: 7.13, 40: 9.86 };
export const kgNom = (d: number) => KG_NOM[d] ?? 0.00617 * d * d;
/** Durchmesser Betonstahl B500B Schweiz */
export const DIAS_CH = [6, 8, 10, 12, 14, 16, 18, 20, 22, 26, 30, 34, 40];
/** Grösste Lieferlänge ohne Zuschlag (Überlänge nach Aufwand) */
export const MAX_LEN = 15000;

// ------------------------------------------------------------ Figur einer Schenkelpolylinie
export interface Figure {
  /** Formnummer ('' = nicht im Katalog → Sonderform, nach Aufwand) */
  nr: string;
  name: string;
  grade: Grade;
  /** Aussenmasse der Schenkel (mm, ungerundet) */
  legs: number[];
  /** Ablenkwinkel zwischen den Schenkeln (°, + = links/gegen den Uhrzeigersinn wie BVBS; erste Biegung positiv) */
  angles: number[];
  planar: boolean;
  /** Stabenden fallen zusammen (Bügel ohne Übergriff/Haken) */
  closed?: boolean;
  /** manuelle Formnummer passt nicht zur Geometrie */
  mismatch?: boolean;
}

/** Polylinie in ihre Ebene legen; planar = alle Punkte ≤ 1 mm von der Ebene */
export function planarize(full: V3[]): { pts: V2[]; planar: boolean } {
  if (full.length < 2) return { pts: full.map((p) => ({ x: p.x, y: p.y })), planar: true };
  const p0 = full[0];
  let k = 1; while (k < full.length - 1 && len3(sub3(full[k], p0)) < 1e-6) k++;
  const u = norm3(sub3(full[k], p0));
  let n: V3 = { x: 0, y: 0, z: 0 };
  for (let i = 1; i + 1 < full.length; i++) { const c = cross3(sub3(full[i], p0), sub3(full[i + 1], p0)); if (len3(c) > len3(n)) n = c; }
  if (len3(n) < 1e-6) return { pts: full.map((p) => ({ x: dot3(sub3(p, p0), u), y: 0 })), planar: true };
  n = norm3(n);
  const v = cross3(n, u);
  const planar = full.every((p) => Math.abs(dot3(sub3(p, p0), n)) <= 1);
  return { pts: full.map((p) => ({ x: dot3(sub3(p, p0), u), y: dot3(sub3(p, p0), v) })), planar };
}

function tokenOk(tok: string, a: number, ref: number): boolean {
  const s = tok[0], m = tok.slice(1), t = Math.abs(a);
  const magOk = m === '90' ? near(t, 90, 3) : m === '180' ? t >= 170 : m === '135' ? near(t, 135, 10)
    : m === 'o' ? t > 3 && t < 87 : m === 'a' ? t > 93 && t < 170 : t > 3;
  if (!magOk) return false;
  if (s === '*') return true;
  return Math.sign(a) * (s === '-' ? -1 : 1) === ref;
}
function patOk(f: SshvForm, L: number[], A: number[]): boolean {
  const toks = (f.pat ?? '').split(' ').filter(Boolean);
  if (toks.length !== A.length) return false;
  const k = toks.findIndex((t) => t[0] !== '*');
  const ref = k < 0 ? 1 : Math.sign(A[k]) * (toks[k][0] === '-' ? -1 : 1);
  return toks.every((t, i) => tokenOk(t, A[i], ref)) && (!f.cond || f.cond(L, A));
}
const reversed = (L: number[], A: number[]) => ({ L: L.slice().reverse(), A: A.slice().reverse().map((a) => -a) });
const signFirst = (A: number[]) => { const f = A.find((a) => Math.abs(a) > 1e-6) ?? 1; return f < 0 ? A.map((a) => -a) : A; };

/** Katalogform zu Aussenmassen/Ablenkwinkeln suchen (beide Laufrichtungen) */
export function matchForm(L: number[], A: number[], d1 = false): { form: SshvForm; L: number[]; A: number[] } | null {
  const cands = SSHV_FORMS.filter((f) => f.pat !== undefined && !f.is3d && (!f.d1 || d1));
  // mit d1 zuerst die d1-Figuren
  if (d1) cands.sort((a, b) => Number(!!b.d1) - Number(!!a.d1));
  const r = reversed(L, A);
  for (const f of cands) {
    if (patOk(f, L, A)) return { form: f, L, A: signFirst(A) };
    if (patOk(f, r.L, r.A)) return { form: f, L: r.L, A: signFirst(r.A) };
  }
  return null;
}

/**
 * SSHV-Figur einer Stabpolylinie (Eckpunkte der Stabachse inkl. Haken, mm).
 * 180°-Haken (zwei 90°-Ecken mit Steg ≈ Biegerolle + Ø) werden zu einer Biegung 180° zusammengefasst.
 * Aussenmass je Schenkel = Achsmass + Ø/2 · min(1, tan(θ/2)) je gebogenem Ende (θ = Ablenkwinkel).
 * nr = manuelle Formnummer (Schenkel/Winkel weiterhin aus der Geometrie).
 */
export function figureOf(full: V3[], d: number, mandrel: number, opt: { nr?: string; d1?: boolean } = {}): Figure {
  const { pts: p0, planar } = planarize(full);
  // doppelte und kollineare Punkte entfernen
  const pts: V2[] = [];
  for (const p of p0) if (!pts.length || dist(p, pts[pts.length - 1]) > 0.05) pts.push(p);
  for (let i = 1; i + 1 < pts.length;) {
    const a = sub(pts[i], pts[i - 1]), b = sub(pts[i + 1], pts[i]);
    if (Math.abs(cross(a, b)) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 1e-4 && dot(a, b) > 0) pts.splice(i, 1); else i++;
  }
  let L: number[] = [], A: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) L.push(dist(pts[i], pts[i + 1]));
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = sub(pts[i], pts[i - 1]), b = sub(pts[i + 1], pts[i]);
    A.push((Math.atan2(cross(a, b), dot(a, b)) * 180) / Math.PI);
  }
  if (!planar) {
    // räumlich: Winkel ohne Vorzeichen aus 3D
    A = [];
    for (let i = 1; i + 1 < full.length; i++) {
      const a = norm3(sub3(full[i], full[i - 1])), b = norm3(sub3(full[i + 1], full[i]));
      A.push((Math.acos(Math.max(-1, Math.min(1, dot3(a, b)))) * 180) / Math.PI);
    }
    L = []; for (let i = 0; i + 1 < full.length; i++) L.push(len3(sub3(full[i + 1], full[i])));
  }
  // 180°-Haken zusammenfassen
  const web = mandrel + d + 2;
  for (let i = 1; i + 1 < L.length; i++) {
    const t0 = A[i - 1], t1 = A[i];
    if (near(Math.abs(t0), 90, 3) && near(Math.abs(t1), 90, 3) && Math.sign(t0) === Math.sign(t1) && L[i] <= web) {
      A.splice(i - 1, 2, 180 * Math.sign(t0)); L.splice(i, 1); i--;
    }
  }
  // Aussenmasse
  const k = (a: number) => { const t = Math.min(Math.abs(a), 180); return t <= 90 ? Math.tan((t * Math.PI) / 360) : 1; };
  const legs = L.map((l, i) => l + (i > 0 ? (d / 2) * k(A[i - 1]) : 0) + (i < A.length ? (d / 2) * k(A[i]) : 0));
  // Laufrichtung: längerer Endschenkel zuerst; erste Biegung positiv
  let Lo = legs, Ao = A;
  if (legs.length > 1 && legs[legs.length - 1] > legs[0] + 0.5) { const r = reversed(legs, A); Lo = r.L; Ao = r.A; }
  Ao = signFirst(Ao);
  // geschlossen ohne Schloss: Enden fallen zusammen, Endschenkel nicht übereinander (Haken/Übergriff)
  const nf = full.length;
  const closed = nf > 3 && len3(sub3(full[0], full[nf - 1])) < 1 && Math.abs(dot3(norm3(sub3(full[1], full[0])), norm3(sub3(full[nf - 1], full[nf - 2])))) < 0.9;
  const manual = sshvForm(opt.nr);
  if (manual) {
    const r = reversed(Lo, Ao);
    const mismatch = manual.pat !== undefined && !patOk(manual, Lo, Ao) && !patOk(manual, r.L, r.A);
    return { nr: manual.nr, name: manual.name, grade: manual.grade, legs: Lo, angles: Ao, planar, closed, mismatch };
  }
  if (!planar) {
    const f = SSHV_FORMS.find((x) => x.is3d && x.bends === Ao.length);
    return { nr: f?.nr ?? '', name: f?.name ?? `Räumliche Sonderform (${Ao.length} Biegungen)`, grade: 'S', legs: Lo, angles: Ao.map(Math.abs), planar };
  }
  const m = matchForm(Lo, Ao, !!opt.d1);
  if (m) return { nr: m.form.nr, name: m.form.name, grade: m.form.grade, legs: m.L, angles: m.A, planar, closed };
  return { nr: '', name: `Sonderform (${Ao.length} Biegungen, nach Aufwand)`, grade: 'S', legs: Lo, angles: Ao, planar, closed };
}

/** Prüfung nach Figurenliste: Mindestschenkel (Haken ≥ 120° ausgenommen) und Überlänge. Liefert Warnungen. */
export function checkFigure(fig: Figure, d: number, roll: Roll = 'd3'): string[] {
  const out: string[] = [];
  const n = fig.legs.length;
  const total = fig.legs.reduce((s, l) => s + l, 0);
  if (total > MAX_LEN) out.push(`Überlänge ${(total / 1000).toFixed(2)} m > 15 m (nach Aufwand)`);
  if (fig.closed) out.push('Bügel ohne Schloss (Übergriff oder Haken ergänzen)');
  if (fig.mismatch) out.push(`Geometrie passt nicht zu Form ${fig.nr}`);
  if (n < 2) return out;
  const { A, B } = minLegs(d, roll);
  fig.legs.forEach((l, i) => {
    const end = i === 0 || i === n - 1;
    const bend = Math.abs(fig.angles[i === 0 ? 0 : i - 1] ?? 0);
    if (end && bend >= 120) return; // Haken
    const min = end ? A : B;
    if (l < min - 0.5) out.push(`Schenkel ${i + 1}: ${Math.round(l / 10)} cm < min. ${Math.round(min / 10)} cm (${end ? 'Anfangs-/Endschenkel' : 'Mittelschenkel'})`);
  });
  return out;
}

/** Skizzen-Polylinie aus Aussenmassen und Ablenkwinkeln (Start 0,0 Richtung +x); 180° mit sichtbarem Steg */
export function figurePolyline(legs: number[], angles: number[], hookWeb = 0): V2[] {
  const out: V2[] = [{ x: 0, y: 0 }];
  let h = 0;
  const web = hookWeb || Math.max(...legs, 1) * 0.06;
  legs.forEach((l, i) => {
    const p = out[out.length - 1];
    out.push({ x: p.x + l * Math.cos(h), y: p.y + l * Math.sin(h) });
    const a = angles[i];
    if (a === undefined) return;
    if (Math.abs(a) >= 170) {
      const s = Math.sign(a) || 1;
      h += (s * Math.PI) / 2;
      const q = out[out.length - 1];
      out.push({ x: q.x + web * Math.cos(h), y: q.y + web * Math.sin(h) });
      h += (s * Math.PI) / 2;
    } else h += (a * Math.PI) / 180;
  });
  return out;
}

/** Text der Form: «205: 50/18/50» (Masse in cm) */
export const figureText = (f: Figure) => `${f.nr || 'Sonderform'}: ${f.legs.map((l) => Math.round(l / 10)).join('/')}`;
