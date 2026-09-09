/**
 * Playwright title enrichment for a `playwright` repository configured `"titles": true`.
 *
 * Reading a spec file gives a `pw_test` fact whose title is the expression as written —
 * for a parameterised test, `renders a ${size} card`, once. Playwright's own list mode
 * evaluates that expression and reports one title per parameter instance. This module runs
 * that list mode against the repository's own installed Playwright and emits one `pw_title`
 * fact per `pw_test` declaration the listing resolved.
 *
 * The two sides are joined on `(spec file, declaration-site ordinal)`. The runner reports
 * positions in *transformed* source, so its line numbers name nothing in the file the
 * parser read: joining on a raw line drops most declarations and, where a transformed line
 * lands on some other declaration's source line, hands that declaration the wrong title. A
 * transform inserts, rewrites and renumbers lines; it does not reorder declarations, so the
 * ordinal is the one key both sides can compute from what they already hold. The listing's
 * specs are collapsed to declaration sites — grouped by reported `(line, column)`, ordered
 * by it — and the Nth site joins to the Nth `pw_test` declaration of the same spec file.
 *
 * Two guards make a drop the only failure the join can still have. Before any fact is
 * emitted for a spec file the two sides must agree on how many declarations it holds, and
 * every declaration whose expression has no `${` must find its own title verbatim at its
 * own site. Either failing refuses the whole spec file, because ordinal drift is
 * contagious: one missed declaration shifts every declaration after it. A refused file
 * resolves nothing and says why; its titles then render `raw`, the expression as written,
 * which is what an absent `pw_title` fact has always meant.
 *
 * Nothing is fetched and nothing is installed: `@playwright/test` is resolved from the
 * repository root exactly as `require` would resolve it there, and the command runs with
 * the repository as its working directory. A suite that vendors a second copy of
 * `@playwright/test` inside a helper package makes a plain list run refuse to load, so
 * the command is started with a small preload that pins every request for the package to
 * the one directory resolved here. The preload is written under `out/` before each run.
 *
 * List mode needs Node: a checkout and the npm package run under it. The single-file
 * executable does not — it embeds its runtime and does not process Node's command-line
 * options, so there is no interpreter to hand the preload and the entry point to, and the
 * tool promises neither a search of the PATH for one nor a fetch. Run that way, the
 * collector refuses before it resolves or writes anything, with a reason that names the
 * distribution and the one that can.
 *
 * Every failure — the package not resolvable, its binary missing, a non-zero exit, a
 * timeout, unparsable output — is returned as a reason, never thrown: titles are
 * enrichment, and extraction proceeds with none.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { fact } from '../facts.js';

/** How long one list run may take before it is abandoned. */
export const LIST_TIMEOUT_MS = 60_000;
/** The largest listing accepted; a suite of tens of thousands of tests fits many times over. */
export const LIST_MAX_BUFFER = 64 * 1024 * 1024;
/** The preload file name, written under the configured `out` directory. */
export const PRELOAD_FILE = '.pw-list-preload.cjs';
/** The variable the preload reads the pinned `node_modules` directory from. */
export const PRELOAD_ENV = 'FLOWTRACE_PW_NODE_MODULES';
/** The reason reported when the tool runs as the single-file executable. */
export const SINGLE_EXECUTABLE_REASON =
  'the single-file executable cannot run Playwright list mode; install the npm package (flowtrace-cli) to collect titles';

/**
 * The preload source, loaded through `node -r` ahead of Playwright's entry point. With
 * the variable unset it changes nothing, so it is always safe to load.
 */
export const PRELOAD_SOURCE = `'use strict';
// Loaded through node -r ahead of Playwright's own entry point. A suite that vendors a
// second copy of @playwright/test inside a helper package makes Playwright refuse to load
// twice from two paths, and list mode then collects nothing. With FLOWTRACE_PW_NODE_MODULES
// set, every request for @playwright/test, playwright or playwright-core resolves inside
// that one directory. Unset, module resolution is untouched.
const Module = require('node:module');
const path = require('node:path');
const root = process.env.FLOWTRACE_PW_NODE_MODULES;
if (root) {
  const pinned = ['@playwright/test', 'playwright', 'playwright-core'];
  const original = Module._resolveFilename;
  Module._resolveFilename = function pinnedResolveFilename(request, parent, isMain, options) {
    for (const name of pinned) {
      if (request === name || request.startsWith(name + '/')) {
        return original.call(this, path.join(root, name) + request.slice(name.length), parent, isMain, options);
      }
    }
    return original.call(this, request, parent, isMain, options);
  };
}
`;

function toRelative(repoRoot, absPath) {
  return relative(repoRoot, absPath).split('\\').join('/');
}

/**
 * Whether this process is the single-file executable rather than Node. The answer comes
 * from `node:sea`; a Node too old to ship that module cannot have built an executable
 * either, so its absence means plain Node.
 */
export function isSingleExecutable() {
  try {
    return createRequire(import.meta.url)('node:sea').isSea() === true;
  } catch {
    return false;
  }
}

/**
 * A directory with its symbolic links resolved, or the path as given when it does not
 * exist. The listing's root comes from Playwright's own resolution and the repository root
 * from the configuration; one may be the link and the other the target, and the prefix
 * between them is only right when both are read the same way.
 */
function canonical(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * The repository's own Playwright command-line entry and the `node_modules` directory it
 * lives in, resolved from `repoRoot` the way `require('@playwright/test')` would resolve
 * there — through a hoisted workspace root if that is where it is installed. Throws with
 * a one-line reason when there is nothing to run.
 */
export function resolvePlaywrightCli(repoRoot) {
  const req = createRequire(join(repoRoot, 'flowtrace-pw-list-resolver.cjs'));
  let pkgJsonPath;
  try {
    pkgJsonPath = req.resolve('@playwright/test/package.json');
  } catch {
    throw new Error('@playwright/test not resolvable from the repository root');
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const binField = pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.playwright);
  if (!binField) throw new Error('@playwright/test declares no command-line entry');
  const cliPath = join(dirname(pkgJsonPath), binField);
  if (!existsSync(cliPath)) throw new Error('the Playwright command-line entry is missing from the installed package');
  return { cliPath, nodeModulesDir: dirname(dirname(dirname(pkgJsonPath))) };
}

/** List mode may print a banner from the suite's own configuration before its JSON. */
export function parseListing(raw) {
  const start = raw.indexOf('\n{\n');
  return JSON.parse(start === -1 ? raw : raw.slice(start + 1));
}

/**
 * The listing's specs collapsed to declaration sites, per spec file:
 * `spec file -> [{ line, column, titles }, …]`. Every spec reported at one `(line, column)`
 * pair is one site — a parameterised declaration is a single site holding each of its
 * instance titles, in listing order and without repeats — and the sites of a file are
 * ordered by that pair, which is the order the file declares them in. The reported
 * positions are read only to group and to order; nothing downstream compares them to a
 * source line. `spec file` is repository-relative the same way a `pw_test` fact's `spec`
 * is, so both sides name a file identically.
 */
export function titlesByLine(listing, repoRoot) {
  const bySpec = new Map();
  const rootDir = listing && listing.config && listing.config.rootDir;
  const prefix = rootDir ? toRelative(canonical(repoRoot), canonical(rootDir)) : '';
  const add = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      const specFile = spec.file || file;
      if (!specFile || typeof spec.line !== 'number') continue;
      const rel = prefix ? `${prefix}/${specFile}` : specFile;
      const sites = bySpec.get(rel) || new Map();
      const column = typeof spec.column === 'number' ? spec.column : 0;
      const key = `${spec.line}::${column}`;
      const site = sites.get(key) || { line: spec.line, column, titles: [] };
      if (!site.titles.includes(spec.title)) site.titles.push(spec.title);
      sites.set(key, site);
      bySpec.set(rel, sites);
    }
    for (const child of suite.suites || []) add(child, file);
  };
  for (const suite of (listing && listing.suites) || []) add(suite, suite.file);
  const ordered = new Map();
  for (const [rel, sites] of bySpec) {
    ordered.set(rel, [...sites.values()].sort((a, b) => a.line - b.line || a.column - b.column));
  }
  return ordered;
}

/** Write the preload under `dir` and return its path; rewritten on every run. */
export function writePreload(dir) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, PRELOAD_FILE);
  writeFileSync(target, PRELOAD_SOURCE);
  return target;
}

/**
 * Run the repository's own Playwright in list mode and group what it reports.
 * Returns `{ status: 'ok', titlesByLine }` or `{ status: 'failed', reason }`; nothing here
 * throws for a repository that simply cannot list. The single-file executable is refused
 * first: that limit belongs to the distribution, not the repository, so it is the reason
 * reported whatever the repository holds, and nothing is written for a run that cannot happen.
 */
export function collectTitles(
  repoRoot,
  { preloadDir, spawn = spawnSync, env = process.env, isSingleExecutable: singleExecutable = isSingleExecutable } = {},
) {
  if (singleExecutable()) return { status: 'failed', reason: SINGLE_EXECUTABLE_REASON };
  let resolved;
  try {
    resolved = resolvePlaywrightCli(repoRoot);
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
  const preload = writePreload(preloadDir);
  let result;
  try {
    result = spawn(process.execPath, ['-r', preload, resolved.cliPath, 'test', '--list', '--reporter=json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: LIST_MAX_BUFFER,
      env: { ...env, [PRELOAD_ENV]: resolved.nodeModulesDir },
    });
  } catch (error) {
    return { status: 'failed', reason: `list mode could not start: ${error.message}` };
  }
  if (!result) return { status: 'failed', reason: 'list mode could not start' };
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    return {
      status: 'failed',
      reason: timedOut ? `list mode timed out after ${LIST_TIMEOUT_MS / 1000} s` : `list mode could not start: ${result.error.message}`,
    };
  }
  if (result.status !== 0 || !result.stdout) {
    const detail = String(result.stderr || '').split('\n').find((line) => line.trim() !== '');
    return { status: 'failed', reason: `list mode exited ${result.status}${detail ? `: ${detail.trim()}` : ''}` };
  }
  let listing;
  try {
    listing = parseListing(result.stdout);
  } catch {
    return { status: 'failed', reason: 'list mode output is not the JSON reporter shape' };
  }
  return { status: 'ok', titlesByLine: titlesByLine(listing, repoRoot) };
}

/**
 * Why one spec file resolves nothing, or `null` when the ordinal join holds for all of it.
 *
 * The arity check is what makes the ordinal meaningful: sites and declarations can only be
 * paired off in order when there are the same number of them. The literal check is what
 * catches a pairing that is off by one anyway — a declaration written as a plain string is
 * reported by the runner under exactly that string, so a site that answers with a different
 * title proves the two sequences do not line up. A declaration written as a template is no
 * evidence either way, since the runner reports the evaluated title and the parser the
 * expression; those are meant to differ, and resolving them is the whole point of the fact.
 *
 * `declarations` are one file's `pw_test` facts in source order, `sites` its ordered
 * declaration sites.
 */
export function refusalReason(declarations, sites) {
  if (sites.length === 0) return 'the listing reports no declaration site for this spec file';
  if (sites.length !== declarations.length) {
    return `the listing reports ${sites.length} declaration sites, the source declares ${declarations.length}`;
  }
  for (let ordinal = 0; ordinal < declarations.length; ordinal += 1) {
    const expression = String(declarations[ordinal].test ?? '');
    if (expression.includes('${')) continue;
    const { titles } = sites[ordinal];
    if (titles.length === 1 && titles[0] === expression) continue;
    return `declaration ${ordinal + 1} reads ${JSON.stringify(expression)}, the listing resolves ${JSON.stringify(titles)} there`;
  }
  return null;
}

/**
 * One `pw_title` fact per `pw_test` declaration of a spec file the join holds for, in the
 * order the `pw_test` facts appear, so two runs over the same repository agree byte for
 * byte. A spec file either resolves every declaration or none of them: `refusals`, when
 * passed, collects one `{ spec, reason }` for each file that resolved none, which is how a
 * run that resolved nothing tells itself apart from a suite that has no titles to resolve.
 */
export function titleFacts(facts, sitesBySpec, refusals = []) {
  const declarations = new Map();
  for (const testFact of facts) {
    if (testFact.type !== 'pw_test') continue;
    declarations.set(testFact.spec, [...(declarations.get(testFact.spec) || []), testFact]);
  }
  const resolved = new Map();
  for (const [spec, list] of declarations) {
    const sites = sitesBySpec.get(spec) || [];
    const reason = refusalReason(list, sites);
    if (reason === null) resolved.set(spec, sites);
    else refusals.push({ spec, reason });
  }
  const ordinals = new Map();
  const out = [];
  for (const testFact of facts) {
    if (testFact.type !== 'pw_test') continue;
    const ordinal = ordinals.get(testFact.spec) || 0;
    ordinals.set(testFact.spec, ordinal + 1);
    const sites = resolved.get(testFact.spec);
    if (!sites) continue;
    out.push(fact('pw_title', { file: testFact.file, line: testFact.line, spec: testFact.spec, titles: sites[ordinal].titles.slice() }));
  }
  return out;
}
