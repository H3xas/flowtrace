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

/** Eight independent validation gates put one route's own seed walk past the 64-seed cap, so
 * its seed, effect and evidence comparison is skipped and the gate has a truncated route to
 * report. Two such routes prove the gate names every skipped route, not only the first. Fewer
 * gates stay under the cap and cannot show the skip rung at all. */
function writeOverCapRoute(dir) {
  const file = joinPath(dir, 'backend', 'src', 'Controllers', 'GizmoController.cs');
  const lines = readFileSync(file, 'utf8').split('\n');
  const classClose = lines.findLastIndex((line) => line === '    }');
  assert.ok(classClose > 0, 'the corpus controller declares a class body to extend');
  const method = (action, template) => [
    `        [HttpPost("${template}")]`,
    `        public async Task<IActionResult> ${action}([FromBody] ConfigureGizmoRequest request)`,
    '        {',
    ...'ABCDEFGH'
      .split('')
      .map((field) => `            if (!request.${field}.IsValid()) { return BadRequest("${field.toLowerCase()}"); }`),
    '',
    '            var catalog = await _gizmos.GetCatalog();',
    '            return Ok(catalog);',
    '        }',
  ];
  lines.splice(classClose, 0, ...method('Configure', 'configure'), ...method('Retune', 'retune'));
  writeFileSync(file, lines.join('\n'));
}

/** One more validation gate on a route whose walk stays under the cap, which changes that
 * route's seed list and so produces a finding the gate can exit 1 on. */
function writeSeedDrift(dir) {
  const file = joinPath(dir, 'backend', 'src', 'Controllers', 'GizmoController.cs');
  const source = readFileSync(file, 'utf8');
  const call = '            var activated = await _gizmos.Activate(request.SerialCode);';
  writeFileSync(
    file,
    source.replace(call, `            if (!request.SerialCode.IsValid()) { return BadRequest("invalid"); }\n\n${call}`),
  );
}

test('a truncated route fails --fail-on on exit 5, and --allow-skipped hands the exit back to findings', (t) => {
  const dir = copyCorpus(t);
  writeOverCapRoute(dir);
  extract(dir);
  const taken = runCli(['join', '--config', 'gizmo.config.json', '--snapshot', 'snapshot.json'], { cwd: dir });
  assert.equal(taken.status, 0, taken.stderr);

  const informational = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json'], { cwd: dir });
  assert.equal(informational.status, 0, informational.stderr);
  for (const route of ['configure', 'retune']) {
    assert.match(
      informational.stdout,
      new RegExp(`skipped POST gizmos/v1/${route}: the snapshot side and the current side's seed walks were truncated at the 64-seed cap`),
    );
  }

  const gated = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--fail-on', 'any'], { cwd: dir });
  assert.equal(gated.status, 5);
  for (const route of ['configure', 'retune']) {
    assert.match(gated.stderr, new RegExp(`flowtrace: skipped POST gizmos/v1/${route}: .*truncated at the 64-seed cap`));
  }
  assert.match(gated.stderr, /flowtrace: 2 routes skipped and never compared/);

  writeSeedDrift(dir);
  extract(dir);
  const stillGated = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--fail-on', 'any'], { cwd: dir });
  assert.equal(stillGated.status, 5, 'a skipped route outranks a selected finding');
  const optedOut = runCli(
    ['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--fail-on', 'any', '--allow-skipped'],
    { cwd: dir },
  );
  assert.equal(optedOut.status, 1, optedOut.stderr);
  assert.match(optedOut.stderr, /1 finding selected by --fail-on/);
});

test('a skipped entry states the cap and the truncated side in JSON without moving the report schema', (t) => {
  const dir = copyCorpus(t);
  writeOverCapRoute(dir);
  extract(dir);
  const taken = runCli(['join', '--config', 'gizmo.config.json', '--snapshot', 'snapshot.json'], { cwd: dir });
  assert.equal(taken.status, 0, taken.stderr);

  const result = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--json', '--fail-on', 'any'], { cwd: dir });
  assert.equal(result.status, 5);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(
    report.skipped.map((entry) => entry.route),
    ['POST gizmos/v1/configure', 'POST gizmos/v1/retune'],
  );
  for (const entry of report.skipped) {
    assert.deepEqual(Object.keys(entry).sort(), ['reason', 'route']);
    assert.match(entry.reason, /the snapshot side and the current side's seed walks were truncated at the 64-seed cap/);
  }
});

test('a drifting pair without truncation exits 1 under --fail-on, and a clean pair exits 0', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const taken = runCli(['join', '--config', 'gizmo.config.json', '--snapshot', 'snapshot.json'], { cwd: dir });
  assert.equal(taken.status, 0, taken.stderr);

  const clean = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--fail-on', 'any'], { cwd: dir });
  assert.equal(clean.status, 0, clean.stderr);

  writeSeedDrift(dir);
  extract(dir);
  const drifted = runCli(['join', '--config', 'gizmo.config.json', '--against', 'snapshot.json', '--fail-on', 'any'], { cwd: dir });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stdout, /seed added: validation=invalid/);
  assert.match(drifted.stderr, /1 finding selected by --fail-on/);
  assert.doesNotMatch(drifted.stderr, /skipped/);
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

/** Hand-written facts with no extraction: both sides of the hop are exactly what a test
 * states, so a joined edge or its absence is the matcher's own decision. */
function syntheticJoin(t, { routes, callers, aliases = [] }) {
  const dir = copyCorpus(t);
  const factsDir = joinPath(dir, 'out', 'facts');
  mkdirSync(factsDir, { recursive: true });
  const writeSet = (name, repo, kind, facts) =>
    writeFileSync(joinPath(factsDir, `${name}.json`), `${JSON.stringify({ repo, kind, facts }, null, 2)}\n`);
  if (routes.length > 0) writeSet('routes', 'backend', 'backend', routes);
  if (callers.length > 0) writeSet('callers', 'web', 'mobile', callers);
  writeFileSync(
    joinPath(dir, 'join.config.json'),
    `${JSON.stringify({ out: 'out', repos: [{ id: 'api', kind: 'backend', root: 'backend', role: ['api'] }], aliases }, null, 2)}\n`,
  );
  const run = runCli(['join', '--config', 'join.config.json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(joinPath(dir, 'out', 'flow.json'), 'utf8'));
}

function routeFact(verb, template, action, line) {
  return {
    type: 'route',
    file: 'src/Controllers/ZoneController.cs',
    line,
    controller: 'ZoneController',
    action,
    verb,
    template,
  };
}

function gatewayFact(verb, template, method, line, resolved = true) {
  return {
    type: 'gateway_call',
    file: 'src/actions/zones.ts',
    line,
    service: 'httpClient',
    method,
    verb,
    template,
    resolved,
  };
}

const DYNAMIC_TEMPLATES = ['*', '${url}', '{id}', '**', '/**?q=1', '//${value}//#frag'];

test('Dynamic URL join AC-1: a request whose URL normalizes to bare star joins no route', (t) => {
  const routes = [
    routeFact('GET', 'glasshouse/v1/zones/{zoneId}/readings', 'Readings', 10),
    routeFact('GET', 'glasshouse/v1/zones/{zoneId}/alarms', 'Alarms', 20),
    routeFact('ANY', 'glasshouse/v1/ping', 'Ping', 30),
    routeFact('GET', '*', 'Anything', 40),
  ];
  const aliases = [{ from: 'glasshouse', to: 'backend' }];
  const callers = DYNAMIC_TEMPLATES.map((template, index) =>
    gatewayFact(index % 2 === 0 ? 'GET' : 'ANY', template, `call${index}`, 100 + index, index < 3),
  );
  for (const order of [routes, [...routes].reverse()]) {
    const flow = syntheticJoin(t, { routes: order, callers, aliases });
    assert.deepEqual(
      flow.edges.filter((edge) => edge.kind === 'calls'),
      [],
      `routes in order ${order.map((route) => route.template).join(', ')}`,
    );
    const expected = callers
      .map((fact) => ({ key: `${fact.verb} *`, fact }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.fact.line - b.fact.line);
    const actual = [...flow.unjoined.mobile_calls_without_route].sort(
      (a, b) => a.key.localeCompare(b.key) || a.fact.line - b.fact.line,
    );
    assert.deepEqual(actual, expected);
  }
});

test('Dynamic URL join AC-2: an unjoined dynamic caller keeps the unresolved representation', (t) => {
  const route = routeFact('GET', 'glasshouse/v1/zones/{zoneId}/readings', 'Readings', 10);
  const caller = gatewayFact('GET', '${url}', 'loadReport', 30, false);
  const flow = syntheticJoin(t, { routes: [route], callers: [caller] });

  assert.deepEqual(Object.keys(flow).sort(), ['edges', 'unjoined']);
  assert.deepEqual(flow.edges, []);
  assert.deepEqual(flow.unjoined.mobile_calls_without_route, [{ key: 'GET *', fact: caller }]);
  assert.deepEqual(flow.unjoined.routes_without_caller, [
    { key: 'GET glasshouse/v1/zones/*/readings', fact: route },
  ]);
  assert.deepEqual(Object.keys(flow.unjoined).sort(), [
    'consume_without_publisher',
    'intercepts_without_route',
    'messages_without_contract',
    'mobile_calls_without_route',
    'publish_unresolved',
    'publish_without_consumer',
    'routes_without_caller',
  ]);
});

test('Dynamic URL join AC-3: known paths keep exact, prefix, alias and suffix joins', (t) => {
  const readings = routeFact('GET', 'glasshouse/v1/zones/{zoneId}/readings', 'Readings', 10);
  const watchers = routeFact('PUT', 'glasshouse/v1/zones/{zoneId}/watchers', 'SaveWatchers', 20);
  const status = routeFact('ANY', 'glasshouse/v1/status', 'Status', 30);
  const callers = [
    gatewayFact('GET', 'glasshouse/v1/zones/{zoneId}/readings', 'exactPath', 1),
    gatewayFact('GET', 'glasshouse/v1/zones/{zoneId}/readings?include=alarms', 'exactWithQuery', 2),
    gatewayFact('GET', 'glasshouse/v1/zones/*', 'prefixPath', 3),
    gatewayFact('PUT', 'v1/zones/{zoneId}/watchers', 'aliasPath', 4),
    gatewayFact('GET', 'status', 'suffixPath', 5),
    gatewayFact('GET', 'glasshouse/v1/status', 'anyVerb', 6),
  ];
  const flow = syntheticJoin(t, {
    routes: [readings, watchers, status],
    callers,
    aliases: [{ from: 'v1', to: 'glasshouse/v1' }],
  });
  const calls = flow.edges.filter((edge) => edge.kind === 'calls');
  const byMethod = new Map(calls.map((edge) => [edge.from.ref, edge]));

  const exact = byMethod.get('httpClient.exactPath');
  assert.equal(exact.match, 'exact');
  assert.equal(exact.key, 'GET glasshouse/v1/zones/*/readings');
  assert.equal(exact.callerKey, 'GET glasshouse/v1/zones/*/readings');
  assert.equal(exact.to.ref, 'ZoneController.Readings');
  assert.equal(byMethod.get('httpClient.exactWithQuery').match, 'exact');
  assert.equal(byMethod.get('httpClient.exactWithQuery').key, 'GET glasshouse/v1/zones/*/readings');
  assert.equal(byMethod.get('httpClient.prefixPath').match, 'prefix');
  assert.equal(byMethod.get('httpClient.prefixPath').key, 'GET glasshouse/v1/zones/*/readings');
  assert.equal(byMethod.get('httpClient.aliasPath').match, 'alias');
  assert.deepEqual(byMethod.get('httpClient.aliasPath').alias, { from: 'v1', to: 'glasshouse/v1' });
  assert.equal(byMethod.get('httpClient.aliasPath').key, 'PUT glasshouse/v1/zones/*/watchers');
  assert.equal(byMethod.get('httpClient.suffixPath').match, 'suffix');
  assert.equal(byMethod.get('httpClient.suffixPath').key, 'ANY glasshouse/v1/status');
  assert.equal(byMethod.get('httpClient.anyVerb').match, 'exact');
  assert.equal(byMethod.get('httpClient.anyVerb').key, 'ANY glasshouse/v1/status');
  assert.deepEqual(flow.unjoined.mobile_calls_without_route, []);
  assert.deepEqual(flow.unjoined.routes_without_caller, []);
});
