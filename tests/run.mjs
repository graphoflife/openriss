#!/usr/bin/env node
// Testläufer: bündelt tests/*.test.ts mit esbuild für Node und führt sie aus.
//   node tests/run.mjs [filter]
import { build } from 'esbuild';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f.includes(filter)).sort();
const out = mkdtempSync(join(tmpdir(), 'openriss-test-'));
let failed = 0;
try {
  for (const f of files) {
    const outfile = join(out, f.replace(/\.ts$/, '.mjs'));
    await build({ entryPoints: [join(dir, f)], bundle: true, platform: 'node', format: 'esm', loader: { '.css': 'empty' }, outfile, logLevel: 'warning' });
    try { await import(pathToFileURL(outfile).href); console.log(`ok   ${f}`); } catch (e) { failed++; console.error(`FAIL ${f}\n`, e); }
  }
} finally { rmSync(out, { recursive: true, force: true }); }
console.log(`${files.length - failed}/${files.length} Testdateien bestanden`);
process.exit(failed ? 1 : 0);
