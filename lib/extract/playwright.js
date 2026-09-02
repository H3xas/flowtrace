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
 *  1. every `.ts` file under the repo is scanned once for module-level string and
 *     object-literal consts (`const X = "..."`, `const X = { a: "..." } as const`) —
 *     these are the endpoint-name constants a client method's URL is built from.
 *  2. every class is scanned for a method whose body calls `this.<field>.<verb>(<url>)`;
 *     the resolved `{verb, template}` is indexed by `Class.method` and by bare method
 *     name, so a call site can resolve through either.
 *  3. every top-level function (arrow-const or `function`) is scanned the same way, so
 *     an assertion helper that both makes the request and asserts its status (a common
 *     shape in this kind of harness) contributes a request and, when the asserted value
 *     is a literal or a ternary keyed on one of the function's own parameters, a status
 *     value too.
 *
 * Spec files (`tests/**`) are then walked for `test(`/`test.skip(`/`test.only(`/
 * `test.fixme(` blocks, `case-id` annotation pushes (plus any configured case-id
 * calls), and the requests and assertions each test body makes, resolving call sites
 * through the indexes above.
 */

import { readFileSync, existsSync } from 'node:fs';
import { relative, join as joinPath } from 'node:path';
import { walk } from '../walk.js';
import { fact } from '../facts.js';

const TESTS_SUBPATH = 'tests';
const DEFAULT_EXCLUDE = ['node_modules', 'generated', 'playwright-report', 'dist', '*.d.ts'];

const KNOWN_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const VERB_UPPER = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const TERMINAL_ASSERT_METHODS = new Set(['toBe', 'toEqual']);

/** Entry point: repoRoot is the harness checkout (the directory holding `tests/`). */
export async function extract(repoRoot, options = {}) {
  const extraExclude = Array.isArray(options.exclude) ? options.exclude : [];
  const exclude = [...DEFAULT_EXCLUDE, ...extraExclude];
  const caseIdCallRe = buildCaseIdCallRe(options.caseIdCalls);

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
      const code = blankComments(readFileSync(absPath, 'utf8'));
      const depths = computeDepths(code);
      const classSpans = findClassSpans(code, depths);
      const fnSpans = findTopLevelFunctionSpans(code, depths);
      fileInfo.set(absPath, { code, depths, classSpans, fnSpans });
      collectModuleConsts(code, moduleConsts, depths);
    } catch {
      continueExtraction();
    }
  }

  const helperIndex = new Map();
  const methodNameIndex = new Map();
  for (const info of fileInfo.values()) {
    try {
      collectHelperIndex(info.code, info.classSpans, moduleConsts, helperIndex, methodNameIndex);
    } catch {
      continueExtraction();
    }
  }

  const helperFnIndex = new Map();
  for (const info of fileInfo.values()) {
    try {
      collectHelperFnIndex(info.fnSpans, moduleConsts, helperIndex, methodNameIndex, helperFnIndex);
    } catch {
      continueExtraction();
    }
  }

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
      const info = fileInfo.get(absPath);
      const code = info ? info.code : blankComments(readFileSync(absPath, 'utf8'));
      processSpecFile(repoRoot, absPath, code, moduleConsts, helperIndex, methodNameIndex, helperFnIndex, facts, caseIdCallRe);
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
    const stubMethodIndex = collectStubMethodIndex(fileInfo);
    for (const absPath of pwSpecFiles) {
      try {
        const info = fileInfo.get(absPath);
        const code = info ? info.code : blankComments(readFileSync(absPath, 'utf8'));
        processPwStubFile(repoRoot, absPath, code, moduleConsts, endpointRegistry, stubMethodIndex, facts);
      } catch {
        continueExtraction();
      }
    }
  }

  return facts;
}

function continueExtraction() {}

/** Lexical helpers: strings, template literals, comments, balanced brackets. */

function skipString(text, index, quote) {
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

function skipTemplate(text, index) {
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

function matchBalanced(text, openIndex) {
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

function blankComments(text) {
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

function makeLineFinder(text) {
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

function splitArgs(text) {
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

function splitPlus(text) {
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

function fullLiteral(text) {
  if (!text) return null;
  const quote = text[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = quote === '`' ? skipTemplate(text, 0) : skipString(text, 0, quote);
  if (end !== text.length) return null;
  return text.slice(1, end - 1);
}

function bestPartial(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '*';
  if (collapsed.length <= 60) return `\${${collapsed}}`;
  return '*';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRelative(repoRoot, absPath) {
  return relative(repoRoot, absPath).split('\\').join('/');
}

function looksLikeUrl(template) {
  return typeof template === 'string' && template.includes('/');
}

/** Module-level string and object-literal consts: `const X = "..."`, `const X = {...}`. */

const OBJECT_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g;
const STRING_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2\s*;/g;
const PROP_RE = /([A-Za-z_$][\w$]*)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;

/**
 * Brace-nesting depth at every character of the file — 0 only at true module scope.
 * Depth is tracked across strings and template literals (a `{` inside one does not
 * count) so a regex match's own start index can be tested against it directly.
 */
function computeDepths(code) {
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

function isSimpleInterpolation(inner) {
  if (inner.includes('`')) return false;
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" || ch === '"') {
      i = skipString(inner, i, ch) - 1;
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
    if (depth === 0 && ch === '?' && inner[i + 1] !== '.' && inner[i + 1] !== '?') return false;
  }
  return true;
}

function substituteConst(inner, moduleConsts) {
  const trimmed = inner.trim();
  const memberMatch = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (memberMatch) {
    const entry = moduleConsts.get(memberMatch[1]);
    if (entry && entry.kind === 'object' && entry.props.has(memberMatch[2])) {
      return entry.props.get(memberMatch[2]);
    }
    return null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const entry = moduleConsts.get(trimmed);
    if (entry && entry.kind === 'string') return entry.value;
    return null;
  }
  return null;
}

function flattenInterpolations(text, moduleConsts) {
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
        const substituted = substituteConst(inner, moduleConsts);
        out += substituted !== null ? substituted : text.slice(i, end);
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

function resolveUrlExpr(text, moduleConsts) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { template: '*', resolved: false };

  const quote = trimmed[0];
  if (quote === "'" || quote === '"' || quote === '`') {
    const end = quote === '`' ? skipTemplate(trimmed, 0) : skipString(trimmed, 0, quote);
    if (end === trimmed.length) {
      const inner = trimmed.slice(1, end - 1);
      if (quote === '`') {
        const flat = flattenInterpolations(inner, moduleConsts);
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
      const r = resolveUrlExpr(part, moduleConsts);
      template += r.template;
      if (!r.resolved) resolved = false;
    }
    return { template, resolved };
  }

  const memberMatch = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (memberMatch) {
    const entry = moduleConsts.get(memberMatch[1]);
    if (entry && entry.kind === 'object' && entry.props.has(memberMatch[2])) {
      return { template: entry.props.get(memberMatch[2]), resolved: true };
    }
    return { template: bestPartial(trimmed), resolved: false };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const entry = moduleConsts.get(trimmed);
    if (entry && entry.kind === 'string') return { template: entry.value, resolved: true };
    return { template: `\${${trimmed}}`, resolved: false };
  }

  return { template: bestPartial(trimmed), resolved: false };
}

/** Class scanning: methods that wrap `this.<field>.<verb>(<url>)`. */

function findClassSpans(code, depths) {
  const spans = [];
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
  let m;
  while ((m = classRe.exec(code))) {
    if (!isTopLevel(m.index, depths)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBalanced(code, braceOpen);
    if (braceClose === -1) continue;
    spans.push({ className: m[1], bodyStart: braceOpen + 1, bodyEnd: braceClose });
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

function findRequestCall(code, bodyStart, bodyEnd) {
  const re = /this\.[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*\(/g;
  re.lastIndex = bodyStart;
  const m = re.exec(code);
  if (!m || m.index >= bodyEnd) return null;
  const parenOpen = m.index + m[0].length - 1;
  const parenClose = matchBalanced(code, parenOpen);
  if (parenClose === -1) return null;
  const argsText = code.slice(parenOpen + 1, parenClose);
  const firstArg = splitArgs(argsText)[0]?.text ?? '';
  return { verb: m[1], firstArg };
}

function collectHelperIndex(code, classSpans, moduleConsts, helperIndex, methodNameIndex) {
  for (const classSpan of classSpans) {
    const members = splitClassMembers(code, classSpan.bodyStart, classSpan.bodyEnd);
    for (const member of members) {
      if (member.name === 'constructor') continue;
      const call = findRequestCall(code, member.bodyStart, member.bodyEnd);
      if (!call) continue;
      const { template, resolved } = resolveUrlExpr(call.firstArg, moduleConsts);
      if (!looksLikeUrl(template)) continue;
      const entry = { verb: VERB_UPPER[call.verb], template, resolved };
      helperIndex.set(`${classSpan.className}.${member.name}`, entry);
      const list = methodNameIndex.get(member.name) || [];
      list.push({ class: classSpan.className, ...entry });
      methodNameIndex.set(member.name, list);
    }
  }
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
      spans.push({ name: m[1], paramsText, bodyText: code.slice(j + 1, braceClose), bodyStart: j + 1, bodyEnd: braceClose });
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
    spans.push({ name: m[1], paramsText, bodyText: code.slice(j, k), bodyStart: j, bodyEnd: k });
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
    spans.push({ name: m[1], paramsText, bodyText: code.slice(j + 1, braceClose), bodyStart: j + 1, bodyEnd: braceClose });
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

function detectRequestHelper(paramsText, bodyText, moduleConsts, helperIndex, methodNameIndex) {
  const paramInfos = parseParamInfos(paramsText);
  const paramNames = paramInfos.map((p) => p.name);
  const allowedMethods = new Set([...KNOWN_VERBS, ...methodNameIndex.keys()]);
  if (allowedMethods.size === 0) return null;
  const callRe = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${[...allowedMethods].map(escapeRegExp).join('|')})\\s*\\(`);
  const callMatch = callRe.exec(bodyText);
  if (!callMatch) return null;

  const paramName = callMatch[1];
  const method = callMatch[2];
  const parenOpen = callMatch.index + callMatch[0].length - 1;
  const parenClose = matchBalanced(bodyText, parenOpen);
  const argsText = parenClose === -1 ? '' : bodyText.slice(parenOpen + 1, parenClose);
  const firstArg = splitArgs(argsText)[0]?.text ?? '';

  let requestEntry = null;
  if (KNOWN_VERBS.has(method)) {
    const { template, resolved } = resolveUrlExpr(firstArg, moduleConsts);
    if (looksLikeUrl(template)) requestEntry = { verb: VERB_UPPER[method], template, resolved };
  } else {
    const paramInfo = paramInfos.find((p) => p.name === paramName);
    if (paramInfo && paramInfo.type && helperIndex.has(`${paramInfo.type}.${method}`)) {
      requestEntry = helperIndex.get(`${paramInfo.type}.${method}`);
    } else {
      const candidates = methodNameIndex.get(method) || [];
      if (candidates.length === 1) requestEntry = candidates[0];
    }
  }
  if (!requestEntry) return null;

  const assertRe = /expect\(\s*([A-Za-z_$][\w$]*)\.status\(\)\s*\)\s*\.\s*(toBe|toEqual)\(\s*([^)]*)\)/;
  const assertMatch = assertRe.exec(bodyText);
  let assertInfo = null;
  if (assertMatch) {
    const argExpr = assertMatch[3].trim();
    const ternaryMatch = /^([A-Za-z_$][\w$]*)\s*\?\s*(-?\d+)\s*:\s*(-?\d+)$/.exec(argExpr);
    if (ternaryMatch && paramNames.includes(ternaryMatch[1])) {
      assertInfo = {
        kind: 'ternary',
        condParam: ternaryMatch[1],
        trueValue: Number(ternaryMatch[2]),
        falseValue: Number(ternaryMatch[3]),
      };
    } else if (/^-?\d+$/.test(argExpr)) {
      assertInfo = { kind: 'literal', value: Number(argExpr) };
    } else {
      assertInfo = { kind: 'unresolved' };
    }
  }
  return { paramNames, request: requestEntry, assert: assertInfo };
}

function collectHelperFnIndex(fnSpans, moduleConsts, helperIndex, methodNameIndex, helperFnIndex) {
  for (const span of fnSpans) {
    const entry = detectRequestHelper(span.paramsText, span.bodyText, moduleConsts, helperIndex, methodNameIndex);
    if (entry) helperFnIndex.set(span.name, entry);
  }
}

function collectFactoryMap(code) {
  const map = new Map();
  const spans = findTopLevelFunctionSpans(code, computeDepths(code));
  for (const span of spans) {
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
 * graph, the same bare-name heuristic `helperIndex`/`methodNameIndex` already rely on. An
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

/** The first argument text of the first `.route(...)` call found in `bodyText`, or null
 *  when the body never calls `.route(` at all — such a method is not a stub helper. */
function findRouteCallArg(bodyText) {
  ROUTE_CALL_RE.lastIndex = 0;
  const m = ROUTE_CALL_RE.exec(bodyText);
  if (!m) return null;
  const parenOpen = m.index + m[0].length - 1;
  const parenClose = matchBalanced(bodyText, parenOpen);
  if (parenClose === -1) return null;
  const argsText = bodyText.slice(parenOpen + 1, parenClose);
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
function collectStubMethodIndex(fileInfo) {
  const index = new Map();
  for (const info of fileInfo.values()) {
    for (const classSpan of info.classSpans) {
      const members = splitClassMembers(info.code, classSpan.bodyStart, classSpan.bodyEnd);
      for (const member of members) {
        if (member.name === 'constructor') continue;
        const bodyText = info.code.slice(member.bodyStart, member.bodyEnd);
        const firstArg = findRouteCallArg(bodyText);
        if (firstArg === null) continue;
        addStubCandidate(index, member.name, classifyStubMethod(member.paramsText || '', firstArg));
      }
    }
    for (const fnSpan of info.fnSpans) {
      const firstArg = findRouteCallArg(fnSpan.bodyText);
      if (firstArg === null) continue;
      addStubCandidate(index, fnSpan.name, classifyStubMethod(fnSpan.paramsText, firstArg));
    }
  }
  return index;
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

function processPwStubFile(repoRoot, absPath, code, moduleConsts, registry, stubMethodIndex, facts) {
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);
  const describeSkipSpans = findDescribeSkipSpans(code);
  const testBlocks = findTestBlocks(code);

  const emit = (index, kind, extra) => {
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
    const { template, resolved } = resolveUrlExpr(firstArg, moduleConsts);
    if (!looksLikeUrl(template)) continue;
    emit(m.index, 'route', { verb: 'ANY', pattern: template, resolved });
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
    if (resolution.kind !== 'forward' || !firstArgPart) {
      emit(m.index, 'opaque', { helper: name });
      continue;
    }
    const endpoint = resolveEndpointValue(firstArgPart.text, registry);
    if (endpoint) {
      emit(m.index, 'route', {
        verb: (endpoint.method || 'GET').toUpperCase(),
        pattern: endpoint.pattern,
        resolved: !endpoint.isRegex,
      });
      continue;
    }
    const { template, resolved } = resolveUrlExpr(firstArgPart.text, moduleConsts);
    emit(m.index, 'route', {
      verb: 'ANY',
      pattern: looksLikeUrl(template) ? template : bestPartial(firstArgPart.text),
      resolved: looksLikeUrl(template) && resolved,
    });
  }
}

/** Spec files: `test(`/`test.describe.skip(` spans, case-id annotations and calls, request/assert scan. */

const DESCRIBE_SKIP_RE = /\btest\.describe\.skip\s*\(/g;
const TEST_RE = /\btest\.(skip|only|fixme)\s*\(|\btest\s*\(/g;
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

function findTestBlocks(code) {
  const blocks = [];
  TEST_RE.lastIndex = 0;
  let m;
  while ((m = TEST_RE.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const argsText = code.slice(parenOpen + 1, parenClose);
    const parts = splitArgs(argsText);
    if (parts.length === 0) continue;
    const title = titleOf(parts[0].text);
    if (title === null) continue;
    const ownSkip = m[1] === 'skip' || m[1] === 'fixme';

    let bodyStart = null;
    let bodyEnd = null;
    if (parts.length > 1) {
      const fnPart = parts[parts.length - 1];
      const fnStart = parenOpen + 1 + fnPart.start;
      // Search for the body brace after the arrow, not the first `{` in the callback —
      // a destructured parameter like `({ request }) => { ... }` has one of its own.
      const arrowIdx = code.indexOf('=>', fnStart);
      const braceSearchFrom = arrowIdx !== -1 && arrowIdx < parenClose ? arrowIdx : fnStart;
      const braceIdx = code.indexOf('{', braceSearchFrom);
      if (braceIdx !== -1 && braceIdx < parenClose) {
        const braceClose = matchBalanced(code, braceIdx);
        if (braceClose !== -1) {
          bodyStart = braceIdx + 1;
          bodyEnd = braceClose;
        }
      }
    }
    blocks.push({ title, index: m.index, ownSkip, bodyStart, bodyEnd });
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
 * One sequential left-to-right pass over a test body: every request (a direct verb
 * call, or a member call whose method name is a known helper) and every assertion
 * (`expect(...)`, or a bare call into a request+assert helper) is visited in source
 * order. `requestsSoFar` counts requests strictly before the one an assertion examines;
 * an assertion on anything but the test's first request is reported as `effect`.
 */
function scanTestBody(bodyText, ctx) {
  const { lineOf, identBindings, helperIndex, methodNameIndex, helperFnIndex, moduleConsts } = ctx;
  const helperMethodNames = [...methodNameIndex.keys()];
  const allowedMemberMethods = new Set([...KNOWN_VERBS, ...helperMethodNames]);
  const memberRe =
    allowedMemberMethods.size > 0
      ? new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${[...allowedMemberMethods].map(escapeRegExp).join('|')})\\s*\\(`, 'g')
      : null;
  const expectRe = /\bexpect\s*\(/g;
  const helperFnNames = [...helperFnIndex.keys()];
  const bareRe =
    helperFnNames.length > 0
      ? new RegExp(`\\b(${helperFnNames.map(escapeRegExp).join('|')})\\s*\\(`, 'g')
      : null;

  const requests = [];
  const asserts = [];
  let requestsSoFar = 0;
  let pos = 0;

  const execFrom = (re, fromIndex) => {
    if (!re) return null;
    re.lastIndex = fromIndex;
    return re.exec(bodyText);
  };

  while (pos < bodyText.length) {
    const expectM = execFrom(expectRe, pos);
    const memberM = execFrom(memberRe, pos);
    const bareM = execFrom(bareRe, pos);
    const candidates = [expectM, memberM, bareM].filter(Boolean);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.index - b.index);
    const picked = candidates[0];

    if (picked === expectM) {
      const parenOpen = expectM.index + expectM[0].length - 1;
      const parenClose = matchBalanced(bodyText, parenOpen);
      if (parenClose === -1) {
        pos = expectM.index + expectM[0].length;
        continue;
      }
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
      continue;
    }

    if (picked === memberM) {
      const ident = memberM[1];
      const method = memberM[2];
      const parenOpen = memberM.index + memberM[0].length - 1;
      const parenClose = matchBalanced(bodyText, parenOpen);
      pos = parenClose === -1 ? memberM.index + memberM[0].length : parenClose + 1;

      if (KNOWN_VERBS.has(method)) {
        const argsText = parenClose === -1 ? '' : bodyText.slice(parenOpen + 1, parenClose);
        const firstArg = splitArgs(argsText)[0]?.text ?? '';
        const { template, resolved } = resolveUrlExpr(firstArg, moduleConsts);
        if (looksLikeUrl(template)) {
          requests.push({ verb: VERB_UPPER[method], template, resolved, line: lineOf(memberM.index) });
          requestsSoFar += 1;
        }
      } else {
        let entry = null;
        const boundClass = identBindings.get(ident);
        if (boundClass && helperIndex.has(`${boundClass}.${method}`)) {
          entry = helperIndex.get(`${boundClass}.${method}`);
        } else {
          const candidatesList = methodNameIndex.get(method) || [];
          if (candidatesList.length === 1) entry = candidatesList[0];
        }
        if (entry) {
          requests.push({ verb: entry.verb, template: entry.template, resolved: true, via: 'helper', line: lineOf(memberM.index) });
        } else {
          requests.push({
            verb: 'ANY',
            template: bestPartial(`${ident}.${method}(...)`),
            resolved: false,
            via: 'helper',
            line: lineOf(memberM.index),
          });
        }
        requestsSoFar += 1;
      }
      continue;
    }

    // bareM: a call into a request(+assert) helper function.
    const fnName = bareM[1];
    const parenOpen = bareM.index + bareM[0].length - 1;
    const parenClose = matchBalanced(bodyText, parenOpen);
    pos = parenClose === -1 ? bareM.index + bareM[0].length : parenClose + 1;
    const argsText = parenClose === -1 ? '' : bodyText.slice(parenOpen + 1, parenClose);
    const callArgs = splitArgs(argsText).map((p) => p.text);
    const helperEntry = helperFnIndex.get(fnName);
    if (!helperEntry) continue;

    const preCount = requestsSoFar;
    if (helperEntry.request) {
      requests.push({
        verb: helperEntry.request.verb,
        template: helperEntry.request.template,
        resolved: true,
        via: 'helper',
        line: lineOf(bareM.index),
      });
      requestsSoFar += 1;
    }
    if (helperEntry.assert) {
      let value;
      if (helperEntry.assert.kind === 'literal') {
        value = helperEntry.assert.value;
      } else if (helperEntry.assert.kind === 'ternary') {
        const idx = helperEntry.paramNames.indexOf(helperEntry.assert.condParam);
        const argText = (callArgs[idx] || '').trim();
        if (argText === 'true') value = helperEntry.assert.trueValue;
        else if (argText === 'false') value = helperEntry.assert.falseValue;
      }
      const kind = preCount >= 1 ? 'effect' : 'status';
      asserts.push({ kind, value, line: lineOf(bareM.index) });
    }
  }

  return { requests, asserts };
}

function processSpecFile(repoRoot, absPath, code, moduleConsts, helperIndex, methodNameIndex, helperFnIndex, facts, caseIdCallRe) {
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);

  const localFactoryMap = collectFactoryMap(code);
  const identBindings = collectIdentBindings(code, localFactoryMap);

  const describeSkipSpans = findDescribeSkipSpans(code);
  const testBlocks = findTestBlocks(code);
  const arrayConsts = collectArrayConsts(code);
  const forOfBindings = collectForOfBindings(code);

  for (const block of testBlocks) {
    const skipped = block.ownSkip || isInsideSkipDescribe(block.index, describeSkipSpans);
    const bodyText = block.bodyStart !== null ? code.slice(block.bodyStart, block.bodyEnd) : '';
    const caseIdEntries = resolveCaseIdEntries(code, block, arrayConsts, forOfBindings, caseIdCallRe);
    const line = lineOf(block.index);

    facts.push(
      fact('pw_test', {
        file: relPath,
        line,
        spec: relPath,
        test: block.title,
        skipped,
      }),
    );

    for (const entry of caseIdEntries) {
      facts.push(
        fact('case_id', {
          file: relPath,
          line,
          spec: relPath,
          ids: entry.ids,
          source: entry.source,
        }),
      );
    }

    if (!bodyText) continue;

    const { requests, asserts } = scanTestBody(bodyText, {
      lineOf: (localIndex) => lineOf(block.bodyStart + localIndex),
      identBindings,
      helperIndex,
      methodNameIndex,
      helperFnIndex,
      moduleConsts,
    });

    for (const req of requests) {
      facts.push(
        fact('pw_request', {
          file: relPath,
          line: req.line,
          spec: relPath,
          test: block.title,
          verb: req.verb,
          template: req.template,
          resolved: req.resolved,
          ...(req.via ? { via: req.via } : {}),
        }),
      );
    }
    for (const assertEntry of asserts) {
      facts.push(
        fact('pw_assert', {
          file: relPath,
          line: assertEntry.line,
          spec: relPath,
          test: block.title,
          kind: assertEntry.kind,
          ...(assertEntry.value !== undefined ? { value: assertEntry.value } : {}),
        }),
      );
    }
  }
}
