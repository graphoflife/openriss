#!/usr/bin/env node
// OpenRiss-Kommandozeile: Skripte gegen die Skript-API ausführen und Projekte exportieren.
//   openriss build <skript.ts|js> [--out projekt.oriss] [--pdf [plansatz.pdf]] [--dxf [ordner]] [--svg [ordner]]
//                  [--ifc [modell.ifc]] [--ifc-disc struct,arch,mep,site] [--ifc-cats …] [--ifc-exclude …]
//                  [--abs [ordner]] [--font "Familie=pfad.ttf[,fett.ttf]"] [--fit-elevations] [-- skript-argumente …]
//   openriss export <projekt.oriss> [--pdf …] [--dxf …] [--svg …] [--ifc …]
//   openriss check <elemente.json|projekt.oriss>     prüft Elemente (Feld- und Verweisfehler)
// Im Skript: `import { createProject, addWall, … } from 'openriss'` (oder direkte Pfade nach src/…).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'src', 'api.ts');

function usage(code = 0) {
  console.log(`OpenRiss CLI
  openriss build <skript.ts> [--out projekt.oriss] [--pdf [datei.pdf]] [--dxf [ordner]] [--svg [ordner]] [--ifc [datei.ifc]] [--abs [ordner]] [--fit-elevations] [-- argumente]
      IFC-Teilmodell: --ifc-disc struct|arch|mep|site[,…]  --ifc-cats wall,floor  --ifc-exclude room,component
      PDF-Schrift:    --font "Arial Narrow=ArialNarrow.ttf[,ArialNarrowBold.ttf]"
  openriss export <projekt.oriss> [--pdf …] [--dxf …] [--svg …] [--ifc …]
  openriss check <elemente.json|projekt.oriss>`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') usage(0);
const input = argv.shift();
if (!input) usage(1);
const dd = argv.indexOf('--');
const scriptArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const flags = dd >= 0 ? argv.slice(0, dd) : argv;
const base = basename(input).replace(/\.(ts|js|mjs|oriss|json)$/i, '');
const opts = { cwd: process.cwd() };
for (let i = 0; i < flags.length; i++) {
  const f = flags[i]; const next = flags[i + 1] && !flags[i + 1].startsWith('--') ? flags[++i] : null;
  if (f === '--out') opts.out = resolve(next ?? `${base}.oriss`);
  else if (f === '--pdf') opts.pdf = resolve(next ?? `${base}.pdf`);
  else if (f === '--dxf') opts.dxf = resolve(next ?? `${base}_dxf`);
  else if (f === '--svg') opts.svg = resolve(next ?? `${base}_svg`);
  else if (f === '--ifc') opts.ifc = resolve(next ?? `${base}.ifc`);
  else if (f === '--abs') opts.abs = resolve(next ?? `${base}_abs`);
  else if (f === '--fit-elevations') { opts.fitElevations = true; if (next) i--; }
  else if (f === '--ifc-disc') opts.ifcDisc = (next ?? '').split(',').filter(Boolean);
  else if (f === '--ifc-cats') opts.ifcCats = (next ?? '').split(',').filter(Boolean);
  else if (f === '--ifc-exclude') opts.ifcExclude = (next ?? '').split(',').filter(Boolean);
  else if (f === '--font') { const m = (next ?? '').match(/^([^=]+)=(.+)$/); if (!m) { console.error('--font "Familie=pfad.ttf[,fett.ttf]"'); usage(1); } (opts.fonts ??= {})[m[1]] = m[2].split(',').map((p) => resolve(p)).join(','); }
  else { console.error(`Unbekannte Option: ${f}`); usage(1); }
}

const src = resolve(input);
if (!existsSync(src)) { console.error(`Datei nicht gefunden: ${src}`); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), 'openriss-'));
const entry = join(work, 'entry.ts');
const lines = [`import * as api from ${JSON.stringify(API)};`];
if (cmd === 'build') lines.push(`import ${JSON.stringify(src)};`);
else if (cmd === 'export') lines.push(`import { readFileSync } from 'node:fs';`, `api.loadProject(readFileSync(${JSON.stringify(src)}, 'utf8'));`);
else if (cmd === 'check') lines.push(
  `import { readFileSync } from 'node:fs';`,
  `const data = JSON.parse(readFileSync(${JSON.stringify(src)}, 'utf8'));`,
  `api.createProject();`,
  `const r = api.importJson(data, { replace: !!data.format, dryRun: true });`,
  `if (r.errors.length) { for (const e of r.errors) console.log(\`\${e.cat} \${e.id}: \${e.field} – \${e.msg}\`); console.log(r.errors.length + ' Fehler'); process.exitCode = 2; } else console.log('Keine Fehler.');`,
);
else usage(1);
lines.push(`await api.finishCli(JSON.parse(process.env.OPENRISS_CLI ?? '{}'));`);
writeFileSync(entry, lines.join('\n'));

let esbuild;
try { esbuild = await import('esbuild'); } catch { console.error('esbuild fehlt – bitte im OpenRiss-Ordner "npm install" ausführen.'); process.exit(1); }
const out = join(work, 'bundle.mjs');
try {
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node18', outfile: out,
    loader: { '.css': 'empty' }, alias: { openriss: API }, sourcemap: 'inline', logLevel: 'warning',
    nodePaths: [join(ROOT, 'node_modules')],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
} catch (e) { rmSync(work, { recursive: true, force: true }); process.exit(1); }
const r = spawnSync(process.execPath, ['--enable-source-maps', out, ...scriptArgs], {
  stdio: 'inherit', env: { ...process.env, OPENRISS_CLI: JSON.stringify(opts) },
});
rmSync(work, { recursive: true, force: true });
process.exit(r.status ?? 1);
