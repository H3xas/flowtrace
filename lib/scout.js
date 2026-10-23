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
import { spawnSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join as joinPath, resolve } from 'node:path';

const SECTION_LINE = /^([a-z][a-z-]*):\s*$/;
const KIND_LINE = /^ {2}([a-z][a-z-]*) \((\d+)(?:, (\d+) dropped)?\):\s*$/;
const EDGE_LINE = /^ {4}(\S.*?):(\d+)\s{2,}([a-z][a-z-]*)\s{2,}->\s+(.+?)\s*$/;
const NO_MATCH = /no symbol matches/i;

/**
 * Every edge kind the index declares, split by what an edge licenses a caller to do.
 *
 * A structural kind means the referencing code is compiled against the named type's shape
 * — a base type, a shared field or return type, a member call, constructor injection, an
 * implemented interface, an overridden method — so a change on either side can break the
 * other silently. They are ordered most-structural-first: a caller that must cap how far
 * it widens has to spend that cap on the edges that name a type's shape or its dispatch
 * target, because member calls are emitted per call site and otherwise crowd them out.
 *
 * A bare `imports` edge means only that the file's namespace overlaps — one file can
 * import a namespace with a hundred types and touch none of them — so it is
 * informational: visible in `counts` for diagnostics, never on its own a reason to widen
 * or to select.
 *
 * A kind named in neither list is one this build does not classify. Parsing still carries
 * it through, and `isKnownKind` is what lets a caller tell a kind deliberately left
 * informational from one newer than the build, so the second can be reported instead of
 * silently becoming the first.
 */
export const STRUCTURAL_KINDS = Object.freeze([
  'inherits',
  'implements',
  'overrides',
  'ctor-di',
  'uses-type',
  'uses-member',
]);

export const INFORMATIONAL_KINDS = Object.freeze(['imports']);

/** The structural kinds as a set, for the per-edge membership test both callers make. */
export const REACH_KINDS = new Set(STRUCTURAL_KINDS);

const INFORMATIONAL = new Set(INFORMATIONAL_KINDS);

/** True for a kind this build classifies at all, structural or informational. */
export function isKnownKind(kind) {
  return REACH_KINDS.has(kind) || INFORMATIONAL.has(kind);
}

/**
 * Widening order for a caller that cannot follow every edge: lower sorts first. A kind
 * that is not structural sorts last so a cap is never spent on an edge nothing follows.
 */
export function structuralRank(kind) {
  const rank = STRUCTURAL_KINDS.indexOf(kind);
  return rank === -1 ? STRUCTURAL_KINDS.length : rank;
}

function markUnavailable(edges, reason) {
  Object.defineProperty(edges, 'unavailable', { value: true, enumerable: false });
  Object.defineProperty(edges, 'reason', { value: reason, enumerable: false });
  return edges;
}

/**
 * Parse `refs <symbol>` output into the outbound edges of the symbol.
 *
 * Every sub-block the indexer prints under `outbound:` is read, whatever kind name its
 * header names — the indexer's own schema decides what kinds exist, and a wrapper that
 * only recognised the kinds known when it was written would fall quietly behind every
 * time that schema grew. Reading a kind here is not the same as acting on it: a caller
 * that must only widen on a specific relationship (a type actually used, say, rather
 * than a base class or a member call) still filters `edges` by `kind` itself.
 *
 * Returns `{edges, counts}`: `edges` holds `{kind, file, line, target}` per edge, in file
 * order; `counts` holds `{total, dropped}` per sub-block as reported by its header line.
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
      if (section === 'outbound') {
        counts[kind] = {
          total: Number(kindMatch[2]),
          dropped: kindMatch[3] === undefined ? 0 : Number(kindMatch[3]),
        };
      }
      continue;
    }
    if (section !== 'outbound' || kind === null) continue;
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
 * Every kind object the payload's `inbound` carries is read, whatever the indexer names
 * it — a caller that must only count a specific relationship toward reach still filters
 * `edges` by `kind` itself, the same way `refs`'s outbound edges are filtered.
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
  for (const kind of Object.keys(parsed.inbound)) {
    const block = parsed.inbound[kind];
    if (!block || typeof block !== 'object') continue;
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

/** How long one lookup may run before it is killed, and how much output it may write. */
export const LOOKUP_TIMEOUT_MS = 30000;
export const LOOKUP_MAX_BUFFER = 32 * 1024 * 1024;

/** The limit used when neither the configuration file nor the environment sets one. */
export function defaultConcurrency() {
  return Math.min(8, availableParallelism());
}

function defaultRun(bin, args, { cwd, env }) {
  return spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: LOOKUP_TIMEOUT_MS,
    maxBuffer: LOOKUP_MAX_BUFFER,
  });
}

/**
 * The asynchronous twin of `defaultRun`, for the concurrent lookup path. It gives the same
 * result shape for every way a lookup can end: an exit code, an exit by signal, a start
 * error, a timeout and output above the limit. Standard input is an empty, already-closed
 * pipe, because `spawnSync` gives the child one and an indexer that reads stdin must not
 * block on a pipe nobody closes.
 */
export function runLookupAsync(bin, args, { cwd, env, timeout = LOOKUP_TIMEOUT_MS, maxBuffer = LOOKUP_MAX_BUFFER } = {}) {
  return new Promise((settle) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);
    // A stream past the limit ends the lookup instead of being buffered: the whole point of
    // the limit is that one runaway child cannot spend the caller's memory.
    const stall = () => {
      if (done || overflow) return;
      overflow = true;
      child.kill('SIGTERM');
    };
    child.stdout.on('data', (chunk) => {
      if (timedOut || overflow) return;
      outBytes += chunk.length;
      if (outBytes > maxBuffer) return stall();
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (timedOut || overflow) return;
      errBytes += chunk.length;
      if (errBytes > maxBuffer) return stall();
      err.push(chunk);
    });
    child.on('error', (error) => {
      finish({ status: null, signal: null, error, stdout: '', stderr: '' });
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) {
        const error = new Error(`lookup timed out after ${timeout} ms`);
        error.code = 'ETIMEDOUT';
        return finish({ status: null, signal: signal || 'SIGTERM', error, stdout, stderr });
      }
      if (overflow) {
        const error = new Error(`lookup wrote more than ${maxBuffer} bytes`);
        error.code = 'ENOBUFS';
        return finish({ status: null, signal: signal || 'SIGTERM', error, stdout, stderr });
      }
      return finish({ status: code, signal, error: null, stdout, stderr });
    });
  });
}

/** Uniform "the index could not answer" result for one lookup kind. */
function classifyOutbound(result) {
  if (!result || result.error || (result.status !== 0 && result.status !== null && result.status !== undefined)) {
    return markUnavailable([], 'indexer exited with an error');
  }
  const parsed = parseRefs(result.stdout || '');
  if (!parsed.matched) return markUnavailable([], 'no symbol matches');
  Object.defineProperty(parsed.edges, 'counts', { value: parsed.counts, enumerable: false });
  return parsed.edges;
}

/** A resolved seed with an empty blast radius exits 3 and is a real, empty answer. */
function classifyImpact(result) {
  const failedExit = result && result.status !== 0 && result.status !== 3
    && result.status !== null && result.status !== undefined;
  if (!result || result.error || failedExit) return markUnavailable([], 'indexer exited with an error');
  const parsed = parseImpact(result.stdout || '');
  if (!parsed.matched) return markUnavailable([], 'no file match');
  Object.defineProperty(parsed.edges, 'braked', { value: parsed.braked, enumerable: false });
  return parsed.edges;
}

function classifyInbound(result) {
  const failedExit = result && result.status !== 0 && result.status !== 3
    && result.status !== null && result.status !== undefined;
  if (!result || result.error || failedExit) return markUnavailable([], 'indexer exited with an error');
  const parsed = parseRefsInbound(result.stdout || '');
  if (!parsed.matched) return markUnavailable([], 'no symbol matches');
  Object.defineProperty(parsed.edges, 'counts', { value: parsed.counts, enumerable: false });
  Object.defineProperty(parsed.edges, 'dropped', { value: parsed.dropped, enumerable: false });
  return parsed.edges;
}

/**
 * One lookup kind's argument list, cache key and result classifier. The pre-checks answer
 * before any key exists, so a configuration with no binary and a repository with no index
 * never wait for a pass and never start a process.
 */
const LOOKUP_KINDS = Object.freeze({
  outbound: {
    pre: (repoRoot, className) => (typeof className !== 'string' || className.trim() === '' ? 'no symbol given' : null),
    key: (repoRoot, className) => `${resolve(repoRoot)}|${className}`,
    args: (repoRoot, className) => ['refs', className],
    classify: classifyOutbound,
  },
  impact: {
    pre: (repoRoot, file) => (typeof file !== 'string' || file.trim() === '' ? 'no file given' : null),
    key: (repoRoot, file, { hops = 2, noIface = false } = {}) =>
      `impact|${resolve(repoRoot)}|${file}|${hops}|${noIface ? 1 : 0}`,
    args: (repoRoot, file, { hops = 2, noIface = false } = {}) => {
      const args = ['impact', file, '--hops', String(hops), '--json'];
      if (noIface) args.push('--no-iface');
      return args;
    },
    classify: classifyImpact,
  },
  inbound: {
    pre: (repoRoot, symbol) => (typeof symbol !== 'string' || symbol.trim() === '' ? 'no symbol given' : null),
    key: (repoRoot, symbol) => `inbound|${resolve(repoRoot)}|${symbol}`,
    args: (repoRoot, symbol) => ['refs', symbol, '--json'],
    classify: classifyInbound,
  },
});

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
export function createScout({
  bin,
  outDir = 'out',
  repos = [],
  run = defaultRun,
  runAsync = runLookupAsync,
  fileExists = existsSync,
  concurrency = defaultConcurrency(),
} = {}) {
  const roots = mappedRoots(repos);
  const env = isolationEnv(outDir);
  // A path is checked on disk; a bare command name is left to the PATH lookup at spawn
  // time, which is the only way an install location stays the caller's business.
  const isPath = typeof bin === 'string' && (bin.includes('/') || bin.includes('\\'));
  const hasBin = typeof bin === 'string' && bin.trim() !== '' && (isPath ? fileExists(bin) : true);
  const limit = Number.isSafeInteger(concurrency) && concurrency >= 1 ? concurrency : defaultConcurrency();
  const cache = new Map();

  function available(repoRoot) {
    if (!hasBin) return false;
    if (typeof repoRoot !== 'string' || repoRoot === '') return false;
    return roots.has(resolve(repoRoot));
  }

  /** Why a lookup cannot start at all, or `null` when it can. */
  function blocked(repoRoot) {
    if (!hasBin) return bin ? 'binary not found' : 'no scout binary configured';
    if (!available(repoRoot)) return 'repository has no index';
    return null;
  }

  function prepare(kind, repoRoot, argument, extra) {
    const reason = blocked(repoRoot) || LOOKUP_KINDS[kind].pre(repoRoot, argument, extra);
    if (reason) return { reason };
    return {
      key: LOOKUP_KINDS[kind].key(repoRoot, argument, extra),
      args: LOOKUP_KINDS[kind].args(repoRoot, argument, extra),
    };
  }

  function lookupSync(kind, repoRoot, argument, extra) {
    const spec = prepare(kind, repoRoot, argument, extra);
    if (spec.reason) return markUnavailable([], spec.reason);
    if (cache.has(spec.key)) return cache.get(spec.key);
    let result;
    try {
      result = run(bin, spec.args, {
        cwd: repoRoot,
        env: { ...process.env, ...env },
      });
    } catch {
      const failed = markUnavailable([], 'indexer could not be started');
      cache.set(spec.key, failed);
      return failed;
    }
    const edges = LOOKUP_KINDS[kind].classify(result);
    cache.set(spec.key, edges);
    return edges;
  }

  /**
   * The outbound edges of a class. `refs <symbol>` is the text renderer, which reports each
   * kind's row cap in its sub-block header; `counts` carries that cap onward.
   */
  function outbound(repoRoot, className) {
    return lookupSync('outbound', repoRoot, className);
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
  function impact(repoRoot, file, extra = {}) {
    return lookupSync('impact', repoRoot, file, extra);
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
    return lookupSync('inbound', repoRoot, symbol);
  }

  /**
   * Run `compute` in lookup passes until a pass records no lookup it has not answered
   * before, and return that pass's result.
   *
   * A pass gets lookup functions that answer from the shared cache and record every key
   * the cache does not hold. Those lookups then run as child processes, at most `limit`
   * at once, and the next pass sees their answers. The cache outlives the passes, so one
   * invocation runs one process per key. The loop ends because a pass that does not end
   * it adds at least one key to a finite set.
   *
   * A lookup still pending answers an empty, unavailable edge list, so the computation
   * runs to completion rather than stopping at the first miss. A computation that throws
   * while it has misses recorded is retried; one that throws without a miss is the
   * caller's error and is rethrown.
   */
  async function passes(compute) {
    for (;;) {
      const misses = new Map();
      const lookups = {
        outbound: (repoRoot, className) => lookupInPass('outbound', repoRoot, className, undefined, misses),
        inbound: (repoRoot, symbol) => lookupInPass('inbound', repoRoot, symbol, undefined, misses),
        impact: (repoRoot, file, extra) => lookupInPass('impact', repoRoot, file, extra, misses),
        scopedDirs,
      };
      let result;
      try {
        result = await compute(lookups);
      } catch (error) {
        if (misses.size === 0) throw error;
      }
      if (misses.size === 0) return result;
      await runMisses(misses);
    }
  }

  function lookupInPass(kind, repoRoot, argument, extra, misses) {
    const spec = prepare(kind, repoRoot, argument, extra);
    if (spec.reason) return markUnavailable([], spec.reason);
    if (cache.has(spec.key)) return cache.get(spec.key);
    if (!misses.has(spec.key)) misses.set(spec.key, { kind, repoRoot, args: spec.args });
    return markUnavailable([], 'lookup pending');
  }

  async function runMisses(misses) {
    const items = [...misses.entries()];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const [key, item] = items[index];
        let result;
        try {
          result = await runAsync(bin, item.args, {
            cwd: item.repoRoot,
            env: { ...process.env, ...env },
          });
        } catch {
          cache.set(key, markUnavailable([], 'indexer could not be started'));
          continue;
        }
        cache.set(key, LOOKUP_KINDS[item.kind].classify(result));
      }
    };
    const workers = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
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

  return { outbound, inbound, impact, scopedDirs, available, env, configured: hasBin, concurrency: limit, passes };
}

/** True when a wrapper result is an empty list because the index could not answer. */
export function isUnavailable(edges) {
  return Boolean(edges && edges.unavailable);
}
