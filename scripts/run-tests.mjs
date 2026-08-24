/**
 * Bundle the TypeScript tests with esbuild, then run them under `node --test`.
 *
 * Bundling sidesteps Node's requirement for explicit file extensions in ESM
 * specifiers, which the app's source (written for a bundler) does not use.
 */
import { rm, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = new URL('../', import.meta.url);
const outdir = fileURLToPath(new URL('.test-build/', root));
const testsDir = fileURLToPath(new URL('tests/', root));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const entryPoints = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `${testsDir}${name}`);

await esbuild.build({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const built = (await readdir(outdir))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => `${outdir}${name}`);

const child = spawn(process.execPath, ['--test', ...built], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
