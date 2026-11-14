/**
 * Whether a Playwright test runs, as far as its spec file can say: `static-skip`,
 * `environment-skip`, `unknown` or `eligible`, and the guards that decided it.
 *
 * A static skip needs no value: a `test.skip(` or `test.fixme(` declaration, a test inside a
 * `test.describe.skip(` or `test.describe.fixme(` at any depth, or a guard call with no
 * condition in a scope that holds the test. A guard with a condition — `test.skip(cond)`,
 * `test.skip(cond, reason)`, the same `test.fixme` forms — applies to each test in its scope:
 * the file at top level, a describe body, a `beforeEach` or `beforeAll` hook body (the tests of
 * the describe or file that holds the hook), or one test's own body. Plain blocks, `for...of`
 * bodies and `.forEach` callbacks between the guard and its scope change nothing; a guard
 * under an `if` or another control statement holds only sometimes, so its value is `unknown`.
 * A guard inside any other function — a helper, an `afterEach`, a fixture — is not read,
 * because nothing here can say when that function runs.
 *
 * A condition is read by the bounded evaluator against the environment values the caller
 * supplies. The first state that applies wins, in this order: a static skip, a guard that
 * reads `true`, a guard that reads `unknown`, and only then `eligible`. An unknown guard can
 * therefore never make a test read as running.
 */

import { evaluateGuard } from './bounded-eval.js';
import { matchBalanced, maskLiterals, splitArgs } from './text.js';

const DESCRIBE_RE = /(?<![.?\w$])test\s*\.\s*describe((?:\s*\.\s*(?:only|skip|fixme|serial|parallel))*)\s*\(/g;
const HOOK_RE = /(?<![.?\w$])test\s*\.\s*(?:beforeEach|beforeAll)\s*\(/g;
const INLINE_FUNCTION_RE = /^(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
const EXPRESSION_LIMIT = 160;

function prevNonSpace(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return i;
}

function matchBackward(masked, closeIndex) {
  const close = masked[closeIndex];
  const open = { ')': '(', ']': '[', '}': '{' }[close];
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (masked[i] === close) depth += 1;
    else if (masked[i] === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function wordBefore(masked, index) {
  const end = prevNonSpace(masked, index);
  let start = end;
  while (start >= 0 && /[\w$]/.test(masked[start])) start -= 1;
  return { word: masked.slice(start + 1, end + 1), start: start + 1 };
}

function spansOf(masked, open, close) {
  const spans = [];
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === open) stack.push(i);
    else if (masked[i] === close && stack.length > 0) spans.push([stack.pop(), i]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** The body brace of the callback a call passes last, or `null` when it passes none inline. */
function callbackBody(code, masked, parenOpen) {
  const parenClose = matchBalanced(code, parenOpen);
  if (parenClose === -1) return null;
  const argsText = code.slice(parenOpen + 1, parenClose);
  const parts = splitArgs(argsText);
  const last = parts[parts.length - 1];
  if (!last || !INLINE_FUNCTION_RE.test(last.text)) return null;
  const from = parenOpen + 1 + last.start;
  const arrow = masked.indexOf('=>', from);
  const search = arrow !== -1 && arrow < parenClose ? arrow : from;
  const brace = masked.indexOf('{', search);
  if (brace === -1 || brace > parenClose) return null;
  const close = matchBalanced(code, brace);
  return close === -1 ? null : { open: brace, close };
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, EXPRESSION_LIMIT);
}

/**
 * The eligibility reader of one spec file. `blocks` are its test declarations (with `index`,
 * `ownSkip`, `bodyStart`, `bodyEnd`), `guardCalls` its guard calls (`index`, `kind`, `parts`),
 * `environment` the configured variable values or `null`.
 */
export function readEligibility(code, { blocks, guardCalls, environment = null }) {
  const masked = maskLiterals(code);
  const braces = spansOf(masked, '{', '}');
  const parens = spansOf(masked, '(', ')');

  const describes = [];
  let m;
  DESCRIBE_RE.lastIndex = 0;
  while ((m = DESCRIBE_RE.exec(masked))) {
    const body = callbackBody(code, masked, m.index + m[0].length - 1);
    if (body) describes.push({ ...body, skip: /\b(?:skip|fixme)\b/.test(m[1]) });
  }
  const hooks = [];
  HOOK_RE.lastIndex = 0;
  while ((m = HOOK_RE.exec(masked))) {
    const body = callbackBody(code, masked, m.index + m[0].length - 1);
    if (body) hooks.push(body);
  }
  const testByOpen = new Map();
  for (const block of blocks) if (block.bodyStart !== null) testByOpen.set(block.bodyStart - 1, block);
  const describeByOpen = new Map(describes.map((entry) => [entry.open, entry]));
  const hookByOpen = new Map(hooks.map((entry) => [entry.open, entry]));
  const inside = (span, position) => position > span.open && position < span.close;
  const describeDepth = (position) => describes.filter((entry) => inside(entry, position)).length;

  const classify = (open) => {
    const p = prevNonSpace(masked, open);
    if (p < 0 || ';{}'.includes(masked[p])) return 'transparent';
    if (masked[p] === ')') {
      const q = matchBackward(masked, p);
      const word = q === -1 ? '' : wordBefore(masked, q).word;
      if (word === 'for') return /\bof\b/.test(masked.slice(q, p)) ? 'transparent' : 'control';
      if (['if', 'while', 'switch', 'catch', 'with'].includes(word)) return 'control';
      return 'opaque';
    }
    if (masked[p] === '>' && masked[p - 1] === '=') {
      let holder = null;
      for (const span of parens) {
        if (span[0] >= open) break;
        if (span[1] > open) holder = span;
      }
      if (holder) {
        const callee = wordBefore(masked, holder[0]);
        if (callee.word === 'forEach' && masked[prevNonSpace(masked, callee.start)] === '.') return 'transparent';
      }
      return 'opaque';
    }
    if (['else', 'try', 'finally', 'do'].includes(wordBefore(masked, p + 1).word)) return 'control';
    return 'opaque';
  };

  /** The scope a guard call at `position` belongs to, or `null` when it is not read. */
  const containerOf = (position) => {
    const enclosing = braces.filter((span) => span[0] < position && span[1] > position).sort((a, b) => b[0] - a[0]);
    let conditional = false;
    for (const [open] of enclosing) {
      if (testByOpen.has(open)) return { kind: 'test', block: testByOpen.get(open), conditional };
      if (describeByOpen.has(open)) return { kind: 'describe', span: describeByOpen.get(open), conditional };
      if (hookByOpen.has(open)) return { kind: 'hook', span: hookByOpen.get(open), conditional };
      const kind = classify(open);
      if (kind === 'opaque') return null;
      if (kind === 'control') conditional = true;
    }
    return { kind: 'file', conditional };
  };

  const guards = [];
  for (const call of guardCalls) {
    if (call.kind !== 'skip' && call.kind !== 'fixme') continue;
    const container = containerOf(call.index);
    if (!container) continue;
    const bare = call.parts.length === 0;
    let holder = null;
    let depth = 0;
    if (container.kind === 'describe') depth = describeDepth(container.span.open + 1);
    if (container.kind === 'hook') {
      holder = describes.filter((entry) => inside(entry, container.span.open)).sort((a, b) => b.open - a.open)[0] || null;
      depth = describeDepth(container.span.open) + 0.5;
    }
    if (container.kind === 'test') depth = Number.MAX_SAFE_INTEGER;
    const entry = { index: call.index, container, holder, depth };
    if (bare && !container.conditional) {
      entry.bare = true;
    } else {
      const condition = bare ? null : call.parts[0].text;
      entry.expression = bare ? `test.${call.kind}()` : collapse(condition);
      entry.value =
        container.conditional || INLINE_FUNCTION_RE.test(condition)
          ? 'unknown'
          : evaluateGuard(code, call.index, condition, environment);
    }
    guards.push(entry);
  }

  /** Whether a guard's scope holds `position`, where `block` is the test that holds it. */
  const applies = (guard, position, block) => {
    const { container } = guard;
    if (container.kind === 'file') return true;
    if (container.kind === 'describe') return inside(container.span, position);
    if (container.kind === 'hook') return guard.holder ? inside(guard.holder, position) : true;
    return block !== null && block === container.block;
  };

  const staticSkipAt = (position, block) =>
    Boolean(block && block.ownSkip) ||
    describes.some((entry) => entry.skip && inside(entry, position)) ||
    guards.some((guard) => guard.bare && applies(guard, position, block));

  const forBlock = (block) => {
    const listed = guards
      .filter((guard) => !guard.bare && applies(guard, block.index, block))
      .sort((a, b) => a.depth - b.depth || a.index - b.index)
      .map((guard) => ({ line: guard.line, scope: guard.container.kind, expression: guard.expression, value: guard.value, index: guard.index }));
    let eligibility = 'eligible';
    if (staticSkipAt(block.index, block)) eligibility = 'static-skip';
    else if (listed.some((guard) => guard.value === true)) eligibility = 'environment-skip';
    else if (listed.some((guard) => guard.value === 'unknown')) eligibility = 'unknown';
    return { eligibility, skipped: eligibility === 'static-skip', guards: listed };
  };

  return { forBlock, staticSkipAt };
}
