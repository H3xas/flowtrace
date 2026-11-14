/**
 * Decisions inside the method bodies of a web or mobile TypeScript file, as `branch_point`
 * facts.
 *
 * It reads masked text only (`maskCode`): string, template, regex and JSX text content is
 * blank, so a `?` or `&&` in prose never reads as code. It does not parse TypeScript. The
 * forms it reads are `if`/`else`, `switch`/`case`, the ternary `?:`, a `&&`/`||` chain and
 * a `??` chain. Loops, `try`/`catch` and optional chaining are not decisions here.
 *
 * Two rules keep the facts one per decision. A `&&`/`||` chain inside the condition of an
 * `if`, a `switch`, a loop or a ternary is part of that decision and gives no fact of its
 * own. And only the outermost chain counts: parentheses, calls and brackets do not start a
 * new chain, an arrow or function body does. So `list.some((x) => x.a && x.b)` inside an
 * `if` condition still gives the callback's own `logical` fact.
 */

import { maskCode } from './text.js';
import { fact } from '../facts.js';

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const TEXT_LIMIT = 120;

/** Words that end the expression before them, so a backward scan stops after them. */
const STOP_WORDS = new Set(['return', 'throw', 'case', 'yield', 'else', 'do', 'of', 'export', 'default']);
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);

/**
 * `spans` are `{ bodyStart, bodyEnd, class, method }`, offsets into `code`. A decision
 * takes the class and method of the innermost span whose body holds it.
 */
export function callerDecisions({ code, spans, relPath, lineOf, jsx = false }) {
  if (!spans || spans.length === 0) return [];
  const jsxExtents = [];
  const masked = maskCode(code, { jsx, jsxExtents });
  const tree = bracketTree(masked);
  const scan = new Scanner(code, masked, tree, lineOf, jsxExtents);

  const seen = new Set();
  const candidates = [];
  for (const span of spans) {
    for (let i = span.bodyStart; i < span.bodyEnd; i += 1) {
      if (seen.has(i)) continue;
      const kind = scan.tokenAt(i);
      if (!kind) continue;
      seen.add(i);
      candidates.push({ at: i, kind });
    }
  }
  candidates.sort((a, b) => a.at - b.at);

  const contexts = scan.contexts(spans);
  const contextOf = (index) => innermost(contexts, index);
  const conditions = [];
  const decisions = [];
  for (const { at, kind } of candidates) {
    if (kind === 'control') {
      const cond = scan.conditionAt(at);
      if (cond) conditions.push(cond);
      continue;
    }
    if (kind === 'if') decisions.push(...scan.ifAt(at));
    else if (kind === 'switch') decisions.push(...scan.switchAt(at));
    else if (kind === 'ternary') {
      const ternary = scan.ternaryAt(at);
      if (ternary) {
        decisions.push(ternary);
        conditions.push({ start: ternary.start, end: at });
      }
    } else decisions.push(...scan.chainAt(at, kind));
  }
  for (const decision of decisions) {
    if (decision.kind === 'if' || decision.kind === 'switch') conditions.push(decision.condition);
  }

  const kept = [];
  const chains = new Map();
  for (const decision of decisions) {
    if (decision.kind !== 'logical' && decision.kind !== 'coalesce') {
      kept.push(decision);
      continue;
    }
    const key = `${decision.kind}:${decision.start}:${decision.end}`;
    if (!chains.has(key)) chains.set(key, decision);
  }
  const chainList = [...chains.values()];
  for (const chain of chainList) {
    const context = contextOf(chain.at);
    const sameContext = (start) => contextOf(start) === context;
    const outer = chainList.some(
      (other) =>
        other !== chain &&
        other.kind === chain.kind &&
        other.start <= chain.start &&
        other.end >= chain.end &&
        other.end - other.start > chain.end - chain.start &&
        sameContext(other.at),
    );
    if (outer) continue;
    if (chain.kind === 'logical') {
      const inCondition = conditions.some(
        (cond) => cond.start <= chain.start && chain.end <= cond.end && sameContext(cond.start),
      );
      if (inCondition) continue;
    }
    kept.push(chain);
  }

  kept.sort((a, b) => a.at - b.at || a.order - b.order);
  const facts = [];
  for (const decision of kept) {
    const span = innermost(spans, decision.at);
    if (!span) continue;
    facts.push(
      fact('branch_point', {
        file: relPath,
        line: decision.line,
        class: span.class,
        method: span.method,
        kind: decision.kind,
        text: decision.text,
        endLine: decision.endLine,
      }),
    );
  }
  return facts;
}

function innermost(spans, index) {
  let best = null;
  for (const span of spans) {
    if (index < span.bodyStart || index >= span.bodyEnd) continue;
    if (!best || span.bodyEnd - span.bodyStart < best.bodyEnd - best.bodyStart) best = span;
  }
  return best;
}

/** The match of every bracket in `masked`, both ways. An unmatched one maps to -1. */
function bracketTree(masked) {
  const match = new Int32Array(masked.length).fill(-1);
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (OPENERS[ch]) stack.push(i);
    else if (CLOSERS[ch]) {
      while (stack.length > 0 && masked[stack[stack.length - 1]] !== CLOSERS[ch]) stack.pop();
      if (stack.length === 0) continue;
      const open = stack.pop();
      match[open] = i;
      match[i] = open;
    }
  }
  return match;
}

/** For every offset, the matched opener that holds it, or -1 at the top level. */
function enclosingOpeners(masked, match) {
  const out = new Int32Array(masked.length).fill(-1);
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (CLOSERS[ch] && stack.length > 0 && match[i] === stack[stack.length - 1]) stack.pop();
    out[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (OPENERS[ch] && match[i] !== -1) stack.push(i);
  }
  return out;
}

const BLOCK_WORDS = new Set(['else', 'try', 'do', 'finally']);
const DECLARE_WORDS = new Set(['const', 'let', 'var', 'readonly', 'public', 'private', 'protected', 'static', 'declare']);

const isIdent = (ch) => /[\w$]/.test(ch || '');
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

class Scanner {
  constructor(code, masked, match, lineOf, jsxExtents = []) {
    this.code = code;
    this.m = masked;
    this.match = match;
    this.lineOf = lineOf;
    this.enclosing = enclosingOpeners(masked, match);
    this.braceKinds = new Map();
    // A JSX element is one operand: a line break inside it never ends a statement, an arm
    // or a chain. Each scan that meets either end of one steps over the whole element.
    this.jsxEnd = new Map();
    this.jsxStart = new Map();
    for (const [start, end] of jsxExtents) {
      if (!this.jsxEnd.has(start) || this.jsxEnd.get(start) < end) this.jsxEnd.set(start, end);
      const last = end - 1;
      if (!this.jsxStart.has(last) || this.jsxStart.get(last) > start) this.jsxStart.set(last, start);
    }
  }

  wordAt(i) {
    if (!isIdent(this.m[i]) || isIdent(this.m[i - 1]) || this.m[i - 1] === '.') return '';
    let j = i;
    while (j < this.m.length && isIdent(this.m[j])) j += 1;
    return this.m.slice(i, j);
  }

  /** The kind of decision token that starts at `i`, `control` for a loop header, or ''. */
  tokenAt(i) {
    const m = this.m;
    const ch = m[i];
    if (ch === 'i' || ch === 's' || ch === 'w' || ch === 'f') {
      const word = this.wordAt(i);
      if (word === 'if' || word === 'switch') return this.nextNonSpace(i + word.length) === '(' ? word : '';
      if (word === 'while' || word === 'for') return 'control';
      return '';
    }
    if (ch === '?') {
      if (m[i + 1] === '?' || m[i - 1] === '?') return m[i - 1] === '?' || m[i + 2] === '=' ? '' : 'coalesce';
      if (m[i + 1] === '.' && !/\d/.test(m[i + 2] || '')) return '';
      return 'ternary';
    }
    if ((ch === '&' || ch === '|') && m[i + 1] === ch && m[i - 1] !== ch && m[i + 2] !== '=') return 'logical';
    return '';
  }

  nextNonSpace(i) {
    let j = i;
    while (j < this.m.length && isSpace(this.m[j])) j += 1;
    return this.m[j];
  }

  skipSpace(i) {
    let j = i;
    while (j < this.m.length && isSpace(this.m[j])) j += 1;
    return j;
  }

  /** Offset of the last non-space character before `end`, at or after `start`. */
  lastNonSpace(start, end) {
    let j = end - 1;
    while (j > start && isSpace(this.m[j])) j -= 1;
    return j;
  }

  text(start, end) {
    return this.code.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
  }

  lines(start, end) {
    const first = this.skipSpace(start);
    return { line: this.lineOf(first), endLine: this.lineOf(Math.max(first, this.lastNonSpace(first, end))) };
  }

  /** The `(` … `)` header of a loop, as a condition region. */
  conditionAt(at) {
    const word = this.wordAt(at);
    let open = this.skipSpace(at + word.length);
    if (word === 'for' && this.m.startsWith('await', open)) open = this.skipSpace(open + 5);
    if (this.m[open] !== '(' || this.match[open] === -1) return null;
    return { start: open + 1, end: this.match[open] };
  }

  /**
   * The end of the statement that starts at `start`: a top-level `;` (included), a closing
   * bracket of the enclosing scope, or a line break where no operator carries the statement on.
   */
  statementEnd(start) {
    let j = start;
    while (j < this.m.length) {
      const ch = this.m[j];
      if (this.jsxEnd.has(j)) {
        j = this.jsxEnd.get(j);
        continue;
      }
      if (OPENERS[ch]) {
        if (this.match[j] === -1) return this.m.length;
        j = this.match[j] + 1;
        continue;
      }
      if (CLOSERS[ch]) return j;
      if (ch === ';') return j + 1;
      if (ch === '\n' && this.endsStatement(start, j)) return j;
      j += 1;
    }
    return j;
  }

  /**
   * The controlled statement after `from`: a block or one statement. An unbraced `if` takes
   * its then statement and its whole `else` chain, and an unbraced loop or `with` takes its
   * head and its body, so an `else` binds once, to the nearest `if`, and the outer statement
   * holds it.
   */
  controlled(from) {
    const start = this.skipSpace(from);
    if (this.m[start] === '{' && this.match[start] !== -1) return { start, end: this.match[start] + 1 };
    const word = this.wordAt(start);
    if (word === 'if' || word === 'while' || word === 'for' || word === 'with') {
      let open = this.skipSpace(start + word.length);
      if (word === 'for' && this.m.startsWith('await', open)) open = this.skipSpace(open + 5);
      if (this.m[open] === '(' && this.match[open] !== -1) {
        const body = this.controlled(this.match[open] + 1);
        const elseAt = this.skipSpace(body.end);
        if (word !== 'if' || this.wordAt(elseAt) !== 'else') return { start, end: body.end };
        return { start, end: this.controlled(elseAt + 4).end };
      }
    }
    return { start, end: this.statementEnd(start) };
  }

  ifAt(at) {
    const open = this.skipSpace(at + 2);
    const close = this.match[open];
    if (close === -1) return [];
    const body = this.controlled(close + 1);
    const decisions = [
      {
        at,
        order: 0,
        kind: 'if',
        text: this.text(at, close + 1),
        line: this.lineOf(at),
        endLine: this.lineOf(Math.max(at, this.lastNonSpace(at, body.end))),
        condition: { start: open + 1, end: close },
      },
    ];
    const elseAt = this.skipSpace(body.end);
    if (this.wordAt(elseAt) !== 'else') return decisions;
    let cursor = this.skipSpace(elseAt + 4);
    let head = elseAt + 4;
    if (this.wordAt(cursor) === 'if') {
      const elseIfOpen = this.skipSpace(cursor + 2);
      if (this.m[elseIfOpen] !== '(' || this.match[elseIfOpen] === -1) return decisions;
      head = this.match[elseIfOpen] + 1;
      cursor = head;
    }
    const elseBody = this.controlled(cursor);
    decisions.push({
      at: elseAt,
      order: 1,
      kind: 'else',
      text: this.text(elseAt, head),
      line: this.lineOf(elseAt),
      endLine: this.lineOf(Math.max(elseAt, this.lastNonSpace(elseAt, elseBody.end))),
    });
    return decisions;
  }

  switchAt(at) {
    const open = this.skipSpace(at + 6);
    const close = this.match[open];
    if (close === -1) return [];
    const bodyOpen = this.skipSpace(close + 1);
    if (this.m[bodyOpen] !== '{' || this.match[bodyOpen] === -1) return [];
    const bodyClose = this.match[bodyOpen];
    const decisions = [
      {
        at,
        order: 0,
        kind: 'switch',
        text: this.text(at, close + 1),
        line: this.lineOf(at),
        endLine: this.lineOf(bodyClose),
        condition: { start: open + 1, end: close },
      },
    ];
    const clauses = [];
    let j = bodyOpen + 1;
    while (j < bodyClose) {
      const ch = this.m[j];
      if (OPENERS[ch] && this.match[j] !== -1) {
        j = this.match[j] + 1;
        continue;
      }
      const word = isIdent(ch) ? this.wordAt(j) : '';
      if (word === 'case' || (word === 'default' && this.nextNonSpace(j + 7) === ':')) {
        const colon = this.clauseColon(j + word.length, bodyClose);
        clauses.push({ at: j, head: colon + 1 });
        j = colon + 1;
        continue;
      }
      j += word ? word.length : 1;
    }
    clauses.forEach((clause, k) => {
      const next = k + 1 < clauses.length ? clauses[k + 1].at : bodyClose;
      decisions.push({
        at: clause.at,
        order: 0,
        kind: 'case',
        text: this.text(clause.at, clause.head),
        line: this.lineOf(clause.at),
        endLine: this.lineOf(Math.max(clause.at, this.lastNonSpace(clause.at, next))),
      });
    });
    return decisions;
  }

  /** The `:` that ends a `case` label, stepping over brackets and a ternary inside it. */
  clauseColon(from, limit) {
    let pending = 0;
    let j = from;
    while (j < limit) {
      const ch = this.m[j];
      if (OPENERS[ch] && this.match[j] !== -1) {
        j = this.match[j] + 1;
        continue;
      }
      if (ch === '?' && this.tokenAt(j) === 'ternary') pending += 1;
      if (ch === ':') {
        if (pending === 0) return j;
        pending -= 1;
      }
      j += 1;
    }
    return limit - 1;
  }

  /**
   * Does a line break at `at` end the statement? Not when the text before it ends on an
   * operator or an opener, or the next line starts with one: either carries the expression on.
   */
  endsStatement(from, at) {
    const before = this.lastNonSpace(from, at);
    const prev = this.m[before];
    if (before < from) return false;
    if (!this.jsxStart.has(before) && /[=+\-*/%&|^!~<>?:,.(\[{]/.test(prev)) return false;
    const next = this.skipSpace(at);
    const head = this.m[next];
    if (/[=+\-*/%&|^<>?:.,)\]}]/.test(head)) return false;
    if (this.m.startsWith('as ', next) || this.m.startsWith('instanceof', next)) return false;
    return true;
  }

  /** Step back over a type-argument list `<…>` that a call's `(` follows, or return `j`. */
  typeArgsBack(j) {
    if (this.m[j] !== '>' || this.m[j - 1] === '=' || this.nextNonSpace(j + 1) !== '(') return j;
    let depth = 0;
    for (let k = j; k >= 0 && j - k < 200; k -= 1) {
      const ch = this.m[k];
      if (ch === '>') depth += 1;
      else if (ch === '<') {
        depth -= 1;
        if (depth === 0) return isIdent(this.m[k - 1]) ? k - 1 : j;
      } else if (ch === ';' || ch === '{' || ch === '}') return j;
    }
    return j;
  }

  /** Step over a type-argument list `<…>` that a call's `(` follows, or return `j`. */
  typeArgsForward(j) {
    if (this.m[j] !== '<' || !isIdent(this.m[j - 1])) return j;
    let depth = 0;
    for (let k = j; k < this.m.length && k - j < 200; k += 1) {
      const ch = this.m[k];
      if (ch === '<') depth += 1;
      else if (ch === '>') {
        depth -= 1;
        if (depth === 0) return this.nextNonSpace(k + 1) === '(' ? k + 1 : j;
      } else if (ch === ';' || ch === '{' || ch === '}') return j;
    }
    return j;
  }

  /**
   * The start of the expression that holds the operator at `at`, scanning back at its own
   * bracket level. It stops at an opener, `,`, `;`, `}`, a ternary `?` or `:`, an assignment,
   * `=>`, a statement keyword, or a line break that ends a statement.
   */
  exprStart(at) {
    const m = this.m;
    let j = at - 1;
    let start = at;
    while (j >= 0) {
      const ch = m[j];
      if (this.jsxStart.has(j)) {
        start = this.jsxStart.get(j);
        j = start - 1;
        continue;
      }
      if (isSpace(ch)) {
        if (ch === '\n' && start < at && this.endsStatement(0, j) && !this.continuesAt(start)) return start;
        j -= 1;
        continue;
      }
      if (ch === ')' || ch === ']') {
        const open = this.match[j];
        if (open === -1) return start;
        const word = this.wordBefore(open);
        if (ch === ')' && CONTROL_WORDS.has(word)) return start;
        start = open;
        j = open - 1;
        continue;
      }
      if (ch === '>' ) {
        const back = this.typeArgsBack(j);
        if (back !== j) {
          start = back + 1;
          j = back;
          continue;
        }
        if (m[j - 1] === '=') return start;
      }
      if (OPENERS[ch] || ch === '}' || ch === ',' || ch === ';' || ch === ':') return start;
      if (ch === '?' && this.tokenAt(j) === 'ternary') return start;
      if (ch === '=' && !/[=!<>]/.test(m[j - 1]) && m[j + 1] !== '=' && m[j + 1] !== '>') return start;
      if (isIdent(ch)) {
        let k = j;
        while (k >= 0 && isIdent(m[k])) k -= 1;
        const word = m.slice(k + 1, j + 1);
        if (STOP_WORDS.has(word) && m[k] !== '.') return start;
        start = k + 1;
        j = k;
        continue;
      }
      start = j;
      j -= 1;
    }
    return start;
  }

  /** Does the text at `at` continue an expression from the line before? */
  continuesAt(at) {
    return /[=+\-*/%&|^<>?:.]/.test(this.m[at] || '');
  }

  wordBefore(index) {
    let j = index - 1;
    while (j >= 0 && isSpace(this.m[j])) j -= 1;
    let k = j;
    while (k >= 0 && isIdent(this.m[k])) k -= 1;
    return this.m.slice(k + 1, j + 1);
  }

  /**
   * The end of the expression that goes on from `from` at its own bracket level. A chain
   * stops at a ternary `?` or `:`, and with `ternary` set a `:` closes only the arms it opened.
   */
  exprEnd(from, { ternary = false } = {}) {
    const m = this.m;
    let pending = 0;
    let j = from;
    while (j < m.length) {
      const ch = m[j];
      if (this.jsxEnd.has(j)) {
        j = this.jsxEnd.get(j);
        continue;
      }
      if (OPENERS[ch]) {
        if (this.match[j] === -1) return m.length;
        j = this.match[j] + 1;
        continue;
      }
      if (ch === '<') {
        const after = this.typeArgsForward(j);
        if (after !== j) {
          j = after;
          continue;
        }
      }
      if (CLOSERS[ch] || ch === ',' || ch === ';') return j;
      if (ch === '\n' && this.endsStatement(from, j)) return j;
      if (ch === '?' && this.tokenAt(j) === 'ternary') {
        if (!ternary) return j;
        pending += 1;
      } else if (ch === ':') {
        if (pending === 0) return j;
        pending -= 1;
      }
      j += 1;
    }
    return j;
  }

  /**
   * The ternary whose `?` is at `at`. A `?` followed by `:`, `)`, `,`, `;`, `=` or a closer is
   * an optional marker, one with no `:` of its own is no ternary, and one whose condition
   * holds a top-level `extends` is a conditional type.
   */
  ternaryAt(at) {
    const next = this.nextNonSpace(at + 1);
    if (next === undefined || /[:),;=\]}]/.test(next)) return null;
    if (this.optionalMethod(at)) return null;
    const colon = this.exprEnd(at + 1, { ternary: true });
    if (this.m[colon] !== ':') return null;
    const start = this.exprStart(at);
    if (/(^|[^\w$.])extends(?![\w$])/.test(this.topLevel(start, at))) return null;
    const end = this.exprEnd(colon + 1, { ternary: true });
    return { at, start, end, order: 0, kind: 'ternary', text: this.text(start, end), ...this.lines(start, end) };
  }

  /**
   * Whether the `?` at `at` marks an optional member rather than a ternary. The bracket that
   * holds it decides: in a type literal, an interface body or a type argument no `?` is a
   * ternary, and in a class body a `?` before `(` marks an optional method. Everywhere else,
   * in a block, parentheses, brackets or an object literal, the `?` reads as a ternary.
   */
  optionalMethod(at) {
    const kind = this.contextOf(at);
    if (kind === 'type') return true;
    return kind === 'class' && this.nextNonSpace(at + 1) === '(';
  }

  /** `type`, `class`, `block`, `object` or `expression`: what the innermost bracket of `at` is. */
  contextOf(at) {
    const open = this.enclosing[at];
    if (open === -1) return this.inTypeArguments(at) ? 'type' : 'block';
    if (this.m[open] !== '{') return this.inTypeArguments(at, open) ? 'type' : 'expression';
    return this.braceKind(open);
  }

  /** What the `{` at `open` opens: a type literal or interface body, a class body, a block or an object literal. */
  braceKind(open) {
    if (this.braceKinds.has(open)) return this.braceKinds.get(open);
    this.braceKinds.set(open, 'block');
    const kind = this.readBraceKind(open);
    this.braceKinds.set(open, kind);
    return kind;
  }

  readBraceKind(open) {
    const m = this.m;
    const before = this.lastNonSpace(0, open);
    if (before < 0 || isSpace(m[before])) return 'block';
    const prev = m[before];
    if (prev === ';' || prev === '{' || prev === '}') return 'block';
    if (prev === '>' && m[before - 1] === '=') return 'block';
    if (prev === ')') return 'block';
    if (prev === ':') return this.annotationColon(before) ? 'type' : 'object';
    if (prev === '=' ) return this.typeAliasEquals(before) ? 'type' : 'object';
    if ((prev === '|' && m[before - 1] !== '|') || (prev === '&' && m[before - 1] !== '&')) {
      return this.inTypeContext(before) ? 'type' : 'object';
    }
    if (prev === '<' || prev === ',') return this.inTypeArguments(open) ? 'type' : 'object';
    if (isIdent(prev)) {
      const head = this.declarationHead(before);
      if (head === 'interface') return 'type';
      if (head === 'class') return 'class';
      if (BLOCK_WORDS.has(this.wordEndingAt(before))) return 'block';
      return 'object';
    }
    return 'object';
  }

  /** The word that ends at `end`, inclusive. */
  wordEndingAt(end) {
    let k = end;
    while (k >= 0 && isIdent(this.m[k])) k -= 1;
    return this.m.slice(k + 1, end + 1);
  }

  /**
   * `interface` or `class` when the identifier ending at `end` closes the head of such a
   * declaration (its name, type parameters and heritage clauses), else ''.
   */
  declarationHead(end) {
    const m = this.m;
    let j = end;
    for (let steps = 0; j >= 0 && steps < 64; steps += 1) {
      while (j >= 0 && isSpace(m[j])) j -= 1;
      if (j < 0) return '';
      const ch = m[j];
      if (ch === '>') {
        let depth = 0;
        let k = j;
        for (; k >= 0; k -= 1) {
          if (m[k] === '>') depth += 1;
          else if (m[k] === '<') {
            depth -= 1;
            if (depth === 0) break;
          } else if (m[k] === ';' || m[k] === '{' || m[k] === '}') return '';
        }
        j = k - 1;
        continue;
      }
      if (ch === ',' || ch === '.') {
        j -= 1;
        continue;
      }
      if (!isIdent(ch)) return '';
      const word = this.wordEndingAt(j);
      if (word === 'interface' || word === 'class') return word;
      j -= word.length;
    }
    return '';
  }

  /** Whether the `=` at `at` is the one of a `type Name<…> =` alias. */
  typeAliasEquals(at) {
    const m = this.m;
    if (/[=!<>+\-*/%&|^]/.test(m[at - 1] || '')) return false;
    let j = this.lastNonSpace(0, at);
    if (m[j] === '>') {
      let depth = 0;
      for (; j >= 0; j -= 1) {
        if (m[j] === '>') depth += 1;
        else if (m[j] === '<') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      j = this.lastNonSpace(0, j);
    }
    if (!isIdent(m[j])) return false;
    const name = this.wordEndingAt(j);
    const before = this.lastNonSpace(0, j - name.length + 1);
    return isIdent(m[before]) && this.wordEndingAt(before) === 'type';
  }

  /**
   * Whether the `:` at `at` starts a type annotation: after a declared name, a parameter, a
   * parameter list's `)`, or a property signature in a type. A ternary colon, a `case` or
   * label colon and an object property colon are not.
   */
  annotationColon(at) {
    const m = this.m;
    const before = this.lastNonSpace(0, at);
    const prev = m[before];
    if (prev === '?') return true;
    const kind = this.contextOf(at);
    if (kind === 'type' || kind === 'class') return true;
    if (this.pendingTernary(at)) return false;
    if (prev === ')') return true;
    if (!isIdent(prev) && prev !== ']') return false;
    if (isIdent(prev)) {
      const name = this.wordEndingAt(before);
      const head = this.lastNonSpace(0, before - name.length + 1);
      if (isIdent(m[head])) {
        const word = this.wordEndingAt(head);
        if (word === 'case') return false;
        if (DECLARE_WORDS.has(word)) return true;
      }
    }
    return kind === 'expression' && m[this.enclosing[at]] === '(';
  }

  /** Whether a ternary `?` at the bracket level of `at` is still waiting for its `:`. */
  pendingTernary(at) {
    const open = this.enclosing[at];
    let pending = 0;
    let j = open + 1;
    while (j < at) {
      const ch = this.m[j];
      if (OPENERS[ch] && this.match[j] !== -1 && this.match[j] < at) {
        j = this.match[j] + 1;
        continue;
      }
      if (ch === ';') pending = 0;
      else if (ch === '?' && this.tokenAt(j) === 'ternary' && !/[:),;=\]}]/.test(this.nextNonSpace(j + 1) || '')) pending += 1;
      else if (ch === ':' && pending > 0) pending -= 1;
      j += 1;
    }
    return pending > 0;
  }

  /** Whether `at` sits in a type: a type literal, an interface body, a type argument, an annotation. */
  inTypeContext(at) {
    if (this.contextOf(at) === 'type') return true;
    const m = this.m;
    const open = this.enclosing[at];
    for (let j = at - 1; j > open; j -= 1) {
      const ch = m[j];
      if (CLOSERS[ch] && this.match[j] !== -1) {
        j = this.match[j];
        continue;
      }
      if (ch === ';' || ch === ',' || ch === '{' || (ch === '=' && m[j + 1] !== '>')) {
        return ch === '=' && this.typeAliasEquals(j);
      }
      if (ch === ':') return this.annotationColon(j);
    }
    return false;
  }

  /**
   * Whether `at` sits inside a `<…>` type argument list at its own bracket level, found by
   * an unmatched `<` that an identifier precedes before the enclosing bracket `open`.
   */
  inTypeArguments(at, open = this.enclosing[at]) {
    const m = this.m;
    let depth = 0;
    for (let j = at - 1; j > open; j -= 1) {
      const ch = m[j];
      if (CLOSERS[ch] && this.match[j] !== -1) {
        j = this.match[j];
        continue;
      }
      if (ch === ';' || ch === '{' || ch === '}') return false;
      if (ch === '>' && m[j - 1] !== '=') depth += 1;
      else if (ch === '<') {
        if (depth === 0) return isIdent(m[this.lastNonSpace(0, j)]) || m[j - 1] === '.';
        depth -= 1;
      }
    }
    return false;
  }

  /** `masked[start, end)` with every bracketed group blanked, so only its own level reads. */
  topLevel(start, end) {
    let out = '';
    let j = start;
    while (j < end) {
      if (OPENERS[this.m[j]] && this.match[j] !== -1) {
        out += ' ';
        j = this.match[j] + 1;
        continue;
      }
      out += this.m[j];
      j += 1;
    }
    return out;
  }

  /** The `&&`/`||` or `??` chain that holds the operator at `at`. */
  chainAt(at, kind) {
    const start = this.exprStart(at);
    const end = this.exprEnd(at + 2);
    return [{ at, start, end, order: 0, kind, text: this.text(start, end), ...this.lines(start, end) }];
  }

  /**
   * The function bodies that start a new chain context: arrow bodies, `function` bodies and
   * the spans themselves.
   */
  contexts(spans) {
    const regions = spans.map((span) => ({ bodyStart: span.bodyStart, bodyEnd: span.bodyEnd }));
    const m = this.m;
    for (let i = 0; i < m.length - 1; i += 1) {
      if (m[i] === '=' && m[i + 1] === '>') {
        const body = this.skipSpace(i + 2);
        if (m[body] === '{' && this.match[body] !== -1) regions.push({ bodyStart: body, bodyEnd: this.match[body] });
        else regions.push({ bodyStart: body, bodyEnd: this.exprEnd(body, { ternary: true }) });
        continue;
      }
      if (m[i] === 'f' && this.wordAt(i) === 'function') {
        const open = m.indexOf('(', i);
        if (open === -1 || this.match[open] === -1) continue;
        const body = this.skipSpace(this.match[open] + 1);
        const brace = m[body] === '{' ? body : m.indexOf('{', body);
        if (brace !== -1 && this.match[brace] !== -1) regions.push({ bodyStart: brace, bodyEnd: this.match[brace] });
      }
    }
    return regions;
  }
}
