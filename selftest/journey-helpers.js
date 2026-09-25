/**
 * Shared plumbing for the journey pack tests: a disposable copy of the pack, the harness run as
 * a subprocess the way a contributor runs it, and small readers for what it leaves behind.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from './helpers.js';

export const PACK = join(REPO_ROOT, 'selftest', 'corpus', 'greenhouse-alerts');
export const HARNESS = join(REPO_ROOT, 'scripts', 'journey-pack.mjs');

export function tempDir(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `flowtrace-journey-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of the pack plus the paths a capture and a replay of it need. */
export function copyPack(t) {
  const work = tempDir(t, 'pack');
  const dir = join(work, 'pack');
  cpSync(PACK, dir, { recursive: true });
  return {
    work,
    dir,
    config: join(dir, 'greenhouse.config.json'),
    ledger: join(dir, 'expected.json'),
    observed: join(dir, 'observed.json'),
    bundle: join(work, 'bundle'),
  };
}

export function runHarness(args, { cwd = REPO_ROOT, harness = HARNESS, env = process.env } = {}) {
  const result = spawnSync(process.execPath, [harness, ...args], { cwd, encoding: 'utf8', env });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function captureCli(pack, options = {}) {
  return runHarness(['capture', '--config', options.config ?? pack.config, '--bundle', options.bundle ?? pack.bundle], options);
}

export function replayCli(pack, out, extra = [], options = {}) {
  return runHarness(
    [
      'replay',
      '--config', options.config ?? pack.config,
      '--bundle', options.bundle ?? pack.bundle,
      '--cases', options.ledger ?? pack.ledger,
      '--out', out,
      ...extra,
    ],
    options,
  );
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The promoted generation directory of a bundle, or null. */
export function currentGeneration(bundle) {
  const pointer = join(bundle, 'current');
  if (!existsSync(pointer)) return null;
  return join(bundle, readJson(pointer).current);
}

/** Every file under a directory with its bytes, for comparing a tree before and after. */
export function treeBytes(dir) {
  const out = new Map();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.set(relative(dir, path).split(sep).join('/'), `${statSync(path).size}:${readFileSync(path).toString('base64')}`);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

/** Diagnostic names printed on stderr, in order. */
export function diagnosticNames(stderr) {
  return [...stderr.matchAll(/^journey-pack: ([a-z-]+): /gm)].map((match) => match[1]).filter((name) => name !== 'usage');
}
