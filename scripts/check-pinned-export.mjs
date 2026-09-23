#!/usr/bin/env node
/**
 * Confirms the pinned flowtrace-edges example in examples/demo-shop/exports still matches
 * what regenerating the worked example produces, and that both files carry provenance a
 * reader can trust.
 *
 *   node scripts/check-pinned-export.mjs <generated-file> <pinned-file>
 *
 * Run it from inside the checkout the generated file was extracted from. That checkout is a
 * requirement, not a convenience: an extraction outside git carries no revision witness at
 * all — no `headSha`, no `dirty`, no `fileCount` — so there is nothing to bind the
 * regeneration to and nothing to compare with a pinned copy that has one. Outside a
 * checkout this refuses rather than compare what is left.
 *
 * This is canonical structural and provenance equality against the pinned copy, not byte
 * equality: the pinned copy was extracted at an earlier commit, so a handful of fields
 * cannot match it. Each one is left out of the comparison only because something else
 * binds it, and nothing is left out for any other reason:
 *
 * - `provenance.id`: derived from the commit and working-tree state below, so it moves
 *   with them. Bound by re-deriving it from the block it sits in, in both files.
 * - `provenance` on every edge: a copy of that id. Bound record by record to the envelope's
 *   id, in both files.
 * - `headSha` on every fact set: the commit each copy was extracted at. The generated file's
 *   is bound to this checkout's HEAD; the pinned copy's must be a commit sha or null.
 * - `dirty` and `dirtyDigest` on every fact set: the working-tree state at extraction, which
 *   a regeneration in a clean checkout and a regeneration beside local edits legitimately
 *   disagree on. Bound in both files by their rule: `dirty` is a boolean, a clean set carries
 *   the empty-input digest and a dirty one does not.
 *
 * `fileCount` is compared like any other field. It counts the tracked files of the worked
 * example's repository, so it moves when the example gains or loses a file and not when an
 * unrelated commit lands. Every other field (the fact-set digests, the provider blocks,
 * `factSetsWithoutEdges`, the configuration the join read, and every edge in order) must
 * match exactly, or this fails naming each field that differs.
 *
 * The checks a document must pass on its own live in selftest/export-invariants.js, which
 * the public contract suite also runs without a checkout; this script adds only what needs
 * one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { exportProblems } from '../selftest/export-invariants.js';

const [, , generatedPath, pinnedPath] = process.argv;
if (!generatedPath || !pinnedPath) {
  console.error('usage: node scripts/check-pinned-export.mjs <generated-file> <pinned-file>');
  process.exit(2);
}

function checkoutHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function comparedView(document) {
  const clone = JSON.parse(JSON.stringify(document));
  if (clone.provenance) delete clone.provenance.id;
  for (const set of clone.provenance?.factSets || []) {
    delete set.headSha;
    delete set.dirty;
    delete set.dirtyDigest;
  }
  for (const edge of clone.edges || []) delete edge.provenance;
  return clone;
}

function step(key, generated, pinned) {
  if (!Array.isArray(generated)) return `.${key}`;
  const entry = pinned[key] ?? generated[key];
  return entry && typeof entry === 'object' && typeof entry.repo === 'string' ? `[${entry.repo}]` : `[${key}]`;
}

function differences(generated, pinned, path, out) {
  if (isDeepStrictEqual(generated, pinned)) return out;
  const bothContainers =
    generated !== null && pinned !== null && typeof generated === 'object' && typeof pinned === 'object' &&
    Array.isArray(generated) === Array.isArray(pinned);
  if (!bothContainers) {
    out.push(`${path}: pinned ${JSON.stringify(pinned) ?? 'absent'}, generated ${JSON.stringify(generated) ?? 'absent'}`);
    return out;
  }
  if (Array.isArray(generated) && generated.length !== pinned.length) {
    out.push(`${path}: pinned has ${pinned.length} entries, generated ${generated.length}`);
    return out;
  }
  for (const key of new Set([...Object.keys(pinned), ...Object.keys(generated)])) {
    differences(generated[key], pinned[key], `${path}${step(key, generated, pinned)}`, out);
  }
  return out;
}

const head = checkoutHead();
if (head === null) {
  console.error(
    'check-pinned-export: this is not a git checkout, so a regeneration here carries no revision ' +
      'witness to bind or compare — run it from the checkout the generated file was extracted from',
  );
  process.exit(1);
}

const generated = JSON.parse(readFileSync(generatedPath, 'utf8'));
const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8'));
const problems = [
  ...exportProblems(generated).map((problem) => `${generatedPath}: ${problem}`),
  ...exportProblems(pinned).map((problem) => `${pinnedPath}: ${problem}`),
];

for (const set of generated.provenance?.factSets || []) {
  if ((set.headSha ?? null) !== head) {
    problems.push(
      `${generatedPath}: provenance.factSets[${set.repo}].headSha ${JSON.stringify(set.headSha ?? null)} is not ` +
        `this checkout's HEAD ${JSON.stringify(head)}`,
    );
  }
}

problems.push(...differences(comparedView(generated), comparedView(pinned), 'export', []));

if (problems.length > 0) {
  console.error(`check-pinned-export: ${generatedPath} does not match the pinned export at ${pinnedPath}`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'regenerate the pinned copy only when the change is intended: cd examples/demo-shop && ' +
      'node ../../bin/flowtrace.js extract --config flowtrace.config.json && ' +
      'node ../../bin/flowtrace.js join --config flowtrace.config.json --export-edges exports/flowtrace-edges.json',
  );
  process.exit(1);
}
console.log('check-pinned-export: ok');
