/**
 * The status identity of a walk is a digest of the fact sets the walk read, so a fact kind or a
 * fact field that an extractor adds moves it. The rest of the answer must not move. This file
 * runs the walks of three corpus groups three ways and compares the answer text with the
 * identity taken out:
 *
 * - with the facts this checkout extracts,
 * - with the same facts after every kind and field added since the release is removed,
 * - against `corpus/status-identity`, the answers that the release wrote for the same starts.
 *
 * A route key, a node or a count that differs is a failure. Only `status.identity` is taken out.
 * The release answers carry their own identity, so a start whose identity did not move at all
 * would show here as a start the new facts never reached.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OUTPUTS } from './dependency-goldens.js';
import { REPO_ROOT } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(REPO_ROOT, 'bin', 'flowtrace.js');
const RELEASE_DIR = join(HERE, 'corpus', 'status-identity');
const INDEX = JSON.parse(readFileSync(join(RELEASE_DIR, 'index.json'), 'utf8'));
const BUOY = join(HERE, 'corpus', 'buoy-signals');

const SOURCES = {
  'demo-shop': { source: join(REPO_ROOT, 'examples', 'demo-shop'), config: 'flowtrace.config.json' },
  'kettle-market': { source: join(HERE, 'corpus', 'kettle-market'), config: 'kettle.config.json' },
  'lantern-depot': { source: join(HERE, 'corpus', 'lantern-depot'), config: 'lantern.config.json' },
};

/** The starts of the buoy-signals area trace whose walk reads a fact set that gained facts. */
const BUOY_MOVED = [
  'GET glasshouse/v1/zones/*/watchers',
  'GET glasshouse/v1/zones/*/readings',
  'POST glasshouse/v1/zones/*/harvest-plan',
];

/** Fact kinds that the release extractors do not write. */
const ADDED_TYPES = new Set(['cypress_backend', 'pw_visit', 'cypress_visit', 'email_read', 'email_sender', 'email_template']);

// A walk's status identity hashes the fixture's head commit, so each input of that commit is
// fixed: the same tree gives the same commit on any machine and any day.
const FIXTURE_COMMIT = {
  GIT_AUTHOR_NAME: 'flowtrace selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'flowtrace selftest',
  GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const FIXTURE_GIT = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('FLOWTRACE_')) delete env[name];
  return env;
}

function runCli(dir, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv(), maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `flowtrace ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function runCliAsync(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv(), maxBuffer: 1 << 28 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`flowtrace ${args.join(' ')}: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

/** Runs `worker` over `items`, at most `limit` at a time, keeping the order of the items. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of a corpus with its facts extracted, ready to be walked. */
function extractedCorpus(t, name) {
  const { source, config } = SOURCES[name];
  const dir = tempDir(t);
  cpSync(source, dir, { recursive: true, filter: (path) => !path.startsWith(`${source}/out`) });
  runCli(dir, ['extract', '--config', config]);
  return { dir, config };
}

function git(dir, ...args) {
  const result = spawnSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...FIXTURE_COMMIT } });
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
}

/** The buoy-signals corpus as a one-commit checkout with its facts and its join written. */
function extractedBuoy(t) {
  const dir = tempDir(t);
  cpSync(BUOY, dir, { recursive: true, filter: (path) => !path.startsWith(`${BUOY}/expected`) });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const config = 'harbor.scout.config.json';
  for (const command of ['extract', 'join']) runCli(dir, [command, '--config', config]);
  return { dir, config };
}

/** What the release extractors wrote: no added kind, no `tests/` stub, no `testLine`, no intercept `handler`. */
function releaseShapedFacts(facts) {
  let removed = 0;
  const kept = [];
  for (const fact of facts) {
    if (ADDED_TYPES.has(fact.type) || (fact.type === 'pw_stub' && String(fact.spec).startsWith('tests/'))) {
      removed += 1;
      continue;
    }
    const { testLine, ...rest } = fact;
    if (testLine !== undefined) removed += 1;
    if (fact.type === 'cypress_intercept' && rest.handler !== undefined) {
      delete rest.handler;
      removed += 1;
    }
    kept.push(rest);
  }
  return { facts: kept, removed };
}

/** Rewrites each fact file of an extracted corpus in release shape. Returns how many facts and fields it removed. */
function removeAddedFacts(dir) {
  const factsDir = join(dir, 'out', 'facts');
  let removed = 0;
  for (const name of readdirSync(factsDir).filter((file) => file.endsWith('.json'))) {
    const set = JSON.parse(readFileSync(join(factsDir, name), 'utf8'));
    const shaped = releaseShapedFacts(set.facts);
    removed += shaped.removed;
    writeFileSync(join(factsDir, name), `${JSON.stringify({ ...set, facts: shaped.facts }, null, 2)}\n`);
  }
  return removed;
}

/** Each walk answer of a document: the document itself, or each element of an area trace. */
function answersOf(document) {
  return Array.isArray(document) ? document : [document];
}

/**
 * The answer text without the one field that holds the status identity: `status.identity` of
 * each walk answer. Nothing else is removed, so a derived identity elsewhere stays and fails.
 */
function withoutIdentity(text) {
  const document = JSON.parse(text);
  let removed = 0;
  for (const answer of answersOf(document)) {
    assert.ok(answer.status && /^sha256:[0-9a-f]{64}$/.test(answer.status.identity ?? ''), `walk answer ${answer.key} has no status identity`);
    delete answer.status.identity;
    removed += 1;
  }
  return { text: JSON.stringify(document, null, 2), removed };
}

function identitiesOf(text) {
  return answersOf(JSON.parse(text)).map((answer) => ({ key: answer.key, identity: answer.status.identity }));
}

function rewriteRoot(text, root) {
  return text.split(root).join('<ROOT>').split(realpathSync(root)).join('<ROOT>');
}

/** Fails with the first differing line, so a moved field reads as a field and not as a wall of text. */
function assertSameAnswer(actual, expected, label) {
  if (actual === expected) return;
  const have = actual.split('\n');
  const want = expected.split('\n');
  let at = 0;
  while (at < have.length && at < want.length && have[at] === want[at]) at += 1;
  const around = (lines) => [lines[at - 1], lines[at], lines[at + 1]].filter((line) => line !== undefined).join('\n') || '(end of answer)';
  assert.fail(`${label}: line ${at + 1} differs\n--- with the new facts\n${around(have)}\n--- other answer\n${around(want)}`);
}

function releaseAnswer(entry) {
  return readFileSync(join(RELEASE_DIR, entry.file), 'utf8');
}

function compareArms(label, current, shaped, released) {
  const now = withoutIdentity(current);
  const without = withoutIdentity(shaped);
  const before = withoutIdentity(released);
  assert.equal(now.removed, before.removed, `${label}: the release answer has another count of walk answers`);
  assertSameAnswer(now.text, without.text, `${label}: with and without the new facts`);
  assertSameAnswer(now.text, before.text, `${label}: against the release answer`);
}

test('Test evidence AC-13: status identity of the buoy-signals area trace moves for three starts and nothing else', (t) => {
  const { dir, config } = extractedBuoy(t);
  const area = ['trace', '--area', 'harbor.area.txt', '--config', config];
  const current = rewriteRoot(runCli(dir, area), dir);
  const removed = removeAddedFacts(dir);
  assert.ok(removed > 0, 'the buoy-signals facts hold facts or fields that the release does not write');
  const shaped = rewriteRoot(runCli(dir, area), dir);
  const entry = INDEX.find((candidate) => candidate.group === 'buoy-signals');
  const released = releaseAnswer(entry);
  compareArms('buoy-signals trace-area', current, shaped, released);

  const moved = (other) => {
    const now = identitiesOf(current);
    const then = identitiesOf(other);
    assert.deepEqual(now.map((answer) => answer.key), then.map((answer) => answer.key));
    return now.filter((answer, index) => answer.identity !== then[index].identity).map((answer) => answer.key).sort();
  };
  assert.deepEqual(moved(shaped), [...BUOY_MOVED].sort(), 'the new facts move the identity of these starts');
  assert.deepEqual(moved(released), [...BUOY_MOVED].sort(), 'the release answer holds another identity for these starts');
});

test('Test evidence AC-13: status identity of the demo-shop and kettle-market seed traces moves and nothing else', (t) => {
  for (const corpus of ['demo-shop', 'kettle-market']) {
    const entries = INDEX.filter((candidate) => candidate.group === 'seed' && candidate.corpus === corpus);
    assert.ok(entries.length > 0, `${corpus} has release answers`);
    const { dir, config } = extractedCorpus(t, corpus);
    const seedTrace = (entry) => runCli(dir, ['trace', entry.start, '--seeds', '--json', '--config', config]);
    const current = entries.map(seedTrace);
    assert.ok(removeAddedFacts(dir) > 0, `${corpus} facts hold facts or fields that the release does not write`);
    const shaped = entries.map(seedTrace);
    entries.forEach((entry, index) => {
      const label = `${corpus} ${entry.start}`;
      compareArms(label, current[index], shaped[index], releaseAnswer(entry));
      assert.notEqual(identitiesOf(current[index])[0].identity, identitiesOf(shaped[index])[0].identity, `${label}: the new facts move the identity`);
      assert.notEqual(identitiesOf(current[index])[0].identity, identitiesOf(releaseAnswer(entry))[0].identity, `${label}: the release holds another identity`);
    });
  }
});

test('Test evidence AC-13: status identity of each dependency output whose digest moves differs and nothing else', async (t) => {
  const entries = INDEX.filter((candidate) => candidate.group === 'dependency');
  const outputArgs = Object.fromEntries(OUTPUTS.map((output) => [output.key, output.args]));
  const corpora = [...new Set(entries.map((entry) => entry.corpus))];
  assert.deepEqual(corpora.sort(), ['demo-shop', 'kettle-market', 'lantern-depot']);
  const starts = new Set(entries.map((entry) => `${entry.corpus}\u0000${entry.start}`));
  assert.equal(entries.length, starts.size * 2, 'each start holds its json and its graph answer');
  assert.ok(entries.every((entry) => entry.output === 'json' || entry.output === 'graph'));

  for (const corpus of corpora) {
    const mine = entries.filter((entry) => entry.corpus === corpus);
    const { dir, config } = extractedCorpus(t, corpus);
    const walk = (entry) => runCliAsync(dir, ['trace', entry.start, '--config', config, ...outputArgs[entry.output]]);
    const current = await pool(mine, 6, walk);
    assert.ok(removeAddedFacts(dir) > 0, `${corpus} facts hold facts or fields that the release does not write`);
    const shaped = await pool(mine, 6, walk);
    mine.forEach((entry, index) => {
      const label = `${corpus} ${entry.start} ${entry.output}`;
      compareArms(label, current[index], shaped[index], releaseAnswer(entry));
      assert.notEqual(identitiesOf(current[index])[0].identity, identitiesOf(releaseAnswer(entry))[0].identity, `${label}: the release holds another identity`);
    });
  }
});

test('Test evidence AC-13: status identity removal takes out the identity and keeps every other field', () => {
  const entry = INDEX.find((candidate) => candidate.group === 'seed' && candidate.start === 'POST orders/v1/checkout');
  const text = releaseAnswer(entry);
  const base = withoutIdentity(text);
  assert.equal(base.removed, 1);

  const edit = (change) => {
    const document = JSON.parse(text);
    change(document);
    return JSON.stringify(document);
  };
  const identityOnly = edit((document) => {
    document.status.identity = `sha256:${'0'.repeat(64)}`;
  });
  assert.equal(withoutIdentity(identityOnly).text, base.text, 'an answer that differs in its identity only is equal');

  const routeKey = edit((document) => {
    document.key = `${document.key}/other`;
  });
  assert.notEqual(withoutIdentity(routeKey).text, base.text, 'a changed route key is a difference');
  const node = edit((document) => {
    document.nodes.pop();
  });
  assert.notEqual(withoutIdentity(node).text, base.text, 'a missing node is a difference');
  const count = edit((document) => {
    document.stats = { ...document.stats, extra: 1 };
  });
  assert.notEqual(withoutIdentity(count).text, base.text, 'a changed count is a difference');
  const derived = edit((document) => {
    document.status.identity = `sha256:${'1'.repeat(64)}`;
    document.status.derivedIdentity = `sha256:${'2'.repeat(64)}`;
  });
  assert.notEqual(withoutIdentity(derived).text, base.text, 'an identity under another name is not taken out');
  const areaAnswer = withoutIdentity(releaseAnswer(INDEX.find((candidate) => candidate.group === 'buoy-signals')));
  assert.equal(areaAnswer.removed, 3, 'each answer of an area trace holds one identity');
  assert.throws(() => withoutIdentity(JSON.stringify({ key: 'GET x', status: {} })), /has no status identity/);
});
