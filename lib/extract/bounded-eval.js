/**
 * A bounded reader of one expression in one spec file: the values a case-id argument or a
 * skip-guard condition can take, read from the file's own source text and nothing else.
 *
 * It parses a small expression grammar — number, string and boolean literals, arrays,
 * identifiers, member reads, subscripts, templates, `?:`, `!`, `===`, `!==`, `&&` and `||` —
 * and reads an identifier only through a binding it can see: a `const` declared before the
 * expression in an enclosing block or at top level, or the binding of a `for...of` loop or a
 * `.forEach` call over an array literal or such a `const` array. Every other binding a name
 * can have (`let`, `var`, a parameter, an import, a function) hides the outer one and stops
 * the read, because its value is decided at run time.
 *
 * A loop binding stands for every element of its array, so one expression can have several
 * values. Each is an instance: the value, and the loop bindings and row members it read.
 * Only the loops the expression reads expand, outer loop first, and a site that would expand
 * past `INSTANCE_LIMIT` instances reads as one failure: a guess at a prefix of them would be
 * a partial answer presented as a whole one.
 *
 * Guard mode adds `process.env.NAME`, `??` and an array's `.includes(…)`. A variable is read
 * from the values the caller passes, never from this process's own environment, and a
 * variable the caller does not name, a loop binding, or anything outside the grammar reads
 * as `unknown`, which then propagates. Nothing here runs code.
 */

import { matchBalanced, maskLiterals, skipString, skipTemplate, splitArgs, stringLiteralValue, templateParts } from './text.js';

/** The most instances one site expands to before it reads as one failure. */
export const INSTANCE_LIMIT = 64;
const MAX_DEPTH = 24;

class Failure extends Error {}

class NeedLoop extends Error {
  constructor(loop) {
    super('loop');
    this.loop = loop;
  }
}

const UNKNOWN = Object.freeze({ k: 'unknown' });
const prim = (v, lit = false) => ({ k: 'prim', v, lit });

// --- tokens and parse tree -------------------------------------------------------------

const PUNCTUATORS = ['===', '!==', '?.', '??', '&&', '||', '==', '!=', '(', ')', '[', ']', '.', '?', ':', '!', ','];

function tokenize(text, base) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = base + i;
    if (ch === "'" || ch === '"') {
      const end = skipString(text, i, ch);
      const value = stringLiteralValue(text.slice(i, end));
      if (value === null) throw new Failure('string');
      tokens.push({ t: 'str', v: value, start });
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(text, i);
      const parts = templateParts(text.slice(i, end));
      if (!parts) throw new Failure('template');
      tokens.push({ t: 'tmpl', parts, start, offset: base + i });
      i = end;
      continue;
    }
    if (ch === '[' || ch === '{') {
      const close = matchBalanced(text, i);
      if (close === -1) throw new Failure('bracket');
      tokens.push({ t: ch === '[' ? 'array' : 'object', text: text.slice(i + 1, close), offset: base + i + 1, start });
      i = close + 1;
      continue;
    }
    const number = /^(?:\d+(?:\.\d+)?)/.exec(text.slice(i));
    if (number) {
      if (/[\w$]/.test(text[i + number[0].length] || '')) throw new Failure('number');
      tokens.push({ t: 'num', v: Number(number[0]), start });
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (word) {
      tokens.push({ t: 'ident', v: word[0], start });
      i += word[0].length;
      continue;
    }
    const punct = PUNCTUATORS.find((candidate) => text.startsWith(candidate, i));
    if (!punct) throw new Failure('token');
    tokens.push({ t: 'p', v: punct, start });
    i += punct.length;
  }
  return tokens;
}

function parse(text, base) {
  const tokens = tokenize(text, base);
  let pos = 0;
  const peek = (v) => tokens[pos] && tokens[pos].t === 'p' && tokens[pos].v === v;
  const take = (v) => {
    if (!peek(v)) throw new Failure('expected');
    pos += 1;
  };

  const conditional = () => {
    const test = logical();
    if (!peek('?')) return test;
    pos += 1;
    const consequent = conditional();
    take(':');
    const alternate = conditional();
    return { n: 'cond', test, consequent, alternate };
  };
  const logical = () => {
    let left = conjunction();
    while (peek('||') || peek('??')) {
      const op = tokens[pos].v;
      pos += 1;
      left = { n: 'logic', op, left, right: conjunction() };
    }
    return left;
  };
  const conjunction = () => {
    let left = equality();
    while (peek('&&')) {
      pos += 1;
      left = { n: 'logic', op: '&&', left, right: equality() };
    }
    return left;
  };
  const equality = () => {
    let left = unary();
    while (peek('===') || peek('!==')) {
      const op = tokens[pos].v;
      pos += 1;
      left = { n: 'eq', op, left, right: unary() };
    }
    return left;
  };
  const unary = () => {
    if (peek('!')) {
      pos += 1;
      return { n: 'not', argument: unary() };
    }
    return postfix();
  };
  const postfix = () => {
    let node = primary();
    for (;;) {
      if (peek('.')) {
        pos += 1;
        const name = tokens[pos];
        if (!name || name.t !== 'ident') throw new Failure('member');
        pos += 1;
        node = { n: 'member', object: node, name: name.v, start: name.start };
        continue;
      }
      const next = tokens[pos];
      if (next && next.t === 'array') {
        pos += 1;
        node = { n: 'index', object: node, key: parse(next.text, next.offset), keyText: next.text.trim() };
        continue;
      }
      if (peek('(')) {
        pos += 1;
        const args = [];
        while (!peek(')')) {
          args.push(conditional());
          if (peek(',')) pos += 1;
          else if (!peek(')')) throw new Failure('call');
        }
        pos += 1;
        node = { n: 'call', callee: node, args };
        continue;
      }
      return node;
    }
  };
  const primary = () => {
    const token = tokens[pos];
    if (!token) throw new Failure('end');
    pos += 1;
    if (token.t === 'num') return { n: 'lit', v: token.v };
    if (token.t === 'str') return { n: 'lit', v: token.v };
    if (token.t === 'tmpl') {
      return {
        n: 'tmpl',
        quasis: token.parts.quasis,
        expressions: token.parts.expressions.map((part) => parse(part.text, token.offset + part.start)),
      };
    }
    if (token.t === 'array') return { n: 'array', items: elementsOf(token.text, token.offset) };
    if (token.t === 'object') return { n: 'object', props: propsOf(token.text, token.offset) };
    if (token.t === 'ident') {
      if (token.v === 'true' || token.v === 'false') return { n: 'lit', v: token.v === 'true' };
      return { n: 'ident', name: token.v, start: token.start };
    }
    if (token.t === 'p' && token.v === '(') {
      const inner = conditional();
      take(')');
      return inner;
    }
    throw new Failure('primary');
  };

  const tree = conditional();
  if (pos !== tokens.length) throw new Failure('trailing');
  return tree;
}

/** The elements of an array literal's inner text, each left unparsed with its offset. */
function elementsOf(text, offset) {
  return splitArgs(text).map((part) => {
    const lead = text.slice(part.start).length - text.slice(part.start).trimStart().length;
    if (part.text.startsWith('...')) return { spread: true };
    return { text: part.text, start: offset + part.start + lead };
  });
}

/**
 * The properties of an object literal's inner text: key -> unparsed value with its offset.
 * A row member nothing reads may hold anything, so a value is parsed only when it is read.
 * A spread, a computed key or a method stops the object from being read at all.
 */
function propsOf(text, offset) {
  const props = new Map();
  for (const part of splitArgs(text)) {
    const lead = text.slice(part.start).length - text.slice(part.start).trimStart().length;
    const start = offset + part.start + lead;
    const raw = part.text;
    const key = /^([A-Za-z_$][\w$]*|\d+|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*:/.exec(raw);
    if (!key) {
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
        props.set(raw, { text: raw, start });
        continue;
      }
      return null;
    }
    const name = key[1][0] === "'" || key[1][0] === '"' ? stringLiteralValue(key[1]) : key[1];
    if (name === null) return null;
    const valueText = raw.slice(key[0].length);
    const valueLead = valueText.length - valueText.trimStart().length;
    props.set(name, { text: valueText.trim(), start: start + key[0].length + valueLead });
  }
  return props;
}

// --- bindings ----------------------------------------------------------------------------

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'yield',
  'delete', 'void', 'in', 'of', 'instanceof', 'super', 'import', 'export', 'class', 'do', 'else', 'try',
  'finally', 'throw', 'case', 'default', 'with', 'let', 'const', 'var', 'true', 'false', 'null', 'undefined',
  'this', 'as', 'type', 'interface', 'enum',
]);
const CONTROL_WORDS = new Set(['if', 'while', 'switch', 'catch', 'with', 'for']);

function identifiersIn(text) {
  return [...String(text).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((name) => !KEYWORDS.has(name));
}

function prevNonSpace(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return i;
}

function nextNonSpace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
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
  return { word: masked.slice(start + 1, end + 1), start: start + 1, end };
}

/** Every `{…}` span of the masked source as `[open, close]`, sorted by the open brace. */
function spansOf(masked, open, close) {
  const spans = [];
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === open) stack.push(i);
    else if (masked[i] === close && stack.length > 0) spans.push([stack.pop(), i]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

function innermost(spans, position) {
  let best = null;
  for (const span of spans) {
    if (span[0] >= position) break;
    if (span[1] >= position) best = span;
  }
  return best;
}

/** Where the single statement that starts at `start` ends: a `;`, a closing brace, or a line end. */
function statementEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && ch === ';') return i;
    else if (depth === 0 && ch === '\n') {
      const next = masked[nextNonSpace(masked, i)];
      if (next && !/[.?:&|+\-*/,=)\]}]/.test(next)) return i;
    }
  }
  return masked.length;
}

/** The end of a declaration's initializer: a `;` or `,` at depth zero, or a line that ends it. */
function initializerEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === ',')) return i;
    else if (depth === 0 && ch === '\n') {
      const after = nextNonSpace(masked, i);
      const next = masked[after];
      const before = masked[prevNonSpace(masked, i)];
      if (before && /[=?:&|+\-*/,(]/.test(before)) continue;
      if (next && !/[.?:&|+\-*/=]/.test(next)) return i;
    }
  }
  return masked.length;
}

/** `= ` after an optional type annotation, or -1. The type can hold brackets and arrows. */
function assignmentAfter(masked, index) {
  let depth = 0;
  for (let i = index; i < masked.length; i += 1) {
    const ch = masked[i];
    if ('([{<'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch) || (ch === '>' && masked[i - 1] !== '=')) depth -= 1;
    else if (depth === 0 && ch === '=' && masked[i + 1] !== '=' && masked[i + 1] !== '>') return i;
    else if (depth === 0 && (ch === ';' || ch === '\n')) return -1;
    if (depth < 0) return -1;
  }
  return -1;
}

/** The body span of a function whose parameter list or arrow ends at `after`. */
function functionBodyAfter(masked, after, braces, parens, arrowAt) {
  const i = nextNonSpace(masked, after);
  if (masked[i] === '{') {
    const span = braces.find((candidate) => candidate[0] === i);
    if (span) return [i, span[1]];
  }
  if (arrowAt !== undefined) {
    const enclosing = innermost(parens, arrowAt) || innermost(braces, arrowAt);
    return [i, enclosing ? enclosing[1] : masked.length];
  }
  return [i, statementEnd(masked, i)];
}

function loopSource(code, masked, text, start) {
  const trimmed = text.trim();
  const lead = text.length - text.trimStart().length;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return { kind: 'ident', name: trimmed, start: start + lead };
  if (trimmed[0] === '[' && matchBalanced(trimmed, 0) === trimmed.length - 1) {
    return { kind: 'array', text: trimmed.slice(1, -1), start: start + lead + 1 };
  }
  return null;
}

/** A loop pattern: `name`, or `{ a, b: c }` read as members of the row. */
function loopPattern(text) {
  const trimmed = text.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return [{ name: trimmed, member: null }];
  if (trimmed[0] !== '{' || trimmed[trimmed.length - 1] !== '}') return null;
  const out = [];
  for (const part of splitArgs(trimmed.slice(1, -1))) {
    const m = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(part.text);
    if (!m) return null;
    out.push({ name: m[2] || m[1], member: m[1] });
  }
  return out.length > 0 ? out : null;
}

function buildScope(code) {
  const masked = maskLiterals(code);
  const braces = spansOf(masked, '{', '}');
  const parens = spansOf(masked, '(', ')');
  const bindings = [];
  const consumedParams = new Set();
  const fileSpan = [0, code.length];
  const blockOf = (index) => {
    const span = innermost(braces, index);
    return span ? [span[0], span[1]] : fileSpan;
  };
  const block = (names, scope) => {
    for (const name of names) bindings.push({ name, kind: 'block', scope });
  };

  let m;
  const loopRe = /(?<![\w$.])for\s*(?:await\s*)?\(/g;
  while ((m = loopRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    const header = code.slice(open + 1, close);
    const body = functionBodyAfter(masked, close + 1, braces, parens);
    const parts = /^\s*(const|let|var)\s+([\s\S]+?)\s+(of|in)\s+([\s\S]+)$/.exec(header);
    if (!parts) continue;
    const scope = [open, body[1]];
    const pattern = parts[1] === 'const' && parts[3] === 'of' ? loopPattern(parts[2]) : null;
    const sourceStart = open + 1 + header.lastIndexOf(parts[4]);
    const source = pattern ? loopSource(code, masked, parts[4], sourceStart) : null;
    if (!pattern || !source) {
      block(identifiersIn(parts[2]), scope);
      continue;
    }
    const loop = { id: bindings.length, at: m.index, source, length: null };
    for (const entry of pattern) bindings.push({ name: entry.name, kind: 'loop', scope, loop, member: entry.member });
  }

  const forEachRe = /\.\s*forEach\s*\(/g;
  while ((m = forEachRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    const receiverEnd = prevNonSpace(masked, m.index);
    let source = null;
    if (masked[receiverEnd] === ']') {
      const start = matchBackward(masked, receiverEnd);
      const before = masked[prevNonSpace(masked, start)];
      if (start !== -1 && !(before && /[\w$)\]]/.test(before))) {
        source = { kind: 'array', text: code.slice(start + 1, receiverEnd), start: start + 1 };
      }
    } else {
      const word = wordBefore(masked, receiverEnd + 1);
      const before = masked[prevNonSpace(masked, word.start)];
      if (/^[A-Za-z_$][\w$]*$/.test(word.word) && before !== '.') source = { kind: 'ident', name: word.word, start: word.start };
    }
    const callback = code.slice(open + 1, close);
    const lead = callback.length - callback.trimStart().length;
    const head = /^(?:async\s+)?(?:function\s*[A-Za-z_$]?[\w$]*\s*\(|\()/.exec(callback.slice(lead));
    let paramsText;
    let paramsOpen;
    let afterParams;
    let arrowAt;
    if (head) {
      paramsOpen = open + 1 + lead + head[0].length - 1;
      const paramsClose = matchBalanced(code, paramsOpen);
      if (paramsClose === -1) continue;
      paramsText = code.slice(paramsOpen + 1, paramsClose);
      afterParams = paramsClose + 1;
      const arrow = nextNonSpace(masked, afterParams);
      if (masked.startsWith('=>', arrow)) {
        arrowAt = arrow;
        afterParams = arrow + 2;
      }
    } else {
      const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(callback.slice(lead));
      if (!single) continue;
      paramsOpen = open + 1 + lead + single[0].indexOf(single[1]);
      paramsText = single[1];
      arrowAt = open + 1 + lead + single[0].length - 2;
      afterParams = arrowAt + 2;
    }
    consumedParams.add(paramsOpen);
    const bodySpan = functionBodyAfter(masked, afterParams, braces, parens, arrowAt);
    const scope = [paramsOpen, Math.min(bodySpan[1], close)];
    const params = splitArgs(paramsText);
    const pattern = source && params.length > 0 ? loopPattern(params[0].text) : null;
    if (!pattern) {
      block(identifiersIn(paramsText), scope);
      continue;
    }
    const loop = { id: bindings.length, at: m.index, source, length: null };
    for (const entry of pattern) bindings.push({ name: entry.name, kind: 'loop', scope, loop, member: entry.member });
    block(params.slice(1).flatMap((param) => identifiersIn(param.text)), scope);
  }

  const constRe = /(?<![\w$.])const\s+([A-Za-z_$][\w$]*)\s*(?=[:=])/g;
  while ((m = constRe.exec(masked))) {
    const eq = assignmentAfter(masked, m.index + m[0].length);
    if (eq === -1) continue;
    const initStart = nextNonSpace(masked, eq + 1);
    const initEnd = initializerEnd(masked, initStart);
    let init = code.slice(initStart, initEnd).trim();
    init = init.replace(/\s+as\s+const\s*$/, '').replace(/\s+satisfies\s+[\s\S]+$/, '');
    bindings.push({ name: m[1], kind: 'const', scope: blockOf(m.index), at: m.index, init, initStart, initEnd });
  }

  const destructRe = /(?<![\w$.])const\s*([{[])/g;
  while ((m = destructRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    block(identifiersIn(code.slice(open + 1, close)), blockOf(m.index));
  }

  const mutableRe = /(?<![\w$.])(?:let|var)\s+/g;
  while ((m = mutableRe.exec(masked))) {
    const start = m.index + m[0].length;
    let end = start;
    if (masked[start] === '{' || masked[start] === '[') end = matchBalanced(code, start) + 1;
    else while (end < masked.length && /[\w$]/.test(masked[end])) end += 1;
    block(identifiersIn(code.slice(start, end)), blockOf(m.index));
  }

  const importRe = /(?<![\w$.])import\s+(?!\()([^;]*?)\s*from\s*['"]/g;
  while ((m = importRe.exec(masked))) block(identifiersIn(m[1]), fileSpan);
  const importEqualsRe = /(?<![\w$.])import\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = importEqualsRe.exec(masked))) block([m[1]], fileSpan);

  const declRe = /(?<![\w$.])(?:function\s*\*?|class|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(masked))) block([m[1]], blockOf(m.index));

  const catchRe = /(?<![\w$.])catch\s*\(/g;
  while ((m = catchRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    block(identifiersIn(code.slice(open + 1, close)), functionBodyAfter(masked, close + 1, braces, parens));
  }

  // Parameters: an arrow's, a function's and a method's. A loop's `for (…)` header and a
  // `.forEach` callback were read above; `if (…) {` and the other control heads are not
  // parameter lists.
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(masked))) {
    let before = prevNonSpace(masked, m.index);
    let open;
    let paramsText;
    if (masked[before] !== ')') {
      // A return type sits between the parameter list and the arrow: `(x: T): U => …`.
      const word = wordBefore(masked, before + 1);
      const colon = prevNonSpace(masked, word.start);
      if (word.word && masked[colon] === ':' && masked[prevNonSpace(masked, colon)] === ')') before = prevNonSpace(masked, colon);
    }
    if (masked[before] === ')') {
      open = matchBackward(masked, before);
      if (open === -1) continue;
      paramsText = code.slice(open + 1, before);
    } else {
      const word = wordBefore(masked, before + 1);
      if (!word.word) continue;
      open = word.start;
      paramsText = word.word;
    }
    if (consumedParams.has(open)) continue;
    const body = functionBodyAfter(masked, m.index + 2, braces, parens, m.index);
    block(identifiersIn(paramsText), [open, body[1]]);
  }
  const headRe = /(?<![\w$.])(?:function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*(?:<[^>(]*>)?\s*\(|([A-Za-z_$][\w$]*)\s*\()/g;
  while ((m = headRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    if (consumedParams.has(open)) continue;
    if (m[1] !== undefined && (KEYWORDS.has(m[1]) || CONTROL_WORDS.has(m[1]))) continue;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    let after = nextNonSpace(masked, close + 1);
    if (masked[after] === ':') {
      while (after < masked.length && masked[after] !== '{' && masked[after] !== ';' && masked[after] !== '\n') after += 1;
    }
    if (m[1] !== undefined && masked[after] !== '{') continue;
    if (masked.startsWith('=>', after)) continue;
    const body = functionBodyAfter(masked, after, braces, parens);
    block(identifiersIn(code.slice(open + 1, close)), [open, body[1]]);
  }

  return { code, bindings };
}

let lastScope = null;
function scopeOf(code) {
  if (!lastScope || lastScope.code !== code) lastScope = buildScope(code);
  return lastScope;
}

/**
 * The binding `name` has at `position`: the innermost one whose scope holds it. A `const`
 * declared after the position, or one whose own initializer holds it, cannot be read there.
 */
function lookup(scope, name, position) {
  let best = null;
  for (const binding of scope.bindings) {
    if (binding.name !== name) continue;
    if (position < binding.scope[0] || position > binding.scope[1]) continue;
    if (!best || binding.scope[0] > best.scope[0] || (binding.scope[0] === best.scope[0] && (binding.at ?? 0) > (best.at ?? 0))) {
      best = binding;
    }
  }
  if (!best) return null;
  if (best.kind === 'const' && (best.at > position || (position >= best.initStart && position <= best.initEnd))) return null;
  return best;
}

// --- evaluation --------------------------------------------------------------------------

function truthy(value) {
  if (value.k === 'prim') return Boolean(value.v);
  return true;
}

function isId(value) {
  return value.k === 'prim' && value.lit && ((typeof value.v === 'number' && Number.isInteger(value.v)) || (typeof value.v === 'string' && value.v !== ''));
}

function evaluator(code, { mode, environment }) {
  const scope = scopeOf(code);

  const valueOfText = (text, start, ctx) => {
    if (ctx.depth > MAX_DEPTH) throw new Failure('depth');
    const tree = parse(text, start);
    return evaluate(tree, { ...ctx, depth: ctx.depth + 1 });
  };

  const loopItems = (loop, ctx) => {
    if (loop.items) return loop.items;
    let items = null;
    if (loop.source.kind === 'array') {
      items = elementsOf(loop.source.text, loop.source.start);
    } else {
      const value = readIdentifier(loop.source.name, loop.source.start, { ...ctx, loopFree: true });
      if (value.k === 'array') items = value.items;
    }
    if (!items || items.some((item) => item.spread)) throw new Failure('loop source');
    loop.items = items;
    return items;
  };

  const readIdentifier = (name, position, ctx) => {
    const binding = lookup(scope, name, position);
    if (!binding || binding.kind === 'block') throw new Failure(`binding ${name}`);
    if (binding.kind === 'const') return valueOfText(binding.init, binding.initStart, ctx);
    if (mode === 'guard') return UNKNOWN;
    if (ctx.loopFree) throw new Failure('loop in a loop source');
    const items = loopItems(binding.loop, ctx);
    if (!ctx.assignment.has(binding.loop.id)) throw new NeedLoop(binding.loop);
    const item = items[ctx.assignment.get(binding.loop.id)];
    const element = valueOfText(item.text, item.start, { ...ctx, loopFree: true });
    if (binding.member === null) {
      if (element.k === 'object') return { ...element, row: name };
      if (element.k === 'prim') ctx.reads.set(name, element.v);
      return element;
    }
    if (element.k !== 'object') throw new Failure('row');
    const prop = element.props.get(binding.member);
    if (!prop) throw new Failure('row member');
    const value = valueOfText(prop.text, prop.start, { ...ctx, loopFree: true });
    if (value.k === 'prim') ctx.reads.set(name, value.v);
    return value;
  };

  const environmentRead = (node) => {
    const object = node.object;
    if (!object || object.n !== 'member' || object.name !== 'env' || object.object.n !== 'ident' || object.object.name !== 'process') return null;
    let name = null;
    if (node.n === 'member') name = node.name;
    else if (node.key.n === 'lit' && typeof node.key.v === 'string') name = node.key.v;
    if (name === null) throw new Failure('environment key');
    if (mode !== 'guard') throw new Failure('environment');
    if (environment && Object.hasOwn(environment, name)) return prim(environment[name]);
    return UNKNOWN;
  };

  const evaluate = (node, ctx) => {
    switch (node.n) {
      case 'lit':
        return prim(node.v, true);
      case 'ident':
        if (node.name === 'process') throw new Failure('process');
        return readIdentifier(node.name, node.start, ctx);
      case 'array':
        return { k: 'array', items: node.items };
      case 'object':
        if (!node.props) throw new Failure('object');
        return { k: 'object', props: node.props };
      case 'tmpl': {
        let text = node.quasis[0];
        for (let i = 0; i < node.expressions.length; i += 1) {
          const value = evaluate(node.expressions[i], ctx);
          if (value.k === 'unknown') return UNKNOWN;
          if (value.k !== 'prim') throw new Failure('template part');
          text += String(value.v) + node.quasis[i + 1];
        }
        return prim(text);
      }
      case 'member': {
        const env = environmentRead(node);
        if (env) return env;
        const object = evaluate(node.object, ctx);
        if (object.k === 'unknown') return UNKNOWN;
        if (object.k !== 'object' || !object.row) throw new Failure('member of a value that is not a loop row');
        const prop = object.props.get(node.name);
        if (!prop) throw new Failure('absent member');
        const value = valueOfText(prop.text, prop.start, { ...ctx, loopFree: true });
        if (value.k === 'prim') ctx.reads.set(`${object.row}.${node.name}`, value.v);
        return value;
      }
      case 'index': {
        const env = environmentRead(node);
        if (env) return env;
        const object = evaluate(node.object, ctx);
        if (object.k === 'unknown') return UNKNOWN;
        if (object.k === 'array') {
          if (node.key.n !== 'lit' || typeof node.key.v !== 'number' || !Number.isInteger(node.key.v)) throw new Failure('index');
          const item = object.items[node.key.v];
          if (!item || item.spread) throw new Failure('absent element');
          return valueOfText(item.text, item.start, ctx);
        }
        if (object.k === 'object') {
          const key = evaluate(node.key, ctx);
          if (key.k === 'unknown') return UNKNOWN;
          if (key.k !== 'prim' || (typeof key.v !== 'string' && typeof key.v !== 'number')) throw new Failure('key');
          const prop = object.props.get(String(key.v));
          if (!prop) throw new Failure('absent key');
          return valueOfText(prop.text, prop.start, ctx);
        }
        throw new Failure('subscript');
      }
      case 'call': {
        if (mode !== 'guard' || node.callee.n !== 'member' || node.callee.name !== 'includes' || node.args.length !== 1) {
          throw new Failure('call');
        }
        const list = evaluate(node.callee.object, ctx);
        if (list.k === 'unknown') return UNKNOWN;
        if (list.k !== 'array') throw new Failure('includes');
        const needle = evaluate(node.args[0], ctx);
        if (needle.k === 'unknown') return UNKNOWN;
        if (needle.k !== 'prim') throw new Failure('includes');
        let sawUnknown = false;
        for (const item of list.items) {
          if (item.spread) throw new Failure('spread');
          const value = valueOfText(item.text, item.start, ctx);
          if (value.k === 'unknown') sawUnknown = true;
          else if (value.k === 'prim' && value.v === needle.v) return prim(true);
        }
        return sawUnknown ? UNKNOWN : prim(false);
      }
      case 'not': {
        const value = evaluate(node.argument, ctx);
        return value.k === 'unknown' ? UNKNOWN : prim(!truthy(value));
      }
      case 'eq': {
        const left = evaluate(node.left, ctx);
        const right = evaluate(node.right, ctx);
        if (left.k === 'unknown' || right.k === 'unknown') return UNKNOWN;
        if (left.k !== 'prim' || right.k !== 'prim') throw new Failure('compare');
        return prim(node.op === '===' ? left.v === right.v : left.v !== right.v);
      }
      case 'logic': {
        if (node.op === '??' && mode !== 'guard') throw new Failure('coalesce');
        const left = evaluate(node.left, ctx);
        if (left.k === 'unknown') return UNKNOWN;
        if (node.op === '&&') return truthy(left) ? evaluate(node.right, ctx) : left;
        if (node.op === '||') return truthy(left) ? left : evaluate(node.right, ctx);
        return left;
      }
      case 'cond': {
        const test = evaluate(node.test, ctx);
        if (test.k === 'unknown') return UNKNOWN;
        return evaluate(truthy(test) ? node.consequent : node.alternate, ctx);
      }
      default:
        throw new Failure('node');
    }
  };

  return { evaluate, scope };
}

/**
 * The case ids one argument can take at `position`, the offset of the argument in `code`.
 *
 * `null` when the argument cannot be read at all. Otherwise one entry per instance, in loop
 * order, outer loop first: `{ ids, instance }` for an instance that reads to an id written in
 * the file, `{ ids: null, instance }` for one that does not — an absent key in one row leaves
 * the other rows their ids. An id is a number or a non-empty string written as a literal, or
 * an array of those; a value built by a template is never one.
 */
export function evaluateCaseId(code, position, text) {
  let tree;
  try {
    tree = parse(String(text), position);
  } catch (error) {
    if (error instanceof Failure) return null;
    throw error;
  }
  const { evaluate } = evaluator(code, { mode: 'id' });
  const leaves = [];
  const loops = new Map();
  let overflow = false;
  const run = (assignment) => {
    if (overflow) return;
    const reads = new Map();
    try {
      const value = evaluate(tree, { assignment, reads, depth: 0 });
      const ids = isId(value) ? [value.v] : value.k === 'array' ? arrayIds(value, evaluate, assignment, reads) : null;
      leaves.push({ assignment, reads, ids });
    } catch (error) {
      if (error instanceof NeedLoop) {
        loops.set(error.loop.id, error.loop);
        const count = error.loop.items ? error.loop.items.length : 0;
        if (leaves.length + count > INSTANCE_LIMIT || count === 0) {
          overflow = count > 0;
          if (count === 0) leaves.push({ assignment, reads, ids: null });
          return;
        }
        for (let i = 0; i < count; i += 1) run(new Map([...assignment, [error.loop.id, i]]));
        return;
      }
      if (error instanceof Failure) {
        leaves.push({ assignment, reads, ids: null });
        return;
      }
      throw error;
    }
    if (leaves.length > INSTANCE_LIMIT) overflow = true;
  };
  run(new Map());
  if (overflow || leaves.length > INSTANCE_LIMIT) return null;
  if (leaves.every((leaf) => leaf.ids === null)) return null;
  const order = [...loops.values()].sort((a, b) => a.at - b.at).map((loop) => loop.id);
  const rank = (leaf) => order.map((id) => (leaf.assignment.has(id) ? leaf.assignment.get(id) : -1));
  const ranked = leaves.map((leaf, index) => ({ leaf, index, key: rank(leaf) }));
  ranked.sort((a, b) => {
    for (let i = 0; i < order.length; i += 1) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.index - b.index;
  });
  return ranked.map(({ leaf }) => ({ ids: leaf.ids, instance: Object.fromEntries(leaf.reads) }));
}

function arrayIds(value, evaluate, assignment, reads) {
  if (value.items.length === 0) return null;
  const ids = [];
  for (const item of value.items) {
    if (item.spread) return null;
    const element = evaluate(parse(item.text, item.start), { assignment, reads, depth: 1 });
    if (!isId(element)) return null;
    ids.push(element.v);
  }
  return ids;
}

/**
 * The value of a skip-guard condition at `position`: `true`, `false`, or `"unknown"` when the
 * condition reads something the caller did not supply or falls outside the grammar.
 */
export function evaluateGuard(code, position, text, environment) {
  try {
    const tree = parse(String(text), position);
    const { evaluate } = evaluator(code, { mode: 'guard', environment: environment || null });
    const value = evaluate(tree, { assignment: new Map(), reads: new Map(), depth: 0 });
    if (value.k === 'unknown') return 'unknown';
    return truthy(value);
  } catch (error) {
    if (error instanceof Failure || error instanceof NeedLoop) return 'unknown';
    throw error;
  }
}
