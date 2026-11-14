/**
 * The Cypress source reading that the `web` and `mobile` readers share, so one
 * `cy.intercept(...)` and one test read the same way in both suites.
 */

import { INLINE_FUNCTION_RE, buildRegionReader } from './test-regions.js';
import { escapeRegExp, fullLiteral, maskLiterals, matchBalanced, skipString, skipTemplate, splitArgs } from './text.js';

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function isVerbFirst(parts) {
  const first = parts[0] ? fullLiteral(parts[0].text.trim()) : null;
  return first !== null && HTTP_VERBS.has(first.toUpperCase()) && parts.length > 1;
}

/** The verb and URL pattern one `cy.intercept(...)` argument list names. */
export function parseIntercept(parts) {
  const first = parts[0] ? parts[0].text.trim() : '';
  const firstLiteral = fullLiteral(first);
  if (isVerbFirst(parts)) {
    const second = parts[1].text.trim();
    const secondLiteral = fullLiteral(second);
    return { verb: firstLiteral.toUpperCase(), pattern: secondLiteral !== null ? secondLiteral : second };
  }
  if (firstLiteral !== null) return { verb: 'ANY', pattern: firstLiteral };
  const asRegExp = /^\/(.+)\/[a-z]*$/.exec(first);
  if (asRegExp) return { verb: 'ANY', pattern: asRegExp[1] };
  if (first.startsWith('{')) {
    const method = /method\s*:\s*(['"`])(\w+)\1/.exec(first);
    const url = /url\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(first);
    if (method || url) {
      return { verb: method ? method[2].toUpperCase() : 'ANY', pattern: url ? url[2] : first };
    }
  }
  return { verb: 'ANY', pattern: first || '*' };
}

/**
 * What the handler of one `cy.intercept(...)` does with the request, in the words a
 * `pw_stub` handler uses: `spy`, `fulfill`, `fetch-fulfill`, `abort` or `unresolved`.
 * `code` is the comment-blanked file, where a handler passed by name is looked up.
 *
 * A function handler that neither replies, destroys nor continues lets Cypress send the
 * request on to the server, so it is a `spy`, unless it gives the request to code this
 * reader does not read.
 */
export function interceptHandler(parts, code) {
  const handler = parts[isVerbFirst(parts) || parts.length > 2 ? 2 : 1];
  if (!handler) return 'spy';
  const text = handler.text.trim();
  if (fullLiteral(text) !== null || text.startsWith('`')) return 'fulfill';
  if (text.startsWith('{') || text.startsWith('[')) return staticKind(text);
  const fn = readFunction(text);
  if (fn) return functionKind(fn);
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const named = namedFunction(code, text);
    if (named) return functionKind(named);
  }
  return 'unresolved';
}

const HANDLER_STRENGTH = { 'fetch-fulfill': 4, fulfill: 3, abort: 2, spy: 1 };
const RESPONSE_EVENTS = new Set(['response', 'before:response']);

function staticKind(text) {
  return /(?<![\w$])forceNetworkError(?![\w$])/.test(maskLiterals(text)) ? 'abort' : 'fulfill';
}

function memberCalls(body, name, methods) {
  const masked = maskLiterals(body);
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*(?:\\?\\.|\\.)\\s*(${methods})\\s*\\(`, 'g');
  const calls = [];
  let m;
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(body, open);
    if (close === -1) return null;
    calls.push({ method: m[1], args: splitArgs(body.slice(open + 1, close)) });
  }
  return calls;
}

function sendsResponse(part) {
  const fn = part ? readFunction(part.text) : null;
  if (!fn || !fn.param) return false;
  const sends = memberCalls(fn.body, fn.param, 'send');
  return sends !== null && sends.length > 0;
}

function functionKind({ param, body }) {
  if (!param) return 'unresolved';
  const calls = memberCalls(body, param, 'reply|destroy|continue|on');
  if (calls === null) return 'unresolved';
  let best = null;
  const take = (kind) => {
    if (best === null || HANDLER_STRENGTH[kind] > HANDLER_STRENGTH[best]) best = kind;
  };
  for (const call of calls) {
    if (call.method === 'reply') take(call.args[0] && staticKind(call.args[0].text) === 'abort' ? 'abort' : 'fulfill');
    else if (call.method === 'destroy') take('abort');
    else if (call.method === 'continue') take(sendsResponse(call.args[0]) ? 'fetch-fulfill' : 'spy');
    else if (call.args[0] && RESPONSE_EVENTS.has(fullLiteral(call.args[0].text))) {
      take(sendsResponse(call.args[1]) ? 'fetch-fulfill' : 'spy');
    }
  }
  if (best !== null) return best;
  const handedOn = new RegExp(`[(,]\\s*${escapeRegExp(param)}\\s*[,)]`).test(maskLiterals(body));
  return handedOn ? 'unresolved' : 'spy';
}

/**
 * The parameter and body of the function expression that is the whole start of `text`, with
 * `bodyStart` and `bodyEnd` as offsets into `text`.
 */
function readFunction(text) {
  const arrow = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*/.exec(text);
  if (arrow) return withBody(arrow[1], arrow[1], text, arrow[0].length);
  const head = /^(?:async\s+)?(function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*)?\(/.exec(text);
  if (!head) return null;
  const open = head[0].length - 1;
  const close = matchBalanced(text, open);
  if (close === -1) return null;
  const tail = head[1] ? /^\s*(?::[^{]*)?(?=\{)/.exec(text.slice(close + 1)) : /^\s*(?::[^=;{]*)?=>\s*/.exec(text.slice(close + 1));
  if (!tail) return null;
  const paramsText = text.slice(open + 1, close);
  const first = splitArgs(paramsText)[0];
  const param = first ? /^([A-Za-z_$][\w$]*)\s*(?:[:=?]|$)/.exec(first.text) : null;
  return withBody(param ? param[1] : null, paramsText, text, close + 1 + tail[0].length);
}

function withBody(param, paramsText, text, from) {
  let bodyStart = from;
  let bodyEnd;
  if (text[from] === '{') {
    const close = matchBalanced(text, from);
    if (close === -1) return null;
    bodyStart = from + 1;
    bodyEnd = close;
  } else {
    bodyEnd = expressionEnd(text, from);
  }
  return { param, paramsText, bodyStart, bodyEnd, body: text.slice(bodyStart, bodyEnd) };
}

function expressionEnd(text, from) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') i = skipString(text, i, ch);
    else if (ch === '`') i = skipTemplate(text, i);
    else if (ch === '(' || ch === '[' || ch === '{') {
      const close = matchBalanced(text, i);
      if (close === -1) return text.length;
      i = close + 1;
    } else if (ch === ';' || ch === '\n' || ch === ',' || ch === ')' || ch === ']' || ch === '}') return i;
    else i += 1;
  }
  return text.length;
}

/** The one function of the file named `name`, or null for none or more than one. */
function namedFunction(code, name) {
  const masked = maskLiterals(code);
  const id = escapeRegExp(name);
  const re = new RegExp(`(?<![\\w$.])(?:(function\\s*\\*?\\s*${id}\\s*\\()|(?:const|let|var)\\s+${id}\\s*(?::[^=;]*)?=(?!=)\\s*)`, 'g');
  const found = [];
  let m;
  while ((m = re.exec(masked))) found.push(m[1] ? code.slice(m.index) : code.slice(m.index + m[0].length));
  return found.length === 1 ? readFunction(found[0]) : null;
}

const DESCRIBE_RE = /(?<![.?\w$])(?:x?describe|context)(?:\s*\.\s*(?:only|skip))*\s*\(/g;
const HOOK_RE = /(?<![.?\w$])(?:beforeEach|before)\s*\(/g;
const COMMAND_RE = /(?<![\w$.])Cypress\s*\.\s*Commands\s*\.\s*add\s*\(/g;

/**
 * Where the function argument of a test declaration sits. `open` and `close` are the parens of
 * the `it(...)` call. A body passed by reference is not `inline`.
 */
export function testFunction(code, open, close) {
  const inner = code.slice(open + 1, close);
  const parts = splitArgs(inner);
  if (parts.length < 2) return { fnStart: null, fnEnd: null, inline: false };
  const last = parts[parts.length - 1];
  const raw = inner.slice(last.start);
  const fnStart = open + 1 + last.start + (raw.length - raw.trimStart().length);
  return { fnStart, fnEnd: fnStart + last.text.length, inline: INLINE_FUNCTION_RE.test(last.text) };
}

/** The custom commands one file defines with `Cypress.Commands.add(name, fn)`. */
function commandFunctions(file) {
  const commands = [];
  COMMAND_RE.lastIndex = 0;
  let m;
  while ((m = COMMAND_RE.exec(file.masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(file.code, open);
    if (close === -1) continue;
    const inner = file.code.slice(open + 1, close);
    const parts = splitArgs(inner);
    const name = parts[0] ? fullLiteral(parts[0].text) : null;
    const fnPart = parts[parts.length - 1];
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name) || parts.length < 2) continue;
    const raw = inner.slice(fnPart.start);
    const at = open + 1 + fnPart.start + (raw.length - raw.trimStart().length);
    const fn = readFunction(fnPart.text);
    if (!fn) continue;
    commands.push({
      name,
      qualified: `cy.${name}`,
      paramsText: fn.paramsText,
      declStart: m.index,
      bodyStart: at + fn.bodyStart,
      bodyEnd: at + fn.bodyEnd,
    });
  }
  return commands;
}

/**
 * The backend class reader of one Cypress suite. `files` is `[{ path, code }]` with `code`
 * comment-blanked. A configured name matches `cy.<name>(`, and a `cy.intercept(` counts by its
 * handler. The regions a test runs reach the functions of its own file and the custom commands
 * of the suite.
 */
export function buildCypressBackendReader({ files = [], mockCalls = [], patchCalls = [] } = {}) {
  function signal(file, { callee, parenOpen }) {
    if (!callee.startsWith('cy.')) return null;
    const name = callee.slice(3);
    if (mockCalls.includes(name)) return { kind: 'mock' };
    if (patchCalls.includes(name)) return { kind: 'patch' };
    if (name !== 'intercept') return null;
    const close = matchBalanced(file.code, parenOpen);
    const kind = close === -1 ? 'unresolved' : interceptHandler(splitArgs(file.code.slice(parenOpen + 1, close)), file.code);
    return kind === 'unresolved' ? { kind, reason: 'unread-handler' } : { kind };
  }
  const regions = buildRegionReader({
    files,
    describeRe: DESCRIBE_RE,
    hookRe: HOOK_RE,
    signal,
    extraFunctions: commandFunctions,
    indexAll: false,
  });
  return { classify: regions.classify };
}
