/**
 * React web UI extractor.
 *
 * Heuristic, regex-and-brace-matching reader over a React + TypeScript library that uses
 * classic Redux with `redux-thunk` on a store it does not own. It does not parse
 * TypeScript; it recognises the idioms below and turns each occurrence into one fact.
 * They are conventions, not a standard: a library that wires state differently needs the
 * patterns widened.
 *
 * The state layer has no separate effects tier: an exported action creator both issues the
 * HTTP request and returns a `(dispatch, getState) => …` continuation, so **the thunk is
 * the effect**. That makes the existing vocabulary sufficient — a JSX `on*` prop is a
 * `template_handler`, a `connect(map, { creators })` entry is a `props_bind`, a creator
 * holding an `httpClient.getGatewayClient()` call is an `effect_handler`, and the chain
 * `template_handler → props_bind|action_dispatch → effect_handler → gateway_call` is the
 * same shape the mobile extractor already produces.
 *
 * Lexical helpers (`matchBalanced`, `skipString`, `skipTemplate`, `findLocalConst`, …) are
 * imported from `./text.js`, which the mobile extractor shares, so a template literal or a
 * JSX expression container holding a brace cannot derail a depth counter.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, join as joinPath } from 'node:path';
import { walk } from '../walk.js';
import { fact } from '../facts.js';
import { extract as extractCypressRemainder } from './web-cypress.js';
import {
  bestPartial,
  blankComments,
  computeDepths,
  findLocalConst,
  flattenInterpolations,
  fullLiteral,
  makeLineFinder,
  matchBalanced,
  skipString,
  skipTemplate,
  splitArgs,
  splitPlus,
  toRelative,
} from './text.js';

/** Source subdirectory walked by default; a repository entry may override it. */
const DEFAULT_SRC_SUBPATH = 'src';

const SOURCE_EXTENSIONS = ['.tsx', '.ts'];

const DEFAULT_EXCLUDE = [
  'node_modules',
  'dist',
  '__tests__',
  '__snapshots__',
  '__mocks__',
  '*.d.ts',
  '*.spec.ts',
  '*.spec.tsx',
  '*.test.ts',
  '*.test.tsx',
  '*.stories.ts',
  '*.stories.tsx',
  '*.pw.ts',
  '*.cy.ts',
  '*.cy.tsx',
];

/**
 * The 1-based column `index` sits at, which with its line is the site a reader would point
 * at. Two declarations of the same trigger can share a line — two inline `useEffect` calls,
 * two unread hooks — and a line alone does not tell them apart.
 */
function columnOf(code, index) {
  return index - (code.lastIndexOf('\n', index - 1) + 1) + 1;
}

/** The HTTP wrapper this extractor recognises: `httpClient.getGatewayClient().<verb>(url)`. */
const GATEWAY_OBJECT = 'httpClient';
const GATEWAY_SERVICE = 'httpClient';
const GATEWAY_FACTORY = 'getGatewayClient';
const GATEWAY_CALL_RE = new RegExp(`\\b${GATEWAY_OBJECT}\\s*\\.\\s*${GATEWAY_FACTORY}\\s*\\(`, 'g');
const GATEWAY_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

/**
 * Files whose exported functions are read as action creators: anything under an
 * `actions/` or `services/` directory. An exported creator elsewhere is read as a helper,
 * not an effect.
 */
const EFFECT_PATH_RE = /(^|\/)(actions|services)(\/|$)/;

/**
 * JSX tags that are wrapping machinery, not a component hop. A message-formatting or
 * provider wrapper adds no composition information of its own, so counting it would fill
 * `renders` with edges that say nothing about which component renders which.
 */
const RENDERS_BLACKLIST = new Set([
  'React',
  'Fragment',
  'StrictMode',
  'Suspense',
  'Profiler',
  'Provider',
  'ErrorBoundary',
  'IntlProvider',
  'RawIntlProvider',
  'FormattedMessage',
  'FormattedHTMLMessage',
  'FormattedDate',
  'FormattedTime',
  'FormattedNumber',
  'FormattedPlural',
  'FormattedList',
  'FormattedRelativeTime',
  'FormattedDateTimeRange',
  'Route',
  'Routes',
  'Router',
  'BrowserRouter',
  'MemoryRouter',
  'HashRouter',
  'Switch',
  'Outlet',
  'Navigate',
  'Redirect',
]);

/**
 * Callee names filtered out of `method_call`. React hooks, `react-intl` formatting,
 * lodash and the JavaScript builtins are calls that never lead anywhere the walk can
 * follow, and unfiltered they would swamp the graph with edges no route ever uses — the
 * same failure an unfiltered `store.dispatch` causes: the denylist keeps `method_call`
 * to calls that can reach a route.
 */
/**
 * The `import` keyword as a value. Written as a template literal on purpose: the
 * single-file bundler scans for side-effect imports textually, and a quoted string
 * literal *ending* in the word presents it the same shape.
 */
const IMPORT_KEYWORD = `import`;

const CALLEE_DENYLIST = new Set([
  // language keywords the bare-call regex would otherwise pick up
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await',
  'delete', 'void', 'do', 'else', 'try', 'super', 'yield', 'case', 'throw', IMPORT_KEYWORD,
  'export', 'const', 'let', 'var', 'class', 'extends', 'in', 'of', 'as',
  // React
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer',
  'useLayoutEffect', 'useImperativeHandle', 'useDebugValue', 'useId', 'useTransition',
  'useDeferredValue', 'useSyncExternalStore', 'useSelector', 'useDispatch', 'useAppDispatch',
  'useAppSelector', 'useStore', 'useNavigate', 'useLocation', 'useParams', 'useSearchParams',
  'setState', 'forceUpdate', 'createElement', 'cloneElement', 'createContext', 'createRef',
  'forwardRef', 'memo', 'lazy', 'render', 'createPortal', 'flushSync',
  // redux wiring
  'connect', 'withRouter', 'compose', 'bindActionCreators', 'applyMiddleware',
  'combineReducers', 'createStore', 'getGatewayClient',
  // react-intl
  'useIntl', 'injectIntl', 'defineMessages', 'defineMessage', 'formatMessage', 'formatDate',
  'formatTime', 'formatNumber', 'formatPlural', 'formatRelativeTime', 'formatList',
  // lodash and collection/object helpers
  'map', 'filter', 'forEach', 'reduce', 'find', 'findIndex', 'findLast', 'some', 'every',
  'includes', 'indexOf', 'lastIndexOf', 'slice', 'splice', 'concat', 'join', 'push', 'pop',
  'shift', 'unshift', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'keys', 'values',
  'entries', 'assign', 'freeze', 'hasOwnProperty', 'isArray', 'isEmpty', 'isEqual', 'isNil',
  'isNull', 'isUndefined', 'isFunction', 'isObject', 'isString', 'isNumber', 'cloneDeep',
  'clone', 'debounce', 'throttle', 'omit', 'pick', 'uniq', 'uniqBy', 'groupBy', 'orderBy',
  'sortBy', 'merge', 'chunk', 'range', 'noop', 'identity',
  // promises, strings, numbers, JSON, console, timers, DOM
  'then', 'catch_', 'finally', 'resolve', 'reject', 'all', 'allSettled', 'race',
  'toString', 'valueOf', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'toLowerCase', 'toUpperCase', 'substring', 'substr', 'charAt', 'startsWith', 'endsWith',
  'padStart', 'padEnd', 'split', 'match', 'matchAll', 'test', 'exec', 'repeat',
  'toFixed', 'parse', 'stringify', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'assert',
  'bind', 'call', 'apply', 'preventDefault', 'stopPropagation', 'stopImmediatePropagation',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'focus', 'blur', 'scrollTo', 'scrollIntoView', 'getBoundingClientRect',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'JSON', 'Math', 'Promise',
  'Error', 'RegExp', 'Set', 'Map', 'WeakMap', 'Symbol', 'BigInt', 'require',
]);

/** Modules whose imported names never lead to a hop inside this repository. */
const FOREIGN_MODULE_RE =
  /^(react|react-dom|react-redux|react-intl|react-router|react-router-dom|redux|redux-thunk|lodash|prop-types|classnames|moment|dayjs|axios)(\/|$)/;

/** Whether a name imported from `specifier` can lead anywhere inside this repository. */
export function isForeignModule(specifier) {
  return typeof specifier === 'string' && FOREIGN_MODULE_RE.test(specifier);
}

/** Wrapper HOCs unwrapped to reach the component a `connect(…)` call really binds. */
const HOC_WRAPPERS = new Set([
  'withRouter', 'injectIntl', 'memo', 'forwardRef', 'observer', 'withStyles', 'withTheme',
  'React.memo', 'React.forwardRef',
]);

const TAG_RE = /<([A-Z][A-Za-z0-9_]*)/g;
const TAG_MEMBER_RE = /\s*\.\s*([A-Za-z_$][\w$]*)/y;
const HANDLER_ATTR_RE = /\bon[A-Z][A-Za-z0-9]*\s*=\s*\{/g;
const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*(?:extends\s+([A-Za-z_$][\w$.]*))?/g;
const FUNCTION_DECL_RE = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
const BINDING_DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:!)?\s*(?::[^=;]*?)?=/g;
const CALL_RE = /\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]*>\s*)?\(/g;
const DISPATCH_RE = /\bdispatch\s*\(/g;
const CONNECT_RE = /\bconnect\s*\(/g;
const ROUTE_TAG_RE = /<Route\b/g;
const IMPORT_RE = /\bimport\s+(?:type\s+)?([\s\S]{0,400}?)\s+from\s*(['"])([^'"]+)\2/g;
const JSX_BODY_RE = /<\/[A-Za-z]|<[A-Za-z][\w.]*[\s/>]/;
const UPPER_CONST_RE = /^[A-Z][A-Z0-9_]*$/;
const NAVIGATE_RE = /\bnavigate\s*\(\s*(['"`])(\/[A-Za-z0-9_-]+)(?=[/'"`])/g;

/**
 * Entry point: `repoRoot` is the library checkout; the extractor walks
 * `<repoRoot>/<srcSubpath>` (default `src`), falling back to `repoRoot` itself when that
 * subdirectory does not exist. Every per-file parse failure is contained so one malformed
 * source file cannot abort the whole extraction.
 *
 * `options.cypressSubpath`, when set, additionally reads a Cypress suite covering this
 * UI. The value may point outward (`../<suite>`), so a suite checked in beside the
 * library rather than inside it is still reachable. It contributes `cypress_test` and
 * `cypress_intercept` facts and nothing else; an absent directory is silence, not an error.
 */
export async function extract(repoRoot, options = {}) {
  const extraExclude = Array.isArray(options.exclude) ? options.exclude : [];
  const exclude = [...DEFAULT_EXCLUDE, ...extraExclude];
  const subpath = typeof options.srcSubpath === 'string' && options.srcSubpath.trim() !== ''
    ? options.srcSubpath.trim()
    : DEFAULT_SRC_SUBPATH;

  const candidate = joinPath(repoRoot, subpath);
  const srcRoot = existsSync(candidate) ? candidate : repoRoot;
  if (!existsSync(srcRoot)) return [];

  const facts = [];
  const routeTargets = new Map();
  const pendingRenders = [];
  const componentFacts = [];
  const componentNames = new Set();
  const mountSegments = new Map();

  for (const absPath of walk(srcRoot, { extensions: SOURCE_EXTENSIONS, exclude })) {
    try {
      processFile(repoRoot, absPath, {
        facts, routeTargets, pendingRenders, componentFacts, componentNames, mountSegments,
      });
    } catch {
      continueExtraction();
    }
  }

  const prefix = inferredMountPrefix(mountSegments);
  for (const entry of componentFacts) {
    if (entry.role === 'hook') continue;
    if (!routeTargets.has(entry.name)) continue;
    entry.role = 'page';
    const path = routeTargets.get(entry.name);
    if (path) entry.path = path;
    if (path && prefix && !path.startsWith(`${prefix}/`)) entry.prefix = prefix;
  }
  for (const pending of pendingRenders) {
    pending.entry.resolved = componentNames.has(pending.to);
  }

  const cypressSubpath = typeof options.cypressSubpath === 'string' ? options.cypressSubpath.trim() : '';
  if (cypressSubpath !== '') {
    const cypressRoot = joinPath(repoRoot, cypressSubpath);
    if (existsSync(cypressRoot)) {
      for (const entry of extractCypressRemainder(cypressRoot, { exclude: extraExclude })) facts.push(entry);
    }
  }

  return facts;
}

function continueExtraction() {}

/**
 * The browser path prefix this library is mounted under, inferred from its own
 * `navigate("/<segment>/…")` literals: the first segment the most of them agree on. The
 * real mount is decided by the host that federates the library, which is outside anything
 * this extractor can read, so the value is a reading of intent and never a manifest —
 * `trace` tags a page start resolved through it as inferred. Fewer than two agreeing
 * literals is not evidence, and no prefix is stated.
 */
function inferredMountPrefix(segments) {
  let best = null;
  let bestCount = 0;
  for (const [segment, count] of [...segments.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count <= bestCount) continue;
    best = segment;
    bestCount = count;
  }
  return bestCount >= 2 ? best : null;
}

/** Lexical odds and ends this extractor adds on top of `./text.js`. */

function skipWs(code, index, limit) {
  let i = index;
  while (i < limit && (code[i] === ' ' || code[i] === '\t' || code[i] === '\r' || code[i] === '\n')) i += 1;
  return i;
}

/**
 * A copy of `code` with the *contents* of every string and template literal replaced by
 * spaces, offsets and line breaks preserved. Regex scans run over this so a tag name, a
 * handler attribute or a `dispatch(` inside a literal cannot become a fact; brace matching
 * still runs over the real text, which skips literals on its own.
 */
function maskLiterals(code) {
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

/** End of the statement starting at `start`: a top-level `;` or the end of the scope. */
function statementEndAt(code, start, limit) {
  let depth = 0;
  let i = start;
  while (i < limit) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return i;
    i += 1;
  }
  return limit;
}

/** The first `{` after `from` that is not inside a type-parameter list or a literal. */
function findBodyOpen(code, from, limit) {
  let angle = 0;
  let i = from;
  while (i < limit && i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if (ch === '<') {
      angle += 1;
      i += 1;
      continue;
    }
    if (ch === '>') {
      if (angle > 0) angle -= 1;
      i += 1;
      continue;
    }
    if (ch === '{' && angle === 0) return i;
    i += 1;
  }
  return -1;
}

/** The `>` closing a JSX opening tag, stepping over attribute expression containers. */
function jsxTagEnd(code, start, limit) {
  let i = start;
  while (i < limit) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipString(code, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if (ch === '{') {
      const close = matchBalanced(code, i);
      i = close === -1 ? limit : close + 1;
      continue;
    }
    if (ch === '>') return i;
    i += 1;
  }
  return limit;
}

/**
 * Read the function value that starts at `from`, covering `function f(){}`,
 * `(a, b) => {}`, `(a) => (<JSX/>)`, `a => expr` and their `async` forms. Returns the
 * parameter and body spans, or `null` when the value is not a function.
 */
function readFunctionValue(code, from, limit) {
  let i = skipWs(code, from, limit);
  if (code.startsWith('async', i) && !/[\w$]/.test(code[i + 5] || '')) i = skipWs(code, i + 5, limit);
  if (code[i] === '<') {
    let angle = 0;
    while (i < limit) {
      if (code[i] === '<') angle += 1;
      else if (code[i] === '>') {
        angle -= 1;
        if (angle === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    i = skipWs(code, i, limit);
  }
  if (code.startsWith('function', i) && !/[\w$]/.test(code[i + 8] || '')) {
    let j = skipWs(code, i + 8, limit);
    if (code[j] === '*') j = skipWs(code, j + 1, limit);
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(code.slice(j, Math.min(limit, j + 120)));
    if (nameMatch) j = skipWs(code, j + nameMatch[0].length, limit);
    if (code[j] !== '(') return null;
    const parenClose = matchBalanced(code, j);
    if (parenClose === -1) return null;
    const bodyOpen = findBodyOpen(code, parenClose + 1, limit);
    if (bodyOpen === -1) return null;
    const bodyClose = matchBalanced(code, bodyOpen);
    if (bodyClose === -1) return null;
    return { parenOpen: j, parenClose, bodyStart: bodyOpen + 1, bodyEnd: bodyClose, block: true };
  }

  let parenOpen = -1;
  let parenClose = -1;
  let afterParams = -1;
  if (code[i] === '(') {
    parenOpen = i;
    parenClose = matchBalanced(code, i);
    if (parenClose === -1) return null;
    afterParams = parenClose + 1;
  } else {
    const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, Math.min(limit, i + 120)));
    if (!ident) return null;
    parenOpen = i;
    parenClose = i + ident[0].length;
    afterParams = parenClose;
  }

  let j = afterParams;
  const window = code.slice(j, Math.min(limit, j + 300));
  const arrowAt = window.indexOf('=>');
  if (arrowAt === -1) return null;
  const between = window.slice(0, arrowAt);
  if (!/^\s*(?::[^;{}=]*)?$/.test(between)) return null;
  j = skipWs(code, j + arrowAt + 2, limit);

  if (code[j] === '{') {
    const bodyClose = matchBalanced(code, j);
    if (bodyClose === -1) return null;
    return { parenOpen, parenClose, bodyStart: j + 1, bodyEnd: bodyClose, block: true };
  }
  if (code[j] === '(') {
    const bodyClose = matchBalanced(code, j);
    if (bodyClose === -1) return null;
    return { parenOpen, parenClose, bodyStart: j + 1, bodyEnd: bodyClose, block: false };
  }
  const end = statementEndAt(code, j, limit);
  if (end <= j) return null;
  return { parenOpen, parenClose, bodyStart: j, bodyEnd: end, block: false };
}

/** Strip HOC wrappers off `connect(map, creators)(withRouter(injectIntl(X)))`. */
function unwrapComponent(text, depth = 0) {
  const trimmed = String(text || '').trim();
  if (trimmed === '' || depth > 6) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  const call = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/.exec(trimmed);
  if (!call) return null;
  const parenOpen = trimmed.indexOf('(', call[1].length);
  const parenClose = matchBalanced(trimmed, parenOpen);
  if (parenClose === -1) return null;
  const inner = trimmed.slice(parenOpen + 1, parenClose);
  const parts = splitArgs(inner);
  const name = call[1].replace(/\s+/g, '');
  if (parts.length === 0) return null;
  if (HOC_WRAPPERS.has(name) || parts.length === 1) return unwrapComponent(parts[0].text, depth + 1);
  return unwrapComponent(parts[parts.length - 1].text, depth + 1);
}

/** `cartItemFooter.tsx` -> `CartItemFooter`: the bucket a module's loose functions sit in. */
function moduleBucketName(relPath) {
  const stem = basename(relPath).replace(/\.[cm]?[jt]sx?$/, '');
  const cleaned = stem.replace(/[^A-Za-z0-9]+(.)/g, (_all, ch) => ch.toUpperCase());
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Every name this file imports, mapped to the module it comes from. `importedAs` receives
 * the name the module exports it under wherever that is not the local name itself:
 * `default` for a default import, `A` for `{ A as B }`, `*` for a namespace import.
 */
function collectImports(code, importedAs = new Map()) {
  const imports = new Map();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(code))) {
    const clause = m[1];
    const specifier = m[3];
    const braceOpen = clause.indexOf('{');
    const head = braceOpen === -1 ? clause : clause.slice(0, braceOpen);
    const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(head);
    if (defaultName) {
      imports.set(defaultName[1], specifier);
      importedAs.set(defaultName[1], 'default');
    }
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) {
      imports.set(namespace[1], specifier);
      importedAs.set(namespace[1], '*');
    }
    if (braceOpen !== -1) {
      const braceClose = clause.indexOf('}', braceOpen);
      const named = clause.slice(braceOpen + 1, braceClose === -1 ? clause.length : braceClose);
      for (const raw of named.split(',')) {
        const part = raw.trim();
        if (part === '') continue;
        const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
        if (aliased) {
          imports.set(aliased[2], specifier);
          importedAs.set(aliased[2], aliased[1]);
        } else if (/^[A-Za-z_$][\w$]*$/.test(part)) imports.set(part, specifier);
      }
    }
  }
  return imports;
}

/** Top-level `const NAME = "literal"` values, the fallback for a URL held in module scope. */
function collectModuleConsts(code, masked, depths) {
  const consts = new Map();
  BINDING_DECL_RE.lastIndex = 0;
  let m;
  while ((m = BINDING_DECL_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const valueStart = m.index + m[0].length;
    const end = statementEndAt(code, valueStart, code.length);
    consts.set(m[1], code.slice(valueStart, end).trim());
  }
  return consts;
}

/** Every top-level declaration that carries a function value, plus every class. */
function collectTopLevel(code, masked, depths) {
  const decls = [];
  const seen = new Set();

  CLASS_DECL_RE.lastIndex = 0;
  let m;
  while ((m = CLASS_DECL_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const bodyOpen = findBodyOpen(code, m.index + m[0].length, code.length);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalanced(code, bodyOpen);
    if (bodyClose === -1) continue;
    decls.push({
      kind: 'class',
      name: m[1],
      base: m[2] || '',
      nameIndex: m.index,
      namePos: m.index + m[0].indexOf(m[1]),
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose,
      block: true,
      exported: isExportedAt(masked, m.index),
    });
    seen.add(m.index);
  }

  FUNCTION_DECL_RE.lastIndex = 0;
  while ((m = FUNCTION_DECL_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const value = readFunctionValue(code, m.index, code.length);
    if (!value) continue;
    decls.push({
      kind: 'function',
      name: m[1],
      nameIndex: m.index,
      namePos: m.index + m[0].indexOf(m[1]),
      ...value,
      exported: isExportedAt(masked, m.index),
    });
  }

  BINDING_DECL_RE.lastIndex = 0;
  while ((m = BINDING_DECL_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const valueStart = m.index + m[0].length;
    const value = readFunctionValue(code, valueStart, code.length);
    const exported = isExportedAt(masked, m.index);
    if (value) {
      decls.push({
        kind: 'function',
        name: m[1],
        nameIndex: m.index,
        namePos: m.index + m[0].indexOf(m[1]),
        ...value,
        exported,
      });
      continue;
    }
    const statementEnd = statementEndAt(code, valueStart, code.length);
    const valueText = code.slice(valueStart, statementEnd).trim();
    const lazy = /^(?:React\s*\.\s*)?lazy\s*\(/.exec(valueText);
    if (lazy) {
      const specifier = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(valueText);
      decls.push({
        kind: 'lazy',
        name: m[1],
        nameIndex: m.index,
        bodyStart: valueStart,
        bodyEnd: statementEnd,
        block: false,
        lazy: specifier ? specifier[2] : '',
        exported,
      });
      continue;
    }
    const wrapped =
      /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/.test(valueText) &&
      /^[A-Z]/.test(m[1]) &&
      !UPPER_CONST_RE.test(m[1]);
    if (wrapped) {
      decls.push({
        kind: 'wrapper',
        name: m[1],
        nameIndex: m.index,
        namePos: m.index + m[0].indexOf(m[1]),
        bodyStart: valueStart,
        bodyEnd: statementEnd,
        block: false,
        wraps: unwrapComponent(valueText),
        exported,
      });
    }
  }

  decls.sort((a, b) => a.nameIndex - b.nameIndex);
  return decls.filter((decl) => !seen.has(decl.nameIndex) || decl.kind === 'class');
}

/**
 * Every identifier a top-level wrapper call hands to a HOC: the inner name of
 * a default-exported `withCartObserver(cartNoticeBody)` wrapper, or of
 * `const ViewCount = connect(null, { … })(viewCount)`. A component declared with a
 * lower-case name only becomes a component by being wrapped, so without this it reads
 * as an ordinary helper.
 */
function collectWrapperTargets(code, masked, depths, decls) {
  const targets = new Set();
  for (const decl of decls) {
    if (decl.kind === 'wrapper' && decl.wraps) targets.add(decl.wraps);
  }
  const defaultExport = /\bexport\s+default\s+(?![A-Za-z_$][\w$]*\s*;)/g;
  let m;
  while ((m = defaultExport.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const start = m.index + m[0].length;
    const end = statementEndAt(code, start, code.length);
    const inner = unwrapComponent(code.slice(start, end));
    if (inner) targets.add(inner);
  }
  const namedDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = namedDefault.exec(masked))) {
    if (depths[m.index] === 0) targets.add(m[1]);
  }
  return targets;
}

/**
 * The component a default export expression stands for: `X`, `memo(X)`, `connect(…)(X)`,
 * `withRouter(connect(…)(X))`. Unlike `unwrapComponent`, a curried call is followed into
 * its last argument list, because that is where the wrapped component is written.
 */
function defaultExportTarget(text, depth = 0) {
  const expression = String(text || '').trim().replace(/;\s*$/, '');
  if (depth > 6) return null;
  const call = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/.exec(expression);
  if (!call) return unwrapComponent(expression);
  const open = call[0].length - 1;
  const close = matchBalanced(expression, open);
  if (close === -1) return null;
  const next = skipWs(expression, close + 1, expression.length);
  if (expression[next] === '(') {
    const end = matchBalanced(expression, next);
    return end === -1 ? null : defaultExportTarget(expression.slice(next + 1, end), depth + 1);
  }
  const parts = splitArgs(expression.slice(open + 1, close));
  if (parts.length === 0) return null;
  const single = HOC_WRAPPERS.has(call[1].replace(/\s+/g, '')) || parts.length === 1;
  return defaultExportTarget((single ? parts[0] : parts[parts.length - 1]).text, depth + 1);
}

/**
 * The name this module's default export binds, or null: a default-exported function or
 * class, `export { X as default }`, or the component a default export expression wraps.
 * A default import of the module renders that name whatever the importer calls it locally.
 */
function defaultExportName(code, masked, depths) {
  const forms = [
    /\bexport\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class)\s*(?!extends\b)([A-Za-z_$][\w$]*)/g,
    /\bexport\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b/g,
  ];
  let m;
  for (const form of forms) {
    while ((m = form.exec(masked))) if (depths[m.index] === 0) return m[1];
  }
  const expression = /\bexport\s+default\s+(?!(?:abstract\s+|async\s+)*(?:function|class)\b)/g;
  while ((m = expression.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const start = m.index + m[0].length;
    return defaultExportTarget(code.slice(start, statementEndAt(code, start, code.length)));
  }
  return null;
}

function isExportedAt(masked, index) {
  const back = masked.slice(Math.max(0, index - 40), index);
  return /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(back);
}

/**
 * Every name this module exports a top-level binding under, keyed by the binding: its own
 * name for `export function A`, `export const A` or `export class A`, and each name of an
 * `export { A, B as C }` list. A list re-exported `from` another module names none of this
 * module's bindings. `defaultExportName` finds the default export in its other forms.
 */
function collectNamedExports(masked, depths, components) {
  const exports = new Map();
  const add = (local, name) => exports.set(local, [...(exports.get(local) || []), name]);
  for (const component of components) {
    const back = masked.slice(Math.max(0, component.nameIndex - 40), component.nameIndex);
    if (/\bexport\s+(?:abstract\s+)?(?:async\s+)?$/.test(back)) add(component.name, component.name);
  }
  const list = /\bexport\s*\{([^}]*)\}/g;
  let m;
  while ((m = list.exec(masked))) {
    if (depths[m.index] !== 0 || /^\s*from\b/.test(masked.slice(m.index + m[0].length))) continue;
    for (const raw of m[1].split(',')) {
      const pair = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(raw.trim());
      if (pair) add(pair[1], pair[2] || pair[1]);
    }
  }
  return exports;
}

/** Members of one scope: declarations sitting directly inside it, one nesting level down. */
function collectMembers(code, masked, depths, scope, owner, componentNames, out, depth = 0) {
  if (depth > 3) return;
  const target = depths[scope.bodyStart];
  const found = [];

  const scan = (re, isBinding) => {
    re.lastIndex = scope.bodyStart;
    let m;
    while ((m = re.exec(masked)) && m.index < scope.bodyEnd) {
      if (depths[m.index] !== target) continue;
      const valueStart = isBinding ? m.index + m[0].length : m.index;
      const value = readFunctionValue(code, valueStart, scope.bodyEnd);
      if (!value) continue;
      found.push({ name: m[1], nameIndex: m.index, namePos: m.index + m[0].indexOf(m[1]), ...value });
    }
  };
  scan(FUNCTION_DECL_RE, false);
  scan(BINDING_DECL_RE, true);
  if (scope.classBody) {
    scanClassMembers(code, masked, depths, scope, target, found);
    scanClassFields(code, masked, depths, scope, target, found);
  }

  found.sort((a, b) => a.nameIndex - b.nameIndex);
  for (const member of found) {
    if (out.some((existing) => existing.nameIndex === member.nameIndex)) continue;
    const entry = { ...member, owner };
    out.push(entry);
    const nextOwner = componentNames.has(member.name) ? member.name : owner;
    collectMembers(code, masked, depths, entry, nextOwner, componentNames, out, depth + 1);
  }
}

const CLASS_MEMBER_RE =
  /(?:^|[;}\n])[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
const CLASS_FIELD_RE =
  /(?:^|[;}\n])[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*!?\s*(?::[^=;{}]+)?=\s*/g;

/**
 * Class arrow fields — `handleSave = () => { … }` — declare handlers with no
 * parentheses after the name, so the method scan alone never sees them.
 */
function scanClassFields(code, masked, depths, scope, target, found) {
  CLASS_FIELD_RE.lastIndex = scope.bodyStart;
  let m;
  while ((m = CLASS_FIELD_RE.exec(masked)) && m.index < scope.bodyEnd) {
    const nameIndex = m.index + m[0].indexOf(m[1]);
    if (depths[nameIndex] !== target) continue;
    const value = readFunctionValue(code, m.index + m[0].length, scope.bodyEnd);
    if (!value) continue;
    if (value.bodyEnd > scope.bodyEnd) continue;
    found.push({ name: m[1], nameIndex, namePos: nameIndex, ...value });
    CLASS_FIELD_RE.lastIndex = value.bodyEnd;
  }
}

function scanClassMembers(code, masked, depths, scope, target, found) {
  CLASS_MEMBER_RE.lastIndex = scope.bodyStart;
  let m;
  while ((m = CLASS_MEMBER_RE.exec(masked)) && m.index < scope.bodyEnd) {
    const nameIndex = m.index + m[0].indexOf(m[1]);
    if (depths[nameIndex] !== target) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const bodyOpen = findBodyOpen(code, parenClose + 1, scope.bodyEnd);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalanced(code, bodyOpen);
    if (bodyClose === -1 || bodyClose > scope.bodyEnd) continue;
    found.push({
      name: m[1],
      nameIndex,
      namePos: nameIndex,
      parenOpen,
      parenClose,
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose,
      block: true,
    });
    CLASS_MEMBER_RE.lastIndex = bodyClose;
  }
}

/** The innermost span in `spans` containing `index`, or `null`. */
function innermost(spans, index) {
  let best = null;
  for (const span of spans) {
    if (index < span.bodyStart || index >= span.bodyEnd) continue;
    if (!best || span.bodyEnd - span.bodyStart < best.bodyEnd - best.bodyStart) best = span;
  }
  return best;
}

/**
 * The lifecycle callbacks a class component declares, and the trigger kind each names. The
 * kind says where React calls the method; it is not a promise about how often the body runs.
 */
const CLASS_LIFECYCLE_KINDS = new Map([
  ['componentDidMount', 'mount'],
  ['componentDidUpdate', 'update'],
  ['componentWillUnmount', 'unmount'],
]);

/** React's own hooks. A `use…` call outside this set is a hook this extractor cannot read. */
const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback',
  'useRef', 'useContext', 'useReducer', 'useImperativeHandle', 'useDebugValue', 'useId',
  'useTransition', 'useDeferredValue', 'useSyncExternalStore',
]);

const USE_EFFECT_RE = /\buseEffect\s*\(/g;
const HOOK_CALL_RE = /\b(use[A-Z][\w$]*)\s*\(/g;
const IF_STATEMENT_RE = /\bif\s*\(/g;
const CALL_IN_BLOCK_RE = /\bdispatch\s*\(|\b[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/;
const RETURN_STATEMENT_RE = /\breturn\b/g;

/**
 * The conditions gating the calls inside one entry body, in source order and deduplicated.
 * A condition counts only when the block it guards holds a call or a dispatch: an `if`
 * guarding nothing the walk can follow is not part of the entry's identity. Nesting is
 * flattened on purpose — the list says which conditions can turn a call off, not which
 * combination of them does.
 */
function guardsOf(code, masked, span) {
  const guards = [];
  IF_STATEMENT_RE.lastIndex = span.bodyStart;
  let m;
  while ((m = IF_STATEMENT_RE.exec(masked)) && m.index < span.bodyEnd) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1 || close > span.bodyEnd) continue;
    const bodyOpen = findBodyOpen(code, close + 1, span.bodyEnd);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalanced(code, bodyOpen);
    if (bodyClose === -1 || bodyClose > span.bodyEnd) continue;
    IF_STATEMENT_RE.lastIndex = close;
    if (!CALL_IN_BLOCK_RE.test(masked.slice(bodyOpen + 1, bodyClose))) continue;
    const text = code.slice(open + 1, close).replace(/\s+/g, ' ').trim();
    if (text !== '' && !guards.includes(text)) guards.push(text);
  }
  return guards;
}

/**
 * An effect callback's dependency list as written, or `undefined` when the argument is not
 * one array literal standing on its own. `[a, b]` is a list; `[]` is an empty one;
 * `[a].concat(b)` and a bare identifier are neither — a reader that took the bracketed head
 * of the first would state a list the source does not, and one that fell back to "no list
 * written" would hide a list the source does write. The caller states the second case as an
 * unread dependency list rather than as an absent one.
 */
function dependencyList(code, masked, from, limit) {
  const i = skipWs(masked, from, limit);
  if (masked[i] !== '[') return undefined;
  const close = matchBalanced(code, i);
  if (close === -1 || close >= limit) return undefined;
  const after = skipWs(masked, close + 1, limit);
  if (after !== limit && masked[after] !== ',') return undefined;
  return code
    .slice(i + 1, close)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The function an effect callback returns as its cleanup: the first top-level `return` of
 * the callback body whose value is a function. A `return` nested deeper belongs to whatever
 * enclosed it, and a body with no braces has no top-level statement to return from.
 */
function cleanupOf(code, masked, depths, body) {
  if (!body.block) return null;
  const target = depths[body.bodyStart];
  RETURN_STATEMENT_RE.lastIndex = body.bodyStart;
  let m;
  while ((m = RETURN_STATEMENT_RE.exec(masked)) && m.index < body.bodyEnd) {
    if (depths[m.index] !== target) continue;
    const value = readFunctionValue(code, m.index + 'return'.length, body.bodyEnd);
    if (!value || value.bodyEnd > body.bodyEnd) continue;
    return { index: m.index, ...value };
  }
  return null;
}

/**
 * Every way execution reaches a component: the class lifecycle methods it declares, the
 * `useEffect` callbacks it registers, the cleanup each of them returns, and any hook call
 * this extractor cannot read. Each becomes one `component_entry` fact whose identity is the
 * component, the trigger kind, the site it was written at and the conditions gating the
 * calls inside it.
 *
 * A `useEffect` callback is also registered as a synthetic member — and so is its cleanup —
 * so the dispatches, calls and gateway requests written inside it attribute to the entry
 * rather than to the component's own body. That member name is an extractor-internal key,
 * never a source identifier, which is why it is kept out of `method_span`.
 *
 * A trigger this extractor cannot read is stated rather than dropped: a callback that is an
 * identifier instead of a literal records `unresolved: dynamic-callback`, and a `use…` call
 * the module does not import from a foreign package records `unresolved: custom-hook`. A
 * foreign hook leads nowhere inside this repository, so it is not an entry at all.
 *
 * Every entry states the line *and* the column of its own trigger, and one unread hook is an
 * entry per call site: two triggers written on one line, and two calls of one unread hook,
 * are as many entries as there are places they are written at.
 */
function processComponentEntries(ctx) {
  const { code, masked, depths, lineOf, relPath, facts, components, members, imports } = ctx;
  const synthetic = [];

  for (const component of components) {
    if (component.role === 'hook') continue;
    const scope = { bodyStart: component.bodyStart, bodyEnd: component.bodyEnd };

    for (const member of members) {
      if (member.owner !== component.name) continue;
      const kind = CLASS_LIFECYCLE_KINDS.get(member.name);
      if (!kind) continue;
      facts.push(
        fact('component_entry', {
          file: relPath,
          line: lineOf(member.nameIndex),
          column: columnOf(code, member.nameIndex),
          endLine: lineOf(member.bodyEnd),
          component: component.name,
          kind,
          trigger: member.name,
          handler: null,
          guards: guardsOf(code, masked, member),
          method: member.name,
        }),
      );
    }

    if (component.kind === 'class') continue;

    USE_EFFECT_RE.lastIndex = scope.bodyStart;
    let m;
    while ((m = USE_EFFECT_RE.exec(masked)) && m.index < scope.bodyEnd) {
      const open = m.index + m[0].length - 1;
      const close = matchBalanced(code, open);
      if (close === -1 || close > scope.bodyEnd) continue;
      USE_EFFECT_RE.lastIndex = close;
      const args = splitArgs(code.slice(open + 1, close));
      const line = lineOf(m.index);
      const column = columnOf(code, m.index);
      const written = args.length > 0 ? args[0].text.trim() : '';
      const callback = args.length > 0 ? readFunctionValue(code, open + 1 + args[0].start, close) : null;
      const named = callback ? null : /^[A-Za-z_$][\w$]*$/.test(written) ? written : null;
      if (!callback && !named) {
        facts.push(
          fact('component_entry', {
            file: relPath,
            line,
            column,
            component: component.name,
            kind: 'unknown',
            trigger: 'useEffect',
            handler: null,
            guards: [],
            unresolved: 'dynamic-callback',
          }),
        );
        continue;
      }
      const written2 = args.length > 1 ? args[1].text.trim() : '';
      const deps = written2 === '' ? undefined : dependencyList(code, masked, open + 1 + args[1].start, close);
      const entry = {
        file: relPath,
        line,
        column,
        component: component.name,
        kind: 'effect',
        trigger: 'useEffect',
        handler: named,
        guards: callback ? guardsOf(code, masked, callback) : [],
      };
      if (callback) entry.endLine = lineOf(callback.bodyEnd);
      if (deps !== undefined) entry.deps = deps;
      else if (written2 !== '') entry.depsUnknown = true;
      const effectMethod = `${component.name}.useEffect@${line}:${column}`;
      if (callback) entry.method = effectMethod;
      facts.push(fact('component_entry', entry));
      if (!callback) continue;
      synthetic.push({
        name: effectMethod,
        owner: component.name,
        nameIndex: m.index,
        bodyStart: callback.bodyStart,
        bodyEnd: callback.bodyEnd,
        synthetic: true,
      });

      const cleanup = cleanupOf(code, masked, depths, callback);
      if (cleanup) {
        const cleanupLine = lineOf(cleanup.index);
        const cleanupColumn = columnOf(code, cleanup.index);
        const cleanupMethod = `${component.name}.useEffectCleanup@${cleanupLine}:${cleanupColumn}`;
        facts.push(
          fact('component_entry', {
            file: relPath,
            line: cleanupLine,
            column: cleanupColumn,
            endLine: lineOf(cleanup.bodyEnd),
            component: component.name,
            kind: 'cleanup',
            trigger: 'useEffect',
            handler: null,
            guards: guardsOf(code, masked, cleanup),
            method: cleanupMethod,
          }),
        );
        synthetic.push({
          name: cleanupMethod,
          owner: component.name,
          nameIndex: cleanup.index,
          bodyStart: cleanup.bodyStart,
          bodyEnd: cleanup.bodyEnd,
          synthetic: true,
        });
      }
    }

    HOOK_CALL_RE.lastIndex = scope.bodyStart;
    while ((m = HOOK_CALL_RE.exec(masked)) && m.index < scope.bodyEnd) {
      const name = m[1];
      if (REACT_HOOKS.has(name) || name === component.name) continue;
      const source = imports.get(name);
      if (source !== undefined && FOREIGN_MODULE_RE.test(source)) continue;
      facts.push(
        fact('component_entry', {
          file: relPath,
          line: lineOf(m.index),
          column: columnOf(code, m.index),
          component: component.name,
          kind: 'unknown',
          trigger: name,
          handler: null,
          guards: [],
          unresolved: 'custom-hook',
        }),
      );
    }
  }

  return synthetic;
}

/** Per-file extraction. */

function processFile(repoRoot, absPath, state) {
  const raw = readFileSync(absPath, 'utf8');
  const code = blankComments(raw);
  const masked = maskLiterals(code);
  const depths = computeDepths(code);
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);
  const { facts } = state;

  if (state.mountSegments) {
    NAVIGATE_RE.lastIndex = 0;
    let navigation;
    while ((navigation = NAVIGATE_RE.exec(code))) {
      const segment = navigation[2];
      state.mountSegments.set(segment, (state.mountSegments.get(segment) || 0) + 1);
    }
  }

  const importedAs = new Map();
  const imports = collectImports(code, importedAs);
  const defaultExport = defaultExportName(code, masked, depths);
  const moduleConsts = collectModuleConsts(code, masked, depths);
  const decls = collectTopLevel(code, masked, depths);
  const bindings = collectConnectBindings(code, masked, depths);
  const wrapperTargets = collectWrapperTargets(code, masked, depths, decls);
  const components = classifyComponents(code, decls, bindings, wrapperTargets, relPath);
  const bucket = primaryBucket(masked, components, bindings, relPath);
  const namedExports = collectNamedExports(masked, depths, components);
  const componentSpans = components.map((component) => ({
    name: component.name,
    bodyStart: component.bodyStart,
    bodyEnd: component.bodyEnd,
  }));
  for (const component of components) {
    state.componentNames.add(component.name);
    const entry = fact('component', {
      file: relPath,
      line: lineOf(component.nameIndex),
      name: component.name,
      selector: component.name,
      role: component.role,
    });
    if (component.lazy) entry.lazy = component.lazy;
    const exported = new Set(namedExports.get(component.name));
    if (component.name === defaultExport) exported.add('default');
    entry.exports = [...exported];
    facts.push(entry);
    state.componentFacts.push(entry);
  }

  const propNames = new Set();
  const propTargets = new Map();
  for (const binding of bindings) {
    for (const pair of binding.pairs) {
      propNames.add(pair.prop);
      propTargets.set(pair.prop, pair.target);
      facts.push(
        fact('props_bind', {
          file: relPath,
          line: lineOf(pair.index),
          component: binding.component,
          prop: pair.prop,
          target: pair.target,
        }),
      );
    }
  }

  const members = [];
  const componentNameSet = new Set(components.map((component) => component.name));
  for (const decl of decls) {
    if (decl.kind === 'lazy' || decl.kind === 'wrapper') continue;
    const owner = decl.kind === 'class' ? decl.name : componentNameSet.has(decl.name) ? decl.name : bucket;
    if (decl.kind === 'class') {
      collectMembers(code, masked, depths, { ...decl, classBody: true }, owner, componentNameSet, members);
    } else {
      members.push({ ...decl, owner: componentNameSet.has(decl.name) ? decl.name : bucket });
      collectMembers(code, masked, depths, decl, owner, componentNameSet, members);
    }
  }
  members.sort((a, b) => a.nameIndex - b.nameIndex);

  const syntheticMembers = processComponentEntries({
    code, masked, depths, lineOf, relPath, facts, components, members, imports,
  });
  members.push(...syntheticMembers);

  const declarationSites = new Set(members.flatMap((member) => [member.nameIndex, member.namePos]));
  const memberNamesByOwner = new Map();
  for (const member of members) {
    if (!memberNamesByOwner.has(member.owner)) memberNamesByOwner.set(member.owner, new Set());
    memberNamesByOwner.get(member.owner).add(member.name);
  }

  for (const member of members) {
    if (member.synthetic) continue;
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineOf(member.nameIndex),
        endLine: lineOf(member.bodyEnd),
        class: member.owner,
        method: member.name,
      }),
    );
  }

  const ctx = {
    code,
    masked,
    depths,
    relPath,
    lineOf,
    facts,
    members,
    componentSpans,
    bucket,
    imports,
    importedAs,
    moduleConsts,
    propNames,
    propTargets,
    declarationSites,
    memberNamesByOwner,
  };

  collectRouteTargets(ctx, state.routeTargets);
  processRenders(ctx, state.pendingRenders);
  processTemplateHandlers(ctx);
  processMethodCalls(ctx);
  ctx.continuations = collectPromiseContinuations(ctx);
  processDispatches(ctx);
  const gatewayLines = processGatewayCalls(ctx);
  if (EFFECT_PATH_RE.test(relPath)) {
    processActionDefs(ctx, decls, masked);
    processEffectHandlers(ctx, decls, gatewayLines, bucket);
  }
}

/**
 * The name loose top-level functions belong to. A module with a component belongs to that
 * component — the connected one first, then the default export, then the first declared —
 * so a handler and the helper it calls land in the same bucket and the walk joins them
 * in-file. A module with no component (an actions or reducers file) belongs to its own
 * name, so `beacons.tsx` reads as `Beacons`.
 */
function primaryBucket(masked, components, bindings, relPath) {
  if (bindings.length > 0 && bindings[0].component) return bindings[0].component;
  const byName = new Map(components.map((component) => [component.name, component]));
  const named = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/.exec(masked);
  if (named && byName.has(named[1])) return named[1];
  const exported = components.find((component) => component.exported);
  if (exported) return exported.name;
  if (components.length > 0) return components[0].name;
  return moduleBucketName(relPath);
}

/**
 * A declaration is a component when it is a class extending `Component`, a lazy or memo
 * wrapper, or an upper-case-named function whose body holds JSX. `use…` names are hooks.
 */
function classifyComponents(code, decls, bindings, wrapperTargets, relPath) {
  const connected = new Set(bindings.map((binding) => binding.component).filter(Boolean));
  const out = [];
  for (const decl of decls) {
    const isHook = /^use[A-Z]/.test(decl.name);
    let isComponent = false;
    if (decl.kind === 'class') isComponent = /(^|\.)(Pure)?Component$/.test(decl.base);
    else if (decl.kind === 'lazy' || decl.kind === 'wrapper') isComponent = /^[A-Z]/.test(decl.name);
    else if (isHook) isComponent = true;
    else if (/^[A-Z]/.test(decl.name) || connected.has(decl.name) || wrapperTargets.has(decl.name)) {
      isComponent = JSX_BODY_RE.test(code.slice(decl.bodyStart, decl.bodyEnd));
    }
    if (!isComponent) continue;
    let role = 'component';
    if (isHook) role = 'hook';
    else if (connected.has(decl.name) || /(^|\/)containers(\/|$)/.test(relPath)) role = 'container';
    out.push({ ...decl, role });
  }
  return out;
}

function collectRouteTargets(ctx, routeTargets) {
  const { code, masked } = ctx;
  ROUTE_TAG_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_TAG_RE.exec(masked))) {
    const end = jsxTagEnd(code, m.index + m[0].length, code.length);
    const attrs = code.slice(m.index, end);
    let path = '';
    const stringPath = /\bpath\s*=\s*(['"])([^'"]*)\1/.exec(attrs);
    if (stringPath) path = stringPath[2];
    else {
      const bracePath = /\bpath\s*=\s*\{/.exec(attrs);
      if (bracePath) {
        const braceIndex = m.index + bracePath.index + bracePath[0].length - 1;
        const close = matchBalanced(code, braceIndex);
        if (close !== -1) {
          const literal = fullLiteral(code.slice(braceIndex + 1, close).trim());
          if (literal !== null) path = flattenInterpolations(literal).text;
        }
      }
    }
    const targets = [];
    const elementAttr = /\belement\s*=\s*\{/.exec(attrs);
    if (elementAttr) {
      const braceIndex = m.index + elementAttr.index + elementAttr[0].length - 1;
      const close = matchBalanced(code, braceIndex);
      if (close !== -1) {
        const inner = code.slice(braceIndex + 1, close);
        const tag = /<([A-Z][A-Za-z0-9_]*)/.exec(inner);
        if (tag) targets.push(tag[1]);
      }
    }
    const componentAttr = /\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(attrs);
    if (componentAttr) targets.push(componentAttr[1]);
    for (const target of targets) {
      if (!routeTargets.has(target) || (path && !routeTargets.get(target))) routeTargets.set(target, path);
    }
  }
}

/** The component a source offset belongs to: enclosing component, else member owner. */
function ownerAt(ctx, index) {
  const component = innermost(ctx.componentSpans, index);
  if (component) return component.name;
  const member = innermost(ctx.members, index);
  if (member) return member.owner;
  return ctx.bucket;
}

function memberAt(ctx, index) {
  const member = innermost(ctx.members, index);
  return member ? member.name : ctx.bucket;
}

function processRenders(ctx, pendingRenders) {
  const { code, masked, relPath, lineOf, facts, imports, importedAs } = ctx;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(masked))) {
    const previous = m.index > 0 ? code[m.index - 1] : ' ';
    if (/[A-Za-z0-9_$]/.test(previous)) continue;
    const tag = m[1];
    if (RENDERS_BLACKLIST.has(tag)) continue;
    const from = ownerAt(ctx, m.index);
    if (from === tag) continue;
    const entry = fact('renders', { file: relPath, line: lineOf(m.index), from, to: tag });
    // The rendered component is the one this file's import names, not whichever file declares
    // the tag: the tag is only the local name, and two files may declare it.
    if (imports && imports.has(tag)) {
      entry.source = imports.get(tag);
      if (importedAs.get(tag) === '*') {
        TAG_MEMBER_RE.lastIndex = m.index + m[0].length;
        const member = TAG_MEMBER_RE.exec(code);
        if (member) entry.imported = member[1];
      } else if (importedAs.has(tag)) entry.imported = importedAs.get(tag);
    }
    facts.push(entry);
    pendingRenders.push({ entry, to: tag });
  }
}

const HANDLER_CALL_RE = /(?:\bthis\s*\.\s*)?(?:\bprops\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
const HANDLER_SKIP = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'new', 'await', 'catch', 'function',
  'preventDefault', 'stopPropagation', 'stopImmediatePropagation', 'log', 'warn', 'error',
]);

/**
 * The four shapes a JSX handler attribute takes: a bare or `this.` reference (`ref`), a
 * `this.props.x` reference (`prop`), an arrow that calls something (`inline`) and an arrow
 * that does not (`assign`).
 */
function classifyHandler(valueText) {
  let text = String(valueText || '').trim();
  while (text.startsWith('(') && matchBalanced(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  if (text === '') return null;

  const propRef = /^(?:this\s*\.\s*)?props\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(text);
  if (propRef) return { kind: 'prop', handler: propRef[1] };
  const thisRef = /^this\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(text);
  if (thisRef) return { kind: 'ref', handler: thisRef[1] };
  const bareRef = /^([A-Za-z_$][\w$]*)$/.exec(text);
  if (bareRef) return { kind: 'ref', handler: bareRef[1] };
  const bound = /^(?:this\s*\.\s*)?(?:(props)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*bind\s*\(/.exec(text);
  if (bound) return { kind: bound[1] ? 'prop' : 'ref', handler: bound[2] };

  const isArrow = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/.test(text);
  if (isArrow) {
    const arrowAt = text.indexOf('=>');
    const body = text.slice(arrowAt + 2);
    HANDLER_CALL_RE.lastIndex = 0;
    let call;
    while ((call = HANDLER_CALL_RE.exec(body))) {
      const name = call[1];
      if (HANDLER_SKIP.has(name)) continue;
      return { kind: 'inline', handler: name };
    }
    const assigned = /(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*=\s*(?!=|>)/.exec(body);
    if (assigned) return { kind: 'assign', handler: assigned[1] };
    const ident = /([A-Za-z_$][\w$]*)/.exec(body);
    return { kind: 'assign', handler: ident ? ident[1] : '*' };
  }

  const member = /([A-Za-z_$][\w$]*)\s*$/.exec(text);
  if (member) return { kind: 'ref', handler: member[1] };
  return null;
}

function processTemplateHandlers(ctx) {
  const { code, masked, relPath, lineOf, facts } = ctx;
  HANDLER_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = HANDLER_ATTR_RE.exec(masked))) {
    const braceIndex = m.index + m[0].length - 1;
    const close = matchBalanced(code, braceIndex);
    if (close === -1) continue;
    HANDLER_ATTR_RE.lastIndex = close;
    const event = m[0].slice(0, m[0].indexOf('=')).trim();
    const classified = classifyHandler(code.slice(braceIndex + 1, close));
    if (!classified) continue;
    facts.push(
      fact('template_handler', {
        file: relPath,
        line: lineOf(m.index),
        column: columnOf(code, m.index),
        component: ownerAt(ctx, m.index),
        event,
        handler: classified.handler,
        kind: classified.kind,
      }),
    );
  }
}

function processMethodCalls(ctx) {
  const { masked, relPath, lineOf, facts, imports, propNames, declarationSites, memberNamesByOwner } = ctx;
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(masked))) {
    const chain = m[1].replace(/\s+/g, '');
    const parts = chain.split('.');
    const called = parts[parts.length - 1];
    if (called === 'dispatch' || CALLEE_DENYLIST.has(called)) continue;
    if (declarationSites.has(m.index)) continue;

    const member = innermost(ctx.members, m.index);
    const owner = member ? member.owner : ctx.bucket;
    const method = member ? member.name : ctx.bucket;
    const siblings = memberNamesByOwner.get(owner) || new Set();

    let field = null;
    if (parts.length === 1) {
      if (propNames.has(called)) continue;
      if (siblings.has(called)) field = 'this';
      else if (imports.has(called) && !FOREIGN_MODULE_RE.test(imports.get(called))) field = IMPORT_KEYWORD;
      else continue;
    } else {
      const receiver = parts.slice(0, -1).join('.');
      if (receiver === 'this' || receiver === 'self') {
        if (!siblings.has(called)) continue;
        field = 'this';
      } else if (receiver === 'props' || receiver === 'this.props') {
        if (propNames.has(called)) continue;
        field = 'props';
      } else {
        const root = parts[0];
        if (root === GATEWAY_OBJECT) continue;
        if (!imports.has(root) || FOREIGN_MODULE_RE.test(imports.get(root))) continue;
        field = root;
      }
    }
    facts.push(
      fact('method_call', {
        file: relPath,
        line: lineOf(m.index),
        class: owner,
        method,
        field,
        calledMethod: called,
      }),
    );
  }
}

/** The action a `dispatch(...)` argument names: a creator call, or a literal `type`. */
function dispatchActionOf(argText) {
  const text = String(argText || '').trim();
  if (text.startsWith('{')) {
    const typeMatch = /\btype\s*:\s*/.exec(text);
    if (!typeMatch) return null;
    const rest = text.slice(typeMatch.index + typeMatch[0].length).trim();
    const literal = /^(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(rest);
    if (literal) return literal[2];
    const ident = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/.exec(rest);
    if (!ident) return null;
    return ident[1].split('.').pop().trim();
  }
  const path = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]*>\s*)?\(/.exec(text);
  if (!path) return null;
  const name = path[1].split('.').pop().trim();
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

const PROPS_CALL_RE = /(?:\bthis\s*\.\s*)?\bprops\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const BARE_CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

function processDispatches(ctx) {
  const { code, masked, relPath, lineOf, facts, propNames, propTargets, memberNamesByOwner } = ctx;
  const continuations = ctx.continuations || [];

  /**
   * The dispatch's own site, plus — when it is written inside a response handler chained
   * onto a gateway call — the request that handler answers and which way it settled. The
   * reader that took the second for an ordering of two sibling statements would be stating
   * a relation the source does not.
   */
  const siteOf = (index) => {
    const continuation = continuationAt(continuations, index);
    return continuation
      ? { continuesFile: continuation.file, continuesLine: continuation.line, outcome: continuation.outcome }
      : {};
  };

  DISPATCH_RE.lastIndex = 0;
  let m;
  while ((m = DISPATCH_RE.exec(masked))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    DISPATCH_RE.lastIndex = parenClose;
    const parts = splitArgs(code.slice(parenOpen + 1, parenClose));
    const action = parts.length > 0 ? dispatchActionOf(parts[0].text) : null;
    if (!action) continue;
    const member = innermost(ctx.members, m.index);
    facts.push(
      fact('action_dispatch', {
        file: relPath,
        line: lineOf(m.index),
        column: columnOf(code, m.index),
        class: member ? member.owner : ctx.bucket,
        method: member ? member.name : ctx.bucket,
        action,
        ...siteOf(m.index),
      }),
    );
  }

  if (propNames.size === 0) return;

  const emit = (index, name) => {
    const member = innermost(ctx.members, index);
    facts.push(
      fact('action_dispatch', {
        file: relPath,
        line: lineOf(index),
        column: columnOf(code, index),
        class: member ? member.owner : ctx.bucket,
        method: member ? member.name : ctx.bucket,
        action: propTargets.get(name) || name,
        ...siteOf(index),
      }),
    );
  };

  PROPS_CALL_RE.lastIndex = 0;
  const seen = new Set();
  while ((m = PROPS_CALL_RE.exec(masked))) {
    if (!propNames.has(m[1])) continue;
    seen.add(m.index);
    emit(m.index, m[1]);
  }

  BARE_CALL_RE.lastIndex = 0;
  while ((m = BARE_CALL_RE.exec(masked))) {
    const name = m[1];
    if (!propNames.has(name)) continue;
    if (ctx.declarationSites.has(m.index)) continue;
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/[.\w$]\s*$/.test(before)) continue;
    const member = innermost(ctx.members, m.index);
    const owner = member ? member.owner : ctx.bucket;
    if ((memberNamesByOwner.get(owner) || new Set()).has(name)) continue;
    emit(m.index, name);
  }
}

/** Scope-aware resolution of a gateway call's first argument. */
function resolveUrlArgument(argText, resolveCtx, depth = 0) {
  const trimmed = String(argText || '').trim();
  if (depth > 4) return { template: bestPartial(trimmed), resolved: false };
  if (trimmed.length === 0) return { template: '*', resolved: false };

  const literal = fullLiteral(trimmed);
  if (literal !== null) return { template: literal, resolved: true };

  const plusParts = splitPlus(trimmed);
  if (plusParts.length > 1) {
    let template = '';
    let allResolved = true;
    for (const part of plusParts) {
      const piece = resolveUrlArgument(part, resolveCtx, depth + 1);
      template += piece.template;
      if (!piece.resolved) allResolved = false;
    }
    return { template, resolved: allResolved };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const local = findLocalConst(resolveCtx, trimmed);
    if (local !== null) return resolveUrlArgument(local, resolveCtx, depth + 1);
    const moduleConst = resolveCtx.moduleConsts.get(trimmed);
    if (moduleConst !== undefined) return resolveUrlArgument(moduleConst, resolveCtx, depth + 1);
    return { template: `\${${trimmed}}`, resolved: false };
  }

  return { template: bestPartial(trimmed), resolved: false };
}

/**
 * One `httpClient.getGatewayClient().<verb>(url)` call, located: the member it is written
 * in, the argument list's braces. Returns null when the match is not one whole gateway call.
 * Both the fact-emitting pass and the promise-continuation pass read a call through this, so
 * the two never disagree about where a call's argument list ends.
 */
function locateGatewayCall(ctx, m) {
  const { code } = ctx;
  const factoryOpen = m.index + m[0].length - 1;
  const factoryClose = matchBalanced(code, factoryOpen);
  if (factoryClose === -1) return null;

  let pos = skipWs(code, factoryClose + 1, code.length);
  let verb = null;
  if (code[pos] === '.') {
    pos = skipWs(code, pos + 1, code.length);
    const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(pos, pos + 40));
    if (!ident) return null;
    if (!GATEWAY_VERBS.has(ident[0].toLowerCase())) return null;
    verb = ident[0].toUpperCase();
    pos = skipWs(code, pos + ident[0].length, code.length);
  } else if (code[pos] === '[') {
    const close = matchBalanced(code, pos);
    if (close === -1) return null;
    verb = '*';
    pos = skipWs(code, close + 1, code.length);
  } else {
    return null;
  }
  if (code[pos] === '<') {
    let angle = 0;
    while (pos < code.length) {
      if (code[pos] === '<') angle += 1;
      else if (code[pos] === '>') {
        angle -= 1;
        if (angle === 0) {
          pos += 1;
          break;
        }
      }
      pos += 1;
    }
    pos = skipWs(code, pos, code.length);
  }
  if (code[pos] !== '(') return null;
  const argsClose = matchBalanced(code, pos);
  if (argsClose === -1) return null;
  return { argsOpen: pos, argsClose, verb, member: innermost(ctx.members, m.index) };
}

/**
 * What answers a gateway call's response: each callback chained onto the call with `.then`
 * or `.catch`, as the span its body covers and the outcome it handles. Only the two-argument
 * form of `.then` distinguishes its own rejection handler; a `.finally` callback answers
 * neither outcome and is left out rather than filed under one.
 */
function promiseContinuations(code, call) {
  const out = [];
  let pos = skipWs(code, call.argsClose + 1, code.length);
  while (code[pos] === '.') {
    const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(pos + 1, pos + 40));
    if (!ident) break;
    const name = ident[0];
    if (name !== 'then' && name !== 'catch') break;
    const argsOpen = skipWs(code, pos + 1 + name.length, code.length);
    if (code[argsOpen] !== '(') break;
    const argsClose = matchBalanced(code, argsOpen);
    if (argsClose === -1) break;
    const args = splitArgs(code.slice(argsOpen + 1, argsClose));
    args.forEach((arg, position) => {
      const outcome = name === 'catch' || position > 0 ? 'failure' : 'success';
      if (name === 'then' && position > 1) return;
      if (name === 'catch' && position > 0) return;
      const body = readFunctionValue(code, argsOpen + 1 + arg.start, argsClose);
      if (!body) return;
      out.push({ start: body.bodyStart, end: body.bodyEnd, outcome });
    });
    pos = skipWs(code, argsClose + 1, code.length);
  }
  return out;
}

/**
 * Every response handler the module writes on a gateway call, with the site of the call it
 * answers. A dispatch written inside one of them runs when that request settles, which is a
 * relation the source states — not one the reader may infer from two statements sharing a
 * method body.
 */
function collectPromiseContinuations(ctx) {
  const { code, masked, lineOf } = ctx;
  const out = [];
  GATEWAY_CALL_RE.lastIndex = 0;
  let m;
  while ((m = GATEWAY_CALL_RE.exec(masked))) {
    const call = locateGatewayCall(ctx, m);
    if (!call) continue;
    const line = lineOf(m.index);
    for (const continuation of promiseContinuations(code, call)) {
      out.push({ ...continuation, file: ctx.relPath, line });
    }
  }
  return out;
}

/**
 * The innermost continuation a dispatch at `index` is written inside, or null. A callback
 * written as an expression — `() => dispatch(…)` — has a body of one expression, so its
 * braces are inclusive on both ends.
 */
function continuationAt(continuations, index) {
  let best = null;
  for (const continuation of continuations) {
    if (index < continuation.start || index > continuation.end) continue;
    if (!best || continuation.end - continuation.start < best.end - best.start) best = continuation;
  }
  return best;
}

function processGatewayCalls(ctx) {
  const { code, masked, relPath, lineOf, facts, moduleConsts } = ctx;
  const lines = [];
  GATEWAY_CALL_RE.lastIndex = 0;
  let m;
  while ((m = GATEWAY_CALL_RE.exec(masked))) {
    const call = locateGatewayCall(ctx, m);
    if (!call) continue;
    const { argsOpen, argsClose, verb, member } = call;
    const argParts = splitArgs(code.slice(argsOpen + 1, argsClose));
    const firstArg = argParts.length > 0 ? argParts[0].text : '';

    const resolveCtx = {
      fileText: code,
      memberBodyStart: member ? member.bodyStart : 0,
      callIndex: m.index,
      moduleConsts,
    };
    let resolved;
    try {
      resolved = resolveUrlArgument(firstArg, resolveCtx);
    } catch {
      resolved = { template: '*', resolved: false };
    }
    const flattened = flattenInterpolations(resolved.template);
    const line = lineOf(m.index);
    lines.push(line);
    facts.push(
      fact('gateway_call', {
        file: relPath,
        line,
        service: GATEWAY_SERVICE,
        method: member ? member.name : ctx.bucket,
        verb,
        template: flattened.text,
        resolved: resolved.resolved && !flattened.collapsed,
      }),
    );
  }
  return lines;
}

/**
 * Every exported creator in an actions or services module. `UPPER_CASE` exports are
 * reducer action *types*, not creators, so they are excluded.
 */
function processActionDefs(ctx, decls, masked) {
  const { relPath, lineOf, facts } = ctx;
  const seen = new Set();
  for (const decl of decls) {
    if (!decl.exported) continue;
    if (UPPER_CONST_RE.test(decl.name)) continue;
    if (seen.has(decl.name)) continue;
    seen.add(decl.name);
    facts.push(fact('action_def', { file: relPath, line: lineOf(decl.nameIndex), action: decl.name }));
  }
  const exportedConst = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:!)?\s*(?::[^=;]*?)?=/g;
  let m;
  while ((m = exportedConst.exec(masked))) {
    const name = m[1];
    if (UPPER_CONST_RE.test(name) || seen.has(name)) continue;
    if (ctx.depths[m.index] !== 0) continue;
    seen.add(name);
    facts.push(fact('action_def', { file: relPath, line: lineOf(m.index), action: name }));
  }
}

/** A creator whose span holds a gateway call is the effect — there is no effects tier. */
function processEffectHandlers(ctx, decls, gatewayLines, bucket) {
  if (gatewayLines.length === 0) return;
  const { relPath, lineOf, facts } = ctx;
  for (const decl of decls) {
    if (!decl.exported) continue;
    if (UPPER_CONST_RE.test(decl.name)) continue;
    const startLine = lineOf(decl.nameIndex);
    const endLine = lineOf(decl.bodyEnd);
    if (!gatewayLines.some((line) => line >= startLine && line <= endLine)) continue;
    facts.push(
      fact('effect_handler', {
        file: relPath,
        line: startLine,
        endLine,
        class: bucket,
        field: decl.name,
        actions: [decl.name],
      }),
    );
  }
}

/** `connect(mapStateToProps, { addCartItem, removeCartItem })(withRouter(injectIntl(X)))`. */
function collectConnectBindings(code, masked, depths) {
  const bindings = [];
  CONNECT_RE.lastIndex = 0;
  let m;
  while ((m = CONNECT_RE.exec(masked))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    CONNECT_RE.lastIndex = parenClose;

    let component = null;
    const after = skipWs(code, parenClose + 1, code.length);
    if (code[after] === '(') {
      const wrapClose = matchBalanced(code, after);
      if (wrapClose !== -1) component = unwrapComponent(code.slice(after + 1, wrapClose));
    }
    if (!component) continue;

    const args = splitArgs(code.slice(parenOpen + 1, parenClose));
    const pairs = [];
    if (args.length >= 2 && args[1].text.startsWith('{')) {
      const objectStart = code.indexOf('{', parenOpen + 1 + args[1].start);
      const objectEnd = objectStart === -1 ? -1 : matchBalanced(code, objectStart);
      if (objectEnd !== -1) {
        for (const part of splitArgs(code.slice(objectStart + 1, objectEnd))) {
          const text = part.text;
          if (text.startsWith('...')) continue;
          const keyed = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(text);
          const index = skipWs(code, objectStart + 1 + part.start, objectEnd);
          if (keyed) {
            const target = /([A-Za-z_$][\w$]*)\s*$/.exec(keyed[2].trim());
            pairs.push({ prop: keyed[1], target: target ? target[1] : keyed[1], index });
            continue;
          }
          if (/^[A-Za-z_$][\w$]*$/.test(text)) pairs.push({ prop: text, target: text, index });
        }
      }
    }
    bindings.push({ component, pairs, index: m.index, topLevel: depths[m.index] === 0 });
  }
  return bindings;
}
