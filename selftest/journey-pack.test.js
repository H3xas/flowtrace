/**
 * The journey pack gate: a fresh capture of the pack, replayed, must project to exactly the
 * committed `observed.json`, and every classification in it must agree with what was observed.
 * A change that moves any case therefore fails here until the same change updates the committed
 * projection, so its before and after sit in its own diff.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PACK, captureCli, copyPack, diagnosticNames, readJson, replayCli, tempDir, writeJson } from './journey-helpers.js';
import { VOCABULARY, readLedger } from '../scripts/journey-pack/ledger.mjs';

const OBSERVED = join(PACK, 'observed.json');

function gate(t, observed = OBSERVED) {
  const pack = copyPack(t);
  const captured = captureCli(pack);
  assert.equal(captured.status, 0, captured.stderr);
  const out = tempDir(t, 'gate');
  return { pack, out, result: replayCli(pack, out, ['--expect', observed]) };
}

test('a fresh capture of the pack replays to the committed projection', (t) => {
  const { out, result } = gate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(diagnosticNames(result.stderr), []);
  assert.equal(readFileSync(join(out, 'projection.json'), 'utf8'), readFileSync(OBSERVED, 'utf8'));
});

test('the committed projection classifies every case from the fixed vocabulary', () => {
  const observed = readJson(OBSERVED);
  const ledger = readLedger(join(PACK, 'expected.json'));
  assert.deepEqual(observed.cases.map((entry) => entry.id), ledger.cases.map((entry) => entry.id));
  assert.deepEqual(observed.runs.map((run) => run.id), ledger.runs.map((run) => run.id));
  for (const entry of observed.cases) {
    assert.ok(VOCABULARY.includes(entry.classification), `${entry.id}: ${entry.classification}`);
    if (entry.classification === 'unresolved-cause') assert.notEqual(entry.evidence.trim(), '');
  }
  const text = readFileSync(OBSERVED, 'utf8');
  assert.doesNotMatch(text, /\/(Users|home|tmp|private|var)\//);
  assert.doesNotMatch(text, /\b[0-9a-f]{7,64}\b/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/);
  assert.doesNotMatch(text, /flowtrace \d|v\d+\.\d+\.\d+/);
  assert.doesNotMatch(text, /\.(cs|tsx?)"/);
});

test('the budget pair is pinned for its own case only', () => {
  const observed = readJson(OBSERVED);
  const run = (id) => observed.runs.find((entry) => entry.id === id);
  const site = (caseId, siteId) => observed.cases.find((entry) => entry.id === caseId).sites.find((entry) => entry.id === siteId);
  assert.equal(run('harvest-plan-small-budget').budgetHit, true);
  assert.equal(site('harvest-write-small-budget', 'write-harvest-plan').found, false);
  assert.equal(run('harvest-plan-large-budget').budgetHit, false);
  assert.equal(site('harvest-write-large-budget', 'write-harvest-plan').found, true);
  const readme = readFileSync(join(PACK, 'README.md'), 'utf8');
  assert.match(readme, /Nothing here states a safe\s+default budget/);
  assert.match(readme, /neither `stats\.budgetHit: false` nor `seedsTruncated: 0`/);
});

test('a projection that no longer matches fails and names the case that moved', (t) => {
  const work = tempDir(t, 'drift');
  const altered = readJson(OBSERVED);
  const moved = altered.cases.find((entry) => entry.id === 'conditional-recompute');
  moved.sites[0].found = !moved.sites[0].found;
  const file = join(work, 'observed.json');
  writeJson(file, altered);
  const { result } = gate(t, file);
  assert.equal(result.status, 1);
  assert.deepEqual(diagnosticNames(result.stderr), ['projection-drift']);
  assert.match(result.stderr, /projection-drift: conditional-recompute$/m);
});

test('a gap relabelled resolved, or an unresolved cause without evidence, is inconsistent', (t) => {
  const work = tempDir(t, 'inconsistent');
  const relabelled = readJson(OBSERVED);
  const gap = relabelled.cases.find((entry) => entry.id === 'harvest-write-small-budget');
  gap.classification = 'resolved';
  const file = join(work, 'relabelled.json');
  writeJson(file, relabelled);
  let { result } = gate(t, file);
  assert.equal(result.status, 1);
  assert.deepEqual(diagnosticNames(result.stderr), ['classification-inconsistent']);
  assert.match(result.stderr, /harvest-write-small-budget: classified resolved but its observations show a gap/);

  const bare = readJson(OBSERVED);
  bare.cases.find((entry) => entry.id === 'repeated-audit-record').classification = 'unresolved-cause';
  const bareFile = join(work, 'bare.json');
  writeJson(bareFile, bare);
  ({ result } = gate(t, bareFile));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repeated-audit-record: unresolved-cause must name the evidence/);

  const hidden = readJson(OBSERVED);
  hidden.cases.find((entry) => entry.id === 'conditional-recompute').classification = 'ordering';
  const hiddenFile = join(work, 'hidden.json');
  writeJson(hiddenFile, hidden);
  ({ result } = gate(t, hiddenFile));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conditional-recompute: observations meet resolved but it is classified ordering/);
});

test('rewriting keeps a classification only where the observation did not change', (t) => {
  const { pack } = gate(t);
  const file = join(pack.work, 'rewritten.json');
  const committed = readJson(OBSERVED);
  const stale = structuredClone(committed);
  stale.cases.find((entry) => entry.id === 'repeated-audit-record').assertions[1].held = true;
  writeJson(file, stale);
  const out = tempDir(t, 'rewrite');
  const result = replayCli(pack, out, ['--write', file]);
  assert.equal(result.status, 0, result.stderr);
  const rewritten = readJson(file);
  for (const entry of rewritten.cases) {
    const expected = entry.id === 'repeated-audit-record' ? null : committed.cases.find((item) => item.id === entry.id).classification;
    assert.equal(entry.classification, expected, entry.id);
  }
});

test('the report states every case with raw counts and never pools packs', (t) => {
  const { out, result } = gate(t);
  assert.equal(result.status, 0);
  const text = readFileSync(join(out, 'report.txt'), 'utf8');
  assert.equal(result.stdout, text);
  const observed = readJson(OBSERVED);
  for (const entry of observed.cases) {
    const line = text.split('\n').find((item) => item.startsWith(`${entry.id} `));
    assert.ok(line, `no report line for ${entry.id}`);
    assert.match(line, new RegExp(`sites ${entry.counts.sitesResolved}/${entry.counts.sitesExpected} `));
    assert.match(line, new RegExp(`assertions ${entry.counts.assertionsHeld}/${entry.counts.assertionsAsserted} `));
    assert.match(line, new RegExp(`${entry.classification}$`));
  }
  assert.match(text, /^totals over 13 cases: sites \d+\/\d+ \(\d\.\d\d\)/m);
  for (const run of observed.runs) assert.match(text, new RegExp(`^run ${run.id}: exit ${run.exit}, `, 'm'));
  assert.match(text, /never pooled/);
  assert.doesNotMatch(text, /accura|strength|precision|recall|score/i);
});
