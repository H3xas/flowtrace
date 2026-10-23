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
  const masked = maskCode(code, { jsx });
  const tree = bracketTree(masked);
  const scan = new Scanner(code, masked, tree, lineOf);

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

const isIdent = (ch) => /[\w$]/.test(ch || '');
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

class Scanner {
  constructor(code, masked, match, lineOf) {
    this.code = code;
    this.m = masked;
    this.match = match;
    this.lineOf = lineOf;
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

  /** The controlled statement after `from`: a block or one statement. */
  controlled(from) {
    const start = this.skipSpace(from);
    if (this.m[start] === '{' && this.match[start] !== -1) return { start, end: this.match[start] + 1 };
    const end = this.statementEnd(start);
    return { start, end };
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
    if (before < from || /[=+\-*/%&|^!~<>?:,.(\[{]/.test(prev)) return false;
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
    const colon = this.exprEnd(at + 1, { ternary: true });
    if (this.m[colon] !== ':') return null;
    const start = this.exprStart(at);
    if (/(^|[^\w$.])extends(?![\w$])/.test(this.topLevel(start, at))) return null;
    if (this.optionalMethod(at, start)) return null;
    const end = this.exprEnd(colon + 1, { ternary: true });
    return { at, start, end, order: 0, kind: 'ternary', text: this.text(start, end), ...this.lines(start, end) };
  }

  /**
   * An optional method member, `size?(): number`, written where a member starts: the name
   * opens its member, and `?(` and `):` follow it with no space.
   */
  optionalMethod(at, start) {
    const m = this.m;
    if (!isIdent(m[at - 1]) || m[at + 1] !== '(' || this.match[at + 1] === -1) return false;
    if (m[this.match[at + 1] + 1] !== ':') return false;
    let before = start - 1;
    while (before >= 0 && isSpace(m[before])) before -= 1;
    return before < 0 || m[before] === '{' || m[before] === ';' || m[before] === ',';
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
