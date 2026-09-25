/**
 * Every input a replay must not accept as a baseline yields a named diagnostic and a non-zero
 * status instead of a projection: an edit the tool's own freshness fingerprint cannot see, a
 * snapshot whose facts no longer match their digest, a missing provider document, a failed
 * title collection, a tool build whose identity is unknown, and a fact set swapped in from
 * another capture. The unmutated bundle is the control and replays clean.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './helpers.js';
import {
  captureCli,
  copyPack,
  currentGeneration,
  diagnosticNames,
  readJson,
  replayCli,
  tempDir,
  writeJson,
} from './journey-helpers.js';
import { sha256 } from '../scripts/journey-pack/identity.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function reseal(generation) {
  const manifestFile = join(generation, 'capture.json');
  const manifest = readJson(manifestFile);
  manifest.snapshot.sha256 = sha256(readFileSync(join(generation, 'snapshot.json')));
  writeJson(manifestFile, manifest);
}

test('the unmutated bundle replays clean', (t) => {
  const pack = copyPack(t);
  assert.equal(captureCli(pack).status, 0);
  const out = tempDir(t, 'control');
  const result = replayCli(pack, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(diagnosticNames(result.stderr), []);
  assert.equal(readJson(join(out, 'replay.json')).result, 'replayed');
});

test('a second edit to an already modified file is caught although the dirty fingerprint stays the same', (t) => {
  const pack = copyPack(t);
  writeFileSync(join(pack.dir, '.gitignore'), 'out/\n');
  git(pack.dir, 'init', '-q');
  git(pack.dir, 'config', 'user.email', 'selftest@example.invalid');
  git(pack.dir, 'config', 'user.name', 'journey selftest');
  git(pack.dir, 'add', '-A');
  git(pack.dir, 'commit', '-q', '-m', 'initial');
  const edited = join(pack.dir, 'web', 'src', 'actions', 'notices.ts');
  appendFileSync(edited, 'export const FIRST_EDIT = 1;\n');
  assert.equal(captureCli(pack).status, 0);
  const firstManifest = readJson(join(currentGeneration(pack.bundle), 'capture.json'));

  appendFileSync(edited, 'export const SECOND_EDIT = 2;\n');
  const out = tempDir(t, 'second-edit');
  const result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['source-changed-since-capture']);
  assert.match(result.stderr, /content of web differs/);
  assert.equal(existsSync(join(out, 'projection.json')), false);

  const second = join(pack.work, 'second-bundle');
  assert.equal(captureCli(pack, { bundle: second }).status, 0);
  const secondManifest = readJson(join(currentGeneration(second), 'capture.json'));
  const web = (manifest) => manifest.repositories.find((entry) => entry.id === 'web');
  assert.match(web(firstManifest).factSet.headSha, /^[0-9a-f]{40}$/);
  assert.equal(web(firstManifest).factSet.dirty, true);
  assert.equal(web(secondManifest).factSet.headSha, web(firstManifest).factSet.headSha);
  assert.equal(web(secondManifest).factSet.dirtyDigest, web(firstManifest).factSet.dirtyDigest);
  assert.notEqual(web(secondManifest).content.digest, web(firstManifest).content.digest);
});

test('a snapshot whose facts no longer match their digest is refused by the tool itself', (t) => {
  const pack = copyPack(t);
  assert.equal(captureCli(pack).status, 0);
  const generation = currentGeneration(pack.bundle);
  const snapshotFile = join(generation, 'snapshot.json');
  const snapshot = readJson(snapshotFile);
  snapshot.factSets.find((set) => set.repo === 'backend').facts[0].line += 1;
  writeJson(snapshotFile, snapshot);
  reseal(generation);
  const out = tempDir(t, 'digest');
  const result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['facts-digest-mismatch']);
  const manifest = readJson(join(out, 'replay.json'));
  assert.equal(manifest.invocations.length, 1);
  assert.equal(manifest.invocations[0].exit, 4);
});

test('a configured facts provider whose document is missing refuses the capture', (t) => {
  const pack = copyPack(t);
  const config = readJson(pack.config);
  config.repos.find((repo) => repo.id === 'backend').factsProvider = { file: 'absent.json', merge: 'prefer-external' };
  writeJson(pack.config, config);
  const result = captureCli(pack);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['provider-document-missing']);
  assert.match(result.stderr, /repository backend/);
  assert.equal(existsSync(join(pack.bundle, 'current')), false);
});

test('a title collector that failed refuses the capture rather than promoting its facts', (t) => {
  const pack = copyPack(t);
  const suite = join(pack.dir, 'suite');
  mkdirSync(join(suite, 'specs'), { recursive: true });
  writeFileSync(
    join(suite, 'specs', 'watchers.spec.ts'),
    "import { test } from '@playwright/test';\n\ntest('saves the selected watchers', async () => {});\n",
  );
  const config = readJson(pack.config);
  config.repos.push({ id: 'suite', kind: 'playwright', root: 'suite', titles: true });
  writeJson(pack.config, config);
  const result = captureCli(pack);
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(diagnosticNames(result.stderr), ['titles-collector-failed']);
  assert.match(result.stderr, /repository suite/);
  const refused = readJson(join(pack.bundle, 'refused-capture.json'));
  assert.equal(refused.invocations.find((entry) => entry.verb === 'extract').exit, 0);
  assert.equal(existsSync(join(pack.bundle, 'current')), false);
});

test('a bundle captured by a build of unknown identity is not accepted as a baseline', (t) => {
  const pack = copyPack(t);
  const tool = join(pack.work, 'tool');
  for (const part of ['bin', 'lib', 'package.json', join('scripts', 'journey-pack.mjs'), join('scripts', 'journey-pack')]) {
    cpSync(join(REPO_ROOT, part), join(tool, part), { recursive: true });
  }
  const harness = join(tool, 'scripts', 'journey-pack.mjs');
  const captured = captureCli(pack, { harness, cwd: tool });
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(readJson(join(currentGeneration(pack.bundle), 'capture.json')).tool.checkoutHead, 'unknown');
  const out = tempDir(t, 'unknown');
  const result = replayCli(pack, out, [], { harness, cwd: tool });
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['identity-unknown']);
  assert.match(result.stderr, /tool\.checkoutHead/);
});

test('a fact set swapped in from another capture is a mismatched bundle', (t) => {
  const pack = copyPack(t);
  assert.equal(captureCli(pack).status, 0);
  const other = copyPack(t);
  appendFileSync(join(other.dir, 'backend', 'src', 'Models', 'Zone.cs'), '\nnamespace Greenhouse.Alerts.Models\n{\n    public class Greenhouse\n    {\n        public void Open()\n        {\n        }\n    }\n}\n');
  assert.equal(captureCli(other).status, 0);
  const generation = currentGeneration(pack.bundle);
  const snapshot = readJson(join(generation, 'snapshot.json'));
  const foreign = readJson(join(currentGeneration(other.bundle), 'snapshot.json')).factSets.find((set) => set.repo === 'backend');
  snapshot.factSets = snapshot.factSets.map((set) => (set.repo === 'backend' ? foreign : set));
  writeJson(join(generation, 'snapshot.json'), snapshot);
  reseal(generation);
  const out = tempDir(t, 'swapped');
  const result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['bundle-mismatch']);
  assert.match(result.stderr, /backend/);
});

test('a snapshot edited without resealing its manifest is a mismatched bundle', (t) => {
  const pack = copyPack(t);
  assert.equal(captureCli(pack).status, 0);
  const generation = currentGeneration(pack.bundle);
  appendFileSync(join(generation, 'snapshot.json'), '\n');
  const out = tempDir(t, 'unsealed');
  const result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['bundle-mismatch']);
});
