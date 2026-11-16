/**
 * Backend realism of a Playwright test: whether it runs on a real backend, on patched
 * responses or on a mocked backend, and the call sites that decided it.
 *
 * Four signals decide a class: a `.route(` call on any receiver, read through its handler; a
 * `routeFromHAR(` call; and a call to a configured full-mock or patch name. The regions a test
 * runs, the helpers they reach and the class precedence come from the shared region engine,
 * with the `beforeEach`/`beforeAll` hooks and `test.describe` blocks of Playwright. A test also
 * runs the fixture regions it counts, which the fixture reader names.
 *
 * Nothing here knows a fact type: `classify` and `visits` return plain records and the extractor
 * makes the facts.
 */

import { destructuredNames, isPlaywrightFixture } from './pw-fixtures.js';
import { isInlineCallback, matchBalanced, splitArgs } from './text.js';
import { buildRegionReader, firstParamName, maskStrings, readCallSubject, readVisitPath } from './test-regions.js';

export { maskStrings };

// A handler with several route calls is as strong as the strongest one it makes.
const HANDLER_STRENGTH = { 'fetch-fulfill': 4, fulfill: 3, abort: 2, spy: 1 };
const UNREAD_HANDLER = Object.freeze({ kind: 'unresolved', reason: 'unread-handler' });

const ROUTE_MEMBER_RE = /\.\s*route\s*\(/g;
const DESCRIBE_RE = /(?<![.?\w$])test\s*\.\s*describe(?:\s*\.\s*(?:only|skip|fixme|serial|parallel))*\s*\(/g;
const HOOK_RE = /(?<![.?\w$])(?:test\s*\.\s*)?(?:beforeEach|beforeAll)\s*\(/g;

// A dotted entry names one callee as written, so `fixtures.seed` is neither
// `other.fixtures.seed` nor `this.fixtures.seed`: a suffix match would patch an unrelated
// namespace. `calleeAt` has already dropped white space and the `?` of `?.`.
function matchesEntry(callee, name, entry) {
  if (!entry.includes('.')) return name === entry;
  return callee === entry;
}

function inlineFunction(text) {
  if (!isInlineCallback(text)) return null;
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

/**
 * One reader over a repository's walked files. `files` is `[{ path, code }]` with `code`
 * already comment-blanked; `mockCalls` and `patchCalls` are the configured call names.
 */
export function buildBackendReader({ files = [], mockCalls = [], patchCalls = [], emailReads = [], fixtures = null, readerFault = () => {} } = {}) {
  function signal(file, { name, callee, before, parenOpen }, scope) {
    if (mockCalls.some((entry) => matchesEntry(callee, name, entry))) return { kind: 'mock' };
    if (patchCalls.some((entry) => matchesEntry(callee, name, entry))) return { kind: 'patch' };
    if (name === 'route' && before === '.') return readHandler(file, parenOpen, scope.visibleInFile);
    if (name === 'routeFromHAR') return { kind: 'har' };
    return null;
  }

  /**
   * The fixture regions a test counts, and one `unread-fixture` site for each counted fixture
   * the reader cannot read. A Playwright built-in fixture runs no project code.
   */
  function fixtureRegions(file, block, { hooks, fileAt }) {
    const spec = fixtures ? fixtures.forSpec(file.path) : null;
    if (!spec) return { regions: [], sites: [] };
    const usedNames = block.inline ? destructuredNames(file.masked.slice(block.fnStart, block.fnEnd)).map((n) => n.key) : [];
    for (const hook of hooks) {
      if (hook.inline) usedNames.push(...destructuredNames(file.masked.slice(hook.start, hook.end)).map((n) => n.key));
    }
    const testLine = file.lineOf(block.index);
    const unread = (name) => ({ line: testLine, where: 'fixture', kind: 'unresolved', fixture: name, reason: 'unread-fixture', order: 0 });
    const regions = [];
    const sites = [];
    for (const name of spec.counted(usedNames)) {
      const fixture = spec.fixtures.get(name);
      if (!fixture) {
        if (!isPlaywrightFixture(name)) sites.push(unread(name));
        continue;
      }
      if (fixture.unread) {
        sites.push(unread(name));
        continue;
      }
      if (fixture.regionStart === undefined) continue;
      const home = fileAt(fixture.file);
      if (!home) continue;
      regions.push({
        file: home,
        start: fixture.regionStart,
        end: fixture.regionEnd,
        where: 'fixture',
        label: { where: 'fixture', fixture: name },
        gate: (index) => fixtures.gateAt(spec, fixture, index, block.index),
      });
    }
    return { regions, sites };
  }

  const regions = buildRegionReader({ files, describeRe: DESCRIBE_RE, hookRe: HOOK_RE, signal, extraRegions: fixtureRegions, readerFault });

  function readHandler(file, parenOpen, visibleInFile = regions.visibleInFile) {
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

  const { classify } = regions;

  /** The handler kind of the `.route(` call whose argument list opens at `parenOpen`. */
  function routeHandler(path, parenOpen, code) {
    try {
      const file = regions.fileFor(path, code);
      return file ? readHandler(file, parenOpen).kind : 'unresolved';
    } catch {
      return 'unresolved';
    }
  }

  /**
   * The handler kind a repo-wide stub helper's `.route(` calls agree on. Each candidate takes the
   * strongest kind it reads; a name whose candidates disagree, or that none can read, is
   * `unresolved`.
   */
  function helperHandler(name) {
    try {
      return agreedHandler(name);
    } catch {
      return 'unresolved';
    }
  }

  function agreedHandler(name) {
    const kinds = [];
    for (const fn of regions.indexed(name)) {
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

  /** The `.goto(` calls one test runs, each with the page path it opens. */
  function visits(path, block, code) {
    return regions.collect(path, block, code, (file, { name, before, parenOpen }) =>
      name === 'goto' && before === '.' ? readVisitPath(file.code, parenOpen) : null,
    );
  }

  /** The configured email read calls one test runs, each with the subject it passes. */
  function emailReadsOf(path, block, code) {
    if (emailReads.length === 0) return [];
    return regions.collect(path, block, code, (file, { name, callee, parenOpen, regionStart }) => {
      const entry = emailReads.find((candidate) => matchesEntry(callee, name, candidate.call));
      return entry ? { call: entry.call, ...readCallSubject(file, parenOpen, entry.subject, regionStart) } : null;
    });
  }

  return { classify, visits, emailReads: emailReadsOf, routeHandler, helperHandler };
}
