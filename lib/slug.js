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
 *
 * A digest only makes two names unlikely to meet, and two keys that flatten to one spelling
 * meet for certain. A verb writing many files in one run separates them with a shared `taken`
 * set. A verb writing one page per run cannot see the earlier run's keys, so its page states
 * the key it was written for and the next run takes the next free name rather than replace a
 * page another key holds.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How many characters of a slug a file name may carry. */
export const MAX_SLUG_CHARS = 120;

/** How much of the digest an over-long key ends in. */
const DIGEST_CHARS = 16;

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
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, DIGEST_CHARS);
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

const KEY_META = /<meta name="flowtrace-key" content="([^"]*)">/;

function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeAttribute(text) {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The `<head>` line that states which key a page was written for. */
export function keyMeta(key) {
  return `<meta name="flowtrace-key" content="${escapeAttribute(String(key))}">`;
}

/** The key a page states, or `null` for a page that states none. */
export function pageKeyOf(text) {
  const match = KEY_META.exec(text);
  return match ? unescapeAttribute(match[1]) : null;
}

/**
 * Write `contents` — a page carrying `keyMeta(key)` — under `<slug><ext>` in `dir`, or under
 * `<slug>-2<ext>`, `-3`… when that name already holds another key's page. A name holding this
 * key is this page from an earlier run and is rewritten in place. A page that states no key
 * was written before pages carried one, when every run replaced it, so it is replaced still.
 * A new name is created exclusively, so a concurrent run holding it is read, not overwritten.
 */
export function writeKeyedPage(dir, slug, ext, key, contents) {
  mkdirSync(dir, { recursive: true });
  for (let counter = 1; ; counter += 1) {
    const target = join(dir, `${counter === 1 ? slug : `${slug}-${counter}`}${ext}`);
    try {
      writeFileSync(target, contents, { flag: 'wx' });
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const held = pageKeyOf(readFileSync(target, 'utf8'));
    if (held === null || held === String(key)) {
      writeFileSync(target, contents);
      return target;
    }
  }
}
