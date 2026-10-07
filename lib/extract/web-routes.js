/**
 * Route declarations a React Router tree states in source, one `page_route` fact per
 * `<Route>` element, and the mounts that anchor such a tree to a browser path, one
 * `page_mount` fact each.
 *
 * Nothing here composes a browser path: a `<Route>` is recorded with its own `path` and
 * with enough about its position — the enclosing `<Route>`, the component that owns it, the
 * condition it sits under, the wrapper around its element, the file its element is imported
 * from — for `lib/page-routes.js` to compose chains at query time, when the configuration's
 * mounts and assumptions are known. A form this reader does not model is recorded as
 * `unsupported` with the reason rather than dropped, so a lookup that meets it can say so.
 */

import { existsSync, statSync } from 'node:fs';
import { join as joinPath, posix } from 'node:path';
import { fact } from '../facts.js';
import { fullLiteral, flattenInterpolations, matchBalanced, skipString, skipTemplate } from './text.js';

const ROUTE_OPEN_RE = /<Route(?![\w$])/g;
const MAP_CALL_RE = /\.\s*map\s*\(/g;
const ROUTES_OPEN_RE = /<(?:Routes|Switch)(?![\w$])/g;
const ROUTE_OBJECT_CALL_RE = /\b(useRoutes|createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements)\s*\(/g;
const ROOT_RENDER_RE = /\b(?:createRoot|hydrateRoot)\s*\(|\bReactDOM\s*\.\s*(?:render|hydrate)\s*\(/g;
const ROUTER_TAGS = new Set(['BrowserRouter', 'HashRouter', 'MemoryRouter', 'Router', 'StaticRouter', 'unstable_HistoryRouter']);
const REDIRECT_TAGS = new Set(['Navigate', 'Redirect']);
/** Wrappers that render their child unconditionally, so they neither guard nor replace it. */
const TRANSPARENT_WRAPPERS = new Set([
  'Suspense', 'React.Suspense', 'Fragment', 'React.Fragment', 'StrictMode', 'React.StrictMode',
]);
const MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function stripParens(text) {
  let out = String(text).trim();
  while (out.startsWith('(') && matchBalanced(out, 0) === out.length - 1) out = out.slice(1, -1).trim();
  return out;
}

/**
 * Walk `text` at nesting depth 0, calling `visit(index, char)` for every character outside a
 * literal or a bracket; a truthy return stops the walk and is returned.
 */
function topLevel(text, visit) {
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
    if (depth === 0) {
      const stop = visit(i, ch);
      if (stop) return stop;
    }
  }
  return null;
}

/** `cond ? a : b` split at its own `?` and `:`, or null when `text` is not one ternary. */
function splitTernary(text) {
  let question = -1;
  let nested = 0;
  let colon = -1;
  topLevel(text, (i, ch) => {
    if (ch === '?') {
      if (text[i + 1] === '.' || text[i + 1] === '?' || text[i - 1] === '?') return null;
      if (question === -1) question = i;
      else nested += 1;
      return null;
    }
    if (ch === ':' && question !== -1) {
      if (nested > 0) {
        nested -= 1;
        return null;
      }
      colon = i;
      return true;
    }
    return null;
  });
  if (question === -1 || colon === -1) return null;
  return { condition: text.slice(0, question), question, colon };
}

/** The offset of the last top-level `&&` in `text`, or -1. */
function lastAnd(text) {
  let found = -1;
  topLevel(text, (i, ch) => {
    if (ch === '&' && text[i + 1] === '&') found = i;
    return null;
  });
  return found;
}

/** Every `name -> { specifier, imported }` an `import` statement binds, `imported` being `default`, `*` or the exported name. */
export function collectImportBindings(code) {
  const bindings = new Map();
  const re = /\bimport\s+(?:type\s+)?([\s\S]{0,400}?)\s+from\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1];
    const specifier = m[3];
    const braceOpen = clause.indexOf('{');
    const head = braceOpen === -1 ? clause : clause.slice(0, braceOpen);
    const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(head);
    if (defaultName) bindings.set(defaultName[1], { specifier, imported: 'default' });
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) bindings.set(namespace[1], { specifier, imported: '*' });
    if (braceOpen !== -1) {
      const braceClose = clause.indexOf('}', braceOpen);
      const named = clause.slice(braceOpen + 1, braceClose === -1 ? clause.length : braceClose);
      for (const raw of named.split(',')) {
        const part = raw.trim().replace(/^type\s+/, '');
        if (part === '') continue;
        const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
        if (aliased) bindings.set(aliased[2], { specifier, imported: aliased[1] === 'default' ? 'default' : aliased[1] });
        else if (/^[A-Za-z_$][\w$]*$/.test(part)) bindings.set(part, { specifier, imported: part });
      }
    }
  }
  return bindings;
}

/**
 * The repository-relative file a relative module specifier names, or null. Only relative
 * specifiers resolve: a package name or a bundler alias is outside what the source says.
 */
export function resolveModule(repoRoot, relPath, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(relPath), specifier));
  if (base.startsWith('..')) return null;
  const candidates = [];
  if (MODULE_EXTENSIONS.some((extension) => base.endsWith(extension))) candidates.push(base);
  for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  for (const candidate of candidates) {
    const absolute = joinPath(repoRoot, ...candidate.split('/'));
    try {
      if (existsSync(absolute) && statSync(absolute).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** The name a module's default export binds: a declared function or class, a bare name, or the innermost of a wrapper call. */
export function defaultExportName(code, masked, depths, unwrap) {
  const declared = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declared.exec(masked))) {
    if (depths[m.index] === 0) return m[1];
  }
  const expression = /\bexport\s+default\s+/g;
  while ((m = expression.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const start = m.index + m[0].length;
    let end = code.indexOf(';', start);
    const newline = code.indexOf('\n\n', start);
    if (end === -1 || (newline !== -1 && newline < end)) end = newline === -1 ? code.length : newline;
    const name = unwrap(code.slice(start, end));
    if (name) return name;
  }
  return null;
}

/** The opening tag starting at `start` (`<Name`), its name and the offset of its `>`. */
function readTag(code, start, tagEnd) {
  const nameMatch = /^<([A-Za-z_$][\w$.]*)/.exec(code.slice(start, start + 200));
  if (!nameMatch) return null;
  const end = tagEnd(code, start + nameMatch[0].length, code.length);
  const selfClosing = code[end - 1] === '/';
  return { name: nameMatch[1], start, end, selfClosing };
}

/** The offset just past the `</Name>` that closes the element opened at `open`, or -1. */
function elementEnd(code, open, tagEnd) {
  if (open.selfClosing) return open.end + 1;
  const escaped = open.name.replace(/[.$]/g, (ch) => `\\${ch}`);
  const re = new RegExp(`<(/?)${escaped}(?![\\w$.])`, 'g');
  re.lastIndex = open.end + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(code))) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        const close = code.indexOf('>', m.index);
        return close === -1 ? -1 : close + 1;
      }
      continue;
    }
    const nested = readTag(code, m.index, tagEnd);
    if (nested && !nested.selfClosing) depth += 1;
    if (nested) re.lastIndex = nested.end + 1;
  }
  return -1;
}

/** The first component tag (upper-case, possibly dotted) at or after `from`, before `limit`. */
function firstComponentTag(code, from, limit) {
  const re = /<([A-Z][\w$]*(?:\.[A-Z][\w$]*)?)/g;
  re.lastIndex = from;
  const m = re.exec(code);
  if (!m || m.index >= limit) return -1;
  return m.index;
}

/**
 * `attrs` with the contents of every `{…}` blanked, offsets preserved, so an attribute of an
 * element nested inside an expression is never read as one of this tag's own.
 */
function shallow(attrs) {
  const out = attrs.split('');
  for (let i = 0; i < attrs.length; i += 1) {
    const ch = attrs[i];
    if (ch === '"' || ch === "'") {
      i = skipString(attrs, i, ch) - 1;
      continue;
    }
    if (ch !== '{') continue;
    const close = matchBalanced(attrs, i);
    const end = close === -1 ? attrs.length : close;
    for (let k = i + 1; k < end; k += 1) out[k] = ' ';
    i = end;
  }
  return out.join('');
}

function attributeAt(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*`);
  const m = re.exec(shallow(attrs));
  return m ? { index: m.index, valueAt: m.index + m[0].length } : null;
}

function attributeValue(attrs, name) {
  const found = attributeAt(attrs, name);
  if (!found) return null;
  const at = found.valueAt;
  const ch = attrs[at];
  if (ch === '"' || ch === "'") {
    const end = skipString(attrs, at, ch);
    return { literal: attrs.slice(at + 1, end - 1), text: attrs.slice(at, end) };
  }
  if (ch === '{') {
    const close = matchBalanced(attrs, at);
    if (close === -1) return { literal: null, text: attrs.slice(at) };
    const inner = attrs.slice(at + 1, close).trim();
    const literal = fullLiteral(inner);
    if (literal !== null && !literal.includes('${')) return { literal, text: inner };
    if (literal !== null) return { literal: null, template: flattenInterpolations(literal).text, text: inner, innerStart: at + 1, innerEnd: close };
    return { literal: null, text: inner, innerStart: at + 1, innerEnd: close };
  }
  return null;
}

/**
 * A path written as a module constant, or as a template whose every interpolation names a
 * module constant holding a plain string, read as that string; anything else is null.
 */
function constantPath(value, moduleConsts) {
  const constantOf = (name) => {
    const raw = moduleConsts.get(name);
    const literal = raw ? fullLiteral(raw) : null;
    return literal !== null && literal !== undefined && !literal.includes('${') ? literal : null;
  };
  if (/^[A-Za-z_$][\w$]*$/.test(value.text)) return constantOf(value.text);
  const template = fullLiteral(value.text);
  if (template === null || !value.text.startsWith('`')) return null;
  let unresolved = false;
  const substituted = template.replace(/\$\{\s*([^}]*?)\s*\}/g, (_all, name) => {
    const literal = /^[A-Za-z_$][\w$]*$/.test(name) ? constantOf(name) : null;
    if (literal === null) unresolved = true;
    return literal ?? '';
  });
  return unresolved ? null : substituted;
}

function hasBareAttribute(attrs, name) {
  const plain = shallow(attrs);
  if (new RegExp(`(?:^|\\s)${name}(?=[\\s/>]|$)(?!\\s*=)`).test(plain)) return true;
  const value = attributeValue(attrs, name);
  return Boolean(value && value.text === 'true');
}

/**
 * What one `element` expression renders: the component, the wrappers around it, a redirect,
 * or the reason it cannot be read. A conditional element yields one reading per arm.
 */
function readElement(code, start, end, ctx, guards) {
  const raw = code.slice(start, end);
  const text = stripParens(raw);
  const offset = start + raw.indexOf(text);
  // A JSX element's own text children may hold `&&` or `?` at depth 0; only an expression can be a condition.
  const ternary = text.startsWith('<') ? null : splitTernary(text);
  if (ternary) {
    const condition = collapse(ternary.condition);
    const line = ctx.lineOf(offset);
    return [
      ...readElement(code, offset + ternary.question + 1, offset + ternary.colon, ctx, [
        ...guards,
        { kind: 'condition', text: condition, branch: 'then', line },
      ]),
      ...readElement(code, offset + ternary.colon + 1, offset + text.length, ctx, [
        ...guards,
        { kind: 'condition', text: condition, branch: 'else', line },
      ]),
    ];
  }
  const and = text.startsWith('<') ? -1 : lastAnd(text);
  if (and !== -1) {
    const condition = collapse(text.slice(0, and));
    return readElement(code, offset + and + 2, offset + text.length, ctx, [
      ...guards,
      { kind: 'condition', text: condition, branch: 'then', line: ctx.lineOf(offset) },
    ]);
  }
  if (!text.startsWith('<')) return [{ unsupported: 'element-expression', elementText: collapse(text), guards }];
  const wrappers = [];
  const ownGuards = [...guards];
  let tag = readTag(code, offset, ctx.tagEnd);
  while (tag) {
    if (REDIRECT_TAGS.has(tag.name)) {
      const attrs = code.slice(tag.start, tag.end + 1);
      const to = attributeValue(attrs, 'to');
      if (!to || to.literal === null) return [{ unsupported: 'redirect-expression', redirectLine: ctx.lineOf(tag.start), wrappers, guards: ownGuards }];
      return [{ redirect: to.literal, redirectLine: ctx.lineOf(tag.start), wrappers, guards: ownGuards }];
    }
    if (tag.selfClosing) break;
    const close = elementEnd(code, tag, ctx.tagEnd);
    const childAt = firstComponentTag(code, tag.end + 1, close === -1 ? end : close);
    if (childAt === -1) break;
    wrappers.push(tag.name);
    if (!TRANSPARENT_WRAPPERS.has(tag.name)) {
      ownGuards.push({ kind: 'wrapper', text: collapse(code.slice(tag.start, tag.end + 1)), line: ctx.lineOf(tag.start) });
    }
    tag = readTag(code, childAt, ctx.tagEnd);
  }
  if (!tag) return [{ unsupported: 'element-expression', elementText: collapse(text), guards: ownGuards }];
  return [{ element: tag.name, elementIndex: tag.start, wrappers, guards: ownGuards }];
}

/**
 * The conditions a `<Route>` at `index` sits under, innermost last, between it and `limit`
 * (the tag that opens its parent). A container that is neither `cond && …` nor a ternary arm
 * — a `.map`, say — makes the route unsupported instead of a guessed guard.
 *
 * An `if (cond) { … }` block around the route is one more condition the route sits under, so
 * it becomes a guard, unevaluated like the others; a function or method body around the route
 * says nothing about when it renders and is walked through. Everything else — a loop, a
 * `switch`, an object literal — stays an unsupported container rather than a guessed guard.
 */
function containerGuards(code, depths, index, limit, lineOf) {
  const guards = [];
  let at = index;
  let depth = depths[index];
  while (depth > 0) {
    let open = -1;
    for (let i = at - 1; i > limit; i -= 1) {
      if (code[i] === '{' && depths[i] === depth - 1) {
        open = i;
        break;
      }
    }
    if (open === -1) break;
    const close = matchBalanced(code, open);
    if (close === -1) break;
    const inner = code.slice(open + 1, close);
    const position = index - open - 1;
    const block = blockAt(code, open, lineOf);
    if (block && block.keyword === 'if') {
      guards.unshift({
        kind: 'condition',
        text: collapse(code.slice(block.paren + 1, block.end - 1)),
        branch: 'then',
        line: block.line,
      });
    } else if (block && block.transparent) {
      // A function or method body says nothing about when the route renders.
    } else if (block) {
      return { guards, unsupported: 'route-expression' };
    } else {
      const ternary = splitTernary(inner);
      if (ternary && position > ternary.question) {
        guards.unshift({
          kind: 'condition',
          text: collapse(ternary.condition),
          branch: position < ternary.colon ? 'then' : 'else',
          line: lineOf(open),
        });
      } else {
        const and = lastAnd(inner);
        if (and !== -1 && position > and) {
          guards.unshift({ kind: 'condition', text: collapse(inner.slice(0, and)), branch: 'then', line: lineOf(open) });
        } else {
          return { guards, unsupported: 'route-expression' };
        }
      }
    }
    at = open;
    depth -= 1;
  }
  return { guards, unsupported: null };
}

/**
 * Whether the brace opened at `open` opens a statement block rather than one of the
 * `{ … }` expression containers a JSX child is written in: an `if (…) { … }` body, a
 * transparent function or method body, or a statement block whose condition decides when
 * the route exists and which this reader therefore will not read through. Null for an
 * expression container, whose own text the caller reads as a ternary or a `&&`.
 */
function blockAt(code, open, lineOf) {
  let at = open;
  while (at > 0 && /\s/.test(code[at - 1])) at -= 1;
  if (code[at - 1] === '>') {
    return code[at - 2] === '=' ? { transparent: true } : null;
  }
  if (code[at - 1] !== ')') {
    const word = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, at - 20), at));
    return word && ['else', 'try', 'finally', 'do'].includes(word[1]) ? { keyword: word[1] } : null;
  }
  const paren = openAt(code, at - 1);
  if (paren === -1) return null;
  let before = paren;
  while (before > 0 && /\s/.test(code[before - 1])) before -= 1;
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, before - 200), before));
  if (!name) return null;
  if (name[1] === 'if') {
    return { keyword: 'if', paren, end: at, line: lineOf(before - name[1].length) };
  }
  // A body after a parameter list belongs to a function or a method, which guards nothing; a
  // loop, a switch or a catch does decide when the route exists, and is refused.
  return ['for', 'while', 'switch', 'catch'].includes(name[1]) ? { keyword: name[1] } : { transparent: true };
}

/**
 * How the element name `name`, written in `relPath`, resolves to a declaration: through the
 * file's own lazy binding, its import, or its own declaration. Unresolved names are left to
 * the lookup, which then treats a name declared in more than one file as ambiguous.
 */
function resolveElement(ctx, name) {
  const lazy = ctx.lazyBindings.get(name);
  if (lazy) {
    return {
      lazyLine: lazy.line,
      lazySpecifier: lazy.specifier,
      ...(lazy.file ? { elementFile: lazy.file, pendingDefault: true } : {}),
    };
  }
  const imported = ctx.importBindings.get(name);
  if (imported) {
    const file = resolveModule(ctx.repoRoot, ctx.relPath, imported.specifier);
    if (!file) return {};
    if (imported.imported === 'default') return { elementFile: file, pendingDefault: true };
    if (imported.imported === '*') return {};
    return { elementFile: file, elementName: imported.imported };
  }
  if (ctx.localComponents.has(name)) return { elementFile: ctx.relPath, elementName: name };
  return {};
}

/**
 * The `(` that opens the group closed at `close`, or -1.
 */
function openAt(code, close) {
  const open = { ')': '(', ']': '[', '}': '{' }[code[close]];
  if (!open) return -1;
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const ch = code[i];
    if (ch === ')' || ch === ']' || ch === '}') depth += 1;
    else if (ch === '(' || ch === '[' || ch === '{') {
      depth -= 1;
      if (depth === 0) return ch === open ? i : -1;
    }
  }
  return -1;
}

/**
 * The leftmost identifier of the member expression whose member access starts at `dot`,
 * skipping the call arguments between it and the property name: `a.b(x).map` reads `a`.
 */
function chainBase(code, dot) {
  let i = dot;
  for (;;) {
    let at = i;
    for (;;) {
      while (at > 0 && /\s/.test(code[at - 1])) at -= 1;
      const ch = code[at - 1];
      if (ch !== ')' && ch !== ']' && ch !== '}') break;
      const open = openAt(code, at - 1);
      if (open === -1) return null;
      at = open;
    }
    const found = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, at - 200), at));
    if (!found) return null;
    const start = at - found[1].length;
    let before = start;
    while (before > 0 && /\s/.test(code[before - 1])) before -= 1;
    if (code[before - 1] !== '.') return { name: found[1], end: at, before };
    i = before - 1;
  }
}

/** The offset of the `=>` of an arrow function whose parameters and body sit at depth 0, or -1. */
function topLevelArrow(text) {
  let found = -1;
  topLevel(text, (i) => {
    if (text[i] === '=' && text[i + 1] === '>') {
      found = i;
      return true;
    }
    return null;
  });
  return found;
}

/** The name a callback binds: its first parameter, when that parameter is a plain identifier. */
function callbackParam(params) {
  let text = String(params).trim();
  while (text.startsWith('(') && matchBalanced(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
  const first = text.split(',')[0].trim();
  const found = /^([A-Za-z_$][\w$]*)(?:\s*:[^,]*)?$/.exec(first);
  return found ? found[1] : null;
}

/** `name.prop` read as the member it is, for the loop binding `name`, or null. */
function loopMember(text, name) {
  const found = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(String(text).trim());
  return found && found[1] === name ? found[2] : null;
}

function mentionsLoop(text, name) {
  return new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(String(text));
}

/** The component name a JSX element or bare identifier names, or null. */
function elementName(text) {
  const trimmed = String(text).trim().replace(/^\((.*)\)$/s, '$1').trim();
  const tag = /^<\s*([A-Z][\w$]*)(?:\.[A-Z][\w$]*)?(?=[\s/>])/.exec(trimmed);
  if (tag) return tag[1];
  return /^([A-Z][\w$]*)$/.test(trimmed) ? trimmed : null;
}

/**
 * The `.map(…)` sites in this file that render a `<Route>` inside `<Routes>` from an array
 * the loop binding indexes, as descriptors for `arrayRouteFacts`. The iteration is read, not
 * run: a callback that renders anything but a `<Route>` states no route, and one whose
 * path or element expression this reader cannot tie to the binding is left to the ordinary
 * JSX pass, which already names it unsupported.
 */
function arrayDescriptors(ctx) {
  const { code, masked, relPath, lineOf } = ctx;
  const out = [];
  const owned = [];
  const routesSpans = [];
  ROUTES_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = ROUTES_OPEN_RE.exec(masked))) {
    const tag = readTag(code, m.index, ctx.tagEnd);
    if (!tag) continue;
    const close = elementEnd(code, tag, ctx.tagEnd);
    routesSpans.push([tag.start, close === -1 ? tag.end + 1 : close]);
  }
  MAP_CALL_RE.lastIndex = 0;
  while ((m = MAP_CALL_RE.exec(masked))) {
    const openParen = m.index + m[0].length - 1;
    if (!routesSpans.some(([start, end]) => openParen > start && openParen < end)) continue;
    const closeParen = matchBalanced(code, openParen);
    if (closeParen === -1) continue;
    const callback = code.slice(openParen + 1, closeParen);
    const arrow = topLevelArrow(callback);
    if (arrow === -1) continue;
    const loop = callbackParam(callback.slice(0, arrow));
    if (!loop) continue;
    const bodyAt = openParen + 1 + arrow + 2;
    const rendered = /<Route(?![\w$])/.exec(callback.slice(arrow + 2));
    if (!rendered) continue;
    const tagIndex = bodyAt + rendered.index;
    const tag = readTag(code, tagIndex, ctx.tagEnd);
    if (!tag) continue;
    const attrs = code.slice(tag.start, tag.end + 1);
    const descriptor = readArrayRoute(ctx, { dot: m.index, loop, attrs, tag, tagIndex });
    if (!descriptor) continue;
    descriptor.mapLine = lineOf(m.index);
    descriptor.mapColumn = m.index - code.lastIndexOf('\n', m.index - 1);
    out.push(descriptor);
    owned.push(tagIndex);
  }
  return { descriptors: out, owned };
}

/** One `.map` callback's `<Route>` as a descriptor, or null when it is not array-driven. */
function readArrayRoute(ctx, { dot, loop, attrs, tag, tagIndex }) {
  const { code, lineOf, relPath } = ctx;
  const descriptor = {
    owner: ctx.ownerAt(tagIndex),
    file: relPath,
    line: lineOf(tagIndex),
    column: tagIndex - code.lastIndexOf('\n', tagIndex - 1),
    endLine: lineOf(Math.max(tagIndex, tag.end)),
    loop,
    renderText: collapse(code.slice(tag.start, tag.end + 1)),
    arrayName: null,
    filter: null,
  };

  const base = chainBase(code, dot);
  if (!base) return null;
  descriptor.arrayName = base.name;
  const receiver = code.slice(base.end, dot);
  const filter = /^\s*\.\s*filter\s*\(/.exec(receiver);
  if (filter) {
    const open = base.end + filter[0].length - 1;
    const close = matchBalanced(code, open);
    const predicate = close === -1 ? '' : code.slice(open + 1, close);
    const arrow = topLevelArrow(predicate);
    if (arrow === -1) descriptor.filter = { kind: 'other', text: collapse(predicate) };
    else {
      const param = callbackParam(predicate.slice(0, arrow));
      const prop = param ? loopMember(predicate.slice(arrow + 2).trim(), param) : null;
      descriptor.filter = prop ? { kind: 'member', prop } : { kind: 'other', text: collapse(predicate) };
    }
  } else if (receiver.trim() !== '') {
    return null;
  }

  const pathValue = attributeValue(attrs, 'path');
  if (!pathValue) {
    descriptor.pathKind = 'literal';
    descriptor.pathLiteral = '';
  } else if (/^['"]/.test(pathValue.text)) {
    descriptor.pathKind = 'literal';
    descriptor.pathLiteral = pathValue.literal;
  } else {
    const inner = pathValue.text;
    const prop = loopMember(inner, loop);
    const plain = fullLiteral(inner);
    if (prop) {
      descriptor.pathKind = 'member';
      descriptor.pathProp = prop;
    } else if (plain !== null && !plain.includes('${')) {
      descriptor.pathKind = 'literal';
      descriptor.pathLiteral = plain;
    } else {
      const template = /^`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\}\s*`$/.exec(inner);
      const interpolated = /^`([\s\S]*)\$\{\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\}([\s\S]*)`$/.exec(inner);
      if (template && template[1] === loop) {
        descriptor.pathKind = 'template';
        descriptor.pathProp = template[2];
        descriptor.pathSuffix = '';
      } else if (interpolated && interpolated[2] === loop) {
        descriptor.pathKind = 'template';
        descriptor.pathProp = interpolated[3];
        descriptor.pathSuffix = `${interpolated[1]}${interpolated[4]}`;
      } else {
        descriptor.pathKind = mentionsLoop(inner, loop) ? 'other' : null;
        descriptor.pathText = collapse(inner);
      }
    }
  }

  const elementValue = attributeValue(attrs, 'element');
  const componentValue = attributeValue(attrs, 'component');
  const chosen = elementValue || componentValue;
  descriptor.elementKey = elementValue ? 'element' : componentValue ? 'component' : null;
  if (chosen) {
    const inner = chosen.text;
    const member = loopMember(inner, loop) || loopMember(inner.replace(/^<\s*|\s*\/?>$/g, ''), loop);
    if (member) {
      descriptor.elementKind = 'member';
      descriptor.elementProp = member;
    } else {
      const literal = elementName(inner);
      if (literal) {
        descriptor.elementKind = 'literal';
        descriptor.elementLiteral = literal;
      } else {
        descriptor.elementKind = mentionsLoop(inner, loop) ? 'other' : null;
        descriptor.elementText = collapse(inner);
      }
    }
  }

  if (descriptor.pathKind == null && descriptor.elementKind == null) return null;
  return descriptor;
}

/**
 * One array entry's site in its own file, from its offset in the array's source text.
 */
function siteIn(array, offset) {
  const before = array.text.slice(0, offset);
  const line = array.line + before.split('\n').length - 1;
  const newline = before.lastIndexOf('\n');
  return {
    file: array.file,
    line,
    column: newline === -1 ? array.column + offset : offset - newline,
  };
}

/** The top-level `,`-separated parts of `text`, each with its offset, skipping literals and groups. */
function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
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
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), start });
  return parts;
}

/**
 * The `{ path, component, … }` properties one array entry states, spreads merged in source
 * order, each value with the site it was written at. Unreadable spreads are reported, never
 * skipped quietly.
 */
function entryProps(text, offset, array, lookup, depth = 0) {
  if (depth > 2) return { error: 'route-array-expression', elementText: collapse(text) };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return { error: 'route-array-expression', elementText: collapse(trimmed) };
  const close = matchBalanced(trimmed, 0);
  if (close === -1) return { error: 'route-array-expression', elementText: collapse(trimmed) };
  const body = trimmed.slice(1, close);
  const props = new Map();
  for (const part of splitTopLevel(body, ',')) {
    const raw = part.text.trim();
    if (raw === '') continue;
    const at = offset + 1 + part.start + (part.text.length - part.text.trimStart().length);
    if (raw.startsWith('...')) {
      const name = raw.slice(3).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { error: 'route-array-expression', elementText: collapse(raw) };
      const spread = resolveObject(name, array, lookup);
      if (spread.error) return spread;
      for (const [key, value] of spread.props) props.set(key, value);
      continue;
    }
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    const valueText = raw.slice(colon + 1).trim();
    props.set(key, { text: valueText, ...siteIn(array, at + raw.indexOf(valueText)) });
  }
  return { props };
}

/**
 * A spread name read as a constant object: a module constant of the file the array is written
 * in, or of the file one of its imports names. Never a value this reader would have to run.
 */
function resolveObject(name, array, lookup) {
  const direct = lookup.constant(array.file, name);
  if (direct) return objectProps(direct, lookup);
  if (lookup.declaredConstant(array.file, name)) return { error: 'route-array-expression', elementText: name };
  const imported = lookup.importedConstant(array.file, name);
  if (imported) {
    const target = lookup.constant(imported.file, imported.name);
    if (target) return objectProps(target, lookup);
    if (lookup.declaredConstant(imported.file, imported.name)) return { error: 'route-array-expression', elementText: name };
  }
  return { error: 'route-array-unresolved', elementText: name };
}

function objectProps(constant, lookup) {
  const close = matchBalanced(constant.text, 0);
  if (!constant.text.trim().startsWith('{') || close === -1) return { error: 'route-array-expression', elementText: collapse(constant.text) };
  return entryProps(constant.text, 0, constant, lookup, 1);
}

/** The array the descriptor's loop binding indexes, or the reason it cannot be read. */
function resolveArray(descriptor, lookup) {
  const direct = lookup.constant(descriptor.file, descriptor.arrayName);
  if (direct) return direct;
  if (lookup.declaredConstant(descriptor.file, descriptor.arrayName)) return { error: 'route-array-expression' };
  const imported = lookup.importedConstant(descriptor.file, descriptor.arrayName);
  if (imported) {
    const target = lookup.constant(imported.file, imported.name);
    if (target) return target;
    if (lookup.declaredConstant(imported.file, imported.name)) return { error: 'route-array-expression' };
    return { error: 'route-array-unresolved' };
  }
  const passes = lookup.propPasses(descriptor.owner, descriptor.arrayName, descriptor.file);
  if (passes.length === 0) return { error: 'route-array-unresolved' };
  if (passes.length > 1) return { error: 'route-array-ambiguous' };
  const pass = passes[0];
  const local = lookup.constant(pass.file, pass.value);
  if (local) return local;
  if (lookup.declaredConstant(pass.file, pass.value)) return { error: 'route-array-expression' };
  const passedOn = lookup.importedConstant(pass.file, pass.value);
  if (passedOn) {
    const target = lookup.constant(passedOn.file, passedOn.name);
    if (target) return target;
    if (lookup.declaredConstant(passedOn.file, passedOn.name)) return { error: 'route-array-expression' };
  }
  return { error: 'route-array-unresolved' };
}

/** The declaration an array entry's element names, through the entry file's own imports. */
function elementBinding(lookup, file, name) {
  const imported = lookup.importBinding(file, name);
  if (!imported) return {};
  const target = lookup.moduleFor(file, imported.specifier);
  if (!target) return {};
  if (imported.imported === 'default') {
    const declared = lookup.defaultExport(target);
    return { elementFile: target, ...(declared ? { elementName: declared } : {}) };
  }
  if (imported.imported === '*') return {};
  return { elementFile: target, elementName: imported.imported };
}

/**
 * The `page_route` facts one array descriptor stands for: one per entry of the array the loop
 * binding indexes, each naming the entry's site and the `.map` site that renders it, or one
 * failure fact naming why the array could not be read. `lookup` answers with the repository's
 * constants, imports and JSX prop sites, which the walk collects for every file.
 */
export function arrayRouteFacts(descriptor, lookup) {
  const site = {
    file: descriptor.file,
    line: descriptor.line,
    column: descriptor.column,
    endLine: descriptor.endLine,
    owner: descriptor.owner,
    arrayFile: descriptor.file,
    arrayName: descriptor.arrayName,
  };
  const failed = (reason, extra = {}) => fact('page_route', { ...site, path: '', unsupported: reason, ...extra });
  const array = resolveArray(descriptor, lookup);
  if (array.error) return [failed(array.error)];
  const text = array.text.trim();
  if (!text.startsWith('[')) return [failed('route-array-expression', { elementText: collapse(text) })];
  const close = matchBalanced(text, 0);
  if (close === -1) return [failed('route-array-expression', { elementText: collapse(text) })];

  const out = [];
  for (const part of splitTopLevel(text.slice(1, close), ',')) {
    const raw = part.text.trim();
    if (raw === '') continue;
    const offset = 1 + part.start + (part.text.length - part.text.trimStart().length);
    const entrySite = siteIn(array, offset);
    const parsed = entryProps(raw, offset, array, lookup);
    if (parsed.error) return [failed(parsed.error, parsed.elementText ? { elementText: parsed.elementText } : {})];
    const props = parsed.props;
    const entry = {
      ...site,
      entryFile: entrySite.file,
      entryLine: entrySite.line,
      entryColumn: entrySite.column,
    };
    let unsupported = null;
    let pathText;
    let path = '';
    if (descriptor.pathKind === 'literal') path = descriptor.pathLiteral;
    else if (descriptor.pathKind === 'member' || descriptor.pathKind === 'template') {
      const prop = props.get(descriptor.pathProp);
      const literal = prop ? fullLiteral(prop.text) : null;
      if (prop && literal !== null && !literal.includes('${')) {
        path = descriptor.pathKind === 'template' ? `${literal}${descriptor.pathSuffix}` : literal;
      } else {
        unsupported = 'path-expression';
        pathText = collapse(prop ? prop.text : descriptor.pathText);
      }
    } else {
      unsupported = 'path-expression';
      pathText = descriptor.pathText;
    }

    let element = null;
    let elementText;
    if (descriptor.elementKind === 'literal') element = descriptor.elementLiteral;
    else if (descriptor.elementKind === 'member') {
      const prop = props.get(descriptor.elementProp);
      const named = prop ? elementName(prop.text) : null;
      if (named) element = named;
      else {
        unsupported = unsupported || 'element-expression';
        elementText = collapse(prop ? prop.text : descriptor.elementText);
      }
    } else if (descriptor.elementKind === 'other') {
      unsupported = unsupported || 'element-expression';
      elementText = descriptor.elementText;
    }

    const guards = [];
    if (descriptor.filter && descriptor.filter.kind === 'member') {
      const prop = props.get(descriptor.filter.prop);
      if (!prop) unsupported = unsupported || 'filter-property';
      else if (prop.text !== 'true') {
        guards.push({ kind: 'condition', text: collapse(prop.text), branch: 'then', file: prop.file, line: prop.line });
      }
    } else if (descriptor.filter) {
      unsupported = unsupported || 'filter-expression';
    }

    const factEntry = fact('page_route', {
      ...entry,
      path,
      ...(unsupported ? { unsupported } : {}),
      ...(pathText !== undefined ? { pathText } : {}),
      ...(elementText !== undefined ? { elementText } : {}),
      ...(guards.length > 0 ? { guards } : {}),
    });
    if (element) {
      factEntry.element = element;
      Object.assign(factEntry, elementBinding(lookup, entrySite.file, element));
    }
    out.push(factEntry);
  }
  if (out.length === 0) return [failed('route-array-expression', { elementText: collapse(text) })];
  return out;
}

/**
 * The JSX prop sites that pass a bare identifier — `<Layout routes={entries} />` — one row per
 * attribute, so an array read through one prop can be found without running the application.
 */
export function jsxIdentifierPasses(ctx) {
  const { code, masked, relPath, lineOf } = ctx;
  const out = [];
  const seen = new Set();
  const re = /<([A-Z][\w$]*)(?![\w$])/g;
  let m;
  while ((m = re.exec(masked))) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    const tag = readTag(code, m.index, ctx.tagEnd);
    if (!tag) continue;
    const attrs = code.slice(tag.start, tag.end + 1);
    for (const [name, value] of identifierAttributes(attrs)) {
      out.push({
        component: m[1],
        prop: name,
        value,
        file: relPath,
        line: lineOf(tag.start),
        column: tag.start - code.lastIndexOf('\n', tag.start - 1),
      });
    }
  }
  return out;
}

/**
 * Every `name={Identifier}` attribute of one opening tag, in source order. The attribute
 * names come from the shallow reading, which blanks every `{…}` so a nested element's
 * attribute is never read as this tag's; the values then come from the tag's own text.
 */
function identifierAttributes(attrs) {
  const out = [];
  const seen = new Set();
  const plain = shallow(attrs);
  const re = /(?:^|\s)([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(plain))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const value = attributeValue(attrs, m[1]);
    if (value && /^[A-Za-z_$][\w$]*$/.test(value.text.trim())) out.push([m[1], value.text.trim()]);
  }
  return out;
}

/**
 * Every `<Route>` in one file as `page_route` facts, plus a `route-object` fact for each
 * router built from route objects, which this reader does not model. Returns the facts and
 * the element names they target, so the caller can keep its own page roles in step.
 */
export function routeFacts(ctx) {
  const { code, masked, depths, relPath, lineOf } = ctx;
  const out = [];
  const arrays = arrayDescriptors(ctx);
  if (ctx.pendingArrayRoutes) ctx.pendingArrayRoutes.push(...arrays.descriptors);
  const opens = [];
  ROUTE_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_OPEN_RE.exec(masked))) {
    const tag = readTag(code, m.index, ctx.tagEnd);
    if (!tag) continue;
    const end = elementEnd(code, tag, ctx.tagEnd);
    opens.push({ ...tag, close: end === -1 ? tag.end + 1 : end });
  }
  const routesOpens = [];
  ROUTES_OPEN_RE.lastIndex = 0;
  while ((m = ROUTES_OPEN_RE.exec(masked))) {
    const tag = readTag(code, m.index, ctx.tagEnd);
    if (tag) routesOpens.push(tag);
  }

  for (const route of opens) {
    // A `<Route>` a `.map` builds from an array entry is stated by `arrayRouteFacts`, which
    // reads the entry's own path and element; reading it here as an expression route too would
    // report the same declaration twice, once of them unsupported.
    if (arrays.owned.includes(route.start)) continue;
    const parent = opens
      .filter((other) => other !== route && other.start < route.start && other.close >= route.close && !other.selfClosing)
      .sort((a, b) => b.start - a.start)[0];
    const container = parent || routesOpens.filter((open) => open.start < route.start).sort((a, b) => b.start - a.start)[0];
    const limit = container ? container.end : -1;
    const attrs = code.slice(route.start, route.end + 1);
    const position = containerGuards(code, depths, route.start, limit, lineOf);
    const base = {
      file: relPath,
      line: lineOf(route.start),
      column: route.start - code.lastIndexOf('\n', route.start - 1),
      endLine: lineOf(Math.max(route.start, route.close - 1)),
      owner: ctx.ownerAt(route.start),
    };
    if (parent) {
      base.parentLine = lineOf(parent.start);
      base.parentColumn = parent.start - code.lastIndexOf('\n', parent.start - 1);
    }
    const hasChildren = opens.some((other) => other !== route && other.start > route.start && other.close <= route.close);
    if (hasChildren) base.layout = true;

    let path = '';
    let unsupported = position.unsupported;
    let pathText;
    if (hasBareAttribute(attrs, 'index')) base.index = true;
    const pathValue = attributeValue(attrs, 'path');
    if (pathValue) {
      const pathAt = attributeAt(attrs, 'path');
      const pathLine = lineOf(route.start + pathAt.valueAt);
      if (pathLine !== base.line) base.pathLine = pathLine;
      const literal = pathValue.literal !== null ? pathValue.literal : constantPath(pathValue, ctx.moduleConsts);
      if (literal !== null) path = literal;
      else {
        unsupported = unsupported || 'path-expression';
        pathText = collapse(pathValue.text);
        path = pathValue.template ?? '';
      }
    }
    if (!unsupported && /(^|\/)[^/]*\?(\/|$)/.test(path)) unsupported = 'optional-segment';

    const readings = [];
    const elementAt = attributeAt(attrs, 'element');
    const componentValue = attributeValue(attrs, 'component');
    if (elementAt && attrs[elementAt.valueAt] === '{') {
      const braceIndex = route.start + elementAt.valueAt;
      const close = matchBalanced(code, braceIndex);
      if (close !== -1) readings.push(...readElement(code, braceIndex + 1, close, ctx, []));
    } else if (componentValue && /^[A-Za-z_$][\w$]*$/.test(componentValue.text)) {
      const componentAt = attributeAt(attrs, 'component');
      readings.push({ element: componentValue.text, elementIndex: route.start + componentAt.valueAt, wrappers: [], guards: [] });
    } else if (attributeAt(attrs, 'render') || componentValue) {
      readings.push({ unsupported: 'element-expression', elementText: 'render', guards: [] });
    }
    if (readings.length === 0) readings.push({ guards: [] });

    for (const reading of readings) {
      const entry = fact('page_route', { ...base, path });
      const guards = [...position.guards, ...(reading.guards || [])];
      if (guards.length > 0) entry.guards = guards;
      const reason = unsupported || reading.unsupported;
      if (reason) entry.unsupported = reason;
      if (pathText !== undefined) entry.pathText = pathText;
      if (reading.elementText) entry.elementText = reading.elementText;
      if (reading.wrappers && reading.wrappers.length > 0) entry.wrappers = reading.wrappers;
      if (reading.redirect !== undefined) {
        entry.redirect = reading.redirect;
        entry.redirectLine = reading.redirectLine;
      } else if (reading.redirectLine !== undefined) {
        entry.redirectLine = reading.redirectLine;
      }
      if (reading.element) {
        entry.element = reading.element;
        entry.elementLine = lineOf(reading.elementIndex);
        Object.assign(entry, resolveElement(ctx, reading.element));
      }
      out.push(entry);
    }
  }

  ROUTE_OBJECT_CALL_RE.lastIndex = 0;
  while ((m = ROUTE_OBJECT_CALL_RE.exec(masked))) {
    if (m.index > 0 && /[\w$.]/.test(masked[m.index - 1])) continue;
    out.push(
      fact('page_route', {
        file: relPath,
        line: lineOf(m.index),
        owner: ctx.ownerAt(m.index),
        path: '',
        unsupported: 'route-object',
        elementText: m[1],
      }),
    );
  }
  return out;
}

/**
 * Mounts the source itself declares: a root render (`createRoot(…).render(<X/>)`,
 * `ReactDOM.render`) mounts every component it renders at the router's `basename`, or at `/`;
 * a router element inside a component mounts that component at its own `basename`.
 */
export function mountFacts(ctx) {
  const { code, masked, relPath, lineOf } = ctx;
  const out = [];
  const covered = [];
  ROOT_RENDER_RE.lastIndex = 0;
  let m;
  while ((m = ROOT_RENDER_RE.exec(masked))) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchBalanced(code, openParen);
    if (closeParen === -1) continue;
    let span = [openParen + 1, closeParen];
    if (/^createRoot/.test(m[0])) {
      const render = /^\s*\.\s*render\s*\(/.exec(code.slice(closeParen + 1, closeParen + 80));
      if (!render) continue;
      const renderParen = closeParen + render[0].length;
      const renderClose = matchBalanced(code, renderParen);
      if (renderClose === -1) continue;
      span = [renderParen + 1, renderClose];
    }
    covered.push(span);
    out.push(...mountsIn(code, span[0], span[1], ctx));
  }
  const heldRoot = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ReactDOM\s*\.\s*)?createRoot\s*\(/g;
  while ((m = heldRoot.exec(masked))) {
    const renderRe = new RegExp(`\\b${m[1]}\\s*\\.\\s*render\\s*\\(`, 'g');
    renderRe.lastIndex = m.index + m[0].length;
    let call;
    while ((call = renderRe.exec(masked))) {
      const renderParen = call.index + call[0].length - 1;
      const renderClose = matchBalanced(code, renderParen);
      if (renderClose === -1) continue;
      if (covered.some(([start]) => start === renderParen + 1)) continue;
      covered.push([renderParen + 1, renderClose]);
      out.push(...mountsIn(code, renderParen + 1, renderClose, ctx));
    }
  }
  const routerRe = /<(BrowserRouter|HashRouter|MemoryRouter|StaticRouter|unstable_HistoryRouter)(?![\w$])/g;
  while ((m = routerRe.exec(masked))) {
    const at = m.index;
    if (covered.some(([start, end]) => at >= start && at < end)) continue;
    const tag = readTag(code, at, ctx.tagEnd);
    if (!tag) continue;
    const basename = attributeValue(code.slice(tag.start, tag.end + 1), 'basename');
    out.push(
      fact('page_mount', {
        file: relPath,
        line: lineOf(tag.start),
        path: basename && basename.literal === null ? '' : normaliseBase(basename && basename.literal),
        source: 'router',
        component: ctx.ownerAt(tag.start),
        ...(basename && basename.literal === null ? { unsupported: 'basename-expression' } : {}),
      }),
    );
  }
  return out;
}

function normaliseBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return '/';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function mountsIn(code, start, end, ctx) {
  const out = [];
  let basename = null;
  let basenameLine = null;
  let basenameUnsupported = false;
  const re = /<([A-Z][\w$]*(?:\.[A-Z][\w$]*)?)/g;
  re.lastIndex = start;
  let m;
  const components = [];
  while ((m = re.exec(code)) && m.index < end) {
    const name = m[1];
    if (ROUTER_TAGS.has(name)) {
      const tag = readTag(code, m.index, ctx.tagEnd);
      const value = tag ? attributeValue(code.slice(tag.start, tag.end + 1), 'basename') : null;
      if (value) {
        basename = value.literal;
        basenameLine = ctx.lineOf(m.index);
        basenameUnsupported = value.literal === null;
      }
      continue;
    }
    components.push({ name, line: ctx.lineOf(m.index) });
  }
  for (const component of components) {
    out.push(
      fact('page_mount', {
        file: ctx.relPath,
        line: basenameLine ?? component.line,
        path: basenameUnsupported ? '' : normaliseBase(basename),
        source: 'app-root',
        component: component.name,
        ...(basenameUnsupported ? { unsupported: 'basename-expression' } : {}),
      }),
    );
  }
  return out;
}
