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
