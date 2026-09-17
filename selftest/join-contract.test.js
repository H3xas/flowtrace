/**
 * The `join --against` skip gate, the `join --export-edges` completeness guarantee, and the
 * provenance an export and a snapshot carry — argument-parser, exit-code and format surface,
 * so per selftest/README.md they belong here rather than in the private suite alone. Nothing
 * here needs a git checkout; what does is in export-check.test.js.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join as joinPath } from 'node:path';
import test from 'node:test';
import { exportProblems } from './export-invariants.js';
import { REPO_ROOT, runCli } from './helpers.js';
import { copyCorpus, extract, providerDocument, writeConfig, writeJsonFile } from './helpers.js';

test('--allow-skipped without --against is a usage error exiting 2', () => {
  const { status, stdout, stderr } = runCli(['join', '--allow-skipped']);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /--json, --fail-on and --allow-skipped are join --against options/);
});

test('--allow-skipped on a command other than join is a usage error exiting 2', () => {
  const { status, stderr } = runCli(['trace', 'POST does/not/matter', '--allow-skipped']);
  assert.equal(status, 2);
  assert.match(stderr, /--allow-skipped is a join option/);
});

/** A caller whose code end has neither file nor line — an incomplete fact a factsProvider
 * or a future extractor could plausibly emit, exactly the shape join-export.js must
 * refuse rather than coerce to null. */
function writeIncompleteEdgeWorkspace(dir) {
  const factsDir = joinPath(dir, 'out', 'facts');
  mkdirSync(factsDir, { recursive: true });
  writeFileSync(
    joinPath(factsDir, 'routes.json'),
    `${JSON.stringify(
      {
        repo: 'routes',
        kind: 'backend',
        facts: [
          {
            type: 'route',
            file: 'src/Controllers/GizmoController.cs',
            line: 10,
            controller: 'GizmoController',
            action: 'Activate',
            verb: 'POST',
            template: 'gizmos/v1/activate',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    joinPath(factsDir, 'caller.json'),
    `${JSON.stringify(
      {
        repo: 'caller',
        kind: 'mobile',
        facts: [
          {
            type: 'gateway_call',
            file: null,
            line: null,
            service: 'GizmoClient',
            method: 'activate',
            verb: 'POST',
            template: 'gizmos/v1/activate',
            resolved: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

test('join --export-edges refuses a joined edge whose code end lacks file or line, and writes nothing', (t) => {
  const dir = copyCorpus(t);
  writeIncompleteEdgeWorkspace(dir);
  const target = joinPath(dir, 'edges.json');

  const first = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /flowtrace: .*refusing calls POST gizmos\/v1\/activate.*from.*missing repo, file or line/);
  assert.equal(existsSync(target), false, 'a refused export must write nothing');

  // A file already at the target path is left exactly as it was, not truncated or replaced.
  writeFileSync(target, 'sentinel\n');
  const second = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'sentinel\n', 'an existing file at the target path must be untouched');
  rmSync(target);
});

test('join --export-edges still exports once every code end is complete', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const result = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const exported = JSON.parse(readFileSync(joinPath(dir, 'edges.json'), 'utf8'));
  assert.equal(exported.format, 'flowtrace-edges');
  assert.equal(exported.schemaVersion, 1);
  assert.ok(Array.isArray(exported.edges));
});

function exportWith(dir, config, target) {
  extract(dir, config);
  const result = runCli(['join', '--config', config, '--export-edges', target], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(joinPath(dir, target), 'utf8'));
}

function onlySet(document) {
  assert.equal(document.provenance.factSets.length, 1);
  return document.provenance.factSets[0];
}

test('an export over a facts provider never shares a provenance id with the same export without one', (t) => {
  const dir = copyCorpus(t);
  writeJsonFile(dir, 'provider.json', providerDocument());
  writeConfig(dir, 'plain.config.json');
  writeConfig(dir, 'provided.config.json', { merge: 'regex-only-with-diff' });

  const plain = exportWith(dir, 'plain.config.json', 'plain.json');
  const provided = exportWith(dir, 'provided.config.json', 'provided.json');

  assert.deepEqual(exportProblems(plain), []);
  assert.deepEqual(exportProblems(provided), []);
  assert.equal(onlySet(plain).digest, onlySet(provided).digest, 'the facts themselves are identical');
  assert.equal(onlySet(plain).provider, undefined);
  assert.deepEqual(Object.keys(onlySet(provided).provider), [
    'producer', 'version', 'merge', 'supplied', 'kept', 'replaced', 'comparison', 'digest',
  ]);
  assert.notEqual(plain.provenance.id, provided.provenance.id);
});

test('a provider location reaches no identity: same facts in another directory keep the provenance id', (t) => {
  const exports = [];
  const dirs = [];
  for (const run of [1, 2]) {
    const dir = copyCorpus(t);
    writeJsonFile(dir, 'provider.json', providerDocument());
    writeConfig(dir, 'provided.config.json', { merge: 'prefer-external' });
    exports.push(exportWith(dir, 'provided.config.json', `run-${run}.json`));
    const header = JSON.parse(readFileSync(joinPath(dir, 'out', 'facts', 'api.json'), 'utf8'));
    const source = header.provider.source.file;
    assert.ok(isAbsolute(source) && source.endsWith('provider.json'), 'the facts header still records where the document was read');
    dirs.push(dir, realpathSync(dir));
  }
  const [first, second] = exports;
  assert.notEqual(dirs[0], dirs[2]);
  assert.equal(first.provenance.id, second.provenance.id);
  for (const [index, document] of exports.entries()) {
    assert.equal(Object.hasOwn(onlySet(document).provider, 'source'), false);
    const text = JSON.stringify(document);
    for (const dir of dirs) assert.equal(text.includes(dir), false, `export ${index + 1} names a checkout path`);
  }
});

test('under regex-only-with-diff, two provider documents with equal counts still produce different ids', (t) => {
  const dir = copyCorpus(t);
  writeConfig(dir, 'provided.config.json', { merge: 'regex-only-with-diff' });
  writeJsonFile(dir, 'provider.json', providerDocument({ action: 'Archive' }));
  const archive = exportWith(dir, 'provided.config.json', 'archive.json');
  writeJsonFile(dir, 'provider.json', providerDocument({ action: 'Retire' }));
  const retire = exportWith(dir, 'provided.config.json', 'retire.json');

  const [before, after] = [onlySet(archive), onlySet(retire)];
  assert.equal(before.digest, after.digest, 'none of the provider facts reaches the fact array');
  for (const field of ['producer', 'version', 'merge', 'supplied', 'kept', 'replaced', 'comparison']) {
    assert.deepEqual(before.provider[field], after.provider[field], `${field} is unchanged`);
  }
  assert.notEqual(before.provider.digest, after.provider.digest);
  assert.notEqual(archive.provenance.id, retire.provenance.id);
});

function writeHandFactSets(dir, { witness }) {
  const factsDir = joinPath(dir, 'out', 'facts');
  rmSync(factsDir, { recursive: true, force: true });
  mkdirSync(factsDir, { recursive: true });
  const header = { repo: 'routes', kind: 'backend', generatedFrom: 'flowtrace 0.0.0' };
  if (witness) {
    Object.assign(header, {
      headSha: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
      dirtyDigest: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    });
  }
  header.facts = [
    { type: 'route', file: 'src/Controllers/GizmoController.cs', line: 10, controller: 'GizmoController', action: 'Activate', verb: 'POST', template: 'gizmos/v1/activate' },
  ];
  writeJsonFile(factsDir, 'routes.json', header);
}

test('a fact set with no revision witness states the absence, and differs from one that has a witness', (t) => {
  const dir = copyCorpus(t);
  writeHandFactSets(dir, { witness: false });
  const absent = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'absent.json', '--snapshot', 'absent.snapshot.json'], { cwd: dir });
  assert.equal(absent.status, 0, absent.stderr);
  writeHandFactSets(dir, { witness: true });
  const present = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'present.json'], { cwd: dir });
  assert.equal(present.status, 0, present.stderr);

  const without = JSON.parse(readFileSync(joinPath(dir, 'absent.json'), 'utf8'));
  const withWitness = JSON.parse(readFileSync(joinPath(dir, 'present.json'), 'utf8'));
  assert.equal(Object.hasOwn(onlySet(without), 'headSha'), true);
  assert.equal(onlySet(without).headSha, null);
  assert.equal(onlySet(without).digest, onlySet(withWitness).digest);
  assert.notEqual(without.provenance.id, withWitness.provenance.id);
  const snapshot = JSON.parse(readFileSync(joinPath(dir, 'absent.snapshot.json'), 'utf8'));
  assert.equal(snapshot.factSets[0].headSha, null);
});

test('the pinned worked-example export satisfies every checkout-free provenance invariant', () => {
  const pinned = JSON.parse(readFileSync(joinPath(REPO_ROOT, 'examples', 'demo-shop', 'exports', 'flowtrace-edges.json'), 'utf8'));
  assert.deepEqual(exportProblems(pinned), []);
  assert.deepEqual([...new Set(pinned.edges.map((edge) => edge.kind))].sort(), ['calls', 'consumes', 'publishes', 'tests']);

  const kindOf = new Map(pinned.provenance.factSets.map((set) => [set.repo, set.kind]));
  const crossRepoMessages = new Set(
    pinned.edges.filter((edge) => edge.kind === 'publishes').map((edge) => `${edge.key}|${edge.from.repo}`),
  );
  const consumedElsewhere = pinned.edges.filter(
    (edge) => edge.kind === 'consumes' && [...crossRepoMessages].some((entry) => entry.startsWith(`${edge.key}|`) && !entry.endsWith(`|${edge.to.repo}`)),
  );
  assert.ok(consumedElsewhere.length > 0, 'a message published in one backend is consumed in another');
  for (const edge of pinned.edges.filter((entry) => entry.kind === 'calls' || entry.kind === 'tests')) {
    assert.notEqual(edge.from.repo, edge.to.repo, `${edge.kind} ${edge.key} crosses repositories`);
  }
  assert.deepEqual(
    pinned.provenance.factSetsWithoutEdges.map((repo) => kindOf.get(repo)),
    ['playwright'],
    'the playwright fact set contributes no edge and says so',
  );
});

test('every provenance invariant names what moved when its field is broken', () => {
  const pinned = JSON.parse(readFileSync(joinPath(REPO_ROOT, 'examples', 'demo-shop', 'exports', 'flowtrace-edges.json'), 'utf8'));
  const backend = (document) => document.provenance.factSets.find((set) => set.kind === 'backend');
  const mutations = [
    ['a hand-edited provenance id', (d) => { d.provenance.id = '0000000000000000'; }, /provenance\.id "0000000000000000" is not the digest of its own block/],
    ['an edge whose provenance is another value', (d) => { d.edges[0].provenance = 'ffffffffffffffff'; }, /edges\[0\] \(\w+ [^)]+\): provenance "ffffffffffffffff" is not the envelope's id/],
    ['an edge whose provenance is empty', (d) => { d.edges[0].provenance = ''; }, /edges\[0\] \(\w+ [^)]+\): provenance "" is not the envelope's id/],
    ['an edge whose provenance is absent', (d) => { delete d.edges[0].provenance; }, /edges\[0\] \(\w+ [^)]+\): provenance is absent/],
    ['a removed revision witness', (d) => { delete backend(d).headSha; }, /factSets\[\w+\]\.headSha is absent/],
    ['an inverted dirty flag without its digest', (d) => { backend(d).dirty = !backend(d).dirty; }, /factSets\[\w+\]\.dirtyDigest /],
    ['a provider location in an identity', (d) => { backend(d).provider = { producer: 'route-lister', source: { file: 'provider.json' } }; }, /factSets\[\w+\]\.provider\.source is stated/],
    ['an unaccounted fact set', (d) => { d.provenance.factSetsWithoutEdges = []; }, /factSets\[\w+\] contributes no edge and is not listed/],
  ];
  for (const [name, mutate, expected] of mutations) {
    const document = structuredClone(pinned);
    mutate(document);
    const problems = exportProblems(document);
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('the exports README states what a tests edge claims and what it never claims', () => {
  const readme = readFileSync(joinPath(REPO_ROOT, 'examples', 'demo-shop', 'exports', 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /A `tests` record's `from` end is a spec, not code: `ref` is the test's title and `file` the spec that declares the intercept/);
  assert.match(readme, /It states that the spec's intercept pattern matches that route action\. It never states that the route's interior ran/);
  assert.match(readme, /literal byte equality within one checkout/);
  assert.match(readme, /canonical structural and provenance equality against the pinned copy/);
});

test('join --snapshot writes schemaVersion 2 with the provider identity, and a schemaVersion 1 snapshot is refused with a retake instruction', (t) => {
  const dir = copyCorpus(t);
  writeJsonFile(dir, 'provider.json', providerDocument({ action: 'Archive' }));
  writeConfig(dir, 'provided.config.json', { merge: 'regex-only-with-diff' });
  extract(dir, 'provided.config.json');
  const taken = runCli(['join', '--config', 'provided.config.json', '--snapshot', 'snapshot.json'], { cwd: dir });
  assert.equal(taken.status, 0, taken.stderr);
  const snapshot = JSON.parse(readFileSync(joinPath(dir, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.factSets[0].provider.producer, 'route-lister');
  assert.equal(Object.hasOwn(snapshot.factSets[0].provider, 'source'), false);

  writeJsonFile(dir, 'old.snapshot.json', { ...snapshot, schemaVersion: 1 });
  const refused = runCli(['join', '--config', 'provided.config.json', '--against', 'old.snapshot.json'], { cwd: dir });
  assert.equal(refused.status, 4);
  assert.match(refused.stderr, /schemaVersion 1 is not supported \(this version reads 2\): .*provider.*retake the snapshot with join --snapshot/);

  writeJsonFile(dir, 'provider.json', providerDocument({ action: 'Retire' }));
  extract(dir, 'provided.config.json');
  const compared = runCli(['join', '--config', 'provided.config.json', '--against', 'snapshot.json', '--json'], { cwd: dir });
  assert.equal(compared.status, 0, compared.stderr);
  const report = JSON.parse(compared.stdout);
  const [before, after] = [report.snapshot.factSets[0], report.current.factSets[0]];
  assert.equal(before.digest, after.digest);
  assert.equal(before.provider.comparison.route.externalOnly, after.provider.comparison.route.externalOnly);
  assert.notEqual(before.provider.digest, after.provider.digest);
});
