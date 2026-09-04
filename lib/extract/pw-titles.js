/**
 * Playwright title enrichment for a `playwright` repository configured `"titles": true`.
 *
 * Reading a spec file gives a `pw_test` fact whose title is the expression as written —
 * for a parameterised test, `renders a ${size} card`, once. Playwright's own list mode
 * evaluates that expression and reports one title per parameter instance, each with the
 * declaration line it came from. This module runs that list mode against the repository's
 * own installed Playwright, groups the titles it reports by declaration line, and emits
 * one `pw_title` fact per `pw_test` declaration the listing resolved. The renderer joins
 * the two on `spec::line` and marks such a title `listed`; a title with no `pw_title`
 * fact stays `raw`.
 *
 * Nothing is fetched and nothing is installed: `@playwright/test` is resolved from the
 * repository root exactly as `require` would resolve it there, and the command runs with
 * the repository as its working directory. A suite that vendors a second copy of
 * `@playwright/test` inside a helper package makes a plain list run refuse to load, so
 * the command is started with a small preload that pins every request for the package to
 * the one directory resolved here. The preload is written under `out/` before each run
 * because the single-file executable has no file on disk to hand `node -r`.
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
 * `{spec}::{line}` -> every title the listing reports at that declaration line, one per
 * parameter instance, in listing order and without repeats. `spec` is repository-relative
 * the same way a `pw_test` fact's `spec` is, so the two join on the same key.
 */
export function titlesByLine(listing, repoRoot) {
  const byLine = new Map();
  const rootDir = listing && listing.config && listing.config.rootDir;
  const prefix = rootDir ? toRelative(canonical(repoRoot), canonical(rootDir)) : '';
  const add = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      const specFile = spec.file || file;
      if (!specFile || typeof spec.line !== 'number') continue;
      const rel = prefix ? `${prefix}/${specFile}` : specFile;
      const key = `${rel}::${spec.line}`;
      const titles = byLine.get(key) || [];
      if (!titles.includes(spec.title)) titles.push(spec.title);
      byLine.set(key, titles);
    }
    for (const child of suite.suites || []) add(child, file);
  };
  for (const suite of (listing && listing.suites) || []) add(suite, suite.file);
  return byLine;
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
 * throws for a repository that simply cannot list.
 */
export function collectTitles(repoRoot, { preloadDir, spawn = spawnSync, env = process.env } = {}) {
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
 * One `pw_title` fact per `pw_test` declaration the listing resolved, in the order the
 * `pw_test` facts appear, so two runs over the same repository agree byte for byte.
 */
export function titleFacts(facts, byLine) {
  const out = [];
  for (const testFact of facts) {
    if (testFact.type !== 'pw_test') continue;
    const titles = byLine.get(`${testFact.spec}::${testFact.line}`);
    if (!titles || titles.length === 0) continue;
    out.push(fact('pw_title', { file: testFact.file, line: testFact.line, spec: testFact.spec, titles: titles.slice() }));
  }
  return out;
}
