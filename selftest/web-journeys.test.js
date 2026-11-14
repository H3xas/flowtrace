/**
 * Web journeys: a web or Ionic screen reaches its routes and its page in `trace`,
 * `span --from-component` and `chains`, over the regatta-desk corpus and kite-club.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { trace } from '../lib/trace.js';
import { REPO_ROOT, runCli } from './helpers.js';

const CORPUS = join(REPO_ROOT, 'selftest', 'corpus');

const made = [];
const extracted = new Map();

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A disposable extracted copy of one corpus, shared by the tests that only read it. */
function fixture(name, config, mutate = null) {
  const key = `${name}|${config}`;
  if (!mutate && extracted.has(key)) return extracted.get(key);
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-journeys-'));
  made.push(dir);
  cpSync(join(CORPUS, name), dir, { recursive: true });
  if (mutate) mutate(dir);
  const result = runCli(['extract', '--config', config], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  if (!mutate) extracted.set(key, dir);
  return dir;
}

function rewrite(dir, file, change) {
  const target = join(dir, file);
  writeFileSync(target, change(readFileSync(target, 'utf8')));
}

function cli(dir, config, args) {
  return runCli([...args, '--config', config], { cwd: dir });
}

function json(dir, config, args) {
  const result = cli(dir, config, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const KITE = ['kite-club', 'kite.config.json'];

test('Web journeys AC-13: one thunk statement prints one chain, in the dispatch form', () => {
  const dir = fixture(...KITE);
  const model = json(dir, KITE[1], ['chains', 'POST clubs/v1/join/{id}']);
  assert.deepEqual(
    { callers: model.counts.callers, chains: model.counts.chains, complete: model.counts.complete, withGap: model.counts.withGap },
    { callers: 3, chains: 10, complete: 6, withGap: 4 },
  );
  for (const site of ['src/join/JoinPage.tsx:9', 'src/legacy/Badge.tsx:7', 'src/clubs/OrphanNotice.tsx:7']) {
    const through = model.chains.filter((chain) => chain.hops.some((hop) => `${hop.file}:${hop.line}` === site));
    assert.equal(through.length, 1, site);
    const kinds = through[0].hops.map((hop) => `${hop.kind} ${hop.fact}`);
    const at = kinds.indexOf('dispatch action_dispatch');
    assert.ok(at >= 0, `${site}: ${kinds.join(', ')}`);
    assert.equal(kinds[at + 1], 'effect effect_handler', site);
    assert.equal(kinds.includes('call method_call'), false, site);
  }
  const pairs = [...new Set(model.chains.map((chain) => `${chain.entry ? chain.entry.id : '-'}|${chain.request.file}:${chain.request.line}`))].sort();
  assert.deepEqual(pairs, [
    '-|src/actions/clubs.ts:8',
    '-|src/api/legacy.ts:4',
    'ClubAboutPage:event:click:onJoin:@src/app/features/clubs/club-about.page.html:2|src/app/features/clubs/club.service.ts:9',
    'ClubFeed:event:onClick:handleJoin:@src/clubs/ClubFeed.tsx:21:31|src/actions/clubs.ts:8',
    'ClubInvitePage:mount:ionViewDidEnter:@src/app/features/clubs/club-invite.page.ts:13|src/app/features/clubs/club.service.ts:9',
    'JoinButton:event:onClick:joinClub:@src/clubs/JoinButton.tsx:12:29|src/actions/clubs.ts:8',
    'JoinChipComponent:event:click:onJoin:@src/app/features/clubs/join-chip.component.html:1|src/app/features/clubs/club.service.ts:9',
    'JoinPage:effect:useEffect:@src/join/JoinPage.tsx:8:3|src/actions/clubs.ts:8',
  ]);
  const text = cli(dir, KITE[1], ['chains', 'POST clubs/v1/join/{id}']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^chains POST clubs\/v1\/join\/\*: 10 chains, 6 without a gap, from 3 callers$/m);
  assert.equal((text.stdout.match(/^chain \d+ of 10:/gm) || []).length, 10);

  const limited = json(dir, KITE[1], ['chains', 'POST clubs/v1/join/{id}', '--depth', '3']);
  const joinPage = limited.chains.filter((chain) => chain.hops.some((hop) => `${hop.file}:${hop.line}` === 'src/join/JoinPage.tsx:9'));
  assert.equal(joinPage.length, 1, 'the form that ran out of depth folds into the form that reached its page');
  assert.equal(joinPage[0].complete, true);
  assert.equal(limited.status.frontier.some((stop) => stop.caller.file === 'src/join/JoinPage.tsx'), false);
});

const REGATTA = ['regatta-desk', 'regatta.config.json'];
const BASE = JSON.parse(readFileSync(join(CORPUS, 'regatta-desk', 'base-capture.json'), 'utf8'));

test('Web journeys AC-11: a page-load entry prints its kind word, and its ids stay', async () => {
  const { traceNodes } = await import('./corpus/regatta-desk/golden.mjs');
  const dir = fixture(...REGATTA);
  const header = cli(dir, REGATTA[1], ['trace', 'RegattaHeader']);
  assert.equal(header.status, 0, header.stderr);
  assert.match(header.stdout, /─ mount RegattaHeader\.componentDidMount@12:3 {2}web {2}src\/regatta\/RegattaHeader\.tsx:12 {2}\[entry\]/);
  assert.match(header.stdout, /─ update RegattaHeader\.componentDidUpdate@16:3 {2}web {2}src\/regatta\/RegattaHeader\.tsx:16 {2}\[entry\]/);
  const board = cli(dir, REGATTA[1], ['trace', 'ResultsBoard']);
  assert.match(board.stdout, /─ effect ResultsBoard\.useEffect@8:3 {2}web {2}src\/results\/ResultsBoard\.tsx:8 {2}\[entry\]/);

  for (const [key, kind, site] of [
    ['GET regattas/v1/{id}', 'mount', 'src/regatta/RegattaHeader.tsx:12'],
    ['GET regattas/v1/{id}/entries', 'update', 'src/regatta/RegattaHeader.tsx:16'],
    ['GET regattas/v1/results', 'effect', 'src/results/ResultsBoard.tsx:8'],
  ]) {
    const text = cli(dir, REGATTA[1], ['chains', key]);
    assert.equal(text.status, 0, text.stderr);
    const line = text.stdout.split('\n').find((candidate) => candidate.startsWith('  entry ') && candidate.includes(site));
    assert.ok(line, `${key}: an entry line at ${site}`);
    assert.ok(line.endsWith(`  kind ${kind}`), line);
    const model = json(dir, REGATTA[1], ['chains', key]);
    const entries = (chains) => [...new Set(chains.filter((chain) => chain.entry).map((chain) => JSON.stringify(chain.entry)))].sort();
    assert.deepEqual(entries(model.chains), entries(BASE.chains[key]), key);
  }

  for (const start of ['RegattaHeader', 'ResultsBoard']) {
    const entryNodes = (nodes) => nodes.filter((node) => node.kind === 'entry');
    assert.deepEqual(entryNodes(traceNodes(json(dir, REGATTA[1], ['trace', start]))), entryNodes(BASE.trace[start]), start);
    for (const identity of BASE.span[start].entries.filter((entry) => entry.kind !== 'event')) {
      const span = json(dir, REGATTA[1], ['span', '--from-component', start, '--entry', identity.id]);
      assert.deepEqual(span.entries.map((entry) => entry.identity), [identity], identity.id);
    }
  }
});

const GROUP = '/groups/:groupId';
const CANDIDATES = [
  '  GlanceCard (page /groups/:groupId) web src/groups/GlanceCard.tsx:3 mounted at src/groups/GroupGlance.tsx:8',
  '  GroupShell (page /groups/:groupId/*) web src/groups/GroupShell.tsx:5 mounted at src/app.tsx:23',
];

/** The corpus without its root render, so no source line mounts `App`. */
function unmounted(mounts) {
  return fixture('regatta-desk', 'regatta-mounted.config.json', (dir) => {
    unlinkSync(join(dir, 'web', 'src', 'index.tsx'));
    const file = join(dir, 'regatta-mounted.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.repos.find((repo) => repo.id === 'web').mounts = mounts;
    writeFileSync(file, JSON.stringify(config));
  });
}

test('Web journeys AC-6: a declared mount beats a guessed one between route trees', () => {
  const dir = fixture(...REGATTA);
  const text = cli(dir, REGATTA[1], ['trace', GROUP]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^start: GroupShell \(page, web src\/groups\/GroupShell\.tsx:5\)$/m);
  assert.match(text.stdout, /─ mounted at \/ {2}web {2}src\/index\.tsx:8 {2}\[mount\] {2}declared$/m);
  assert.match(text.stdout, /─ route groups\/:groupId\/\* → GroupShell {2}web {2}src\/app\.tsx:23 {2}\[mount\] {2}declared$/m);
  assert.equal(text.stdout.includes('imported from'), false);
  assert.match(text.stdout, /GET groups\/v1\/\*/);
  const model = json(dir, REGATTA[1], ['trace', GROUP]);
  assert.equal(model.root.ref, 'GroupShell');
  assert.equal(model.root.mount.host.source, 'declared');
  assert.deepEqual(
    model.root.mount.chain.map((segment) => `${segment.kind} ${segment.path} ${segment.file}:${segment.line}`),
    ['route groups/:groupId/* src/app.tsx:23'],
  );

  const configured = unmounted({ App: '/' });
  const byConfig = cli(configured, 'regatta-mounted.config.json', ['trace', GROUP]);
  assert.equal(byConfig.status, 0, byConfig.stderr);
  assert.match(byConfig.stdout, /^GroupShell {2}web {2}src\/groups\/GroupShell\.tsx:5 {2}\[start\] {2}configured mount \/$/m);
  assert.match(byConfig.stdout, /─ route groups\/:groupId\/\* → GroupShell {2}web {2}src\/app\.tsx:23 {2}\[mount\] {2}declared$/m);

  const inTree = json(dir, REGATTA[1], ['trace', '/regattas/:regattaId']);
  assert.equal(inTree.root.ref, 'RegattaPage');
});

test('Web journeys AC-7: tied candidates of two route trees exit 2 with both candidates', () => {
  for (const mounts of [{}, { App: '/', GroupGlance: '/' }]) {
    const dir = unmounted(mounts);
    const text = cli(dir, 'regatta-mounted.config.json', ['trace', GROUP]);
    assert.equal(text.status, 2, JSON.stringify(mounts));
    assert.equal(text.stdout, '');
    assert.deepEqual(text.stderr.trimEnd().split('\n'), [`flowtrace: "${GROUP}" matches 2 starts:`, ...CANDIDATES, 'reason: ambiguous']);
    const envelope = cli(dir, 'regatta-mounted.config.json', ['trace', GROUP, '--json']);
    assert.equal(envelope.status, 2);
    const document = JSON.parse(envelope.stdout);
    assert.equal(document.status, 'ambiguous');
    assert.equal(document.reason, 'ambiguous');
    assert.deepEqual(document.candidates, CANDIDATES.map((line) => line.trim()));
  }
});

/** The fact sets one extracted copy wrote, as the walk reads them. */
function factSetsOf(dir) {
  const folder = join(dir, 'out', 'facts');
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
}

const routeRefs = (nodes) => nodes.filter((node) => node.kind === 'route').map((node) => `${node.ref} ${node.via}`).sort();

/** The page hops of every chain that climbs through `component`. */
function chainPages(dir, keys, component) {
  const pages = new Set();
  for (const key of keys) {
    for (const chain of json(dir, REGATTA[1], ['chains', key]).chains) {
      if (!chain.page || !chain.hops.some((hop) => hop.component === component || hop.to === component || hop.class === component)) continue;
      for (const entry of chain.page.paths) pages.add(`page ${entry.path} ${chain.page.file}:${chain.page.line} ${entry.host}`);
    }
  }
  return [...pages].sort();
}

test('Web journeys AC-8: a component start lists its pages as mount hops', () => {
  const dir = fixture(...REGATTA);
  for (const [component, keys, page] of [
    ['CrewRoster', ['GET crews/v1/{id}'], 'page /crews/:crewId src/app.tsx:19 declared'],
    ['SignupPanel', ['GET crews/v1/signups'], 'page /crews/:crewId src/app.tsx:19 declared'],
    ['BoatList', ['POST boats/v1/{id}/pick'], 'page /boats src/app.tsx:20 declared'],
    ['BoatRow', ['POST boats/v1/{id}/inspect'], 'page /boats src/app.tsx:20 declared'],
  ]) {
    const [path, site, host] = page.slice('page '.length).split(' ');
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`─ page ${path}  web  ${site}  [mount]  ${host}\n`), `${component}:\n${text.stdout}`);
    const model = json(dir, REGATTA[1], ['trace', component]);
    const hops = model.nodes
      .filter((node) => node.kind === 'mount' && node.segment === 'page')
      .map((node) => `${node.ref} ${node.file}:${node.line} ${node.source}`);
    assert.deepEqual(hops, [page], component);
    assert.deepEqual(
      model.root.pages.pages.flatMap((entry) => entry.paths.map((one) => `page ${one.path} ${entry.file}:${entry.line} ${one.host}`)),
      [page],
    );
    assert.deepEqual(model.root.pages.reasons, []);
    assert.equal(model.root.mount, undefined);
    assert.deepEqual(chainPages(dir, keys, component), [page], `${component}: the page hops of chains`);
  }
});

test('Web journeys AC-9: a component with no page or with tied pages says so, and its routes stay', () => {
  const dir = fixture(...REGATTA);
  const sets = factSetsOf(dir);
  for (const [component, line, reason] of [
    ['DriftNotice', '─ no-page DriftNotice  web  src/marks/DriftNotice.tsx:9  [mount]', { reason: 'no-page', repo: 'web', file: 'src/marks/DriftNotice.tsx', line: 9, ref: 'DriftNotice' }],
    [
      'MarkBoard',
      '─ page-ambiguous App -> MarkBoard  web  src/app.tsx:21  [mount]  candidates src/app.tsx:21:7, src/app.tsx:21:83',
      { reason: 'page-ambiguous', repo: 'web', file: 'src/app.tsx', line: 21, ref: 'App -> MarkBoard', candidates: ['src/app.tsx:21:7', 'src/app.tsx:21:83'] },
    ],
  ]) {
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`${line}\n`), `${component}:\n${text.stdout}`);
    const model = json(dir, REGATTA[1], ['trace', component]);
    assert.deepEqual(model.root.pages, { pages: [], reasons: [reason] });
    const without = trace(sets, component, {});
    assert.deepEqual(routeRefs(model.nodes), routeRefs(without.nodes), `${component}: the routes of the walk without pages`);
    assert.deepEqual(model.status.frontier, without.status.frontier);
  }
  const chains = json(dir, REGATTA[1], ['chains', 'GET marks/v1/{id}']);
  assert.ok(chains.chains.some((chain) => chain.gaps.includes('no-page') && chain.hops[0].component === 'DriftNotice'));
});
