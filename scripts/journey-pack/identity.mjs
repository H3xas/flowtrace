/**
 * Identities the journey harness records beside flowtrace's own: content digests of the
 * files an extractor reads, a witness of every file under a root, the tool build, a digest of
 * the normalised configuration, and the pinned environment every child runs under. Node
 * built-ins only, and nothing from `lib/`: the harness measures the tool, so it must not share
 * code with it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The sentinel for a field the harness could not establish. It never compares equal. */
export const UNKNOWN = 'unknown';

export function isUnknown(value) {
  return value === UNKNOWN || value === undefined;
}

/** Equality that refuses to vouch for anything the harness could not establish. */
export function sameKnown(left, right) {
  if (isUnknown(left) || isUnknown(right)) return false;
  return canonicalJson(left) === canonicalJson(right);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted recursively, so equal values serialise to equal bytes. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function posix(path) {
  return path.split(sep).join('/');
}

// Mirrors the directories the extractor walk always skips, so a digest never covers a
// dependency or build tree the extraction itself never opened.
const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist']);

/**
 * Regular files under `root` whose name passes `accept`, as sorted POSIX paths relative to
 * `root`. Symbolic links are never followed: a link can point anywhere, and following one
 * would let the digest cover files that are not part of the tree being identified.
 */
function listFiles(root, { accept = () => true, skip = ALWAYS_SKIP, prefix = '' } = {}) {
  const found = [];
  const visit = (directory, rel) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(path, relPath);
      } else if (entry.isFile() && accept(entry.name, relPath)) {
        found.push({ path, rel: `${prefix}${relPath}` });
      }
    }
  };
  visit(root, '');
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** `tree/1`: sha256 over `path NUL sha256(bytes) LF` for every listed file, in path order. */
export function treeDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.rel}\0${sha256(readFileSync(file.path))}\n`);
  return hash.digest('hex');
}

const byExtension = (...extensions) => (name) => extensions.some((extension) => name.toLowerCase().endsWith(extension));

/**
 * `scope/1`: the files a repository's extractor kind can read, a superset of what it
 * actually reads (configured excludes are ignored), so any change the extraction could see
 * moves the digest. A kind the harness has no rule for is `unknown`, never an empty digest.
 */
export function contentIdentity(repo, root) {
  const kind = repo.kind;
  let files;
  let scope;
  if (kind === 'backend' || kind === 'contracts') {
    files = listFiles(root, { accept: byExtension('.cs') });
    scope = `${kind}: *.cs under root`;
  } else if (kind === 'web') {
    files = listFiles(root, { accept: byExtension('.ts', '.tsx') });
    scope = 'web: *.ts, *.tsx under root';
    const cypress = typeof repo.cypressSubpath === 'string' ? repo.cypressSubpath.trim() : '';
    if (cypress !== '') {
      const cypressRoot = resolve(root, cypress);
      files = files.concat(listFiles(cypressRoot, { accept: byExtension('.ts', '.tsx', '.js', '.jsx'), prefix: 'cypress:' }));
      scope += '; *.ts, *.tsx, *.js, *.jsx under cypressSubpath';
    }
  } else if (kind === 'playwright') {
    files = listFiles(root, {
      accept: (name, rel) =>
        name.toLowerCase().endsWith('.ts') ||
        (!rel.includes('/') && (name === 'package.json' || /^playwright\.config\./.test(name))),
    });
    scope = 'playwright: *.ts under root; package.json and playwright.config.* at root';
  } else if (kind === 'mobile') {
    files = listFiles(root, { accept: byExtension('.ts', '.html') });
    scope = 'mobile: *.ts, *.html under root';
  } else {
    return { rule: 'scope/1', scope: `${kind}: no rule`, files: 0, digest: UNKNOWN };
  }
  if (!existsSync(root)) return { rule: 'scope/1', scope, files: 0, digest: UNKNOWN };
  return { rule: 'scope/1', scope, files: files.length, digest: treeDigest(files), list: files };
}

/**
 * A listing of every regular file under the roots, `.git` aside, by size and modification
 * time. It is not a content identity; it exists to notice a write anywhere under a root —
 * a cache, a lock file, a generated source — that the content scope does not cover.
 */
export function witness(roots) {
  const entries = new Map();
  for (const [label, root] of roots) {
    for (const file of listFiles(root, { skip: new Set(['.git']) })) {
      let stat;
      try {
        stat = lstatSync(file.path);
      } catch {
        continue;
      }
      entries.set(`${label}:${file.rel}`, `${stat.size}:${stat.mtimeMs}`);
    }
  }
  const lines = [...entries.keys()].sort().map((key) => `${key}\0${entries.get(key)}\n`);
  return { digest: sha256(lines.join('')), entries };
}

/** Relative paths whose witness entry differs, capped so a refusal stays readable. */
export function witnessChanges(before, after, limit = 20) {
  const changed = [];
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const key of [...keys].sort()) {
    if (before.entries.get(key) !== after.entries.get(key)) changed.push(key);
    if (changed.length >= limit) break;
  }
  return changed;
}

/** The roots a repository's witness covers: its root and, for a web client, its Cypress suite. */
export function witnessRoots(repo, root) {
  const roots = [[repo.id, root]];
  const cypress = typeof repo.cypressSubpath === 'string' ? repo.cypressSubpath.trim() : '';
  if (repo.kind === 'web' && cypress !== '') roots.push([`${repo.id}:cypress`, resolve(root, cypress)]);
  return roots;
}

function relativeFromConfig(configDir, value) {
  const rel = posix(relative(configDir, resolve(configDir, value)));
  return rel === '' ? '.' : rel;
}

/**
 * `config/1`: the configuration as the harness identifies it — `out` dropped (it names where
 * results go, not what was read), repository roots and provider files rewritten relative to
 * the configuration file, keys sorted — and the sha256 of that compact JSON.
 */
export function configIdentity(configFile) {
  const raw = JSON.parse(readFileSync(configFile, 'utf8'));
  const configDir = dirname(configFile);
  const normalised = structuredClone(raw);
  delete normalised.out;
  const roots = {};
  for (const repo of Array.isArray(normalised.repos) ? normalised.repos : []) {
    if (typeof repo.root === 'string') {
      repo.root = relativeFromConfig(configDir, repo.root);
      roots[repo.id] = repo.root;
    }
    if (repo.factsProvider && typeof repo.factsProvider.file === 'string') {
      repo.factsProvider.file = relativeFromConfig(configDir, repo.factsProvider.file);
    }
  }
  return { raw, identity: { rule: 'config/1', digest: sha256(canonicalJson(normalised)), roots } };
}

/** Whether the configuration can make flowtrace consult a code index. */
export function codeIndexConfigured(raw, env = process.env) {
  if (raw && raw.scout !== undefined) return true;
  if (Array.isArray(raw?.repos) && raw.repos.some((repo) => repo && repo.scout === true)) return true;
  return typeof env.FLOWTRACE_SCOUT_BIN === 'string' && env.FLOWTRACE_SCOUT_BIN.trim() !== '';
}

/** The variables every flowtrace child is pinned to, as the manifest records them. */
export const PINNED_ENVIRONMENT = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
  TZ: 'UTC',
  GIT_OPTIONAL_LOCKS: '0',
  FLOWTRACE_SCOUT_BIN: '(removed)',
});

/**
 * The environment a flowtrace child runs with. `GIT_OPTIONAL_LOCKS=0` keeps the `git status`
 * that extraction and every stale-facts check run from rewriting a checkout's index, and
 * removing the code-index variable keeps a replay from consulting one.
 */
export function childEnvironment(env = process.env) {
  const out = { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC', GIT_OPTIONAL_LOCKS: '0' };
  delete out.FLOWTRACE_SCOUT_BIN;
  return out;
}

function git(cwd, args) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The build that ran: its checkout HEAD only when the harness sits at the top of its own git
 * work tree (a copy dropped inside some other repository must not borrow that repository's
 * HEAD), and a `tree/1` digest over `bin/` and `lib/` either way.
 */
export function toolIdentity(harnessRoot) {
  const top = git(harnessRoot, ['rev-parse', '--show-toplevel']);
  const head = top && safeRealpath(top) === safeRealpath(harnessRoot) ? git(harnessRoot, ['rev-parse', 'HEAD']) : null;
  const files = [
    ...listFiles(join(harnessRoot, 'bin'), { prefix: 'bin/', skip: new Set() }),
    ...listFiles(join(harnessRoot, 'lib'), { prefix: 'lib/', skip: new Set() }),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    checkoutHead: head && /^[0-9a-f]{40,64}$/.test(head) ? head : UNKNOWN,
    sourceDigest: files.length > 0 ? treeDigest(files) : UNKNOWN,
  };
}

/** Every `unknown` value in an identity record, as dotted field paths. */
export function unknownFields(value, path = '') {
  if (value === UNKNOWN) return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => unknownFields(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.keys(value).flatMap((key) => unknownFields(value[key], path ? `${path}.${key}` : key));
  }
  return [];
}

/**
 * Replaces every known local directory with a placeholder, longest first, so a manifest can
 * name what ran without naming the machine it ran on. Both the spelling a path was given in and
 * its resolved form are replaced, since a temporary directory often reaches a child through a
 * symbolic link.
 */
export function makeScrubber(placeholders) {
  const pairs = [];
  const add = (path, label) => {
    if (typeof path !== 'string' || path === '' || path === '/') return;
    for (const variant of new Set([resolve(path), safeRealpath(path)])) pairs.push([variant, label]);
  };
  for (const [label, path] of placeholders) add(path, label);
  add(tmpdir(), '<tmp>');
  add(homedir(), '<home>');
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = String(text);
    for (const [path, label] of pairs) out = out.split(path).join(label);
    return out;
  };
}

const LEAK_PATTERNS = [
  /(^|[^A-Za-z0-9._-])\/(Users|home|tmp|private|var|Volumes|opt)\//,
  /(^|[^A-Za-z0-9])[A-Za-z]:\\/,
  /file:\/\//,
];

/** Whether scrubbed text still carries a machine path. */
export function leaksPath(text) {
  return LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
