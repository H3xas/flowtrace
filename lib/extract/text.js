/**
 * Lexical helpers shared by the TypeScript-reading extractors.
 *
 * Every function here works on raw source text: it skips strings, template literals and
 * comments so a brace, quote or `${` inside one of them cannot derail a depth counter.
 * `lib/extract/mobile.js` imports them, so a second extractor can reuse them without
 * copying. Nothing here knows about a repo
 * kind, a fact type or a file layout.
 */

import { relative } from 'node:path';

export function skipString(text, index, quote) {
  let i = index + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i += 1;
  }
  return i;
}

export function skipTemplate(text, index) {
  let i = index + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && text[i + 1] === '{') {
      const close = matchBalanced(text, i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    i += 1;
  }
  return i;
}

export function matchBalanced(text, openIndex) {
  const open = text[openIndex];
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[open];
  if (!close) return -1;
  let depth = 0;
  let i = openIndex;
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
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === open) {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * The close index of the literal that is the whole of `text`, or -1. A reader that stopped at
 * the first balanced literal would take one operand of a longer expression — `[…].concat(…)`,
 * `{ … }.path` — as a complete declaration and report part of a computed value as read.
 */
export function wholeLiteralClose(text) {
  const close = matchBalanced(text, 0);
  return close === text.length - 1 ? close : -1;
}

function skipTrivia(text, index, end) {
  let i = index;
  while (i < end) {
    if (/\s/.test(text[i])) i += 1;
    else if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? end : nl;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? end : close + 2;
    } else break;
  }
  return i;
}

function skipAngles(text, index, end) {
  if (text[index] !== '<') return index;
  let depth = 0;
  for (let i = index; i < end; i += 1) {
    if (text[i] === '<') depth += 1;
    else if (text[i] === '>' && text[i - 1] !== '=') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The body of the inline function that `text` holds at `[start, end)`: `{ open, close }` of
 * its brace body, or, for an arrow that returns an expression, `expression: true` with `open`
 * just before the expression and `close` at `end`. `null` when the span is not an inline
 * function. The body is the one after the function's own parameter list, because the first
 * `=>` or `{` in the span can belong to a destructured parameter or to a nested function.
 */
export function inlineFunctionBody(text, start, end) {
  const wordAt = (at) => /^[A-Za-z_$][\w$]*/.exec(text.slice(at, Math.min(end, at + 64)))?.[0] || '';
  let i = skipTrivia(text, start, end);
  if (wordAt(i) === 'async') {
    const after = skipTrivia(text, i + 5, end);
    if (!text.startsWith('=>', after)) i = after;
  }
  if (wordAt(i) === 'function') {
    i = skipTrivia(text, i + 8, end);
    if (text[i] === '*') i = skipTrivia(text, i + 1, end);
    i = skipTrivia(text, i + wordAt(i).length, end);
    i = skipAngles(text, i, end);
    if (i === -1) return null;
    i = skipTrivia(text, i, end);
    if (text[i] !== '(') return null;
    const paramsClose = matchBalanced(text, i);
    if (paramsClose === -1 || paramsClose >= end) return null;
    i = skipTrivia(text, paramsClose + 1, end);
    if (text[i] === ':') i = text.indexOf('{', i);
    if (i === -1 || i >= end || text[i] !== '{') return null;
    const close = matchBalanced(text, i);
    return close === -1 || close >= end ? null : { open: i, close, expression: false };
  }
  i = skipAngles(text, i, end);
  if (i === -1) return null;
  if (text[i] === '(') {
    const paramsClose = matchBalanced(text, i);
    if (paramsClose === -1 || paramsClose >= end) return null;
    i = skipTrivia(text, paramsClose + 1, end);
    if (text[i] === ':') i = text.indexOf('=>', i);
  } else {
    const name = wordAt(i);
    if (!name) return null;
    i = skipTrivia(text, i + name.length, end);
  }
  if (i === -1 || i >= end || !text.startsWith('=>', i)) return null;
  i = skipTrivia(text, i + 2, end);
  if (i >= end) return null;
  if (text[i] !== '{') return { open: i - 1, close: end, expression: true };
  const close = matchBalanced(text, i);
  return close === -1 || close >= end ? null : { open: i, close, expression: false };
}

export function blankComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const start = i;
      i = skipString(text, i, ch);
      out += text.slice(start, i);
      continue;
    }
    if (ch === '`') {
      const start = i;
      i = skipTemplate(text, i);
      out += text.slice(start, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function makeLineFinder(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return function lineOf(index) {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function splitArgs(text) {
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
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push({ text: text.slice(start), start });
  return parts
    .map((part) => ({ text: part.text.trim(), start: part.start }))
    .filter((part) => part.text.length > 0);
}

export function splitPlus(text) {
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
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '+' && depth === 0) {
      parts.push(text.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function fullLiteral(text) {
  if (!text) return null;
  const quote = text[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = quote === '`' ? skipTemplate(text, 0) : skipString(text, 0, quote);
  if (end !== text.length) return null;
  return text.slice(1, end - 1);
}

export function bestPartial(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '*';
  if (collapsed.length <= 60) return `\${${collapsed}}`;
  return '*';
}

export function hasTopLevelTernary(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipString(text, i, ch) - 1;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i) - 1;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === '?' && text[i + 1] !== '.' && text[i + 1] !== '?') return true;
  }
  return false;
}

export function isSimpleInterpolation(inner) {
  if (inner.includes('`')) return false;
  if (hasTopLevelTernary(inner)) return false;
  return true;
}

export function flattenInterpolations(text) {
  let out = '';
  let i = 0;
  let collapsed = false;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const braceOpen = i + 1;
      const braceClose = matchBalanced(text, braceOpen);
      const end = braceClose === -1 ? text.length : braceClose + 1;
      const innerEnd = braceClose === -1 ? text.length : braceClose;
      const inner = text.slice(braceOpen + 1, innerEnd);
      if (isSimpleInterpolation(inner)) {
        out += text.slice(i, end);
      } else {
        out += '*';
        collapsed = true;
      }
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return { text: out, collapsed };
}

export function toRelative(repoRoot, absPath) {
  return relative(repoRoot, absPath).split('\\').join('/');
}

/** Class-body member splitting. */
export function findLocalConst(ctx, name) {
  const { fileText, memberBodyStart, callIndex } = ctx;
  const re = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`);
  let searchFrom = memberBodyStart;
  let lastStart = null;
  while (searchFrom < callIndex) {
    const window = fileText.slice(searchFrom, callIndex);
    const m = re.exec(window);
    if (!m) break;
    lastStart = searchFrom + m.index + m[0].length;
    searchFrom = lastStart + 1;
  }
  if (lastStart === null) return null;
  let i = lastStart;
  let depth = 0;
  const start = i;
  while (i < callIndex) {
    const ch = fileText[i];
    if (ch === "'" || ch === '"') {
      i = skipString(fileText, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(fileText, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return fileText.slice(start, i);
    i += 1;
  }
  return fileText.slice(start, callIndex);
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Brace depth at every offset in `code`, with strings and template literals held at the
 * depth they open in so a `{` inside one never nests. Depth 0 is module scope, which is
 * how a reader tells a top-level declaration from one nested inside a function or a JSX
 * expression.
 */
export function computeDepths(code) {
  const depths = new Int32Array(code.length + 1);
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const end = skipString(code, i, ch);
      for (let k = i; k < end && k < code.length; k += 1) depths[k] = depth;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(code, i);
      for (let k = i; k < end && k < code.length; k += 1) depths[k] = depth;
      i = end;
      continue;
    }
    depths[i] = depth;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    i += 1;
  }
  depths[code.length] = depth;
  return depths;
}

/**
 * A copy of `code` with the *contents* of every string and template literal replaced by
 * spaces, offsets and line breaks preserved. Regex scans run over this so a tag name, a
 * handler attribute or a `dispatch(` inside a literal cannot become a fact; brace matching
 * still runs over the real text, which skips literals on its own.
 */
export function maskLiterals(code) {
  const out = code.split('');
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = ch === '`' ? skipTemplate(code, i) : skipString(code, i, ch);
      for (let k = i + 1; k < end - 1 && k < code.length; k += 1) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Words after which a `/` opens a regex literal and a `<` opens a JSX element. */
const EXPRESSION_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

/**
 * `maskLiterals` that also blanks regex literal bodies and, with `jsx`, the text children of
 * JSX elements. A `/` or `<` starts one of those only where an expression can start, which
 * the token before it decides: after an identifier, a number or a closing bracket it is an
 * operator. Without that rule `a / b / c` would read as a regex and `</p>` as one too.
 */
export function maskCode(code, { jsx = false } = {}) {
  const out = code.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < code.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const isIdent = (ch) => /[\w$]/.test(ch || '');

  // Each lexer returns the offset after what it read. `stop` is the closing brace of a JSX
  // expression container, so the code inside it ends where the container ends.
  const lexCode = (start, stop) => {
    let i = start;
    let opens = true;
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      if (stop && depth === 0 && ch === '}') return i;
      if (ch === "'" || ch === '"' || ch === '`') {
        const end = ch === '`' ? skipTemplate(code, i) : skipString(code, i, ch);
        blank(i + 1, end - 1);
        i = end;
        opens = false;
        continue;
      }
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (isIdent(ch)) {
        let j = i;
        while (j < code.length && isIdent(code[j])) j += 1;
        opens = EXPRESSION_KEYWORDS.has(code.slice(i, j));
        i = j;
        continue;
      }
      if (ch === '/' && opens) {
        const end = regexEnd(code, i);
        if (end !== -1) {
          blank(i + 1, end - 1);
          i = end;
          opens = false;
          continue;
        }
      }
      if (ch === '<' && opens && jsx && /[A-Za-z>]/.test(code[i + 1] || '')) {
        const end = lexJsxElement(i);
        if (end !== -1) {
          i = end;
          opens = false;
          continue;
        }
      }
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      opens = !(ch === ')' || ch === ']' || ch === '}');
      i += 1;
    }
    return i;
  };

  // The offset after the element that opens at `start`, or -1 when `<` is not one: a type
  // parameter list `<T,>` or `<T extends U>` reads as a tag name and then fails here.
  const lexJsxElement = (start) => {
    let i = start + 1;
    while (i < code.length && /[\w$.:-]/.test(code[i])) i += 1;
    const afterName = code.slice(i).match(/^\s*(\S+)/);
    if (afterName && (afterName[1].startsWith(',') || /^extends\b/.test(afterName[1]))) return -1;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "'" || ch === '"') {
        const end = skipString(code, i, ch);
        blank(i + 1, end - 1);
        i = end;
        continue;
      }
      if (ch === '{') {
        i = lexCode(i + 1, true) + 1;
        continue;
      }
      if (ch === '/' && code[i + 1] === '>') return i + 2;
      if (ch === '>') break;
      i += 1;
    }
    if (i >= code.length) return -1;
    i += 1;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '{') {
        i = lexCode(i + 1, true) + 1;
        continue;
      }
      if (ch === '<' && code[i + 1] === '/') {
        const close = code.indexOf('>', i);
        return close === -1 ? code.length : close + 1;
      }
      if (ch === '<' && /[A-Za-z>]/.test(code[i + 1] || '')) {
        const end = lexJsxElement(i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
      i += 1;
    }
    return code.length;
  };

  lexCode(0, false);
  return out.join('');
}

/** The offset after the regex literal that opens at `start`, or -1 when none closes on its line. */
function regexEnd(code, start) {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      if (i === start + 1) return -1;
      i += 1;
      while (i < code.length && /[a-z]/.test(code[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

const SINGLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * The value of the text between the quotes of a string or the backticks of a template part,
 * with its escape sequences read the way JavaScript reads them. A runner reports a title by
 * its value, so `'it\'s open'` must compare as `it's open`. `null` for a sequence JavaScript
 * itself refuses, such as a cut `\x` or `\u`.
 */
export function cookEscapes(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) return null;
    if (next === '\r' && raw[i + 2] === '\n') {
      i += 3;
      continue;
    }
    if (next === '\n' || next === '\r' || next === ' ' || next === ' ') {
      i += 2;
      continue;
    }
    if (Object.hasOwn(SINGLE_ESCAPES, next) && !(next === '0' && /[0-9]/.test(raw[i + 2] || ''))) {
      out += SINGLE_ESCAPES[next];
      i += 2;
      continue;
    }
    if (next === 'x') {
      const hex = raw.slice(i + 2, i + 4);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (next === 'u') {
      if (raw[i + 2] === '{') {
        const close = raw.indexOf('}', i + 3);
        const hex = close === -1 ? '' : raw.slice(i + 3, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
        out += String.fromCodePoint(parseInt(hex, 16));
        i = close + 1;
        continue;
      }
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (/[1-9]/.test(next)) return null;
    out += next;
    i += 2;
  }
  return out;
}

/** The value of a string literal that is the whole of `text`, escapes read, or `null`. */
export function stringLiteralValue(text) {
  const trimmed = String(text ?? '').trim();
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"') return null;
  if (skipString(trimmed, 0, quote) !== trimmed.length || trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) return null;
  return cookEscapes(trimmed.slice(1, -1));
}

/**
 * The parts of a template literal that is the whole of `text`: `quasis` holds the value of
 * each literal part, escapes read, and `expressions` the source of each `${…}` with its offset
 * in `text`. There is always one more quasi than expression. `null` when `text` is not one
 * whole template or a part holds an escape JavaScript refuses.
 */
export function templateParts(text) {
  const source = String(text ?? '');
  if (source[0] !== '`' || skipTemplate(source, 0) !== source.length || source[source.length - 1] !== '`') return null;
  const quasis = [];
  const expressions = [];
  let raw = '';
  let i = 1;
  while (i < source.length - 1) {
    const ch = source[i];
    if (ch === '\\') {
      raw += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      const close = matchBalanced(source, i + 1);
      if (close === -1) return null;
      const cooked = cookEscapes(raw);
      if (cooked === null) return null;
      quasis.push(cooked);
      raw = '';
      expressions.push({ text: source.slice(i + 2, close), start: i + 2 });
      i = close + 1;
      continue;
    }
    raw += ch;
    i += 1;
  }
  const cooked = cookEscapes(raw);
  if (cooked === null) return null;
  quasis.push(cooked);
  return { quasis, expressions };
}
