/**
 * How the C# backend extractor reads attributes, route arguments, calls, decisions and
 * response statuses, over the invented `ferry-tickets` corpus (two backend repositories and
 * one web client). Each test runs the CLI the way a user does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureBranchPoints, pinnedFacts, readBaseline } from './branch-point-baseline.js';

test('CSharp reading AC-10: the facts of the existing decision kinds stay as the baseline pins them', () => {
  const baseline = readBaseline();
  assert.ok(baseline.corpora.length > 0);
  for (const entry of baseline.corpora) {
    const now = captureBranchPoints(entry);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(entry.repos).sort(), `${entry.corpus} ${entry.config}: repositories`);
    for (const [repo, pinned] of Object.entries(entry.repos)) {
      assert.deepEqual(pinnedFacts(now[repo]), pinned.facts, `${entry.corpus} ${entry.config} ${repo}`);
    }
  }
});
