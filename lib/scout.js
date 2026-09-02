/**
 * Wrapper around the per-repository code index used for graph hops.
 *
 * scout is a separate, standalone code-index CLI; flowtrace only shells out to it. Point
 * flowtrace at it with `scout.bin` in the configuration file or with `FLOWTRACE_SCOUT_BIN`
 * in the environment — an absolute or relative path, or a bare command name resolved on
 * `PATH`. Nothing here assumes an install location.
 *
 * The trace step reads facts first; the index is only consulted when the facts say
 * nothing about a class. Every invocation is isolated: `SCOUT_REGISTRY` and
 * `SCOUT_CONTENT_DB` are forced to files under the flowtrace out directory so a trace
 * never reads or writes the caller's own index stores.
 *
 * The wrapper never throws. A missing binary, a repository with no index, a non-zero
 * exit or an unknown symbol all produce an empty edge list carrying `unavailable`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join as joinPath, resolve } from 'node:path';

export const GRAPH_KINDS = Object.freeze(['inherits', 'uses-type', 'uses-member']);

const SECTION_LINE = /^([a-z][a-z-]*):\s*$/;
const KIND_LINE = /^ {2}([a-z][a-z-]*) \((\d+)(?:, (\d+) dropped)?\):\s*$/;
const EDGE_LINE = /^ {4}(\S.*?):(\d+)\s{2,}([a-z][a-z-]*)\s{2,}->\s+(.+?)\s*$/;
const NO_MATCH = /no symbol matches/i;

function markUnavailable(edges, reason) {
  Object.defineProperty(edges, 'unavailable', { value: true, enumerable: false });
  Object.defineProperty(edges, 'reason', { value: reason, enumerable: false });
  return edges;
}

/**
 * Parse `refs <symbol>` output into the outbound edges of the symbol.
 *
 * Returns `{edges, counts}`: `edges` holds `{kind, file, line, target}` for the
 * `inherits`, `uses-type` and `uses-member` sub-blocks of `outbound:`, in file order;
 * `counts` holds `{total, dropped}` per sub-block as reported by its header line.
 */
export function parseRefs(text) {
  const edges = [];
  const counts = {};
  if (typeof text !== 'string' || text.trim() === '' || NO_MATCH.test(text)) {
    return { edges, counts, matched: false };
  }
  let section = null;
  let kind = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    const sectionMatch = SECTION_LINE.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      kind = null;
      continue;
    }
    const kindMatch = KIND_LINE.exec(line);
    if (kindMatch) {
      kind = kindMatch[1];
      if (section === 'outbound' && GRAPH_KINDS.includes(kind)) {
        counts[kind] = {
          total: Number(kindMatch[2]),
          dropped: kindMatch[3] === undefined ? 0 : Number(kindMatch[3]),
        };
      }
      continue;
    }
    if (section !== 'outbound' || !GRAPH_KINDS.includes(kind)) continue;
    const edgeMatch = EDGE_LINE.exec(line);
    if (!edgeMatch) continue;
    edges.push({
      kind: edgeMatch[3],
      file: edgeMatch[1],
      line: Number(edgeMatch[2]),
      target: edgeMatch[4],
    });
  }
  return { edges, counts, matched: true };
}

/**
 * Parse `impact <file> --hops N --json` output into the affected-file rows of the blast
 * radius. Scout's `impact` prints valid JSON on two different exit codes — 0 when the
 * blast radius is non-empty, 3 ("zero hits") when the seed resolves but reaches nothing
 * — and plain text (never JSON) on `notfound`/`ambiguous`/usage errors regardless of
 * `--json`; `matched` is only ever true for the two JSON-carrying cases, so a caller never
 * has to know which exit code produced them.
 *
 * Returns `{edges, braked, matched}`: `edges` holds `{file, hops, via}` per affected file,
 * in the rank order scout already returns them in. `via` is the interface-hop label
 * (`"IFoo (ctor-di)"`, joined when a file carries more than one) when the file was
 * reached through an interface, `'heuristic'` for a guess-only hit, `'direct'` otherwise.
 * `braked` holds `{iface, fanin}` per interface scout's broad-interface brake held
 * back from widening through — empty when the brake fired on nothing or is off.
 */
export function parseImpact(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { edges: [], braked: [], matched: false };
  }
  if (!parsed || parsed.status !== 'resolved' || !Array.isArray(parsed.rows)) {
    return { edges: [], braked: [], matched: false };
  }
  const edges = parsed.rows.map((row) => ({
    file: row.file,
    hops: row.hop,
    via: Array.isArray(row.ifaceVia) && row.ifaceVia.length > 0
      ? row.ifaceVia.join(', ')
      : row.heuristic
        ? 'heuristic'
        : 'direct',
  }));
  const braked = Array.isArray(parsed.braked)
    ? parsed.braked.map((entry) => ({ iface: entry.iface, fanin: entry.fanin }))
    : [];
  return { edges, braked, matched: true };
}

/**
 * Parse `refs <symbol> --json` into the **inbound** references of the symbol — who names
 * it, the direction `impact` walks and the one a test-class selection needs. The text
 * renderer caps each kind's rows and reports the remainder as `dropped`; the same cap
 * applies to the JSON, so `dropped` is carried out rather than hidden: a caller that must
 * not under-select reads it as "this list is a floor, not the set".
 *
 * Returns `{edges, counts, dropped, matched}`. `edges` holds `{kind, file, line,
 * heuristic}` per inbound row in the order the indexer returns them; `matched` is false
 * for anything that is not a resolved JSON payload, including the plain-text "no symbol
 * matches" page the indexer prints on a zero hit regardless of `--json`.
 */
export function parseRefsInbound(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { edges: [], counts: {}, dropped: 0, matched: false };
  }
  if (!parsed || parsed.status !== 'resolved' || !parsed.inbound) {
    return { edges: [], counts: {}, dropped: 0, matched: false };
  }
  const edges = [];
  const counts = {};
  let dropped = 0;
  for (const kind of GRAPH_KINDS) {
    const block = parsed.inbound[kind];
    if (!block) continue;
    counts[kind] = { total: Number(block.total) || 0, dropped: Number(block.dropped) || 0 };
    dropped += counts[kind].dropped;
    for (const row of block.rows || []) {
      if (!row || typeof row.file !== 'string') continue;
      edges.push({ kind, file: row.file, line: Number(row.line) || 0, heuristic: row.heuristic === true });
    }
  }
  return { edges, counts, dropped, matched: true };
}

function isolationEnv(outDir) {
  const dir = resolve(outDir || 'out');
  return {
    SCOUT_REGISTRY: joinPath(dir, 'scout-registry.json'),
    SCOUT_CONTENT_DB: joinPath(dir, 'scout-content.db'),
  };
}

function defaultRun(bin, args, { cwd, env }) {
  return spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function mappedRoots(repos) {
  const roots = new Set();
  for (const repo of repos || []) {
    if (repo && repo.scout === true && typeof repo.root === 'string') {
      roots.add(resolve(repo.root));
    }
  }
  return roots;
}

/**
 * Build the graph-hop wrapper.
 *
 * `bin` is the indexer executable from the configuration, `outDir` the directory the
 * isolated index stores live in, `repos` the configured repositories (only those with
 * `scout: true` are consulted). `run` and `fileExists` exist so tests can drive the
 * wrapper without a binary.
 */
export function createScout({ bin, outDir = 'out', repos = [], run = defaultRun, fileExists = existsSync } = {}) {
  const roots = mappedRoots(repos);
  const env = isolationEnv(outDir);
  // A path is checked on disk; a bare command name is left to the PATH lookup at spawn
  // time, which is the only way an install location stays the caller's business.
  const isPath = typeof bin === 'string' && (bin.includes('/') || bin.includes('\\'));
  const hasBin = typeof bin === 'string' && bin.trim() !== '' && (isPath ? fileExists(bin) : true);
  const cache = new Map();

  function available(repoRoot) {
    if (!hasBin) return false;
    if (typeof repoRoot !== 'string' || repoRoot === '') return false;
    return roots.has(resolve(repoRoot));
  }

  function outbound(repoRoot, className) {
    if (!hasBin) return markUnavailable([], bin ? 'binary not found' : 'no scout binary configured');
    if (!available(repoRoot)) return markUnavailable([], 'repository has no index');
    if (typeof className !== 'string' || className.trim() === '') {
      return markUnavailable([], 'no symbol given');
    }
    const key = `${resolve(repoRoot)}|${className}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      result = run(bin, ['refs', className], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
      });
    } catch {
      const failed = markUnavailable([], 'indexer could not be started');
      cache.set(key, failed);
      return failed;
    }
    if (!result || result.error || (result.status !== 0 && result.status !== null && result.status !== undefined)) {
      const failed = markUnavailable([], 'indexer exited with an error');
      cache.set(key, failed);
      return failed;
    }
    const parsed = parseRefs(result.stdout || '');
    if (!parsed.matched) {
      const failed = markUnavailable([], 'no symbol matches');
      cache.set(key, failed);
      return failed;
    }
    const edges = parsed.edges;
    Object.defineProperty(edges, 'counts', { value: parsed.counts, enumerable: false });
    cache.set(key, edges);
    return edges;
  }

  /**
   * `impact <file> --hops N [--no-iface]` — the blast radius of one changed file, walked
   * forward from it rather than outward from a symbol: every file scout finds depending on
   * `file` within `hops` hops, natively including the interface hop unless
   * `noIface` disables it. Same binary resolution, isolation, caching and never-throws
   * discipline as `outbound`; `file` is repo-relative, matching the facts scout and
   * flowtrace both key on. The returned edge array carries a non-enumerable `braked`
   * property (`{iface, fanin}[]`) naming any interface scout's own broad-interface
   * brake held back from widening through — empty when nothing was braked.
   */
  function impact(repoRoot, file, { hops = 2, noIface = false } = {}) {
    if (!hasBin) return markUnavailable([], bin ? 'binary not found' : 'no scout binary configured');
    if (!available(repoRoot)) return markUnavailable([], 'repository has no index');
    if (typeof file !== 'string' || file.trim() === '') {
      return markUnavailable([], 'no file given');
    }
    const key = `impact|${resolve(repoRoot)}|${file}|${hops}|${noIface ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    const args = ['impact', file, '--hops', String(hops), '--json'];
    if (noIface) args.push('--no-iface');
    let result;
    try {
      result = run(bin, args, {
        cwd: repoRoot,
        env: { ...process.env, ...env },
      });
    } catch {
      const failed = markUnavailable([], 'indexer could not be started');
      cache.set(key, failed);
      return failed;
    }
    // A resolved seed with an empty blast radius exits 3 ("zero hits") carrying the same
    // valid JSON payload as exit 0 — that is a real, empty answer, never a failure.
    const failedExit = result.status !== 0 && result.status !== 3
      && result.status !== null && result.status !== undefined;
    if (!result || result.error || failedExit) {
      const failed = markUnavailable([], 'indexer exited with an error');
      cache.set(key, failed);
      return failed;
    }
    const parsed = parseImpact(result.stdout || '');
    if (!parsed.matched) {
      const failed = markUnavailable([], 'no file match');
      cache.set(key, failed);
      return failed;
    }
    const edges = parsed.edges;
    Object.defineProperty(edges, 'braked', { value: parsed.braked, enumerable: false });
    cache.set(key, edges);
    return edges;
  }

  /**
   * `refs <symbol> --json`, inbound: every file naming `symbol`, including the heuristic
   * member-level rows the index resolves without a full type binding. Same binary
   * resolution, isolation, caching and never-throws discipline as `outbound`; the returned
   * array carries non-enumerable `counts` and `dropped` (the indexer's own per-kind row
   * cap), so a caller can say "this is a floor" rather than treat the list as complete.
   *
   * `refs` exits 3 on a resolved symbol as well as on a zero hit, so exit status alone
   * cannot separate the two: the payload does. A zero hit prints text, never JSON.
   */
  function inbound(repoRoot, symbol) {
    if (!hasBin) return markUnavailable([], bin ? 'binary not found' : 'no scout binary configured');
    if (!available(repoRoot)) return markUnavailable([], 'repository has no index');
    if (typeof symbol !== 'string' || symbol.trim() === '') {
      return markUnavailable([], 'no symbol given');
    }
    const key = `inbound|${resolve(repoRoot)}|${symbol}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      result = run(bin, ['refs', symbol, '--json'], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
      });
    } catch {
      const failed = markUnavailable([], 'indexer could not be started');
      cache.set(key, failed);
      return failed;
    }
    const failedExit = result && result.status !== 0 && result.status !== 3
      && result.status !== null && result.status !== undefined;
    if (!result || result.error || failedExit) {
      const failed = markUnavailable([], 'indexer exited with an error');
      cache.set(key, failed);
      return failed;
    }
    const parsed = parseRefsInbound(result.stdout || '');
    if (!parsed.matched) {
      const failed = markUnavailable([], 'no symbol matches');
      cache.set(key, failed);
      return failed;
    }
    const edges = parsed.edges;
    Object.defineProperty(edges, 'counts', { value: parsed.counts, enumerable: false });
    Object.defineProperty(edges, 'dropped', { value: parsed.dropped, enumerable: false });
    cache.set(key, edges);
    return edges;
  }

  /**
   * The directories the repository's index was built over, read straight off the manifest
   * the indexer writes — never guessed, and never a claim when the manifest is missing.
   * `null` means "unknown"; an empty list means the manifest names no restriction, so the
   * whole repository is in scope.
   */
  function scopedDirs(repoRoot) {
    if (typeof repoRoot !== 'string' || repoRoot === '') return null;
    const key = `scoped|${resolve(repoRoot)}`;
    if (cache.has(key)) return cache.get(key);
    let value = null;
    try {
      const manifest = JSON.parse(readFileSync(joinPath(repoRoot, '.scout', 'manifest.json'), 'utf8'));
      if (Array.isArray(manifest.scoped_dirs)) value = manifest.scoped_dirs.map(String);
    } catch {
      value = null;
    }
    cache.set(key, value);
    return value;
  }

  return { outbound, inbound, impact, scopedDirs, available, env, configured: hasBin };
}

/** True when a wrapper result is an empty list because the index could not answer. */
export function isUnavailable(edges) {
  return Boolean(edges && edges.unavailable);
}
