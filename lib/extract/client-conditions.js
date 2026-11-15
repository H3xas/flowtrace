/**
 * Client display conditions, transfers and read traces.
 *
 * One reader serves the Angular templates the mobile extractor reads and the JSX of the
 * web extractor's components. A region is one component's template or JSX body. In it the
 * reader finds each display condition (`*ngIf`, `[hidden]`, `{c && …}`, `{c ? … : …}`,
 * `return c && …`, an early return) and each transfer (a bound property or prop at an
 * element), reads each expression with one small grammar, and follows each read back
 * through aliases, members, getters, inputs, props and the parent sites that bind them,
 * to a literal or to one named reason. It reads text only and holds no list of names:
 * the only words it knows are the framework's own (`ngIf`, `props`, `Store`, …).
 *
 * The reader is total over its input. Text outside the grammar is an `unsupported-syntax`
 * row or reason, a form it knows and does not read is `unsupported-form`, and nothing
 * within the envelope is dropped without a fact or a reason. `docs/fact-schema.md` states
 * the facts, the forms, the steps and the closed reason lists.
 */

import { fact } from '../facts.js';
import { matchBalanced, maskCode, maskLiterals, skipString, skipTemplate } from './text.js';

export const HOP_LIMIT = 16;
export const TRACE_LIMIT = 64;
export const TRACE_STEPS = Object.freeze([
  'alias', 'destructure', 'member', 'assignment', 'getter', 'input', 'prop', 'transfer', 'iteration', 'async',
]);
export const TRACE_REASONS = Object.freeze([
  'dynamic-key', 'store-selector', 'call', 'external-root', 'unsupported-local',
  'no-binding', 'spread-props',
  'ambiguous', 'cycle', 'depth-limit', 'trace-limit',
  'unsupported-syntax', 'unsupported-form',
]);
export const REGION_ROW_REASONS = Object.freeze(['unsupported-syntax', 'unsupported-form']);
export const REGION_FAILURES = Object.freeze([
  'template-url-unresolved', 'template-url-non-literal', 'inline-template-substitution',
]);
export const REGION_STATES = Object.freeze(['complete', 'partial', 'failed']);

// Recursion in the parser and the scanners is bounded, so a hostile nesting is a reason,
// never a stack overflow.
const MAX_NESTING = 64;
const TEXT_LIMIT = 120;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const SYNTAX = Symbol('unsupported-syntax');

function collapse(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

/* ------------------------------------------------------------------------------------ */
/* Expression grammar                                                                    */
/* ------------------------------------------------------------------------------------ */

const PUNCTUATORS = [
  '===', '!==', '?.', '==', '!=', '<=', '>=', '&&', '||', '??',
  '?', ':', '!', '.', '(', ')', '[', ']', ',', '<', '>', '|', '{', '}',
];
const LITERAL_WORDS = new Set(['true', 'false', 'null', 'undefined']);
const REFUSED_WORDS = new Set([
  'typeof', 'new', 'void', 'delete', 'in', 'instanceof', 'function', 'class', 'await', 'yield',
  'let', 'const', 'var', 'return',
]);

function tokenize(text, pipes) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      tokens.push({ t: 'id', v: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(text.slice(i, i + 64));
      tokens.push({ t: 'lit', v: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipString(text, i, ch);
      if (end > text.length || end - 1 <= i || text[end - 1] !== ch) return null;
      tokens.push({ t: 'lit', v: text.slice(i, end), str: text.slice(i + 1, end - 1), start: i, end });
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(text, i);
      if (end > text.length || end - 1 <= i || text[end - 1] !== '`') return null;
      const body = text.slice(i + 1, end - 1);
      if (body.includes('${')) return null;
      tokens.push({ t: 'lit', v: text.slice(i, end), str: body, start: i, end });
      i = end;
      continue;
    }
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (!text.startsWith(p, i)) continue;
      if (p === '?.' && /[0-9]/.test(text[i + 2] || '')) continue;
      if (p === '|' && !pipes) return null;
      matched = p;
      break;
    }
    if (!matched) return null;
    tokens.push({ t: 'p', v: matched, start: i, end: i + matched.length });
    i += matched.length;
  }
  return tokens;
}

/**
 * Parse one expression of the grammar: identifiers, `this.`, member chains with `.`, `?.`
 * and `!`, keyed access, calls, unary `!`, comparison, logical, conditional and nullish
 * operators, literals, and (with `pipes`) Angular pipes with arguments. Returns `{ ast }`
 * or `{ error: 'unsupported-syntax' }`; it never throws on its input.
 */
export function parseExpression(text, { pipes = false } = {}) {
  const tokens = tokenize(String(text), pipes);
  if (!tokens || tokens.length === 0) return { error: 'unsupported-syntax' };
  let pos = 0;
  let depth = 0;

  const isP = (v, at = pos) => tokens[at] && tokens[at].t === 'p' && tokens[at].v === v;
  const fail = () => {
    throw SYNTAX;
  };
  const expect = (v) => {
    if (!isP(v)) fail();
    pos += 1;
    return tokens[pos - 1];
  };
  const enter = () => {
    depth += 1;
    if (depth > MAX_NESTING) fail();
  };
  const leave = () => {
    depth -= 1;
  };

  function parseTop() {
    return pipes ? parsePipe() : parseCond();
  }

  function parsePipe() {
    let left = parseCond();
    while (isP('|')) {
      pos += 1;
      const name = tokens[pos];
      if (!name || name.t !== 'id') fail();
      pos += 1;
      const args = [];
      while (isP(':')) {
        pos += 1;
        args.push(parseCond());
      }
      left = { k: 'pipe', expr: left, name: name.v, args, start: left.start, end: tokens[pos - 1].end };
    }
    return left;
  }

  function parseCond() {
    enter();
    const test = parseOr();
    let node = test;
    if (isP('?')) {
      pos += 1;
      const then = parseCond();
      expect(':');
      const otherwise = parseCond();
      node = { k: 'cond', test, then, else: otherwise, start: test.start, end: otherwise.end };
    }
    leave();
    return node;
  }

  function binary(next, ops) {
    return () => {
      let left = next();
      while (tokens[pos] && tokens[pos].t === 'p' && ops.includes(tokens[pos].v)) {
        const op = tokens[pos].v;
        pos += 1;
        const right = next();
        left = { k: 'bin', op, left, right, start: left.start, end: right.end };
      }
      return left;
    };
  }

  const parseRel = binary(parseUnary, ['<', '>', '<=', '>=']);
  const parseEq = binary(parseRel, ['==', '!=', '===', '!==']);
  const parseAnd = binary(parseEq, ['&&']);
  const parseOr = binary(parseAnd, ['||', '??']);

  function parseUnary() {
    if (isP('!')) {
      const start = tokens[pos].start;
      pos += 1;
      enter();
      const expr = parseUnary();
      leave();
      return { k: 'not', expr, start, end: expr.end };
    }
    return parsePostfix();
  }

  function parseArgs() {
    const args = [];
    if (!isP(')')) {
      args.push(parseCond());
      while (isP(',')) {
        pos += 1;
        args.push(parseCond());
      }
    }
    return { args, end: expect(')').end };
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (isP('.')) {
        pos += 1;
        const name = tokens[pos];
        if (!name || name.t !== 'id') fail();
        pos += 1;
        node = { k: 'member', obj: node, name: name.v, optional: false, start: node.start, end: name.end };
        continue;
      }
      if (isP('?.')) {
        pos += 1;
        if (isP('[')) {
          pos += 1;
          enter();
          const key = parseTop();
          leave();
          const close = expect(']');
          node = { k: 'index', obj: node, key, optional: true, start: node.start, end: close.end };
          continue;
        }
        if (isP('(')) {
          pos += 1;
          enter();
          const { args, end } = parseArgs();
          leave();
          node = { k: 'call', callee: node, args, start: node.start, end };
          continue;
        }
        const name = tokens[pos];
        if (!name || name.t !== 'id') fail();
        pos += 1;
        node = { k: 'member', obj: node, name: name.v, optional: true, start: node.start, end: name.end };
        continue;
      }
      if (isP('[')) {
        pos += 1;
        enter();
        const key = parseTop();
        leave();
        const close = expect(']');
        node = { k: 'index', obj: node, key, optional: false, start: node.start, end: close.end };
        continue;
      }
      if (isP('(')) {
        pos += 1;
        enter();
        const { args, end } = parseArgs();
        leave();
        node = { k: 'call', callee: node, args, start: node.start, end };
        continue;
      }
      if (isP('!')) {
        const bang = tokens[pos];
        pos += 1;
        node = { k: 'nonnull', expr: node, start: node.start, end: bang.end };
        continue;
      }
      return node;
    }
  }

  function parsePrimary() {
    const token = tokens[pos];
    if (!token) fail();
    if (token.t === 'id') {
      pos += 1;
      if (LITERAL_WORDS.has(token.v)) return { k: 'lit', text: token.v, start: token.start, end: token.end };
      if (token.v === 'this') return { k: 'this', start: token.start, end: token.end };
      if (REFUSED_WORDS.has(token.v)) fail();
      return { k: 'id', name: token.v, start: token.start, end: token.end };
    }
    if (token.t === 'lit') {
      pos += 1;
      return { k: 'lit', text: token.v, str: token.str, start: token.start, end: token.end };
    }
    if (isP('(')) {
      pos += 1;
      enter();
      const inner = parseTop();
      leave();
      const close = expect(')');
      return { k: 'paren', expr: inner, start: token.start, end: close.end };
    }
    if (isP('[') && isP(']', pos + 1)) {
      pos += 2;
      return { k: 'lit', text: '[]', start: token.start, end: tokens[pos - 1].end };
    }
    if (isP('{') && isP('}', pos + 1)) {
      pos += 2;
      return { k: 'lit', text: '{}', start: token.start, end: tokens[pos - 1].end };
    }
    return fail();
  }

  try {
    const ast = parseTop();
    if (pos !== tokens.length) return { error: 'unsupported-syntax' };
    return { ast };
  } catch (error) {
    if (error === SYNTAX) return { error: 'unsupported-syntax' };
    throw error;
  }
}

/** The innermost node under parentheses and non-null assertions. */
function unwrap(node) {
  let current = node;
  while (current && (current.k === 'paren' || current.k === 'nonnull')) current = current.expr;
  return current;
}

/**
 * Flatten a postfix chain into its base and the operations applied to it, left to right.
 * `this.a?.b['c'](x)` is base `this` with member `a`, member `b`, index `'c'` and a call.
 */
function chainOf(node) {
  const ops = [];
  let current = node;
  for (;;) {
    if (current.k === 'member') ops.push({ op: 'member', name: current.name });
    else if (current.k === 'index') ops.push({ op: 'index', key: current.key });
    else if (current.k === 'call') ops.push({ op: 'call', args: current.args, node: current });
    else if (current.k === 'nonnull') ops.push({ op: 'skip' });
    else if (current.k === 'paren' && ops.length === 0) {
      current = current.expr;
      continue;
    } else break;
    current = current.obj || current.callee || current.expr;
  }
  ops.reverse();
  return { base: current, ops };
}

function literalKey(key) {
  const inner = unwrap(key);
  if (!inner || inner.k !== 'lit') return null;
  if (inner.str !== undefined) return { key: inner.str };
  if (/^\d/.test(inner.text)) return { key: inner.text, numeric: true };
  return null;
}

/**
 * Every read in an expression, left to right. A read is a path rooted at an identifier or
 * at `this.`: its `root`, its `segs` (`{ name }`, `{ key }`), whether an odd count of `!`
 * encloses it, the pipes it passes through, and `stop` when the path ends at a dynamic key
 * or a call. A read inside a call argument, a dynamic key or a pipe argument is `nested`:
 * it is a read of the site, but not a source of the value the site computes. A pipe name is
 * never a read.
 */
export function collectReads(ast) {
  const reads = [];
  const visit = (node, nots, pipes, isAsync, nested) => {
    if (!node) return;
    switch (node.k) {
      case 'lit':
        return;
      case 'not':
        visit(node.expr, nots + 1, pipes, isAsync, nested);
        return;
      case 'paren':
        visit(node.expr, nots, pipes, isAsync, nested);
        return;
      case 'bin':
        visit(node.left, nots, pipes, isAsync, nested);
        visit(node.right, nots, pipes, isAsync, nested);
        return;
      case 'cond':
        visit(node.test, nots, pipes, isAsync, nested);
        visit(node.then, nots, pipes, isAsync, nested);
        visit(node.else, nots, pipes, isAsync, nested);
        return;
      case 'pipe': {
        const async = node.name === 'async';
        visit(node.expr, nots, async ? pipes : [...pipes, node.name], isAsync || async, nested);
        for (const arg of node.args) visit(arg, nots, [], false, true);
        return;
      }
      default:
        break;
    }
    const { base, ops } = chainOf(node);
    if (base.k !== 'id' && base.k !== 'this') {
      visit(base, nots, pipes, isAsync, nested);
      for (const op of ops) {
        if (op.op === 'index') visit(op.key, nots, [], false, true);
        if (op.op === 'call') for (const arg of op.args) visit(arg, nots, [], false, true);
      }
      return;
    }
    const segs = [];
    let stop = null;
    let callArgs = null;
    const after = [];
    for (const op of ops) {
      if (stop) break;
      if (op.op === 'skip') continue;
      if (op.op === 'member') {
        segs.push({ name: op.name });
        continue;
      }
      if (op.op === 'index') {
        const literal = literalKey(op.key);
        if (literal) {
          segs.push(literal);
          continue;
        }
        stop = 'dynamic-key';
        after.push(op.key);
        continue;
      }
      if (op.op === 'call') {
        stop = 'call';
        callArgs = op.args;
        for (const arg of op.args) after.push(arg);
      }
    }
    const thisRooted = base.k === 'this';
    let root = thisRooted ? null : base.name;
    let rest = segs;
    if (thisRooted) {
      if (segs.length === 0 || segs[0].name === undefined) {
        stop = stop || 'unsupported-syntax';
        root = 'this';
        rest = [];
      } else {
        root = segs[0].name;
        rest = segs.slice(1);
      }
    }
    reads.push({
      root,
      thisRooted,
      segs: rest,
      stop,
      callArgs,
      negated: nots % 2 === 1,
      pipes: [...pipes],
      async: isAsync,
      nested,
      start: node.start,
      end: node.end,
    });
    for (const inner of after) visit(inner, nots, [], false, true);
  };
  visit(ast, 0, [], false, false);
  return reads;
}

function renderSegs(segs) {
  return segs
    .map((seg) => {
      if (seg.iter) return '[]';
      if (seg.key !== undefined) {
        if (seg.numeric) return `[${seg.key}]`;
        return IDENT_RE.test(seg.key) ? `.${seg.key}` : `['${seg.key}']`;
      }
      return `.${seg.name}`;
    })
    .join('');
}

function renderPath(root, segs) {
  return `${root}${renderSegs(segs)}`;
}

/**
 * What a value expression is to a trace: one path (the trace follows it, keeping the
 * suffix it came with), a path under the `async` pipe, a literal, a stop, or a compound
 * whose own reads are each a branch.
 */
function classifyValue(ast) {
  const node = unwrap(ast);
  if (!node) return { kind: 'error' };
  if (node.k === 'lit') return { kind: 'literal', text: node.text };
  if (node.k === 'pipe') {
    const inner = classifyValue(node.expr);
    if (node.name === 'async' && inner.kind === 'path') return { kind: 'async', read: inner.read, node };
    if (inner.kind === 'path' || inner.kind === 'async') return inner;
    return { kind: 'compound', reads: collectReads(node).filter((read) => !read.nested) };
  }
  if (['id', 'this', 'member', 'index', 'call'].includes(node.k)) {
    const reads = collectReads(node);
    const own = reads.filter((read) => !read.nested);
    if (own.length === 1 && own[0].start === node.start && own[0].end === node.end) {
      return own[0].stop ? { kind: 'stop', read: own[0] } : { kind: 'path', read: own[0] };
    }
    return { kind: 'compound', reads: own };
  }
  const reads = collectReads(node).filter((read) => !read.nested);
  if (reads.length === 0) return literalOnly(node) ? { kind: 'literal', text: null, node } : { kind: 'error' };
  return { kind: 'compound', reads };
}

function literalOnly(node) {
  const inner = unwrap(node);
  if (!inner) return false;
  if (inner.k === 'lit') return true;
  if (inner.k === 'not') return literalOnly(inner.expr);
  if (inner.k === 'bin') return literalOnly(inner.left) && literalOnly(inner.right);
  if (inner.k === 'cond') return literalOnly(inner.test) && literalOnly(inner.then) && literalOnly(inner.else);
  return false;
}

/* ------------------------------------------------------------------------------------ */
/* Text positions and splitting                                                          */
/* ------------------------------------------------------------------------------------ */

/** Lines and 1-based columns of one file's text, by offset. */
function makeHost(file, text) {
  const source = typeof text === 'string' ? text : '';
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return {
    file,
    at(offset) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { file, line: lo + 1, column: offset - starts[lo] + 1 };
    },
  };
}

function compareLoc(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return (a.column || 0) - (b.column || 0);
}

/** Split `text` at each top-level `sep` (outside quotes and brackets), keeping offsets. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipString(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i);
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
    i += 1;
  }
  parts.push({ text: text.slice(start), start });
  return parts.map((part) => {
    const lead = part.text.length - part.text.trimStart().length;
    return { text: part.text.trim(), start: part.start + lead };
  });
}

function skipWs(text, i, limit = text.length) {
  let j = i;
  while (j < limit && /\s/.test(text[j])) j += 1;
  return j;
}

function prevNonWs(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  return j;
}

/** The `(` that opens the `)` at `close`, read backwards over `masked` text, or -1. */
function matchBackward(masked, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const ch = masked[i];
    if (ch === ')' || ch === ']' || ch === '}') depth += 1;
    else if (ch === '(' || ch === '[' || ch === '{') {
      depth -= 1;
      if (depth === 0) return ch === '(' ? i : -1;
    }
  }
  return -1;
}

/**
 * Where an expression that starts at `start` ends: a top-level `;` or `,`, a closer it did
 * not open, or a line break after which the statement cannot go on. TypeScript inserts the
 * semicolon a class field or an assignment usually leaves out.
 */
function expressionEnd(code, start, limit) {
  let depth = 0;
  let i = start;
  while (i < limit) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === ',')) return i;
    if (depth === 0 && ch === '\n') {
      const before = prevNonWs(code, i);
      const after = skipWs(code, i, limit);
      const last = before >= start ? code[before] : '';
      const next = code[after] || '';
      const continues = '=([{,?:|&+-*/.<>!'.includes(last) || '.?:|&+*/=<>'.includes(next) || (next === '-' && code[after + 1] !== '-');
      if (!continues) return i;
    }
    i += 1;
  }
  return limit;
}

/** Identifier names a parameter list or a destructuring pattern binds. */
function patternNames(text) {
  const names = [];
  for (const part of splitTop(text, ',')) {
    let item = part.text;
    if (item === '') continue;
    if (item.startsWith('...')) item = item.slice(3).trim();
    const eq = splitTop(item, '=');
    item = eq[0].text;
    if (item.startsWith('{') || item.startsWith('[')) {
      const close = matchBalanced(item, 0);
      const inner = item.slice(1, close === -1 ? item.length : close);
      for (const entry of splitTop(inner, ',')) {
        const colon = splitTop(entry.text, ':');
        const target = colon.length > 1 ? colon.slice(1).map((c) => c.text).join(':') : colon[0].text;
        names.push(...patternNames(target));
      }
      continue;
    }
    const typed = splitTop(item, ':')[0].text;
    const name = /^[A-Za-z_$][\w$]*/.exec(typed);
    if (name) names.push(name[0]);
  }
  return names;
}

/**
 * Every nested function in `[start, end)` of `code`: arrows and `function` expressions, with
 * the names their parameters bind, their body span and, for an arrow that is the callback of
 * a `.map(` call, the receiver it iterates.
 */
function nestedFunctions(code, masked, start, end) {
  const found = [];
  for (let i = start; i < end - 1; i += 1) {
    if (masked[i] === '=' && masked[i + 1] === '>') {
      const fn = readArrow(code, masked, i, start, end);
      if (fn) found.push(fn);
      continue;
    }
    if (masked.startsWith('function', i) && !/[\w$]/.test(masked[i - 1] || '') && !/[\w$]/.test(masked[i + 8] || '')) {
      const open = masked.indexOf('(', i + 8);
      if (open === -1 || open >= end) continue;
      const close = matchBalanced(masked, open);
      if (close === -1) continue;
      const bodyOpen = masked.indexOf('{', close);
      if (bodyOpen === -1 || bodyOpen >= end) continue;
      const bodyClose = matchBalanced(masked, bodyOpen);
      if (bodyClose === -1) continue;
      found.push({
        params: patternNames(code.slice(open + 1, close)),
        paramStart: open + 1,
        bodyStart: bodyOpen + 1,
        bodyEnd: bodyClose,
        block: true,
        start: i,
      });
    }
  }
  return found;
}

function readArrow(code, masked, arrowAt, start, end) {
  let p = prevNonWs(masked, arrowAt);
  if (p < start) return null;
  let paramStart;
  let paramText;
  if (masked[p] === ')') {
    const open = matchBackward(masked, p);
    if (open === -1 || open < start) return null;
    paramStart = open + 1;
    paramText = code.slice(open + 1, p);
    p = open;
  } else if (/[\w$]/.test(masked[p])) {
    let q = p;
    while (q > start && /[\w$]/.test(masked[q - 1])) q -= 1;
    paramStart = q;
    paramText = code.slice(q, p + 1);
    p = q;
  } else return null;
  let bodyStart = skipWs(code, arrowAt + 2, end);
  let bodyEnd;
  let block = false;
  if (code[bodyStart] === '{') {
    const close = matchBalanced(masked, bodyStart);
    if (close === -1) return null;
    bodyStart += 1;
    bodyEnd = close;
    block = true;
  } else {
    bodyEnd = expressionEnd(code, bodyStart, end);
  }
  const before = masked.slice(Math.max(start, p - 64), p);
  const mapCall = /\.\s*map\s*\(\s*$/.exec(before);
  let receiver = null;
  if (mapCall) {
    const dot = p - (before.length - mapCall.index);
    receiver = receiverBefore(code, masked, dot, start);
  }
  return {
    params: patternNames(paramText),
    paramText,
    paramStart,
    bodyStart,
    bodyEnd,
    block,
    start: p,
    map: Boolean(mapCall),
    receiver,
  };
}

/** The member chain that ends just before `dot` (the receiver of `.map`), with its offset. */
function receiverBefore(code, masked, dot, limit) {
  let i = dot - 1;
  while (i >= limit && /\s/.test(masked[i])) i -= 1;
  const endAt = i + 1;
  while (i >= limit) {
    const ch = masked[i];
    if (/[\w$.?!]/.test(ch)) {
      i -= 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      let depth = 0;
      let j = i;
      for (; j >= limit; j -= 1) {
        if (masked[j] === ')' || masked[j] === ']') depth += 1;
        else if (masked[j] === '(' || masked[j] === '[') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j < limit) break;
      i = j - 1;
      continue;
    }
    break;
  }
  const startAt = i + 1;
  return { text: code.slice(startAt, endAt), start: startAt };
}

/* ------------------------------------------------------------------------------------ */
/* Imports                                                                               */
/* ------------------------------------------------------------------------------------ */

const IMPORT_RE = /(^|\n)[ \t]*import\s+(?!\()([^;]*?)\s+from\s+(['"])([^'"\n]+)\3/g;

/** Local name -> `{ source, imported }` for each value an import statement binds. */
function readImports(code) {
  const imports = new Map();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(code))) {
    const clause = m[2].replace(/^type\s+/, '');
    const source = m[4];
    const brace = clause.indexOf('{');
    const head = brace === -1 ? clause : clause.slice(0, brace);
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(head);
    if (def && def[1] !== 'type') imports.set(def[1], { source, imported: 'default' });
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) imports.set(ns[1], { source, imported: '*' });
    if (brace !== -1) {
      const close = clause.indexOf('}', brace);
      for (const raw of clause.slice(brace + 1, close === -1 ? clause.length : close).split(',')) {
        const part = raw.trim().replace(/^type\s+/, '');
        const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
        if (aliased) imports.set(aliased[2], { source, imported: aliased[1] });
        else if (IDENT_RE.test(part)) imports.set(part, { source, imported: part });
      }
    }
  }
  return imports;
}

/* ------------------------------------------------------------------------------------ */
/* Class members                                                                         */
/* ------------------------------------------------------------------------------------ */

const MODIFIER_RE = /^(?:public|private|protected|readonly|static|override|declare|abstract|async)\b\s*/;

/**
 * The members a class body declares, read at its top level: fields (with an initializer
 * or none), getters, setters and methods, each with its decorators. Assignments
 * `this.x = …` anywhere in the body are listed separately. Constructor parameter
 * properties are injected dependencies, which the caller states.
 */
function readClassModel(code, bodyStart, bodyEnd) {
  const masked = maskLiterals(code);
  const members = new Map();
  const bodies = [];
  const add = (name, entry) => {
    if (!members.has(name)) members.set(name, []);
    members.get(name).push(entry);
  };
  let i = bodyStart;
  let guard = 0;
  while (i < bodyEnd && guard < 100000) {
    guard += 1;
    i = skipWs(code, i, bodyEnd);
    if (i >= bodyEnd) break;
    if (code[i] === ';' || code[i] === ',') {
      i += 1;
      continue;
    }
    const decorators = [];
    while (code[i] === '@') {
      const dm = /^@([A-Za-z_$][\w$.]*)/.exec(code.slice(i, i + 120));
      if (!dm) break;
      let j = i + dm[0].length;
      let args = '';
      const k = skipWs(code, j, bodyEnd);
      if (code[k] === '(') {
        const close = matchBalanced(code, k);
        if (close === -1) break;
        args = code.slice(k + 1, close);
        j = close + 1;
      }
      decorators.push({ name: dm[1], args });
      i = skipWs(code, j, bodyEnd);
    }
    for (let mod = MODIFIER_RE.exec(code.slice(i, i + 40)); mod; mod = MODIFIER_RE.exec(code.slice(i, i + 40))) {
      const after = skipWs(code, i + mod[0].length, bodyEnd);
      if ('(:=;?!<'.includes(code[after])) break;
      i = after;
    }
    let accessor = null;
    const acc = /^(get|set)\s+(?=[A-Za-z_$#])/.exec(code.slice(i, i + 8));
    if (acc) {
      accessor = acc[1];
      i += acc[0].length;
    }
    const nm = /^#?[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 200));
    if (!nm) {
      const close = code[i] === '{' || code[i] === '[' ? matchBalanced(code, i) : -1;
      i = close === -1 ? expressionEnd(code, i + 1, bodyEnd) + 1 : close + 1;
      continue;
    }
    const name = nm[0];
    const nameIndex = i;
    let j = skipWs(code, i + name.length, bodyEnd);
    if (code[j] === '?' || code[j] === '!') j = skipWs(code, j + 1, bodyEnd);
    if (code[j] === '<' || code[j] === '(') {
      let open = j;
      if (code[j] === '<') {
        open = code.indexOf('(', j);
        if (open === -1 || open >= bodyEnd) break;
      }
      const close = matchBalanced(code, open);
      if (close === -1) break;
      let k = close + 1;
      while (k < bodyEnd && code[k] !== '{' && code[k] !== ';' && code[k] !== '}') k += 1;
      if (code[k] !== '{') {
        add(name, { kind: accessor || 'method', name, nameIndex, decorators, paramStart: open + 1, paramEnd: close });
        i = k + 1;
        continue;
      }
      const bodyClose = matchBalanced(code, k);
      if (bodyClose === -1) break;
      const entry = {
        kind: accessor || 'method',
        name,
        nameIndex,
        decorators,
        paramStart: open + 1,
        paramEnd: close,
        bodyStart: k + 1,
        bodyEnd: bodyClose,
      };
      add(name, entry);
      bodies.push(entry);
      i = bodyClose + 1;
      continue;
    }
    let typeEnd = j;
    if (code[j] === ':') {
      typeEnd = typeAnnotationEnd(code, j + 1, bodyEnd);
      j = skipWs(code, typeEnd, bodyEnd);
    }
    if (code[j] === '=' && code[j + 1] !== '=' && code[j + 1] !== '>') {
      const valueStart = skipWs(code, j + 1, bodyEnd);
      const valueEnd = expressionEnd(code, valueStart, bodyEnd);
      const value = code.slice(valueStart, valueEnd).trimEnd();
      const entry = {
        kind: 'field',
        name,
        nameIndex,
        decorators,
        init: { text: value, start: valueStart, end: valueStart + value.length },
      };
      add(name, entry);
      bodies.push({ ...entry, bodyStart: valueStart, bodyEnd: valueStart + value.length, field: true });
      i = valueEnd + 1;
      continue;
    }
    add(name, { kind: 'field', name, nameIndex, decorators, init: null });
    i = code[j] === ';' ? j + 1 : Math.max(j, typeEnd, i + name.length);
  }

  const assignments = [];
  const assignRe = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  assignRe.lastIndex = bodyStart;
  let m;
  while ((m = assignRe.exec(masked)) && m.index < bodyEnd) {
    const before = prevNonWs(masked, m.index);
    if (before >= 0 && masked[before] === '.') continue;
    const valueStart = skipWs(code, m.index + m[0].length, bodyEnd);
    const valueEnd = expressionEnd(code, valueStart, bodyEnd);
    const value = code.slice(valueStart, valueEnd).trimEnd();
    const owner = bodies.find((body) => m.index >= body.bodyStart && m.index < body.bodyEnd) || null;
    assignments.push({
      name: m[1],
      pos: m.index,
      value: { text: value, start: valueStart, end: valueStart + value.length },
      owner,
    });
  }
  return { members, assignments, bodies, masked };
}

/** The end of a type annotation: a top-level `=` or `;`, or a line break that ends it. */
function typeAnnotationEnd(code, start, limit) {
  let depth = 0;
  let i = start;
  while (i < limit) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if ('([{<'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch) || (ch === '>' && code[i - 1] !== '=')) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ';') return i;
      if (ch === '=' && code[i + 1] !== '>') return i;
      if (ch === '\n') {
        const after = skipWs(code, i, limit);
        const before = prevNonWs(code, i);
        if (!'|&'.includes(code[after]) && !'|&:,'.includes(code[before])) return i;
      }
    }
    i += 1;
  }
  return limit;
}

/** Names and key paths a destructuring pattern binds: `{ a, b: { c }, d: e }` binds a, c, e. */
function patternBindings(text, keys = []) {
  const out = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    for (const name of patternNames(trimmed)) out.push({ name, keys, array: true });
    return out;
  }
  if (!trimmed.startsWith('{')) {
    const name = /^[A-Za-z_$][\w$]*/.exec(trimmed);
    if (name) out.push({ name: name[0], keys });
    return out;
  }
  const close = matchBalanced(trimmed, 0);
  const inner = trimmed.slice(1, close === -1 ? trimmed.length : close);
  for (const entry of splitTop(inner, ',')) {
    let item = entry.text;
    if (item === '') continue;
    if (item.startsWith('...')) {
      const rest = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(item);
      if (rest) out.push({ name: rest[1], keys, rest: true });
      continue;
    }
    item = splitTop(item, '=')[0].text;
    const colon = splitTop(item, ':');
    const keyText = colon[0].text;
    const keyName = /^['"]?([^'"]+)['"]?$/.exec(keyText);
    if (!keyName) continue;
    const key = IDENT_RE.test(keyName[1]) ? { name: keyName[1] } : { key: keyName[1] };
    if (colon.length > 1) {
      const target = colon.slice(1).map((c) => c.text).join(':');
      out.push(...patternBindings(target, [...keys, key]));
    } else out.push({ name: keyName[1], keys: [...keys, key] });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Angular templates                                                                     */
/* ------------------------------------------------------------------------------------ */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);
const CONTROL_FLOW_RE = /@(if|else|switch|case|default|for|empty|defer|placeholder|loading|error|let)\b/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/**
 * Read an Angular template: its elements with their bound and static attributes, the
 * display condition and transfer sites, the template locals each element brings into
 * scope, and the rows for each form the reader knows and does not read. `base` is the
 * offset of the template text in the host file, so every position is a file position.
 */
function scanTemplate(text, base) {
  const sites = [];
  const elements = [];
  const rows = [];
  const refs = [];
  const row = (offset, reason, snippet) => rows.push({ offset: base + offset, reason, text: collapse(snippet) });
  const rootScope = [];
  const stack = [{ tag: null, scope: rootScope }];

  const scanText = (from, to) => {
    const chunk = text.slice(from, to);
    CONTROL_FLOW_RE.lastIndex = 0;
    let m;
    while ((m = CONTROL_FLOW_RE.exec(chunk))) {
      const lineEnd = chunk.indexOf('\n', m.index);
      row(from + m.index, 'unsupported-form', chunk.slice(m.index, lineEnd === -1 ? chunk.length : lineEnd));
    }
  };

  let i = 0;
  let textStart = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      scanText(textStart, i);
      const end = text.indexOf('-->', i + 4);
      i = end === -1 ? text.length : end + 3;
      textStart = i;
      continue;
    }
    if (text[i] === '<' && text[i + 1] === '/') {
      scanText(textStart, i);
      const m = /^<\/\s*([\w:-]+)\s*>/.exec(text.slice(i, i + 200));
      if (m) {
        const tag = m[1].toLowerCase();
        for (let k = stack.length - 1; k > 0; k -= 1) {
          if (stack[k].tag === tag) {
            stack.length = k;
            break;
          }
        }
        i += m[0].length;
      } else i += 2;
      textStart = i;
      continue;
    }
    if (text[i] === '<' && /[A-Za-z]/.test(text[i + 1] || '')) {
      scanText(textStart, i);
      const tagMatch = /^<([A-Za-z][\w:-]*)/.exec(text.slice(i, i + 200));
      const tag = tagMatch[1];
      let j = i + tagMatch[0].length;
      const attrs = [];
      let selfClosing = false;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (j >= text.length) break;
        if (text[j] === '>') {
          j += 1;
          break;
        }
        if (text[j] === '/' && text[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        ATTR_RE.lastIndex = j;
        const am = ATTR_RE.exec(text);
        if (!am || am[0].length === 0) {
          j += 1;
          continue;
        }
        const quoted = am[2] !== undefined ? am[2] : am[3];
        const value = quoted !== undefined ? quoted : am[4];
        const valueStart = value === undefined ? -1 : am.index + am[0].length - value.length - (quoted !== undefined ? 1 : 0);
        attrs.push({ name: am[1], value, valueStart, start: am.index, hasValue: value !== undefined });
        j = am.index + am[0].length;
      }
      const parent = stack[stack.length - 1];
      const element = readElement(tag, i, attrs, parent.scope);
      elements.push(element);
      const lower = tag.toLowerCase();
      if (!selfClosing && !VOID_ELEMENTS.has(lower)) stack.push({ tag: lower, scope: element.scope });
      i = j;
      textStart = i;
      continue;
    }
    i += 1;
  }
  scanText(textStart, text.length);

  function readElement(tag, start, attrs, parentScope) {
    const scope = [...parentScope];
    const element = { tag, offset: base + start, bound: new Map(), statics: new Set(), spreads: [], scope };
    const structural = [];
    const others = [];
    for (const attr of attrs) {
      if (attr.name.startsWith('*')) structural.push(attr);
      else others.push(attr);
    }
    for (const attr of others) {
      if (attr.name.startsWith('#') || attr.name.startsWith('ref-')) {
        refs.push(attr.name.replace(/^#|^ref-/, ''));
      } else if (attr.name.startsWith('let-')) {
        scope.push({ name: attr.name.slice(4), kind: 'local', offset: base + attr.start });
      }
    }
    for (const attr of structural) {
      const name = attr.name.slice(1);
      const value = attr.value || '';
      const valueAt = attr.valueStart === -1 ? attr.start : attr.valueStart;
      if (name === 'ngIf') readNgIf(element, attr, value, valueAt, parentScope, scope);
      else if (name === 'ngFor') readNgFor(attr, value, valueAt, parentScope, scope);
      else row(attr.start, 'unsupported-form', `${attr.name}="${value}"`);
    }
    for (const attr of others) readAttribute(element, attr, scope);
    return element;
  }

  function readNgIf(element, attr, value, valueAt, parentScope, scope) {
    const parts = splitTop(value, ';');
    let head = parts[0] || { text: '', start: 0 };
    let alias = null;
    const as = /^([\s\S]*?)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(head.text);
    if (as) {
      alias = as[2];
      head = { text: as[1], start: head.start };
    }
    const site = {
      kind: 'condition',
      form: 'ngIf',
      shows: true,
      text: collapse(value),
      offset: base + attr.start,
      expr: { text: head.text, start: base + valueAt + head.start },
      scope: parentScope,
      pipes: true,
    };
    sites.push(site);
    for (const part of parts.slice(1)) {
      if (part.text === '') continue;
      const m = /^(else|then)\s*:?\s*[A-Za-z_$][\w$]*$/.exec(part.text);
      const letAlias = /^let\s+([A-Za-z_$][\w$]*)\s*(?:=\s*ngIf)?$/.exec(part.text);
      const asAlias = /^ngIf\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part.text);
      if (m) continue;
      if (letAlias || asAlias) {
        alias = (letAlias || asAlias)[1];
        continue;
      }
      row(valueAt + part.start, 'unsupported-syntax', part.text);
    }
    if (alias) scope.push({ name: alias, kind: 'alias', offset: base + attr.start, expr: site.expr, scope: parentScope });
  }

  function readNgFor(attr, value, valueAt, parentScope, scope) {
    const parts = splitTop(value, ';');
    const head = /^let\s+([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/.exec(parts[0] ? parts[0].text : '');
    if (!head) {
      row(valueAt, 'unsupported-syntax', value);
      return;
    }
    const receiverAt = parts[0].text.length - head[2].length;
    // The `of` source is read in the parent scope. It is not a site, but each trace
    // through the local follows it.
    scope.push({
      name: head[1],
      kind: 'iteration',
      offset: base + attr.start,
      expr: { text: head[2].trim(), start: base + valueAt + parts[0].start + receiverAt },
      scope: parentScope,
    });
    for (const part of parts.slice(1)) {
      if (part.text === '') continue;
      const asLocal = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part.text);
      const letLocal = /^let\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*$/.exec(part.text);
      const option = /^[A-Za-z_$][\w$]*\s*:/.test(part.text);
      if (asLocal) scope.push({ name: asLocal[2], kind: 'local', offset: base + valueAt + part.start });
      else if (letLocal) scope.push({ name: letLocal[1], kind: 'local', offset: base + valueAt + part.start });
      else if (!option) row(valueAt + part.start, 'unsupported-syntax', part.text);
    }
  }

  function readAttribute(element, attr, scope) {
    const name = attr.name;
    const valueAt = attr.valueStart === -1 ? attr.start : attr.valueStart;
    const value = attr.value === undefined ? '' : attr.value;
    if (name.startsWith('(') || name.startsWith('on-') || name.startsWith('#') || name.startsWith('ref-') || name.startsWith('let-')) return;
    if (name.startsWith('bind-') || name.startsWith('bindon-')) {
      row(attr.start, 'unsupported-form', `${name}="${value}"`);
      return;
    }
    let form = null;
    let bound = null;
    const two = /^\[\(([^)\]]+)\)\]$/.exec(name);
    const prop = /^\[([^\]]+)\]$/.exec(name);
    if (two) {
      form = 'two-way';
      bound = two[1];
    } else if (prop) {
      bound = prop[1];
      if (bound === 'hidden') {
        sites.push({
          kind: 'condition',
          form: 'hidden',
          shows: false,
          text: collapse(value),
          offset: base + attr.start,
          expr: { text: value, start: base + valueAt },
          scope,
          pipes: true,
        });
        return;
      }
      if (bound === 'ngSwitch' || bound === 'ngIf' || bound === 'ngForOf') {
        row(attr.start, 'unsupported-form', `${name}="${value}"`);
        return;
      }
      const prefixed = /^(attr|class|style)\.(.+)$/.exec(bound);
      if (prefixed) {
        form = prefixed[1];
        bound = prefixed[2];
      } else form = 'property';
    }
    if (!form) {
      element.statics.add(name);
      return;
    }
    const site = {
      kind: 'transfer',
      form,
      tag: element.tag,
      name: bound,
      text: collapse(value),
      offset: base + attr.start,
      expr: { text: value, start: base + valueAt },
      scope,
      pipes: true,
      element,
    };
    sites.push(site);
    if (form === 'property' || form === 'two-way') element.bound.set(bound, site);
  }

  return { sites, elements, rows, refs };
}

/* ------------------------------------------------------------------------------------ */
/* JSX                                                                                   */
/* ------------------------------------------------------------------------------------ */

const JSX_OPENERS = '(,=:?&|{[!;';
const REACT_RESERVED = new Set(['key', 'ref']);

function wordAt(text, i, word) {
  return text.startsWith(word, i) && !/[\w$]/.test(text[i - 1] || '') && !/[\w$]/.test(text[i + word.length] || '');
}

/**
 * Read the JSX of one component body `[start, end)`: the display conditions at the top
 * level of the body and in `.map` iteration bodies, each element's attributes and spreads,
 * and a row for each `||` or `??` render. `masked` is the file with string contents and
 * JSX text blanked, so brackets and keywords in it are code.
 */
function scanJsx(code, masked, start, end, block) {
  const sites = [];
  const elements = [];
  const rows = [];
  let nesting = 0;
  const row = (offset, reason, snippet) => rows.push({ offset, reason, text: collapse(snippet) });

  const opensJsx = (i, from) => {
    if (masked[i] !== '<' || !/[A-Za-z>]/.test(masked[i + 1] || '')) return false;
    const p = prevNonWs(masked, i);
    if (p < from) return true;
    if (JSX_OPENERS.includes(masked[p])) return true;
    return /\breturn$/.test(masked.slice(Math.max(0, p - 5), p + 1));
  };

  const trimSpan = (s, e) => {
    let a = skipWs(masked, s, e);
    let b = e;
    while (b > a && /\s/.test(masked[b - 1])) b -= 1;
    while (masked[a] === '(' && matchBalanced(masked, a) === b - 1) {
      a = skipWs(masked, a + 1, b - 1);
      b -= 1;
      while (b > a && /\s/.test(masked[b - 1])) b -= 1;
    }
    return [a, b];
  };

  const startsJsx = (s, e) => {
    const [a] = trimSpan(s, e);
    return masked[a] === '<' && /[A-Za-z>]/.test(masked[a + 1] || '');
  };

  const condition = (form, shows, s, e, offset) => {
    const [a, b] = trimSpan(s, e);
    sites.push({
      kind: 'condition',
      form,
      shows,
      text: collapse(code.slice(a, b)),
      offset: offset === undefined ? a : offset,
      expr: { text: code.slice(a, b), start: a },
    });
  };

  // Top-level operators of an expression, up to its first JSX element.
  const operators = (s, e) => {
    const ops = [];
    let depth = 0;
    let i = s;
    while (i < e) {
      const ch = masked[i];
      if (ch === "'" || ch === '"') {
        i = skipString(masked, i, ch);
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(masked, i);
        continue;
      }
      if (depth === 0 && opensJsx(i, s)) break;
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) depth -= 1;
      else if (depth === 0) {
        const two = masked.slice(i, i + 2);
        if (two === '&&' || two === '||' || two === '??') {
          ops.push({ op: two, at: i });
          i += 2;
          continue;
        }
        if (ch === '?' && masked[i + 1] !== '.') {
          ops.push({ op: '?', at: i });
          break;
        }
      }
      i += 1;
    }
    return ops;
  };

  // The `:` that closes the conditional whose `?` is at `q`, past any JSX in its branch.
  const ternaryColon = (q, e) => {
    let depth = 0;
    let nested = 0;
    let i = q + 1;
    while (i < e) {
      const ch = masked[i];
      if (ch === "'" || ch === '"') {
        i = skipString(masked, i, ch);
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(masked, i);
        continue;
      }
      if (depth === 0 && opensJsx(i, q + 1)) {
        const after = element(i, e, true);
        i = after === -1 ? i + 1 : after;
        continue;
      }
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) depth -= 1;
      else if (depth === 0 && ch === '?' && masked[i + 1] !== '.' && masked[i + 1] !== '?') nested += 1;
      else if (depth === 0 && ch === ':') {
        if (nested === 0) return i;
        nested -= 1;
      }
      i += 1;
    }
    return -1;
  };

  const value = (s, e, mode) => {
    const [a, b] = trimSpan(s, e);
    if (a >= b) return;
    const ops = operators(a, b);
    const q = ops.find((op) => op.op === '?');
    if (q) {
      const colon = ternaryColon(q.at, b);
      if (colon !== -1 && (startsJsx(q.at + 1, colon) || startsJsx(colon + 1, b))) {
        condition('ternary', 'both', a, q.at);
        walk(q.at + 1, colon, false);
        walk(colon + 1, b, false);
        return;
      }
      walk(a, b, false);
      return;
    }
    const logical = ops.filter((op) => op.op !== '?');
    const last = logical[logical.length - 1];
    if (last && startsJsx(last.at + 2, b)) {
      if (last.op === '&&') {
        if (logical.some((op) => op.op !== '&&')) {
          row(a, 'unsupported-form', code.slice(a, b));
        } else condition(mode === 'return' ? 'return-and' : 'and', true, a, last.at);
      } else row(a, 'unsupported-form', code.slice(a, b));
      walk(last.at + 2, b, false);
      return;
    }
    walk(a, b, false);
  };

  // Read the element that opens at `i`. With `skipOnly` it records nothing.
  function element(i, limit, skipOnly) {
    nesting += 1;
    try {
      if (nesting > MAX_NESTING) {
        if (!skipOnly) row(i, 'unsupported-syntax', code.slice(i, i + 40));
        return limit;
      }
      let j = i + 1;
      const tagMatch = /^[\w$.:-]*/.exec(masked.slice(j, j + 200));
      const tag = tagMatch[0];
      j += tag.length;
      const afterName = /^\s*(\S+)/.exec(masked.slice(j, j + 40));
      if (tag && afterName && (afterName[1].startsWith(',') || /^extends\b/.test(afterName[1]))) return -1;
      const el = { tag, offset: i, bound: new Map(), statics: new Set(), spreads: [] };
      if (!skipOnly && tag) elements.push(el);
      let closed = false;
      while (j < limit) {
        j = skipWs(masked, j, limit);
        const ch = masked[j];
        if (ch === '/' && masked[j + 1] === '>') return j + 2;
        if (ch === '>') {
          j += 1;
          closed = true;
          break;
        }
        if (ch === '{') {
          const close = matchBalanced(masked, j);
          if (close === -1) return limit;
          const inner = skipWs(masked, j + 1, close);
          if (masked.startsWith('...', inner)) {
            const exprStart = skipWs(masked, inner + 3, close);
            const text = code.slice(exprStart, close).trim();
            const site = {
              kind: 'transfer',
              form: 'spread',
              tag,
              name: `...${text}`,
              text: collapse(`...${text}`),
              offset: j,
              expr: { text, start: exprStart },
              element: el,
            };
            if (!skipOnly) {
              sites.push(site);
              el.spreads.push(site);
            }
          } else if (!skipOnly) row(j, 'unsupported-syntax', code.slice(j, close + 1));
          j = close + 1;
          continue;
        }
        const nm = /^[A-Za-z_$][\w$:.-]*/.exec(masked.slice(j, j + 200));
        if (!nm) {
          j += 1;
          continue;
        }
        const name = nm[0];
        const nameAt = j;
        j += name.length;
        const eq = skipWs(masked, j, limit);
        if (masked[eq] !== '=') {
          if (!skipOnly) el.statics.add(name);
          continue;
        }
        const v = skipWs(masked, eq + 1, limit);
        if (masked[v] === '"' || masked[v] === "'") {
          if (!skipOnly) el.statics.add(name);
          j = skipString(masked, v, masked[v]);
          continue;
        }
        if (masked[v] === '{') {
          const close = matchBalanced(masked, v);
          if (close === -1) return limit;
          if (!skipOnly && !/^on[A-Z]/.test(name) && !REACT_RESERVED.has(name)) {
            const text = code.slice(v + 1, close);
            const lead = text.length - text.trimStart().length;
            const site = {
              kind: 'transfer',
              form: 'jsx',
              tag,
              name,
              text: collapse(text),
              offset: nameAt,
              expr: { text: text.trim(), start: v + 1 + lead },
              element: el,
            };
            // An element passed as a prop holds no read of its own; its own elements and
            // containers are read where they stand.
            if (startsJsx(v + 1, close)) {
              site.elementValue = true;
              walk(v + 1, close, false);
            }
            sites.push(site);
            el.bound.set(name, site);
          }
          j = close + 1;
          continue;
        }
        j = v;
      }
      if (!closed) return limit;
      while (j < limit) {
        const ch = masked[j];
        if (ch === '{') {
          const close = matchBalanced(masked, j);
          if (close === -1) return limit;
          if (!skipOnly) container(j + 1, close);
          j = close + 1;
          continue;
        }
        if (ch === '<' && masked[j + 1] === '/') {
          const close = masked.indexOf('>', j);
          return close === -1 ? limit : close + 1;
        }
        if (ch === '<' && /[A-Za-z>]/.test(masked[j + 1] || '')) {
          const after = element(j, limit, skipOnly);
          j = after === -1 ? j + 1 : after;
          continue;
        }
        j += 1;
      }
      return limit;
    } finally {
      nesting -= 1;
    }
  }

  function container(s, e) {
    const inner = code.slice(s, e).trim();
    if (inner === '' || /^\/\*[\s\S]*\*\/$/.test(inner)) return;
    value(s, e, 'container');
  }

  function nestedFunction(fn) {
    if (!fn.map) return;
    if (fn.block) walk(fn.bodyStart, fn.bodyEnd, true);
    else value(fn.bodyStart, fn.bodyEnd, 'container');
  }

  // Walk code `[s, e)`. At the top level of a body (`top`), a `return` and an `if` whose
  // branch returns are display conditions; elsewhere the walk only finds elements and
  // `.map` iteration bodies.
  function walk(s, e, top) {
    let depth = 0;
    let i = s;
    while (i < e) {
      const ch = masked[i];
      if (ch === "'" || ch === '"') {
        i = skipString(masked, i, ch);
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(masked, i);
        continue;
      }
      if (ch === '=' && masked[i + 1] === '>') {
        const fn = readArrow(code, masked, i, s, e);
        if (fn) {
          nestedFunction(fn);
          i = fn.block ? fn.bodyEnd + 1 : Math.max(fn.bodyEnd, i + 2);
          continue;
        }
        i += 2;
        continue;
      }
      if (wordAt(masked, i, 'function')) {
        const open = masked.indexOf('(', i);
        const close = open === -1 ? -1 : matchBalanced(masked, open);
        const body = close === -1 ? -1 : masked.indexOf('{', close);
        const bodyClose = body === -1 || body >= e ? -1 : matchBalanced(masked, body);
        i = bodyClose === -1 ? i + 8 : bodyClose + 1;
        continue;
      }
      if (top && depth === 0 && wordAt(masked, i, 'return')) {
        const exprEnd = expressionEnd(masked, i + 6, e);
        value(i + 6, exprEnd, 'return');
        i = exprEnd;
        continue;
      }
      if (top && depth === 0 && wordAt(masked, i, 'if')) {
        const open = skipWs(masked, i + 2, e);
        const close = masked[open] === '(' ? matchBalanced(masked, open) : -1;
        if (close !== -1) {
          const k = skipWs(masked, close + 1, e);
          let returns = -1;
          let blockEnd = -1;
          if (wordAt(masked, k, 'return')) returns = k;
          else if (masked[k] === '{') {
            blockEnd = matchBalanced(masked, k);
            const first = skipWs(masked, k + 1, e);
            if (blockEnd !== -1 && wordAt(masked, first, 'return')) returns = first;
          }
          if (returns !== -1) {
            condition('early-return', false, open + 1, close, i);
            if (blockEnd !== -1) {
              walk(k + 1, blockEnd, false);
              i = blockEnd + 1;
            } else {
              const exprEnd = expressionEnd(masked, returns + 6, e);
              walk(returns + 6, exprEnd, false);
              i = exprEnd;
            }
            continue;
          }
          i = close + 1;
          continue;
        }
      }
      if (opensJsx(i, s)) {
        const after = element(i, e, false);
        i = after === -1 ? i + 1 : after;
        continue;
      }
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      i += 1;
    }
  }

  if (block) walk(start, end, true);
  else value(start, end, 'return');
  return { sites, elements, rows };
}

/* ------------------------------------------------------------------------------------ */
/* Scopes                                                                                */
/* ------------------------------------------------------------------------------------ */

const DECL_RE = /\b(const|let|var)\s+/g;

/** `const`, `let` and `var` declarations in `[start, end)`, each with its value span. */
function readDecls(code, masked, start, end) {
  const decls = [];
  DECL_RE.lastIndex = start;
  let m;
  while ((m = DECL_RE.exec(masked)) && m.index < end) {
    let i = m.index + m[0].length;
    let patternEnd;
    if (masked[i] === '{' || masked[i] === '[') {
      const close = matchBalanced(masked, i);
      if (close === -1) continue;
      patternEnd = close + 1;
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i, i + 200));
      if (!name) continue;
      patternEnd = i + name[0].length;
    }
    const pattern = code.slice(i, patternEnd);
    let j = skipWs(masked, patternEnd, end);
    if (masked[j] === ':') j = skipWs(masked, typeAnnotationEnd(masked, j + 1, end), end);
    let value = null;
    if (masked[j] === '=' && masked[j + 1] !== '=') {
      const valueStart = skipWs(masked, j + 1, end);
      const valueEnd = expressionEnd(masked, valueStart, end);
      const text = code.slice(valueStart, valueEnd).trimEnd();
      value = { text, start: valueStart };
    }
    for (const binding of patternBindings(pattern)) {
      decls.push({
        ...binding,
        kind: m[1],
        pos: namePosition(code, i, patternEnd, binding.name),
        declStart: m.index,
        pattern,
        destructured: masked[i] === '{' || masked[i] === '[',
        value,
      });
    }
  }
  return decls;
}

/** Where a bound name stands in a pattern: the occurrence that is not a key before `:`. */
function namePosition(code, start, end, name) {
  const re = new RegExp(`(^|[^\\w$.])(${name.replace(/\$/g, '\\$')})(?![\\w$])`, 'g');
  const text = code.slice(start, end);
  let m;
  let fallback = start;
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length;
    if (fallback === start) fallback = start + at;
    const after = skipWs(text, at + name.length);
    if (text[after] !== ':') return start + at;
  }
  return fallback;
}

function reassignments(masked, name, start, end, skip) {
  const found = [];
  const re = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*=(?![=>])`, 'g');
  re.lastIndex = start;
  let m;
  while ((m = re.exec(masked)) && m.index < end) {
    const at = m.index + m[1].length;
    if (skip.has(at)) continue;
    found.push({ pos: at, valueStart: m.index + m[0].length });
  }
  return found;
}

/* ------------------------------------------------------------------------------------ */
/* Regions                                                                               */
/* ------------------------------------------------------------------------------------ */

function baseRegion(input, framework, regionKind) {
  return {
    framework,
    regionKind,
    component: input.component,
    classFile: input.classFile || input.file,
    file: input.file || input.classFile,
    rows: [],
    sites: [],
    elements: [],
    refs: [],
    parents: [],
    failure: null,
  };
}

function internalRegion(region, offset) {
  region.sites = [];
  region.elements = [];
  region.rows = [{ offset, reason: 'unsupported-syntax', text: '', internal: true }];
  return region;
}

function codeContext(code, bodyStart, bodyEnd) {
  const masked = maskLiterals(code);
  const nested = nestedFunctions(code, masked, bodyStart, bodyEnd);
  return { code, masked, nested, imports: readImports(code) };
}

/**
 * One Angular component region. `input`: `component`, `classFile`, `code` (the `.ts`
 * text with comments blanked), `bodyStart` and `bodyEnd` of the class body, `injected`
 * (`[{ name, type }]` of constructor and `inject()` members) and `template`, one of
 * `{ file, text }` (an external template), `{ text, start, propertyOffset }` (an inline
 * one) or `{ failure, propertyOffset }`.
 */
export function angularRegion(input) {
  const region = baseRegion(input, 'angular', 'template');
  const template = input.template;
  const host = makeHost(input.classFile, input.code);
  region.classHost = host;
  try {
    const ctx = codeContext(input.code, input.bodyStart, input.bodyEnd);
    ctx.host = host;
    ctx.model = readClassModel(input.code, input.bodyStart, input.bodyEnd);
    ctx.injected = new Map((input.injected || []).map((field) => [field.name, field]));
    ctx.decls = readDecls(input.code, ctx.masked, input.bodyStart, input.bodyEnd);
    ctx.containers = [
      ...ctx.model.bodies.filter((body) => !body.field).map((body) => ({
        start: body.bodyStart,
        end: body.bodyEnd,
        method: body,
        params: patternNames(input.code.slice(body.paramStart, body.paramEnd)),
      })),
      ...ctx.nested.map((fn) => ({ start: fn.bodyStart, end: fn.bodyEnd, fn, params: fn.params })),
    ];
    region.ctx = ctx;
    if (template.failure) {
      region.failure = template.failure;
      region.file = input.classFile;
      region.host = host;
      region.scanOffset = template.propertyOffset;
      return region;
    }
    if (template.file) {
      region.file = template.file;
      region.host = makeHost(template.file, template.text);
      region.scanOffset = 0;
      region.componentFile = input.classFile;
      Object.assign(region, scanTemplate(template.text, 0));
    } else {
      region.file = input.classFile;
      region.host = host;
      region.scanOffset = template.propertyOffset;
      Object.assign(region, scanTemplate(template.text, template.start));
    }
  } catch (error) {
    if (!region.host) region.host = host;
    if (region.scanOffset === undefined) region.scanOffset = template.propertyOffset || 0;
    region.ctx = region.ctx || { code: input.code, masked: input.code, nested: [], imports: new Map(), model: { members: new Map(), assignments: [], bodies: [] }, injected: new Map(), decls: [], containers: [] };
    internalRegion(region, region.scanOffset);
  }
  return region;
}

/**
 * One React component region. `input`: `component`, `file`, `code` (the file text),
 * `offset` (where the component is named, for its `client_scan` line), and either
 * `fn` (`{ bodyStart, bodyEnd, block, paramStart, paramEnd }` of a function component) or
 * `classBody` (`{ bodyStart, bodyEnd }` of a class component, read at its `render()`).
 */
export function jsxRegion(input) {
  const region = baseRegion(input, 'react', 'jsx');
  const host = makeHost(input.file, input.code);
  region.host = host;
  region.classHost = host;
  region.scanOffset = input.offset;
  region.propsOffset = input.offset;
  try {
    const jsxMasked = maskCode(input.code, { jsx: true });
    const span = input.fn || input.classBody;
    const ctx = codeContext(input.code, span.bodyStart, span.bodyEnd);
    ctx.masked = jsxMasked;
    ctx.nested = nestedFunctions(input.code, jsxMasked, span.bodyStart, span.bodyEnd);
    ctx.host = host;
    ctx.injected = new Map();
    let body;
    if (input.fn) {
      ctx.model = { members: new Map(), assignments: [], bodies: [] };
      body = { start: input.fn.bodyStart, end: input.fn.bodyEnd, block: input.fn.block };
      const params = input.code.slice(input.fn.paramStart, input.fn.paramEnd);
      const first = splitTop(params, ',')[0];
      if (first && first.text) {
        const paramAt = input.fn.paramStart + first.start;
        region.propsOffset = paramAt;
        if (first.text.startsWith('{')) {
          const close = matchBalanced(first.text, 0);
          const pattern = first.text.slice(0, close === -1 ? first.text.length : close + 1);
          ctx.propsBindings = patternBindings(pattern).map((binding) => ({
            ...binding,
            pos: namePosition(input.code, paramAt, paramAt + pattern.length, binding.name),
            pattern,
          }));
        } else {
          const name = /^[A-Za-z_$][\w$]*/.exec(first.text);
          if (name) ctx.propsName = name[0];
        }
      }
    } else {
      ctx.model = readClassModel(input.code, span.bodyStart, span.bodyEnd);
      ctx.classComponent = true;
      const render = (ctx.model.members.get('render') || []).find((entry) => entry.kind === 'method' && entry.bodyStart !== undefined);
      if (!render) {
        region.ctx = ctx;
        ctx.decls = [];
        ctx.containers = [];
        return region;
      }
      body = { start: render.bodyStart, end: render.bodyEnd, block: true };
    }
    ctx.decls = readDecls(input.code, jsxMasked, span.bodyStart, span.bodyEnd);
    ctx.containers = [
      { start: body.start, end: body.end, component: true, params: [] },
      ...ctx.model.bodies.filter((entry) => !entry.field && entry.bodyStart !== body.start).map((entry) => ({
        start: entry.bodyStart,
        end: entry.bodyEnd,
        method: entry,
        params: patternNames(input.code.slice(entry.paramStart, entry.paramEnd)),
      })),
      ...ctx.nested.map((fn) => ({ start: fn.bodyStart, end: fn.bodyEnd, fn, params: fn.params })),
    ];
    region.ctx = ctx;
    Object.assign(region, scanJsx(input.code, jsxMasked, body.start, body.end, body.block));
  } catch (error) {
    region.ctx = region.ctx || { code: input.code, masked: input.code, nested: [], imports: new Map(), model: { members: new Map(), assignments: [], bodies: [] }, injected: new Map(), decls: [], containers: [] };
    internalRegion(region, input.offset);
  }
  return region;
}

/* ------------------------------------------------------------------------------------ */
/* Traces                                                                                */
/* ------------------------------------------------------------------------------------ */

function regionKey(file, component) {
  return `${file}#${component}`;
}

function absoluteRead(read, base) {
  return { ...read, start: read.start + base, end: read.end + base };
}

function containerOf(ctx, pos) {
  let best = null;
  for (const c of ctx.containers) {
    if (pos < c.start || pos >= c.end) continue;
    if (!best || c.end - c.start < best.end - best.start) best = c;
  }
  return best;
}

function containersAt(ctx, pos) {
  return ctx.containers
    .filter((c) => pos >= c.start && pos < c.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
}

function isStoreType(type) {
  return /^Store\b/.test(String(type || '').trim());
}

function importedFrom(ctx, name, source, imported) {
  const entry = ctx.imports.get(name);
  return Boolean(entry && entry.source === source && entry.imported === imported);
}

function callsImported(ctx, node, source, imported) {
  const inner = unwrap(node);
  if (!inner || inner.k !== 'call') return false;
  const callee = unwrap(inner.callee);
  return Boolean(callee && callee.k === 'id' && importedFrom(ctx, callee.name, source, imported));
}

/** The reason a read that stops at a call ends with: a framework store call, or `call`. */
function stopReason(place, read) {
  if (read.stop !== 'call') return read.stop;
  const ctx = place.region.ctx;
  if (!read.thisRooted && read.segs.length === 0) {
    if (importedFrom(ctx, read.root, 'react-redux', 'useSelector')) return 'store-selector';
    if (importedFrom(ctx, read.root, '@ngrx/store', 'select')) return 'store-selector';
  }
  const member = read.thisRooted || place.kind === 'template';
  const injected = member ? ctx.injected.get(read.root) : null;
  if (injected && isStoreType(injected.type) && read.segs.length === 1) {
    if (read.segs[0].name === 'select') return 'store-selector';
    if (read.segs[0].name === 'pipe' && (read.callArgs || []).some((arg) => callsImported(ctx, arg, '@ngrx/store', 'select'))) {
      return 'store-selector';
    }
  }
  return 'call';
}

/**
 * Follows reads back to their sources. One tracer serves one extraction: it keeps every
 * binding a trace passed through, so the caller can write each one as a `client_assignment`
 * with the reads of its value.
 */
class Tracer {
  constructor() {
    this.bindings = new Map();
    this.pending = [];
  }

  trace(place, read) {
    const out = { traces: [], done: false };
    this.followRead(place, read, [], [], new Set(), out);
    return out.traces;
  }

  emit(out, hops, end) {
    if (out.done) return;
    if (out.traces.length === TRACE_LIMIT) {
      out.traces[out.traces.length - 1].end = { unresolved: 'trace-limit' };
      out.done = true;
      return;
    }
    out.traces.push({ hops: [...hops], end });
  }

  stop(out, hops, reason) {
    this.emit(out, hops, { unresolved: reason });
  }

  hop(out, hops, host, offset, step, path, next) {
    if (out.done) return;
    if (hops.length >= HOP_LIMIT) {
      this.stop(out, hops, 'depth-limit');
      return;
    }
    const loc = host.at(offset);
    next([...hops, { step, file: loc.file, line: loc.line, column: loc.column, path }]);
  }

  bind(region, entry) {
    const id = `${region.classFile}|${entry.offset}|${entry.target}`;
    if (!this.bindings.has(id)) {
      const binding = { id, region, ...entry };
      this.bindings.set(id, binding);
      this.pending.push(binding);
    }
  }

  followValue(place, text, start, suffix, hops, seen, out) {
    if (out.done) return;
    const parsed = parseExpression(text, { pipes: place.kind === 'template' });
    if (parsed.error) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const value = classifyValue(parsed.ast);
    if (value.kind === 'literal') {
      this.emit(out, hops, { origin: 'literal', text: collapse(value.text === null ? text : value.text) });
      return;
    }
    if (value.kind === 'path' || value.kind === 'stop') {
      this.followRead(place, absoluteRead(value.read, start), suffix, hops, seen, out);
      return;
    }
    if (value.kind === 'async') {
      const read = absoluteRead(value.read, start);
      this.hop(out, hops, place.host, start + value.node.start, 'async', readPath(read, suffix), (next) =>
        this.followRead(place, read, suffix, next, seen, out));
      return;
    }
    if (value.kind === 'compound') {
      for (const read of value.reads) {
        if (out.done) return;
        this.followRead(place, absoluteRead(read, start), [], hops, seen, out);
      }
      return;
    }
    this.stop(out, hops, 'unsupported-syntax');
  }

  followRead(place, read, suffix, hops, seen, out) {
    if (out.done) return;
    if (read.stop) {
      this.stop(out, hops, stopReason(place, read));
      return;
    }
    const segs = [...read.segs, ...suffix];
    if (place.kind === 'template') this.lookupTemplate(place, read.root, segs, hops, seen, out);
    else this.lookupCode(place, read, segs, hops, seen, out);
  }

  lookupTemplate(place, root, segs, hops, seen, out) {
    const path = renderPath(root, segs);
    for (let k = place.scope.length - 1; k >= 0; k -= 1) {
      const frame = place.scope[k];
      if (frame.name !== root) continue;
      if (frame.kind === 'local') {
        this.stop(out, hops, 'unsupported-local');
        return;
      }
      const outer = { ...place, scope: frame.scope };
      const step = frame.kind === 'iteration' ? 'iteration' : 'alias';
      const nextSegs = frame.kind === 'iteration' ? [{ iter: true }, ...segs] : segs;
      this.hop(out, hops, place.host, frame.offset, step, path, (next) =>
        this.followValue(outer, frame.expr.text, frame.expr.start, nextSegs, next, seen, out));
      return;
    }
    if (place.region.refs.includes(root)) {
      this.stop(out, hops, 'unsupported-local');
      return;
    }
    this.lookupMember(place.region, root, segs, hops, seen, out);
  }

  lookupMember(region, name, segs, hops, seen, out) {
    const ctx = region.ctx;
    const path = renderPath(name, segs);
    const id = `${region.classFile}#${region.component}#${name}`;
    if (seen.has(id)) {
      this.stop(out, hops, 'cycle');
      return;
    }
    if (ctx.injected.has(name)) {
      this.stop(out, hops, 'external-root');
      return;
    }
    if (ctx.classComponent && name === 'props') {
      this.propsRoot(region, segs, hops, seen, out);
      return;
    }
    if (ctx.classComponent && name === 'state') {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const entries = (ctx.model.members.get(name) || []).filter((entry) => !(entry.kind === 'set' && !hasInput(entry)));
    const declared = entries.filter((entry) => entry.kind === 'field' || entry.kind === 'get');
    if (declared.length > 1) {
      this.stop(out, hops, 'ambiguous');
      return;
    }
    const branches = [];
    for (const entry of entries) {
      if (entry.kind === 'field' && entry.init) branches.push({ step: 'member', offset: entry.nameIndex, entry });
      if (entry.kind === 'get') branches.push({ step: 'getter', offset: entry.nameIndex, entry });
      if ((entry.kind === 'field' || entry.kind === 'set') && hasInput(entry)) {
        branches.push({ step: 'input', offset: entry.nameIndex, entry });
      }
    }
    for (const assignment of ctx.model.assignments) {
      if (assignment.name === name) branches.push({ step: 'assignment', offset: assignment.pos, assignment });
    }
    if (branches.length === 0) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    branches.sort((a, b) => a.offset - b.offset);
    const nextSeen = new Set(seen).add(id);
    const host = region.classHost;
    const place = (pos) => ({ kind: 'code', region, host, pos });
    for (const branch of branches) {
      if (out.done) return;
      this.hop(out, hops, host, branch.offset, branch.step, path, (next) => {
        if (branch.step === 'member') {
          const init = branch.entry.init;
          this.bind(region, { target: name, text: init.text, offset: branch.offset, step: 'member', value: init, place: place(init.start) });
          this.followValue(place(init.start), init.text, init.start, segs, next, nextSeen, out);
          return;
        }
        if (branch.step === 'assignment') {
          const value = branch.assignment.value;
          this.bind(region, { target: name, text: value.text, offset: branch.offset, step: 'assignment', value, place: place(value.start) });
          this.followValue(place(value.start), value.text, value.start, segs, next, nextSeen, out);
          return;
        }
        if (branch.step === 'getter') {
          const ret = singleReturn(ctx.code, branch.entry);
          if (!ret) {
            this.stop(out, next, 'unsupported-syntax');
            return;
          }
          this.bind(region, { target: name, text: ret.text, offset: branch.offset, step: 'getter', value: ret, place: place(ret.start) });
          this.followValue(place(ret.start), ret.text, ret.start, segs, next, nextSeen, out);
          return;
        }
        this.crossing(region, inputName(branch.entry), segs, next, nextSeen, out);
      });
    }
  }

  lookupCode(place, read, segs, hops, seen, out) {
    const region = place.region;
    const ctx = region.ctx;
    if (read.thisRooted) {
      this.lookupMember(region, read.root, segs, hops, seen, out);
      return;
    }
    const name = read.root;
    for (const container of containersAt(ctx, place.pos)) {
      const decls = ctx.decls.filter((decl) => decl.name === name && containerOf(ctx, decl.pos) === container);
      if (decls.length > 1) {
        this.stop(out, hops, 'ambiguous');
        return;
      }
      if (decls.length === 1) {
        this.resolveDecl(region, container, decls[0], segs, hops, seen, out);
        return;
      }
      if (container.fn && container.params.includes(name)) {
        this.fromParameter(region, container.fn, name, segs, hops, seen, out);
        return;
      }
      if (container.method && container.params.includes(name)) {
        this.stop(out, hops, 'unsupported-syntax');
        return;
      }
      if (container.component) {
        if (ctx.propsName === name) {
          this.propsRoot(region, segs, hops, seen, out);
          return;
        }
        const binding = (ctx.propsBindings || []).find((entry) => entry.name === name);
        if (binding) {
          if (binding.rest) {
            this.stop(out, hops, 'unsupported-syntax');
            return;
          }
          this.hop(out, hops, region.host, binding.pos, 'destructure', renderPath(name, segs), (next) => {
            this.bind(region, { target: name, text: collapse(binding.pattern), offset: binding.pos, step: 'destructure', value: null });
            this.propsRoot(region, [...binding.keys, ...segs], next, seen, out);
          });
          return;
        }
      }
    }
    this.stop(out, hops, 'external-root');
  }

  fromParameter(region, fn, name, segs, hops, seen, out) {
    if (!fn.map || !fn.receiver) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const first = splitTop(fn.paramText.replace(/^\(|\)$/g, ''), ',')[0];
    const bindings = first ? patternBindings(first.text) : [];
    const binding = bindings.find((entry) => entry.name === name);
    if (!binding || binding.rest || binding.array) {
      this.stop(out, hops, 'unsupported-local');
      return;
    }
    const offset = namePosition(region.ctx.code, fn.paramStart, fn.paramStart + fn.paramText.length, name);
    const place = { kind: 'code', region, host: region.classHost, pos: fn.receiver.start };
    this.hop(out, hops, region.classHost, offset, 'iteration', renderPath(name, segs), (next) =>
      this.followValue(place, fn.receiver.text, fn.receiver.start, [{ iter: true }, ...binding.keys, ...segs], next, seen, out));
  }

  resolveDecl(region, container, decl, segs, hops, seen, out) {
    const ctx = region.ctx;
    const id = `${region.classFile}#decl:${decl.pos}`;
    if (seen.has(id)) {
      this.stop(out, hops, 'cycle');
      return;
    }
    if (decl.array || decl.rest) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const branches = [];
    if (decl.value) branches.push({ step: decl.destructured ? 'destructure' : 'alias', offset: decl.pos, value: decl.value });
    if (decl.kind !== 'const' && !decl.destructured) {
      const skip = new Set([decl.pos]);
      for (const re of reassignments(ctx.masked, decl.name, container.start, container.end, skip)) {
        const valueStart = skipWs(ctx.code, re.valueStart, container.end);
        const valueEnd = expressionEnd(ctx.masked, valueStart, container.end);
        branches.push({
          step: 'assignment',
          offset: re.pos,
          value: { text: ctx.code.slice(valueStart, valueEnd).trimEnd(), start: valueStart },
        });
      }
    }
    if (branches.length === 0) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const nextSeen = new Set(seen).add(id);
    const path = renderPath(decl.name, segs);
    for (const branch of branches) {
      if (out.done) return;
      const place = { kind: 'code', region, host: region.classHost, pos: branch.value.start };
      const nextSegs = branch.step === 'destructure' ? [...decl.keys, ...segs] : segs;
      const text = branch.step === 'destructure' ? `${decl.pattern} = ${branch.value.text}` : branch.value.text;
      this.hop(out, hops, region.classHost, branch.offset, branch.step, path, (next) => {
        this.bind(region, { target: decl.name, text, offset: branch.offset, step: branch.step, value: branch.value, place });
        this.followValue(place, branch.value.text, branch.value.start, nextSegs, next, nextSeen, out);
      });
    }
  }

  propsRoot(region, segs, hops, seen, out) {
    if (segs.length === 0 || segs[0].iter) {
      this.stop(out, hops, 'unsupported-syntax');
      return;
    }
    const name = segs[0].name !== undefined ? segs[0].name : segs[0].key;
    this.hop(out, hops, region.host, region.propsOffset, 'prop', renderPath('props', segs), (next) =>
      this.crossing(region, name, segs.slice(1), next, seen, out));
  }

  crossing(child, name, segs, hops, seen, out) {
    if (child.parents.length === 0) {
      this.stop(out, hops, 'no-binding');
      return;
    }
    for (const parent of child.parents) {
      if (out.done) return;
      if (parent.ambiguous) {
        this.stop(out, hops, 'ambiguous');
        continue;
      }
      const site = parent.element.bound.get(name);
      if (site) {
        const place = parent.region.placeOf(site);
        this.hop(out, hops, place.host, site.offset, 'transfer', transferPath(site, segs), (next) =>
          this.followValue(place, site.expr.text, site.expr.start, segs, next, seen, out));
        continue;
      }
      if (parent.element.statics.has(name)) this.stop(out, hops, 'unsupported-form');
      else if (parent.element.spreads.length > 0) this.stop(out, hops, 'spread-props');
      else this.stop(out, hops, 'no-binding');
    }
  }
}

function hasInput(entry) {
  return (entry.decorators || []).some((decorator) => decorator.name === 'Input');
}

function inputName(entry) {
  const decorator = (entry.decorators || []).find((d) => d.name === 'Input');
  const alias = decorator && /^\s*['"]([^'"]+)['"]\s*$/.exec(decorator.args);
  return alias ? alias[1] : entry.name;
}

function singleReturn(code, entry) {
  if (entry.bodyStart === undefined) return null;
  const body = code.slice(entry.bodyStart, entry.bodyEnd);
  const statements = splitTop(body, ';').filter((part) => part.text !== '');
  if (statements.length !== 1) return null;
  const m = /^return\s+([\s\S]+)$/.exec(statements[0].text);
  if (!m) return null;
  const start = entry.bodyStart + statements[0].start + statements[0].text.length - m[1].length;
  return { text: m[1].trim(), start };
}

function readPath(read, suffix = []) {
  if (read.root === 'this' && read.thisRooted) return 'this';
  return renderPath(read.root, [...read.segs, ...suffix]);
}

function transferPath(site, segs) {
  const parsed = parseExpression(site.expr.text, { pipes: site.pipes });
  if (!parsed.error) {
    const value = classifyValue(parsed.ast);
    if (value.kind === 'path' || value.kind === 'stop') return readPath(value.read, segs);
    if (value.kind === 'async') return readPath(value.read, segs);
  }
  return `${collapse(site.expr.text)}${renderSegs(segs)}`;
}

/* ------------------------------------------------------------------------------------ */
/* Facts                                                                                 */
/* ------------------------------------------------------------------------------------ */

function placeFor(region) {
  return (site) =>
    region.framework === 'angular'
      ? { kind: 'template', region, host: region.host, scope: site.scope || [] }
      : { kind: 'code', region, host: region.host, pos: site.expr.start };
}

function located(region, loc) {
  const fields = { file: loc.file, line: loc.line, column: loc.column };
  if (loc.file !== region.classFile) fields.componentFile = region.classFile;
  return fields;
}

function readsOf(text, start, pipes) {
  const parsed = parseExpression(text, { pipes });
  if (parsed.error) return null;
  return collectReads(parsed.ast).map((read) => absoluteRead(read, start));
}

function readFact(region, host, read, traces, context, siteLoc) {
  const loc = host.at(read.start);
  const stopped = traces.find((trace) => trace.end.unresolved);
  const fields = {
    component: region.component,
    path: readPath(read),
    context,
    ...located(region, loc),
    negated: read.negated,
    traces,
  };
  if (stopped) fields.unresolved = stopped.end.unresolved;
  fields.site = { kind: context, file: siteLoc.file, line: siteLoc.line, column: siteLoc.column };
  if (read.pipes.length > 0) fields.pipes = read.pipes;
  return fact('client_read', fields);
}

/**
 * The facts of a set of regions, in a stable order. `resolveTarget(region, element)` names
 * the component an element renders: `{ target: { file, component } }`,
 * `{ candidates: [{ file, component }, …] }` when more than one component answers to it, or
 * nothing. Regions sort by their component file and line; within a region the `client_scan`
 * comes first, then each site with its reads, then each assignment with its reads.
 */
export function clientFacts(regions, { resolveTarget = () => null } = {}) {
  const list = regions.filter(Boolean);
  const byKey = new Map();
  for (const region of list) {
    region.key = regionKey(region.classFile, region.component);
    region.placeOf = placeFor(region);
    region.scanLoc = region.host.at(region.scanOffset || 0);
    if (!byKey.has(region.key)) byKey.set(region.key, region);
  }
  for (const region of list) {
    for (const element of region.elements) {
      const resolved = resolveTarget(region, element) || {};
      if (resolved.target) {
        element.resolved = resolved.target;
        const child = byKey.get(regionKey(resolved.target.file, resolved.target.component));
        if (child) child.parents.push({ region, element });
      } else if (resolved.candidates) {
        for (const candidate of resolved.candidates) {
          const child = byKey.get(regionKey(candidate.file, candidate.component));
          if (child) child.parents.push({ region, element, ambiguous: true });
        }
      }
    }
  }
  for (const region of list) {
    region.parents.sort((a, b) => compareLoc(a.region.host.at(a.element.offset), b.region.host.at(b.element.offset)));
  }
  list.sort((a, b) => {
    const fa = a.componentFile || a.file;
    const fb = b.componentFile || b.file;
    if (fa !== fb) return fa < fb ? -1 : 1;
    if (a.scanLoc.line !== b.scanLoc.line) return a.scanLoc.line - b.scanLoc.line;
    return a.component < b.component ? -1 : a.component > b.component ? 1 : 0;
  });

  const tracer = new Tracer();
  for (const region of list) {
    region.siteEntries = [];
    const sites = [...region.sites].sort((a, b) => compareLoc(region.host.at(a.offset), region.host.at(b.offset)));
    for (const site of sites) {
      const entry = { site, loc: region.host.at(site.offset), reads: [] };
      region.siteEntries.push(entry);
      if (site.elementValue) continue;
      try {
        const reads = readsOf(site.expr.text, site.expr.start, Boolean(site.pipes));
        if (!reads) {
          region.rows.push({ offset: site.expr.start, reason: 'unsupported-syntax', text: collapse(site.expr.text || site.text) });
          continue;
        }
        const place = region.placeOf(site);
        for (const read of reads) {
          entry.reads.push({ read, traces: tracer.trace({ ...place, pos: read.start }, read) });
        }
      } catch (error) {
        entry.reads = [];
        region.rows.push({ offset: site.offset, reason: 'unsupported-syntax', text: '', internal: true });
      }
    }
  }
  while (tracer.pending.length > 0) {
    const binding = tracer.pending.shift();
    binding.reads = [];
    if (!binding.value) continue;
    try {
      const reads = readsOf(binding.value.text, binding.value.start, false) || [];
      for (const read of reads) {
        const place = { kind: 'code', region: binding.region, host: binding.region.classHost, pos: read.start };
        binding.reads.push({ read, traces: tracer.trace(place, read) });
      }
    } catch (error) {
      binding.reads = [];
      binding.region.rows.push({ offset: binding.offset, reason: 'unsupported-syntax', text: '', internal: true });
    }
  }
  const bindingsOf = new Map();
  for (const binding of tracer.bindings.values()) {
    if (!bindingsOf.has(binding.region)) bindingsOf.set(binding.region, []);
    bindingsOf.get(binding.region).push(binding);
  }

  const facts = [];
  for (const region of list) {
    const body = [];
    let conditions = 0;
    let transfers = 0;
    let reads = 0;
    for (const { site, loc, reads: siteReads } of region.siteEntries) {
      if (site.kind === 'condition') {
        conditions += 1;
        body.push(fact('display_condition', {
          component: region.component,
          form: site.form,
          shows: site.shows,
          text: site.text,
          ...located(region, loc),
        }));
      } else {
        transfers += 1;
        const fields = {
          component: region.component,
          target: site.tag,
          name: site.name,
          text: site.text,
          ...located(region, loc),
          form: site.form,
        };
        if (site.element && site.element.resolved) {
          fields.targetFile = site.element.resolved.file;
          fields.targetComponent = site.element.resolved.component;
        }
        body.push(fact('client_transfer', fields));
      }
      for (const { read, traces } of siteReads) {
        reads += 1;
        body.push(readFact(region, region.host, read, traces, site.kind, loc));
      }
    }
    const bindings = (bindingsOf.get(region) || []).sort((a, b) => compareLoc(region.classHost.at(a.offset), region.classHost.at(b.offset)) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
    for (const binding of bindings) {
      const loc = region.classHost.at(binding.offset);
      body.push(fact('client_assignment', {
        component: region.component,
        target: binding.target,
        text: collapse(binding.text),
        ...located(region, loc),
        step: binding.step,
      }));
      for (const { read, traces } of binding.reads) {
        reads += 1;
        body.push(readFact(region, region.classHost, read, traces, 'assignment', loc));
      }
    }
    const status = region.failure ? 'failed' : region.rows.length > 0 ? 'partial' : 'complete';
    const scan = {
      component: region.component,
      region: region.regionKind,
      status,
      ...located(region, { ...region.scanLoc, column: undefined }),
    };
    delete scan.column;
    if (region.failure) scan.reason = region.failure;
    if (region.rows.length > 0) {
      scan.unsupported = region.rows
        .map((entry) => {
          const loc = region.host.at(entry.offset);
          const rowFields = { file: loc.file, line: loc.line, column: loc.column, reason: entry.reason, text: entry.text };
          if (entry.internal) rowFields.internal = true;
          return rowFields;
        })
        .sort((a, b) => compareLoc(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
    }
    scan.counts = { conditions, transfers, assignments: bindings.length, reads };
    facts.push(fact('client_scan', scan), ...body);
  }
  return facts;
}
