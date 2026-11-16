/**
 * Route chains: `chains "<route key>"` over the kite-club corpus, every fact-backed path from
 * a web or mobile screen down to one backend route, each break a named gap, and the same
 * entry and request pairs as the forward component walk.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { callersOf } from '../lib/span.js';
import { REPO_ROOT, runCli } from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'kite-club');
const CONFIG = 'kite.config.json';
const ROUTE = 'POST clubs/v1/join/{id}';
const ROUTE_KEY = 'POST clubs/v1/join/*';
const GAP_REASONS = [
  'template-not-resolved',
  'entry-unresolved',
  'no-entry',
  'no-caller',
  'component-ambiguous',
  'page-ambiguous',
  'no-page',
  'walk-limit',
];
const HOP_KINDS = ['page', 'render', 'entry', 'call', 'dispatch', 'bind', 'effect', 'request', 'gap'];

const made = [];
let pack = '';
let base = null;

function copy(mutate = null) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-chains-'));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  if (mutate) mutate(dir);
  const extracted = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  return dir;
}

function rewrite(dir, file, change) {
  const target = join(dir, file);
  writeFileSync(target, change(readFileSync(target, 'utf8')));
}

function chains(dir, args = [], key = ROUTE) {
  return runCli(['chains', key, '--config', CONFIG, ...args], { cwd: dir });
}

function chainsJson(dir, args = [], key = ROUTE) {
  const result = chains(dir, ['--json', ...args], key);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function kinds(chain) {
  return chain.hops.map((hop) => hop.kind);
}

function byEntry(model, component, trigger = null) {
  return model.chains.filter(
    (chain) => chain.entry && chain.entry.component === component && (trigger === null || chain.entry.trigger === trigger),
  );
}

function withRender(model, from, to) {
  return model.chains.filter((chain) => chain.hops.some((hop) => hop.kind === 'render' && hop.from === from && hop.to === to));
}

function one(list, label) {
  assert.equal(list.length, 1, `${label}: ${list.length} chains`);
  return list[0];
}

function factSets(dir) {
  const factsDir = join(dir, 'out', 'facts');
  return readdirSync(factsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(factsDir, name), 'utf8')));
}

before(() => {
  pack = copy();
  base = chainsJson(pack);
});

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test('Route chains AC-1: the web thunk chain and the mobile effect chain run from page to request', () => {
  for (const chain of base.chains) {
    for (const hop of chain.hops) {
      assert.ok(HOP_KINDS.includes(hop.kind), hop.kind);
      assert.ok(typeof hop.repo === 'string' && hop.repo !== '', JSON.stringify(hop));
      assert.ok(typeof hop.file === 'string' && hop.file !== '', JSON.stringify(hop));
      assert.ok(Number.isInteger(hop.line), JSON.stringify(hop));
      if (hop.kind === 'gap') assert.equal(hop.fact, null);
      else assert.ok(typeof hop.fact === 'string' && hop.fact !== '', JSON.stringify(hop));
    }
  }

  const web = one(byEntry(base, 'ClubFeed'), 'ClubFeed');
  assert.equal(web.repo, 'web');
  assert.equal(web.complete, true);
  assert.deepEqual(kinds(web), ['page', 'render', 'entry', 'dispatch', 'bind', 'effect', 'request']);
  assert.deepEqual(
    web.hops.map((hop) => [hop.fact, `${hop.file}:${hop.line}`]),
    [
      ['page_route', 'src/app.tsx:12'],
      ['renders', 'src/app.tsx:12'],
      ['template_handler', 'src/clubs/ClubFeed.tsx:21'],
      ['action_dispatch', 'src/clubs/ClubFeed.tsx:15'],
      ['props_bind', 'src/clubs/ClubFeed.tsx:33'],
      ['effect_handler', 'src/actions/clubs.ts:6'],
      ['gateway_call', 'src/actions/clubs.ts:8'],
    ],
  );
  assert.equal(web.entry.trigger, 'onClick');
  assert.equal(web.entry.handler, 'handleJoin');

  const mobile = one(byEntry(base, 'ClubAboutPage'), 'ClubAboutPage');
  assert.equal(mobile.repo, 'mobile');
  assert.equal(mobile.complete, true);
  assert.deepEqual(kinds(mobile), ['page', 'entry', 'dispatch', 'effect', 'call', 'request']);
  assert.deepEqual(
    mobile.hops.map((hop) => [hop.fact, `${hop.file}:${hop.line}`]),
    [
      ['component', 'src/app/features/clubs/club-about.page.ts:5'],
      ['template_handler', 'src/app/features/clubs/club-about.page.html:2'],
      ['action_dispatch', 'src/app/features/clubs/club-about.page.ts:15'],
      ['effect_handler', 'src/app/features/clubs/club.effects.ts:11'],
      ['method_call', 'src/app/features/clubs/club.effects.ts:12'],
      ['gateway_call', 'src/app/features/clubs/club.service.ts:9'],
    ],
  );
  assert.equal(mobile.hops[3].ref, 'ClubEffects.joinClub$');
  assert.equal(mobile.hops[4].calledMethod, 'join');

  const text = chains(pack);
  assert.equal(text.status, 0, text.stderr);
  for (const chain of [web, mobile]) {
    for (const hop of chain.hops) {
      const line = text.stdout
        .split('\n')
        .find((candidate) => candidate.includes(`${hop.file}:${hop.line}`) && candidate.includes(hop.fact) && candidate.includes(hop.repo));
      assert.ok(line, `text output holds ${hop.kind} ${hop.fact} ${hop.file}:${hop.line}`);
    }
  }
});

test('Route chains AC-2: a page comes from the route element, the route range or the Ionic page', () => {
  const joinPage = byEntry(base, 'JoinPage');
  assert.equal(joinPage.length, 1, 'the thunk call and its dispatch are one chain');
  assert.deepEqual(kinds(joinPage[0]), ['page', 'entry', 'dispatch', 'effect', 'request']);
  for (const chain of joinPage) {
    assert.equal(chain.complete, true);
    assert.equal(chain.page.fact, 'page_route');
    assert.equal(chain.page.path, 'join');
    assert.equal(`${chain.page.file}:${chain.page.line}`, 'src/app.tsx:11');
    assert.equal(chain.hops[1].kind, 'entry');
    assert.equal(chain.entry.trigger, 'useEffect');
  }

  const feed = one(byEntry(base, 'ClubFeed'), 'ClubFeed');
  assert.equal(feed.page.path, 'clubs/:clubId/*');
  assert.deepEqual(feed.page.paths, [{ path: '/kites/clubs/:clubId/*', host: 'declared' }]);
  assert.equal(feed.hops[1].from, 'App');
  assert.equal(feed.hops[1].to, 'ClubFeed');

  const about = one(byEntry(base, 'ClubAboutPage'), 'ClubAboutPage');
  assert.equal(about.page.fact, 'component');
  assert.equal(about.page.component, 'ClubAboutPage');

  const chip = one(byEntry(base, 'JoinChipComponent'), 'JoinChipComponent');
  assert.deepEqual(kinds(chip), ['page', 'render', 'entry', 'call', 'request']);
  assert.equal(chip.page.component, 'ClubAboutPage');
  assert.equal(chip.hops[1].to, 'app-join-chip');

  const invite = one(byEntry(base, 'ClubInvitePage'), 'ClubInvitePage');
  assert.equal(invite.entry.trigger, 'ionViewDidEnter');
  assert.equal(invite.hops[1].fact, 'method_span');
  assert.equal(invite.page.component, 'ClubInvitePage');

  const dir = copy((root) =>
    rewrite(root, 'web/src/app.tsx', (text) =>
      text.replace(
        '      <Route path="clubs/:clubId/*" element={<Shell main={<ClubFeed />} side={<ClubSidebar />} />} />',
        '      <Route path="clubs/:clubId/*" element={<Shell main={<ClubFeed />} side={null} />} /><Route path="feed/:clubId" element={<Shell main={<ClubFeed />} side={null} />} />',
      ),
    ),
  );
  const variant = chainsJson(dir);
  const ambiguous = variant.chains.filter((chain) => chain.hops[0].reason === 'page-ambiguous');
  assert.ok(ambiguous.length > 0, 'a render two routes of one range hold is page-ambiguous');
  for (const chain of ambiguous) {
    assert.equal(chain.page, null);
    assert.equal(chain.hops[0].ref, 'App -> ClubFeed');
    assert.deepEqual(chain.hops[0].candidates, ['src/app.tsx:12:7', 'src/app.tsx:12:91']);
  }
});

test('Route chains AC-3: each break is one gap from the closed list', () => {
  const sidebar = one(
    base.chains.filter((chain) => chain.hops.some((hop) => hop.kind === 'gap' && hop.component === 'ClubSidebar')),
    'ClubSidebar',
  );
  assert.deepEqual(sidebar.gaps, ['no-entry']);
  assert.equal(sidebar.page.path, 'clubs/:clubId/*');
  assert.deepEqual(kinds(sidebar), ['page', 'render', 'gap', 'dispatch', 'bind', 'effect', 'request']);

  const badge = base.chains.filter((chain) => chain.hops.some((hop) => hop.file === 'src/legacy/Badge.tsx'));
  assert.equal(badge.length, 1, 'the thunk call and its dispatch are one chain');
  for (const chain of badge) {
    assert.deepEqual(kinds(chain).slice(2), ['dispatch', 'effect', 'request']);
    assert.deepEqual(chain.gaps, ['component-ambiguous', 'no-entry']);
    assert.equal(chain.hops[0].reason, 'component-ambiguous');
    assert.deepEqual(chain.hops[0].candidates, ['src/cards/Badge.tsx', 'src/legacy/Badge.tsx']);
    assert.equal(`${chain.hops[0].file}:${chain.hops[0].line}`, 'src/clubs/ClubFeed.tsx:27');
  }
  assert.equal(base.chains.some((chain) => chain.hops.some((hop) => hop.file === 'src/cards/Badge.tsx')), false);

  const orphan = base.chains.filter((chain) => chain.hops.some((hop) => hop.file === 'src/clubs/OrphanNotice.tsx'));
  assert.equal(orphan.length, 1);
  for (const chain of orphan) {
    assert.deepEqual(kinds(chain).slice(2), ['dispatch', 'effect', 'request']);
    assert.deepEqual(chain.gaps, ['no-page', 'no-entry']);
    assert.equal(chain.hops[0].component, 'OrphanNotice');
  }

  const legacy = one(base.chains.filter((chain) => chain.request.file === 'src/api/legacy.ts'), 'legacyJoin');
  assert.deepEqual(legacy.gaps, ['no-caller']);
  assert.deepEqual(kinds(legacy), ['gap', 'request']);

  const unresolved = copy((root) => {
    const factsBefore = join(root, 'web', 'src', 'actions', 'clubs.ts');
    assert.ok(readFileSync(factsBefore, 'utf8').includes('joinClub'));
  });
  const factsFile = join(unresolved, 'out', 'facts', 'web.json');
  const document = JSON.parse(readFileSync(factsFile, 'utf8'));
  const thunkCall = document.facts.find((fact) => fact.type === 'gateway_call' && fact.file === 'src/actions/clubs.ts');
  thunkCall.resolved = false;
  writeFileSync(factsFile, `${JSON.stringify(document, null, 2)}\n`);
  const notResolved = chainsJson(unresolved);
  const feed = one(byEntry(notResolved, 'ClubFeed'), 'ClubFeed with resolved: false');
  assert.deepEqual(feed.gaps, ['template-not-resolved']);
  assert.equal(feed.page.path, 'clubs/:clubId/*');
  assert.equal(feed.hops[feed.hops.length - 2].reason, 'template-not-resolved');

  const twoRunJoins = copy((root) => {
    rewrite(root, 'web/src/join/JoinPage.tsx', (text) =>
      text
        .replace("import { joinClub } from '../actions/clubs';", "import { runJoin } from '../actions/runJoin';")
        .replace("  useEffect(() => {\n    dispatch(joinClub('welcome'));\n  }, [dispatch]);", '  useEffect(runJoin, [dispatch]);'),
    );
    writeFileSync(
      join(root, 'web', 'src', 'actions', 'runJoin.ts'),
      "import { joinClub } from './clubs';\n\nexport function runJoin() {\n  joinClub('welcome');\n}\n",
    );
    writeFileSync(join(root, 'web', 'src', 'legacy', 'runJoin.ts'), 'export function runJoin() {\n  return null;\n}\n');
  });
  const entryGap = chainsJson(twoRunJoins);
  const ambiguousEntry = one(
    entryGap.chains.filter((chain) => chain.gaps.includes('entry-unresolved')),
    'entry-unresolved',
  );
  assert.deepEqual(ambiguousEntry.gaps, ['entry-unresolved']);
  assert.equal(ambiguousEntry.page.path, 'join');
  const gapHop = ambiguousEntry.hops.find((hop) => hop.reason === 'entry-unresolved');
  assert.equal(gapHop.cause, 'no-target');
  assert.deepEqual(gapHop.candidates, ['src/actions/runJoin.ts:3', 'src/legacy/runJoin.ts:1']);

  const help = runCli(['--help']);
  const section = help.stdout.slice(help.stdout.indexOf('chains "<route key>"'));
  for (const reason of GAP_REASONS) assert.match(section, new RegExp(`\\n    ${reason} `), reason);
  for (const model of [base, notResolved, entryGap]) {
    for (const chain of model.chains) {
      for (const reason of chain.gaps) assert.ok(GAP_REASONS.includes(reason), reason);
    }
    assert.deepEqual(Object.keys(model.counts.gaps), GAP_REASONS);
  }
});

test('Route chains AC-4: render variants from one page to one entry print one chain', () => {
  const button = one(byEntry(base, 'JoinButton'), 'JoinButton');
  assert.equal(button.variants, 3);
  assert.deepEqual(
    button.hops.filter((hop) => hop.kind === 'render').map((hop) => `${hop.from} -> ${hop.to} ${hop.file}:${hop.line}`),
    ['App -> ClubFeed src/app.tsx:12', 'ClubFeed -> JoinButton src/clubs/ClubFeed.tsx:24'],
  );
  assert.equal(withRender(base, 'Panel', 'JoinButton').length, 0);
  for (const chain of base.chains) {
    if (chain !== button) assert.equal(chain.variants, 1);
  }
});

test('Route chains AC-5: only the app callers of the route start a chain', () => {
  const sets = factSets(pack);
  const expected = callersOf(sets, ROUTE_KEY, []).map((caller) => `${caller.repo}|${caller.file}:${caller.line}`);
  assert.deepEqual(expected, ['mobile|src/app/features/clubs/club.service.ts:9', 'web|src/actions/clubs.ts:8', 'web|src/api/legacy.ts:4']);
  const starts = [...new Set(base.chains.map((chain) => `${chain.repo}|${chain.request.file}:${chain.request.line}`))].sort();
  assert.deepEqual(starts, expected);
  assert.equal(base.counts.callers, expected.length);
  for (const chain of base.chains) {
    assert.ok(chain.repo === 'web' || chain.repo === 'mobile', chain.repo);
    assert.equal(chain.hops[chain.hops.length - 1].fact, 'gateway_call');
    assert.ok(!chain.request.file.includes('cypress') && !chain.request.file.endsWith('.cy.ts'));
  }
  assert.ok(sets.some((set) => set.facts.some((fact) => fact.type === 'cypress_intercept')), 'the Cypress intercept is in the facts');
  assert.ok(sets.some((set) => set.facts.some((fact) => fact.type === 'pw_request')), 'the Playwright request is in the facts');

  const normal = chains(pack, ['--json'], ROUTE_KEY);
  const braced = chains(pack, ['--json'], ROUTE);
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(normal.stdout, braced.stdout);
});

/** The (entry id, request site) pairs `span --from-component` resolves to the route. */
function forwardPairs(dir, extra) {
  const pairs = new Set();
  for (const set of factSets(dir)) {
    if (set.kind !== 'web' && set.kind !== 'mobile') continue;
    const declarations = set.facts.filter((fact) => fact.type === 'component' && fact.role !== 'service');
    for (const declaration of declarations) {
      const shared = declarations.filter((fact) => fact.name === declaration.name).length > 1;
      const args = ['span', '--from-component', declaration.name, '--repo', set.repo, '--json', '--config', CONFIG, ...extra];
      if (shared) args.push('--file', declaration.file);
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 0, `${declaration.name}: ${result.stderr}`);
      const page = JSON.parse(result.stdout);
      const own = new Set(page.entries.filter((view) => view.identity.component === declaration.name).map((view) => view.identity.id));
      for (const route of page.routes) {
        if (route.key !== ROUTE_KEY) continue;
        for (const arm of route.arms) {
          if (arm.entry !== null && own.has(arm.entry)) pairs.add(`${arm.entry}|${arm.file}:${arm.line}`);
        }
      }
    }
  }
  return [...pairs].sort();
}

function backwardPairs(model) {
  return [
    ...new Set(model.chains.filter((chain) => chain.complete).map((chain) => `${chain.entry.id}|${chain.request.file}:${chain.request.line}`)),
  ].sort();
}

test('Route chains AC-6: the chains without a gap name the arms of the forward walk', () => {
  const pairs = forwardPairs(pack, []);
  assert.ok(pairs.length >= 6, pairs.join('\n'));
  assert.deepEqual(backwardPairs(base), pairs);

  const shallow = chainsJson(pack, ['--depth', '3']);
  const shallowPairs = forwardPairs(pack, ['--depth', '3']);
  assert.deepEqual(backwardPairs(shallow), shallowPairs);
  assert.ok(shallowPairs.length < pairs.length, 'depth 3 drops arms on both sides');
});

test('Route chains AC-7: a key that is not exactly one route exits 2 with one reason', () => {
  const cases = [
    ['POST clubs/v1/nowhere', 'no-declaration'],
    ['GET clubs/v1/health', 'ambiguous'],
    ['ClubService', 'not-a-route'],
    ['/kites/join', 'not-a-route'],
  ];
  for (const [key, reason] of cases) {
    const text = chains(pack, [], key);
    assert.equal(text.status, 2, `${key}: ${text.stderr}`);
    assert.equal(text.stdout, '');
    const reasons = text.stderr.split('\n').filter((line) => line.startsWith('reason:'));
    assert.deepEqual(reasons, [`reason: ${reason}`], key);

    const json = chains(pack, ['--json'], key);
    assert.equal(json.status, 2, key);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.reason, reason);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.chains, undefined);
    assert.deepEqual(json.stderr.split('\n').filter((line) => line.startsWith('reason:')), [`reason: ${reason}`]);
  }

  const none = chains(pack, [], 'DELETE clubs/v1/{id}');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout.split('\n')[0], /^chains DELETE clubs\/v1\/\*: 0 chains, 0 without a gap, from 0 callers$/);
  const noneJson = chainsJson(pack, [], 'DELETE clubs/v1/{id}');
  assert.deepEqual(noneJson.chains, []);
});

test('Route chains AC-8: the JSON document is versioned and the same bytes on every run', () => {
  const first = chains(pack, ['--json']);
  const second = chains(pack, ['--json']);
  assert.equal(first.stdout, second.stdout);
  const elsewhere = chains(copy(), ['--json']);
  assert.equal(elsewhere.stdout, first.stdout);
  assert.doesNotMatch(first.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.equal(first.stdout.includes(pack), false);

  assert.deepEqual(Object.keys(base), ['schemaVersion', 'route', 'status', 'counts', 'chains']);
  assert.equal(base.schemaVersion, 1);
  assert.deepEqual(base.route, {
    key: ROUTE_KEY,
    verb: 'POST',
    path: 'clubs/v1/join/{id}',
    controller: 'ClubsController',
    action: 'Join',
    repo: 'api',
    file: 'src/Controllers/ClubsController.cs',
    line: 9,
  });
  assert.equal(base.status.schemaVersion, 1);
  assert.equal(base.status.scope.mode, 'to-pages');
  const counts = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(readFileSync(join(FIXTURE, 'README.md'), 'utf8'))[1]);
  for (const [field, value] of Object.entries(counts)) assert.equal(base.counts[field], value, field);
  for (const chain of base.chains) {
    assert.deepEqual(Object.keys(chain), ['repo', 'complete', 'variants', 'gaps', 'page', 'entry', 'request', 'hops']);
    assert.deepEqual(chain.gaps, chain.hops.filter((hop) => hop.kind === 'gap').map((hop) => hop.reason));
  }
});

test('Route chains AC-9: the depth and node limits state a partial walk and raise with their flags', () => {
  const shallow = chainsJson(pack, ['--depth', '1']);
  assert.equal(shallow.status.traversal, 'partial');
  assert.ok(shallow.status.stops.depth > 0);
  const cut = shallow.chains.filter((chain) => chain.hops[0].reason === 'walk-limit');
  assert.ok(cut.length > 0);
  for (const chain of cut) assert.equal(chain.hops[0].cause, 'depth');
  assert.ok(shallow.status.frontier.every((entry) => entry.raisedBy === '--depth'));
  assert.equal(chainsJson(pack, ['--depth', '8']).status.traversal, 'complete');
  assert.equal(base.status.traversal, 'complete');

  const budget = chainsJson(pack, ['--max-nodes', '2']);
  assert.equal(budget.status.traversal, 'partial');
  assert.ok(budget.status.stops['node-budget'] > 0);
  assert.ok(budget.chains.some((chain) => chain.hops[0].cause === 'node-budget'));
  assert.equal(chainsJson(pack, ['--max-nodes', '100000']).status.traversal, 'complete');

  const plain = chains(pack, ['--depth', '1']);
  const strict = chains(pack, ['--depth', '1', '--require-complete']);
  assert.equal(strict.status, 4);
  assert.equal(strict.stdout, plain.stdout);
  assert.match(strict.stderr, /^flowtrace: not complete: depth \d+ \(raise --depth\)$/m);
  const refused = chains(pack, ['--require-complete', '--depth', '1'], 'POST clubs/v1/nowhere');
  assert.equal(refused.status, 2);

  const git = mkdtempSync(join(tmpdir(), 'flowtrace-chains-git-'));
  made.push(git);
  cpSync(FIXTURE, git, { recursive: true });
  writeFileSync(join(git, '.gitignore'), 'out/\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'selftest@example.invalid'],
    ['config', 'user.name', 'flowtrace selftest'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'initial'],
  ]) {
    assert.equal(spawnSync('git', args, { cwd: git, encoding: 'utf8' }).status, 0);
  }
  assert.equal(runCli(['extract', '--config', CONFIG], { cwd: git }).status, 0);
  const fresh = chains(git, ['--require-complete']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /status: traversal complete, freshness matching/);
});

test('Route chains AC-10: the help, the CLI reference and the corpus list name the verb', () => {
  const help = runCli(['--help']).stdout;
  assert.match(help, /\n {2}chains {4}list every fact-backed path/);
  const start = help.indexOf('chains "<route key>" [--json] [--depth N] [--max-nodes N] [--require-complete]');
  assert.ok(start > 0, 'the chains section');
  const section = help.slice(start, help.indexOf('\nsurface "<route key>"'));
  for (const option of ['--json', '--depth', '--max-nodes', '--require-complete']) assert.ok(section.includes(option), option);
  for (const kind of HOP_KINDS) assert.match(section, new RegExp(`\\b${kind}\\b`), kind);
  for (const reason of GAP_REASONS) assert.ok(section.includes(reason), reason);
  assert.match(section, /Exit 0/);
  assert.match(section, /exits 2/);
  assert.match(section, /exits 4/);
  assert.match(help, /--require-complete \(trace, trace --area, span, span --from-component and chains\)/);

  const docs = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'docs-check.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
  assert.ok(readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').includes('chains "<route key>"'));
  assert.ok(readFileSync(join(REPO_ROOT, 'selftest', 'README.md'), 'utf8').includes('corpus/kite-club/'));
});
