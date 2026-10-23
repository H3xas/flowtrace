/**
 * C# constant string expressions, read the way a route argument uses them.
 *
 * A route attribute names its template as a constant expression: a literal, a verbatim
 * literal, a `const string` field by simple or qualified name, `+` concatenation, a constant
 * interpolation or `nameof`. This module indexes the `const string` fields of one repository
 * and gives each expression exactly one value or none. It never guesses: an unknown name, two
 * declarations with different values, a cycle or a form it does not read all give `null`, and
 * the caller keeps the argument as written.
 */

const CONST_STRING = /\bconst\s+string\s+/g;
const NAMESPACE = /\bnamespace\s+([\w.]+)\s*[;{]/g;
const QUALIFIED_NAME = /^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*$/;
const MAX_DEPTH = 64;
const ESCAPE = /^\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|['"\\0abfnrtv])/;
const SIMPLE_ESCAPES = { "'": "'", '"': '"', '\\': '\\', 0: '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

function segments(name) {
  return name.split('.').map((part) => part.trim());
}

function enclosing(frames, position) {
  let best = null;
  for (const frame of frames) {
    if (frame.endIndex == null) continue;
    if (position >= frame.startIndex && position < frame.endIndex && (!best || frame.startIndex > best.startIndex)) best = frame;
  }
  return best;
}

/** The names of the classes that hold `frame`, outermost first, `frame` itself last. */
export function classPathOf(frame, classFrames) {
  const path = [];
  let current = frame;
  while (current && path.length < MAX_DEPTH) {
    path.unshift(current.name);
    current = enclosing(classFrames, current.keywordIndex);
  }
  return path;
}

/** The namespace a position in the masked text sits in: the last declaration before it. */
export function namespaceAt(masked, position) {
  let found = '';
  NAMESPACE.lastIndex = 0;
  for (let match = NAMESPACE.exec(masked); match && match.index < position; match = NAMESPACE.exec(masked)) {
    found = match[1];
  }
  return found;
}

/** The scope a class frame gives the expressions written in it. */
export function scopeOf(frame, classFrames, masked) {
  if (!frame) return { namespace: namespaceAt(masked, 0), classPath: [] };
  return { namespace: namespaceAt(masked, frame.keywordIndex), classPath: classPathOf(frame, classFrames) };
}

function statementEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return null;
      depth -= 1;
    } else if (c === ';' && depth === 0) return i;
  }
  return null;
}

/** `[start, end)` ranges of `masked` between `from` and `to`, split at top-level `separator`. */
function splitRanges(masked, from, to, separator) {
  const ranges = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, to]);
  return ranges;
}

/**
 * Every `const string` field of the scanned files, by field name. Each entry keeps its
 * initializer as raw and masked text and the scope the initializer resolves in.
 */
export function buildConstantIndex(scans) {
  const index = new Map();
  for (const scan of scans) {
    const { masked, content, classFrames, methodFrames } = scan;
    CONST_STRING.lastIndex = 0;
    let match;
    while ((match = CONST_STRING.exec(masked))) {
      const at = match.index;
      if (enclosing(methodFrames, at)) continue;
      const owner = enclosing(classFrames, at);
      if (!owner) continue;
      const from = at + match[0].length;
      const end = statementEnd(masked, from);
      if (end == null) continue;
      const scope = scopeOf(owner, classFrames, masked);
      for (const [start, stop] of splitRanges(masked, from, end, ',')) {
        const declarator = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(masked.slice(start, stop));
        if (!declarator) continue;
        const initStart = start + declarator[0].length;
        const entry = {
          id: `${scan.relPath}:${initStart}`,
          name: declarator[1],
          raw: content.slice(initStart, stop),
          masked: masked.slice(initStart, stop),
          scope,
        };
        if (!index.has(entry.name)) index.set(entry.name, []);
        index.get(entry.name).push(entry);
      }
    }
  }
  return index;
}

function sameSegments(left, right) {
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

function endsWithSegments(full, tail) {
  return tail.length <= full.length && tail.every((part, i) => part === full[full.length - tail.length + i]);
}

/** The declarations a name can mean from `scope`: a simple name in its own class and then
 * in each class that holds it, a qualified name wherever its qualifier ends a class path. */
function candidatesFor(name, scope, index) {
  const parts = segments(name);
  const field = parts[parts.length - 1];
  const entries = index.get(field) || [];
  const qualifier = parts.slice(0, -1);
  if (qualifier.length === 0) {
    for (let depth = scope.classPath.length; depth >= 1; depth -= 1) {
      const path = scope.classPath.slice(0, depth);
      const found = entries.filter((entry) => entry.scope.namespace === scope.namespace && sameSegments(entry.scope.classPath, path));
      if (found.length > 0) return found;
    }
    return [];
  }
  return entries.filter((entry) => {
    const full = [...entry.scope.namespace.split('.').filter(Boolean), ...entry.scope.classPath];
    return endsWithSegments(full, qualifier);
  });
}

function unescapeRegular(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
      out += SIMPLE_ESCAPES[next];
      i += 1;
      continue;
    }
    const hex = next === 'u' ? /^[0-9a-fA-F]{4}/ : next === 'U' ? /^[0-9a-fA-F]{8}/ : next === 'x' ? /^[0-9a-fA-F]{1,4}/ : null;
    const digits = hex ? hex.exec(body.slice(i + 2)) : null;
    if (!digits) return null;
    out += String.fromCodePoint(parseInt(digits[0], 16));
    i += 1 + digits[0].length;
  }
  return out;
}

/**
 * The value of a C# raw string literal on one line: three or more quotes, the same count to
 * close it, and no escapes. A raw literal on more than one line is null, because its value
 * depends on the indentation and the line ends of the file.
 */
function rawLiteral(raw) {
  const quotes = /^"{3,}/.exec(raw)[0];
  if (raw.length < quotes.length * 2 || !raw.endsWith(quotes)) return null;
  const body = raw.slice(quotes.length, raw.length - quotes.length);
  if (body.includes(quotes) || body.startsWith('"') || body.endsWith('"') || /[\r\n]/.test(body)) return null;
  return body;
}

/**
 * The value of one C# string literal that holds no interpolation: a regular literal with its
 * escapes decoded, a verbatim `@"…"` literal with each `""` as one quote, or a raw literal on
 * one line. Null for any other text.
 */
export function csharpLiteral(text) {
  const raw = text.trim();
  if (raw.startsWith('"""')) return rawLiteral(raw);
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return null;
    return unescapeRegular(raw.slice(1, -1));
  }
  if (raw.startsWith('@"')) {
    if (raw.length < 3 || !raw.endsWith('"')) return null;
    const body = raw.slice(2, -1);
    if (body.replace(/""/g, '').includes('"')) return null;
    return body.replace(/""/g, '"');
  }
  return null;
}

/** The offset just past a regular or verbatim string body that opens at `from`. */
function quotedEnd(text, from, verbatim) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (!verbatim && c === '\\') i += 2;
    else if (!verbatim && (c === '\n' || c === '\r')) return i;
    else if (c === '"' && verbatim && text[i + 1] === '"') i += 2;
    else if (c === '"') return i + 1;
    else i += 1;
  }
  return text.length;
}

/** The offset just past an interpolated regular or verbatim body that opens at `from`. */
function interpolatedEnd(text, from, verbatim) {
  let i = from;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (depth > 0) {
      const literal = literalAt(text, i);
      if (literal) {
        i = literal.end;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    } else if (c === '{' && text[i + 1] === '{') i += 2;
    else if (c === '{') {
      depth = 1;
      i += 1;
    } else if (!verbatim && c === '\\') i += 2;
    else if (!verbatim && (c === '\n' || c === '\r')) return i;
    else if (c === '"' && verbatim && text[i + 1] === '"') i += 2;
    else if (c === '"') return i + 1;
    else i += 1;
  }
  return text.length;
}

/**
 * The C# string or character literal that starts at `at`, as `{ kind, end }`, where kind is
 * `regular`, `verbatim`, `raw`, `interpolated` or `char`. Null when none starts there.
 */
function literalAt(text, at) {
  const head = /^(\$*)(@?)(\$*)("+|')/.exec(text.slice(at, at + 64));
  if (!head) return null;
  const dollars = head[1].length + head[3].length;
  const verbatim = head[2] === '@';
  const quote = head[4];
  const start = at + head[0].length;
  if (quote === "'") {
    if (dollars || verbatim) return null;
    let i = start;
    while (i < text.length && text[i] !== "'" && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    return { kind: 'char', end: Math.min(text.length, i + 1) };
  }
  if (quote.length >= 3 && !verbatim) {
    const close = text.indexOf(quote, start);
    return { kind: dollars ? 'interpolated' : 'raw', end: close === -1 ? text.length : close + quote.length };
  }
  const bodyStart = at + head[1].length + head[2].length + head[3].length + 1;
  if (dollars) return { kind: 'interpolated', end: interpolatedEnd(text, bodyStart, verbatim) };
  return { kind: verbatim ? 'verbatim' : 'regular', end: quotedEnd(text, bodyStart, verbatim) };
}

/**
 * The C# text with every comment and every string and character literal blanked, offsets
 * kept, and `spans`, the `{ start, end, kind }` of each string literal. Raw and verbatim
 * literals are blanked like the rest, so no code is read from inside one.
 */
export function maskCSharpText(text) {
  const out = text.split('');
  const spans = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      let end = i;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    const literal = c === '"' || c === "'" || c === '@' || c === '$' ? literalAt(text, i) : null;
    if (literal) {
      if (literal.kind !== 'char') spans.push({ start: i, end: literal.end, kind: literal.kind });
      blank(i, literal.end);
      i = Math.max(literal.end, i + 1);
      continue;
    }
    i += 1;
  }
  return { masked: out.join(''), spans };
}

/** The text of a hole in an interpolated literal and where its closing brace is, skipping
 * string literals inside it. Null when it never closes. */
function holeEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return c === '}' ? i : null;
    }
  }
  return null;
}

/** `text` with the inside of each regular string literal blanked, length kept. */
function blankStrings(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '"') {
      out += text[i];
      continue;
    }
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    out += ' '.repeat(Math.min(j, text.length - 1) - i + 1);
    i = j;
  }
  return out.slice(0, text.length);
}

function hasTopLevel(text, chars) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && chars.includes(c)) return true;
  }
  return false;
}

function interpolated(raw, scope, index, visiting, depth) {
  let out = '';
  let i = 2;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return i === raw.length - 1 ? out : null;
    if (c === '\n' || c === '\r') return null;
    if (c === '{') {
      if (raw[i + 1] === '{') {
        out += '{';
        i += 2;
        continue;
      }
      const close = holeEnd(raw, i);
      if (close == null) return null;
      const hole = raw.slice(i + 1, close);
      // A format string or an alignment makes the hole a run-time conversion, not a constant.
      if (hasTopLevel(hole, ':,')) return null;
      const value = resolveIn(hole, blankStrings(hole), scope, index, visiting, depth + 1);
      if (value === null) return null;
      out += value;
      i = close + 1;
      continue;
    }
    if (c === '}') {
      if (raw[i + 1] !== '}') return null;
      out += '}';
      i += 2;
      continue;
    }
    if (c === '\\') {
      const escape = ESCAPE.exec(raw.slice(i));
      if (!escape) return null;
      out += unescapeRegular(escape[0]);
      i += escape[0].length;
      continue;
    }
    out += c;
    i += 1;
  }
  return null;
}

function resolveName(name, scope, index, visiting, depth) {
  const found = candidatesFor(name, scope, index);
  if (found.length === 0) return null;
  const values = new Set();
  for (const entry of found) {
    if (visiting.has(entry.id)) return null;
    visiting.add(entry.id);
    const value = resolveIn(entry.raw, entry.masked, entry.scope, index, visiting, depth + 1);
    visiting.delete(entry.id);
    if (value === null) return null;
    values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}

function resolveIn(rawText, maskedText, scope, index, visiting, depth) {
  if (depth > MAX_DEPTH) return null;
  const lead = rawText.length - rawText.trimStart().length;
  const raw = rawText.trim();
  if (raw === '') return null;
  const masked = maskedText.slice(lead, lead + raw.length);

  const parts = splitRanges(masked, 0, masked.length, '+');
  if (parts.length > 1) {
    let out = '';
    for (const [start, end] of parts) {
      const value = resolveIn(raw.slice(start, end), masked.slice(start, end), scope, index, visiting, depth + 1);
      if (value === null) return null;
      out += value;
    }
    return out;
  }
  if (raw.startsWith('(') && closesAtEnd(masked)) {
    return resolveIn(raw.slice(1, -1), masked.slice(1, -1), scope, index, visiting, depth + 1);
  }
  if (raw.startsWith('"')) {
    if (raw.startsWith('"""') || raw.length < 2 || !raw.endsWith('"')) return null;
    return unescapeRegular(raw.slice(1, -1));
  }
  if (raw.startsWith('@"')) {
    if (raw.length < 3 || !raw.endsWith('"')) return null;
    const body = raw.slice(2, -1);
    if (body.replace(/""/g, '').includes('"')) return null;
    return body.replace(/""/g, '"');
  }
  if (raw.startsWith('$"')) return interpolated(raw, scope, index, visiting, depth);
  const nameOf = /^nameof\s*\(([\s\S]*)\)$/.exec(raw);
  if (nameOf) {
    const inner = nameOf[1].trim();
    return QUALIFIED_NAME.test(inner) ? segments(inner).pop() : null;
  }
  if (QUALIFIED_NAME.test(raw)) return resolveName(raw, scope, index, visiting, depth);
  return null;
}

function closesAtEnd(masked) {
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === masked.length - 1;
    }
  }
  return false;
}

/**
 * The one value a constant string expression has from `scope`, or `null` when it has none
 * this reader can establish. `raw` and `masked` are the same text, raw and with literals and
 * comments blanked.
 */
export function resolveConstantString(raw, masked, scope, index) {
  return resolveIn(raw, masked, scope, index, new Set(), 0);
}
