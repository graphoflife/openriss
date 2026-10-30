// Erzeugt liberationSans.ts (TTF-Dateien zlib-komprimiert als Base64) für den PDF-Export.
// Aufruf im Repo: node src/modules/output/fonts/genFontData.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { zlibSync } from 'fflate';

const dir = new URL('.', import.meta.url);
const pack = (f) => Buffer.from(zlibSync(new Uint8Array(readFileSync(new URL(f, dir))), { level: 9 })).toString('base64');
const out = `// GENERIERT von genFontData.mjs – nicht von Hand ändern.
// Liberation Sans 2.1.5 (Regular, Bold), SIL Open Font License 1.1 – siehe OFL.txt.
// Unveränderte TTF-Dateien, zlib-komprimiert, Base64. Wird vom PDF-Export dynamisch geladen.
export const REGULAR = '${pack('LiberationSans-Regular.ttf')}';
export const BOLD = '${pack('LiberationSans-Bold.ttf')}';
`;
writeFileSync(new URL('liberationSans.ts', dir), out);
console.log('liberationSans.ts', out.length, 'Zeichen');
