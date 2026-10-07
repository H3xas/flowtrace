/**
 * The file-name rule every artifact written under `out/` is named by: one key in, one flat
 * slug out, capped so a name stays a name. The cap is the whole difficulty. A key longer
 * than it has to lose something, and what it loses is often the tail that told it apart
 * from its neighbour — two entries of one component, two routes of one controller — so a
 * later write lands on the file the earlier one wrote.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SLUG_CHARS, routeSlugFor, sanitiseKey } from '../lib/slug.js';

/** A source path long enough to spend the cap on its own, before any identity is added. */
const DEEP_DIR = `deep-${'d'.repeat(96)}`;
const DEEP = `src/zones/${DEEP_DIR}/WatcherNotesPanel.tsx`;

test('a key that fits the cap keeps the spelling the verbs have always written', () => {
  assert.equal(sanitiseKey('glasshouse/v1/zones/*/watchers'), 'glasshouse-v1-zones-star-watchers');
  assert.equal(sanitiseKey('POST gizmos/v1/archive'), 'post-gizmos-v1-archive');
});

test('the cap is the boundary, not an approximation', () => {
  const atCap = 'a'.repeat(MAX_SLUG_CHARS);
  assert.equal(sanitiseKey(atCap), atCap, 'a key the cap exactly holds keeps its spelling');
  assert.notEqual(sanitiseKey(`${atCap}b`), sanitiseKey(`${atCap}c`), 'one character past it does not');
});

test('a key with nothing file-safe in it still names a file', () => {
  assert.equal(sanitiseKey(''), 'route');
  assert.equal(sanitiseKey('///'), 'route');
});

test('a long key stays inside the cap and keeps its head readable', () => {
  const slug = sanitiseKey(`component-notes-${DEEP}-effect-25-3`);
  assert.ok(slug.length <= MAX_SLUG_CHARS, `${slug} runs past the cap`);
  assert.ok(slug.startsWith('component-notes-src-zones-deep-'), slug);
  assert.match(slug, /^[a-z0-9-]+$/, 'a file name, not a path');
});

test('two keys that first differ past the cap are two names, never one', () => {
  const at25 = sanitiseKey(`component-notes-${DEEP}-useeffect-null-25-3`);
  const at29 = sanitiseKey(`component-notes-${DEEP}-useeffect-null-29-3`);
  assert.notEqual(at25, at29, 'the site past the cap is what tells the two entries apart');
});

test('a cut that lands on a dash leaves no doubled one behind', () => {
  const slug = sanitiseKey(`${'ab-'.repeat(60)}/end`);
  assert.ok(slug.length <= MAX_SLUG_CHARS, slug);
  assert.doesNotMatch(slug, /--/, slug);
  assert.match(slug, /-[\da-f]{8}$/, 'the name ends in the digest of the whole key');
});

test('the same key names the same file every run', () => {
  assert.equal(sanitiseKey(`component-notes-${DEEP}`), sanitiseKey(`component-notes-${DEEP}`));
});

test('two long keys sharing one taken set still take two names', () => {
  const taken = new Set();
  const first = routeSlugFor(`trace ${DEEP} one`, taken);
  const second = routeSlugFor(`trace ${DEEP} two`, taken);
  assert.notEqual(first, second);
});
