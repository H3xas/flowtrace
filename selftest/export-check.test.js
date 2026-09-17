/**
 * `scripts/check-pinned-export.mjs` fails, naming what moved, for every way an export's
 * provenance can be wrong while its edges stay exactly as they were. These need a git
 * checkout, because the check binds each fact set's `headSha` to the checkout's HEAD; the
 * invariants a document satisfies on its own are pinned without one in join-contract.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import test from 'node:test';
import { copyCorpus, extract, providerDocument, REPO_ROOT, runCli, writeConfig, writeJsonFile } from './helpers.js';

const CHECK = joinPath(REPO_ROOT, 'scripts', 'check-pinned-export.mjs');
const CONFIG = 'export.config.json';
const CLIENT = { id: 'client', kind: 'web', root: 'client', cypressSubpath: 'cypress' };

function writeSource(dir, path, text) {
  mkdirSync(dirname(joinPath(dir, path)), { recursive: true });
  writeFileSync(joinPath(dir, path), text);
}

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** The corpus backend taking a provider under regex-only-with-diff, plus a web client whose
 * gateway call and Cypress intercept both reach the backend's activate route, committed. */
function checkoutWorkspace(t) {
  const dir = copyCorpus(t);
  writeSource(dir, 'client/src/services/gizmos.ts', [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export const activateGizmo = (serialCode: string) =>',
    "  httpClient.getGatewayClient().post('gizmos/v1/activate', { serialCode });",
    '',
  ].join('\n'));
  writeSource(dir, 'client/cypress/e2e/activate.cy.ts', [
    "describe('activation', () => {",
    "  it('activates a gizmo', () => {",
    "    cy.intercept('POST', '**/gizmos/v1/activate', { statusCode: 200 });",
    '  });',
    '});',
    '',
  ].join('\n'));
  writeJsonFile(dir, 'provider.json', providerDocument());
  writeConfig(dir, CONFIG, { merge: 'regex-only-with-diff', extraRepos: [CLIENT] });
  writeFileSync(joinPath(dir, '.gitignore'), 'out/\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'selftest@example.invalid');
  git(dir, 'config', 'user.name', 'flowtrace selftest');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function regenerate(dir, target) {
  extract(dir, CONFIG);
  const result = runCli(['join', '--config', CONFIG, '--export-edges', target], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(joinPath(dir, target), 'utf8'));
}

function check(dir, generated, pinned) {
  return spawnSync(process.execPath, [CHECK, generated, pinned], { cwd: dir, encoding: 'utf8' });
}

function topology(document) {
  return document.edges.map(({ provenance, ...record }) => record);
}

test('check-pinned-export fails on every provenance mutation that leaves the edges untouched', async (t) => {
  const dir = checkoutWorkspace(t);
  const pinned = regenerate(dir, 'out/pinned.json');
  assert.deepEqual([...new Set(pinned.edges.map((edge) => edge.kind))].sort(), ['calls', 'tests']);

  const baseline = check(dir, 'out/pinned.json', 'out/pinned.json');
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(regenerate(dir, 'out/fresh.json').provenance.id, pinned.provenance.id);
  assert.equal(check(dir, 'out/fresh.json', 'out/pinned.json').status, 0);

  const api = (document) => document.provenance.factSets.find((set) => set.repo === 'api');
  const edited = [
    ['a mutated headSha', (d) => { api(d).headSha = 'f'.repeat(40); }, /factSets\[api\]\.headSha "f{40}" is not this checkout's HEAD/],
    ['a removed headSha', (d) => { delete api(d).headSha; }, /factSets\[api\]\.headSha is absent/],
    ['an inverted dirty without its digest', (d) => { api(d).dirty = !api(d).dirty; }, /factSets\[api\]\.dirtyDigest /],
    ['a changed fileCount', (d) => { api(d).fileCount += 1; }, /export\.provenance\.factSets\[api\]\.fileCount: pinned \d+, generated \d+/],
    ['a hand-edited provenance id', (d) => { d.provenance.id = '0'.repeat(16); }, /provenance\.id "0{16}" is not the digest of its own block/],
    ['an edge whose provenance is another value', (d) => { d.edges[0].provenance = 'f'.repeat(16); }, /edges\[0\] \(calls POST gizmos\/v1\/activate\): provenance "f{16}" is not the envelope's id/],
    ['an edge whose provenance is absent', (d) => { delete d.edges[0].provenance; }, /edges\[0\] \(calls POST gizmos\/v1\/activate\): provenance is absent/],
  ];
  for (const [name, mutate, expected] of edited) {
    await t.test(name, () => {
      const document = structuredClone(pinned);
      mutate(document);
      assert.deepEqual(topology(document), topology(pinned));
      writeJsonFile(dir, 'out/mutated.json', document);
      const result = check(dir, 'out/mutated.json', 'out/pinned.json');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }

  await t.test('a tree that is not a git checkout', () => {
    const outside = mkdtempSync(joinPath(tmpdir(), 'flowtrace-no-checkout-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    for (const name of ['generated.json', 'pinned.json']) {
      copyFileSync(joinPath(dir, 'out', 'pinned.json'), joinPath(outside, name));
    }
    const result = spawnSync(process.execPath, [CHECK, 'generated.json', 'pinned.json'], { cwd: outside, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /this is not a git checkout, so a regeneration here carries no revision witness/);
    assert.doesNotMatch(result.stderr, /fileCount/);
  });

  const regenerated = [
    [
      'a changed provider producer or version',
      () => writeJsonFile(dir, 'provider.json', providerDocument({ producer: 'route-lister-next', version: '3.0.0' })),
      [/factSets\[api\]\.provider\.producer: pinned "route-lister", generated "route-lister-next"/, /factSets\[api\]\.provider\.version: pinned "2\.1\.0", generated "3\.0\.0"/],
    ],
    [
      'a removed provider block',
      () => writeConfig(dir, CONFIG, { extraRepos: [CLIENT] }),
      [/factSets\[api\]\.provider: pinned \{.*\}, generated absent/],
    ],
    [
      'a provider document whose content changed while every count stayed equal',
      () => writeJsonFile(dir, 'provider.json', providerDocument({ action: 'Retire' })),
      [/factSets\[api\]\.provider\.digest: pinned "[0-9a-f]{40}", generated "[0-9a-f]{40}"/],
    ],
  ];
  for (const [name, change, expected] of regenerated) {
    await t.test(name, () => {
      change();
      try {
        const document = regenerate(dir, 'out/regenerated.json');
        assert.deepEqual(topology(document), topology(pinned));
        const result = check(dir, 'out/regenerated.json', 'out/pinned.json');
        assert.notEqual(result.status, 0);
        for (const pattern of expected) assert.match(result.stderr, pattern);
        assert.doesNotMatch(result.stderr, /provider\.(supplied|kept|replaced|comparison)/);
      } finally {
        git(dir, 'checkout', '--', '.');
      }
    });
  }
});
