#!/usr/bin/env node
/**
 * Write the serial pins the concurrent-lookup tests compare against.
 *
 * Run it with the CLI of the commit the pins are pinned from. Each verb gets its own run
 * in a fresh copy of the prepared fixture, and `expected/<name>/` holds that run's status,
 * stdout, stderr and every file the run created or changed. The temporary root is written
 * as `<ROOT>` so a pin reads the same from any directory. `expected/lookups.json` holds
 * the answers of that commit's own `lib/scout.js` to every lookup case in `pinned.mjs`.
 *
 *   node pin.mjs --cli /path/to/bin/flowtrace.js [--scout /path/to/lib/scout.js] [--out expected]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG, INVOCATIONS, serialAnswers } from './pinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// A walk's status identity hashes the fixture's head commit, so every input of that
// commit is fixed: the same tree then gives the same commit on any machine and any day.
const FIXTURE_COMMIT = {
  GIT_AUTHOR_NAME: 'flowtrace selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'flowtrace selftest',
  GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const FIXTURE_GIT = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? null : process.argv[at + 1];
}

const cli = resolve(argument('--cli') || join(HERE, '..', '..', '..', 'bin', 'flowtrace.js'));
const outRoot = resolve(argument('--out') || join(HERE, 'expected'));
const scoutModule = resolve(argument('--scout') || join(dirname(cli), '..', 'lib', 'scout.js'));
const workRoot = mkdtempSync(join(tmpdir(), 'flowtrace-pins-'));

/** Every regular file under `dir`, relative to it, in sorted order. */
function walk(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'expected') continue;
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function readAll(dir) {
  const map = new Map();
  for (const rel of walk(dir)) map.set(rel, readFileSync(join(dir, rel)));
  return map;
}

function run(cwd, args, env) {
  const result = spawnSync(process.execPath, [cli, ...args, '--config', CONFIG], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The fixture the verb runs start from: the corpus, its git baseline, and its facts. */
function prepare(name, { touch = false } = {}) {
  const dir = join(workRoot, name);
  cpSync(HERE, dir, { recursive: true, filter: (source) => !source.includes(`${HERE}/expected`) });
  const git = (...args) => {
    const result = spawnSync('git', [...FIXTURE_GIT, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, ...FIXTURE_COMMIT },
    });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  if (touch) {
    // `affected` reads a diff from the checkout: one touched source file is enough.
    const target = join(dir, 'backend', 'src', 'Controllers', 'ZoneWatchersController.cs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}// touched for the diff\n`);
  }
  for (const args of [['extract'], ['join']]) {
    const result = run(dir, args, {});
    if (result.status !== 0) throw new Error(`fixture ${args[0]} failed: ${result.stderr}`);
  }
  return dir;
}

function rewriteRoot(text, root) {
  return text.split(root).join('<ROOT>').split(resolve(root)).join('<ROOT>');
}

const base = prepare('base');
const baseWithDiff = prepare('base-diff', { touch: true });
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const invocation of INVOCATIONS) {
  const dir = join(workRoot, invocation.name);
  cpSync(invocation.touch ? baseWithDiff : base, dir, { recursive: true });
  const before = readAll(dir);
  const result = run(dir, invocation.args, { FLOWTRACE_STUB_LOG: join(dir, 'stub.log') });
  const after = readAll(dir);
  const target = join(outRoot, invocation.name);
  mkdirSync(join(target, 'files'), { recursive: true });
  writeFileSync(join(target, 'status'), `${result.status}\n`);
  writeFileSync(join(target, 'stdout'), rewriteRoot(result.stdout, dir));
  writeFileSync(join(target, 'stderr'), rewriteRoot(result.stderr, dir));
  for (const [rel, body] of after) {
    if (rel === 'stub.log' || rel.endsWith('.log')) continue;
    const old = before.get(rel);
    if (old && old.equals(body)) continue;
    const at = join(target, 'files', rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, rewriteRoot(body.toString('utf8'), dir));
  }
  // A file the run deleted is part of its answer too.
  const removed = [...before.keys()].filter((rel) => !after.has(rel));
  if (removed.length > 0) writeFileSync(join(target, 'removed'), `${removed.sort().join('\n')}\n`);
  process.stdout.write(`${invocation.name}: exit ${result.status}\n`);
}

const { createScout } = await import(pathToFileURL(scoutModule).href);
writeFileSync(join(outRoot, 'lookups.json'), `${JSON.stringify(serialAnswers(createScout), null, 2)}\n`);
process.stdout.write('lookups: written\n');

rmSync(workRoot, { recursive: true, force: true });
