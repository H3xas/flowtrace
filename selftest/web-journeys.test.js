/**
 * Web journeys: a web or Ionic screen reaches its routes and its page in `trace`,
 * `span --from-component` and `chains`, over the regatta-desk corpus and kite-club.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const BASE_FACTS = join(CORPUS, 'regatta-desk', 'base-facts', 'web.json');

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
    const entries = (chains) =>
      [...new Set(chains.filter((chain) => chain.entry && chain.entry.kind !== 'event').map((chain) => JSON.stringify(chain.entry)))].sort();
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

test('Web journeys AC-9: a component in a render cycle that no route reaches says no-page', () => {
  const dir = fixture(...REGATTA, (root) => {
    mkdirSync(join(root, 'web', 'src', 'loop'), { recursive: true });
    writeFileSync(join(root, 'web', 'src', 'loop', 'Ping.tsx'), ['import { Pong } from "./Pong";', '', 'export function Ping() {', '  return <Pong />;', '}', ''].join('\n'));
    writeFileSync(join(root, 'web', 'src', 'loop', 'Pong.tsx'), ['import { Ping } from "./Ping";', '', 'export function Pong() {', '  return <Ping />;', '}', ''].join('\n'));
  });
  for (const [component, file] of [['Ping', 'src/loop/Ping.tsx'], ['Pong', 'src/loop/Pong.tsx']]) {
    const model = json(dir, REGATTA[1], ['trace', component]);
    assert.deepEqual(model.root.pages, { pages: [], reasons: [{ reason: 'no-page', repo: 'web', file, line: 3, ref: component }] }, component);
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.ok(text.stdout.includes(`─ no-page ${component}  web  ${file}:3  [mount]\n`), text.stdout);
  }
});

test('Web journeys AC-10: a page path start walks the components its route element holds as props', () => {
  const kite = fixture(...KITE);
  const byUrl = json(kite, KITE[1], ['trace', '/kites/clubs/:clubId']);
  const byName = json(kite, KITE[1], ['trace', 'ClubFeed']);
  assert.ok(routeRefs(byName.nodes).length > 0);
  for (const route of routeRefs(byName.nodes)) assert.ok(routeRefs(byUrl.nodes).includes(route), route);
  const held = byUrl.edges.filter((edge) => edge.from === byUrl.root.id && edge.via === 'template');
  const heldRefs = held.map((edge) => byUrl.nodes.find((node) => node.id === edge.to).ref);
  assert.ok(heldRefs.includes('ClubFeed'), heldRefs.join(', '));
  assert.ok(!heldRefs.includes('Shell'), 'the element is the start, not a child it holds');

  const regatta = fixture(...REGATTA);
  const boats = json(regatta, REGATTA[1], ['trace', '/boats']);
  assert.equal(boats.root.ref, 'BoatList');
  assert.ok(!boats.nodes.some((node) => node.ref === 'Frame'), 'a wrapper stays a guard, not a held child');
  const crews = cli(regatta, REGATTA[1], ['trace', '/crews/:crewId']);
  assert.equal(crews.status, 0, crews.stderr);
  assert.match(crews.stdout, /^Layout {2}web/m);
});

test('Web journeys AC-5: a dispatch or call inside an arrow names that arrow, and its digest moves', async () => {
  const dir = fixture(...REGATTA);
  const facts = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'web.json'), 'utf8')).facts;
  const at = (type, file, line) => facts.find((fact) => fact.type === type && fact.file === file && fact.line === line);
  const handlers = facts.filter((fact) => fact.type === 'template_handler' && fact.kind === 'inline');
  for (const handler of handlers) {
    const held = facts.filter(
      (fact) =>
        (fact.type === 'action_dispatch' || fact.type === 'method_call') &&
        fact.arrow &&
        fact.arrow.attribute &&
        fact.arrow.attribute.line === handler.line &&
        fact.arrow.attribute.column === handler.column &&
        fact.file === handler.file,
    );
    assert.ok(held.length > 0, `${handler.file}:${handler.line}:${handler.column} holds a dispatch or call`);
    for (const fact of held) assert.equal(fact.arrow.attribute.name, handler.event);
  }
  assert.deepEqual(at('action_dispatch', 'src/boats/BoatList.tsx', 21).arrow, {
    line: 20,
    column: 20,
    attribute: { name: 'onClick', line: 20, column: 11 },
  });
  assert.deepEqual(at('action_dispatch', 'src/crews/CrewRoster.tsx', 14).arrow, { line: 14, column: 20, name: 'onSignUp' });
  assert.deepEqual(at('action_dispatch', 'src/crews/SignupPanel.tsx', 18).arrow, { line: 17, column: 16, name: 'action' });
  assert.deepEqual(at('action_dispatch', 'src/results/ResultsBoard.tsx', 9).arrow, { line: 8, column: 13 }, 'an effect callback is an anonymous arrow');
  for (const [file, line] of [
    ['src/crews/CrewRoster.tsx', 13],
    ['src/crews/SignupPanel.tsx', 14],
    ['src/regatta/RegattaHeader.tsx', 13],
    ['src/marks/DriftNotice.tsx', 10],
  ]) {
    assert.equal(at('action_dispatch', file, line).arrow, undefined, `${file}:${line} sits in no arrow`);
  }
  assert.deepEqual(
    handlers.filter((fact) => fact.component === 'MarkBoard').map((fact) => fact.handler),
    ['roundMark', 'skipMark'],
    'dispatch(creator(x)) names the creator',
  );
  for (const [method, line, endLine] of [['loadWind', 6, 7], ['loadTide', 9, 11], ['refreshResults', 37, 40]]) {
    const span = facts.find((fact) => fact.type === 'method_span' && fact.method === method);
    assert.deepEqual([span.line, span.endLine], [line, endLine], `the curried creator ${method} spans its thunk`);
  }
  assert.ok(facts.some((fact) => fact.type === 'effect_handler' && fact.field === 'loadWind'));
  assert.equal(at('gateway_call', 'src/actions/weather.ts', 7).method, 'loadWind');

  const { factsDigest } = await import('../lib/facts.js');
  const base = JSON.parse(readFileSync(BASE_FACTS, 'utf8')).facts;
  assert.notEqual(factsDigest(facts), factsDigest(base));
  const strip = (list) => list.map(({ arrow, ...rest }) => rest);
  assert.notEqual(factsDigest(strip(facts)), factsDigest(facts), 'the arrow fields alone move the digest');
});

/** Each edge of a `trace --json` document, with the node it reaches and its evidence sites. */
function traceHops(document) {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  return document.edges.map((edge) => ({
    from: byId.get(edge.from),
    to: byId.get(edge.to),
    via: edge.via,
    evidence: (edge.evidence || []).map((item) => `${item.type} ${item.file}:${item.line}`),
  }));
}

/** The routes below the node `ref` names, through every edge out of it. */
function routesBelow(document, predicate) {
  const children = new Map();
  for (const edge of document.edges) children.set(edge.from, [...(children.get(edge.from) || []), edge.to]);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const out = new Set();
  const visit = (id) => {
    const node = byId.get(id);
    if (node && node.kind === 'route') out.add(node.ref);
    for (const next of children.get(id) || []) visit(next);
  };
  for (const node of document.nodes.filter(predicate)) visit(node.id);
  return [...out].sort();
}

function webFacts(dir) {
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', 'web.json'), 'utf8')).facts;
}

test('Web journeys AC-1: a dispatch in a component body or in render reaches its route', () => {
  const dir = fixture(...REGATTA);
  const facts = webFacts(dir);
  const effectSite = (field) => {
    const fact = facts.find((item) => item.type === 'effect_handler' && item.field === field);
    return `${fact.file}:${fact.line}`;
  };
  for (const [component, line, hop, route, evidence, creator, gateway] of [
    ['SignupPanel', '─ body SignupPanel.render  web  src/crews/SignupPanel.tsx:13  [body]', 'props', 'GET crews/v1/signups', ['action_dispatch src/crews/SignupPanel.tsx:14', 'props_bind src/crews/SignupPanel.tsx:25'], 'loadSignups', 'gateway_call src/actions/crews.ts:13'],
    ['WindBox', '─ body WindBox.WindBox  web  src/weather/WindBox.tsx:5  [body]', 'dispatch', 'GET weather/v1/wind', ['action_dispatch src/weather/WindBox.tsx:7'], 'loadWind', 'gateway_call src/actions/weather.ts:7'],
    ['CrewRoster', '─ body CrewRoster.CrewRoster  web  src/crews/CrewRoster.tsx:12  [body]', 'props', 'GET crews/v1/*', ['action_dispatch src/crews/CrewRoster.tsx:13', 'props_bind src/crews/CrewRoster.tsx:22'], 'loadCrew', 'gateway_call src/actions/crews.ts:5'],
  ]) {
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`${line}\n`), `${component}:\n${text.stdout}`);
    const document = json(dir, REGATTA[1], ['trace', component]);
    const hops = traceHops(document);
    const arm = hops.find((item) => item.to.holder === 'body');
    const bound = hops.find((item) => item.from === arm.to && item.via === hop);
    assert.deepEqual(bound.evidence, evidence, component);
    const effect = hops.find((item) => item.from === bound.to && item.via === 'effect');
    assert.equal(`${effect.to.file}:${effect.to.line}`, effectSite(creator), `${component}: the effect_handler site`);
    const request = hops.find((item) => item.from === effect.to && item.to.kind === 'route');
    assert.equal(request.to.ref, route);
    assert.deepEqual(request.evidence, [gateway]);
  }
});

test('Web journeys AC-2: an inline arrow handler joins the dispatch it holds, at the arrow site', () => {
  const dir = fixture(...REGATTA);
  for (const [component, handlers] of [
    ['BoatList', [['pickBoat', 'src/boats/BoatList.tsx:15:40', 'POST boats/v1/*/pick'], ['removeBoat', 'src/boats/BoatList.tsx:20:20', 'DELETE boats/v1/*']]],
    ['BoatRow', [['inspectBoat', 'src/boats/BoatRow.tsx:14:38', 'POST boats/v1/*/inspect'], ['loadBoats', 'src/boats/BoatRow.tsx:19:18', 'GET boats/v1/all']]],
    ['MarkBoard', [['roundMark', 'src/marks/MarkBoard.tsx:9:38', 'POST marks/v1/*/round'], ['skipMark', 'src/marks/MarkBoard.tsx:14:18', 'POST marks/v1/*/skip']]],
  ]) {
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.equal(text.status, 0, text.stderr);
    const document = json(dir, REGATTA[1], ['trace', component]);
    for (const [handler, site, route] of handlers) {
      assert.match(text.stdout, new RegExp(`─ \\(onClick\\) ${handler}\\(\\)  web  ${site.replace(/[.]/g, '\\.')}  \\[handler\\]\\n`), `${component}:\n${text.stdout}`);
      const node = document.nodes.find((item) => item.via === 'handler' && item.method === handler);
      assert.equal(node.inline, true);
      assert.equal(`${node.file}:${node.line}:${node.column}`, site);
      assert.equal(node.unresolved, undefined);
      assert.deepEqual(routesBelow(document, (item) => item.id === node.id), [route], `${component}.${handler}`);
    }
    assert.ok(!document.nodes.some((item) => item.holder === 'body'), `${component}: an inline handler leaves no body arm`);
    assert.ok(!document.nodes.some((item) => item.ref === 'dispatch' || item.method === 'dispatch'));
  }
});

test('Web journeys AC-3: an arrow that no event links is named at its own site', () => {
  const dir = fixture(...REGATTA);
  for (const [component, line, route] of [
    ['CrewRoster', '─ arrow onSignUp  web  src/crews/CrewRoster.tsx:14:20  [body]', 'POST crews/v1/*/signup'],
    ['SignupPanel', '─ arrow action  web  src/crews/SignupPanel.tsx:17:16  [body]', 'POST crews/v1/*/release'],
  ]) {
    const text = cli(dir, REGATTA[1], ['trace', component]);
    assert.ok(text.stdout.includes(`${line}\n`), `${component}:\n${text.stdout}`);
    const document = json(dir, REGATTA[1], ['trace', component]);
    const arm = document.nodes.find((node) => node.holder === 'arrow');
    assert.deepEqual(routesBelow(document, (node) => node.id === arm.id), [route]);
  }
});

test('Web journeys AC-4: a creator with no effect walks the creators it dispatches, one hop each', async () => {
  const { traceNodes } = await import('./corpus/regatta-desk/golden.mjs');
  const dir = fixture(...REGATTA);
  const page = json(dir, REGATTA[1], ['trace', 'RegattaPage', '--no-fold']);
  const hops = traceHops(page);
  const handler = hops.find((item) => item.via === 'handler').to;
  const all = hops.find((item) => item.from === handler && item.to.ref === 'refreshAll');
  assert.equal(all.via, 'dispatch');
  assert.deepEqual(all.evidence, ['action_dispatch src/regatta/RegattaPage.tsx:13']);
  const desk = hops.find((item) => item.from === all.to && item.to.ref === 'refreshDesk');
  assert.deepEqual([desk.via, desk.to.hops, all.to.hops], ['dispatch', handler.hops + 2, handler.hops + 1]);
  assert.deepEqual(desk.evidence, ['action_dispatch src/actions/regattas.ts:44']);
  assert.deepEqual(
    hops.filter((item) => item.from === desk.to).map((item) => `${item.via} ${item.evidence.join(', ')}`),
    ['dispatch action_dispatch src/actions/regattas.ts:32', 'dispatch action_dispatch src/actions/regattas.ts:33'],
    'one hop for each nested dispatch, and none for the call inside it',
  );
  assert.deepEqual(routesBelow(page, (node) => node.id === handler.id), ['GET regattas/v1/*', 'GET regattas/v1/*/entries']);

  const bounded = json(dir, REGATTA[1], ['trace', 'RegattaPage', '--depth', String(desk.to.hops)]);
  assert.ok(bounded.status.frontier.some((stop) => stop.target === 'refreshDesk' && stop.reason === 'depth' && stop.via === 'dispatch'), JSON.stringify(bounded.status.frontier));

  const results = json(dir, REGATTA[1], ['trace', 'ResultsBoard']);
  const inline = results.nodes.find((node) => node.inline);
  assert.deepEqual(routesBelow(results, (node) => node.id === inline.id), ['GET regattas/v1/*/standings', 'GET regattas/v1/results']);
  const wind = json(dir, REGATTA[1], ['trace', 'WindBox']);
  assert.deepEqual(routesBelow(wind, (node) => node.inline === true), ['GET weather/v1/tide'], 'a curried creator with its own request');

  const header = traceNodes(json(dir, REGATTA[1], ['trace', 'RegattaHeader']))
    .filter((node) => node.kind !== 'mount')
    .map((node) => ({ ...node, keys: node.keys.filter((key) => key !== 'pages') }));
  assert.deepEqual(header, BASE.trace.RegattaHeader.filter((node) => node.kind !== 'mount'), 'a creator with an effect walks as at the base');
});

/** Each hop of a chain as `kind fact file:line ref`. */
function hopRows(chain) {
  return chain.hops.map((hop) => `${hop.kind} ${hop.fact ?? hop.reason} ${hop.file}:${hop.line} ${hop.ref}`);
}

function componentNames(dir) {
  return [...new Set(webFacts(dir).filter((fact) => fact.type === 'component' && fact.role !== 'service').map((fact) => fact.name))].sort();
}

test('Web journeys AC-1: span lists a body arm without entry, and chains and span agree', () => {
  const dir = fixture(...REGATTA);
  const panel = json(dir, REGATTA[1], ['span', '--from-component', 'SignupPanel']);
  const signups = panel.routes.find((route) => route.key === 'GET crews/v1/signups').arms;
  assert.deepEqual(
    signups.map((arm) => [arm.entry, arm.holder, `${arm.file}:${arm.line}`]),
    [[null, { kind: 'body', name: 'SignupPanel.render', file: 'src/crews/SignupPanel.tsx', line: 13 }, 'src/actions/crews.ts:13']],
  );
  const chain = json(dir, REGATTA[1], ['chains', 'GET crews/v1/signups']).chains;
  assert.deepEqual(chain.map(hopRows), [[
    'page page_route src/app.tsx:19 crews/:crewId',
    'render renders src/app.tsx:19 App -> SignupPanel',
    'gap no-entry src/crews/SignupPanel.tsx:13 SignupPanel.render',
    'dispatch action_dispatch src/crews/SignupPanel.tsx:14 SignupPanel.render -> loadSignups',
    'bind props_bind src/crews/SignupPanel.tsx:25 SignupPanel.props.loadSignups -> loadSignups',
    'effect effect_handler src/actions/crews.ts:12 Crews.loadSignups',
    'request gateway_call src/actions/crews.ts:13 GET /crews/v1/signups',
  ]]);
  const wind = json(dir, REGATTA[1], ['chains', 'GET weather/v1/wind']).chains;
  assert.deepEqual(wind.map(hopRows), [[
    'page page_route src/app.tsx:22 weather',
    'gap no-entry src/weather/WindBox.tsx:5 WindBox.WindBox',
    'dispatch action_dispatch src/weather/WindBox.tsx:7 WindBox.WindBox -> loadWind',
    'effect effect_handler src/actions/weather.ts:6 Weather.loadWind',
    'request gateway_call src/actions/weather.ts:7 GET /weather/v1/wind',
  ]]);

  // A chain with an entry climbed the whole way from its request; only a page reason can sit
  // above that entry, so its pair is the pair of a span arm.
  const forward = new Map();
  const add = (key, pair) => forward.set(key, [...(forward.get(key) || []), pair]);
  for (const name of componentNames(dir)) {
    const page = json(dir, REGATTA[1], ['span', '--from-component', name]);
    const own = new Set(page.entries.filter((view) => view.identity.component === name).map((view) => view.identity.id));
    for (const route of page.routes) {
      for (const arm of route.arms) {
        if (arm.entry && own.has(arm.entry)) add(route.key, `${arm.entry}|${arm.file}:${arm.line}`);
        if (!arm.entry && arm.holder) add(route.key, `${arm.holder.name}@${arm.holder.file}:${arm.holder.line}|${arm.file}:${arm.line}`);
      }
    }
  }
  assert.ok(forward.size >= 12, [...forward.keys()].join('\n'));
  for (const [key, pairs] of forward) {
    const model = json(dir, REGATTA[1], ['chains', key]);
    const backward = model.chains.map((item) => {
      const gap = item.hops.find((hop) => hop.reason === 'no-entry');
      const top = item.entry ? item.entry.id : gap ? `${gap.ref}@${gap.file}:${gap.line}` : null;
      return top && `${top}|${item.request.file}:${item.request.line}`;
    });
    assert.deepEqual([...new Set(backward.filter(Boolean))].sort(), [...new Set(pairs)].sort(), key);
  }
});

test('Web journeys AC-2: span and chains put the request under the inline handler entry', () => {
  const dir = fixture(...REGATTA);
  for (const [component, key, entry, held] of [
    ['BoatList', 'DELETE boats/v1/*', 'BoatList:event:onClick:removeBoat:@src/boats/BoatList.tsx:20:11', 'dispatch action_dispatch src/boats/BoatList.tsx:21 BoatList.render -> removeBoat'],
    ['BoatList', 'POST boats/v1/*/pick', 'BoatList:event:onClick:pickBoat:@src/boats/BoatList.tsx:15:31', 'dispatch action_dispatch src/boats/BoatList.tsx:15 BoatList.render -> pickBoat'],
    ['MarkBoard', 'POST marks/v1/*/skip', 'MarkBoard:event:onClick:skipMark:@src/marks/MarkBoard.tsx:14:9', 'dispatch action_dispatch src/marks/MarkBoard.tsx:15 MarkBoard.MarkBoard -> skipMark'],
    ['WindBox', 'GET weather/v1/tide', 'WindBox:event:onClick:loadTide:@src/weather/WindBox.tsx:10:29', 'dispatch action_dispatch src/weather/WindBox.tsx:10 WindBox.WindBox -> loadTide'],
  ]) {
    const span = json(dir, REGATTA[1], ['span', '--from-component', component]);
    assert.deepEqual(span.routes.find((route) => route.key === key).arms.map((arm) => arm.entry), [entry], key);
    const model = json(dir, REGATTA[1], ['chains', key]);
    assert.equal(model.chains.length, 1, `${key}: one chain, and no extra no-entry chain`);
    const [chain] = model.chains;
    assert.equal(chain.entry.id, entry);
    const rows = hopRows(chain);
    const at = rows.findIndex((row) => row.startsWith('entry template_handler'));
    assert.equal(rows[at + 1], held, key);
    assert.ok(!chain.hops.some((hop) => hop.reason === 'no-entry' || hop.reason === 'entry-unresolved'), key);
  }
});

test('Web journeys AC-3: span and chains name the arrow that holds a request no event reaches', () => {
  const dir = fixture(...REGATTA);
  for (const [component, key, holder, gap] of [
    ['CrewRoster', 'POST crews/v1/*/signup', { kind: 'arrow', name: 'CrewRoster.onSignUp', file: 'src/crews/CrewRoster.tsx', line: 14, column: 20 }, 'gap no-entry src/crews/CrewRoster.tsx:14 CrewRoster.onSignUp'],
    ['SignupPanel', 'POST crews/v1/*/release', { kind: 'arrow', name: 'SignupPanel.action', file: 'src/crews/SignupPanel.tsx', line: 17, column: 16 }, 'gap no-entry src/crews/SignupPanel.tsx:17 SignupPanel.action'],
  ]) {
    const span = json(dir, REGATTA[1], ['span', '--from-component', component]);
    assert.deepEqual(span.routes.find((route) => route.key === key).arms.map((arm) => [arm.entry, arm.holder]), [[null, holder]]);
    const page = cli(dir, REGATTA[1], ['span', '--from-component', component]);
    assert.equal(page.status, 0, page.stderr);
    const html = readFileSync(join(dir, 'out', 'span', `component-${component.toLowerCase()}-src-crews-${component.toLowerCase()}-tsx.html`), 'utf8');
    assert.ok(html.includes(`held by arrow ${holder.name} at ${holder.file}:${holder.line}:${holder.column}`), component);
    const model = json(dir, REGATTA[1], ['chains', key]);
    assert.deepEqual(model.chains.map((chain) => hopRows(chain).find((row) => row.startsWith('gap no-entry'))), [gap]);
  }
});

test('Web journeys AC-4: span and chains walk each nested dispatch as one hop', () => {
  const dir = fixture(...REGATTA);
  const key = 'GET regattas/v1/*/entries';
  const handler = 'RegattaPage:event:onClick:handleRefresh:@src/regatta/RegattaPage.tsx:20:31';
  const nested = [
    'dispatch action_dispatch src/regatta/RegattaPage.tsx:13 RegattaPage.handleRefresh -> refreshAll',
    'bind props_bind src/regatta/RegattaPage.tsx:28 RegattaPage.props.refreshAll -> refreshAll',
    'dispatch action_dispatch src/actions/regattas.ts:44 Regattas.refreshAll -> refreshDesk',
    'dispatch action_dispatch src/actions/regattas.ts:33 Regattas.refreshDesk -> loadEntries',
    'effect effect_handler src/actions/regattas.ts:12 Regattas.loadEntries',
    'request gateway_call src/actions/regattas.ts:14 GET /regattas/v1/${regattaId}/entries',
  ];
  const model = json(dir, REGATTA[1], ['chains', key]);
  const chain = model.chains.find((item) => item.entry && item.entry.id === handler);
  assert.deepEqual(hopRows(chain).slice(-nested.length), nested);
  assert.ok(!model.chains.some((item) => item.hops.some((hop) => hop.reason === 'no-caller')), 'the creator is not a dead end');

  const shallow = json(dir, REGATTA[1], ['chains', key, '--depth', '2']).chains;
  assert.ok(!shallow.some((item) => item.entry && item.entry.id === handler), 'two levels do not reach the handler');
  assert.ok(shallow.some((item) => item.hops[0].reason === 'walk-limit'), JSON.stringify(shallow.map(hopRows)));

  const span = json(dir, REGATTA[1], ['span', '--from-component', 'RegattaPage']);
  const arm = span.routes.find((route) => route.key === key).arms.find((item) => item.entry === handler);
  assert.deepEqual(arm.breadcrumb.map((step) => `${step.via} ${step.ref}`).slice(-5), [
    'dispatch refreshAll',
    'dispatch refreshDesk',
    'dispatch loadEntries',
    'effect Regattas.loadEntries',
    'literal GET regattas/v1/*/entries',
  ]);
  assert.ok(!span.unresolved.some((item) => item.reason === 'no-effect' && ['refreshAll', 'refreshDesk'].includes(item.attempted)), 'a creator with its own work is not a no-effect arm');
});

test('Web journeys AC-12: plain trace lists each mobile hook as an entry and every route the span lists', () => {
  const dir = fixture(...REGATTA);
  const text = cli(dir, REGATTA[1], ['trace', 'RaceDayPage']);
  assert.equal(text.status, 0, text.stderr);
  for (const line of [
    '─ mount RaceDayPage.ngOnInit@13  mobile  src/app/features/race/race-day.page.ts:13  [entry]',
    '─ mount RaceDayPage.ionViewWillEnter@17  mobile  src/app/features/race/race-day.page.ts:17  [entry]',
    '─ mount RaceDayPage.ionViewDidEnter@21  mobile  src/app/features/race/race-day.page.ts:21  [entry]',
    '─ mount ProtestChipComponent.ngOnInit@11  mobile  src/app/features/race/protest-chip.component.ts:11  [entry]',
  ]) {
    assert.ok(text.stdout.includes(`${line}\n`), `${line}\n${text.stdout}`);
  }
  const document = json(dir, REGATTA[1], ['trace', 'RaceDayPage']);
  const routes = [...new Set(document.nodes.filter((node) => node.kind === 'route').map((node) => node.ref))].sort();
  const span = json(dir, REGATTA[1], ['span', '--from-component', 'RaceDayPage']);
  assert.deepEqual(routes, span.routes.map((route) => route.key).sort());
  assert.ok(routes.includes('GET race/v1/briefing'), 'the hook that dispatches through the store reaches its route');
  assert.equal(document.status.scope.entries, false, 'the scope of plain trace stays');

  const handler = json(dir, REGATTA[1], ['trace', 'RaceDayPage', '--from-handler', 'onProtest']);
  assert.ok(!handler.nodes.some((node) => node.kind === 'entry'), 'a handler walk lists no hook');
});

test('Web journeys AC-15: the help, the command reference, the fact schema and the changelog name each change', async () => {
  const { execFileSync } = await import('node:child_process');
  const help = runCli(['--help'], { cwd: REPO_ROOT });
  assert.equal(help.status, 0, help.stderr);
  const section = (start, end) => {
    const from = help.stdout.indexOf(`\n${start}`);
    const to = help.stdout.indexOf(`\n${end}`, from + 1);
    assert.ok(from >= 0 && to > from, start);
    return help.stdout.slice(from, to).replace(/\s+/g, ' ');
  };
  const traceHelp = section('trace <start>', 'span "<route key>"');
  for (const topic of [
    'Pages of a component',
    '"no-page"',
    '"page-ambiguous"',
    'root.pages',
    'Route trees',
    'exits 2 with reason ambiguous',
    'holds as a child',
    '"body" hop',
    '"arrow <name>" hop',
    'arrow site, file:line:column',
    '"dispatch(c(x))"',
    'Each nested dispatch spends one level of --depth',
    'starts with its kind word',
    'lifecycle hook that sends a request',
  ]) {
    assert.ok(traceHelp.includes(topic), `trace help: ${topic}`);
  }
  const spanHelp = section('span --from-component', 'chains "<route key>"');
  assert.ok(spanHelp.includes('"holder" on the arm'), 'span help: the holder');
  const chainsHelp = section('chains "<route key>"', 'surface "<route key>"');
  for (const topic of ['inline handler arrow is the entry', 'names that arrow', 'with no effect hop', 'print as one chain in the dispatch form']) {
    assert.ok(chainsHelp.includes(topic), `chains help: ${topic}`);
  }

  const reference = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8');
  assert.ok(reference.includes(help.stdout.trimEnd()), 'docs/cli.md is the help text');
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'docs-check.mjs')], { cwd: REPO_ROOT, stdio: 'pipe' });

  const schema = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8').replace(/\s+/g, ' ');
  for (const topic of ['Optional on web `action_dispatch` and `method_call`: `arrow`', '`attribute: { name, line, column }`', '`dispatch(c(x))`, names the creator `c`']) {
    assert.ok(schema.includes(topic), `fact schema: ${topic}`);
  }

  // The entry lives in a fragment file until the release folds it into `## Unreleased`,
  // so both places count as the changelog.
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const fragmentDir = join(REPO_ROOT, 'changes', 'changelog');
  let fragments = '';
  try {
    fragments = readdirSync(fragmentDir).filter((name) => name.endsWith('.md')).sort()
      .map((name) => readFileSync(join(fragmentDir, name), 'utf8')).join('\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const unreleased = (changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 1)) + '\n' + fragments).replace(/\s+/g, ' ');
  for (const topic of ['### Web journeys','`root.pages`', 'reason `ambiguous`', 'route element holds', 'inline handler arrow', '`arrow`', 'kind word', 'lifecycle hook', 'dispatch form']) {
    assert.ok(unreleased.includes(topic), `changelog: ${topic}`);
  }
});

test('Web journeys AC-5: a fact set with no arrow field, or with a damaged one, walks the older way and fails nothing', () => {
  const headFacts = JSON.parse(readFileSync(join(fixture(...REGATTA), 'out', 'facts', 'web.json'), 'utf8'));
  const withFacts = (facts) => {
    const dir = fixture(...REGATTA, () => {});
    writeFileSync(join(dir, 'out', 'facts', 'web.json'), JSON.stringify({ ...headFacts, facts }));
    return dir;
  };
  // Each damage keeps the other fields of a real arrow, so a reader that let it through
  // would still join the fact to its handler or name.
  const damagedSets = [];
  const damages = [
    (arrow) => ({ ...arrow, line: String(arrow.line) }),
    (arrow) => ({ ...arrow, column: undefined }),
    (arrow) => ({ ...arrow, name: arrow.name === undefined ? undefined : 5, ...(arrow.attribute ? { attribute: { ...arrow.attribute, column: '1' } } : {}) }),
    (arrow) => `${arrow.line}:${arrow.column}`,
  ];
  const stripped = headFacts.facts.map(({ arrow, ...rest }) => rest);
  for (const damage of damages) {
    const damaged = headFacts.facts.map((fact) => (fact.arrow ? { ...fact, arrow: damage(fact.arrow) } : fact));
    assert.ok(damaged.some((fact) => fact.arrow), 'the head facts state arrows');
    damagedSets.push(damaged);
  }
  const older = JSON.parse(readFileSync(BASE_FACTS, 'utf8')).facts;

  const walk = (dir) => {
    const run = (args) => {
      const result = cli(dir, REGATTA[1], [...args, '--json']);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stderr, '', args.join(' '));
      return JSON.parse(result.stdout);
    };
    const trace = ['CrewRoster', 'BoatList', 'SignupPanel'].map((start) =>
      run(['trace', start]).nodes.map((node) => `${node.kind} ${node.ref} ${node.file}:${node.line}:${node.column ?? ''} ${node.holder ?? ''}${node.inline ? ' inline' : ''}`),
    );
    const chains = ['GET crews/v1/signups', 'GET weather/v1/wind'].map((route) =>
      run(['chains', route]).chains.map((chain) => chain.hops.map((hop) => `${hop.kind} ${hop.fact ?? ''} ${hop.file}:${hop.line}`).join(' > ')),
    );
    const span = run(['span', '--from-component', 'CrewRoster']).routes.map(({ status, ...route }) => route);
    return { trace, chains, span };
  };

  const plain = walk(withFacts(stripped));
  for (const damaged of damagedSets) assert.deepEqual(walk(withFacts(damaged)), plain, 'a damaged arrow field reads as no field');
  assert.notDeepEqual(walk(fixture(...REGATTA)), plain, 'the arrow fields change the walk');
  for (const rows of plain.trace) {
    assert.ok(!rows.some((row) => row.endsWith(' inline') || row.includes(' arrow')), 'no inline or arrow holder joins without arrow fields');
  }
  walk(withFacts(older));
});
