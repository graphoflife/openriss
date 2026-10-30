// ABS-Datei für Biegemaschinen nach BVBS-Richtlinie «Datenaustausch von Bewehrungsdaten» 3.1, Gruppe BF2D
// (rein rechnerisch, in Node testbar). Eine Zeile je Position:
//   BF2D@Hj<Projekt>@r<Plan>@i<Index>@p<Pos>@l<Länge mm>@n<Anzahl>@e<kg/Stk>@d<Ø>@g<Stahl>@s<Biegerolle mm>@v@
//   G l<Schenkel mm>@w<Winkel °>@ … @w0@   [M a<System>@b<Typ>@c1@n<System>@o<Typ>@p1@]   C<Prüfziffer>@ CRLF
// Prüfziffer: IP = 96 − (Σ ASCII aller Zeichen bis und mit «C») mod 32.

export interface BvbsCouplerEnd { sys: string; type: string }
export interface BvbsRecord {
  project: string; plan: string; index: string;
  pos: number;
  /** Gesamtlänge (abgewickelt) mm */
  len: number;
  n: number;
  /** Gewicht je Stück kg */
  kgEach: number;
  dia: number;
  steel?: string;
  /** Biegerollendurchmesser mm */
  mandrel: number;
  /** Schenkel (Aussenmasse) mm und Biegewinkel ° (+ = links); Winkel nach dem letzten Schenkel = 0 */
  legs: number[]; angles: number[];
  coupler?: { start?: BvbsCouplerEnd; end?: BvbsCouplerEnd };
}

/** Prüfziffer nach BVBS: 96 − (Σ Zeichencodes) mod 32 */
export const bvbsChecksum = (s: string): number => {
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return 96 - (sum % 32);
};
/** Feldinhalt: nur ASCII (Umlaute umschreiben, sonst '?'), '@' → '-' */
export function bvbsField(v: string | number): string {
  return String(v).replace(/@/g, '-').replace(/[äöüÄÖÜß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' } as Record<string, string>)[c])
    .replace(/Ø/g, 'D').replace(/[^\x20-\x7e]/g, '?');
}
/** Zahl wie Python «{:g}»: ohne überflüssige Nachkommastellen (Winkel auf 0,1° gerundet) */
const g = (v: number) => { const r = Math.round(v * 10) / 10; return String(Object.is(r, -0) ? 0 : r); };

/** Eine BF2D-Zeile (ohne Zeilenende) */
export function bvbsLine(r: BvbsRecord): string {
  let s = `BF2D@Hj${bvbsField(r.project)}@r${bvbsField(r.plan)}@i${bvbsField(r.index)}@p${r.pos}@l${Math.round(r.len)}@n${r.n}`
    + `@e${r.kgEach.toFixed(3)}@d${r.dia}@g${bvbsField(r.steel ?? 'B500B')}@s${Math.round(r.mandrel)}@v@`;
  s += 'G';
  r.legs.forEach((l, i) => { s += `l${Math.round(l)}@w${g(r.angles[i] ?? 0)}@`; });
  const c = r.coupler;
  if (c && (c.start || c.end)) {
    s += 'M';
    s += c.start ? `a${bvbsField(c.start.sys)}@b${bvbsField(c.start.type)}@c1@` : 'a@b@c@';
    s += c.end ? `n${bvbsField(c.end.sys)}@o${bvbsField(c.end.type)}@p1@` : 'n@o@p@';
  }
  s += 'C';
  return s + `${bvbsChecksum(s)}@`;
}
/** ABS-Datei (Zeilen mit CRLF) */
export const bvbsFile = (recs: BvbsRecord[]) => recs.map(bvbsLine).join('\r\n') + (recs.length ? '\r\n' : '');

/** Selbsttest mit den Beispielen der BVBS-Richtlinie 3.1 (BF2D-Beispiel 1: Prüfziffer 72; «abcde@C» → 78) */
export function bvbsSelfTest(): boolean {
  return bvbsChecksum('BF2D@HjTestPDF@r417@ia@p1@l1000@n10@e0.888@d12@gB500A@s48@v@Gl400@w90@l600@w0@C') === 72 && bvbsChecksum('abcde@C') === 78;
}
