/**
 * Cypress evidence reader for a `web` repository.
 *
 * A React UI library's Cypress suite may live in a sibling package rather than under the
 * source tree the web extractor walks. Its `cy.intercept()` calls are route evidence
 * `cover` already knows how to read. This module walks that sibling and emits the two fact
 * types the mobile extractor emits for the same idiom, `cypress_test` and
 * `cypress_intercept`, so nothing downstream needs to learn a new shape. Cypress and
 * Playwright evidence can coexist; this reader reports only the Cypress facts.
 *
 * `cy.intercept()` is read verb-first (`cy.intercept("GET", "**\/x")`), URL-only, from a
 * regular expression, or from an options object with `method`/`url` — the same four
 * shapes the mobile reader handles. Intercepts are read from every source file in the
 * suite, not only from `.cy.*` specs: intercepts routinely live in support commands and
 * shared fluent helpers, and one written there is exactly as much
 * proof that a route is exercised as one written inline. Those carry no enclosing test,
 * the same way a support-command intercept does in the other suite. `cypress_test`, by
 * contrast, is emitted for `.cy.*` specs only — a helper is not a test.
 */

import { readFileSync } from 'node:fs';

import { fact } from '../facts.js';
import { buildCypressBackendReader, interceptHandler, parseIntercept, testFunction } from './cypress.js';
import { walk } from '../walk.js';
import { blankComments, fullLiteral, makeLineFinder, matchBalanced, splitArgs, toRelative } from './text.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
/** A spec, as Cypress itself names one — the only file kind that declares tests. */
const SPEC_NAME = /\.cy\.[jt]sx?$/;
const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'coverage'];

const DESCRIBE_SKIP_RE = /\b(?:describe|context)\.skip\s*\(|\bxdescribe\s*\(/g;
const TEST_RE = /\b(it|xit|specify)(\.(only|skip))?\s*\(/g;
const INTERCEPT_RE = /\bcy\.intercept\s*\(/g;

function spansOf(code, pattern) {
  const spans = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(code))) {
    const open = match.index + match[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    spans.push({ match, start: open, end: close });
  }
  return spans;
}

function testBlocks(code) {
  const blocks = [];
  for (const { match, start, end } of spansOf(code, TEST_RE)) {
    const parts = splitArgs(code.slice(start + 1, end));
    const title = parts.length > 0 ? fullLiteral(parts[0].text) : null;
    if (title === null) continue;
    blocks.push({ title, index: match.index, start, end, ownSkip: match[1] === 'xit' || match[3] === 'skip' });
  }
  return blocks;
}

function enclosingTest(position, blocks) {
  let nearest = null;
  let narrowest = Infinity;
  for (const block of blocks) {
    if (position <= block.start || position >= block.end) continue;
    if (block.end - block.start >= narrowest) continue;
    narrowest = block.end - block.start;
    nearest = block;
  }
  return nearest;
}

function readSpec({ rel: relPath, code }, backendReader, facts) {
  const lineOf = makeLineFinder(code);
  const skipped = spansOf(code, DESCRIBE_SKIP_RE);
  const inSkippedSuite = (position) => skipped.some((span) => position > span.start && position < span.end);
  const blocks = SPEC_NAME.test(relPath) ? testBlocks(code) : [];

  for (const block of blocks) {
    const line = lineOf(block.index);
    const skippedTest = block.ownSkip || inSkippedSuite(block.start);
    facts.push(fact('cypress_test', { file: relPath, line, spec: relPath, test: block.title, skipped: skippedTest }));
    const backend = backendReader.classify(relPath, { index: block.index, ...testFunction(code, block.start, block.end) }, code);
    facts.push(
      fact('cypress_backend', {
        file: relPath,
        line,
        spec: relPath,
        test: block.title,
        skipped: skippedTest,
        backend: backend.backend,
        sites: backend.sites,
        ...(backend.reason ? { reason: backend.reason } : {}),
      }),
    );
  }

  for (const { match, start, end } of spansOf(code, INTERCEPT_RE)) {
    const parts = splitArgs(code.slice(start + 1, end));
    const parsed = parseIntercept(parts);
    const owner = enclosingTest(match.index, blocks);
    facts.push(
      fact('cypress_intercept', {
        file: relPath,
        line: lineOf(match.index),
        spec: relPath,
        test: owner ? owner.title : '',
        testLine: owner ? lineOf(owner.index) : null,
        verb: parsed.verb,
        pattern: parsed.pattern,
        skipped: inSkippedSuite(match.index) || (owner ? owner.ownSkip : false),
        handler: interceptHandler(parts, code),
      }),
    );
  }
}

/**
 * Read every source file under `root` and return its `cypress_test` and `cypress_backend`
 * (specs only) and `cypress_intercept` facts. The whole suite is read before any test is
 * classified, so a custom command defined in any file is known to every spec, and
 * `options.backendCalls` names the full-mock and patch calls. `options.relativeTo` sets the root the emitted `file` paths
 * are relative to, so a suite living beside the library it tests still reports paths a
 * reader can find. Per-file parse failures are contained: one malformed spec never
 * aborts the read.
 */
export function extract(root, options = {}) {
  const facts = [];
  const relativeTo = typeof options.relativeTo === 'string' && options.relativeTo !== '' ? options.relativeTo : root;
  const exclude = [...DEFAULT_EXCLUDE, ...(Array.isArray(options.exclude) ? options.exclude : [])];
  const backendCalls = options.backendCalls || {};
  const sources = [];
  for (const absPath of walk(root, { extensions: SOURCE_EXTENSIONS, exclude })) {
    try {
      sources.push({ rel: toRelative(relativeTo, absPath), code: blankComments(readFileSync(absPath, 'utf8')) });
    } catch {
      continue;
    }
  }
  const backendReader = buildCypressBackendReader({
    files: sources.map((source) => ({ path: source.rel, code: source.code })),
    mockCalls: Array.isArray(backendCalls.mockCalls) ? backendCalls.mockCalls : [],
    patchCalls: Array.isArray(backendCalls.patchCalls) ? backendCalls.patchCalls : [],
  });
  for (const source of sources) {
    try {
      readSpec(source, backendReader, facts);
    } catch {
      continue;
    }
  }
  return facts;
}
