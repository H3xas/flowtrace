/**
 * Web journeys: a web or Ionic screen reaches its routes and its page in `trace`,
 * `span --from-component` and `chains`, over the regatta-desk corpus and kite-club.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

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
