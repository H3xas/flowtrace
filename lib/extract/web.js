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
import { normalizeRoute } from '../normalize.js';
import { buildWebControl } from './control-web.js';
import { keepCarriedJoinTasks } from '../control-evidence.js';
import { extract as extractCypressRemainder } from './web-cypress.js';
import { callerDecisions } from './caller-decisions.js';
import { clientFacts, jsxRegion } from './client-conditions.js';
import { buildTraceIndex } from '../trace.js';
import { renderTarget } from '../render-target.js';
import {
  arrayRouteFacts, collectImportBindings, jsxIdentifierPasses, mountFacts,
  resolveModule, routeFacts,
} from './web-routes.js';
import {
  bestPartial,
  blankComments,
  escapeRegExp,
  computeDepths,
  findLocalConst,
  flattenInterpolations,
  fullLiteral,
  makeLineFinder,
  maskLiterals,
  matchBalanced,
  skipString,
  skipTemplate,
  splitArgs,
  splitPlus,
  substituteInterpolations,
  toRelative,
  wholeLiteralClose,
} from './text.js';

/** Source subdirectory walked by default; a repository entry may override it. */
const DEFAULT_SRC_SUBPATH = 'src';

/**
 * A `.js` or `.jsx` file is read with the rules of `.ts` and `.tsx`: a React client written in
 * plain JavaScript uses the same idioms, only without the types.
 */
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

const DEFAULT_EXCLUDE = [
  'node_modules',
  'dist',
  '__tests__',
  '__snapshots__',
  '__mocks__',
  '*.d.ts',
  '*.spec.ts',
  '*.spec.tsx',
  '*.spec.js',
  '*.spec.jsx',
  '*.test.ts',
  '*.test.tsx',
  '*.test.js',
  '*.test.jsx',
  '*.stories.ts',
  '*.stories.tsx',
  '*.stories.js',
  '*.stories.jsx',
  '*.pw.ts',
  '*.cy.ts',
  '*.cy.tsx',
  '*.cy.js',
  '*.cy.jsx',
];

/** Plain JavaScript has no type syntax to tell JSX apart from, so a `.js` file may hold JSX. */
function mayHoldJsx(relPath) {
  return /\.(?:tsx|jsx|js)$/.test(relPath);
}

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
  const navigateSites = new Map();
  const defaultExports = new Map();
  const pendingDefaults = [];
  const literalConsts = new Map();
  const computedConsts = new Map();
  const propPasses = [];
  const pendingArrayRoutes = [];
  const httpClients = Array.isArray(options.httpClients) ? options.httpClients : [];
  const clientRegions = [];

  for (const absPath of walk(srcRoot, { extensions: SOURCE_EXTENSIONS, exclude })) {
    try {
      processFile(repoRoot, absPath, {
        facts, routeTargets, pendingRenders, componentFacts, componentNames, mountSegments,
        navigateSites, defaultExports, pendingDefaults, literalConsts, computedConsts, propPasses,
        pendingArrayRoutes, httpClients, clientRegions,
      });
    } catch {
      continueExtraction();
    }
  }

  for (const pending of pendingDefaults) {
    const name = defaultExports.get(pending.file);
    if (name) pending.entry[pending.field] = name;
  }

  // Route arrays are read after the whole walk, because the array one `.map` renders may be
  // declared or passed from another file, and every file's constants and prop sites are
  // collected by then. An entry feeds the same page-role bookkeeping a `<Route>` does.
  const arrayLookup = routeArrayLookup(repoRoot, { literalConsts, computedConsts, propPasses, defaultExports, componentFacts });
  for (const descriptor of pendingArrayRoutes) {
    for (const entry of arrayRouteFacts(descriptor, arrayLookup)) {
      facts.push(entry);
      if (entry.element && !entry.unsupported && entry.redirect === undefined) {
        // An entry with a module and no declared name is a default import that no default
        // export of that module settles, as a barrel that re-exports it.
        const key = entry.elementFile
          ? importedTargetKey(entry.elementFile, entry.elementName ? null : 'default', entry.elementName || null, entry.element)
          : entry.element;
        addRouteTarget(routeTargets, key, entry.path);
      }
    }
  }

  const prefix = inferredMountPrefix(mountSegments);
  if (prefix) {
    const site = navigateSites.get(prefix);
    facts.push(
      fact('page_mount', {
        file: site.file,
        line: site.line,
        path: prefix,
        source: 'inferred',
        evidence: mountSegments.get(prefix),
      }),
    );
  }
  for (const { entry, path } of routePages(componentFacts, routeTargets, reExportReader(repoRoot))) {
    entry.role = 'page';
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

  facts.push(...webClientFacts(facts, clientRegions));
  return keepCarriedJoinTasks(facts);
}

function continueExtraction() {}

/**
 * A route target the file imports: the component the module `file` exports as `exported`, or
 * declares as `name` when the reader already settled the export. `tag` is the local name, kept
 * for the key only: the target is the component the module chain gives, or none.
 */
function importedTargetKey(file, exported, name, tag) {
  return JSON.stringify([file, exported, name, tag]);
}

/** The first path a target is routed under wins over a later bare mention of it. */
function addRouteTarget(routeTargets, key, path) {
  if (!routeTargets.has(key) || (path && !routeTargets.get(key))) routeTargets.set(key, path);
}

/**
 * Each component a route renders, with the path of its route. A target named by its local tag
 * marks every component of that name, as before. A target the file imports marks only the
 * component its module exports under that name, through the re-exports of a barrel module, so
 * an alias or a second module that declares the same name is never taken for it. A target the
 * chain does not reach marks nothing, because a name match in another module is a guess.
 */
function routePages(componentFacts, routeTargets, reExports) {
  const byName = new Map();
  const imported = [];
  for (const [key, path] of routeTargets) {
    if (key.startsWith('[')) imported.push({ target: JSON.parse(key), path });
    else byName.set(key, path);
  }
  const candidates = componentFacts.filter((entry) => entry.role !== 'hook');
  const matches = (entry, [file, exported, name]) =>
    entry.file === file && (exported !== null ? (entry.exports || []).includes(exported) : entry.name === name);
  const hits = new Map();
  const reached = ([file, exported, name]) => {
    const direct = candidates.filter((entry) => matches(entry, [file, exported, name]));
    if (direct.length > 0 || exported === null) return direct;
    const seen = new Set();
    let frontier = [[file, exported]];
    for (let depth = 0; depth < RE_EXPORT_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const [from, as] of frontier) {
        for (const link of reExports(from, as)) {
          const step = `${link.file}\u0000${link.exported}`;
          if (seen.has(step)) continue;
          seen.add(step);
          const found = candidates.filter((entry) => matches(entry, [link.file, link.exported, null]));
          if (found.length > 0) return found;
          next.push([link.file, link.exported]);
        }
      }
      frontier = next;
    }
    return [];
  };
  for (const { target, path } of imported) {
    for (const entry of reached(target)) if (!hits.has(entry) || (path && !hits.get(entry))) hits.set(entry, path);
  }
  for (const entry of candidates) {
    if (!byName.has(entry.name)) continue;
    const path = byName.get(entry.name);
    if (!hits.has(entry) || (path && !hits.get(entry))) hits.set(entry, path);
  }
  return candidates.filter((entry) => hits.has(entry)).map((entry) => ({ entry, path: hits.get(entry) }));
}

/** How many barrel modules a route target is followed through before it counts as unresolved. */
const RE_EXPORT_DEPTH = 8;

/** `export { a, b as c } from '<module>'`, `export * from '<module>'` and `export { a, b as c }`. */
const RE_EXPORT_RE = /\bexport\s+(?:\*(?!\s*as\b)|\{([^}]*)\})\s*(?:from\s*(['"])([^'"\n]+)\2)?/g;

/**
 * Reads the re-exports of a module file: `(file, exported)` gives each `{ file, exported }` that
 * the module exports under the name `exported` from another module, directly or through a
 * name it imports. The file text is read once per file.
 */
function reExportReader(repoRoot) {
  const byFile = new Map();
  const linksOf = (file) => {
    if (byFile.has(file)) return byFile.get(file);
    let code = null;
    try {
      code = blankComments(readFileSync(joinPath(repoRoot, ...String(file).split('/')), 'utf8'));
    } catch {
      code = null;
    }
    const links = [];
    if (code !== null) {
      const imports = collectImportBindings(code);
      RE_EXPORT_RE.lastIndex = 0;
      let m;
      while ((m = RE_EXPORT_RE.exec(code))) {
        const specifier = m[3];
        if (m[1] === undefined) {
          if (specifier) links.push({ as: '*', specifier, imported: '*' });
          continue;
        }
        for (const part of m[1].split(',')) {
          const names = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
          if (!names[0]) continue;
          const local = names[0].trim();
          const as = (names[1] || names[0]).trim();
          if (specifier) links.push({ as, specifier, imported: local });
          else {
            const binding = imports.get(local);
            if (binding && binding.imported !== '*') links.push({ as, specifier: binding.specifier, imported: binding.imported });
          }
        }
      }
    }
    byFile.set(file, links);
    return links;
  };
  return (file, exported) => {
    const out = [];
    for (const link of linksOf(file)) {
      if (link.as !== '*' && link.as !== exported) continue;
      if (link.as === '*' && exported === 'default') continue;
      const target = resolveModule(repoRoot, file, link.specifier);
      if (target) out.push({ file: target, exported: link.as === '*' ? exported : link.imported });
    }
    return out;
  };
}

/** The key a route element tag names: the import it comes from, else its local name. */
function routeTargetKey(ctx, tag) {
  const binding = ctx.importBindings.get(tag);
  if (!binding || binding.imported === '*') return tag;
  const file = resolveModule(ctx.repoRoot, ctx.relPath, binding.specifier);
  return file ? importedTargetKey(file, binding.imported, null, tag) : tag;
}

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
 * End of the statement starting at `start`: a top-level `;` or the end of the scope. With
 * `lineEnd`, a top-level line break ends it too, for source that leaves its semicolons out.
 */
function statementEndAt(code, start, limit, lineEnd = false) {
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
    if (lineEnd && ch === '\n' && depth === 0) return i;
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

  // A curried creator, `(id) => (dispatch) => {…}`, returns its thunk: the inner arrow is the
  // body, or the span ends at the inner parameter list and the thunk falls out of the creator.
  if (code[j] !== '{') {
    const inner = readFunctionValue(code, j, limit);
    if (inner) return { parenOpen, parenClose, bodyStart: j, bodyEnd: inner.block ? inner.bodyEnd + 1 : inner.bodyEnd, block: false };
  }
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

/**
 * The component a wrapper expression stands for: `X`, `memo(X)`, `connect(a, b)(X)`,
 * `withRouter(connect(a, b)(X))`, `compose(a, b)(X)` or `f(a)(b)(X)`. A curried call writes the
 * wrapped component in its last argument group, so that group is the one followed. A call with
 * one group follows its only argument, or the last one of a call that is not a known wrapper.
 */
function unwrapComponent(text, depth = 0) {
  const trimmed = String(text || '').trim().replace(/;\s*$/, '');
  if (trimmed === '' || depth > 6) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  const call = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/.exec(trimmed);
  if (!call) return null;
  const groups = [];
  let open = call[0].length - 1;
  while (trimmed[open] === '(') {
    const close = matchBalanced(trimmed, open);
    if (close === -1) return null;
    groups.push(trimmed.slice(open + 1, close));
    open = skipWs(trimmed, close + 1, trimmed.length);
  }
  const parts = splitArgs(groups[groups.length - 1]);
  if (parts.length === 0) return null;
  const name = call[1].replace(/\s+/g, '');
  const first = groups.length === 1 && (HOC_WRAPPERS.has(name) || parts.length === 1);
  return unwrapComponent((first ? parts[0] : parts[parts.length - 1]).text, depth + 1);
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

/**
 * Module-level constants split into the ones whose value is an array or object literal, with
 * the site they were written at, and the names of the rest. A route array, and a constant
 * object spread into one, is read from the first set; a name in the second is a value the
 * reader will not run, so a route built from one is named unsupported rather than guessed.
 */
function collectLiteralConsts(code, masked, depths, lineOf, relPath) {
  const literals = [];
  const computed = [];
  BINDING_DECL_RE.lastIndex = 0;
  let m;
  while ((m = BINDING_DECL_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const at = skipWs(code, m.index + m[0].length, code.length);
    if (code[at] !== '[' && code[at] !== '{') {
      computed.push(m[1]);
      continue;
    }
    const end = statementEndAt(code, at, code.length);
    const text = code.slice(at, end).trim();
    // A literal that is only the start of a longer expression is a computed value: keeping it
    // in the literal set would let a reader report its first operand as the whole declaration.
    if (wholeLiteralClose(text) === -1) {
      computed.push(m[1]);
      continue;
    }
    literals.push({
      name: m[1],
      text,
      file: relPath,
      line: lineOf(at),
      column: at - code.lastIndexOf('\n', at - 1),
    });
  }
  return { literals, computed };
}

/**
 * The cross-file answers one route array needs: a module constant by file and name, the JSX
 * sites that pass a bare identifier as a prop, and the import bindings of any file (read on
 * demand, because the array one `.map` renders may live in another module).
 */
function routeArrayLookup(repoRoot, state) {
  const bindings = new Map();
  const declaredIn = new Map();
  for (const component of state.componentFacts || []) {
    if (!declaredIn.has(component.name)) declaredIn.set(component.name, new Set());
    declaredIn.get(component.name).add(component.file);
  }
  const bindingsOf = (file) => {
    if (!bindings.has(file)) {
      let code = null;
      try {
        code = readFileSync(joinPath(repoRoot, ...String(file).split('/')), 'utf8');
      } catch {
        code = null;
      }
      bindings.set(file, code === null ? new Map() : collectImportBindings(code));
    }
    return bindings.get(file);
  };
  return {
    constant: (file, name) => (state.literalConsts.get(file) || new Map()).get(name) || null,
    declaredConstant: (file, name) => (state.computedConsts.get(file) || new Set()).has(name),
    /**
     * The sites that pass `prop` to the component `component` declared in `ownerFile`: a
     * same-named component elsewhere in the repository is a different component, so a site
     * that renders one of those supplies nothing here.
     */
    propPasses: (component, prop, ownerFile) => state.propPasses.filter((pass) => {
      if (pass.component !== component || pass.prop !== prop) return false;
      if (!ownerFile || pass.file === ownerFile) return true;
      const binding = bindingsOf(pass.file).get(component);
      const target = binding ? resolveModule(repoRoot, pass.file, binding.specifier) : null;
      if (target) return target === ownerFile;
      const declared = declaredIn.get(component);
      return !declared || declared.size === 1;
    }),
    importBinding: (file, name) => bindingsOf(file).get(name) || null,
    moduleFor: (file, specifier) => resolveModule(repoRoot, file, specifier),
    defaultExport: (file) => state.defaultExports.get(file) || null,
    importedConstant(file, name) {
      const binding = bindingsOf(file).get(name);
      if (!binding || binding.imported === '*') return null;
      const target = resolveModule(repoRoot, file, binding.specifier);
      if (!target) return null;
      if (binding.imported === 'default') return { file: target, name: state.defaultExports.get(target) || name };
      return { file: target, name: binding.imported };
    },
  };
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
 * Each module-level `const X = { ... }` with its brace span. Its function-valued entries are
 * the methods of an object that stands in for a class, as a service or client module exports.
 * The literal stays out of `collectTopLevel`, so it is never a component candidate.
 */
function collectObjectLiterals(code, masked, depths) {
  const found = [];
  OBJECT_CONST_RE.lastIndex = 0;
  let m;
  while ((m = OBJECT_CONST_RE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open);
    if (close === -1) continue;
    found.push({ name: m[1], bodyStart: open + 1, bodyEnd: close });
    OBJECT_CONST_RE.lastIndex = close;
  }
  return found;
}

/** A type annotation can hold `=>`, so the `=` of the value is the one a `{` follows. */
const OBJECT_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^;{]*?)?=\s*\{/g;

const OBJECT_METHOD_RE = /^(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/;
const OBJECT_PROPERTY_RE = /^([A-Za-z_$][\w$]*)\s*:\s*/;

/** The offset of the first token at or after `index`, past white space and comments. */
function skipWsAndComments(code, index, limit) {
  let i = skipWs(code, index, limit);
  while (i < limit && code[i] === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
    const end = code[i + 1] === '/' ? code.indexOf('\n', i) : code.indexOf('*/', i + 2);
    i = skipWs(code, end === -1 ? limit : code[i + 1] === '/' ? end : end + 2, limit);
  }
  return i;
}

/**
 * The function-valued entries at the top level of one object literal: a method shorthand,
 * or a property whose value is an arrow or a function expression. A spread, a computed key
 * and a nested literal name no method a caller can reach by the literal's name.
 */
function objectLiteralMembers(code, literal) {
  const members = [];
  const parts = splitArgs(code.slice(literal.bodyStart, literal.bodyEnd));
  for (const part of parts) {
    const start = skipWsAndComments(code, literal.bodyStart + part.start, literal.bodyEnd);
    const rawStart = literal.bodyStart + part.start;
    const lead = /^\s*/.exec(code.slice(rawStart, literal.bodyEnd))[0].length;
    const end = rawStart + lead + part.text.length;
    const head = code.slice(start, Math.min(end, start + 200));
    const method = OBJECT_METHOD_RE.exec(head);
    if (method) {
      const parenOpen = start + method[0].length - 1;
      const parenClose = matchBalanced(code, parenOpen);
      if (parenClose === -1 || parenClose > end) continue;
      const bodyOpen = findBodyOpen(code, parenClose + 1, end);
      if (bodyOpen === -1) continue;
      const bodyClose = matchBalanced(code, bodyOpen);
      if (bodyClose === -1 || bodyClose > end) continue;
      members.push({
        name: method[1], nameIndex: start, namePos: start, parenOpen, parenClose,
        bodyStart: bodyOpen + 1, bodyEnd: bodyClose, block: true,
      });
      continue;
    }
    const property = OBJECT_PROPERTY_RE.exec(head);
    if (!property) continue;
    const value = readFunctionValue(code, start + property[0].length, end);
    if (value) members.push({ name: property[1], nameIndex: start, namePos: start, ...value });
  }
  return members;
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
 * One export list's own value entries, as `[local, exported]`: empty when the list forwards
 * another module's bindings or the statement marks it type-only, and null when an entry is
 * not a plain identifier, optionally `as`-aliased. A `type` marker on an entry removes that
 * entry alone. An unreadable entry leaves the whole declaration unproven, because a name it
 * lists is no evidence of a local value export without a shape this reader can trust.
 */
function localExportEntries(masked, openBrace, closeBrace, typeOnly) {
  if (typeOnly) return [];
  const after = skipWs(masked, closeBrace + 1, masked.length);
  if (/^from\b/.test(masked.slice(after))) return [];
  const entries = [];
  for (const raw of masked.slice(openBrace + 1, closeBrace).split(',')) {
    const text = raw.trim();
    if (text === '') continue;
    const entry = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(text);
    if (!entry) return null;
    if (!entry[1]) entries.push([entry[2], entry[3] || entry[2]]);
  }
  return entries;
}

/** Every value entry of every export list this module writes itself, in file order. */
function collectLocalExportEntries(masked, depths) {
  const lists = [];
  const list = /\bexport\s*(?:type\s+)?\{/g;
  let m;
  while ((m = list.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(masked, open);
    if (close === -1) continue;
    const entries = localExportEntries(masked, open, close, /type\s+\{$/.test(m[0]));
    if (!entries) continue;
    lists.push(...entries);
    list.lastIndex = close + 1;
  }
  return lists;
}

/**
 * The name this module's default export binds, or null: a default-exported function or
 * class, a local `export { X as default }`, or the component a default export expression
 * wraps. A default import of the module renders that name whatever the importer calls it
 * locally.
 */
function defaultBindingName(code, masked, depths) {
  const declaration = /\bexport\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class)\s*(?!extends\b)([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declaration.exec(masked))) if (depths[m.index] === 0) return m[1];
  const listed = collectLocalExportEntries(masked, depths).find(([, exported]) => exported === 'default');
  if (listed) return listed[0];
  const expression = /\bexport\s+default\s+(?!(?:abstract\s+|async\s+)*(?:function|class)\b)/g;
  while ((m = expression.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const start = m.index + m[0].length;
    return (
      unwrapComponent(code.slice(start, statementEndAt(code, start, code.length, true))) ||
      unwrapComponent(code.slice(start, statementEndAt(code, start, code.length)))
    );
  }
  return null;
}

function isExportedAt(masked, index) {
  const back = masked.slice(Math.max(0, index - 40), index);
  return /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(back);
}

/**
 * Every name this module exports a top-level binding under, keyed by the binding: its own
 * name for `export function A`, `export const A` or `export class A`, and each value name of
 * an `export { A, B as C }` list. A list re-exported `from` another module, a type-only list
 * and a `type` entry name none of this module's values. `defaultBindingName` finds the
 * default export in its other forms.
 */
function collectNamedExports(masked, depths, components) {
  const exports = new Map();
  const add = (local, name) => exports.set(local, [...(exports.get(local) || []), name]);
  for (const component of components) {
    const back = masked.slice(Math.max(0, component.nameIndex - 40), component.nameIndex);
    if (/\bexport\s+(?:abstract\s+)?(?:async\s+)?$/.test(back)) add(component.name, component.name);
  }
  for (const [local, exported] of collectLocalExportEntries(masked, depths)) add(local, exported);
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

const ARROW_RE = /=>/g;
const FUNCTION_KEYWORD_RE = /\bfunction\b/g;
const ARROW_NAME_RE = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?::[^;{}()=]*)?=\s*$/;

/** The open bracket that `close` in `text` closes, or -1. */
function matchBack(text, close) {
  const open = text[close] === ')' ? '(' : '[';
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (text[i] === text[close]) depth += 1;
    else if (text[i] === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where the arrow whose `=>` is at `arrowAt` starts: its parameters, or `async` before them. */
function arrowStart(masked, arrowAt) {
  const before = masked.slice(Math.max(0, arrowAt - 300), arrowAt);
  const offset = arrowAt - before.length;
  let start = -1;
  const typed = /\)\s*:\s*[^;{}()=]*$/.exec(before);
  const trimmed = before.trimEnd();
  if (typed) start = matchBack(masked, offset + typed.index);
  else if (trimmed.endsWith(')')) start = matchBack(masked, offset + trimmed.length - 1);
  else {
    const ident = /[A-Za-z_$][\w$]*$/.exec(trimmed);
    if (ident) start = offset + ident.index;
  }
  if (start <= 0) return start;
  const lead = /\basync\s*$/.exec(masked.slice(Math.max(0, start - 40), start));
  return lead ? start - lead[0].length : start;
}

/** Whether the `function` keyword at `index` starts an expression, not a declaration. */
function isFunctionExpression(masked, index) {
  const before = masked.slice(Math.max(0, index - 40), index).replace(/\basync\s*$/, '').trimEnd();
  if (/(?:^|[^\w$])return$/.test(before)) return true;
  const last = before[before.length - 1];
  if (last === '{') return before.slice(0, -1).trimEnd().endsWith('=');
  return last !== undefined && '=(,:?[|&!'.includes(last);
}

/**
 * Every arrow and function expression of a file, with its body span and what its value is
 * bound to: a local name (`const f = () => …`, `f = () => …`, a class field), or the JSX
 * `on*` attribute whose site its `template_handler` fact states. The walk joins a dispatch
 * inside an attribute-bound arrow to that handler, and names a name-bound one.
 */
function collectArrows(code, masked, lineOf) {
  const attributes = new Map();
  HANDLER_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = HANDLER_ATTR_RE.exec(masked))) {
    const valueAt = skipWs(code, m.index + m[0].length, code.length);
    const event = m[0].slice(0, m[0].indexOf('=')).trim();
    attributes.set(valueAt, { name: event, line: lineOf(m.index), column: columnOf(code, m.index) });
  }
  const starts = new Set();
  ARROW_RE.lastIndex = 0;
  while ((m = ARROW_RE.exec(masked))) {
    const start = arrowStart(masked, m.index);
    if (start >= 0) starts.add(start);
  }
  FUNCTION_KEYWORD_RE.lastIndex = 0;
  while ((m = FUNCTION_KEYWORD_RE.exec(masked))) {
    if (!isFunctionExpression(masked, m.index)) continue;
    const lead = /\basync\s*$/.exec(masked.slice(Math.max(0, m.index - 40), m.index));
    starts.add(lead ? m.index - lead[0].length : m.index);
  }
  const arrows = [];
  for (const start of starts) {
    const value = readFunctionValue(code, start, code.length);
    if (!value) continue;
    const named = ARROW_NAME_RE.exec(masked.slice(Math.max(0, start - 200), start));
    const attribute = attributes.get(start);
    arrows.push({
      bodyStart: value.bodyStart,
      bodyEnd: value.bodyEnd,
      arrow: {
        line: lineOf(start),
        column: columnOf(code, start),
        ...(named && !attribute ? { name: named[1] } : {}),
        ...(attribute ? { attribute } : {}),
      },
    });
  }
  return arrows;
}

/** The `arrow` field of a fact written at `index`: the innermost arrow that holds it. */
function arrowField(ctx, index) {
  if (!ctx.arrows) return {};
  const holder = innermost(ctx.arrows, index);
  return holder ? { arrow: holder.arrow } : {};
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
      if (state.navigateSites && !state.navigateSites.has(segment)) {
        state.navigateSites.set(segment, { file: relPath, line: lineOf(navigation.index) });
      }
    }
  }

  const importedAs = new Map();
  const imports = collectImports(code, importedAs);
  const defaultExport = defaultBindingName(code, masked, depths);
  const moduleConsts = collectModuleConsts(code, masked, depths);
  if (state.literalConsts) {
    const consts = collectLiteralConsts(code, masked, depths, lineOf, relPath);
    if (consts.literals.length > 0) {
      if (!state.literalConsts.has(relPath)) state.literalConsts.set(relPath, new Map());
      for (const constant of consts.literals) state.literalConsts.get(relPath).set(constant.name, constant);
    }
    if (consts.computed.length > 0) state.computedConsts.set(relPath, new Set(consts.computed));
    state.propPasses.push(...jsxIdentifierPasses({ code, masked, lineOf, relPath, tagEnd: jsxTagEnd }));
  }
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
    if (component.lazy) {
      entry.lazy = component.lazy;
      const lazyFile = resolveModule(repoRoot, relPath, component.lazy);
      if (lazyFile) {
        entry.lazyFile = lazyFile;
        if (state.pendingDefaults) state.pendingDefaults.push({ entry, field: 'lazyName', file: lazyFile });
      }
    }
    const exported = new Set(namedExports.get(component.name));
    if (component.name === defaultExport) exported.add('default');
    entry.exports = [...exported];
    facts.push(entry);
    state.componentFacts.push(entry);
    if (state.clientRegions) state.clientRegions.push({ entry, component, relPath, code });
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
  // A bare call in an object literal member binds to the module declaration of that name,
  // never to a property of the object, so it lands on the span the file gives the function.
  const literalOwners = new Set();
  const moduleFunctionOwners = new Map();
  for (const decl of decls) {
    if (decl.kind === 'function' && !moduleFunctionOwners.has(decl.name)) {
      moduleFunctionOwners.set(decl.name, componentNameSet.has(decl.name) ? decl.name : bucket);
    }
  }
  for (const literal of collectObjectLiterals(code, masked, depths)) {
    literalOwners.add(literal.name);
    for (const member of objectLiteralMembers(code, literal)) {
      const entry = { ...member, owner: literal.name };
      members.push(entry);
      collectMembers(code, masked, depths, entry, literal.name, componentNameSet, members);
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
  facts.push(
    ...callerDecisions({
      code,
      spans: members
        .filter((member) => !member.synthetic)
        .map((member) => ({ bodyStart: member.bodyStart, bodyEnd: member.bodyEnd, class: member.owner, method: member.name })),
      relPath,
      lineOf,
      jsx: mayHoldJsx(relPath),
    }),
  );

  // A call outside every component and member is filed under the module body, so the
  // module is the span that holds it.
  const control = buildWebControl(code, masked, lineOf, [
    ...components.map((component) => ({ start: component.bodyStart, end: component.bodyEnd })),
    ...members.map((entry) => ({ start: entry.bodyStart, end: entry.bodyEnd })),
    { start: 0, end: code.length, module: true },
  ]);

  const ctx = {
    repoRoot,
    importBindings: collectImportBindings(code),
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
    functions: decls,
    defaultExport,
    propNames,
    propTargets,
    declarationSites,
    memberNamesByOwner,
    literalOwners,
    moduleFunctionOwners,
    arrows: collectArrows(code, masked, lineOf),
    control,
  };

  collectRouteTargets(ctx, state.routeTargets);
  try {
    collectRouteDeclarations(repoRoot, ctx, decls, components, state);
  } catch {
    continueExtraction();
  }
  processRenders(ctx, state.pendingRenders);
  processTemplateHandlers(ctx);
  processMethodCalls(ctx);
  ctx.gatewayCalls = locateGatewayCalls(ctx, state.httpClients || []);
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
    for (const target of targets) addRouteTarget(routeTargets, routeTargetKey(ctx, target), path);
  }
}

/**
 * `page_route` and `page_mount` facts for one file. A route's element resolved through a
 * default import or a lazy import names its component only once every file's default export
 * is known, so that name is filled in after the walk.
 */
function collectRouteDeclarations(repoRoot, ctx, decls, components, state) {
  if (!state.defaultExports) return;
  if (ctx.defaultExport) state.defaultExports.set(ctx.relPath, ctx.defaultExport);
  const lazyBindings = new Map();
  for (const decl of decls) {
    if (decl.kind !== 'lazy') continue;
    lazyBindings.set(decl.name, {
      line: ctx.lineOf(decl.nameIndex),
      specifier: decl.lazy,
      file: resolveModule(repoRoot, ctx.relPath, decl.lazy),
    });
  }
  const routeCtx = {
    ...ctx,
    repoRoot,
    tagEnd: jsxTagEnd,
    ownerAt: (index) => ownerAt(ctx, index),
    lazyBindings,
    pendingArrayRoutes: state.pendingArrayRoutes,
    localComponents: new Set(components.filter((component) => component.kind !== 'lazy').map((component) => component.name)),
  };
  for (const entry of routeFacts(routeCtx)) {
    if (entry.pendingDefault) {
      delete entry.pendingDefault;
      state.pendingDefaults.push({ entry, field: 'elementName', file: entry.elementFile });
    }
    ctx.facts.push(entry);
    if (entry.element && !entry.unsupported && entry.redirect === undefined) {
      addRouteTarget(state.routeTargets, routeTargetKey(ctx, entry.element), entry.path);
    }
  }
  for (const entry of mountFacts(routeCtx)) ctx.facts.push(entry);
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

const CLIENT_ROLES = new Set(['page', 'container', 'component']);

/**
 * The client condition facts of the components read in the walk. Roles are final only
 * after the walk, and a child is resolved through the same render imports as `trace`,
 * so the regions are read last, against the whole fact set.
 */
function webClientFacts(facts, pending) {
  const regions = [];
  for (const { entry, component, relPath, code } of pending) {
    if (!CLIENT_ROLES.has(entry.role)) continue;
    if (component.kind !== 'function' && component.kind !== 'class') continue;
    const input = { component: entry.name, file: relPath, code, offset: component.nameIndex };
    if (component.kind === 'class') {
      input.classBody = { bodyStart: component.bodyStart, bodyEnd: component.bodyEnd };
    } else {
      const paren = code[component.parenOpen] === '(';
      input.fn = {
        bodyStart: component.bodyStart,
        bodyEnd: component.bodyEnd,
        block: component.block,
        paramStart: paren ? component.parenOpen + 1 : component.parenOpen,
        paramEnd: component.parenClose,
      };
    }
    regions.push(jsxRegion(input));
  }
  if (regions.length === 0) return [];
  const index = buildTraceIndex([{ repo: '', kind: 'web', facts }]);
  const renders = new Map();
  for (const entry of facts) {
    if (entry.type !== 'renders') continue;
    const key = `${entry.file}|${entry.line}|${entry.from}|${entry.to}`;
    if (!renders.has(key)) renders.set(key, entry);
  }
  const resolveTarget = (region, element) => {
    const { line } = region.host.at(element.offset);
    const site = renders.get(`${region.file}|${line}|${region.component}|${element.tag}`);
    if (!site) return null;
    const found = renderTarget(index, '', site) || {};
    if (found.target && found.target.fact) {
      return { target: { file: found.target.fact.file, component: found.target.fact.name } };
    }
    if (found.candidates) {
      const name = site.imported !== undefined && site.imported !== 'default' ? site.imported : site.to;
      return { candidates: found.candidates.map((file) => ({ file, component: name })) };
    }
    return null;
  };
  return clientFacts(regions, { resolveTarget });
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
      if (name === 'dispatch') {
        // `dispatch(c(x))` runs the creator `c`, so the handler is `c`.
        const open = call.index + call[0].length - 1;
        const close = matchBalanced(body, open);
        const args = close === -1 ? [] : splitArgs(body.slice(open + 1, close));
        const action = args.length > 0 ? dispatchActionOf(args[0].text) : null;
        if (action) return { kind: 'inline', handler: action };
      }
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
    let calledClass;
    if (parts.length === 1) {
      if (propNames.has(called)) continue;
      if (ctx.literalOwners.has(owner) && ctx.moduleFunctionOwners.has(called) && !shadowedAt(ctx, called, m.index)) {
        field = 'this';
        calledClass = ctx.moduleFunctionOwners.get(called);
      } else if (siblings.has(called)) field = 'this';
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
        ...(calledClass !== undefined ? { calledClass } : {}),
        ...ctx.control(m.index),
        ...arrowField(ctx, m.index),
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
        class: member ? member.owner : ctx.bucket,
        method: member ? member.name : ctx.bucket,
        action,
        ...ctx.control(m.index),
        ...siteOf(m.index),
        ...arrowField(ctx, m.index),
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
        class: member ? member.owner : ctx.bucket,
        method: member ? member.name : ctx.bucket,
        action: propTargets.get(name) || name,
        ...ctx.control(index),
        ...siteOf(index),
        ...arrowField(ctx, index),
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

/**
 * Scope-aware resolution of a gateway call's first argument. A `${name}` inside a template
 * becomes the value of the const it names when that value is a literal, so a URL composed
 * from a route constant joins like one written out. Only the whole argument may be a call to a
 * helper of the same file: a helper inside a `+` part is one piece of a URL the reader does
 * not see whole, and it keeps the reading it had.
 */
function resolveUrlArgument(argText, resolveCtx, depth = 0, whole = true) {
  const trimmed = String(argText || '').trim();
  if (depth > 4) return { template: bestPartial(trimmed), resolved: false };
  if (trimmed.length === 0) return { template: '*', resolved: false };

  const literal = fullLiteral(trimmed);
  if (literal !== null) {
    if (trimmed[0] !== '`') return { template: literal, resolved: true };
    return {
      template: substituteInterpolations(literal, (name) => literalConstValue(name, resolveCtx, depth)),
      resolved: true,
    };
  }

  const plusParts = splitPlus(trimmed);
  if (plusParts.length > 1) {
    let template = '';
    let allResolved = true;
    for (const part of plusParts) {
      const piece = resolveUrlArgument(part, resolveCtx, depth + 1, false);
      template += piece.template;
      if (!piece.resolved) allResolved = false;
    }
    return { template, resolved: allResolved };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const local = findLocalConst(resolveCtx, trimmed);
    if (local !== null) return resolveUrlArgument(local, resolveCtx, depth + 1, whole);
    const moduleConst = resolveCtx.moduleConsts.get(trimmed);
    if (moduleConst !== undefined) return resolveUrlArgument(moduleConst, resolveCtx, depth + 1, whole);
    return { template: `\${${trimmed}}`, resolved: false };
  }

  if (whole) {
    const returned = resolveHelperReturn(trimmed, resolveCtx, depth);
    if (returned) return returned;
  }

  return { template: bestPartial(trimmed), resolved: false };
}

/**
 * The text a const holds when it is a literal: a string, or a template or `+` concatenation of
 * literals, with no runtime value left in it. Null for any other const or for no const.
 */
function literalConstValue(name, resolveCtx, depth) {
  const text = findLocalConst(resolveCtx, name) ?? resolveCtx.moduleConsts.get(name);
  if (text === undefined || text === null) return null;
  const value = resolveUrlArgument(text, resolveCtx, depth + 1, false);
  if (!value.resolved || value.template.includes('${')) return null;
  return value.template;
}

/**
 * The URL a call to a function of the same file returns, read from its return expressions in
 * the scope of its body. Returns that differ share the text up to their last common `/`, which
 * the trailing `*` marks as a prefix. A helper whose common text starts with a runtime value
 * names no path, so it is left to the base reading rather than joined on a guess.
 */
function resolveHelperReturn(text, resolveCtx, depth) {
  const call = /^([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>\s*)?\(/.exec(text);
  if (!call || matchBalanced(text, call[0].length - 1) !== text.length - 1) return null;
  const helper = (resolveCtx.functions || []).find((decl) => decl.kind === 'function' && decl.name === call[1]);
  if (!helper) return null;
  const returns = returnExpressions(resolveCtx.fileText, resolveCtx.masked, helper);
  if (returns.length === 0) return null;
  const templates = [];
  for (const entry of returns) {
    const scope = { ...resolveCtx, memberBodyStart: helper.bodyStart, callIndex: entry.index };
    const value = resolveUrlArgument(entry.text, scope, depth + 1, false);
    if (!value.resolved) return null;
    templates.push(value.template);
  }
  const template = commonTemplate(templates);
  const head = normalizeRoute(template).split('/')[0];
  if (head === '' || head.includes('*')) return null;
  return { template, resolved: true };
}

/**
 * The expressions a function body returns: the body itself for an expression body, else each
 * `return` of the block that is not written inside a function nested in it.
 */
function returnExpressions(code, masked, fn) {
  if (!fn.block) return [{ text: code.slice(fn.bodyStart, fn.bodyEnd), index: fn.bodyStart }];
  const nested = [];
  const nestedRe = /=>\s*\{|\bfunction\b[^(]*\(/g;
  nestedRe.lastIndex = fn.bodyStart;
  let m;
  while ((m = nestedRe.exec(masked)) && m.index < fn.bodyEnd) {
    let open = m.index + m[0].length - 1;
    if (!m[0].startsWith('=>')) {
      const paramsClose = matchBalanced(code, open);
      open = paramsClose === -1 ? -1 : findBodyOpen(code, paramsClose + 1, fn.bodyEnd);
    }
    const close = open === -1 ? -1 : matchBalanced(code, open);
    if (close === -1) continue;
    nested.push([open, close]);
    nestedRe.lastIndex = close;
  }
  const out = [];
  const returnRe = /\breturn\b/g;
  returnRe.lastIndex = fn.bodyStart;
  while ((m = returnRe.exec(masked)) && m.index < fn.bodyEnd) {
    if (nested.some(([open, close]) => m.index > open && m.index < close)) continue;
    const start = m.index + m[0].length;
    const end = statementEndAt(code, start, fn.bodyEnd);
    out.push({ text: code.slice(start, end), index: m.index });
  }
  return out;
}

/**
 * The text every template starts with. When they differ, the text is cut after its last `/`
 * and ends in `*`, and the cut never splits an interpolation.
 */
function commonTemplate(templates) {
  const first = templates[0];
  if (templates.every((template) => template === first)) return first;
  let length = 0;
  while (templates.every((template) => length < template.length && template[length] === first[length])) length += 1;
  let prefix = first.slice(0, length);
  const open = prefix.lastIndexOf('${');
  if (open !== -1 && prefix.indexOf('}', open) === -1) prefix = prefix.slice(0, open);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '*' : `${prefix.slice(0, slash + 1)}*`;
}

/**
 * Every gateway call of the module, in source order: the gateway client's
 * `httpClient.getGatewayClient().<verb>(url)` and each `<receiver>.<verb>(url)` of
 * `gatewayReceivers`. Both the fact-emitting pass and the promise-continuation pass read this
 * one list, so the two never disagree about which calls exist or where an argument list ends.
 */
function locateGatewayCalls(ctx, httpClients) {
  const { code, masked } = ctx;
  const calls = [];
  GATEWAY_CALL_RE.lastIndex = 0;
  let m;
  while ((m = GATEWAY_CALL_RE.exec(masked))) {
    const factoryClose = matchBalanced(code, m.index + m[0].length - 1);
    if (factoryClose === -1) continue;
    const call = verbCallAt(ctx, factoryClose + 1, m.index);
    if (call) calls.push({ ...call, service: GATEWAY_SERVICE });
  }
  const receivers = gatewayReceivers(ctx, httpClients);
  if (receivers.any) {
    RECEIVER_CALL_RE.lastIndex = 0;
    while ((m = RECEIVER_CALL_RE.exec(masked))) {
      const field = m[1] !== undefined;
      const name = m[2];
      if (!receivers.knows(field, name, m.index)) continue;
      if (!GATEWAY_VERBS.has(m[3].toLowerCase())) continue;
      if (!field && !receivers.listed.has(name) && shadowedAt(ctx, name, m.index, receivers.sites)) continue;
      if (/\.\s*$/.test(masked.slice(Math.max(0, m.index - 40), m.index))) continue;
      const call = verbCallAt(ctx, m.index + (field ? m[1].length : 0) + name.length, m.index);
      if (call) calls.push({ ...call, service: name });
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}

/**
 * The identifier grammar of `httpClients` in the configuration load: a name the load accepts
 * must be a name the receiver readers find, `$` and non-ASCII letters included.
 */
const ID_NAME = '[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D]*';
/** No identifier character before, so a name is never read out of a longer name. */
const ID_BEFORE = '(?<![\\p{ID_Continue}$\\u200C\\u200D])';

/** `this.<name>.<verb>` or `<name>.<verb>`, read on the masked text so a literal never matches. */
const RECEIVER_CALL_RE = new RegExp(`${ID_BEFORE}(this\\s*\\.\\s*)?(${ID_NAME})\\s*\\.\\s*(${ID_NAME})`, 'gu');

/**
 * The names a module calls the backend through besides the gateway client. Bare names are the
 * local name of the default import from `axios`, a const that holds `<axios>.create(...)` and
 * each name the repository lists in `httpClients`. Field names are a class field or a
 * `this.<field> =` assignment that holds `<axios>.create(...)`, a constructor parameter
 * property typed `AxiosInstance`, and each listed name again, for `this.<name>`. A name is
 * known only from what this module writes: a receiver passed in untyped is unknown unless
 * the repository lists it.
 */
function gatewayReceivers(ctx, httpClients) {
  const { masked } = ctx;
  const model = lexicalModel(ctx);
  const whole = [[0, masked.length]];
  const listed = new Set(httpClients);
  const bare = new Map(httpClients.map((name) => [name, whole]));
  const fields = new Map(httpClients.map((name) => [name, whole]));
  const sites = new Set();
  const add = (map, name, range) => {
    if (map.get(name) === whole) return;
    map.set(name, range === whole ? whole : [...(map.get(name) || []), range]);
  };
  const axiosNames = axiosDefaultImports(ctx.code);
  for (const name of axiosNames) add(bare, name, whole);
  if (axiosNames.length > 0) {
    const created = new RegExp(
      `(?:\\b(?:const|let|var)\\s+(${ID_NAME})|\\bthis\\s*\\.\\s*(${ID_NAME})|^[ \\t]*(?:(?:private|public|protected|readonly|static)\\s+)*(${ID_NAME}))` +
        `\\s*(?::[^=;\\n]*?)?=\\s*(${axiosNames.map(escapeRegExp).join('|')})\\s*\\.\\s*create\\s*\\(`,
      'gmu',
    );
    let m;
    while ((m = created.exec(masked))) {
      const axiosAt = m.index + m[0].lastIndexOf(m[4]);
      if (shadowedAt(ctx, m[4], axiosAt)) continue;
      if (m[1]) {
        const site = m.index + /^\S+\s+/u.exec(m[0])[0].length;
        sites.add(site);
        const scope = model.scopes.find((entry) => entry.site === site && entry.names.has(m[1]));
        add(bare, m[1], scope ? [scope.start, scope.end] : whole);
      } else add(fields, m[2] || m[3], innermostRange(model.classes, m.index) || whole);
    }
  }
  const typed = new RegExp(`\\b(?:private|public|protected|readonly)\\s+(?:readonly\\s+)?(${ID_NAME})\\s*:\\s*AxiosInstance\\b`, 'gu');
  let m;
  while ((m = typed.exec(masked))) {
    if (!/\bconstructor\s*\([^)]*$/.test(masked.slice(Math.max(0, m.index - 400), m.index))) continue;
    add(fields, m[1], innermostRange(model.classes, m.index) || whole);
  }
  const within = (ranges, index) => ranges.some(([start, end]) => start <= index && index < end);
  return {
    listed,
    sites,
    knows: (field, name, index) => {
      const ranges = (field ? fields : bare).get(name);
      return ranges !== undefined && within(ranges, index);
    },
    any: bare.size + fields.size > 0,
  };
}

/**
 * The local names of the default import from `axios`, read with the identifier grammar of the
 * receiver readers: `import <name> from 'axios'`, also with named or namespace imports after it.
 */
function axiosDefaultImports(code) {
  const text = blankComments(code);
  const re = new RegExp(
    `\\bimport\\s+(${ID_NAME})\\s*(?:,\\s*(?:\\{[^}]*\\}|\\*\\s*as\\s+${ID_NAME}))?\\s*from\\s*(['"])axios\\2`,
    'gu',
  );
  const names = [];
  let m;
  while ((m = re.exec(text))) if (m[1] !== 'type') names.push(m[1]);
  return names;
}

/** The innermost `[start, end)` of `ranges` that holds `index`, or null. */
function innermostRange(ranges, index) {
  let best = null;
  for (const range of ranges) {
    if (range[0] <= index && index < range[1] && (!best || range[0] > best[0])) best = range;
  }
  return best;
}

/**
 * True when a parameter or a local declaration of a scope around `index` binds `name`, so the
 * name there is not the import or the module-level binding of that spelling. `ignoreSites`
 * holds the name offsets of declarations that are themselves the binding being read.
 */
function shadowedAt(ctx, name, index, ignoreSites) {
  return lexicalModel(ctx).scopes.some((scope) =>
    scope.start <= index && index < scope.end && scope.names.has(name) && !(ignoreSites && ignoreSites.has(scope.site)));
}

/** The scopes and class bodies of the module, read once per module. */
function lexicalModel(ctx) {
  if (!ctx.lexicalModel) ctx.lexicalModel = lexicalScopes(blankComments(ctx.masked));
  return ctx.lexicalModel;
}

/** Words that open a parenthesis and a block without binding a name in the parenthesis. */
const NON_BINDING_HEADS = new Set(['if', 'for', 'while', 'switch', 'with', 'return', 'typeof', 'await', 'yield', 'new', 'in', 'of', 'do', 'else', 'void', 'delete']);

/** Characters after which a `function` or `class` keyword starts an expression, not a declaration. */
const EXPRESSION_BEFORE = new Set(['=', '(', ',', ':', '?', '[', '!', '&', '|', '+', '-', '*', '/', '%', '<', '>', '~', '^']);

/**
 * The scopes of `text` (code with its literals and comments blanked) that bind names, and the
 * class bodies. A scope binds the parameters of a function, a method, an arrow or a `catch`;
 * each `let` or `const` declarator in its block or `for` header; each `var` declarator in its
 * function; a function or class declared inside a block; and the name of a function or class
 * expression inside that expression. A module-level declaration is the module binding itself,
 * so it is no scope here.
 */
function lexicalScopes(text) {
  const scopes = [];
  const functions = [];
  const classes = [];
  const blocks = [];
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}' && stack.length > 0) blocks.push([stack.pop(), i + 1]);
  }
  const headWord = (pos) => {
    const before = text.slice(Math.max(0, pos - 80), pos);
    const word = new RegExp(`${ID_BEFORE}(${ID_NAME})\\s*$`, 'u').exec(before);
    return word ? word[1] : null;
  };

  const forHeaders = [];
  for (let open = text.indexOf('('); open !== -1; open = text.indexOf('(', open + 1)) {
    const close = matchBalanced(text, open);
    if (close === -1) continue;
    const head = headWord(open);
    if (head === 'for' || (head === 'await' && /\bfor\s+await\s*$/.test(text.slice(Math.max(0, open - 20), open)))) {
      forHeaders.push([open, close]);
      const forBody = statementBodyAfter(text, close + 1);
      for (const decl of declarationsIn(text, open + 1, close)) {
        if (decl.kind !== 'var') scopes.push({ start: open, end: forBody, names: new Set([decl.name]), site: decl.site });
      }
      continue;
    }
    const body = functionBodyAfter(text, close + 1);
    if (!body) continue;
    if (body.block && (head === null || NON_BINDING_HEADS.has(head))) continue;
    if (head !== 'catch') functions.push([open, body.end]);
    const names = patternNames(text.slice(open + 1, close));
    if (names.length > 0) scopes.push({ start: open, end: body.end, names: new Set(names), site: -1 });
  }

  const singleArrow = new RegExp(`${ID_BEFORE}(?<!\\.\\s*)(${ID_NAME})\\s*=>`, 'gu');
  let m;
  while ((m = singleArrow.exec(text))) {
    const end = arrowBodyEnd(text, m.index + m[0].length);
    functions.push([m.index, end]);
    scopes.push({ start: m.index, end, names: new Set([m[1]]), site: -1 });
  }

  for (const decl of declarationsIn(text, 0, text.length)) {
    const header = forHeaders.find(([open, close]) => open < decl.site && decl.site < close);
    if (header && decl.kind !== 'var') continue;
    const range = decl.kind === 'var' ? innermostRange(functions, decl.site) : innermostRange(blocks, decl.site);
    if (range) scopes.push({ start: range[0], end: range[1], names: new Set([decl.name]), site: decl.site });
  }

  const declared = new RegExp(`${ID_BEFORE}(function\\b(?:\\s*\\*)?|class\\b)(?!\\s*:)(?:\\s*(${ID_NAME}))?`, 'gu');
  while ((m = declared.exec(text))) {
    const isClass = m[1] === 'class';
    const end = isClass ? classBodyEnd(text, m.index + m[0].length) : functionExpressionEnd(text, m.index + m[0].length);
    if (isClass && end !== -1) classes.push([m.index, end]);
    if (!m[2]) continue;
    const site = m.index + m[0].length - m[2].length;
    if (expressionAt(text, m.index)) {
      if (end !== -1) scopes.push({ start: m.index, end, names: new Set([m[2]]), site });
      continue;
    }
    const block = innermostRange(blocks, site);
    if (block) scopes.push({ start: block[0], end: block[1], names: new Set([m[2]]), site });
  }
  return { scopes, classes };
}

/** True when the `function` or `class` keyword at `at` starts an expression. */
function expressionAt(text, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return false;
  if (EXPRESSION_BEFORE.has(text[i])) return true;
  const word = new RegExp(`(${ID_NAME})$`, 'u').exec(text.slice(Math.max(0, i - 20), i + 1));
  if (word !== null && word[1] === 'async') return expressionAt(text, i + 1 - word[1].length);
  return word !== null && ['return', 'yield', 'await', 'typeof', 'void', 'new', 'in', 'of', 'case'].includes(word[1]);
}

/** The end of the body of a function whose parameter list follows `from`, or -1. */
function functionExpressionEnd(text, from) {
  const open = text.indexOf('(', from);
  if (open === -1 || text.slice(from, open).trim() !== '') return -1;
  const close = matchBalanced(text, open);
  if (close === -1) return -1;
  const body = functionBodyAfter(text, close + 1);
  return body ? body.end : -1;
}

/** The end of a class body that follows `from`, after an optional `extends` clause, or -1. */
function classBodyEnd(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1 || /[;}:=,]/.test(text.slice(from, open))) return -1;
  const close = matchBalanced(text, open);
  return close === -1 ? -1 : close + 1;
}

/**
 * Each name a `const`, `let` or `var` statement binds between `from` and `to`, every
 * declarator of the statement included, with the offset of the name and the keyword kind.
 */
function declarationsIn(text, from, to) {
  const found = [];
  const re = /\b(const|let|var)\s+/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    const kind = m[1] === 'var' ? 'var' : 'lexical';
    let pos = m.index + m[0].length;
    for (;;) {
      pos = skipWs(text, pos, to);
      if (text[pos] === '{' || text[pos] === '[') {
        const close = matchBalanced(text, pos);
        if (close === -1) break;
        for (const name of patternNames(text.slice(pos, close + 1))) found.push({ name, site: pos, kind });
        pos = close + 1;
      } else {
        const name = new RegExp(`^${ID_NAME}`, 'u').exec(text.slice(pos, pos + 200));
        if (!name) break;
        found.push({ name: name[0], site: pos, kind });
        pos += name[0].length;
      }
      const next = declaratorEnd(text, pos, to);
      if (next === -1) break;
      pos = next + 1;
    }
    re.lastIndex = Math.max(re.lastIndex, pos);
  }
  return found;
}

/**
 * The offset of the `,` that ends the declarator whose name ends at `from`, or -1 when the
 * statement ends first: at a `;`, a closer, an `of` or `in` of a `for` header, or a line break
 * that no `,` follows or comes before.
 */
function declaratorEnd(text, from, to) {
  let depth = 0;
  let angle = 0;
  let initialized = false;
  for (let i = from; i < to; i += 1) {
    const ch = text[i];
    if (!initialized && depth === 0) {
      if (ch === '<') angle += 1;
      else if (ch === '>' && text[i - 1] !== '=') angle = Math.max(0, angle - 1);
      else if (ch === '=' && angle === 0) initialized = true;
      if (angle > 0) continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ',') return i;
      if (ch === ';') return -1;
      if (ch === '\n') {
        const before = text.slice(from, i).trimEnd();
        const after = text.slice(i).trimStart();
        if (!before.endsWith(',') && !after.startsWith(',') && !/[=+\-*/%&|^<>?:]$/.test(before)) return -1;
      }
      if (/\s/.test(text[i - 1] || ' ') && /^(?:of|in)\b/.test(text.slice(i, i + 3))) return -1;
    }
  }
  return -1;
}

/**
 * What follows a parameter list when it is one: `{` (a function or method body, or a `catch`)
 * or `=>` (an arrow), after an optional return type. Returns `{ block, end }`, or null.
 */
function functionBodyAfter(text, from) {
  let pos = skipWs(text, from, text.length);
  if (text[pos] === ':') {
    pos = skipWs(text, pos + 1, text.length);
    let depth = 0;
    for (let i = pos; i < Math.min(text.length, pos + 400); i += 1) {
      const ch = text[i];
      if (depth === 0 && text.startsWith('=>', i)) {
        pos = i;
        break;
      }
      if (ch === '{' && depth === 0) {
        if (i === pos) {
          const close = matchBalanced(text, i);
          if (close === -1) return null;
          i = close;
          continue;
        }
        pos = i;
        break;
      }
      if ('([<'.includes(ch)) depth += 1;
      else if (')]>'.includes(ch)) depth -= 1;
      else if (depth === 0 && (ch === ';' || ch === ',' || ch === '}')) return null;
      if (depth < 0) return null;
    }
  }
  if (text.startsWith('=>', pos)) {
    const start = skipWs(text, pos + 2, text.length);
    if (text[start] === '{') {
      const close = matchBalanced(text, start);
      return close === -1 ? null : { block: false, end: close + 1 };
    }
    return { block: false, end: arrowBodyEnd(text, start) };
  }
  if (text[pos] === '{') {
    const close = matchBalanced(text, pos);
    return close === -1 ? null : { block: true, end: close + 1 };
  }
  return null;
}

/** The end of an arrow body that starts at `from`: its block, or its expression up to a `,`, `;`, closer or line end at its own depth. */
function arrowBodyEnd(text, from) {
  const start = skipWs(text, from, text.length);
  if (text[start] === '{') {
    const close = matchBalanced(text, start);
    return close === -1 ? text.length : close + 1;
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) return i;
  }
  return text.length;
}

/** The end of the statement or block that follows a `for (...)` header. */
function statementBodyAfter(text, from) {
  const start = skipWs(text, from, text.length);
  if (text[start] === '{') {
    const close = matchBalanced(text, start);
    return close === -1 ? text.length : close + 1;
  }
  return arrowBodyEnd(text, start);
}

/** Accessibility words of a constructor parameter property, which come before its name. */
const PARAMETER_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);

/**
 * The names a parameter list or a destructuring pattern binds: `a`, `...rest`, `{ a, b: c }`,
 * `[d, e]` and nested forms. A default value and a type annotation bind nothing.
 */
function patternNames(text) {
  const names = [];
  const kinds = ['list'];
  let skipping = false;
  let skipDepth = 0;
  let expectName = true;
  const token = new RegExp(`(${ID_NAME})|\\.\\.\\.|[{}\\[\\]()<>,=:?]`, 'gu');
  let m;
  while ((m = token.exec(text))) {
    const tok = m[0];
    if (skipping) {
      if ('([{<'.includes(tok)) {
        skipDepth += 1;
        continue;
      }
      if (')]}>'.includes(tok)) {
        if (skipDepth > 0) {
          skipDepth -= 1;
          continue;
        }
        skipping = false;
      } else if (tok === ',' && skipDepth === 0) {
        skipping = false;
        expectName = true;
        continue;
      } else continue;
    }
    const kind = kinds[kinds.length - 1];
    if (tok === '{') {
      kinds.push('object');
      expectName = true;
    } else if (tok === '[') {
      kinds.push('array');
      expectName = true;
    } else if (tok === '}' || tok === ']') {
      if (kinds.length > 1) kinds.pop();
      expectName = false;
    } else if (tok === '=') {
      skipping = true;
      skipDepth = 0;
    } else if (tok === ':') {
      if (kind === 'object') expectName = true;
      else {
        skipping = true;
        skipDepth = 0;
      }
    } else if (tok === ',' || tok === '...') {
      expectName = true;
    } else if (m[1]) {
      if (!expectName) continue;
      if (kind !== 'object' && PARAMETER_MODIFIERS.has(tok)) continue;
      if (kind === 'object' && /^\s*:/.test(text.slice(m.index + tok.length))) {
        expectName = false;
        continue;
      }
      names.push(tok);
      expectName = false;
    }
  }
  return names;
}

/**
 * The verb call that starts at `from`, right after a receiver: `.<verb>` or a computed
 * `[verb]`, optional type arguments, and the argument list. `at` is where the whole call
 * starts. Returns null when what follows is not one whole verb call.
 */
function verbCallAt(ctx, from, at) {
  const { code } = ctx;
  let pos = skipWs(code, from, code.length);
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
  return { index: at, argsOpen: pos, argsClose, verb, member: innermost(ctx.members, at) };
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
  const { code, lineOf } = ctx;
  const out = [];
  for (const call of ctx.gatewayCalls) {
    const line = lineOf(call.index);
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
  for (const call of ctx.gatewayCalls) {
    const { argsOpen, argsClose, verb, member, service, index } = call;
    const argParts = splitArgs(code.slice(argsOpen + 1, argsClose));
    const firstArg = argParts.length > 0 ? argParts[0].text : '';

    const resolveCtx = {
      fileText: code,
      memberBodyStart: member ? member.bodyStart : 0,
      callIndex: index,
      moduleConsts,
      masked,
      functions: ctx.functions,
    };
    let resolved;
    try {
      resolved = resolveUrlArgument(firstArg, resolveCtx);
    } catch {
      resolved = { template: '*', resolved: false };
    }
    const flattened = flattenInterpolations(resolved.template);
    const line = lineOf(index);
    lines.push(line);
    facts.push(
      fact('gateway_call', {
        file: relPath,
        line,
        service,
        method: member ? member.name : ctx.bucket,
        verb,
        template: flattened.text,
        resolved: resolved.resolved && !flattened.collapsed,
        ...ctx.control(index),
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
