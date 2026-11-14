/**
 * Playwright fixtures of a spec: the `test` it calls, traced through `.extend(...)` chains and
 * relative imports, and the fixtures and options each level of the chain defines.
 *
 * One reader serves the backend class and the receiver types of the helper-call walk, so both
 * see the same fixtures. It reads text, not a syntax tree, and only the files it is given: the
 * walked files of the extract root, so an import outside the root or an excluded file is never
 * read.
 *
 * A fixture is read from an object literal `extend` argument: an arrow, a `function`, a method
 * shorthand, `[fn, { auto: true }]`, `[value, { option: true }]` or a literal value. Its region
 * is the code of its function from the start of the body to its `use(` call, because only that
 * code runs before the test does.
 */

import { posix } from 'node:path';
import { maskLiteralText, matchBalanced, splitArgs } from './text.js';

// The fixtures and options Playwright Test supplies itself, from the `Fixtures` and
// `TestOptions` reference of Playwright Test 1.49. A name in this list is never unread.
const PLAYWRIGHT_FIXTURES = new Set([
  'browser', 'browserName', 'context', 'page', 'request', 'playwright',
  'acceptDownloads', 'actionTimeout', 'baseURL', 'bypassCSP', 'channel', 'clientCertificates',
  'colorScheme', 'connectOptions', 'contextOptions', 'defaultBrowserType', 'deviceScaleFactor',
  'extraHTTPHeaders', 'geolocation', 'hasTouch', 'headless', 'httpCredentials',
  'ignoreHTTPSErrors', 'isMobile', 'javaScriptEnabled', 'launchOptions', 'locale',
  'navigationTimeout', 'offline', 'permissions', 'proxy', 'screenshot', 'serviceWorkers',
  'storageState', 'testIdAttribute', 'timezoneId', 'trace', 'userAgent', 'video', 'viewport',
]);

const PLAYWRIGHT_MODULE = '@playwright/test';
const IDENT = '[A-Za-z_$][\\w$]*';
const IMPORT_RE = /(?<![\w$.])import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])/g;
const EXPORT_LIST_RE = /(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}(\s*from\s*(['"]))?/g;
const DESCRIBE_RE = /(?<![.?\w$])test\s*\.\s*describe(?:\s*\.\s*(?:only|skip|fixme|serial|parallel))*\s*\(/g;
const USE_RE = /(?<![.?\w$])test\s*\.\s*use\s*\(/g;
const GATE_RE = new RegExp(`(?<![\\w$.])if\\s*\\(\\s*(!\\s*)?(${IDENT})\\s*\\)`, 'g');

/** Whether `name` is a fixture or an option that Playwright Test supplies. */
export function isPlaywrightFixture(name) {
  return PLAYWRIGHT_FIXTURES.has(name);
}

/**
 * The names a function destructures from its first parameter, as `[{ key, local }]`, where
 * `fnText` starts at the function (`async ({ a, b: c }) => …`). An empty list when the first
 * parameter is not an object pattern.
 */
export function destructuredNames(fnText) {
  const open = fnText.indexOf('(');
  if (open === -1 || !/^\s*(?:async\s+)?(?:function\b[^(]*)?$/.test(fnText.slice(0, open))) return [];
  const close = matchBalanced(fnText, open);
  if (close === -1) return [];
  const first = splitArgs(fnText.slice(open + 1, close))[0];
  if (!first || first.text[0] !== '{') return [];
  const patternEnd = matchBalanced(first.text, 0);
  if (patternEnd === -1) return [];
  const names = [];
  for (const part of splitArgs(first.text.slice(1, patternEnd))) {
    const m = new RegExp(`^(${IDENT})\\s*(?::\\s*(${IDENT}))?`).exec(part.text);
    if (m) names.push({ key: m[1], local: m[2] || m[1] });
  }
  return names;
}

function leading(text) {
  return text.length - text.trimStart().length;
}

/** The literal value of `text`: a boolean, a number, a string or `null`, else not readable. */
function literalValue(text) {
  const t = text.trim();
  if (t === 'true') return { ok: true, value: true };
  if (t === 'false') return { ok: true, value: false };
  if (t === 'null') return { ok: true, value: null };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) return { ok: true, value: Number(t) };
  const m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(t) || /^`([^`$\\]*)`$/.exec(t);
  if (m) return { ok: true, value: m[2] !== undefined ? m[2] : m[1] };
  return { ok: false };
}

/** The `{ name: value }` pairs of an object literal's text, with `value` as written. */
function objectPairs(text) {
  const t = text.trim();
  if (t[0] !== '{' || matchBalanced(t, 0) !== t.length - 1) return null;
  const pairs = new Map();
  for (const part of splitArgs(t.slice(1, -1))) {
    const m = new RegExp(`^(?:(${IDENT})|(['"])([^'"]*)\\2)\\s*:`).exec(part.text);
    if (m) pairs.set(m[1] || m[3], part.text.slice(m[0].length).trim());
  }
  return pairs;
}

/** The end of a `<…>` type argument list that opens at `open`, or -1. */
function typeArgsEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '<') depth += 1;
    else if (ch === '>' && text[i - 1] !== '=') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (ch === ';' && depth === 0) return -1;
  }
  return -1;
}

/** `name: Type` members of an inline type literal, as name -> the type's leading identifier. */
function typeMembers(typeArgsText) {
  const types = new Map();
  const t = typeArgsText.trim();
  if (t[0] !== '{') return types;
  const close = matchBalanced(t, 0);
  if (close === -1) return types;
  for (const raw of t.slice(1, close).split(/[;,\n]/)) {
    const m = new RegExp(`^\\s*(${IDENT})\\s*\\??\\s*:\\s*(${IDENT})`).exec(raw);
    if (m) types.set(m[1], m[2]);
  }
  return types;
}

/**
 * The function that a fixture value's text starts with, as offsets into the file: its
 * parameters and its body. Null when the text is not a function written in place.
 */
function readFunction(masked, start, end, method = false) {
  const text = masked.slice(start, end);
  const head = /^(?:async\s+)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*)?\(/.exec(text);
  if (!head) return null;
  const open = start + head[0].length - 1;
  const close = matchBalanced(masked, open);
  if (close === -1 || close >= end) return null;
  const isFunction = method || /function\b/.test(head[0]);
  let j = close + 1;
  if (!isFunction) {
    const arrow = /^\s*(?::[^=;{]*)?=>\s*/.exec(masked.slice(j, end));
    if (!arrow) return null;
    j += arrow[0].length;
  } else {
    while (j < end && /\s/.test(masked[j])) j += 1;
  }
  const params = masked.slice(open + 1, close);
  if (masked[j] === '{') {
    const bodyEnd = matchBalanced(masked, j);
    if (bodyEnd === -1 || bodyEnd >= end) return null;
    return { paramsStart: open, params, bodyStart: j + 1, bodyEnd };
  }
  if (isFunction) return null;
  return { paramsStart: open, params, bodyStart: j, bodyEnd: end };
}

/**
 * One reader over a repository's walked files. `files` is `[{ path, code }]`, with `path`
 * relative to the extract root and `code` comment-blanked.
 */
export function buildFixtureReader({ files = [] } = {}) {
  const sources = new Map(files.map((file) => [file.path, file.code]));
  const parsed = new Map();
  const specs = new Map();

  function fileAt(path) {
    if (!sources.has(path)) return null;
    if (!parsed.has(path)) {
      const code = sources.get(path);
      parsed.set(path, { path, code, masked: maskLiteralText(code), imports: null, exports: null });
    }
    return parsed.get(path);
  }

  /** The module specifier of the string whose opening quote is at `quote`. */
  function specifierAt(file, quote) {
    const close = file.code.indexOf(file.code[quote], quote + 1);
    return close === -1 ? null : file.code.slice(quote + 1, close);
  }

  function importsOf(file) {
    if (!file.imports) {
      file.imports = new Map();
      IMPORT_RE.lastIndex = 0;
      let m;
      while ((m = IMPORT_RE.exec(file.masked))) {
        const from = specifierAt(file, m.index + m[0].length - 1);
        if (from === null) continue;
        for (const part of splitArgs(m[1])) {
          const s = new RegExp(`^(?:type\\s+)?(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(part.text);
          if (s) file.imports.set(s[2] || s[1], { from, imported: s[1] });
        }
      }
    }
    return file.imports;
  }

  /** Export name -> `{ local }` for a local binding or `{ from, imported }` for a re-export. */
  function exportsOf(file) {
    if (!file.exports) {
      file.exports = new Map();
      EXPORT_LIST_RE.lastIndex = 0;
      let m;
      while ((m = EXPORT_LIST_RE.exec(file.masked))) {
        const from = m[2] ? specifierAt(file, m.index + m[0].length - 1) : null;
        for (const part of splitArgs(m[1])) {
          const s = new RegExp(`^(?:type\\s+)?(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(part.text);
          if (!s) continue;
          file.exports.set(s[2] || s[1], from === null ? { local: s[1] } : { from, imported: s[1] });
        }
      }
    }
    return file.exports;
  }

  /** The walked file a relative specifier names, else null. */
  function resolveModule(fromPath, specifier) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    if (base.startsWith('../')) return null;
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, `${stem}.ts`, `${base}.ts`, `${base}/index.ts`]) {
      if (sources.has(candidate)) return candidate;
    }
    return null;
  }

  /** The `extend` call that a top-level `const <name> =` binds, as offsets into the file. */
  function extendDefinition(file, name) {
    const re = new RegExp(`(?<![\\w$.])(?:export\\s+)?(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=;]+)?=\\s*(${IDENT})\\s*\\.\\s*extend\\s*`, 'g');
    const m = re.exec(file.masked);
    if (!m) return null;
    let j = m.index + m[0].length;
    let typeArgs = '';
    if (file.masked[j] === '<') {
      const close = typeArgsEnd(file.masked, j);
      if (close === -1) return null;
      typeArgs = file.code.slice(j + 1, close);
      j = close + 1;
      while (/\s/.test(file.masked[j] || '')) j += 1;
    }
    if (file.masked[j] !== '(') return null;
    const close = matchBalanced(file.masked, j);
    if (close === -1) return null;
    const first = splitArgs(file.masked.slice(j + 1, close))[0];
    const argStart = first ? j + 1 + first.start + leading(file.masked.slice(j + 1 + first.start)) : j + 1;
    return { base: m[1], typeArgs, argStart, argEnd: first ? argStart + first.text.length : argStart };
  }

  /** One level of a chain: the fixtures its object literal argument defines. */
  function readLevel(file, def) {
    const level = { file: file.path, unreadable: false, fixtures: new Map() };
    const types = typeMembers(def.typeArgs);
    const { masked } = file;
    if (masked[def.argStart] !== '{' || matchBalanced(masked, def.argStart) !== def.argEnd - 1) {
      level.unreadable = true;
      return level;
    }
    const innerStart = def.argStart + 1;
    for (const part of splitArgs(masked.slice(innerStart, def.argEnd - 1))) {
      const start = innerStart + part.start + leading(masked.slice(innerStart + part.start));
      const end = start + part.text.length;
      const fixture = readProperty(file, start, end);
      if (!fixture) continue;
      if (fixture.type === null && types.has(fixture.name)) fixture.type = types.get(fixture.name);
      level.fixtures.set(fixture.name, fixture);
    }
    return level;
  }

  function readProperty(file, start, end) {
    const { masked, code } = file;
    const text = masked.slice(start, end);
    const method = new RegExp(`^(?:async\\s+)?(?:\\*\\s*)?(${IDENT})\\s*\\(`).exec(text);
    if (method && method[1] !== 'async') {
      const fn = readFunction(masked, start + method[0].length - 1, end, true);
      return fn ? fixtureOf(file, method[1], fn, {}) : { name: method[1], unread: true, type: null };
    }
    const key = new RegExp(`^(?:(${IDENT})|(['"])([^'"]*)\\2)\\s*:\\s*`).exec(code.slice(start, end));
    if (!key) return null;
    const name = key[1] || key[3];
    const valueStart = start + key[0].length;
    const valueText = masked.slice(valueStart, end).trimEnd();
    const fn = readFunction(masked, valueStart, end);
    if (fn) return fixtureOf(file, name, fn, {});
    if (valueText[0] === '[' && matchBalanced(masked, valueStart) === valueStart + valueText.length - 1) {
      const items = splitArgs(masked.slice(valueStart + 1, valueStart + valueText.length - 1));
      const optionsText = items[1] ? code.slice(valueStart + 1 + items[1].start, valueStart + 1 + items[1].start + leading(masked.slice(valueStart + 1 + items[1].start)) + items[1].text.length) : '{}';
      const flags = objectPairs(optionsText) || new Map();
      const first = items[0];
      if (!first) return { name, unread: true, type: null };
      const firstStart = valueStart + 1 + first.start + leading(masked.slice(valueStart + 1 + first.start));
      const firstEnd = firstStart + first.text.length;
      if (flags.get('option') === 'true') {
        return { name, option: true, value: literalValue(code.slice(firstStart, firstEnd)), deps: [], type: null };
      }
      const inner = readFunction(masked, firstStart, firstEnd);
      if (!inner) return { name, unread: true, type: null, auto: flags.get('auto') === 'true' };
      return fixtureOf(file, name, inner, { auto: flags.get('auto') === 'true' });
    }
    const value = literalValue(code.slice(valueStart, end));
    if (value.ok) return { name, value, deps: [], type: null };
    return { name, unread: true, type: null };
  }

  function fixtureOf(file, name, fn, { auto = false }) {
    const params = splitArgs(fn.params);
    const deps = destructuredNames(`(${fn.params})`);
    const useName = params[1] ? new RegExp(`^(${IDENT})`).exec(params[1].text)?.[1] || 'use' : 'use';
    const useRe = new RegExp(`(?<![\\w$.])${useName.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    useRe.lastIndex = fn.bodyStart;
    const m = useRe.exec(file.masked);
    const regionEnd = m && m.index < fn.bodyEnd ? m.index : fn.bodyEnd;
    let type = null;
    if (m && m.index < fn.bodyEnd) {
      const created = new RegExp(`^${useName.replace(/\$/g, '\\$')}\\s*\\(\\s*new\\s+(${IDENT})`).exec(file.masked.slice(m.index, fn.bodyEnd));
      if (created) type = created[1];
    }
    return { name, file: file.path, regionStart: fn.bodyStart, regionEnd, deps, auto, type };
  }

  /**
   * The chain levels behind `name` in `path`, outermost base first. An empty list is
   * `@playwright/test` itself; null is a `test` the reader cannot trace.
   */
  function chainOf(path, name, seen) {
    const key = `${path}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const file = fileAt(path);
    if (!file) return null;
    const def = extendDefinition(file, name);
    if (def) {
      const parent = chainOf(path, def.base, seen);
      return parent === null ? null : [...parent, readLevel(file, def)];
    }
    const imported = importsOf(file).get(name);
    if (imported) return chainThrough(path, imported.from, imported.imported, seen);
    const exported = exportsOf(file).get(name);
    if (exported && exported.from) return chainThrough(path, exported.from, exported.imported, seen);
    if (exported && exported.local !== name) return chainOf(path, exported.local, seen);
    return null;
  }

  function chainThrough(path, from, imported, seen) {
    if (from === PLAYWRIGHT_MODULE) return imported === 'test' ? [] : null;
    const target = resolveModule(path, from);
    if (!target) return null;
    const file = fileAt(target);
    const exported = exportsOf(file).get(imported);
    if (exported && exported.from) return chainThrough(target, exported.from, exported.imported, seen);
    return chainOf(target, exported ? exported.local : imported, seen);
  }

  function describeSpans(file) {
    const spans = [];
    DESCRIBE_RE.lastIndex = 0;
    let m;
    while ((m = DESCRIBE_RE.exec(file.masked))) {
      const open = m.index + m[0].length - 1;
      const close = matchBalanced(file.masked, open);
      if (close !== -1) spans.push([open, close]);
    }
    return spans;
  }

  function innermost(spans, index) {
    let best = null;
    for (const span of spans) {
      if (span[0] < index && index < span[1] && (!best || span[0] > best[0])) best = span;
    }
    return best;
  }

  /** Every `test.use({ … })` of a spec, with the scope it sets values for. */
  function usesOf(file, describes) {
    const uses = [];
    USE_RE.lastIndex = 0;
    let m;
    while ((m = USE_RE.exec(file.masked))) {
      const open = m.index + m[0].length - 1;
      const close = matchBalanced(file.masked, open);
      if (close === -1) continue;
      const pairs = objectPairs(file.code.slice(open + 1, close)) || new Map();
      const values = new Map([...pairs].map(([name, text]) => [name, literalValue(text)]));
      uses.push({ index: m.index, scope: innermost(describes, m.index), values });
    }
    return uses;
  }

  function readSpec(path) {
    const file = fileAt(path);
    if (!file) return null;
    const chain = chainOf(path, 'test', new Set());
    if (!chain || chain.length === 0) return null;
    const fixtures = new Map();
    let partial = false;
    for (const level of chain) {
      if (level.unreadable) partial = true;
      for (const [name, fixture] of level.fixtures) fixtures.set(name, fixture);
    }
    const describes = describeSpans(file);
    const uses = usesOf(file, describes);

    /** The value of option `name` for the test declared at `index`. */
    function optionValue(name, index) {
      const scopes = describes.filter((span) => span[0] < index && index < span[1]).sort((a, b) => b[0] - a[0]);
      for (const scope of [...scopes, null]) {
        const set = uses.filter((use) => use.scope === scope && use.values.has(name));
        if (set.length > 0) return set[set.length - 1].values.get(name);
      }
      const fixture = fixtures.get(name);
      return fixture && fixture.option ? fixture.value : { ok: false };
    }

    /** The fixtures a test counts: the names it uses, every `auto` fixture, and their dependencies. */
    function counted(names) {
      const out = [];
      const seen = new Set();
      const queue = [...names, ...[...fixtures.values()].filter((f) => f.auto).map((f) => f.name)];
      while (queue.length > 0) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
        const fixture = fixtures.get(name);
        if (fixture && fixture.deps) queue.push(...fixture.deps.map((dep) => dep.key));
      }
      return out;
    }

    return {
      fixtures,
      partial,
      optionValue,
      counted,
      typeOf: (name) => fixtures.get(name)?.type || null,
    };
  }

  /** The fixtures of the spec at `path`, or null when its `test` is Playwright's own or untraced. */
  function forSpec(path) {
    if (!specs.has(path)) specs.set(path, readSpec(path));
    return specs.get(path);
  }

  /**
   * The option gates around `index` in the region of `fixture`: `on`, `off`, or `unread` when an
   * option value cannot be resolved. An `if` whose condition is not one option name keeps the
   * stub, as at any other site.
   */
  function gateAt(spec, fixture, index, testIndex) {
    const file = fileAt(fixture.file);
    const locals = new Map(fixture.deps.map((dep) => [dep.local, dep.key]));
    let result = 'on';
    GATE_RE.lastIndex = fixture.regionStart;
    let m;
    while ((m = GATE_RE.exec(file.masked)) && m.index < index) {
      const key = locals.get(m[2]);
      const option = key && spec.fixtures.get(key);
      if (!option || !option.option) continue;
      const branches = gateBranches(file.masked, m.index + m[0].length, fixture.regionEnd);
      const negate = !!m[1];
      let truth = null;
      if (branches.then[0] <= index && index < branches.then[1]) truth = !negate;
      else if (branches.otherwise && branches.otherwise[0] <= index && index < branches.otherwise[1]) truth = negate;
      if (truth === null) continue;
      const value = spec.optionValue(key, testIndex);
      if (!value.ok) result = 'unread';
      else if (Boolean(value.value) !== truth) return 'off';
    }
    return result;
  }

  return { forSpec, gateAt };
}

/** The `then` span of an `if` whose condition closes before `start`, and its `else` span. */
function gateBranches(masked, start, limit) {
  const then = statementSpan(masked, start, limit);
  let j = then[1];
  if (masked[j] === ';') j += 1;
  while (j < limit && /\s/.test(masked[j])) j += 1;
  const elseMatch = /^else\b\s*/.exec(masked.slice(j, limit));
  if (!elseMatch) return { then, otherwise: null };
  return { then, otherwise: statementSpan(masked, j + elseMatch[0].length, limit) };
}

function statementSpan(masked, start, limit) {
  let j = start;
  while (j < limit && /\s/.test(masked[j])) j += 1;
  if (masked[j] === '{') {
    const close = matchBalanced(masked, j);
    return [j, close === -1 ? limit : close + 1];
  }
  let depth = 0;
  let k = j;
  while (k < limit) {
    const ch = masked[k];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ';' && depth === 0) break;
    k += 1;
  }
  return [j, k];
}
