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
 * every declaration written as a plain string must find its own title verbatim at its own
 * site, while one wrapped in a configured case-id call must find its title argument inside
 * each title at its site. Either failing refuses the whole spec file, because ordinal drift
 * is contagious: one missed declaration shifts every declaration after it. A refused file
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
import { configuredCall, titleArgument } from './case-id-call.js';
import { findTestBlocks } from './playwright.js';
import { blankComments, escapeRegExp, makeLineFinder, stringLiteralValue, templateParts } from './text.js';

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
 * What the runner must report back for a declaration: `{ text, rule, pattern? }`, or `null`
 * when the source cannot say — the declaration then rests on its ordinal alone.
 *
 * With the source of the title argument at hand (`titleSource`), its shape decides:
 *
 * - a string literal, or a template with no interpolation, is reported as written, escapes
 *   read, so its rule is `equal`;
 * - a template with a literal part is held to those parts in their order, each interpolation
 *   matching any run of text, so its rule is a `pattern` over the whole title;
 * - a whole call to a configured case-id wrapper is held to its title argument, its second,
 *   which a wrapper may surround with other text: a string literal there gives `contains`, a
 *   template a `pattern` that may start and end anywhere in the title;
 * - an identifier, a member path, an unconfigured call, a template with no literal part and
 *   any other computed expression is a value supplied or evaluated elsewhere, so the
 *   declaration rests on its ordinal.
 *
 * Without the source, the cut `pw_test.test` text is all there is: it arrives stripped of its
 * quotes, so a plain string and a bare identifier are told apart only by their shape, and an
 * interpolation in the title argument leaves the declaration on its ordinal.
 *
 * Containment is weaker than equality. A misaligned file in which every shifted wrapped title
 * happens to occur inside the runner title it meets resolves with the titles of those sites.
 */
const IDENTIFIER_TITLE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CALL_TITLE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([\s\S]*\)$/;
const STRING_ARG_RE = /^(['"])((?:\\.|(?!\1).)*)\1$/;

function literalExpectation(source, wrapped) {
  const text = String(source ?? '').trim();
  const value = stringLiteralValue(text);
  if (value !== null) {
    if (wrapped && value === '') return null;
    return { text: value, rule: wrapped ? 'contains' : 'equal' };
  }
  const parts = templateParts(text);
  if (!parts) return null;
  if (parts.expressions.length === 0) {
    if (wrapped && parts.quasis[0] === '') return null;
    return { text: parts.quasis[0], rule: wrapped ? 'contains' : 'equal' };
  }
  if (parts.quasis.every((quasi) => quasi === '')) return null;
  const body = parts.quasis.map(escapeRegExp).join('[\\s\\S]*');
  return { text: text.slice(1, -1), rule: 'pattern', pattern: new RegExp(wrapped ? body : `^${body}$`) };
}

function sourceExpectation(source, caseIdCalls) {
  const text = String(source ?? '').trim();
  if (text === '') return null;
  const call = configuredCall(text, caseIdCalls);
  if (call) return literalExpectation(titleArgument(call), true);
  return literalExpectation(text, false);
}

function textExpectation(expression, caseIdCalls) {
  const text = String(expression).trim();
  if (text === '' || IDENTIFIER_TITLE_RE.test(text)) return null;
  if (!CALL_TITLE_RE.test(text)) return text.includes('${') ? null : { text, rule: 'equal' };
  const argument = titleArgument(configuredCall(text, caseIdCalls));
  const literal = argument === null ? null : STRING_ARG_RE.exec(argument);
  if (!literal || literal[2] === '' || literal[2].includes('${')) return null;
  return { text: literal[2], rule: 'contains' };
}

/**
 * The title one declaration is held to. `declaration` is a `pw_test` fact, with or without a
 * `titleSource`, or the title expression itself.
 */
export function titleExpectation(declaration, caseIdCalls = []) {
  if (declaration && typeof declaration === 'object') {
    if (typeof declaration.titleSource === 'string') return sourceExpectation(declaration.titleSource, caseIdCalls);
    return textExpectation(declaration.test ?? '', caseIdCalls);
  }
  return textExpectation(declaration, caseIdCalls);
}

function holds(expected, titles) {
  if (expected.rule === 'equal') return titles.length === 1 && titles[0] === expected.text;
  if (titles.length === 0) return false;
  if (expected.rule === 'contains') return titles.every((title) => title.includes(expected.text));
  return titles.every((title) => expected.pattern.test(title));
}

/** The title text a declaration is held to, or `null` when it rests on its ordinal. */
export function echoedTitle(expression, caseIdCalls = []) {
  return titleExpectation(expression, caseIdCalls)?.text ?? null;
}

/**
 * Why one spec file resolves nothing, or `null` when the ordinal join holds for all of it.
 *
 * The arity check is what makes the ordinal meaningful: sites and declarations can only be
 * paired off in order when there are the same number of them. The literal check is what
 * catches a pairing that is off by one anyway — a declaration written as a plain string is
 * reported by the runner under exactly that string, so a site that answers with a different
 * title proves the two sequences do not line up.
 *
 * Only a title the runner is obliged to echo back carries that evidence. A template, a
 * table-supplied identifier and an unrecognized call are all evaluated before the runner ever
 * sees them, so the two sides are meant to differ and the ordinal stands alone. A title
 * wrapped in a configured case-id call is the exception: its title argument still survives
 * into every title the site reports, so unwrapping recovers a check instead of discarding it.
 *
 * `declarations` are one file's `pw_test` facts in source order, `sites` its ordered
 * declaration sites, `caseIdCalls` the configured case-id callees.
 */
export function refusalReason(declarations, sites, caseIdCalls = []) {
  if (sites.length === 0) return 'the listing reports no declaration site for this spec file';
  if (sites.length !== declarations.length) {
    return `the listing reports ${sites.length} declaration sites, the source declares ${declarations.length}`;
  }
  for (let ordinal = 0; ordinal < declarations.length; ordinal += 1) {
    const expected = titleExpectation(declarations[ordinal], caseIdCalls);
    if (expected === null) continue;
    const { titles } = sites[ordinal];
    if (holds(expected, titles)) continue;
    return `declaration ${ordinal + 1} reads ${JSON.stringify(expected.text)}, the listing resolves ${JSON.stringify(titles)} there`;
  }
  return null;
}

/**
 * The declarations of one spec file, each with the source text of its title argument read
 * from the file itself: `pw_test.test` is cut at 160 characters and carries a literal's escapes
 * unread, so a check against it could refuse a title the runner reports correctly. The source
 * is attached only when the file declares exactly these tests at exactly these lines; a file
 * that cannot be read or that disagrees keeps the text check.
 */
function withTitleSources(root, spec, list) {
  let code;
  try {
    code = blankComments(readFileSync(join(root, spec), 'utf8'));
  } catch {
    return list;
  }
  const lineOf = makeLineFinder(code);
  const blocks = findTestBlocks(code);
  if (blocks.length !== list.length || blocks.some((block, i) => lineOf(block.index) !== list[i].line)) return list;
  return list.map((declaration, i) => ({ ...declaration, titleSource: blocks[i].titleArg }));
}

/**
 * One `pw_title` fact per `pw_test` declaration of a spec file the join holds for, in the
 * order the `pw_test` facts appear, so two runs over the same repository agree byte for
 * byte. A spec file either resolves every declaration or none of them: `refusals`, when
 * passed, collects one `{ spec, reason }` for each file that resolved none, which is how a
 * run that resolved nothing tells itself apart from a suite that has no titles to resolve.
 */
export function titleFacts(facts, sitesBySpec, refusals = [], caseIdCalls = [], options = {}) {
  const declarations = new Map();
  for (const testFact of facts) {
    if (testFact.type !== 'pw_test') continue;
    declarations.set(testFact.spec, [...(declarations.get(testFact.spec) || []), testFact]);
  }
  if (options.root) {
    for (const [spec, list] of declarations) declarations.set(spec, withTitleSources(options.root, spec, list));
  }
  const resolved = new Map();
  for (const [spec, list] of declarations) {
    const sites = sitesBySpec.get(spec) || [];
    const reason = refusalReason(list, sites, caseIdCalls);
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
