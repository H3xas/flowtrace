#!/usr/bin/env node
/**
 * Confirms the pinned flowtrace-edges example in examples/demo-shop/exports still matches
 * what regenerating the worked example produces.
 *
 *   node scripts/check-pinned-export.mjs <generated-file> <pinned-file>
 *
 * The comparison strips exactly the fields the extraction stamps from the checkout's own
 * git state — headSha, dirty, dirtyDigest and fileCount on every fact set, and the
 * provenance id derived from them — since those move with every commit regardless of
 * whether an edge changed; examples/demo-shop/exports/README.md tells a reader the same
 * thing. Everything else — schemaVersion, format, tool, the configuration the join read,
 * and every edge in order — must match byte for byte, or this fails naming what changed.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [, , generatedPath, pinnedPath] = process.argv;
if (!generatedPath || !pinnedPath) {
  console.error('usage: node scripts/check-pinned-export.mjs <generated-file> <pinned-file>');
  process.exit(2);
}

function stableView(document) {
  const clone = JSON.parse(JSON.stringify(document));
  for (const set of clone.provenance?.factSets || []) {
    delete set.headSha;
    delete set.dirty;
    delete set.dirtyDigest;
    delete set.fileCount;
  }
  delete clone.provenance?.id;
  for (const edge of clone.edges || []) delete edge.provenance;
  return clone;
}

const generated = JSON.parse(readFileSync(generatedPath, 'utf8'));
const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8'));

assert.deepStrictEqual(
  stableView(generated),
  stableView(pinned),
  `${generatedPath} no longer matches the pinned export at ${pinnedPath} beyond the ` +
    'fields the checkout\'s own git state stamps; regenerate it with: cd examples/demo-shop ' +
    '&& node ../../bin/flowtrace.js join --config flowtrace.config.json ' +
    '--export-edges exports/flowtrace-edges.json',
);
console.log('check-pinned-export: ok');
