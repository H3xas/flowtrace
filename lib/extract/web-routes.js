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
    at = open;
    depth -= 1;
  }
  return { guards, unsupported: null };
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
 * Every `<Route>` in one file as `page_route` facts, plus a `route-object` fact for each
 * router built from route objects, which this reader does not model. Returns the facts and
 * the element names they target, so the caller can keep its own page roles in step.
 */
export function routeFacts(ctx) {
  const { code, masked, depths, relPath, lineOf } = ctx;
  const out = [];
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
        path: normaliseBase(basename && basename.literal),
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
        path: normaliseBase(basename),
        source: 'app-root',
        component: component.name,
        ...(basenameUnsupported ? { unsupported: 'basename-expression' } : {}),
      }),
    );
  }
  return out;
}
