/**
 * The test region engine both test runners share: which regions a test runs, what each region
 * calls, and the backend class those calls give it.
 *
 * It reads text, not a syntax tree. Comments are blanked by the caller and string contents are
 * masked here, so a call that is only written down in a comment or a string never counts, while
 * the code inside a template literal's `${…}` still does. Masking keeps every offset, so an
 * index into the masked text is the same index into the source.
 *
 * A test is read through its own body, the hooks of the file and of every describe block that
 * encloses it, and every function those regions call, followed to a fixed point. A same-file
 * function wins over a repo-wide one of the same name; a repo-wide name is resolved over the
 * class methods and top-level functions of every walked file, by bare name, because the index
 * follows no import. A runner profile says which calls are signals and how its describe blocks
 * and hooks are written.
 */

import { escapeRegExp, fullLiteral, isInlineCallback, makeLineFinder, maskLiteralText, matchBalanced, objectProperties, skipString, skipTemplate, splitArgs } from './text.js';

const KIND_ORDER = ['mock', 'patch', 'fulfill', 'fetch-fulfill', 'har', 'abort', 'spy', 'unresolved'];
const KIND_RANK = new Map(KIND_ORDER.map((kind, index) => [kind, index]));
const PATCH_KINDS = new Set(['patch', 'fulfill', 'fetch-fulfill', 'har']);

const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async',
  'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'super', 'import', 'export', 'class', 'do',
  'else', 'try', 'finally', 'throw', 'case', 'default', 'with', 'let', 'const', 'var', 'constructor',
]);

const CALL_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const FUNCTION_DECL_RE = /(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
const BOUND_FUNCTION_RE =
  /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(|\(|([A-Za-z_$][\w$]*)\s*=>)/g;
const CLASS_RE = /(?<![\w$.])class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
const METHOD_HEAD_RE =
  /^(?:(?:public|private|protected|readonly|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/;
const PROPERTY_ARROW_RE =
  /^(?:(?:public|private|protected|readonly|static|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:\(|([A-Za-z_$][\w$]*)\s*=>)/;
/**
 * The source with every string, template-literal and regex character replaced by a space,
 * quotes and newlines kept, and the code inside `${…}` kept as code.
 */
export function maskStrings(code) {
  return maskLiteralText(code);
}

/** Every `{ … }` span of masked text, as `[open, close]`, in order of the open brace. */
function braceSpans(masked) {
  const spans = [];
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length > 0) spans.push([stack.pop(), i]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

function innermostSpan(spans, position) {
  let best = null;
  for (const span of spans) {
    if (span[0] >= position) break;
    if (span[1] > position) best = span;
  }
  return best;
}

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * The value of the source text of a string or template literal part: each escape sequence
 * gives the character it stands for, and a line continuation gives nothing.
 */
function cookedText(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    const hex = next === 'x' ? /^[0-9a-fA-F]{2}/.exec(raw.slice(i + 2)) : null;
    const unit = next === 'u' ? /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(raw.slice(i + 2)) : null;
    if (hex) {
      out += String.fromCharCode(parseInt(hex[0], 16));
      i += 1 + hex[0].length;
    } else if (unit) {
      out += String.fromCodePoint(parseInt(unit[1] || unit[2], 16));
      i += 1 + unit[0].length;
    } else if (next === '\r' && raw[i + 2] === '\n') {
      i += 2;
    } else if (next === '\n' || next === '\r' || next === '\u2028' || next === '\u2029') {
      i += 1;
    } else {
      out += Object.hasOwn(SIMPLE_ESCAPES, next) ? SIMPLE_ESCAPES[next] : next;
      i += 1;
    }
  }
  return out;
}

/** The value of a string literal, or of a template literal with no `${…}`; else null. */
export function plainLiteral(text) {
  const trimmed = String(text).trim();
  const literal = fullLiteral(trimmed);
  if (literal === null || (trimmed[0] === '`' && literal.includes('${'))) return null;
  return cookedText(literal);
}

/**
 * The page path of a visit call whose argument list opens at `parenOpen`: the first argument
 * when it is a string literal with no interpolation, else `{ path: null, reason }`.
 */
export function readVisitPath(code, parenOpen) {
  const close = matchBalanced(code, parenOpen);
  if (close === -1) return { path: null, reason: 'not-literal' };
  const first = splitArgs(code.slice(parenOpen + 1, close))[0];
  const literal = first ? plainLiteral(first.text) : null;
  return literal === null ? { path: null, reason: 'not-literal' } : { path: literal };
}

/** A string or template literal as a subject pattern, each `${…}` as `*`; else null. */
function subjectPattern(text) {
  const plain = plainLiteral(text);
  if (plain !== null) return plain;
  const trimmed = text.trim();
  if (trimmed[0] !== '`' || skipTemplate(trimmed, 0) !== trimmed.length) return null;
  let out = '';
  let raw = '';
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    if (trimmed[i] === '\\') {
      raw += trimmed.slice(i, i + 2);
      i += 1;
    } else if (trimmed[i] === '$' && trimmed[i + 1] === '{') {
      const close = matchBalanced(trimmed, i + 1);
      if (close === -1) return null;
      out += `${cookedText(raw)}*`;
      raw = '';
      i = close;
    } else raw += trimmed[i];
  }
  return out + cookedText(raw);
}

const UNREADABLE_SUBJECT = Object.freeze({ subject: null, reason: 'unreadable-subject' });

/**
 * The subject a read call passes, at `position` (`{ index, key }`): the argument at `index`, or
 * the property `key` of the object literal there. A string or template literal gives its
 * pattern; a name gives the value of the one `const` the call sees, bound to one of these
 * between `regionStart` and the call. An object whose parts can carry the key at run time, or
 * that holds the key twice, and anything else, is unreadable.
 */
export function readCallSubject(file, parenOpen, position, regionStart) {
  const close = matchBalanced(file.masked, parenOpen);
  if (close === -1) return UNREADABLE_SUBJECT;
  const arg = splitArgs(file.code.slice(parenOpen + 1, close))[position.index];
  if (!arg) return UNREADABLE_SUBJECT;
  let value = arg.text.trim();
  if (position.key !== null) {
    const properties = objectProperties(value);
    const matching = properties === null ? [] : properties.filter((property) => property.key === position.key);
    if (matching.length !== 1) return UNREADABLE_SUBJECT;
    value = matching[0].value === null ? position.key : matching[0].value;
  }
  const pattern = subjectPattern(value);
  if (pattern !== null) return { subject: pattern };
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) return UNREADABLE_SUBJECT;
  const bound = boundConst(file, value, regionStart, parenOpen);
  const constant = bound === null ? null : subjectPattern(bound);
  return constant === null ? UNREADABLE_SUBJECT : { subject: constant };
}

// On the next line, a token that continues the expression makes the literal part of a longer
// value.
const CONTINUES_ON_NEXT_LINE = /^(?:[-+*/%&|^<>=!~?,.([`]|instanceof\b|in\b)/;

/**
 * Whether the statement ends right after the literal that closes at `stop`: past blanks and
 * blanked comments of any length comes `;`, `}` or a line end, and after a line end the next
 * token does not continue the expression.
 */
function literalEndsStatement(masked, stop) {
  let i = stop;
  while (i < masked.length && (masked[i] === ' ' || masked[i] === '\t')) i += 1;
  if (i >= masked.length || masked[i] === ';' || masked[i] === '}') return true;
  if (masked[i] !== '\n' && masked[i] !== '\r') return false;
  i = skipSpace(masked, i);
  return i >= masked.length || !CONTINUES_ON_NEXT_LINE.test(masked.slice(i, i + 12));
}

/**
 * The initializer text of the `const <name> =` that the call at `end` sees: the last one between
 * `start` and the call whose block holds the call. It is null unless the initializer is one
 * string or template literal and nothing else, with one declarator, and no nearer binding of
 * the name stands between it and the call.
 */
function boundConst(file, name, start, end) {
  const re = new RegExp(`(?<![\\w$.])const\\s+${escapeRegExp(name)}\\s*(?::[^=;]*)?=\\s*`, 'g');
  re.lastIndex = start;
  let found = null;
  let m;
  while ((m = re.exec(file.masked)) && m.index < end) {
    const block = innermostSpan(file.spans, m.index);
    if (block && block[1] < end) continue;
    found = m.index + m[0].length;
  }
  if (found === null) return null;
  const quote = file.code[found];
  let stop;
  if (quote === '`') stop = skipTemplate(file.code, found);
  else if (quote === "'" || quote === '"') stop = skipString(file.code, found, quote);
  else return null;
  if (stop <= found || stop > end || !literalEndsStatement(file.masked, stop)) return null;
  if (nearerBinding(file, name, stop, end)) return null;
  return file.code.slice(found, stop);
}

const DECLARATION_RE = /(?<![\w$.])(var|let|const)\s+/g;
const FUNCTION_HEAD_RE = /(?<![\w$.])function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*(?:<[^>(]*>)?\s*\(/g;
const PARAM_HEAD_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_PARAM_HEADS = new Set(['if', 'for', 'while', 'switch', 'with', 'function', 'return', 'typeof', 'await', 'new', 'void', 'delete', 'yield', 'in', 'of']);

/** The names a declarator list binds, from `from` to the end of its statement. */
function declaredNames(masked, from) {
  let i = from;
  let depth = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || (ch === '\n' && !/[,=]\s*$/.test(masked.slice(from, i))))) break;
    i += 1;
  }
  return splitArgs(masked.slice(from, i))
    .map((part) => /^([A-Za-z_$][\w$]*)/.exec(part.text))
    .filter(Boolean)
    .map((match) => match[1]);
}

/** Whether a parameter list binds `name` as a plain or rest parameter. */
function bindsParam(paramsText, name) {
  return splitArgs(paramsText).some((part) => new RegExp(`^(?:\\.\\.\\.)?${escapeRegExp(name)}\\s*(?:[:=?]|$)`).test(part.text));
}

/** The open paren that matches the close paren at `close`, read backwards; -1 for none. */
function openParenBefore(masked, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (masked[i] === ')') depth += 1;
    else if (masked[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Whether a binding of `name` between `from` and the call at `end` hides an outer `const`: a
 * `var` of the name, a `let` or `const` of it in a block that holds the call, or a function
 * that holds the call and takes it as a plain parameter.
 */
function nearerBinding(file, name, from, end) {
  const { masked, spans } = file;
  const holds = (block) => block === null || block[1] > end;
  let m;
  DECLARATION_RE.lastIndex = from;
  while ((m = DECLARATION_RE.exec(masked)) && m.index < end) {
    if (!declaredNames(masked, m.index + m[0].length).includes(name)) continue;
    if (m[1] === 'var' || holds(innermostSpan(spans, m.index))) return true;
  }
  const takesName = (paramsText, body) => body && body.bodyStart <= end && end < body.bodyEnd && bindsParam(paramsText, name);
  for (let i = masked.indexOf('=>', from); i !== -1 && i < end; i = masked.indexOf('=>', i + 2)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(masked[j])) j -= 1;
    let paramsText;
    if (masked[j] === ')') {
      const open = openParenBefore(masked, j);
      if (open === -1) continue;
      paramsText = masked.slice(open + 1, j);
    } else {
      const ident = /([A-Za-z_$][\w$]*)$/.exec(masked.slice(Math.max(0, j - 200), j + 1));
      if (!ident) continue;
      paramsText = ident[1];
    }
    if (takesName(paramsText, bodyFrom(masked, skipSpace(masked, i + 2)))) return true;
  }
  for (const re of [FUNCTION_HEAD_RE, PARAM_HEAD_RE]) {
    re.lastIndex = from;
    while ((m = re.exec(masked)) && m.index < end) {
      if (re === PARAM_HEAD_RE && NOT_PARAM_HEADS.has(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBalanced(masked, open);
      if (close === -1) continue;
      const body = re === FUNCTION_HEAD_RE ? bodyAfterParams(masked, close, false) : /^\s*\{/.test(masked.slice(close + 1)) ? bodyAfterParams(masked, close, false) : null;
      if (takesName(masked.slice(open + 1, close), body)) return true;
    }
  }
  return false;
}

export function firstParamName(paramsText) {
  const first = splitArgs(paramsText)[0];
  if (!first) return null;
  const m = /^([A-Za-z_$][\w$]*)\s*(?:[:=?,]|$)/.exec(first.text);
  return m ? m[1] : null;
}

/** The body span of a function whose parameter list closes at `paramClose`. */
function bodyAfterParams(masked, paramClose, arrow) {
  let j = paramClose + 1;
  if (arrow) {
    const tail = /^\s*(?::[^=;{]*)?=>\s*/.exec(masked.slice(j, j + 400));
    if (!tail) return null;
    j += tail[0].length;
    return bodyFrom(masked, j);
  }
  while (j < masked.length && masked[j] !== '{' && masked[j] !== ';') j += 1;
  if (masked[j] !== '{') return null;
  const close = matchBalanced(masked, j);
  return close === -1 ? null : { bodyStart: j + 1, bodyEnd: close };
}

/** A block body, or an expression body that runs to the first `;`, `,` or unmatched closer. */
function bodyFrom(masked, j) {
  if (masked[j] === '{') {
    const close = matchBalanced(masked, j);
    return close === -1 ? null : { bodyStart: j + 1, bodyEnd: close };
  }
  let depth = 0;
  let k = j;
  while (k < masked.length) {
    const ch = masked[k];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ';' || ch === ',') && depth === 0) break;
    k += 1;
  }
  return { bodyStart: j, bodyEnd: k };
}

function classMembers(masked, bodyStart, bodyEnd) {
  const members = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const ch = masked[i];
    if (/\s/.test(ch) || ch === ';' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '@') {
      const m = /^@[A-Za-z_$][\w$.]*\s*/.exec(masked.slice(i, i + 200));
      i += m ? m[0].length : 1;
      if (masked[i] === '(') {
        const close = matchBalanced(masked, i);
        i = close === -1 ? bodyEnd : close + 1;
      }
      continue;
    }
    const window = masked.slice(i, Math.min(bodyEnd, i + 400));
    const property = PROPERTY_ARROW_RE.exec(window);
    if (property) {
      const head = i + property[0].length;
      let body = null;
      let paramsText = '';
      if (property[2]) {
        paramsText = property[2];
        body = bodyFrom(masked, skipSpace(masked, head));
      } else {
        const close = matchBalanced(masked, head - 1);
        if (close !== -1) {
          paramsText = masked.slice(head, close);
          body = bodyAfterParams(masked, close, true);
        }
      }
      if (body) {
        members.push({ name: property[1], paramsText, declStart: i, ...body });
        i = body.bodyEnd + 1;
        continue;
      }
    }
    const method = METHOD_HEAD_RE.exec(window);
    if (method) {
      const open = i + method[0].length - 1;
      const close = matchBalanced(masked, open);
      if (close !== -1) {
        const body = bodyAfterParams(masked, close, false);
        if (body && body.bodyStart - close < 400) {
          members.push({ name: method[1], paramsText: masked.slice(open + 1, close), declStart: i, ...body });
          i = body.bodyEnd + 1;
          continue;
        }
      }
    }
    if ('([{'.includes(ch)) {
      const close = matchBalanced(masked, i);
      i = close === -1 ? bodyEnd : close + 1;
      continue;
    }
    while (i < bodyEnd && !/[\s;,{([]/.test(masked[i])) i += 1;
  }
  return members;
}

function skipSpace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/**
 * Every function of one file: `function` declarations and expressions with a name, functions
 * and arrows bound to a `const`/`let`/`var`, and the methods and arrow properties of its
 * classes. `scope` is where a call can see it by name; `indexed` says whether the repo-wide
 * helper index holds it.
 */
function collectFunctions(file) {
  const { masked, spans } = file;
  const functions = [];
  const scopeOf = (position) => innermostSpan(spans, position) || [-1, masked.length];
  let m;

  FUNCTION_DECL_RE.lastIndex = 0;
  while ((m = FUNCTION_DECL_RE.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(masked, open);
    if (close === -1) continue;
    const body = bodyAfterParams(masked, close, false);
    if (!body) continue;
    const scope = scopeOf(m.index);
    functions.push({ name: m[1], qualified: m[1], paramsText: masked.slice(open + 1, close), declStart: m.index, scope, indexed: scope[0] === -1, ...body });
  }

  BOUND_FUNCTION_RE.lastIndex = 0;
  while ((m = BOUND_FUNCTION_RE.exec(masked))) {
    const scope = scopeOf(m.index);
    const head = m.index + m[0].length;
    let body = null;
    let paramsText = '';
    if (m[2]) {
      paramsText = m[2];
      body = bodyFrom(masked, skipSpace(masked, head));
    } else {
      const close = matchBalanced(masked, head - 1);
      if (close === -1) continue;
      paramsText = masked.slice(head, close);
      body = bodyAfterParams(masked, close, !/function\b/.test(m[0]));
    }
    if (!body) continue;
    functions.push({ name: m[1], qualified: m[1], paramsText, declStart: m.index, scope, indexed: scope[0] === -1, ...body });
  }

  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(masked, open);
    if (close === -1) continue;
    const topLevel = innermostSpan(spans, m.index) === null;
    for (const member of classMembers(masked, open + 1, close)) {
      functions.push({
        ...member,
        qualified: `${m[1]}.${member.name}`,
        scope: [-1, masked.length],
        indexed: topLevel && member.name !== 'constructor',
      });
    }
  }

  functions.sort((a, b) => a.bodyStart - b.bodyStart);
  for (const fn of functions) {
    fn.file = file;
    fn.param = firstParamName(fn.paramsText);
  }
  return functions;
}

/** `this.page.route` for the `route` at `nameIndex`: the identifier chain the call is written on. */
function calleeAt(text, nameIndex, name) {
  const parts = [name];
  let i = nameIndex;
  for (;;) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    if (text[j] !== '.') break;
    j -= 1;
    if (text[j] === '?') j -= 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    let k = j;
    while (k >= 0 && /[\w$]/.test(text[k])) k -= 1;
    const ident = text.slice(k + 1, j + 1);
    if (!/^[A-Za-z_$][\w$]*$/.test(ident)) break;
    parts.unshift(ident);
    i = k + 1;
  }
  return parts.join('.');
}

function previousToken(text, index) {
  let j = index - 1;
  while (j >= 0 && /[\s*]/.test(text[j])) j -= 1;
  if (text[j] === '.') return '.';
  let k = j;
  while (k >= 0 && /[\w$]/.test(text[k])) k -= 1;
  return text.slice(k + 1, j + 1);
}

function sameKinds(a, b) {
  if (a.size !== b.size) return false;
  for (const kind of a.keys()) if (!b.has(kind)) return false;
  return true;
}

/**
 * One region reader over a repository's walked files. `files` is `[{ path, code }]` with `code`
 * already comment-blanked. `describeRe` and `hookRe` find the runner's describe blocks and
 * hooks. `signal(file, call, scope)` gives the signal a call is, as `{ kind, reason? }`, or null
 * for a call the reader follows; `call` is `{ name, callee, before, parenOpen }` and
 * `scope.visibleInFile` finds a same-file function by name. `extraFunctions(file)` gives the
 * functions a runner defines through a call rather than a declaration, each with `name`,
 * `qualified`, `paramsText`, `declStart`, `bodyStart` and `bodyEnd`. They are always
 * repo-wide; with `indexAll` false, they are the only repo-wide functions.
 */
export function buildRegionReader({ files = [], describeRe, hookRe, signal, extraFunctions = null, indexAll = true, extraRegions = null, readerFault = () => {} }) {
  const byPath = new Map();
  const repoIndex = new Map();
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  function parseFile(path, code) {
    const masked = maskStrings(code);
    const file = { path, code, masked, lineOf: makeLineFinder(code), spans: braceSpans(masked) };
    file.functions = collectFunctions(file);
    if (!indexAll) for (const fn of file.functions) fn.indexed = false;
    if (extraFunctions) {
      for (const fn of extraFunctions(file)) {
        file.functions.push({ ...fn, scope: [-1, masked.length], indexed: true, file, param: firstParamName(fn.paramsText) });
      }
      file.functions.sort((a, b) => a.bodyStart - b.bodyStart);
    }
    file.byName = new Map();
    for (const fn of file.functions) {
      const list = file.byName.get(fn.name) || [];
      list.push(fn);
      file.byName.set(fn.name, list);
    }
    return file;
  }

  // A file this reader cannot parse is left out of the index rather than failing the
  // extraction: its own tests then classify as `unread-file`, never as `real`.
  for (const { path, code } of ordered) {
    let file;
    try {
      file = parseFile(path, code);
    } catch {
      continue;
    }
    byPath.set(path, file);
    for (const fn of file.functions) {
      if (!fn.indexed) continue;
      const list = repoIndex.get(fn.name) || [];
      list.push(fn);
      repoIndex.set(fn.name, list);
    }
  }

  function fileFor(path, code) {
    let file = byPath.get(path);
    if (!file && typeof code === 'string') {
      try {
        file = parseFile(path, code);
      } catch {
        return null;
      }
      byPath.set(path, file);
      summarize(file.functions);
    }
    return file || null;
  }

  /** The same-file functions a call at `position` sees by `name`, innermost scope first. */
  function visibleInFile(file, name, position) {
    const visible = (file.byName.get(name) || []).filter((fn) => fn.scope[0] < position && position < fn.scope[1]);
    if (visible.length === 0) return [];
    const narrowest = Math.min(...visible.map((fn) => fn.scope[1] - fn.scope[0]));
    return visible.filter((fn) => fn.scope[1] - fn.scope[0] === narrowest);
  }

  /**
   * The functions a call follows. A same-file declaration inside the scanned region is not
   * followed, because the scan already reads its body.
   */
  function candidates(file, name, position, regionStart, regionEnd) {
    const local = visibleInFile(file, name, position);
    if (local.length > 0) {
      return local.filter((fn) => fn.declStart < regionStart || fn.declStart >= regionEnd);
    }
    return repoIndex.get(name) || [];
  }

  const scope = { visibleInFile };

  /** Signals and calls of one region, in source order. */
  function scanRegion(file, start, end) {
    const text = file.masked;
    const signals = [];
    const calls = [];
    CALL_RE.lastIndex = start;
    let m;
    while ((m = CALL_RE.exec(text)) && m.index < end) {
      const name = m[1];
      if (NOT_CALLS.has(name)) continue;
      const before = previousToken(text, m.index);
      if (before === 'function' || before === 'new') continue;
      const callee = calleeAt(text, m.index, name);
      const parenOpen = m.index + m[0].length - 1;
      const at = { index: m.index, line: file.lineOf(m.index), call: callee };
      const found = signal(file, { name, callee, before, parenOpen }, scope);
      if (found) signals.push({ ...at, ...found });
      else calls.push({ ...at, name, cands: candidates(file, name, m.index, start, end) });
    }
    return { signals, calls: calls.filter((call) => call.cands.length > 0) };
  }

  // Two kind summaries per function: `may` holds what some candidate of each call reaches,
  // `must` what every candidate reaches. Both are least fixed points, so a cycle ends the walk.
  const summaries = new Map();
  const allFunctions = [];
  const extend = (witness, fn) => ({ ...witness, chain: [fn.qualified, ...witness.chain] });

  /** Adds the summaries of `functions` and settles every summary again. */
  function summarize(functions) {
    for (const fn of functions) {
      const scan = scanRegion(fn.file, fn.bodyStart, fn.bodyEnd);
      const own = new Map();
      for (const signal of scan.signals) {
        if (own.has(signal.kind)) continue;
        own.set(signal.kind, { kind: signal.kind, call: signal.call, file: fn.file.path, line: signal.line, reason: signal.reason, chain: [] });
      }
      summaries.set(fn, { calls: scan.calls, may: new Map(own), must: new Map(own) });
      allFunctions.push(fn);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const fn of allFunctions) {
        const summary = summaries.get(fn);
        for (const call of summary.calls) {
          for (const cand of call.cands) {
            for (const [kind, witness] of summaries.get(cand).may) {
              if (summary.may.has(kind)) continue;
              summary.may.set(kind, extend(witness, cand));
              changed = true;
            }
          }
          const lead = call.cands[0];
          for (const [kind, witness] of summaries.get(lead).must) {
            if (summary.must.has(kind)) continue;
            if (!call.cands.every((cand) => summaries.get(cand).must.has(kind))) continue;
            summary.must.set(kind, extend(witness, lead));
            changed = true;
          }
        }
      }
    }
  }

  const indexed = [];
  for (const file of byPath.values()) indexed.push(...file.functions);
  summarize(indexed);

  /**
   * The sites of one region. `gate`, when given, says for a call at an index whether it runs:
   * `off` drops it, and `unread` turns a call that can stub into one `unread-option` site.
   */
  function regionSites(file, start, end, where, gate = null) {
    const sites = [];
    const scan = scanRegion(file, start, end);
    const unreadOption = (at) => sites.push({ line: at.line, where, kind: 'unresolved', call: at.call, reason: 'unread-option', order: start });
    for (const signal of scan.signals) {
      const state = gate ? gate(signal.index) : 'on';
      if (state === 'off') continue;
      if (state === 'unread') {
        unreadOption(signal);
        continue;
      }
      sites.push({ line: signal.line, where, kind: signal.kind, call: signal.call, reason: signal.reason, order: start });
    }
    for (const call of scan.calls) {
      const state = gate ? gate(call.index) : 'on';
      if (state === 'off') continue;
      if (state === 'unread') {
        if (call.cands.some((cand) => summaries.get(cand).may.size > 0)) unreadOption(call);
        continue;
      }
      const lead = call.cands[0];
      const must = new Map();
      const may = new Map();
      for (const kind of summaries.get(lead).must.keys()) {
        if (call.cands.every((cand) => summaries.get(cand).must.has(kind))) must.set(kind, true);
      }
      for (const cand of call.cands) for (const kind of summaries.get(cand).may.keys()) may.set(kind, true);
      for (const kind of must.keys()) {
        const witness = extend(summaries.get(lead).must.get(kind), lead);
        const local = witness.file === file.path;
        sites.push({
          line: local ? witness.line : call.line,
          where: 'helper',
          kind,
          call: witness.call,
          via: witness.chain,
          ...(local ? {} : { at: { file: witness.file, line: witness.line } }),
          reason: witness.reason,
          order: start,
        });
      }
      if (!sameKinds(must, may)) {
        sites.push({
          line: call.line,
          where: 'helper',
          kind: 'unresolved',
          call: call.call,
          ...(call.cands.length === 1 ? { via: [lead.qualified] } : {}),
          reason: 'ambiguous-helper',
          order: start,
        });
      }
    }
    return sites;
  }

  function describeSpans(file) {
    if (!file.describes) {
      file.describes = [];
      describeRe.lastIndex = 0;
      let m;
      while ((m = describeRe.exec(file.masked))) {
        const open = m.index + m[0].length - 1;
        const close = matchBalanced(file.masked, open);
        if (close !== -1) file.describes.push([open, close]);
      }
    }
    return file.describes;
  }

  function hooks(file) {
    if (!file.hooks) {
      file.hooks = [];
      hookRe.lastIndex = 0;
      let m;
      while ((m = hookRe.exec(file.masked))) {
        const open = m.index + m[0].length - 1;
        const close = matchBalanced(file.masked, open);
        if (close === -1) continue;
        const inner = file.masked.slice(open + 1, close);
        const parts = splitArgs(inner);
        const last = parts[parts.length - 1];
        let block = null;
        for (const span of describeSpans(file)) {
          if (span[0] < m.index && m.index < span[1] && (!block || span[0] > block[0])) block = span;
        }
        const call = m[0].replace(/\s*\($/, '').replace(/\s+/g, '');
        const fnStart = last ? open + 1 + last.start + (inner.slice(last.start).length - inner.slice(last.start).trimStart().length) : open + 1;
        file.hooks.push({
          index: m.index,
          line: file.lineOf(m.index),
          call,
          block,
          inline: !!last && isInlineCallback(last.text),
          start: fnStart,
          end: last ? fnStart + last.text.length : close,
        });
      }
    }
    return file.hooks;
  }

  /**
   * The class of one test. `block` is `{ index, fnStart, fnEnd, inline }`: where the declaration
   * starts and the span of the function argument that holds its body.
   */
  function classify(path, block, code) {
    let file = null;
    try {
      file = fileFor(path, code);
    } catch {
      file = null;
    }
    // A file the reader cannot parse classifies each of its tests as unread. A failure while one
    // test is read goes to the caller, which keeps the other tests of the spec.
    if (!file) return { backend: 'unknown', sites: [], reason: 'unread-file' };
    return classifyIn(file, block);
  }

  /** The hooks that run before the test whose declaration starts at `index`. */
  function hooksOf(file, index) {
    return hooks(file).filter((hook) => !hook.block || (hook.block[0] < index && index < hook.block[1]));
  }

  /**
   * What `pick(file, call)` gives for the calls one test runs: those of the hooks that run
   * before it, of its own body, and of each function those call, the same regions that decide
   * its class. `call.regionStart` is where the walked function body starts. Each item gets
   * `file`, `line` and `where`; each function is read once per test.
   */
  function collect(path, block, code, pick) {
    try {
      const file = fileFor(path, code);
      return file ? collectIn(file, block, pick) : [];
    } catch {
      return [];
    }
  }

  /**
   * The regions a test runs beyond its hooks and its own body, from `extraRegions`: each with its
   * `file`, `start`, `end`, `where`, the `label` its sites carry and an optional `gate`; and the
   * sites of the regions the reader cannot read.
   */
  function extraOf(file, block) {
    if (!extraRegions) return { regions: [], sites: [] };
    return extraRegions(file, block, { hooks: hooksOf(file, block.index), fileAt: (path) => byPath.get(path) });
  }

  function collectIn(file, block, pick) {
    const items = [];
    const read = new Set();
    const walkRegion = (at, start, end, where, gate = null) => {
      const re = new RegExp(CALL_RE.source, 'g');
      re.lastIndex = start;
      let m;
      while ((m = re.exec(at.masked)) && m.index < end) {
        const name = m[1];
        if (NOT_CALLS.has(name)) continue;
        const before = previousToken(at.masked, m.index);
        if (before === 'function' || before === 'new') continue;
        // A call that an option turns off does not run, and one that an option the reader
        // cannot read decides may not run, so neither gives an item.
        if (gate && gate(m.index) !== 'on') continue;
        const call = { name, callee: calleeAt(at.masked, m.index, name), before, parenOpen: m.index + m[0].length - 1, regionStart: start };
        const found = pick(at, call);
        if (found) {
          items.push({ ...found, file: at.path, line: at.lineOf(m.index), where });
          continue;
        }
        for (const cand of candidates(at, name, m.index, start, end)) {
          if (read.has(cand)) continue;
          read.add(cand);
          walkRegion(cand.file, cand.bodyStart, cand.bodyEnd, 'helper');
        }
      }
    };
    for (const hook of hooksOf(file, block.index)) if (hook.inline) walkRegion(file, hook.start, hook.end, 'hook');
    if (block.inline) walkRegion(file, block.fnStart, block.fnEnd, 'test');
    for (const region of extraOf(file, block).regions) walkRegion(region.file, region.start, region.end, region.where, region.gate);
    return items;
  }

  function classifyIn(file, block) {
    const sites = [];
    readerFault('backend', { spec: file.path, test: block.title });
    for (const hook of hooksOf(file, block.index)) {
      if (!hook.inline) {
        sites.push({ line: hook.line, where: 'hook', kind: 'unresolved', call: hook.call, reason: 'body-by-reference', order: hook.start });
        continue;
      }
      sites.push(...regionSites(file, hook.start, hook.end, 'hook'));
    }
    if (block.inline) sites.push(...regionSites(file, block.fnStart, block.fnEnd, 'test'));
    const extra = extraOf(file, block);
    sites.push(...extra.sites);
    const testLine = file.lineOf(block.index);
    for (const region of extra.regions) {
      for (const site of regionSites(region.file, region.start, region.end, region.where, region.gate)) {
        // A site in another file is shown at the test's own line, with `at` naming where it is written.
        const placed = region.file === file ? site : { ...site, line: testLine, at: site.at || { file: region.file.path, line: site.line } };
        sites.push({ ...placed, ...region.label, order: 0 });
      }
    }

    sites.sort((a, b) => a.line - b.line || a.order - b.order || KIND_RANK.get(a.kind) - KIND_RANK.get(b.kind));
    const seen = new Set();
    const unique = [];
    for (const site of sites) {
      const { reason, order, ...shown } = site;
      if (shown.call === undefined) delete shown.call;
      const key = JSON.stringify(shown);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ shown, reason });
    }
    const kinds = new Set(unique.map((site) => site.shown.kind));
    let backend = 'real';
    if (kinds.has('mock')) backend = 'mocked';
    else if ([...kinds].some((kind) => PATCH_KINDS.has(kind))) backend = 'patched';
    else if (!block.inline || kinds.has('unresolved')) backend = 'unknown';
    const result = { backend, sites: unique.map((site) => site.shown) };
    if (backend === 'unknown') {
      result.reason = !block.inline ? 'body-by-reference' : unique.find((site) => site.shown.kind === 'unresolved').reason;
    }
    return result;
  }

  return { classify, collect, fileFor, visibleInFile, indexed: (name) => repoIndex.get(name) || [] };
}
