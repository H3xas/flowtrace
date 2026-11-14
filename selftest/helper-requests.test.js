import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, copyFixture, runCli, asEarlierFacts } from './helpers.js';
import { captureFacts } from './corpus/lantern-depot/capture.mjs';
import { normaliseTemplate, requestIndex } from '../lib/skeleton.js';

const CORPUS = 'lantern-depot';
const CONFIG = 'lantern.config.json';
const BASE_FACTS = JSON.parse(readFileSync(join(REPO_ROOT, 'selftest', 'corpus', CORPUS, 'base-facts.json'), 'utf8'));

function extractDepot(t) {
  const dir = copyFixture(t, CORPUS);
  const result = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return { dir, facts: JSON.parse(readFileSync(join(dir, 'out', 'facts', 'depot.json'), 'utf8')).facts };
}

function factsOf(facts, type, spec, title) {
  return facts.filter((candidate) => candidate.type === type && candidate.spec === spec && candidate.test === title);
}

function requestsOf(facts, spec, title) {
  return factsOf(facts, 'pw_request', spec, title).map(({ testLine, ...rest }) => rest);
}

function request(spec, title, fields) {
  return { type: 'pw_request', file: spec, spec, test: title, ...fields };
}

const link = (file, line, call) => ({ file, line, call });

test('Helper request evidence AC-1: a test reaches a PUT and then a DELETE through a helper function and a helper class', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/shelves.spec.ts';
  const title = 'tidies a shelf through two helpers';
  const head = [link(spec, 8, 'tidyShelf'), link('helpers/tidy.ts', 4, 'steps.renameThenRemove')];
  assert.deepEqual(requestsOf(facts, spec, title), [
    request(spec, title, {
      line: 8,
      verb: 'PUT',
      template: 'depot/v1/shelves/${id}',
      resolved: true,
      via: 'helper',
      receiver: 'ShelfClient',
      chain: [...head, link('helpers/shelf-steps.ts', 7, 'this.shelves.rename'), link('clients/shelf-client.ts', 9, 'this.ctx.put')],
    }),
    request(spec, title, {
      line: 8,
      verb: 'DELETE',
      template: 'depot/v1/shelves/${id}',
      resolved: true,
      via: 'helper',
      receiver: 'ShelfClient',
      chain: [...head, link('helpers/shelf-steps.ts', 8, 'this.shelves.remove'), link('clients/shelf-client.ts', 13, 'this.ctx.delete')],
    }),
  ]);
});

test('Helper request evidence AC-2: every client call of a helper is one fact, in source order, through a parameter or any typed field', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/sweep.spec.ts';
  const sweep = [
    ['POST', 'depot/v1/bins/${id}/open', 'clients/bin-client.ts', 9],
    ['PUT', 'depot/v1/bins/${id}/label', 'clients/bin-client.ts', 17],
    ['POST', 'depot/v1/bins/${id}/close', 'clients/bin-client.ts', 13],
  ];
  const cases = [
    ['sweeps bins through a helper function', 7, 'sweepBins', [5, 6, 7], ['bins.open', 'bins.label', 'bins.close']],
    ['sweeps bins through a parameter property', 12, 'sweeper.sweep', [14, 15, 16], ['this.bins.open', 'this.bins.label', 'this.bins.close']],
    ['sweeps bins through a field declaration', 17, 'sweeper.sweep', [28, 29, 30], ['this.bins.open', 'this.bins.label', 'this.bins.close']],
    ['sweeps bins through a field the constructor creates', 22, 'sweeper.sweep', [42, 43, 44], ['this.bins.open', 'this.bins.label', 'this.bins.close']],
  ];
  for (const [title, line, entry, helperLines, helperCalls] of cases) {
    assert.deepEqual(
      requestsOf(facts, spec, title),
      sweep.map(([verb, template, clientFile, clientLine], index) =>
        request(spec, title, {
          line,
          verb,
          template,
          resolved: true,
          via: 'helper',
          receiver: 'BinClient',
          chain: [
            link(spec, line, entry),
            link('helpers/sweep.ts', helperLines[index], helperCalls[index]),
            link(clientFile, clientLine, `this.ctx.${verb.toLowerCase()}`),
          ],
        }),
      ),
      title,
    );
  }
});

test('Helper request evidence AC-3: a request inside an expect argument is a fact and gives the assert the kind of a request written before it', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/bins.spec.ts';
  const shape = (title) => ({
    requests: requestsOf(facts, spec, title).map((candidate) => `${candidate.verb} ${candidate.template}`),
    asserts: factsOf(facts, 'pw_assert', spec, title).map((candidate) => `${candidate.kind} ${candidate.value}`),
  });
  const pairs = [
    ['a client request inside expect', 'a client request on the line before expect', ['POST depot/v1/bins/${id}/close'], ['status 403']],
    ['a direct request inside expect', 'a direct request on the line before expect', ['POST depot/v1/bins/bin-4/open'], ['status 200']],
    [
      'a second request inside expect',
      'a second request on the line before expect',
      ['POST depot/v1/bins/${id}/open', 'POST depot/v1/bins/${id}/close'],
      ['effect 200'],
    ],
  ];
  for (const [inside, before, requests, asserts] of pairs) {
    assert.deepEqual(shape(inside), { requests, asserts }, inside);
    assert.deepEqual(shape(before), { requests, asserts }, before);
  }
  const expectLines = { 'a client request inside expect': 6, 'a direct request inside expect': 16, 'a second request inside expect': 27 };
  for (const [title, line] of Object.entries(expectLines)) {
    const found = requestsOf(facts, spec, title).at(-1);
    assert.equal(found.line, line, title);
    const asserted = factsOf(facts, 'pw_assert', spec, title)[0];
    assert.equal(asserted.line, line, title);
  }
  assert.deepEqual(requestsOf(facts, spec, 'a direct request inside expect'), [
    request(spec, 'a direct request inside expect', { line: 16, verb: 'POST', template: 'depot/v1/bins/bin-4/open', resolved: true }),
  ]);
});

test('Helper request evidence AC-4: a URL const resolves in its own file, then through a named import, then by its one repository value', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/scope.spec.ts';
  const templates = (title) => requestsOf(facts, spec, title).map((candidate) => [candidate.template, candidate.resolved]);
  assert.deepEqual(templates('each client reads the base of its own file'), [
    ['depot/v1/shelves/count', true],
    ['depot/v1/bins/${id}/open', true],
  ]);
  assert.deepEqual(templates('an imported const reads the value of the file that exports it'), [
    ['depot/v1/ledger/entries', true],
    ['depot/v9/archive/pages', true],
  ]);
  assert.deepEqual(templates('a name with two values and a name with one'), [
    ['depot/v1/zones/north/lamps', true],
    ['depot/v1/zones/south/lamps', true],
    ['${area}/doors', false],
    ['depot/v1/docks/bays', true],
  ]);
});

test('Helper request evidence AC-5: a followed fact carries receiver and chain from the test call, and every reader takes it', (t) => {
  const { dir, facts } = extractDepot(t);
  const requests = facts.filter((candidate) => candidate.type === 'pw_request');
  for (const candidate of requests.filter((each) => each.via)) {
    assert.ok(Array.isArray(candidate.chain) && candidate.chain.length > 0, JSON.stringify(candidate));
    for (const entry of candidate.chain) {
      assert.deepEqual(Object.keys(entry).sort(), ['call', 'file', 'line']);
      assert.equal(typeof entry.file, 'string');
      assert.equal(typeof entry.line, 'number');
      assert.equal(typeof entry.call, 'string');
    }
    assert.equal(candidate.chain[0].file, candidate.file);
    assert.equal(candidate.chain[0].line, candidate.line);
    for (const field of ['spec', 'test', 'verb', 'template']) assert.equal(typeof candidate[field], 'string');
    assert.equal(typeof candidate.resolved, 'boolean');
    if (candidate.reason) assert.equal(candidate.receiver, undefined);
  }
  const spec = 'tests/audit.spec.ts';
  assert.deepEqual(requestsOf(facts, spec, 'a request in a top-level helper function'), [
    request(spec, 'a request in a top-level helper function', {
      line: 6,
      verb: 'POST',
      template: 'depot/v1/audit/${id}',
      resolved: true,
      via: 'helper',
      chain: [link(spec, 6, 'stampAudit'), link('helpers/audit.ts', 4, 'request.post')],
    }),
  ]);
  assert.deepEqual(requestsOf(facts, spec, 'a client method named after a verb'), [
    request(spec, 'a client method named after a verb', {
      line: 11,
      verb: 'DELETE',
      template: 'depot/v2/crates/${id}',
      resolved: true,
      via: 'helper',
      receiver: 'CrateClient',
      chain: [link(spec, 11, 'crates.delete'), link('clients/crate-client.ts', 13, 'this.ctx.delete')],
    }),
  ]);

  const schema = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8');
  for (const field of ['receiver', 'chain', 'reason']) assert.match(schema, new RegExp(`\`${field}\``), field);

  const covered = runCli(['cover', '--area', 'lantern.area.txt', '--json', '--config', CONFIG], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  const routes = new Map(JSON.parse(covered.stdout).routes.map((route) => [route.key, route]));
  const expected = {
    'PUT depot/v1/shelves/*': ['tidies a shelf through two helpers'],
    'DELETE depot/v1/shelves/*': ['tidies a shelf through two helpers'],
    'POST depot/v1/audit/*': ['a request in a top-level helper function'],
    'DELETE depot/v2/crates/*': ['a client method named after a verb', 'four bodies reach the request'],
    'POST depot/v2/crates/*/close': [],
  };
  for (const [key, titles] of Object.entries(expected)) {
    const route = routes.get(key);
    assert.ok(route, key);
    assert.deepEqual(route.evidence.tests.map((entry) => entry.test).sort(), titles, key);
    assert.equal(route.evidence.executing, titles.length, key);
  }
  const closeFacts = requests.filter((candidate) => candidate.verb === 'POST' && candidate.template === 'depot/v1/bins/${id}/close');
  assert.equal(routes.get('POST depot/v1/bins/*/close').evidence.intercepts, closeFacts.length);

  const index = requestIndex([{ facts }]);
  assert.deepEqual(index.get(`PUT ${normaliseTemplate('depot/v1/shelves/${id}')}`), [
    { spec: 'tests/shelves.spec.ts', line: 8, via: 'helper' },
  ]);

  writeFileSync(join(dir, 'depot.areas.txt'), 'depot,depot/**\n');
  const ready = runCli(['readiness', '--areas', 'depot.areas.txt', '--json', '--config', CONFIG], { cwd: dir });
  assert.equal(ready.status, 0, ready.stderr);
  JSON.parse(ready.stdout);

  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  appendFileSync(join(dir, 'backend', 'src', 'Controllers', 'CrateController.cs'), '// a changed line\n');
  const hit = runCli(['affected', '--area', 'lantern.area.txt', '--json', '--config', CONFIG], { cwd: dir });
  assert.equal(hit.status, 0, hit.stderr);
  const specs = JSON.parse(hit.stdout).specs.map((row) => row.spec).sort();
  assert.deepEqual(specs, ['tests/audit.spec.ts', 'tests/depth.spec.ts']);
});

test('Helper request evidence AC-6: a helper that stubs a route is never entered and gives no request', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/stub.spec.ts';
  assert.deepEqual(requestsOf(facts, spec, 'a stub helper is not a request'), []);
  assert.deepEqual(
    requestsOf(facts, spec, 'a chain through a stub helper stops there').map((candidate) => candidate.chain.map((entry) => entry.call)),
    [['shelves.count', 'this.ctx.get']],
  );
  const now = captureFacts(join(REPO_ROOT, 'bin', 'flowtrace.js'));
  for (const name of Object.keys(BASE_FACTS)) {
    const stubs = (set) => set.filter((candidate) => candidate.type === 'pw_stub');
    assert.deepEqual(stubs(asEarlierFacts(now[name])), stubs(BASE_FACTS[name]), name);
  }
});

test('Helper request evidence AC-7: a receiver two client classes could be stays one unresolved fact and names neither template', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/ambiguous.spec.ts';
  const unresolved = (line, chain) => ({
    line,
    verb: 'ANY',
    template: '${holder.close(...)}',
    resolved: false,
    via: 'helper',
    reason: 'ambiguous-receiver',
    chain,
  });
  assert.deepEqual(requestsOf(facts, spec, 'an untyped receiver inside a helper'), [
    request(spec, 'an untyped receiver inside a helper', unresolved(5, [link(spec, 5, 'closeAny'), link('helpers/ambiguous.ts', 2, 'holder.close')])),
  ]);
  assert.deepEqual(requestsOf(facts, spec, 'an untyped receiver in the test body'), [
    request(spec, 'an untyped receiver in the test body', unresolved(10, [link(spec, 10, 'holder.close')])),
  ]);
  // One client defines `delete`, but an untyped receiver of a verb can be the request
  // fixture itself, so the call has two readings and names neither.
  assert.deepEqual(requestsOf(facts, spec, 'a verb name on an untyped receiver'), [
    request(spec, 'a verb name on an untyped receiver', {
      ...unresolved(14, [link(spec, 14, 'dropAny'), link('helpers/ambiguous.ts', 6, 'holder.delete')]),
      template: '${holder.delete(...)}',
    }),
  ]);
  const named = facts.filter(
    (candidate) => candidate.type === 'pw_request' && candidate.spec === spec && /depot\/v1\/bins|depot\/v2\/crates/.test(candidate.template),
  );
  assert.deepEqual(named, []);
});

test('Helper request evidence AC-8: four bodies resolve, a fifth is one depth-bound fact, and a cycle ends', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/depth.spec.ts';
  const deep = 'helpers/deep.ts';
  assert.deepEqual(requestsOf(facts, spec, 'four bodies reach the request'), [
    request(spec, 'four bodies reach the request', {
      line: 8,
      verb: 'DELETE',
      template: 'depot/v2/crates/${id}',
      resolved: true,
      via: 'helper',
      receiver: 'CrateClient',
      chain: [
        link(spec, 8, 'levelOne'),
        link(deep, 8, 'levelTwo'),
        link(deep, 12, 'levelThree'),
        link(deep, 16, 'crates.delete'),
        link('clients/crate-client.ts', 13, 'this.ctx.delete'),
      ],
    }),
  ]);
  assert.deepEqual(requestsOf(facts, spec, 'a fifth body is past the bound'), [
    request(spec, 'a fifth body is past the bound', {
      line: 12,
      verb: 'ANY',
      template: '${crates.delete(...)}',
      resolved: false,
      via: 'helper',
      reason: 'depth-bound',
      chain: [
        link(spec, 12, 'levelZero'),
        link(deep, 4, 'levelOne'),
        link(deep, 8, 'levelTwo'),
        link(deep, 12, 'levelThree'),
        link(deep, 16, 'crates.delete'),
      ],
    }),
  ]);
  assert.deepEqual(
    requestsOf(facts, spec, 'two helpers that call each other').map((candidate) => candidate.chain.map((entry) => entry.call)),
    [['pingSouth', 'pingNorth', 'bins.open', 'this.ctx.post']],
  );
  assert.deepEqual(
    requestsOf(facts, spec, 'a test after the cycle').map((candidate) => `${candidate.verb} ${candidate.template}`),
    ['PUT depot/v1/bins/${id}/label'],
  );
});

// Facts a rule of the helper traversal adds to the corpora the base already read, by corpus.
// None of them makes a request through a helper or inside an expect argument today.
const ADDED_FACTS = {};

function withoutAdded(facts, added = []) {
  const listed = new Set(added.map((candidate) => JSON.stringify(candidate)));
  return facts.filter((candidate) => !listed.has(JSON.stringify(candidate)));
}

test('Helper request evidence AC-9: a direct request keeps its base shape, and the other corpora keep their base facts', (t) => {
  const { facts } = extractDepot(t);
  const spec = 'tests/direct.spec.ts';
  assert.deepEqual(requestsOf(facts, spec, 'a direct request in the test body'), [
    request(spec, 'a direct request in the test body', { line: 4, verb: 'GET', template: 'depot/v1/shelves/count', resolved: true }),
  ]);
  const now = captureFacts(join(REPO_ROOT, 'bin', 'flowtrace.js'));
  assert.deepEqual(Object.keys(now), Object.keys(BASE_FACTS));
  for (const name of Object.keys(BASE_FACTS)) {
    assert.deepEqual(withoutAdded(asEarlierFacts(now[name]), ADDED_FACTS[name]), BASE_FACTS[name], name);
  }
});
