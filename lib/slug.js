/**
 * The file-name rule for everything the CLI writes one file per key: `out/flows/<slug>.md`,
 * a route's `.packet.json`, its case sheet and its Gherkin draft, a selected component page.
 * One key in, one flat lower-case slug out, shared here so no two verbs disagree on naming.
 *
 * A cap keeps a name a name, and a cap on its own is not enough: two keys that agree up to it
 * would share a file, and the later write would land on the earlier artifact — two `useEffect`
 * entries of one component under a deep source path, two routes under a long shared prefix. A
 * key longer than the cap therefore ends in a digest of the whole key, so the head stays
 * readable and the tail no two different keys share is what separates them.
 */
import { createHash } from 'node:crypto';

/** How many characters of a slug a file name may carry. */
export const MAX_SLUG_CHARS = 120;

/** How much of the digest an over-long key ends in. */
const DIGEST_CHARS = 8;

/** The name a key with nothing file-safe left in it still gets. */
const EMPTY_SLUG = 'route';

export function sanitiseKey(key) {
  const flat = String(key)
    .toLowerCase()
    .replace(/\*/g, 'star')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!flat) return EMPTY_SLUG;
  if (flat.length <= MAX_SLUG_CHARS) return flat;
  const digest = createHash('sha1').update(flat).digest('hex').slice(0, DIGEST_CHARS);
  const head = flat.slice(0, MAX_SLUG_CHARS - DIGEST_CHARS - 1).replace(/-+$/, '');
  return `${head}-${digest}`;
}

/** A key's file name; a second key with the same slug takes a numbered suffix. */
export function routeSlugFor(routeKey, taken = new Set()) {
  const base = sanitiseKey(routeKey);
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}
