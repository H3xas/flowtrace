/**
 * Backend realism of a Playwright test: whether it runs on a real backend, on patched
 * responses or on a mocked backend, and the call sites that decided it.
 *
 * Like the rest of the Playwright extractor this reads text, not a syntax tree. Comments are
 * blanked by the caller and string contents are masked here, so a stub that is only written
 * down in a comment or a string never counts, while the code inside a template literal's
 * `${…}` still does. Masking keeps every offset, so an index into the masked text is the same
 * index into the source.
 *
 * Four signals decide a class: a `.route(` call on any receiver, read through its handler; a
 * `routeFromHAR(` call; and a call to a configured full-mock or patch name. A test is read
 * through its own body, the `beforeEach`/`beforeAll` hooks of the file and of every
 * `test.describe` block that encloses it, and every function those regions call, followed to a
 * fixed point. A same-file function wins over a repo-wide one of the same name; a repo-wide
 * name is resolved over the class methods and top-level functions of every walked file, by
 * bare name, because the index follows no import.
 *
 * Nothing here knows a fact type: `classify` returns a plain record and the extractor makes the
 * fact.
 */

import { makeLineFinder, matchBalanced, skipString, splitArgs } from './text.js';

const KIND_ORDER = ['mock', 'patch', 'fulfill', 'fetch-fulfill', 'har', 'abort', 'spy', 'unresolved'];
const KIND_RANK = new Map(KIND_ORDER.map((kind, index) => [kind, index]));
const PATCH_KINDS = new Set(['patch', 'fulfill', 'fetch-fulfill', 'har']);
// A handler with several route calls is as strong as the strongest one it makes.
const HANDLER_STRENGTH = { 'fetch-fulfill': 4, fulfill: 3, abort: 2, spy: 1 };
const UNREAD_HANDLER = Object.freeze({ kind: 'unresolved', reason: 'unread-handler' });

const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async',
  'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'super', 'import', 'export', 'class', 'do',
  'else', 'try', 'finally', 'throw', 'case', 'default', 'with', 'let', 'const', 'var', 'constructor',
]);

const CALL_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const ROUTE_MEMBER_RE = /\.\s*route\s*\(/g;
const DESCRIBE_RE = /(?<![.?\w$])test\s*\.\s*describe(?:\s*\.\s*(?:only|skip|fixme|serial|parallel))*\s*\(/g;
const HOOK_RE = /(?<![.?\w$])(?:test\s*\.\s*)?(?:beforeEach|beforeAll)\s*\(/g;
const FUNCTION_DECL_RE = /(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
const BOUND_FUNCTION_RE =
  /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(|\(|([A-Za-z_$][\w$]*)\s*=>)/g;
const CLASS_RE = /(?<![\w$.])class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
const METHOD_HEAD_RE =
  /^(?:(?:public|private|protected|readonly|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/;
const PROPERTY_ARROW_RE =
  /^(?:(?:public|private|protected|readonly|static|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:\(|([A-Za-z_$][\w$]*)\s*=>)/;
const INLINE_FUNCTION_RE = /^(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * The source with every string and template-literal character replaced by a space, quotes and
 * newlines kept, and the code inside `${…}` kept as code.
 */
export function maskStrings(code) {
  const out = code.split('');
  maskRange(code, 0, code.length, out);
  return out.join('');
}

function blank(out, from, to) {
  for (let k = from; k < to; k += 1) {
    if (out[k] !== '\n') out[k] = ' ';
  }
}

function maskRange(code, start, end, out) {
  let i = start;
  while (i < end) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const close = skipString(code, i, ch);
      const terminated = close > i + 1 && code[close - 1] === ch && close <= end;
      blank(out, i + 1, terminated ? close - 1 : Math.min(close, end));
      i = close;
      continue;
    }
    if (ch === '`') {
      i = maskTemplate(code, i, end, out);
      continue;
    }
    i += 1;
  }
}

function maskTemplate(code, open, end, out) {
  let i = open + 1;
  while (i < end) {
    const ch = code[i];
    if (ch === '\\') {
      blank(out, i, Math.min(i + 2, end));
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && code[i + 1] === '{') {
      const close = matchBalanced(code, i + 1);
      const stop = close === -1 ? end : close;
      maskRange(code, i + 2, stop, out);
      i = close === -1 ? end : close + 1;
      continue;
    }
    blank(out, i, i + 1);
    i += 1;
  }
  return i;
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

function firstParamName(paramsText) {
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

function matchesEntry(callee, name, entry) {
  if (!entry.includes('.')) return name === entry;
  return callee === entry || callee.endsWith(`.${entry}`);
}

function inlineFunction(text) {
  const arrowParam = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  if (arrowParam && arrowParam[1] !== 'function') {
    return { param: arrowParam[1], bodyText: text.slice(arrowParam[0].length) };
  }
  const head = /^(?:async\s+)?(?:(function)\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(|\()/.exec(text);
  if (!head) return null;
  const open = head[0].length - 1;
  const close = matchBalanced(text, open);
  if (close === -1) return null;
  const rest = text.slice(close + 1);
  if (!head[1] && !/^\s*(?::[^=;{]*)?=>/.test(rest)) return null;
  return { param: firstParamName(text.slice(open + 1, close)), bodyText: rest };
}

function handlerKind(param, bodyText) {
  if (!param) return UNREAD_HANDLER;
  const re = new RegExp(`(?<![\\w$.])${param.replace(/\$/g, '\\$')}\\s*(?:\\?\\.|\\.)\\s*(fulfill|fetch|continue|fallback|abort)\\s*\\(`, 'g');
  const seen = new Set();
  let m;
  while ((m = re.exec(bodyText))) seen.add(m[1]);
  if (seen.has('fulfill')) return { kind: seen.has('fetch') ? 'fetch-fulfill' : 'fulfill' };
  if (seen.has('abort')) return { kind: 'abort' };
  if (seen.has('continue') || seen.has('fallback')) return { kind: 'spy' };
  return UNREAD_HANDLER;
}

function sameKinds(a, b) {
  if (a.size !== b.size) return false;
  for (const kind of a.keys()) if (!b.has(kind)) return false;
  return true;
}

/**
 * One reader over a repository's walked files. `files` is `[{ path, code }]` with `code`
 * already comment-blanked; `mockCalls` and `patchCalls` are the configured call names.
 */
export function buildBackendReader({ files = [], mockCalls = [], patchCalls = [] } = {}) {
  const byPath = new Map();
  const repoIndex = new Map();
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  function parseFile(path, code) {
    const masked = maskStrings(code);
    const file = { path, masked, lineOf: makeLineFinder(code), spans: braceSpans(masked) };
    file.functions = collectFunctions(file);
    file.byName = new Map();
    for (const fn of file.functions) {
      const list = file.byName.get(fn.name) || [];
      list.push(fn);
      file.byName.set(fn.name, list);
    }
    return file;
  }

  for (const { path, code } of ordered) {
    const file = parseFile(path, code);
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
      file = parseFile(path, code);
      byPath.set(path, file);
    }
    return file;
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

  function readHandler(file, parenOpen) {
    const text = file.masked;
    if (text[parenOpen] !== '(') return UNREAD_HANDLER;
    const close = matchBalanced(text, parenOpen);
    if (close === -1) return UNREAD_HANDLER;
    const inner = text.slice(parenOpen + 1, close);
    const handler = splitArgs(inner)[1];
    if (!handler) return UNREAD_HANDLER;
    const inline = inlineFunction(handler.text);
    if (inline) return handlerKind(inline.param, inline.bodyText);
    const chain = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.exec(handler.text);
    if (!chain) return UNREAD_HANDLER;
    const name = handler.text.split('.').pop().trim();
    const named = visibleInFile(file, name, parenOpen + 1 + handler.start);
    if (named.length === 0) return { kind: 'unresolved', reason: 'named-handler' };
    const fn = named[0];
    return handlerKind(fn.param, text.slice(fn.bodyStart, fn.bodyEnd));
  }

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
      if (mockCalls.some((entry) => matchesEntry(callee, name, entry))) {
        signals.push({ ...at, kind: 'mock' });
      } else if (patchCalls.some((entry) => matchesEntry(callee, name, entry))) {
        signals.push({ ...at, kind: 'patch' });
      } else if (name === 'route' && before === '.') {
        signals.push({ ...at, ...readHandler(file, parenOpen) });
      } else if (name === 'routeFromHAR') {
        signals.push({ ...at, kind: 'har' });
      } else {
        calls.push({ ...at, name, cands: candidates(file, name, m.index, start, end) });
      }
    }
    return { signals, calls: calls.filter((call) => call.cands.length > 0) };
  }

  // Two kind summaries per function: `may` holds what some candidate of each call reaches,
  // `must` what every candidate reaches. Both are least fixed points, so a cycle ends the walk.
  const summaries = new Map();
  const allFunctions = [];
  for (const file of byPath.values()) allFunctions.push(...file.functions);
  for (const fn of allFunctions) {
    const scan = scanRegion(fn.file, fn.bodyStart, fn.bodyEnd);
    const own = new Map();
    for (const signal of scan.signals) {
      if (own.has(signal.kind)) continue;
      own.set(signal.kind, { kind: signal.kind, call: signal.call, file: fn.file.path, line: signal.line, reason: signal.reason, chain: [] });
    }
    summaries.set(fn, { calls: scan.calls, may: new Map(own), must: new Map(own) });
  }
  const extend = (witness, fn) => ({ ...witness, chain: [fn.qualified, ...witness.chain] });
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

  function regionSites(file, start, end, where) {
    const sites = [];
    const scan = scanRegion(file, start, end);
    for (const signal of scan.signals) {
      sites.push({ line: signal.line, where, kind: signal.kind, call: signal.call, reason: signal.reason, order: start });
    }
    for (const call of scan.calls) {
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
      DESCRIBE_RE.lastIndex = 0;
      let m;
      while ((m = DESCRIBE_RE.exec(file.masked))) {
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
      HOOK_RE.lastIndex = 0;
      let m;
      while ((m = HOOK_RE.exec(file.masked))) {
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
          inline: !!last && INLINE_FUNCTION_RE.test(last.text),
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
    const file = fileFor(path, code);
    if (!file) return { backend: 'unknown', sites: [], reason: 'unread-handler' };
    const sites = [];
    for (const hook of hooks(file)) {
      if (hook.block && !(hook.block[0] < block.index && block.index < hook.block[1])) continue;
      if (!hook.inline) {
        sites.push({ line: hook.line, where: 'hook', kind: 'unresolved', call: hook.call, reason: 'body-by-reference', order: hook.start });
        continue;
      }
      sites.push(...regionSites(file, hook.start, hook.end, 'hook'));
    }
    if (block.inline) sites.push(...regionSites(file, block.fnStart, block.fnEnd, 'test'));

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

  /** The handler kind of the `.route(` call whose argument list opens at `parenOpen`. */
  function routeHandler(path, parenOpen, code) {
    const file = fileFor(path, code);
    return file ? readHandler(file, parenOpen).kind : 'unresolved';
  }

  /**
   * The handler kind a repo-wide stub helper's `.route(` calls agree on. Each candidate takes the
   * strongest kind it reads; a name whose candidates disagree, or that none can read, is
   * `unresolved`.
   */
  function helperHandler(name) {
    const kinds = [];
    for (const fn of repoIndex.get(name) || []) {
      const body = fn.file.masked.slice(0, fn.bodyEnd);
      let best = null;
      let routes = 0;
      ROUTE_MEMBER_RE.lastIndex = fn.bodyStart;
      let m;
      while ((m = ROUTE_MEMBER_RE.exec(body))) {
        routes += 1;
        const { kind } = readHandler(fn.file, m.index + m[0].length - 1);
        if (kind !== 'unresolved' && (best === null || HANDLER_STRENGTH[kind] > HANDLER_STRENGTH[best])) best = kind;
      }
      if (routes > 0) kinds.push(best || 'unresolved');
    }
    if (kinds.length === 0) return 'unresolved';
    return kinds.every((kind) => kind === kinds[0]) ? kinds[0] : 'unresolved';
  }

  return { classify, routeHandler, helperHandler };
}
