/**
 * Playwright API harness extractor.
 *
 * Heuristic, regex-and-bracket-matching reader over a Playwright TypeScript API test
 * harness (feature client packages plus `test()` specs). It does not parse TypeScript;
 * it recognises the idioms this kind of harness uses for wrapping an HTTP request behind
 * a client method, asserting a response status, and tagging a test with a test-management
 * case id,
 * turning each occurrence into one fact (see `lib/facts.js` for the fact shapes).
 *
 * Three passes:
 *  1. every `.ts` file under the repo is scanned once for its module-level string and
 *     object-literal consts (`const X = "..."`, `const X = { a: "..." } as const`), its
 *     named imports and its exports. A name in a URL resolves in the file that writes the
 *     URL: its own const, else the one value the files exporting an imported name agree
 *     on, else the one value the repository holds for that name.
 *  2. every class method and top-level function (arrow-const or `function`) becomes one
 *     body, with its call sites in source order: a request (`<receiver>.<verb>(<url>)`)
 *     or a call into another body through a typed parameter, a `new`/factory binding,
 *     `this`, a typed class field, or a bare function name.
 *  3. a fixed point marks every body that reaches a request. A body that calls `.route(`
 *     stubs responses and never counts as a request source.
 *
 * Spec files (`tests/**`) are then walked for `test(`/`test.skip(`/`test.only(`/
 * `test.fixme(` blocks, `case-id` annotation pushes (plus any configured case-id
 * calls), and the requests and assertions each test body makes. A call from a test body
 * is followed into at most `MAX_BODIES` bodies; every request it reaches is one fact at
 * the test's own call, carrying the chain of calls that led there.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { walk } from '../walk.js';
import { fact } from '../facts.js';
import { buildBackendReader } from './pw-backend.js';
import { buildFixtureReader, destructuredNames } from './pw-fixtures.js';
import {
  bestPartial,
  blankComments,
  computeDepths,
  escapeRegExp,
  fullLiteral,
  isInlineCallback,
  isSimpleInterpolation,
  makeLineFinder,
  maskLiteralText,
  matchBalanced,
  skipString,
  skipTemplate,
  splitArgs,
  splitPlus,
  toRelative,
} from './text.js';

const TESTS_SUBPATH = 'tests';
const DEFAULT_EXCLUDE = ['node_modules', 'generated', 'playwright-report', 'dist', '*.d.ts'];

const KNOWN_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const VERB_UPPER = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const TERMINAL_ASSERT_METHODS = new Set(['toBe', 'toEqual']);
// Bodies a test's call may enter on its way to a request. A fixed bound keeps a call graph
// with a deep or wide helper layer from multiplying facts without end.
const MAX_BODIES = 4;

/** Entry point: repoRoot is the harness checkout (the directory holding `tests/`). */
export async function extract(repoRoot, options = {}) {
  const extraExclude = Array.isArray(options.exclude) ? options.exclude : [];
  const exclude = [...DEFAULT_EXCLUDE, ...extraExclude];
  const caseIdCallRe = buildCaseIdCallRe(options.caseIdCalls);
  const backendCalls = options.backendCalls || {};
  // A caller can make one reader fail at a named point, so the containment of a failure can be
  // shown end to end. The CLI builds its options from fixed keys and never sets this.
  const fault = typeof options.readerFault === 'function' ? options.readerFault : () => {};

  const allFiles = walk(repoRoot, { extensions: ['.ts'], exclude });

  // Every file is parsed once into `{code, depths, classSpans, fnSpans}`. `depths` is the
  // brace-nesting depth at every character — 0 only at true module scope — so module-const
  // scanning and top-level-function scanning can both skip anything declared *inside* some
  // other construct (a test body, an `if`, a `describe`, another function): without it, a
  // test's own local `const id = \`WidgetAPI${…}\`;` would leak into the shared consts
  // map and silently rewrite every unrelated `${id}` path-parameter interpolation in the repo.
  const fileInfo = new Map();
  const moduleConsts = new Map();
  for (const absPath of allFiles) {
    try {
      const info = parseFile(repoRoot, absPath);
      fileInfo.set(absPath, info);
      collectModuleConsts(info.code, moduleConsts, info.depths);
    } catch {
      continueExtraction();
    }
  }

  const walkedFiles = [...fileInfo].map(([absPath, info]) => ({ path: toRelative(repoRoot, absPath), code: info.code }));
  const fixtures = buildFixtureReader({ files: walkedFiles });
  const requestCtx = buildRequestContext(fileInfo);
  requestCtx.fault = fault;
  requestCtx.fixtures = fixtures;

  const backendReader = buildBackendReader({
    files: walkedFiles,
    mockCalls: Array.isArray(backendCalls.mockCalls) ? backendCalls.mockCalls : [],
    patchCalls: Array.isArray(backendCalls.patchCalls) ? backendCalls.patchCalls : [],
    fixtures,
    readerFault: fault,
  });

  const facts = [];
  const testsRoot = joinPath(repoRoot, TESTS_SUBPATH);
  const testsSpecFiles = existsSync(testsRoot) ? walk(testsRoot, { extensions: ['.ts'], exclude }) : [];
  const testsSpecSet = new Set(testsSpecFiles);
  // A Playwright UI E2E harness may have no `tests/` convention — its specs can be
  // `.pw.ts` files anywhere in the repo — so they are found from the same repo-wide walk
  // rather than a second directory-scoped one, and still run through the case-id/request/
  // assert scan below: a UI spec asserting nothing but a locator count still produces a
  // valid `pw_test` (title, skipped), which is exactly what the coverage report
  // wants for a "playwright specs" column.
  const pwSpecFiles = allFiles.filter((absPath) => absPath.endsWith(PW_SPEC_EXTENSION) && !testsSpecSet.has(absPath));
  const specFiles = [...testsSpecFiles, ...pwSpecFiles];
  for (const absPath of specFiles) {
    try {
      const info = fileInfo.get(absPath) || parseFile(repoRoot, absPath);
      processSpecFile(info, requestCtx, facts, caseIdCallRe, backendReader);
    } catch {
      continueExtraction();
    }
  }

  if (pwSpecFiles.length > 0) {
    const endpointRegistry = new Map();
    for (const info of fileInfo.values()) {
      try {
        collectEndpointRegistry(info.code, info.depths, endpointRegistry);
      } catch {
        continueExtraction();
      }
    }
    const stubMethodIndex = collectStubMethodIndex(fileInfo, fault);
    for (const absPath of pwSpecFiles) {
      try {
        const info = fileInfo.get(absPath);
        const code = info ? info.code : blankComments(readFileSync(absPath, 'utf8'));
        fault('stub-spec', { spec: toRelative(repoRoot, absPath) });
        processPwStubFile(repoRoot, absPath, code, mapLookup(moduleConsts), endpointRegistry, stubMethodIndex, facts, backendReader);
      } catch {
        continueExtraction();
      }
    }
  }

  return facts;
}

function continueExtraction() {}

function looksLikeUrl(template) {
  return typeof template === 'string' && template.includes('/');
}

/** Module-level string and object-literal consts: `const X = "..."`, `const X = {...}`. */

const OBJECT_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g;
const STRING_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2\s*;/g;
const PROP_RE = /([A-Za-z_$][\w$]*)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;

function isTopLevel(index, depths) {
  return depths[index] === 0;
}

function collectModuleConsts(code, moduleConsts, depths) {
  OBJECT_CONST_RE.lastIndex = 0;
  let m;
  while ((m = OBJECT_CONST_RE.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBalanced(code, braceOpen);
    if (braceClose === -1) continue;
    const body = code.slice(braceOpen + 1, braceClose);
    const props = new Map();
    PROP_RE.lastIndex = 0;
    let pm;
    while ((pm = PROP_RE.exec(body))) props.set(pm[1], pm[3]);
    if (props.size > 0) moduleConsts.set(m[1], { kind: 'object', props });
  }
  STRING_CONST_RE.lastIndex = 0;
  while ((m = STRING_CONST_RE.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    if (!moduleConsts.has(m[1])) moduleConsts.set(m[1], { kind: 'string', value: m[3] });
  }
}

/** URL argument resolution: literal, template literal (with const substitution), `+`. */

/**
 * A const lookup answers `(name, prop)` with `{ status: 'value', value }`, or with status
 * `none` (no const of that name) or `ambiguous` (more than one value is left). A bare name
 * reads a string const, `name.prop` reads one property of an object const.
 */
const NO_VALUE = Object.freeze({ status: 'none' });
const AMBIGUOUS_VALUE = Object.freeze({ status: 'ambiguous' });

function constEntryValue(entry, prop) {
  if (prop === undefined) return entry.kind === 'string' ? entry.value : undefined;
  return entry.kind === 'object' ? entry.props.get(prop) : undefined;
}

/** The repo-wide first-wins map: the stub path reads consts this way. */
function mapLookup(moduleConsts) {
  return (name, prop) => {
    const entry = moduleConsts.get(name);
    const value = entry ? constEntryValue(entry, prop) : undefined;
    return value === undefined ? NO_VALUE : { status: 'value', value };
  };
}

function substituteConst(inner, lookup) {
  const trimmed = inner.trim();
  const memberMatch = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (memberMatch) return lookup(memberMatch[1], memberMatch[2]);
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return lookup(trimmed);
  return NO_VALUE;
}

function foldInterpolations(text, lookup) {
  let out = '';
  let resolved = true;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const braceOpen = i + 1;
      const braceClose = matchBalanced(text, braceOpen);
      const end = braceClose === -1 ? text.length : braceClose + 1;
      const inner = braceClose === -1 ? text.slice(braceOpen + 1) : text.slice(braceOpen + 1, braceClose);
      if (isSimpleInterpolation(inner)) {
        const substituted = substituteConst(inner, lookup);
        out += substituted.status === 'value' ? substituted.value : text.slice(i, end);
        // A name with no const is a path parameter; a name with two values is a guess.
        if (substituted.status === 'ambiguous') resolved = false;
      } else {
        out += '*';
        resolved = false;
      }
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return { text: out, resolved };
}

function resolveUrlExpr(text, lookup) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { template: '*', resolved: false };

  const quote = trimmed[0];
  if (quote === "'" || quote === '"' || quote === '`') {
    const end = quote === '`' ? skipTemplate(trimmed, 0) : skipString(trimmed, 0, quote);
    if (end === trimmed.length) {
      const inner = trimmed.slice(1, end - 1);
      if (quote === '`') {
        const flat = foldInterpolations(inner, lookup);
        return { template: flat.text, resolved: flat.resolved };
      }
      return { template: inner, resolved: true };
    }
  }

  const plusParts = splitPlus(trimmed);
  if (plusParts.length > 1) {
    let template = '';
    let resolved = true;
    for (const part of plusParts) {
      const r = resolveUrlExpr(part, lookup);
      template += r.template;
      if (!r.resolved) resolved = false;
    }
    return { template, resolved };
  }

  const memberMatch = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (memberMatch) {
    const found = lookup(memberMatch[1], memberMatch[2]);
    if (found.status === 'value') return { template: found.value, resolved: true };
    return { template: bestPartial(trimmed), resolved: false };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const found = lookup(trimmed);
    if (found.status === 'value') return { template: found.value, resolved: true };
    return { template: `\${${trimmed}}`, resolved: false };
  }

  return { template: bestPartial(trimmed), resolved: false };
}

/** Class scanning: class spans and their members. */

function findClassSpans(code, depths) {
  const spans = [];
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
  let m;
  while ((m = classRe.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBalanced(code, braceOpen);
    if (braceClose === -1) continue;
    spans.push({ className: m[1], index: m.index, bodyStart: braceOpen + 1, bodyEnd: braceClose });
  }
  return spans;
}

const MEMBER_HEAD_RE = /(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(/;

function splitClassMembers(code, bodyStart, bodyEnd) {
  const members = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 || nl > bodyEnd ? bodyEnd : nl;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? bodyEnd : end + 2;
      continue;
    }
    const window = code.slice(i, Math.min(bodyEnd, i + 200));
    const headMatch = MEMBER_HEAD_RE.exec(window);
    if (headMatch && headMatch.index === 0) {
      const name = headMatch[1];
      const parenOpen = i + headMatch[0].length - 1;
      const parenClose = matchBalanced(code, parenOpen);
      if (parenClose === -1) {
        i += 1;
        continue;
      }
      let j = parenClose + 1;
      let braceIdx = -1;
      while (j < bodyEnd) {
        const c = code[j];
        if (c === "'" || c === '"') {
          j = skipString(code, j, c);
          continue;
        }
        if (c === '`') {
          j = skipTemplate(code, j);
          continue;
        }
        if (c === '{') {
          braceIdx = j;
          break;
        }
        if (c === ';' || c === ',') break;
        j += 1;
      }
      if (braceIdx !== -1) {
        const closeBrace = matchBalanced(code, braceIdx);
        if (closeBrace === -1) {
          i = bodyEnd;
          continue;
        }
        members.push({
          name,
          paramsText: code.slice(parenOpen + 1, parenClose),
          bodyStart: braceIdx + 1,
          bodyEnd: closeBrace,
        });
        i = closeBrace + 1;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      const close = matchBalanced(code, i);
      i = close === -1 ? bodyEnd : close + 1;
      continue;
    }
    i += 1;
  }
  return members;
}

/** Top-level function scanning: arrow-consts and `function` declarations. */

function findTopLevelFunctionSpans(code, depths) {
  const spans = [];
  const arrowRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/g;
  let m;
  while ((m = arrowRe.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const paramsText = code.slice(parenOpen + 1, parenClose);
    const arrowIdx = code.indexOf('=>', parenClose);
    if (arrowIdx === -1 || arrowIdx > parenClose + 400) continue;
    let j = arrowIdx + 2;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (code[j] === '{') {
      const braceClose = matchBalanced(code, j);
      if (braceClose === -1) continue;
      spans.push({ name: m[1], index: m.index, paramsText, bodyText: code.slice(j + 1, braceClose), bodyStart: j + 1, bodyEnd: braceClose });
      continue;
    }
    let k = j;
    let depth = 0;
    while (k < code.length) {
      const ch = code[k];
      if (ch === "'" || ch === '"') {
        k = skipString(code, k, ch);
        continue;
      }
      if (ch === '`') {
        k = skipTemplate(code, k);
        continue;
      }
      if ('([{'.includes(ch)) {
        depth += 1;
        k += 1;
        continue;
      }
      if (')]}'.includes(ch)) {
        if (depth === 0) break;
        depth -= 1;
        k += 1;
        continue;
      }
      if (ch === ';' && depth === 0) break;
      k += 1;
    }
    spans.push({ name: m[1], index: m.index, paramsText, bodyText: code.slice(j, k), bodyStart: j, bodyEnd: k });
  }

  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const paramsText = code.slice(parenOpen + 1, parenClose);
    let j = parenClose + 1;
    while (j < code.length && code[j] !== '{' && code[j] !== ';') j += 1;
    if (j >= code.length || code[j] !== '{') continue;
    const braceClose = matchBalanced(code, j);
    if (braceClose === -1) continue;
    spans.push({ name: m[1], index: m.index, paramsText, bodyText: code.slice(j + 1, braceClose), bodyStart: j + 1, bodyEnd: braceClose });
  }
  return spans;
}

function parseParamInfos(paramsText) {
  return splitArgs(paramsText).map((part) => {
    const typed = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$.]*)/.exec(part.text);
    if (typed) return { name: typed[1], type: typed[2] };
    const bare = /^\s*([A-Za-z_$][\w$]*)/.exec(part.text);
    return { name: bare ? bare[1] : '', type: null };
  });
}

/** The status a top-level helper asserts on a response it holds: `expect(r.status()).toBe(...)`. */
function helperAssertInfo(body) {
  const bodyText = body.info.code.slice(body.bodyStart, body.bodyEnd);
  const assertMatch = /expect\(\s*([A-Za-z_$][\w$]*)\.status\(\)\s*\)\s*\.\s*(toBe|toEqual)\(\s*([^)]*)\)/.exec(bodyText);
  if (!assertMatch) return null;
  const paramNames = body.params.map((p) => p.name);
  const argExpr = assertMatch[3].trim();
  const ternaryMatch = /^([A-Za-z_$][\w$]*)\s*\?\s*(-?\d+)\s*:\s*(-?\d+)$/.exec(argExpr);
  if (ternaryMatch && paramNames.includes(ternaryMatch[1])) {
    return {
      kind: 'ternary',
      paramIndex: paramNames.indexOf(ternaryMatch[1]),
      trueValue: Number(ternaryMatch[2]),
      falseValue: Number(ternaryMatch[3]),
    };
  }
  if (/^-?\d+$/.test(argExpr)) return { kind: 'literal', value: Number(argExpr) };
  return { kind: 'unresolved' };
}

function collectFactoryMap(fnSpans) {
  const map = new Map();
  for (const span of fnSpans) {
    const m = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/.exec(span.bodyText);
    if (m) map.set(span.name, m[1]);
  }
  return map;
}

const IDENT_BIND_RE =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:new\s+([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*\()/g;

function collectIdentBindings(code, factoryMap) {
  const map = new Map();
  IDENT_BIND_RE.lastIndex = 0;
  let m;
  while ((m = IDENT_BIND_RE.exec(code))) {
    if (m[2]) {
      map.set(m[1], m[2]);
      continue;
    }
    if (m[3] && factoryMap.has(m[3])) map.set(m[1], factoryMap.get(m[3]));
  }
  return map;
}

/** Per-file parse: blanked code, depth map, class and function spans, and the file's own names. */
function parseFile(repoRoot, absPath) {
  const code = blankComments(readFileSync(absPath, 'utf8'));
  const depths = computeDepths(code);
  return {
    rel: toRelative(repoRoot, absPath),
    code,
    depths,
    classSpans: findClassSpans(code, depths),
    fnSpans: findTopLevelFunctionSpans(code, depths),
    names: collectFileNames(code, depths),
    masked: null,
    stubMasked: null,
    lineOf: null,
    lookup: null,
    factories: null,
    bindings: null,
  };
}

const EXPORTED_DECL_RE = /\bexport\s+(?:declare\s+|abstract\s+|async\s+)*(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_RE = /\bexport\s*\{([^}]*)\}/g;
const NAMED_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"\n]*['"]/g;
const IMPORT_SPEC_RE = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/;

/**
 * A file's module consts, the names it exports (by declaration or by a plain export list),
 * and its named imports as local name -> exported name. Import paths are not followed: a
 * named import is matched to the files that export that name.
 */
function collectFileNames(code, depths) {
  const consts = new Map();
  collectModuleConsts(code, consts, depths);
  const exported = new Set();
  let m;
  EXPORTED_DECL_RE.lastIndex = 0;
  while ((m = EXPORTED_DECL_RE.exec(code))) {
    if (isTopLevel(m.index, depths)) exported.add(m[1]);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(code))) {
    const tail = code.slice(EXPORT_LIST_RE.lastIndex, EXPORT_LIST_RE.lastIndex + 16);
    if (!isTopLevel(m.index, depths) || /^\s*from\b/.test(tail)) continue;
    for (const part of m[1].split(',')) {
      const spec = IMPORT_SPEC_RE.exec(part);
      if (spec && !spec[2]) exported.add(spec[1]);
    }
  }
  const imports = new Map();
  NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = NAMED_IMPORT_RE.exec(code))) {
    for (const part of m[1].split(',')) {
      const spec = IMPORT_SPEC_RE.exec(part);
      if (spec) imports.set(spec[2] || spec[1], spec[1]);
    }
  }
  return { consts, exported, imports };
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function lastSegment(typeText) {
  return typeText.split('.').pop();
}

const PARAM_RE = /^\s*((?:(?:public|private|protected|readonly|override)\s+)*)([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([A-Za-z_$][\w$.]*))?/;

/** Parameters with their type name, and whether a modifier makes one a class field. */
function parseParams(paramsText) {
  return splitArgs(paramsText || '').map((part) => {
    const m = PARAM_RE.exec(part.text);
    if (!m) return { name: '', type: null, property: false };
    return { name: m[2], type: m[3] ? lastSegment(m[3]) : null, property: m[1].trim() !== '' };
  });
}

/** Text with every string and every bracketed group replaced by `#`, so only the text at the
 *  group's own nesting level is left — a class body's field declarations, not its params. */
function flattenGroups(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let end = -1;
    if (ch === "'" || ch === '"') end = skipString(text, i, ch);
    else if (ch === '`') end = skipTemplate(text, i);
    else if (ch === '(' || ch === '{' || ch === '[') {
      const close = matchBalanced(text, i);
      end = close === -1 ? text.length : close + 1;
    }
    if (end !== -1) {
      out += '#'.repeat(end - i);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const FIELD_DECL_RE =
  /(?:^|[;\n])[ \t]*(?:(?:public|private|protected|readonly|static|declare|override)\s+)*([A-Za-z_$][\w$]*)[ \t]*[!?]?[ \t]*(?::[ \t]*([A-Za-z_$][\w$.]*))?[^=;\n#]*(?:=[ \t]*new\s+([A-Za-z_$][\w$.]*))?/g;
const CTOR_NEW_FIELD_RE = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)/g;

/** Field types of one class: a constructor parameter property or a typed field declaration,
 *  overridden by the class a `new` initializer or a constructor `this.f = new X(` creates. */
function collectFieldTypes(code, span, members) {
  const declared = new Map();
  const created = new Map();
  const flat = flattenGroups(code.slice(span.bodyStart, span.bodyEnd));
  FIELD_DECL_RE.lastIndex = 0;
  let m;
  while ((m = FIELD_DECL_RE.exec(flat))) {
    if (m[3]) created.set(m[1], lastSegment(m[3]));
    else if (m[2]) declared.set(m[1], lastSegment(m[2]));
  }
  for (const member of members) {
    if (member.name !== 'constructor') continue;
    for (const param of parseParams(member.paramsText)) {
      if (param.property && param.type) declared.set(param.name, param.type);
    }
    const ctorBody = code.slice(member.bodyStart, member.bodyEnd);
    CTOR_NEW_FIELD_RE.lastIndex = 0;
    while ((m = CTOR_NEW_FIELD_RE.exec(ctorBody))) created.set(m[1], lastSegment(m[2]));
  }
  const fields = new Map(declared);
  for (const [name, type] of created) fields.set(name, type);
  return fields;
}

function makeBody(info, cls, name, paramsText, bodyStart, bodyEnd, exported) {
  ROUTE_CALL_RE.lastIndex = 0;
  return {
    info,
    cls,
    name,
    params: parseParams(paramsText),
    bodyStart,
    bodyEnd,
    exported,
    isStub: ROUTE_CALL_RE.test(stubMaskedCode(info).slice(bodyStart, bodyEnd)),
    reaches: false,
    sites: null,
    bindings: null,
  };
}

/**
 * The pseudo-body of a test: its sites resolve like a helper's, with no class. Its parameters are
 * the fixtures it destructures that have a readable type.
 */
function testBody(info, block, fixtures) {
  const spec = fixtures ? fixtures.forSpec(info.rel) : null;
  const params = [];
  if (spec && block.fnStart !== null) {
    for (const { key, local } of destructuredNames(maskedCode(info).slice(block.fnStart, block.fnEnd))) {
      const type = spec.typeOf(key);
      if (type) params.push({ name: local, type, property: false });
    }
  }
  return {
    info,
    cls: null,
    name: block.title,
    params,
    bodyStart: block.bodyStart,
    bodyEnd: block.bodyEnd,
    exported: false,
    isStub: false,
    reaches: false,
    sites: null,
    bindings: null,
  };
}

/**
 * Repo-wide tables for request evidence: const definitions, classes (methods and field
 * types), top-level functions and class methods by name, and every body, with `reaches`
 * settled by a fixed point.
 */
function buildRequestContext(fileInfo) {
  const ctx = { constDefs: new Map(), classDefs: new Map(), fnDefs: new Map(), methodsByName: new Map(), bodies: [] };
  for (const info of fileInfo.values()) {
    try {
      indexFile(ctx, info);
    } catch {
      continueExtraction();
    }
  }
  markReach(ctx);
  return ctx;
}

function indexFile(ctx, info) {
  const { code, names } = info;
  for (const [name, entry] of names.consts) pushTo(ctx.constDefs, name, { info, entry, exported: names.exported.has(name) });
  for (const span of info.classSpans) {
    const members = splitClassMembers(code, span.bodyStart, span.bodyEnd);
    const cls = {
      name: span.className,
      info,
      exported: names.exported.has(span.className),
      methods: new Map(),
      fields: collectFieldTypes(code, span, members),
    };
    for (const member of members) {
      if (member.name === 'constructor' || cls.methods.has(member.name)) continue;
      const body = makeBody(info, cls, member.name, member.paramsText, member.bodyStart, member.bodyEnd, false);
      cls.methods.set(member.name, body);
      pushTo(ctx.methodsByName, member.name, body);
      ctx.bodies.push(body);
    }
    pushTo(ctx.classDefs, span.className, cls);
  }
  for (const span of info.fnSpans) {
    const body = makeBody(info, null, span.name, span.paramsText, span.bodyStart, span.bodyEnd, names.exported.has(span.name));
    pushTo(ctx.fnDefs, span.name, body);
    ctx.bodies.push(body);
  }
}

/**
 * The definitions a name can mean in one file: its own, else for a named import the files
 * that export the imported name, else every definition in the repository. Each entry
 * carries `info` and `exported`.
 */
function scopedCandidates(info, name, defs) {
  const all = defs.get(name) || [];
  const own = all.filter((def) => def.info === info);
  if (own.length > 0) return own;
  const imported = info.names.imports.get(name);
  if (imported === undefined) return all;
  const sameName = defs.get(imported) || [];
  const exporters = sameName.filter((def) => def.exported);
  return exporters.length > 0 ? exporters : sameName;
}

/** Const lookup in the scope of one file: one value resolves, two or more are ambiguous. */
function fileLookup(ctx, info) {
  if (!info.lookup) {
    info.lookup = (name, prop) => {
      const values = new Set();
      for (const def of scopedCandidates(info, name, ctx.constDefs)) {
        const value = constEntryValue(def.entry, prop);
        if (value !== undefined) values.add(value);
      }
      if (values.size === 1) return { status: 'value', value: values.values().next().value };
      return values.size === 0 ? NO_VALUE : AMBIGUOUS_VALUE;
    };
  }
  return info.lookup;
}

function lineAt(info, index) {
  if (!info.lineOf) info.lineOf = makeLineFinder(info.code);
  return info.lineOf(index);
}

/** The code with every literal's text blanked, so a call written inside one is not a site. */
function maskedCode(info) {
  if (info.masked === null) info.masked = maskLiteralText(info.code, { interpolations: false });
  return info.masked;
}

/** The same with interpolation code kept: a stub written inside `${…}` still runs. */
function stubMaskedCode(info) {
  if (info.stubMasked === null) info.stubMasked = maskLiteralText(info.code);
  return info.stubMasked;
}

function fileBindings(info) {
  if (!info.factories) info.factories = collectFactoryMap(info.fnSpans);
  if (!info.bindings) info.bindings = collectIdentBindings(info.code, info.factories);
  return info.bindings;
}

function bodyBindings(body) {
  if (!body.bindings) {
    fileBindings(body.info);
    body.bindings = collectIdentBindings(body.info.code.slice(body.bodyStart, body.bodyEnd), body.info.factories);
  }
  return body.bindings;
}

const CALL_SITE_RE = /(?<![.\w$])(this|[A-Za-z_$][\w$]*)((?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
const DECLARATION_HEAD_RE = /\b(?:function|new)\s*$/;

/**
 * Every call site of one body, in source order, arguments and arrow functions included. A
 * `<receiver>.<verb>(<url>)` whose first argument resolves to a path is a request; any other
 * `ident.m(`, `this.m(`, `this.field.m(` or bare `fn(` naming a repo function is a call.
 */
function readSites(ctx, body) {
  if (body.sites) return body.sites;
  const { info } = body;
  const masked = maskedCode(info);
  const sites = [];
  CALL_SITE_RE.lastIndex = body.bodyStart;
  let m;
  while ((m = CALL_SITE_RE.exec(masked)) && m.index < body.bodyEnd) {
    const head = m[1];
    const members = m[2] ? m[2].split('.').map((part) => part.replace(/[\s?]/g, '')).filter(Boolean) : [];
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(info.code, parenOpen);
    const argsText = parenClose === -1 ? '' : info.code.slice(parenOpen + 1, parenClose);
    const site = {
      index: m.index,
      call: [head, ...members].join('.'),
      head,
      members,
      argsText,
      request: null,
      targets: null,
      fixtureReading: false,
    };
    const method = members[members.length - 1];
    if (members.length > 0 && KNOWN_VERBS.has(method)) {
      const firstArg = splitArgs(argsText)[0]?.text ?? '';
      const { template, resolved } = resolveUrlExpr(firstArg, fileLookup(ctx, info));
      if (looksLikeUrl(template)) {
        site.request = { verb: VERB_UPPER[method], template, resolved };
        sites.push(site);
        continue;
      }
    }
    if (members.length === 0) {
      if (head === 'this' || !ctx.fnDefs.has(head) || DECLARATION_HEAD_RE.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue;
    } else if (members.length > (head === 'this' ? 2 : 1)) {
      continue;
    }
    sites.push(site);
  }
  body.sites = sites;
  return sites;
}

function receiverType(body, ident) {
  const param = body.params.find((p) => p.name === ident);
  if (param) return param.type;
  return bodyBindings(body).get(ident) || fileBindings(body.info).get(ident) || null;
}

function classMethods(ctx, info, typeName, method) {
  const out = [];
  for (const cls of scopedCandidates(info, typeName, ctx.classDefs)) {
    const target = cls.methods.get(method);
    if (target) out.push(target);
  }
  return out;
}

/** The bodies a call site can enter, before `reaches` narrows them. */
function siteTargets(ctx, body, site) {
  if (site.targets) return site.targets;
  const { head, members } = site;
  const method = members[members.length - 1];
  const byName = () => {
    // An untyped receiver of a verb name can be the request fixture itself, holding a URL
    // this reader cannot build: one client of that name is then still two readings.
    if (KNOWN_VERBS.has(method)) site.fixtureReading = true;
    return ctx.methodsByName.get(method) || [];
  };
  let targets;
  if (members.length === 0) {
    targets = scopedCandidates(body.info, head, ctx.fnDefs);
  } else if (head === 'this') {
    if (!body.cls) targets = [];
    else if (members.length === 1) {
      const own = body.cls.methods.get(method);
      targets = own ? [own] : byName();
    } else {
      const type = body.cls.fields.get(members[0]);
      targets = type ? classMethods(ctx, body.cls.info, type, method) : byName();
    }
  } else {
    const type = receiverType(body, head);
    targets = type ? classMethods(ctx, body.info, type, method) : byName();
  }
  site.targets = targets;
  return targets;
}

function reachingTargets(ctx, body, site) {
  return siteTargets(ctx, body, site).filter((target) => target.reaches);
}

/** A body reaches a request when it makes one or calls a body that does; a stub body never does. */
function markReach(ctx) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const body of ctx.bodies) {
      if (body.reaches || body.isStub) continue;
      let reaches = false;
      try {
        reaches = readSites(ctx, body).some((site) => site.request || reachingTargets(ctx, body, site).length > 0);
      } catch {
        // A body this reader cannot read reaches nothing, so it never stops the other files.
        body.sites = [];
        continueExtraction();
      }
      if (reaches) {
        body.reaches = true;
        changed = true;
      }
    }
  }
}

function unresolvedRequest(reason, site, chain) {
  return { verb: 'ANY', template: bestPartial(`${site.call}(...)`), resolved: false, via: 'helper', reason, chain };
}

/**
 * The requests one call site leads to, in depth-first source order. `depth` is the number of
 * bodies entered from the test body; a request written in the test body itself keeps the
 * plain shape. A body already on the chain is not entered again, and neither is a target
 * past `MAX_BODIES`.
 */
function followSite(ctx, body, site, depth, chain, onChain, out) {
  const path = [...chain, { file: body.info.rel, line: lineAt(body.info, site.index), call: site.call }];
  if (site.request) {
    if (depth === 0) out.push({ ...site.request });
    else out.push({ ...site.request, via: 'helper', ...(body.cls ? { receiver: body.cls.name } : {}), chain: path });
    return;
  }
  const targets = reachingTargets(ctx, body, site);
  if (targets.length === 0) return;
  if (targets.length > 1 || site.fixtureReading) {
    out.push(unresolvedRequest('ambiguous-receiver', site, path));
    return;
  }
  const target = targets[0];
  if (onChain.has(target)) return;
  if (depth >= MAX_BODIES) {
    out.push(unresolvedRequest('depth-bound', site, path));
    return;
  }
  onChain.add(target);
  for (const inner of readSites(ctx, target)) followSite(ctx, target, inner, depth + 1, path, onChain, out);
  onChain.delete(target);
}

/**
 * `pw_stub` facts: `page.route(...)` evidence from a Playwright UI E2E harness whose
 * `.pw.ts` specs can live anywhere in the repo — there is no `tests/` convention for
 * this kind of harness the way there is for the API client harness above.
 *
 * Three shapes count as evidence: a direct `page.route(<url-or-glob-or-regex>, ...)` call
 * in a spec; a call into a project helper method that *forwards* one of its own
 * parameters into its own `.route(...)` call (`stubEndpoint(endpoint, ...)` calling
 * `this.page.route(endpoint.route, ...)`); and a call with no traceable parameter at all
 * (`stubAllDefinedEndpoints()` iterating its own endpoint list) — recorded as `kind:
 * "opaque"`, counted, never joined to a route. The helper's own shape is discovered once,
 * repo-wide, from whichever class or top-level function's body contains a `.route(` call;
 * nothing is hard-coded to one class or method name.
 *
 * A forwarding helper's endpoint argument resolves through a small registry of
 * `Endpoint`-shaped object literals (`{ route: "...", method: "..." }`) nested two levels
 * under one default-exported object literal / `const NAME = {...}` — the shape a stub-mock file
 * such as `playwright/mocks/endpoints.ts` uses — indexed by its last two dotted segments
 * so a call site (`endpoints.catalog.listProducts`) resolves without following the import
 * graph. An
 * inline object literal at the call site (`{ ...endpoints.x.y, status: 500 }`) is read the
 * same way, spread base first, direct `route`/`method` keys overriding it.
 */

const PW_SPEC_EXTENSION = '.pw.ts';
const ENDPOINT_TOP_RE = /\bexport\s+default\s*\{|\bconst\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*\{/g;
const ROUTE_CALL_RE = /\.\s*route\s*\(/g;

/** A JS regex literal's source, from its opening `/` to the first unescaped `/` outside
 *  a character class — a minimal tokenizer, not a full parser. Null on anything odd. */
function readRegexSource(text) {
  let i = 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inClass) return text.slice(1, i);
    if (ch === '\n') return null;
    i += 1;
  }
  return null;
}

/**
 * Best-effort glob-shaped reading of a regex source: anchors dropped, escaped slashes
 * unescaped, character classes and their quantifiers collapsed to `*`, optional groups
 * dropped. Lossy on purpose — it only has to survive `matchRoute`'s exact/prefix/suffix
 * comparison for the common "one dynamic id segment" shape; anything it mangles simply
 * lands in `unmatched`; nothing here is ever reported as `resolved`.
 */
function regexToGlobGuess(source) {
  let text = source.replace(/^\^/, '').replace(/\$$/, '');
  text = text.replace(/\\\//g, '/');
  text = text.replace(/\[[^\]]*\](?:\{\d+(?:,\d*)?\}|[+*?])?/g, '*');
  text = text.replace(/\.\*/g, '*').replace(/\.\+/g, '*');
  text = text.replace(/\([^()]*\)\??/g, '');
  return text.replace(/\*{2,}/g, '*');
}

function parseRouteValue(valueText) {
  const trimmed = valueText.trim();
  const lit = fullLiteral(trimmed);
  if (lit !== null) return { pattern: lit, isRegex: false };
  if (trimmed[0] === '/') {
    const source = readRegexSource(trimmed);
    if (source !== null) return { pattern: regexToGlobGuess(source), isRegex: true };
  }
  return null;
}

/**
 * Top-level comma-separated entries of an object literal's inner text: a spread
 * (`...expr`), a `key: value` pair (bare or quoted key), or an unrecognised part. Reuses
 * `splitArgs`'s bracket/string-aware comma split — an object literal's body is exactly
 * that shape once the surrounding braces are stripped.
 */
function scanObjectEntries(text) {
  return splitArgs(text).map((part) => {
    const raw = part.text;
    const spreadMatch = /^\.\.\.\s*([\s\S]+)$/.exec(raw);
    if (spreadMatch) return { spread: true, spreadRef: spreadMatch[1].trim() };
    const keyMatch = /^(?:([A-Za-z_$][\w$]*)|(['"])((?:\\.|(?!\2)[\s\S])*?)\2)\s*:\s*([\s\S]*)$/.exec(raw);
    if (keyMatch) {
      const key = keyMatch[1] !== undefined ? keyMatch[1] : keyMatch[3];
      return { spread: false, key, valueText: keyMatch[4] };
    }
    return { spread: false, key: null, valueText: raw };
  });
}

/** The inner text of a `{ ... }` a value expression leads with (after an `as Cast`, a
 *  trailing suffix is simply ignored since only the balanced brace span is read), or
 *  null when the value is not itself an object literal. */
function findLeadingBraceSpan(text) {
  const trimmed = text.trimStart();
  if (trimmed[0] !== '{') return null;
  const close = matchBalanced(trimmed, 0);
  if (close === -1) return null;
  return trimmed.slice(1, close);
}

/** `route`/`method` read off an entry's own direct properties, plus its spread source
 *  (the first `...expr`) so a caller can fall back to a spread base's own route/method. */
function readEntryRouteMethod(entries) {
  let route = null;
  let method = null;
  let spreadRef = null;
  for (const entry of entries) {
    if (entry.spread) {
      if (!spreadRef) spreadRef = entry.spreadRef;
      continue;
    }
    if (entry.key === 'route') route = parseRouteValue(entry.valueText);
    if (entry.key === 'method') method = fullLiteral(entry.valueText.trim());
  }
  return { route, method, spreadRef };
}

/**
 * `section.key -> {pattern, isRegex, method}` for every nested `Endpoint`-shaped object
 * two levels under a top-level default-exported object literal / `const NAME = {...}`.
 */
function collectEndpointRegistry(code, depths, registry) {
  ENDPOINT_TOP_RE.lastIndex = 0;
  let m;
  while ((m = ENDPOINT_TOP_RE.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBalanced(code, braceOpen);
    if (braceClose === -1) continue;
    const body = code.slice(braceOpen + 1, braceClose);
    for (const section of scanObjectEntries(body)) {
      if (section.spread || !section.key) continue;
      const sectionInner = findLeadingBraceSpan(section.valueText);
      if (sectionInner === null) continue;
      for (const entry of scanObjectEntries(sectionInner)) {
        if (entry.spread || !entry.key) continue;
        const entryInner = findLeadingBraceSpan(entry.valueText);
        if (entryInner === null) continue;
        const { route, method } = readEntryRouteMethod(scanObjectEntries(entryInner));
        if (!route) continue;
        registry.set(`${section.key}.${entry.key}`, {
          pattern: route.pattern,
          isRegex: route.isRegex,
          method: method || 'GET',
        });
      }
    }
  }
}

function memberChain(text) {
  const trimmed = text.trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(trimmed)) return null;
  return trimmed.split('.');
}

/** Resolve `a.b.c` (or any longer chain) by its last two segments — the bare-name
 *  heuristic the rest of this file already uses instead of following imports. */
function resolveEndpointRef(text, registry) {
  const chain = memberChain(text);
  if (!chain) return null;
  return registry.get(chain.slice(-2).join('.')) || null;
}

/** An endpoint-ref member chain, or an inline `{ ...ref, route: ..., method: ... }`
 *  object literal — the two shapes a call site passes a stub helper in this harness. */
function resolveEndpointValue(argText, registry) {
  const trimmed = argText.trim();
  if (trimmed[0] === '{') {
    const inner = findLeadingBraceSpan(trimmed);
    if (inner === null) return null;
    const { route, method, spreadRef } = readEntryRouteMethod(scanObjectEntries(inner));
    const base = spreadRef ? resolveEndpointRef(spreadRef, registry) : null;
    const pattern = route ? route.pattern : base ? base.pattern : null;
    const isRegex = route ? route.isRegex : !!base && base.isRegex;
    const method2 = method || (base ? base.method : null);
    if (pattern === null) return null;
    return { pattern, isRegex, method: method2 || 'GET' };
  }
  return resolveEndpointRef(trimmed, registry);
}

/** The first argument text of the first `.route(...)` call in the body from `start` to `end`,
 *  or null when the body never calls `.route(` at all — such a method is not a stub helper.
 *  The call is found in `masked`, so a `.route(` written inside a literal is not one. */
function findRouteCallArg(code, masked, start, end) {
  ROUTE_CALL_RE.lastIndex = 0;
  const m = ROUTE_CALL_RE.exec(masked.slice(start, end));
  if (!m) return null;
  const parenOpen = start + m.index + m[0].length - 1;
  const parenClose = matchBalanced(code, parenOpen);
  if (parenClose === -1 || parenClose > end) return null;
  const argsText = code.slice(parenOpen + 1, parenClose);
  return splitArgs(argsText)[0]?.text ?? '';
}

/**
 * A method/function whose body calls `.route(<arg>)` is a stub helper. It `forward`s a
 * URL/endpoint if `<arg>` is one of its own declared parameters, bare (`stubUrl(url)`) or
 * a property access on one (`stubEndpoint(endpoint)` calling `.route(endpoint.route)`);
 * otherwise — a loop variable, an outer const, a hard-coded literal — it is `opaque`: it
 * stubs routes, but no call site can say which one.
 */
function classifyStubMethod(paramsText, firstArg) {
  const paramNames = parseParamInfos(paramsText).map((p) => p.name);
  const trimmed = firstArg.trim();
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (bare && paramNames.includes(bare[1])) return { kind: 'forward' };
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (member && paramNames.includes(member[1])) return { kind: 'forward' };
  return { kind: 'opaque' };
}

function addStubCandidate(index, name, entry) {
  const list = index.get(name) || [];
  list.push(entry);
  index.set(name, list);
}

/** Every class method and top-level function repo-wide whose body calls `.route(`,
 *  keyed by bare name (several files may each define a same-named helper). */
function collectStubMethodIndex(fileInfo, fault) {
  const index = new Map();
  for (const info of fileInfo.values()) {
    // A file whose helpers cannot be read adds none, and the helpers of the other files stay.
    try {
      fault('stub-index', { file: info.rel });
      indexStubMethods(info, index);
    } catch {
      continueExtraction();
    }
  }
  return index;
}

function indexStubMethods(info, index) {
  const found = [];
  const masked = stubMaskedCode(info);
  for (const classSpan of info.classSpans) {
    for (const member of splitClassMembers(info.code, classSpan.bodyStart, classSpan.bodyEnd)) {
      if (member.name === 'constructor') continue;
      const firstArg = findRouteCallArg(info.code, masked, member.bodyStart, member.bodyEnd);
      if (firstArg !== null) found.push([member.name, classifyStubMethod(member.paramsText || '', firstArg)]);
    }
  }
  for (const fnSpan of info.fnSpans) {
    const firstArg = findRouteCallArg(info.code, masked, fnSpan.bodyStart, fnSpan.bodyEnd);
    if (firstArg !== null) found.push([fnSpan.name, classifyStubMethod(fnSpan.paramsText, firstArg)]);
  }
  for (const [name, entry] of found) addStubCandidate(index, name, entry);
}

/** A name several unrelated helpers share resolves only when every candidate agrees on
 *  `forward` — otherwise it is treated as `opaque` rather than risk joining the wrong
 *  route to a call site that could mean either helper. */
function resolveStubMethod(name, stubMethodIndex) {
  const candidates = stubMethodIndex.get(name);
  if (!candidates || candidates.length === 0) return null;
  return candidates.every((candidate) => candidate.kind === 'forward') ? candidates[0] : { kind: 'opaque' };
}

/** The smallest `test(...)` span enclosing `position`, or null when nothing does — a
 *  `stubAllDefinedEndpoints()` call in `test.beforeEach(...)` names no test, the same
 *  convention `cypress_intercept` uses for a support-command intercept. */
function findEnclosingTestBlock(position, testBlocks) {
  let nearest = null;
  let bestSpan = Infinity;
  for (const block of testBlocks) {
    if (block.bodyStart === null) continue;
    if (position > block.bodyStart && position < block.bodyEnd) {
      const span = block.bodyEnd - block.bodyStart;
      if (span < bestSpan) {
        bestSpan = span;
        nearest = block;
      }
    }
  }
  return nearest;
}

function processPwStubFile(repoRoot, absPath, code, lookup, registry, stubMethodIndex, facts, backendReader) {
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);
  const describeSkipSpans = findDescribeSkipSpans(code);
  const testBlocks = findTestBlocks(code);

  const emit = (index, kind, extra, handler) => {
    const test = findEnclosingTestBlock(index, testBlocks);
    const skipped = isInsideSkipDescribe(index, describeSkipSpans) || (test ? test.ownSkip : false);
    facts.push(
      fact('pw_stub', {
        file: relPath,
        line: lineOf(index),
        spec: relPath,
        test: test ? test.title : '',
        kind,
        skipped,
        ...extra,
        handler,
      }),
    );
  };

  const directRe = /\bpage\s*\.\s*route\s*\(/g;
  directRe.lastIndex = 0;
  let m;
  while ((m = directRe.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const argsText = code.slice(parenOpen + 1, parenClose);
    const firstArg = splitArgs(argsText)[0]?.text ?? '';
    const { template, resolved } = resolveUrlExpr(firstArg, lookup);
    if (!looksLikeUrl(template)) continue;
    emit(m.index, 'route', { verb: 'ANY', pattern: template, resolved }, backendReader.routeHandler(relPath, parenOpen, code));
  }

  const stubNames = [...stubMethodIndex.keys()];
  if (stubNames.length === 0) return;
  const callRe = new RegExp(`\\b(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(${stubNames.map(escapeRegExp).join('|')})\\s*\\(`, 'g');
  callRe.lastIndex = 0;
  while ((m = callRe.exec(code))) {
    const name = m[1];
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const argsText = code.slice(parenOpen + 1, parenClose);
    const firstArgPart = splitArgs(argsText)[0];
    const resolution = resolveStubMethod(name, stubMethodIndex);
    if (!resolution) continue;
    const handler = backendReader.helperHandler(name);
    if (resolution.kind !== 'forward' || !firstArgPart) {
      emit(m.index, 'opaque', { helper: name }, handler);
      continue;
    }
    const endpoint = resolveEndpointValue(firstArgPart.text, registry);
    if (endpoint) {
      emit(m.index, 'route', {
        verb: (endpoint.method || 'GET').toUpperCase(),
        pattern: endpoint.pattern,
        resolved: !endpoint.isRegex,
      }, handler);
      continue;
    }
    const { template, resolved } = resolveUrlExpr(firstArgPart.text, lookup);
    emit(m.index, 'route', {
      verb: 'ANY',
      pattern: looksLikeUrl(template) ? template : bestPartial(firstArgPart.text),
      resolved: looksLikeUrl(template) && resolved,
    }, handler);
  }
}

/** Spec files: `test(`/`test.describe.skip(` spans, case-id annotations and calls, request/assert scan. */

const DESCRIBE_SKIP_RE = /\btest\.describe\.skip\s*\(/g;
// `\b` alone would match the `test` in `/re/.test(s)` and `obj.test(v)`, because a dot is
// not a word character. Only a `test` that is not a member of something is Playwright's.
const TEST_RE = /(?<![.?\w$])test\.(skip|only|fixme)\s*\(|(?<![.?\w$])test\s*\(/g;
const ANNOTATION_PUSH_RE = /\btest\s*\.\s*info\s*\(\s*\)\s*\.\s*annotations\s*\.\s*push\s*\(/g;

/**
 * The configured case-id call sites, one pattern over them all. Each entry is a callee
 * as written at the call site (`tms.id` matches `tms.id(...)`). No entries — no call
 * scan: out of the box only the framework-neutral annotation shape resolves.
 */
function buildCaseIdCallRe(calls) {
  const names = (Array.isArray(calls) ? calls : []).filter((name) => typeof name === 'string' && name.trim() !== '');
  if (names.length === 0) return null;
  const escaped = names.map((name) => name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\s*\\(`, 'g');
}

function findDescribeSkipSpans(code) {
  const spans = [];
  DESCRIBE_SKIP_RE.lastIndex = 0;
  let m;
  while ((m = DESCRIBE_SKIP_RE.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    spans.push({ start: parenOpen, end: parenClose });
  }
  return spans;
}

function isInsideSkipDescribe(position, spans) {
  return spans.some((span) => position > span.start && position < span.end);
}

function titleOf(text) {
  const lit = fullLiteral(text);
  if (lit !== null) return lit;
  if (text[0] === '`') {
    const end = skipTemplate(text, 0);
    if (end === text.length) return text.slice(1, -1);
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed.slice(0, 160) : null;
}

/**
 * A declaration ends in the function that holds the test body, whether that function is
 * written out at the call site or named there and defined elsewhere. The
 * `test.skip(condition, reason)` form is a runtime guard written inside a body: it holds no
 * body of its own and ends in a string, and its shorter `test.skip()` / `test.skip(condition)`
 * forms hold nothing at all. Shape alone separates the two, so nothing here evaluates an
 * expression — a body passed by reference is a declaration like any other.
 */
function isRuntimeGuard(kind, parts) {
  if (kind !== 'skip' && kind !== 'only' && kind !== 'fixme') return false;
  if (parts.length < 2) return true;
  return fullLiteral(parts[parts.length - 1].text) !== null;
}


/**
 * Every test declaration of a spec. A call whose closing `)` the reader cannot find still
 * declares a test: it keeps its title and `unread: 'unbalanced-call'` and no body, so the test
 * is counted as unread instead of vanishing.
 */
function findTestBlocks(code) {
  const blocks = [];
  TEST_RE.lastIndex = 0;
  let m;
  while ((m = TEST_RE.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    const argsText = code.slice(parenOpen + 1, parenClose === -1 ? code.length : parenClose);
    const parts = splitArgs(argsText);
    if (parts.length === 0 || isRuntimeGuard(m[1], parts)) continue;
    const title = titleOf(parts[0].text);
    if (title === null) continue;
    const ownSkip = m[1] === 'skip' || m[1] === 'fixme';
    if (parenClose === -1) {
      blocks.push({ title, index: m.index, ownSkip, bodyStart: null, bodyEnd: null, fnStart: null, fnEnd: null, inline: false, unread: 'unbalanced-call' });
      continue;
    }

    let bodyStart = null;
    let bodyEnd = null;
    let fnStart = null;
    let fnEnd = null;
    let inline = false;
    // A body passed by reference leaves no braces inside the call, so the search below
    // finds none before the closing paren and the block keeps an empty body.
    if (parts.length > 1) {
      const fnPart = parts[parts.length - 1];
      const partStart = parenOpen + 1 + fnPart.start;
      const leading = argsText.slice(fnPart.start).length - argsText.slice(fnPart.start).trimStart().length;
      fnStart = partStart + leading;
      fnEnd = fnStart + fnPart.text.length;
      inline = isInlineCallback(fnPart.text);
      // Search for the body brace after the arrow, not the first `{` in the callback —
      // a destructured parameter like `({ request }) => { ... }` has one of its own.
      const arrowIdx = code.indexOf('=>', partStart);
      const braceSearchFrom = arrowIdx !== -1 && arrowIdx < parenClose ? arrowIdx : partStart;
      const braceIdx = code.indexOf('{', braceSearchFrom);
      if (braceIdx !== -1 && braceIdx < parenClose) {
        const braceClose = matchBalanced(code, braceIdx);
        if (braceClose !== -1) {
          bodyStart = braceIdx + 1;
          bodyEnd = braceClose;
        }
      }
    }
    blocks.push({ title, index: m.index, ownSkip, bodyStart, bodyEnd, fnStart, fnEnd, inline });
  }
  return blocks;
}

/**
 * Case-id call argument resolution. Two shapes resolve; everything else is
 * absent rather than guessed — a bare `/-?\d+/` digit scan would fabricate ids (a
 * subscript expression like `rows[0].caseId` would yield `[0]`, the index pulled out of
 * the brackets), so no such scan runs and that expression yields nothing at all.
 *
 * - A literal argument — a number, a quoted string, or an array of only those — resolves
 *   directly (`tms.id(9001)`, `tms.id(['TC-3', 'TC-4'])`).
 * - A bare `ident.prop` member expression resolves through `resolveTableIds` when `ident`
 *   is the loop binding of a same-file `for (const ident of ARRAY)` wrapping the test
 *   declaration and `ARRAY` is a same-file array of object literals — the data-driven-suite
 *   shape. Anything else of this shape (a subscript, a call, a template, a cross-file or
 *   unresolvable table) is refused, not approximated.
 */
function literalCaseId(text) {
  if (/^-?\d+$/.test(text)) return Number(text);
  const m = /^(['"])((?:\\.|(?!\1).)*)\1$/.exec(text);
  return m && m[2] !== '' ? m[2] : null;
}

function parseLiteralCaseIds(argsText) {
  const trimmed = String(argsText || '').trim();
  const single = literalCaseId(trimmed);
  if (single !== null) return [single];
  if (trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']') {
    const elements = splitArgs(trimmed.slice(1, -1));
    if (elements.length === 0) return null;
    const ids = [];
    for (const element of elements) {
      const id = literalCaseId(element.text);
      if (id === null) return null;
      ids.push(id);
    }
    return ids;
  }
  return null;
}

function memberExprOf(argsText) {
  const trimmed = String(argsText || '').trim();
  const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  return m ? { ident: m[1], prop: m[2] } : null;
}

const ARRAY_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[/g;

/** Same-file `const IDENT = [ ... ]` array literals, keyed by identifier, first wins. */
function collectArrayConsts(code) {
  const arrays = new Map();
  ARRAY_CONST_RE.lastIndex = 0;
  let m;
  while ((m = ARRAY_CONST_RE.exec(code))) {
    if (arrays.has(m[1])) continue;
    const bracketOpen = m.index + m[0].length - 1;
    const bracketClose = matchBalanced(code, bracketOpen);
    if (bracketClose === -1) continue;
    const body = code.slice(bracketOpen + 1, bracketClose);
    arrays.set(
      m[1],
      splitArgs(body).map((part) => part.text),
    );
  }
  return arrays;
}

const FOR_OF_RE = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;

/** Every `for (const IDENT of SOURCE)` clause in the file, keyed by where its body starts. */
function collectForOfBindings(code) {
  const bindings = [];
  FOR_OF_RE.lastIndex = 0;
  let m;
  while ((m = FOR_OF_RE.exec(code))) {
    bindings.push({ end: FOR_OF_RE.lastIndex, ident: m[1], source: m[2] });
  }
  return bindings;
}

/**
 * The innermost `for (const ident of ...)` binding whose body wraps `testIndex` — either
 * the block form (`for (...) { ... }`) or the single-statement form
 * (`for (const row of rows) test(...)`), where the loop clause is followed
 * only by whitespace before the test call it wraps.
 */
function findWrappingForOf(code, testIndex, bindings) {
  let best = null;
  for (const binding of bindings) {
    if (binding.end > testIndex) continue;
    let i = binding.end;
    while (i < testIndex && /\s/.test(code[i])) i += 1;
    let wraps = false;
    if (i === testIndex) {
      wraps = true;
    } else if (code[i] === '{') {
      const braceClose = matchBalanced(code, i);
      if (braceClose !== -1 && testIndex > i && testIndex < braceClose) wraps = true;
    }
    if (wraps && (!best || binding.end > best.end)) best = binding;
  }
  return best;
}

/** `{ key: value, ... }` -> `Map(key -> value text)`, or null when not an object literal. */
function objectLiteralProps(elementText) {
  const trimmed = String(elementText || '').trim();
  if (trimmed[0] !== '{' || trimmed[trimmed.length - 1] !== '}') return null;
  const props = new Map();
  for (const part of splitArgs(trimmed.slice(1, -1))) {
    const raw = part.text;
    let colonIndex = -1;
    let depth = 0;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === "'" || ch === '"') {
        i = skipString(raw, i, ch);
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(raw, i);
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
      if (ch === ':' && depth === 0) {
        colonIndex = i;
        break;
      }
      i += 1;
    }
    if (colonIndex === -1) continue;
    let key = raw.slice(0, colonIndex).trim();
    const quotedKey = fullLiteral(key);
    if (quotedKey !== null) key = quotedKey;
    props.set(key, raw.slice(colonIndex + 1).trim());
  }
  return props;
}

/**
 * Every row of a same-file table, in declaration order, resolved to `prop`'s numeric
 * literal value — or `null` the moment any one row cannot be read as a plain integer, since
 * a partial resolution would misalign with the per-instance titles this is meant to join.
 */
function resolveTableIds(code, testIndex, ident, prop, arrayConsts, forOfBindings) {
  const candidates = forOfBindings.filter((binding) => binding.ident === ident);
  const binding = findWrappingForOf(code, testIndex, candidates);
  if (!binding) return null;
  const elements = arrayConsts.get(binding.source);
  if (!elements || elements.length === 0) return null;
  const ids = [];
  for (const elementText of elements) {
    const props = objectLiteralProps(elementText);
    const valueText = props ? props.get(prop) : undefined;
    if (!valueText || !/^-?\d+$/.test(valueText)) return null;
    ids.push(Number(valueText));
  }
  return ids;
}

/**
 * Resolves every case-id declaration in one test body into the `{ids, source}` entries
 * `case_id` facts are built from: one entry per `case-id` annotation push whose
 * `description` is a string literal (a bare `TODO` is the placeholder generated specs
 * carry, so it stays a pending id rather than becoming one), one per literal configured
 * call, and one per table row a member-expression call resolves.
 */
function resolveCaseIdEntries(code, block, arrayConsts, forOfBindings, callRe) {
  const entries = [];
  if (block.bodyStart === null) return entries;
  const bodyText = code.slice(block.bodyStart, block.bodyEnd);
  let m;

  ANNOTATION_PUSH_RE.lastIndex = 0;
  while ((m = ANNOTATION_PUSH_RE.exec(bodyText))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(bodyText, parenOpen);
    if (parenClose === -1) continue;
    const argsText = bodyText.slice(parenOpen + 1, parenClose);
    ANNOTATION_PUSH_RE.lastIndex = parenClose + 1;
    if (!/\btype\s*:\s*(['"])case-id\1/.test(argsText)) continue;
    const description = /\bdescription\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(argsText);
    if (!description) continue;
    const value = description[2].trim();
    if (value === '' || value === 'TODO') continue;
    entries.push({ ids: [/^-?\d+$/.test(value) ? Number(value) : value], source: 'annotation' });
  }

  if (!callRe) return entries;
  callRe.lastIndex = 0;
  while ((m = callRe.exec(bodyText))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(bodyText, parenOpen);
    if (parenClose === -1) continue;
    const argsText = bodyText.slice(parenOpen + 1, parenClose);
    callRe.lastIndex = parenClose + 1;

    const literal = parseLiteralCaseIds(argsText);
    if (literal) {
      // A bare TODO literal is the pending placeholder, same as in an annotation push --
      // it stays a pending id rather than becoming one.
      if (!(literal.length === 1 && literal[0] === 'TODO')) {
        entries.push({ ids: literal, source: 'literal' });
      }
      continue;
    }
    const member = memberExprOf(argsText);
    if (!member) continue;
    const tableIds = resolveTableIds(code, block.index, member.ident, member.prop, arrayConsts, forOfBindings);
    if (!tableIds) continue;
    for (const id of tableIds) entries.push({ ids: [id], source: 'table' });
  }
  return entries;
}

/**
 * One sequential left-to-right pass over a test body: every call site (a request, or a call
 * followed to the requests it reaches) and every assertion (`expect(...)`, or a bare call
 * into a helper that asserts a status) is visited in source order. A site inside an
 * `expect(...)` argument is counted before that assertion. `requestsSoFar` counts requests
 * strictly before the one an assertion examines; an assertion on anything but the test's
 * first request is reported as `effect`.
 */
function scanTestBody(ctx, body) {
  const { info } = body;
  const bodyText = info.code.slice(body.bodyStart, body.bodyEnd);
  const lineOf = (localIndex) => lineAt(info, body.bodyStart + localIndex);
  const sites = readSites(ctx, body);
  const expectRe = /\bexpect\s*\(/g;

  const requests = [];
  const asserts = [];
  let requestsSoFar = 0;
  let nextSite = 0;

  const takeSitesBefore = (localIndex) => {
    while (nextSite < sites.length && sites[nextSite].index - body.bodyStart < localIndex) {
      const site = sites[nextSite];
      nextSite += 1;
      const found = [];
      followSite(ctx, body, site, 0, [], new Set(), found);
      const line = lineAt(info, site.index);
      const preCount = requestsSoFar;
      for (const request of found) requests.push({ ...request, line });
      requestsSoFar += found.length;
      if (found.length > 0) ctx.fault('request', { spec: info.rel, test: body.name });
      if (site.members.length > 0 || found.length === 0) continue;
      const targets = reachingTargets(ctx, body, site);
      const assertInfo = targets.length === 1 ? helperAssertInfo(targets[0]) : null;
      if (!assertInfo) continue;
      let value;
      if (assertInfo.kind === 'literal') {
        value = assertInfo.value;
      } else if (assertInfo.kind === 'ternary') {
        const argText = (splitArgs(site.argsText)[assertInfo.paramIndex]?.text || '').trim();
        if (argText === 'true') value = assertInfo.trueValue;
        else if (argText === 'false') value = assertInfo.falseValue;
      }
      asserts.push({ kind: preCount >= 1 ? 'effect' : 'status', value, line });
      ctx.fault('assert', { spec: info.rel, test: body.name });
    }
  };

  let pos = 0;
  while (pos < bodyText.length) {
    expectRe.lastIndex = pos;
    const expectM = expectRe.exec(bodyText);
    if (!expectM) break;
    takeSitesBefore(expectM.index);
    const parenOpen = expectM.index + expectM[0].length - 1;
    const parenClose = matchBalanced(bodyText, parenOpen);
    if (parenClose === -1) {
      pos = expectM.index + expectM[0].length;
      continue;
    }
    takeSitesBefore(parenClose);
    const exprText = bodyText.slice(parenOpen + 1, parenClose).trim();
    let i = parenClose + 1;
    while (i < bodyText.length && /\s/.test(bodyText[i])) i += 1;
    if (bodyText[i] !== '.') {
      pos = parenClose + 1;
      continue;
    }
    i += 1;
    const notMatch = /^not\s*\.\s*/.exec(bodyText.slice(i));
    if (notMatch) i += notMatch[0].length;
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(bodyText.slice(i));
    if (!nameMatch) {
      pos = parenClose + 1;
      continue;
    }
    const matcherName = nameMatch[0];
    i += matcherName.length;
    while (i < bodyText.length && /\s/.test(bodyText[i])) i += 1;
    if (bodyText[i] !== '(') {
      pos = i;
      continue;
    }
    const matcherParenClose = matchBalanced(bodyText, i);
    if (matcherParenClose === -1) {
      pos = i + 1;
      continue;
    }
    const matcherArgText = bodyText.slice(i + 1, matcherParenClose).trim();
    pos = matcherParenClose + 1;

    const isStatusExpr = /\.status\(\)\s*$/.test(exprText);
    let kind = 'body';
    let value;
    if (matcherName === 'toBeOK') {
      kind = 'status';
    } else if (isStatusExpr && TERMINAL_ASSERT_METHODS.has(matcherName)) {
      kind = 'status';
      if (/^-?\d+$/.test(matcherArgText)) value = Number(matcherArgText);
    } else if (TERMINAL_ASSERT_METHODS.has(matcherName)) {
      if (/^-?\d+$/.test(matcherArgText)) value = Number(matcherArgText);
      else if (/^(true|false)$/.test(matcherArgText)) value = matcherArgText === 'true';
      else if (fullLiteral(matcherArgText) !== null) value = fullLiteral(matcherArgText);
    }
    if (requestsSoFar >= 2) kind = 'effect';
    asserts.push({ kind, value, line: lineOf(expectM.index) });
    ctx.fault('assert', { spec: info.rel, test: body.name });
  }
  takeSitesBefore(Infinity);

  return { requests, asserts };
}

/**
 * The facts of one spec, test by test. A test is read into its own list first, so a reader
 * that fails inside one test drops only that test's partial request and assert facts: the test
 * keeps its `pw_test` and an `unknown` `pw_backend` marked `reader-failure`, and the later tests
 * of the spec are still read.
 */
function processSpecFile(info, requestCtx, facts, caseIdCallRe, backendReader) {
  const { code, rel: relPath } = info;
  const lineOf = (index) => lineAt(info, index);

  const describeSkipSpans = findDescribeSkipSpans(code);
  const testBlocks = findTestBlocks(code);
  const arrayConsts = collectArrayConsts(code);
  const forOfBindings = collectForOfBindings(code);

  for (const block of testBlocks) {
    const skipped = block.ownSkip || isInsideSkipDescribe(block.index, describeSkipSpans);
    const at = { file: relPath, line: lineOf(block.index), spec: relPath, test: block.title };
    if (block.unread) {
      pushUnreadTest(facts, at, skipped, block.unread, []);
      continue;
    }
    let caseIdEntries = [];
    try {
      requestCtx.fault('case-id', { spec: relPath, test: block.title });
      caseIdEntries = resolveCaseIdEntries(code, block, arrayConsts, forOfBindings, caseIdCallRe);
      facts.push(...readTestFacts(info, requestCtx, backendReader, block, at, skipped, caseIdEntries));
    } catch {
      pushUnreadTest(facts, at, skipped, 'reader-failure', caseIdEntries);
    }
  }
}

function caseIdFact(at, entry) {
  return fact('case_id', { file: at.file, line: at.line, spec: at.spec, ids: entry.ids, source: entry.source });
}

/** A test the reader could not read in full: its declaration, its finished case ids, and an `unknown` class. */
function pushUnreadTest(facts, at, skipped, unread, caseIdEntries) {
  facts.push(fact('pw_test', { ...at, skipped, unread }));
  for (const entry of caseIdEntries) facts.push(caseIdFact(at, entry));
  facts.push(fact('pw_backend', { ...at, skipped, backend: 'unknown', sites: [], reason: unread }));
}

function readTestFacts(info, requestCtx, backendReader, block, at, skipped, caseIdEntries) {
  const out = [fact('pw_test', { ...at, skipped })];
  for (const entry of caseIdEntries) out.push(caseIdFact(at, entry));

  const { requests, asserts } =
    block.bodyStart !== null && block.bodyEnd > block.bodyStart
      ? scanTestBody(requestCtx, testBody(info, block, requestCtx.fixtures))
      : { requests: [], asserts: [] };

  for (const req of requests) {
    out.push(
      fact('pw_request', {
        file: at.file,
        line: req.line,
        spec: at.spec,
        test: at.test,
        verb: req.verb,
        template: req.template,
        resolved: req.resolved,
        ...(req.via ? { via: req.via } : {}),
        ...(req.receiver ? { receiver: req.receiver } : {}),
        ...(req.chain ? { chain: req.chain } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
      }),
    );
  }
  for (const assertEntry of asserts) {
    out.push(
      fact('pw_assert', {
        file: at.file,
        line: assertEntry.line,
        spec: at.spec,
        test: at.test,
        kind: assertEntry.kind,
        ...(assertEntry.value !== undefined ? { value: assertEntry.value } : {}),
      }),
    );
  }

  const backend = backendReader.classify(at.file, block, info.code);
  out.push(
    fact('pw_backend', {
      ...at,
      skipped,
      backend: backend.backend,
      sites: backend.sites,
      ...(backend.reason ? { reason: backend.reason } : {}),
    }),
  );
  return out;
}
