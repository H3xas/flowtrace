/**
 * Whether a Playwright test runs, as far as its spec file says: `static-skip`,
 * `environment-skip`, `unknown` or `eligible`, read against the environment values the
 * configuration names and never against the shell that runs `extract`. `cover` counts only an
 * eligible test as one that runs.
 *
 * `corpus/widget-gate/` holds the specs and one configuration with no environment values and
 * two with `E2E_ENV` set to `dev` and to `stage`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../lib/config.js';
import { buildEvidenceIndex, stateOf } from '../lib/cover.js';
import { inlineFunctionBody } from '../lib/extract/text.js';
import { validateFacts } from '../lib/facts.js';
import { copyFixture, extract, runCli } from './helpers.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flowtrace.js');

function extractGate(t, config = 'gate.config.json') {
  const dir = copyFixture(t, 'widget-gate');
  extract(dir, config);
  return { dir, facts: JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8')).facts };
}

function testsOf(facts, spec) {
  return facts.filter((candidate) => candidate.type === 'pw_test' && candidate.spec === spec);
}

function stateAt(facts, spec, line) {
  const found = testsOf(facts, spec).find((candidate) => candidate.line === line);
  assert.ok(found, `${spec}:${line} declares a test`);
  return found;
}

function guardsAt(facts, spec, line) {
  return stateAt(facts, spec, line).guards.map(({ line: at, scope, value }) => [at, scope, value]);
}

test('Test eligibility AC-27: static skips read with no value, and skipped means a static skip', (t) => {
  const { facts } = extractGate(t);
  const spec = 'tests/static.spec.ts';
  const states = testsOf(facts, spec).map((candidate) => [candidate.line, candidate.eligibility, candidate.skipped]);
  assert.deepEqual(states, [
    [3, 'eligible', false],
    [5, 'static-skip', true],
    [7, 'static-skip', true],
    [10, 'static-skip', true],
    [13, 'static-skip', true],
    [19, 'static-skip', true],
    [26, 'static-skip', true],
    [32, 'static-skip', true],
  ]);
  for (const candidate of facts.filter((entry) => entry.type === 'pw_test')) {
    assert.equal(candidate.skipped, candidate.eligibility === 'static-skip', `${candidate.spec}:${candidate.line}`);
  }
  const parked = (type) => facts.filter((entry) => entry.type === type && entry.spec === 'ui/parked.pw.ts').map((entry) => entry.skipped);
  assert.deepEqual(parked('pw_test'), [true], 'a test inside test.describe.fixme(');
  assert.deepEqual(parked('pw_stub'), [true], 'pw_stub reads the fixme describe as a skip');
  assert.deepEqual(parked('pw_backend'), [true], 'pw_backend reads it too');
  const backend = facts.filter((entry) => entry.type === 'pw_backend' && entry.spec === spec).map((entry) => entry.skipped);
  assert.deepEqual(backend, states.map(([, , skipped]) => skipped));
});

test('Test eligibility AC-27: a function-expression or expression-body describe keeps its skip', (t) => {
  const { facts } = extractGate(t);
  const spec = 'tests/function-callbacks.spec.ts';
  for (const [line, label] of [
    [4, 'a test with a destructured arrow inside test.describe.skip(..., function () {'],
    [10, 'a test inside test.describe.fixme(..., async function parked() {'],
    [33, 'a test that is the expression body of test.describe.skip('],
  ]) {
    assert.equal(stateAt(facts, spec, line).eligibility, 'static-skip', label);
    assert.equal(stateAt(facts, spec, line).skipped, true, label);
  }
});

test('Test eligibility AC-28: a function-expression hook, describe and test body keep their guards', (t) => {
  const dev = extractGate(t, 'gate-dev.config.json').facts;
  const stage = extractGate(t, 'gate-stage.config.json').facts;
  const spec = 'tests/function-callbacks.spec.ts';
  assert.deepEqual(guardsAt(dev, spec, 18), [[15, 'hook', false]], 'a function hook with a destructured parameter');
  assert.equal(stateAt(dev, spec, 18).eligibility, 'eligible');
  assert.deepEqual(guardsAt(stage, spec, 18), [[15, 'hook', true]]);
  assert.equal(stateAt(stage, spec, 18).eligibility, 'environment-skip');
  assert.deepEqual(
    guardsAt(dev, spec, 26),
    [
      [24, 'describe', false],
      [28, 'test', true],
    ],
    'a function test body whose nested arrow comes before its guard',
  );
  assert.equal(stateAt(dev, spec, 26).eligibility, 'environment-skip');
  assert.deepEqual(guardsAt(stage, spec, 26), [
    [24, 'describe', true],
    [28, 'test', false],
  ]);
});

test('Test eligibility AC-28: a callback body is the one after its own parameter list', () => {
  const bodyOf = (source) => {
    const found = inlineFunctionBody(source, 0, source.length);
    return found && { text: source.slice(found.open, found.close + 1), expression: found.expression };
  };
  const brace = (text) => ({ text, expression: false });
  assert.deepEqual(bodyOf('function () { run(() => { inner(); }); }'), brace('{ run(() => { inner(); }); }'));
  assert.deepEqual(bodyOf('async function ({ page }) { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('async function* named<T>(a: T): Promise<void> { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('async ({ request }) => { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('async ({ page }: { page: Page }): Promise<void> => { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('(a /* => { */, b = "{") => { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('async => { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('row => { go(); }'), brace('{ go(); }'));
  assert.deepEqual(bodyOf('() => test("x", () => {})'), { text: ' test("x", () => {})', expression: true });
  for (const source of ['handler', 'make(() => {})', 'function () {', '() =>', '{ a: 1 }']) {
    assert.equal(bodyOf(source), null, source);
  }
});

test('Test eligibility AC-28: guards are carried to each test in their scope, and two environments differ', (t) => {
  const dev = extractGate(t, 'gate-dev.config.json').facts;
  const stage = extractGate(t, 'gate-stage.config.json').facts;
  const spec = 'tests/environment.spec.ts';
  for (const line of [8, 12]) {
    assert.equal(stateAt(dev, spec, line).eligibility, 'eligible', `dev, line ${line}`);
    assert.equal(stateAt(stage, spec, line).eligibility, 'environment-skip', `stage, line ${line}`);
    assert.deepEqual(stateAt(dev, spec, line).guards, [{ line: 6, scope: 'describe', expression: '!supported', value: false }]);
  }
  assert.deepEqual(stateAt(dev, spec, 15).guards, [], 'a test outside the describe carries no guard');

  assert.deepEqual(guardsAt(stage, 'tests/file-scope.spec.ts', 5), [[3, 'file', true]], 'a file guard');
  assert.deepEqual(guardsAt(stage, 'tests/file-scope.spec.ts', 8), [[3, 'file', true]], 'a file guard reaches a nested test');
  assert.deepEqual(guardsAt(stage, 'tests/scopes.spec.ts', 12), [[9, 'hook', true]], 'a beforeEach hook guard');
  assert.equal(stateAt(dev, 'tests/scopes.spec.ts', 12).eligibility, 'eligible');
  assert.deepEqual(
    guardsAt(dev, 'tests/scopes.spec.ts', 21),
    [
      [16, 'describe', false],
      [19, 'describe', false],
      [22, 'test', true],
    ],
    'outer scope first, then inner, then the test body',
  );
  assert.equal(stateAt(dev, 'tests/scopes.spec.ts', 21).eligibility, 'environment-skip');
  assert.deepEqual(guardsAt(dev, 'tests/scopes.spec.ts', 33), [], 'a guard in a helper is not read');
  const guard = stateAt(stage, 'tests/scopes.spec.ts', 21).guards[2];
  assert.deepEqual(Object.keys(guard).sort(), ['expression', 'line', 'scope', 'value']);
  assert.equal(guard.expression, "process.env.E2E_ENV === 'dev'");
});

test('Test eligibility AC-29: a condition that cannot be read stays unknown and never makes a test eligible', (t) => {
  const plain = extractGate(t).facts;
  const dev = extractGate(t, 'gate-dev.config.json').facts;
  assert.deepEqual(guardsAt(plain, 'tests/environment.spec.ts', 8), [[6, 'describe', 'unknown']], 'no testEnvironment key');
  assert.equal(stateAt(plain, 'tests/environment.spec.ts', 8).eligibility, 'unknown');
  const spec = 'tests/unknown.spec.ts';
  for (const [line, label] of [
    [10, 'an imported binding'],
    [18, 'a let binding'],
    [24, 'a condition outside the grammar'],
    [30, 'a variable the key does not name'],
  ]) {
    assert.equal(stateAt(dev, spec, line).eligibility, 'unknown', label);
    assert.deepEqual(stateAt(dev, spec, line).guards.map((entry) => entry.value), ['unknown'], label);
  }
  assert.equal(stateAt(dev, spec, 37).eligibility, 'environment-skip', 'a true guard over an unknown one');
  assert.equal(stateAt(dev, spec, 44).eligibility, 'static-skip', 'a static skip over both');
  assert.deepEqual(guardsAt(dev, 'tests/scopes.spec.ts', 27), [[29, 'test', 'unknown']], 'a bare guard under a condition');
  assert.equal(stateAt(dev, 'tests/scopes.spec.ts', 41).eligibility, 'unknown', 'a guard that reads a loop binding');

  for (const facts of [plain, dev]) {
    for (const candidate of facts.filter((entry) => entry.type === 'pw_test')) {
      if (candidate.guards.some((entry) => entry.value === 'unknown')) {
        assert.notEqual(candidate.eligibility, 'eligible', `${candidate.spec}:${candidate.line}`);
      }
    }
  }
});

test('Test eligibility AC-30: testEnvironment loads, a malformed value refuses, and the process environment is never read', (t) => {
  const repos = [{ id: 'e2e', kind: 'playwright', root: 'e2e' }];
  const loaded = validateConfig({ out: 'out', repos, testEnvironment: { E2E_ENV: 'dev' } }, { file: 'gate.config.json' });
  assert.deepEqual(loaded.testEnvironment, { E2E_ENV: 'dev' });
  assert.equal(validateConfig({ out: 'out', repos }, { file: 'gate.config.json' }).testEnvironment, null);
  for (const value of [null, 'dev', ['dev'], { E2E_ENV: 1 }, { E2E_ENV: null }, { E2E_ENV: { nested: 'dev' } }]) {
    assert.throws(
      () => validateConfig({ out: 'out', repos, testEnvironment: value }, { file: 'gate.config.json' }),
      /^Error: config gate\.config\.json: "testEnvironment" must be an object of string values$/,
      JSON.stringify(value),
    );
  }

  const dir = copyFixture(t, 'widget-gate');
  const run = spawnSync(process.execPath, [CLI, 'extract', '--config', 'gate.config.json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, E2E_ENV: 'dev' },
  });
  assert.equal(run.status, 0, run.stderr);
  const facts = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8')).facts;
  assert.equal(stateAt(facts, 'tests/environment.spec.ts', 8).eligibility, 'unknown', 'E2E_ENV in the process is not read');
});

test('Test eligibility AC-31: cover counts only an eligible test as one that runs', (t) => {
  const stateFor = (config) => {
    const dir = copyFixture(t, 'widget-gate');
    extract(dir, config);
    const result = runCli(['cover', '--config', config, '--area', 'gate.area.txt', '--json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(JSON.parse(result.stdout).routes.map((route) => [route.key, route.state]));
  };
  assert.deepEqual(stateFor('gate-dev.config.json'), {
    'GET gate/v1/open': 'route',
    'GET gate/v1/staged': 'route',
    'GET gate/v1/unread': 'skipped',
    'GET gate/v1/parked': 'skipped',
    'GET gate/v1/folded': 'skipped',
  });
  assert.deepEqual(stateFor('gate-stage.config.json'), {
    'GET gate/v1/open': 'route',
    'GET gate/v1/staged': 'skipped',
    'GET gate/v1/unread': 'skipped',
    'GET gate/v1/parked': 'skipped',
    'GET gate/v1/folded': 'skipped',
  });

  const route = { type: 'route', file: 'A.cs', line: 1, verb: 'GET', template: 'gate/v1/open' };
  const pwTest = (extra) => ({ type: 'pw_test', file: 't.spec.ts', line: 1, spec: 't.spec.ts', test: 'x', ...extra });
  const request = { type: 'pw_request', file: 't.spec.ts', line: 2, spec: 't.spec.ts', test: 'x', verb: 'GET', template: 'gate/v1/open', resolved: true };
  const intercept = (skipped) => ({ type: 'cypress_intercept', file: 'c.cy.ts', line: 2, spec: 'c.cy.ts', test: 'y', verb: 'GET', pattern: '**/gate/v1/open', skipped });
  const evidenceState = (testFact, extra = []) => {
    const sets = [
      { repo: 'api', kind: 'backend', facts: [route] },
      { repo: 'e2e', kind: 'playwright', facts: [testFact, request, ...extra] },
    ];
    validateFacts(sets[1].facts);
    const index = buildEvidenceIndex(sets);
    return stateOf(index.byRoute.get('GET gate/v1/open') || []);
  };
  assert.equal(evidenceState(pwTest({ skipped: false })), 'route', 'a pw_test with no eligibility keeps the skipped rule');
  assert.equal(evidenceState(pwTest({ skipped: true })), 'skipped');
  assert.equal(evidenceState(pwTest({ skipped: false, eligibility: 'eligible', guards: [] })), 'route');
  for (const eligibility of ['environment-skip', 'unknown']) {
    assert.equal(evidenceState(pwTest({ skipped: false, eligibility, guards: [] })), 'skipped', eligibility);
  }
  assert.equal(evidenceState(pwTest({ skipped: true, eligibility: 'static-skip', guards: [] })), 'skipped');
  assert.equal(
    evidenceState(pwTest({ skipped: false, eligibility: 'unknown', guards: [] }), [intercept(false)]),
    'route',
    'Cypress evidence keeps the skipped rule',
  );
});

test('Test eligibility AC-32: the schema accepts the eligibility fields and refuses a malformed one', () => {
  const base = { type: 'pw_test', file: 't.spec.ts', line: 1, spec: 't.spec.ts', test: 'x', skipped: false };
  const guard = { line: 3, scope: 'describe', expression: '!supported', value: 'unknown' };
  assert.equal(
    validateFacts([
      base,
      { ...base, eligibility: 'eligible', guards: [] },
      { ...base, eligibility: 'unknown', guards: [guard] },
      { ...base, eligibility: 'environment-skip', guards: [{ ...guard, value: true }] },
      { ...base, skipped: true, eligibility: 'static-skip', guards: [{ ...guard, value: false }] },
    ]),
    5,
  );
  assert.throws(() => validateFacts([{ ...base, eligibility: 'maybe' }]), /field "eligibility" must be one of: static-skip, environment-skip, unknown, eligible/);
  for (const field of ['line', 'scope', 'expression', 'value']) {
    const { [field]: dropped, ...partial } = guard;
    assert.throws(() => validateFacts([{ ...base, eligibility: 'unknown', guards: [partial] }]), /a "guards" entry needs/, field);
  }
  assert.throws(() => validateFacts([{ ...base, eligibility: 'unknown', guards: [{ ...guard, scope: 'suite' }] }]), /"scope" of: file, describe, hook, test/);
  for (const eligibility of ['eligible', 'environment-skip', 'unknown']) {
    assert.throws(
      () => validateFacts([{ ...base, skipped: true, eligibility }]),
      /field "skipped" must be true exactly when "eligibility" is "static-skip"/,
      eligibility,
    );
  }
});
