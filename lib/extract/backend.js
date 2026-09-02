/**
 * ASP.NET Core / MassTransit / worker-queue / SignalR fact extractor.
 *
 * Heuristic, regex-based reader over `.cs` source. It does not parse C#; it recognises
 * a small set of common routing and messaging idioms and turns each occurrence into one
 * fact (see `lib/facts.js` for the fact shapes). The idioms are conventions, not a
 * standard: a codebase that names things differently is expected to widen the patterns
 * below.
 */

import { readFileSync } from 'node:fs';
import { relative, basename } from 'node:path';
import { walk } from '../walk.js';
import { fact } from '../facts.js';

const DEFAULT_EXCLUDE = ['Tests', 'bin', 'obj', 'load-tests', 'automation', '.openapi'];

const ATTRIBUTE_LINE = /^\s*\[\s*([A-Za-z_][\w.]*)\s*(?:\((.*)\))?\s*\]\s*$/;
const HTTP_VERB_ATTRIBUTE = /^Http(Get|Post|Put|Patch|Delete)$/;
/** The two route-template tokens ASP.NET Core substitutes by its own convention --
 * `[controller]` (the declaring class name with a trailing `Controller` removed) and
 * `[action]` (the declaring method name). Matched case-insensitively, the way the
 * framework's own token replacement is. `[area]` and custom token providers are out of
 * scope and stay verbatim. */
const ROUTE_TEMPLATE_TOKEN = /\[(controller|action)\]/gi;

/** A Razor Page code-behind, the only file shape the page-handler pass reads. */
const RAZOR_PAGE_CODE_BEHIND = /\.cshtml\.cs$/;
/** `OnGet` / `OnPostAsync` / `OnPostUpdate` -- verb first, then the optional
 * named-handler part, then the optional `Async` suffix the convention strips. */
const RAZOR_PAGE_HANDLER = /^On(Get|Post|Put|Patch|Delete|Head)([A-Za-z0-9_]*)$/;
/** The `@page` directive at the head of the sibling `.cshtml`, with the optional
 * route template that either appends to (`"{handler?}"`) or replaces (`"/custom"`) the
 * path the file's own location derives. */
const PAGE_ROUTE_DIRECTIVE = /^\s*@page(?:\s+"([^"]*)")?\s*$/;
/** `Areas/<area>/Pages/...` -- the area name prefixes the derived page route. */
const AREA_PAGES_SEGMENT = /(?:^|\/)Areas\/([^/]+)\/Pages\//;
/** The `{handler}` / `{handler?}` route token a page template uses to put a named
 * handler in the path rather than in the query string. */
const PAGE_HANDLER_TOKEN = /\{handler\??\}/i;

/** `group.MapGet("template", handler)` -- the receiver identifier is kept so a
 * `MapGroup` prefix bound to that name composes into the emitted route. */
const MINIMAL_API_MAP_CALL = /([A-Za-z_]\w*)\s*\.\s*Map(Get|Post|Put|Patch|Delete|Methods)\s*\(\s*"([^"]*)"\s*[,)]/g;
/** `var group = app.MapGroup("prefix")` -- one hop of a route-group chain. */
const MAP_GROUP_ASSIGNMENT = /\b(?:var|[A-Za-z_][\w<>.?[\]]*)\s+(\w+)\s*=\s*([A-Za-z_]\w*)\s*\.\s*MapGroup\s*\(\s*"([^"]*)"\s*\)/g;
/** `app.MapGroup("prefix").MapGet("template", handler)` -- the same composition
 * written inline, where no variable ever names the group. */
const INLINE_MAP_GROUP_CALL = /\.\s*MapGroup\s*\(\s*"([^"]*)"\s*\)\s*\.\s*Map(Get|Post|Put|Patch|Delete|Methods)\s*\(\s*"([^"]*)"\s*[,)]/g;
/** A handler passed as a method group (`app.MapGet("t", HandleAsync)`) rather than
 * as an inline lambda -- the referenced method is what the walk continues into. */
const METHOD_GROUP_ARGUMENT = /^\s*(?:this\s*\.\s*)?(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)\s*(?:,|$)/;
/** The Ardalis-style single-endpoint base, matched by its shape
 * (`.WithRequest<…>.WithActionResult<…>`, `.WithoutRequest.WithResult<…>`, …) rather than by
 * a hardcoded base-type name, so a differently-named same-shape base still qualifies. */
const ENDPOINT_BASE_SHAPE = /\.\s*With(?:out)?Request\b[\s\S]{0,400}?\.\s*With(?:out)?(?:Action)?Result\b/;
/** A verb attribute read out of an endpoint class's attribute block by index,
 * so a multi-line attribute sitting between it and the method (`[SwaggerOperation( … )]`)
 * cannot hide it the way the line-at-a-time controller pass is hidden from it. */
const HTTP_VERB_ATTRIBUTE_CALL = /\[\s*Http(Get|Post|Put|Patch|Delete)\s*(?:\(\s*"([^"]*)"\s*\))?\s*\]/g;
const ROUTE_ATTRIBUTE_CALL = /\[\s*Route\s*\(\s*"([^"]*)"\s*\)\s*\]/g;
const HTTP_VERB_WORDS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const INTERPOLATED_URL = /\$"\{(\w+)\}([^"]*)"/;
const OUTBOUND_VERB_CALL = /\.(Get|Post|Put|Patch|Delete)Async\s*\(/;

/** Publish-call method names built in by default -- the MassTransit
 * `IPublishEndpoint.Publish`/`PublishAsync` idiom. A worker-queue framework with its own
 * publish method names adds them through `workerPatterns.publishCalls`. */
const DEFAULT_PUBLISH_CALLS = Object.freeze(['Publish']);
/** Consumer base types built in by default -- MassTransit's `IConsumer<T>` plus the
 * plain `BaseConsumer<T>` naming convention. A framework with its own consumer base
 * classes adds them through `workerPatterns.consumerBases`. */
const DEFAULT_CONSUMER_BASES = Object.freeze(['BaseConsumer', 'IConsumer']);
/** Channel-publish method names built in by default -- the StackExchange.Redis
 * `PublishAsync` idiom. Extras come from `workerPatterns.broadcastCalls`. */
const DEFAULT_BROADCAST_CALLS = Object.freeze(['PublishAsync']);

const PROCESSOR_CLASS = /(?<!abstract\s)\bclass\s+(\w+)\s*:\s*(?:[\w.]+\.)*(\w*Processor)\s*<([^<>]*(?:<[^<>]*>[^<>]*)*)>/g;
const SIGNALR_PUSH = /\.(?:SendCoreAsync|SendAsync)\s*\(\s*"([^"]+)"/g;
const EXCHANGE_CONSTANT = /public\s+const\s+string\s+(\w+)\s*=\s*"([^"]+)"\s*;/;
const DI_BINDING = /\.(?:AddScoped|AddTransient|AddSingleton|Register)\s*<\s*(\w+)\s*,\s*(\w+)\s*>\s*\(/g;
/** A field declared as a generic collection of an interface element type --
 * `private readonly List<IFoo> _field = new List<IFoo>();` -- read directly off the class
 * body, independent of constructor injection. Requires a leading access modifier, which C#
 * never allows on a local variable, so this cannot match a collection declared inside a
 * method body. */
const COLLECTION_FIELD_DECLARATION =
  /\b(?:private|protected|internal|public)\b(?:\s+readonly)?\s+(List|IList|ICollection|IEnumerable|IReadOnlyCollection|IReadOnlyList|HashSet|ISet)\s*<\s*(I[A-Za-z]\w*)\s*>\s+(_?\w+)\s*[=;]/g;
/** The `foreach (var x in _field)` header -- `x` is resolved against the loop body
 * separately; this only finds the header itself so the body span can be located. */
const FOREACH_HEADER = /\bforeach\s*\(/g;
/** A `foreach` collection expression that is a bare field reference (`_field` or
 * `this._field`), the only shape the interface-collection fan-out reads -- an expression
 * like `_field.Where(...)` names no single field the walk can resolve an element type for. */
const BARE_FIELD_REF = /^(?:this\.)?(_?\w+)$/;
/** The single-generic-arg factory-registration shape `DI_BINDING` never reads:
 * `AddTransient<TIface>(param => ...)` / `AddScoped<TIface>(param => ...)`. The generic
 * argument gives `TIface`; the concrete type is read separately out of the factory body
 * by `implFromFactoryBody`, since the shape does not name it up front the way the
 * two-argument overload does. */
const DI_FACTORY_CALL = /\.(?:AddScoped|AddTransient|AddSingleton|Register)\s*<\s*(\w+)\s*>\s*\(\s*(\w+)\s*=>/g;
/** The generic handler interface a request type binds to its handler through --
 * MediatR's `IRequestHandler<TRequest[, TResponse]>` and the two CQRS spellings of the same
 * one-request-one-handler shape. `INotificationHandler` is deliberately absent: a notification
 * fans out to many handlers at once, a different shape from the single dispatch read here. */
const MEDIATOR_HANDLER_INTERFACE = /^I(?:Request|Command|Query)Handler$/;
/** The handler entry method, used only when no parameter of the handler's own request
 * type identifies one -- an interface-declared `Handle`/`HandleAsync` with the request arriving
 * under a base or wrapper type. */
const HANDLER_ENTRY_METHOD = /^Handle(?:Async)?$/;
/** `{receiver}.Send(` -- the single-dispatch mediator call, never a member of a longer
 * chain (`a.b.Send(...)` names no receiver this can resolve). `Publish` is out of scope. */
const MEDIATOR_SEND_CALL = /(?:^|[^\w.])((?:this\.)?[A-Za-z_]\w*)\s*\.\s*Send\s*(?:<[^<>]*>)?\s*\(/g;
const MESSAGE_FILE_PATH = /(^|\/)Messaging\/Messages(\/|$)/;
const NAMESPACE_DECLARATION = /namespace\s+([\w.]+)\s*[;{]/;

const FILTER_REGISTRATION_CALL = /\.Filters\.Add\s*\(\s*typeof\s*\(\s*(\w+)\s*\)\s*\)/g;
const EXCEPTION_FILTER_BASE = /:\s*(?:[\w.]+\.)*ExceptionFilterAttribute\b/;
const EXCEPTION_GUARD = /\.Exception\s+is\s+([\w.]+)/g;
const CATCH_CLAUSE = /\bcatch\s*(?:\(\s*([\w.]+)(?:\s+\w+)?\s*\))?/g;
const EXCEPTION_STATUS_CALLS = [
  [/\bStatusCodes\.Status(\d{3})\w*/, (m) => m[1]],
  [/\bStatusCode\s*\(\s*(\d{3})\s*[,)]/, (m) => m[1]],
  [/\bUnauthorized\s*\(/, () => '401'],
  [/\bForbid\s*\(/, () => '403'],
  [/\bNotFound\s*\(/, () => '404'],
  [/\bBadRequest\s*\(/, () => '400'],
  [/\bConflict\s*\(/, () => '409'],
  [/\bNoContent\s*\(/, () => '204'],
  [/\bOk\s*\(/, () => '200'],
];

const CLASS_SIGNATURE = /\b(class|record|struct|interface)\s+(\w+)(?:\s*<([^<>]*)>)?(?:\s*\(([^()]*)\))?/;
const METHOD_SIGNATURE = /(?:public|private|protected|internal)(?:\s+(?:static|virtual|override|async|sealed|abstract|new|readonly|partial|extern|unsafe))*\s+(?:[\w<>[\],.?]+\s+)*?(\w+)\s*(?:<([^<>]*)>)?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*(?:base|this)\s*\([^()]*\))?\s*(?:where\b[^{]*)?$/;
const EXPRESSION_BODY_METHOD = /(?:public|private|protected|internal)(?:\s+(?:static|virtual|override|async|sealed|abstract|new|readonly|partial|extern|unsafe))*\s+(?:[\w<>[\],.?]+\s+)*?(\w+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*(?:base|this)\s*\([^()]*\))?\s*(?:where\b[^{;=]*)?=>/g;
const SELF_CALL = /(?<!\.)\b(?:this\.)?(?:await\s+)?(\w+)\s*(?:<[^<>]*>)?\s*\(/g;

const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const',
  'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern',
  'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface',
  'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override',
  'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
  'nameof', 'when', 'var', 'async', 'await', 'dynamic', 'yield', 'partial', 'get', 'set', 'value', 'add',
  'remove', 'where', 'select', 'from', 'into', 'orderby', 'join', 'let', 'on', 'equals', 'by', 'ascending',
  'descending', 'with', 'init', 'required', 'record',
]);

const IF_TRIGGER = /\bif\s*\(/;
const SWITCH_TRIGGER = /\bswitch\s*\(/;
const ERROR_RETURN_TRIGGER = /\breturn\s+(?:BadRequest|NotFound|Forbid|StatusCode|Unauthorized)\s*\(|\bthrow\s+new\s+\w*Exception\b/;
const GUARD_TRIGGER = /\bif\s*\([^()]*==\s*null\s*\)\s*(?:\{\s*)?return\b|\?\?\s*throw\b/;
const TOGGLE_KEYWORD = /\bIsToggleEnabled\s*\(|\bIsEnabled\s*\(\s*Toggles\.|\bFeatureToggle\b/;
const VALIDATION_KEYWORD = /\bIsValid\s*\(|\bValidate\s*\(|\.Validate\b/;

const MESSAGE_MARKER_INTERFACE = /\bICorrelatedMessage\b|\bIMessage\b|\bCorrelatedBy\s*</;
const MESSAGE_NAME_SUFFIX = /Message$/;

/**
 * Compile the worker-queue pattern set for one extraction run. Every field of
 * `overrides` comes from the top-level `workerPatterns` configuration key, already
 * validated as regex-source strings:
 *
 * - `publishCalls`, `consumerBases`, `broadcastCalls` extend the built-in alternations
 *   above with a framework's own method or base-type names.
 * - `registrations` are whole regexes for a worker-queue framework's registration idiom;
 *   capture group 1 is the processor type, group 2 the work-type name.
 * - `topologyBindings` are whole regexes for a queue-topology binding call; capture
 *   group 1 is the message type, group 2 the work-type name.
 * - `queuePrefixConstants` name the constant whose string literal is the queue-name
 *   prefix, matched in any class — the configured name carries the specificity, so no
 *   class-name shape is imposed on where an estate keeps its constants.
 * - `configReads` name helper methods whose single string argument is a configuration
 *   key, feeding the outbound-HTTP pass.
 *
 * Nothing framework-specific ships by default: with no configuration, the registration,
 * topology-binding, queue-prefix and config-read passes are inert.
 */
function compileWorkerPatterns(overrides = {}) {
  const {
    registrations = [], topologyBindings = [], queuePrefixConstants = [],
    publishCalls = [], consumerBases = [], broadcastCalls = [], configReads = [],
  } = overrides;
  const publish = [...DEFAULT_PUBLISH_CALLS, ...publishCalls].join('|');
  const consumerBase = [...DEFAULT_CONSUMER_BASES, ...consumerBases].join('|');
  const broadcast = [...DEFAULT_BROADCAST_CALLS, ...broadcastCalls].join('|');
  return {
    publishCall: new RegExp(
      `\\b(?:${publish})(?:Async)?\\s*<\\s*(\\w+)\\s*>|\\b(?:${publish})(?:Async)?\\s*\\(\\s*(?:await\\s+)?new\\s+(\\w+)\\b`,
      'g',
    ),
    consumerClass: new RegExp(
      `(?<!abstract\\s)\\bclass\\s+(\\w+)\\s*:\\s*(?:[\\w.]+\\.)*(?:${consumerBase})\\s*<\\s*(?:Batch\\s*<\\s*(\\w+)\\s*>|(\\w+))\\s*>`,
      'g',
    ),
    redisPublishCall: new RegExp(`\\b(?:${broadcast})\\s*\\(\\s*Channels\\.(\\w+)`, 'g'),
    registrations: registrations.map((source) => new RegExp(source, 'g')),
    topologyBindings: topologyBindings.map((source) => new RegExp(source, 'g')),
    workerQueuePrefix: queuePrefixConstants.length > 0
      ? new RegExp(`\\b(?:${queuePrefixConstants.join('|')})\\s*=\\s*"([^"]+)"`)
      : null,
    configKeyAssignment: configReads.length > 0
      ? new RegExp(`(_?[A-Za-z]\\w*)\\s*=\\s*[\\w.]*\\.(?:${configReads.join('|')})\\(\\s*"([^"]+)"\\s*\\)`)
      : null,
  };
}

/**
 * Replace string/char literals and comments with spaces (newlines kept) so brace
 * counting and keyword matching never trip over text that only looks like code.
 */
function maskCsharp(content) {
  const out = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];
    const c2 = i + 1 < n ? content[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && content[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        out.push(content[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    const c3 = i + 2 < n ? content[i + 2] : '';
    const isVerbatim = (c === '@' && c2 === '"') || ((c === '@' && c2 === '$') && c3 === '"') || ((c === '$' && c2 === '@') && c3 === '"');
    if (isVerbatim) {
      const prefixLen = c2 === '"' ? 2 : 3;
      for (let k = 0; k < prefixLen; k += 1) {
        out.push(' ');
        i += 1;
      }
      while (i < n) {
        if (content[i] === '"') {
          if (content[i + 1] === '"') {
            out.push(' ', ' ');
            i += 2;
            continue;
          }
          out.push(' ');
          i += 1;
          break;
        }
        out.push(content[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    if (c === '$' && c2 === '"') {
      out.push(' ', ' ');
      i += 2;
      while (i < n) {
        if (content[i] === '\\') {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (content[i] === '"') {
          out.push(' ');
          i += 1;
          break;
        }
        out.push(content[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      out.push(' ');
      i += 1;
      while (i < n) {
        if (content[i] === '\\') {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (content[i] === '"') {
          out.push(' ');
          i += 1;
          break;
        }
        out.push(content[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      out.push(' ');
      i += 1;
      while (i < n) {
        if (content[i] === '\\') {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (content[i] === "'") {
          out.push(' ');
          i += 1;
          break;
        }
        out.push(' ');
        i += 1;
      }
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function stripAttributes(text) {
  let previous;
  let result = text;
  do {
    previous = result;
    result = result.replace(/\[[^[\]]*\]/g, (m) => ' '.repeat(m.length));
  } while (result !== previous);
  return result;
}

function matchClassHeader(rawHeader) {
  const header = stripAttributes(rawHeader);
  const match = header.match(CLASS_SIGNATURE);
  if (!match) return null;
  return {
    keyword: match[1],
    name: match[2],
    typeParamsText: match[3],
    primaryParamsText: match[4],
    trailer: header.slice(match.index + match[0].length),
  };
}

function matchMethodHeader(rawHeader) {
  const header = stripAttributes(rawHeader);
  if (header.trim() === '') return null;
  const match = header.match(METHOD_SIGNATURE);
  if (!match) return null;
  return { name: match[1], typeParamsText: match[2], paramsText: match[3], matchIndex: match.index };
}

/**
 * Single brace-counting pass that classifies every `{ … }` span in a file as a
 * class/record/struct body, a method (or constructor) body, or an opaque "other"
 * block (if/for/switch/property/lambda/…). Method frames keep a direct reference
 * to their enclosing class frame so later passes never re-search for it.
 */
function scanFrames(masked) {
  const classFrames = [];
  const methodFrames = [];
  const stack = [];
  let lastBoundary = 0;
  const n = masked.length;

  for (let i = 0; i < n; i += 1) {
    const ch = masked[i];
    if (ch === '{') {
      const header = masked.slice(lastBoundary, i);
      const classInfo = matchClassHeader(header);
      if (classInfo) {
        const entry = {
          name: classInfo.name,
          keyword: classInfo.keyword,
          trailer: classInfo.trailer,
          startIndex: i + 1,
          endIndex: null,
          braceIndex: i,
          typeParamsText: classInfo.typeParamsText,
          primaryParamsText: classInfo.primaryParamsText,
        };
        classFrames.push(entry);
        stack.push({ kind: 'class', ref: entry });
      } else {
        const enclosingClass = [...stack].reverse().find((frame) => frame.kind === 'class');
        const methodInfo = matchMethodHeader(header);
        if (methodInfo && enclosingClass) {
          const entry = {
            name: methodInfo.name,
            isCtor: methodInfo.name === enclosingClass.ref.name,
            paramsText: methodInfo.paramsText,
            typeParamsText: methodInfo.typeParamsText,
            classRef: enclosingClass.ref,
            headerIndex: lastBoundary + methodInfo.matchIndex,
            startIndex: i + 1,
            endIndex: null,
          };
          methodFrames.push(entry);
          stack.push({ kind: 'method', ref: entry });
        } else {
          stack.push({ kind: 'other' });
        }
      }
      lastBoundary = i + 1;
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && top.kind !== 'other') {
        top.ref.endIndex = i;
      }
      lastBoundary = i + 1;
      continue;
    }
  }
  return { classFrames, methodFrames };
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '<' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '>' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseParams(paramsText) {
  const text = (paramsText ?? '').trim();
  if (!text) return [];
  return splitTopLevel(text, ',')
    .map((raw) => stripAttributes(raw).trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const withoutDefault = entry.split('=')[0].trim();
      const withoutParamsKeyword = withoutDefault.replace(/\bparams\b/, ' ').trim();
      const tokens = withoutParamsKeyword.split(/\s+/).filter((t) => t !== '');
      if (tokens.length < 2) return null;
      const name = tokens[tokens.length - 1];
      const type = tokens.slice(0, -1).join(' ');
      return { type, name };
    })
    .filter((p) => p !== null);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAssignment(bodyMasked, name) {
  const escaped = escapeRegExp(name);
  const re = new RegExp(`\\b(?:this\\.)?(_?${escaped})\\b\\s*=\\s*\\b${escaped}\\b\\s*;`);
  const match = bodyMasked.match(re);
  return match ? { field: match[1], index: match.index } : null;
}

function findDeclaredField(classBodyMasked, fieldName) {
  const escaped = escapeRegExp(fieldName);
  const re = new RegExp(`\\b(?:private|protected|internal|public)\\b(?:\\s+readonly)?\\s+[\\w<>[\\],.?]+\\s+${escaped}\\s*;`);
  const match = classBodyMasked.match(re);
  return match ? { index: match.index } : null;
}

function classifyBranch(maskedLine) {
  const triggered =
    IF_TRIGGER.test(maskedLine) ||
    SWITCH_TRIGGER.test(maskedLine) ||
    ERROR_RETURN_TRIGGER.test(maskedLine) ||
    GUARD_TRIGGER.test(maskedLine);
  if (!triggered) return null;
  if (TOGGLE_KEYWORD.test(maskedLine)) return 'toggle';
  if (VALIDATION_KEYWORD.test(maskedLine)) return 'validation';
  if (ERROR_RETURN_TRIGGER.test(maskedLine)) return 'error_return';
  if (GUARD_TRIGGER.test(maskedLine)) return 'guard';
  if (SWITCH_TRIGGER.test(maskedLine)) return 'switch';
  return 'if';
}

/**
 * Builds every `ctor_field` fact for a file and, alongside it, a class-frame ->
 * field-name-set map so `extractMethodCalls` knows which `_field.Method(` calls are
 * reachable without re-deriving the same information.
 */
function extractCtorFields(relPath, content, masked, classFrames, methodFrames, facts) {
  const fieldsByClass = new Map();
  const addField = (classRef, field) => {
    if (!fieldsByClass.has(classRef)) fieldsByClass.set(classRef, new Set());
    fieldsByClass.get(classRef).add(field);
  };

  for (const classEntry of classFrames) {
    if (classEntry.endIndex == null || !classEntry.primaryParamsText) continue;
    for (const { type, name } of parseParams(classEntry.primaryParamsText)) {
      facts.push(
        fact('ctor_field', {
          file: relPath,
          line: lineAt(content, classEntry.braceIndex),
          class: classEntry.name,
          field: name,
          paramType: type,
        }),
      );
      addField(classEntry, name);
    }
  }

  for (const ctor of methodFrames) {
    if (!ctor.isCtor || !ctor.classRef || ctor.endIndex == null) continue;
    const params = parseParams(ctor.paramsText);
    if (params.length === 0) continue;
    const bodyMasked = masked.slice(ctor.startIndex, ctor.endIndex);
    const classBodyMasked =
      ctor.classRef.endIndex != null ? masked.slice(ctor.classRef.startIndex, ctor.classRef.endIndex) : '';

    for (const { type, name } of params) {
      const assigned = findAssignment(bodyMasked, name);
      if (assigned) {
        facts.push(
          fact('ctor_field', {
            file: relPath,
            line: lineAt(content, ctor.startIndex + assigned.index),
            class: ctor.classRef.name,
            field: assigned.field,
            paramType: type,
          }),
        );
        addField(ctor.classRef, assigned.field);
        continue;
      }
      const declared = findDeclaredField(classBodyMasked, `_${name}`);
      if (declared) {
        facts.push(
          fact('ctor_field', {
            file: relPath,
            line: lineAt(content, ctor.classRef.startIndex + declared.index),
            class: ctor.classRef.name,
            field: `_${name}`,
            paramType: type,
          }),
        );
        addField(ctor.classRef, `_${name}`);
      }
    }
  }

  // A collection field of an interface element type, populated after construction
  // (e.g. a pipeline's `RegisterFilter` calls) rather than injected -- never reached by the
  // ctor-param passes above, since it is neither a primary-constructor parameter nor a field
  // a constructor body assigns. Skipped when the field already has a fact from those passes,
  // so a genuinely ctor-injected collection field is not double-stated.
  for (const classEntry of classFrames) {
    if (classEntry.endIndex == null) continue;
    const known = fieldsByClass.get(classEntry);
    const classBodyMasked = masked.slice(classEntry.startIndex, classEntry.endIndex);
    COLLECTION_FIELD_DECLARATION.lastIndex = 0;
    let match;
    while ((match = COLLECTION_FIELD_DECLARATION.exec(classBodyMasked))) {
      const [, collectionType, elementType, field] = match;
      if (known && known.has(field)) continue;
      facts.push(
        fact('ctor_field', {
          file: relPath,
          line: lineAt(content, classEntry.startIndex + match.index),
          class: classEntry.name,
          field,
          paramType: `${collectionType}<${elementType}>`,
        }),
      );
      addField(classEntry, field);
    }
  }

  return fieldsByClass;
}

/** `GetRequiredService<T>()`/`GetService<T>()` -- the Microsoft.Extensions.DependencyInjection
 * service-locator idiom -- resolve `T` at the call site rather than through the constructor,
 * so `T` is worth keeping once captured even though the walk cannot follow it from this call
 * alone (see `extractServiceLocatorCalls`, which captures the calls that follow it). */
function isServiceLocatorMethod(calledMethod) {
  return calledMethod === 'GetRequiredService' || calledMethod === 'GetService';
}

function extractMethodCalls(relPath, content, masked, methodFrames, fieldsByClass, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = fieldsByClass.get(method.classRef);
    if (!fields || fields.size === 0) continue;

    const alternation = [...fields]
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length)
      .join('|');
    const callRe = new RegExp(`(?:\\bthis\\.)?\\b(${alternation})\\.(\\w+)\\s*(?:<\\s*([^<>]*)\\s*>)?\\s*\\(`, 'g');
    const body = masked.slice(method.startIndex, method.endIndex);

    let match;
    callRe.lastIndex = 0;
    while ((match = callRe.exec(body))) {
      const calledMethod = match[2];
      if (calledMethod === 'Result' || calledMethod === 'Value') continue;
      const typeArg = match[3] ? match[3].trim() : '';
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, method.startIndex + match.index),
          class: method.classRef.name,
          method: method.name,
          field: match[1],
          calledMethod,
          ...(isServiceLocatorMethod(calledMethod) && typeArg ? { typeArg } : {}),
        }),
      );
    }
  }
}

/**
 * The two shapes a `_field.GetRequiredService<TService>()` / `GetService<TService>()`
 * resolution commonly takes, once the generic argument above is on hand: the resolved
 * instance stored in a local variable and called on a later line --
 * `var pipeline = _serviceProvider.GetRequiredService<ICheckoutPipeline>();` then
 * `pipeline.ProcessAsync(...)` -- or the same call chained straight into its own member --
 * `_serviceProvider.GetRequiredService<T>().Method(...)`. Both emit one extra `method_call`
 * for the *real* call, the one actually made on `TService`, carrying `receiverType: TService`
 * so the walk can resolve it exactly like a declared field without `TService` ever needing a
 * `ctor_field` of its own. A local variable is scoped to the method body it is declared in --
 * two methods reusing the same local name for two different resolved types (`Add`/`Update`
 * each calling their own local `pipeline`) resolve independently, because this walk never
 * leaves the one method body it is built from.
 */
function extractServiceLocatorCalls(relPath, content, masked, methodFrames, fieldsByClass, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = fieldsByClass.get(method.classRef);
    if (!fields || fields.size === 0) continue;

    const alternation = [...fields]
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length)
      .join('|');
    const body = masked.slice(method.startIndex, method.endIndex);

    const chainRe = new RegExp(
      `\\b(?:${alternation})\\.(?:GetRequiredService|GetService)\\s*<\\s*([\\w.]+)\\s*>\\s*\\(\\s*\\)\\s*\\.\\s*(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`,
      'g',
    );
    let match;
    chainRe.lastIndex = 0;
    while ((match = chainRe.exec(body))) {
      const receiverType = match[1].trim();
      const calledMethod = match[2];
      if (calledMethod === 'Result' || calledMethod === 'Value') continue;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, method.startIndex + match.index),
          class: method.classRef.name,
          method: method.name,
          field: receiverType,
          calledMethod,
          receiverType,
        }),
      );
    }

    const assignRe = new RegExp(
      `\\bvar\\s+(\\w+)\\s*=\\s*(?:await\\s+)?(?:${alternation})\\.(?:GetRequiredService|GetService)\\s*<\\s*([\\w.]+)\\s*>\\s*\\(\\s*\\)`,
      'g',
    );
    const locals = new Map();
    assignRe.lastIndex = 0;
    while ((match = assignRe.exec(body))) {
      locals.set(match[1], { receiverType: match[2].trim(), afterIndex: match.index + match[0].length });
    }
    if (locals.size === 0) continue;

    const localAlternation = [...locals.keys()].map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
    const localCallRe = new RegExp(`\\b(${localAlternation})\\.(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`, 'g');
    localCallRe.lastIndex = 0;
    while ((match = localCallRe.exec(body))) {
      const local = locals.get(match[1]);
      if (match.index < local.afterIndex) continue;
      const calledMethod = match[2];
      if (calledMethod === 'Result' || calledMethod === 'Value') continue;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, method.startIndex + match.index),
          class: method.classRef.name,
          method: method.name,
          field: match[1],
          calledMethod,
          receiverType: local.receiverType,
        }),
      );
    }
  }
}

function computeLineStartIndices(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function skipWhitespace(masked, index) {
  let i = index;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  return i;
}

function findMatchingClose(masked, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === openChar) depth += 1;
    else if (masked[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function findMatchingParen(masked, openIndex) {
  return findMatchingClose(masked, openIndex, '(', ')');
}

function findStatementEnd(masked, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) return i;
  }
  return null;
}

/**
 * From right after a condition's `)` (or, for a bare `else`, right after the
 * keyword), resolves whether a `{ … }` block or a single statement follows and
 * returns that span's end line plus the index one past it, for an else-chain
 * lookup to continue from.
 */
function resolveControlledSpan(masked, content, fromIndex) {
  const bodyStart = skipWhitespace(masked, fromIndex);
  if (masked[bodyStart] === '{') {
    const closeIndex = findMatchingClose(masked, bodyStart, '{', '}');
    if (closeIndex == null) return null;
    return { endLine: lineAt(content, closeIndex), afterIndex: closeIndex + 1 };
  }
  const semicolonIndex = findStatementEnd(masked, bodyStart);
  if (semicolonIndex == null) return null;
  return { endLine: lineAt(content, semicolonIndex), afterIndex: semicolonIndex + 1 };
}

/**
 * A call on an *element* of a known field, not on the field itself -- the shape a
 * polymorphic dispatch over a collected list takes (`foreach (var x in _filters) { await
 * x.ProcessAsync(dto); }`), plus the direct-index variant (`_filters[i].ProcessAsync(dto)`).
 * Neither is reachable through `extractMethodCalls`, which only ever matches a call whose
 * receiver text *is* the field name.
 *
 * Emitted as an ordinary `method_call` fact -- `field` names the collection, same as any
 * other receiver-field call -- with an added `elementAccess: true` marker (and, for the
 * `foreach` shape, the loop variable's own name) so the walk knows the field's declared type
 * describes a collection whose *elements* the call runs against, not the collection object
 * itself; the walk fans out over every known implementation of the element's interface
 * rather than resolving a single receiver class.
 */
function extractElementCalls(relPath, content, masked, methodFrames, fieldsByClass, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = fieldsByClass.get(method.classRef);
    if (!fields || fields.size === 0) continue;
    const body = masked.slice(method.startIndex, method.endIndex);

    FOREACH_HEADER.lastIndex = 0;
    let headerMatch;
    while ((headerMatch = FOREACH_HEADER.exec(body))) {
      const openParenIndex = headerMatch.index + headerMatch[0].length - 1;
      const closeParenIndex = findMatchingParen(body, openParenIndex);
      if (closeParenIndex == null) continue;
      const headerText = body.slice(openParenIndex + 1, closeParenIndex);
      const inMatch = headerText.match(/\bin\b/);
      if (!inMatch) continue;
      const declPart = headerText.slice(0, inMatch.index).trim();
      const collectionPart = headerText.slice(inMatch.index + inMatch[0].length).trim();
      const collectionMatch = collectionPart.match(BARE_FIELD_REF);
      if (!collectionMatch || !fields.has(collectionMatch[1])) continue;
      const collectionField = collectionMatch[1];
      const declTokens = declPart.split(/\s+/).filter((token) => token !== '');
      const loopVar = declTokens[declTokens.length - 1];
      if (!loopVar || !/^\w+$/.test(loopVar)) continue;

      const afterParenAbs = method.startIndex + closeParenIndex + 1;
      const span = resolveControlledSpan(masked, content, afterParenAbs);
      if (!span) continue;
      const bodyStartAbs = method.startIndex + skipWhitespace(body, closeParenIndex + 1);
      const bodyEndAbs = span.afterIndex - 1;
      if (bodyEndAbs <= bodyStartAbs) continue;
      const loopBody = masked.slice(bodyStartAbs, bodyEndAbs);

      const callRe = new RegExp(`(?:\\bthis\\.)?\\b${escapeRegExp(loopVar)}\\.(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`, 'g');
      let callMatch;
      callRe.lastIndex = 0;
      while ((callMatch = callRe.exec(loopBody))) {
        const calledMethod = callMatch[1];
        if (calledMethod === 'Result' || calledMethod === 'Value') continue;
        facts.push(
          fact('method_call', {
            file: relPath,
            line: lineAt(content, bodyStartAbs + callMatch.index),
            class: method.classRef.name,
            method: method.name,
            field: collectionField,
            calledMethod,
            elementAccess: true,
            loopVar,
          }),
        );
      }
    }

    const alternation = [...fields].map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
    const indexedRe = new RegExp(`(?:\\bthis\\.)?\\b(${alternation})\\s*\\[[^\\]]*\\]\\s*\\.(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`, 'g');
    indexedRe.lastIndex = 0;
    let indexedMatch;
    while ((indexedMatch = indexedRe.exec(body))) {
      const calledMethod = indexedMatch[2];
      if (calledMethod === 'Result' || calledMethod === 'Value') continue;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, method.startIndex + indexedMatch.index),
          class: method.classRef.name,
          method: method.name,
          field: indexedMatch[1],
          calledMethod,
          elementAccess: true,
        }),
      );
    }
  }
}

/**
 * `class X : ..., IFoo, ...` read straight off the class header -- an interface
 * implementation stated at the declaration itself, independent of whether anything registers
 * it in DI. Interface, struct and record declarations never qualify (an interface's own base
 * list extends other interfaces; it does not implement them). Only a base-list entry shaped
 * like the common interface convention (`I` + an uppercase letter) is kept, the same
 * convention `resolveReceiverClass`'s `IFoo` -> `Foo` fallback already trusts elsewhere in
 * this file -- a plain base class is never mistaken for an interface.
 */
function parseBaseInterfaces(trailer) {
  if (!trailer) return [];
  let text = trailer.trim();
  if (!text.startsWith(':')) return [];
  text = text.slice(1);
  const whereMatch = text.match(/\bwhere\b/);
  if (whereMatch) text = text.slice(0, whereMatch.index);
  const names = [];
  for (const entry of splitTopLevel(text, ',')) {
    const identifier = entry.trim().match(/^([\w.]+)/);
    if (!identifier) continue;
    const bare = identifier[1];
    const dot = bare.lastIndexOf('.');
    const name = dot === -1 ? bare : bare.slice(dot + 1);
    if (/^I[A-Z]\w*$/.test(name)) names.push(name);
  }
  return names;
}

function extractIfaceImpl(relPath, content, classFrames, facts) {
  for (const classEntry of classFrames) {
    if (classEntry.keyword !== 'class' || classEntry.endIndex == null) continue;
    for (const iface of parseBaseInterfaces(classEntry.trailer)) {
      facts.push(
        fact('iface_impl', {
          file: relPath,
          line: lineAt(content, classEntry.braceIndex),
          class: classEntry.name,
          iface,
        }),
      );
    }
  }
}

/**
 * Finds the `if (`/`switch (` on a branch trigger line and returns the index
 * right after its condition's matching `)`, or null for the bare `x ?? throw …`
 * guard form, which has no condition to speak of.
 */
function conditionEndIndexFor(masked, lineStart, lineEnd) {
  const lineText = masked.slice(lineStart, lineEnd);
  const match = lineText.match(/\b(?:if|switch)\s*\(/);
  if (!match) return null;
  const openParenIndex = lineStart + match.index + match[0].length - 1;
  const closeParenIndex = findMatchingParen(masked, openParenIndex);
  return closeParenIndex == null ? null : closeParenIndex + 1;
}

/**
 * Looks for `else` (optionally `else if (…)`) right after a resolved span and,
 * if found, resolves its own controlled span the same way.
 */
function resolveElseBranch(masked, content, afterIndex) {
  const elseStart = skipWhitespace(masked, afterIndex);
  if (masked.slice(elseStart, elseStart + 4) !== 'else' || /\w/.test(masked[elseStart + 4] ?? '')) return null;
  let cursor = skipWhitespace(masked, elseStart + 4);
  if (masked.slice(cursor, cursor + 2) === 'if' && !/\w/.test(masked[cursor + 2] ?? '')) {
    const ifCursor = skipWhitespace(masked, cursor + 2);
    if (masked[ifCursor] !== '(') return null;
    const closeParenIndex = findMatchingParen(masked, ifCursor);
    if (closeParenIndex == null) return null;
    cursor = closeParenIndex + 1;
  }
  const span = resolveControlledSpan(masked, content, cursor);
  if (!span) return null;
  return { line: lineAt(content, elseStart), endLine: span.endLine, afterIndex: span.afterIndex };
}

/**
 * Every branch_point carries `endLine`: the block's closing brace, the single
 * statement's own line when there is no block, or the trigger's own line for
 * `error_return` and the bare `?? throw` guard. `if`/`toggle`/`validation`/`guard`
 * branches also check for a following `else`/`else if`, emitted as its own
 * `branch_point` (`kind: 'else'`) so the joiner can gate the not-taken path too.
 */
function extractBranchPoints(relPath, content, masked, methodFrames, facts) {
  const contentLines = content.split(/\r\n|\r|\n/);
  const maskedLines = masked.split(/\r\n|\r|\n/);
  const lineStarts = computeLineStartIndices(content);

  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const startLine = lineAt(content, method.startIndex);
    const methodEndLine = lineAt(content, method.endIndex);
    for (let ln = startLine; ln <= methodEndLine; ln += 1) {
      const maskedLine = maskedLines[ln - 1] ?? '';
      const kind = classifyBranch(maskedLine);
      if (!kind) continue;

      const text = (contentLines[ln - 1] ?? '').trim().slice(0, 120);
      const base = { file: relPath, line: ln, class: method.classRef.name, method: method.name };

      if (kind === 'error_return') {
        facts.push(fact('branch_point', { ...base, kind, text, endLine: ln }));
        continue;
      }

      const lineStart = lineStarts[ln - 1];
      const lineEnd = ln < lineStarts.length ? lineStarts[ln] - 1 : masked.length;
      const conditionEnd = conditionEndIndexFor(masked, lineStart, lineEnd);
      if (conditionEnd == null) {
        facts.push(fact('branch_point', { ...base, kind, text, endLine: ln }));
        continue;
      }

      const span = resolveControlledSpan(masked, content, conditionEnd);
      facts.push(fact('branch_point', { ...base, kind, text, endLine: span ? span.endLine : ln }));

      if (span && kind !== 'switch') {
        const elseBranch = resolveElseBranch(masked, content, span.afterIndex);
        if (elseBranch) {
          const elseText = (contentLines[elseBranch.line - 1] ?? '').trim().slice(0, 120);
          facts.push(
            fact('branch_point', {
              ...base,
              line: elseBranch.line,
              kind: 'else',
              text: elseText,
              endLine: elseBranch.endLine,
            }),
          );
        }
      }
    }
  }
}

function extractRedisPublish(relPath, content, masked, facts, patterns) {
  patterns.redisPublishCall.lastIndex = 0;
  let match;
  while ((match = patterns.redisPublishCall.exec(masked))) {
    facts.push(
      fact('redis_publish', {
        file: relPath,
        line: lineAt(content, match.index),
        channel: match[1],
      }),
    );
  }
}

function findEnclosingClass(classFrames, position) {
  let best = null;
  for (const entry of classFrames) {
    if (entry.endIndex == null) continue;
    if (position >= entry.startIndex && position < entry.endIndex && (!best || entry.startIndex > best.startIndex)) {
      best = entry;
    }
  }
  return best;
}

function findEnclosingMethod(methodFrames, position) {
  let best = null;
  for (const entry of methodFrames) {
    if (entry.endIndex == null) continue;
    if (position >= entry.startIndex && position < entry.endIndex && (!best || entry.startIndex > best.startIndex)) {
      best = entry;
    }
  }
  return best;
}

const GENERIC_TYPE_PARAM_NAME = /^T([A-Z]\w*)?$/;

function typeParamNames(typeParamsText) {
  if (!typeParamsText) return new Set();
  return new Set(
    splitTopLevel(typeParamsText, ',')
      .map((part) => part.trim().split(/\s+/).filter(Boolean).pop())
      .filter((name) => name),
  );
}

/**
 * A captured `publish` message name like `TMessage` is a generic type parameter,
 * not a real message, when it matches the `T`/`TXxx` naming convention AND is
 * actually declared as a type parameter of the enclosing method or class. The
 * concrete publishes at that generic helper's own call sites (`new X` / `<X>`)
 * are captured separately, so suppressing this one loses nothing.
 */
function isGenericTypeParamMessage(message, classFrames, methodFrames, position) {
  if (!GENERIC_TYPE_PARAM_NAME.test(message)) return false;
  const method = findEnclosingMethod(methodFrames, position);
  if (method && typeParamNames(method.typeParamsText).has(message)) return true;
  const classEntry = findEnclosingClass(classFrames, position);
  if (classEntry && typeParamNames(classEntry.typeParamsText).has(message)) return true;
  return false;
}

/**
 * `SomeMethod<TMessage>(TMessage message, ...)` -- a generic method's OWN
 * declaration -- matches the publish-call pattern's `<T>` alternative exactly like a real
 * call would, but is neither: interface method declarations never get a body
 * (no `method_span` frame is possible), and a concrete method's own signature
 * line sits just outside its body span. The declared type immediately
 * reappearing as the first parameter's type is a structural tell that this is
 * a declaration, not a call.
 */
function looksLikeGenericDeclarationEcho(content, matchEndIndex, name) {
  const window = content.slice(matchEndIndex, matchEndIndex + name.length + 8);
  const re = new RegExp(`^\\s*\\(\\s*${escapeRegExp(name)}\\b`);
  return re.test(window);
}

/**
 * One `method_span` per method/constructor body the brace scanner already
 * delimited: `line` is the signature's own start line, `endLine` its matching
 * closing brace. Lets the joiner attach file-level facts (`publish`,
 * `redis_publish`, `signalr_push`, `http_out`) to the method that actually
 * contains them instead of to the whole file.
 */
function extractMethodSpans(relPath, content, methodFrames, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineAt(content, method.headerIndex),
        endLine: lineAt(content, method.endIndex),
        class: method.classRef.name,
        method: method.name,
      }),
    );
  }
}

function findExpressionBodiedMethods(masked, classFrames) {
  const results = [];
  EXPRESSION_BODY_METHOD.lastIndex = 0;
  let match;
  while ((match = EXPRESSION_BODY_METHOD.exec(masked))) {
    const semicolonIndex = findStatementEnd(masked, match.index + match[0].length);
    if (semicolonIndex == null) continue;
    const classEntry = findEnclosingClass(classFrames, match.index);
    if (!classEntry) continue;
    results.push({ name: match[1], classEntry, matchIndex: match.index, semicolonIndex });
  }
  return results;
}

function extractExpressionBodiedMethodSpans(relPath, content, expressionBodiedMethods, facts) {
  for (const entry of expressionBodiedMethods) {
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineAt(content, entry.matchIndex),
        endLine: lineAt(content, entry.semicolonIndex),
        class: entry.classEntry.name,
        method: entry.name,
      }),
    );
  }
}

/**
 * Names of every declared method (brace-bodied or expression-bodied) per class,
 * "any overload" collapsed into one entry since self-calls are matched by name
 * only. Constructors are included too, though they are never legally called
 * like this from inside a method body, so their presence is harmless.
 */
function buildMethodNamesByClass(methodFrames, expressionBodiedMethods) {
  const byClass = new Map();
  const add = (classRef, name) => {
    if (!byClass.has(classRef)) byClass.set(classRef, new Set());
    byClass.get(classRef).add(name);
  };
  for (const method of methodFrames) {
    if (method.classRef) add(method.classRef, method.name);
  }
  for (const entry of expressionBodiedMethods) {
    add(entry.classEntry, entry.name);
  }
  return byClass;
}

function isDeclarationContinuation(masked, index) {
  const start = skipWhitespace(masked, index);
  if (masked[start] === '{') return true;
  return masked.slice(start, start + 2) === '=>';
}

/**
 * `Name(`/`this.Name(`/`await Name(` inside a method body, where `Name` is a
 * declared method of the SAME class (any overload), is a same-class call the
 * joiner can follow without a `di_binding`. Excluded: C# keywords, `nameof`/
 * `typeof`, a ctor_field of the same name, and anything immediately followed by
 * `{`/`=>` -- a local-function declaration, not a call.
 */
function extractSelfCalls(relPath, content, masked, methodFrames, methodNamesByClass, fieldsByClass, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const methodNames = methodNamesByClass.get(method.classRef);
    if (!methodNames || methodNames.size === 0) continue;
    const fieldNames = fieldsByClass.get(method.classRef) ?? new Set();

    const body = masked.slice(method.startIndex, method.endIndex);
    SELF_CALL.lastIndex = 0;
    let match;
    while ((match = SELF_CALL.exec(body))) {
      const name = match[1];
      if (CSHARP_KEYWORDS.has(name)) continue;
      if (fieldNames.has(name)) continue;
      if (!methodNames.has(name)) continue;

      const openParenIndex = method.startIndex + match.index + match[0].length - 1;
      const closeParenIndex = findMatchingParen(masked, openParenIndex);
      if (closeParenIndex == null) continue;
      if (isDeclarationContinuation(masked, closeParenIndex + 1)) continue;

      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, method.startIndex + match.index),
          class: method.classRef.name,
          method: method.name,
          field: 'this',
          calledMethod: name,
        }),
      );
    }
  }
}

function toRelativePath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split('\\').join('/');
}

function lineAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function stringArgument(argText) {
  if (argText === undefined) return '';
  const match = argText.match(/"([^"]*)"/);
  return match ? match[1] : '';
}

function joinTemplate(base, extra) {
  const parts = [];
  if (base) parts.push(base.replace(/^\/+|\/+$/g, ''));
  if (extra) parts.push(extra.replace(/^\/+|\/+$/g, ''));
  return parts.filter((part) => part !== '').join('/');
}

/**
 * Resolve ASP.NET Core's own route-template tokens against the declaring class
 * and method, so two actions sharing one `[Route("[controller]/[action]")]` attribute end
 * up as two distinct route keys instead of one. `[controller]` becomes the class name with
 * a trailing `Controller` removed (a class named exactly `Controller` keeps its name rather
 * than resolving to nothing); `[action]` becomes the method name exactly as the route fact
 * records it, async suffix included, so `template` and `action` never disagree. A template
 * carrying neither token is returned untouched.
 */
function expandRouteTokens(template, controllerName, actionName) {
  if (typeof template !== 'string' || !template.includes('[')) return template;
  return template.replace(ROUTE_TEMPLATE_TOKEN, (match, token) => {
    if (token.toLowerCase() === 'controller') {
      if (!controllerName) return match;
      return controllerName.replace(/Controller$/, '') || controllerName;
    }
    return actionName || match;
  });
}

function extractRoutes(relPath, content, facts) {
  const lines = content.split(/\r\n|\r|\n/);
  let sawClass = false;
  let controllerName = null;
  let classTemplate = '';
  let pendingAttrs = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim() === '') continue;

    const attrMatch = line.match(ATTRIBUTE_LINE);
    if (attrMatch) {
      pendingAttrs.push({ name: attrMatch[1], arg: attrMatch[2], line: i + 1 });
      continue;
    }

    if (!sawClass) {
      const classMatch = line.match(/\bclass\s+(\w+)\b/);
      if (classMatch) {
        sawClass = true;
        controllerName = classMatch[1];
        const routeAttr = pendingAttrs.find((a) => a.name === 'Route');
        classTemplate = routeAttr ? stringArgument(routeAttr.arg) : '';
      }
      pendingAttrs = [];
      continue;
    }

    const hasModifier = /\b(public|protected|internal|private)\b/.test(line);
    if (hasModifier && line.includes('(')) {
      const httpAttrs = pendingAttrs.filter((a) => HTTP_VERB_ATTRIBUTE.test(a.name));
      const routeAttrs = pendingAttrs.filter((a) => a.name === 'Route');
      if (httpAttrs.length > 0 || routeAttrs.length > 0) {
        const actionMatch = line.match(/(\w+)\s*\(/);
        const action = actionMatch ? actionMatch[1] : null;
        if (action && action !== controllerName) {
          const bareVerbs = [];
          for (const attr of httpAttrs) {
            const verb = attr.name.match(HTTP_VERB_ATTRIBUTE)[1].toUpperCase();
            if (attr.arg === undefined) {
              bareVerbs.push({ verb, line: attr.line });
              continue;
            }
            const template = expandRouteTokens(
              joinTemplate(classTemplate, stringArgument(attr.arg)),
              controllerName,
              action,
            );
            facts.push(
              fact('route', {
                file: relPath,
                line: attr.line,
                controller: controllerName,
                action,
                verb,
                template,
              }),
            );
          }

          if (routeAttrs.length > 0) {
            for (const routeAttr of routeAttrs) {
              const template = expandRouteTokens(
                joinTemplate(classTemplate, stringArgument(routeAttr.arg)),
                controllerName,
                action,
              );
              const verbs = bareVerbs.length > 0 ? bareVerbs.map((b) => b.verb) : ['ANY'];
              for (const verb of verbs) {
                facts.push(
                  fact('route', {
                    file: relPath,
                    line: routeAttr.line,
                    controller: controllerName,
                    action,
                    verb,
                    template,
                  }),
                );
              }
            }
          } else {
            for (const bare of bareVerbs) {
              facts.push(
                fact('route', {
                  file: relPath,
                  line: bare.line,
                  controller: controllerName,
                  action,
                  verb: bare.verb,
                  template: expandRouteTokens(joinTemplate(classTemplate, ''), controllerName, action),
                }),
              );
            }
          }
        }
      }
    }
    pendingAttrs = [];
  }
}

/**
 * Every `[Route("…")]` template declared on a class in this file, by class name.
 *
 * Read line-at-a-time the same way the controller-action pass reads its own class
 * attribute, and shared by the Razor Page and endpoint-class passes so all three agree on
 * what a class-level route override looks like.
 */
function classRouteTemplates(content) {
  const lines = content.split(/\r\n|\r|\n/);
  const byClass = new Map();
  let pending = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const attrMatch = line.match(ATTRIBUTE_LINE);
    if (attrMatch) {
      pending.push(attrMatch);
      continue;
    }
    const classMatch = line.match(/\bclass\s+(\w+)\b/);
    if (classMatch) {
      const routeAttr = pending.find((a) => a[1] === 'Route');
      if (routeAttr) byClass.set(classMatch[1], stringArgument(routeAttr[2]));
    }
    pending = [];
  }
  return byClass;
}

/**
 * The conventional route a Razor Page's own location derives -- the path under
 * the nearest `Pages/` root, prefixed by the area name when the page lives under
 * `Areas/<area>/Pages/`. A file outside any `Pages/` root keeps its own path, which is the
 * only thing left to key it by.
 */
function razorPagePath(relPath) {
  const withoutExtension = relPath.replace(RAZOR_PAGE_CODE_BEHIND, '');
  const marker = '/Pages/';
  const at = withoutExtension.lastIndexOf(marker);
  let underPages = null;
  if (at !== -1) underPages = withoutExtension.slice(at + marker.length);
  else if (withoutExtension.startsWith('Pages/')) underPages = withoutExtension.slice('Pages/'.length);
  if (underPages === null || underPages === '') return withoutExtension;
  const area = withoutExtension.match(AREA_PAGES_SEGMENT);
  return area ? joinTemplate(area[1], underPages) : underPages;
}

/**
 * The `@page` directive's route template, read off the sibling `.cshtml` view.
 * Returns the template (possibly the empty string for a bare `@page`), or `null` when
 * there is no view file or its first meaningful line is not a `@page` directive.
 */
function razorPageRouteTemplate(absPath) {
  if (typeof absPath !== 'string') return null;
  let source;
  try {
    source = readFileSync(absPath.replace(/\.cs$/, ''), 'utf8');
  } catch {
    return null;
  }
  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (line.trim() === '') continue;
    const match = line.match(PAGE_ROUTE_DIRECTIVE);
    return match ? (match[1] ?? '') : null;
  }
  return null;
}

/**
 * Fold a `@page` route template into the derived page path. A template starting
 * with `/` replaces the derived path outright, which is what the directive means; any
 * other template appends to it.
 */
function composePageRoute(derivedPath, directiveTemplate) {
  if (!directiveTemplate) return derivedPath;
  const trimmed = directiveTemplate.trim();
  if (trimmed === '') return derivedPath;
  if (trimmed.startsWith('/')) return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  return joinTemplate(derivedPath, trimmed);
}

/**
 * Substitute a named handler into the page template's `{handler?}` token, and
 * drop the token entirely for an unnamed one, so `OnPost` and `OnPostUpdate` on a page
 * routed `"{handler?}"` end up as two keys rather than one.
 */
function applyPageHandler(template, handlerName) {
  if (!PAGE_HANDLER_TOKEN.test(template)) return template;
  return template
    .replace(PAGE_HANDLER_TOKEN, handlerName ?? '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * One `route` fact per Razor Page handler.
 *
 * A page's route comes from its file's location plus convention, not from an attribute, so
 * this pass is keyed by the `*.cshtml.cs` file name and by the `On{Verb}` method-name
 * convention rather than by anything the controller-action pass looks for. A class-level
 * `[Route]` attribute or a `@page` route template overrides the derived path, in that
 * order. A named handler (`OnPostUpdate`) keeps its name in the optional `handler` field
 * whether or not the page's own template puts it in the path.
 */
function extractRazorPageRoutes(relPath, absPath, content, classFrames, methodFrames, facts) {
  if (!RAZOR_PAGE_CODE_BEHIND.test(relPath)) return;
  if (methodFrames.length === 0) return;
  const derived = razorPagePath(relPath);
  const directive = razorPageRouteTemplate(absPath);
  const classTemplates = classRouteTemplates(content);

  for (const frame of methodFrames) {
    const match = frame.name.match(RAZOR_PAGE_HANDLER);
    if (!match) continue;
    if (!content.startsWith('public', frame.headerIndex)) continue;
    const className = frame.classRef ? frame.classRef.name : basename(relPath).replace(/\.cshtml\.cs$/, '');
    const handler = match[2].replace(/Async$/, '');
    const override = classTemplates.get(className);
    const base = override
      ? composePageRoute(override.replace(/^\/+|\/+$/g, ''), '')
      : composePageRoute(derived, directive ?? '');
    const template = applyPageHandler(base, handler);
    facts.push(
      fact('route', {
        file: relPath,
        line: lineAt(content, frame.headerIndex),
        controller: className,
        action: frame.name,
        verb: match[1].toUpperCase(),
        template,
        ...(handler === '' ? {} : { handler }),
      }),
    );
  }
}

/** Resolve a route group's own prefix, following the chain a group of a group builds. */
function mapGroupPrefix(groups, name, depth = 0) {
  const entry = groups.get(name);
  if (!entry || depth > 8) return '';
  return joinTemplate(mapGroupPrefix(groups, entry.receiver, depth + 1), entry.template);
}

/**
 * The `ordinal`-th argument that follows the route template, split on commas the nesting
 * depth leaves at the top level so a verb array or a lambda parameter list never counts as
 * an argument boundary. `masked` supplies the depth, `raw` the text to return.
 */
function argumentAfterTemplate(raw, masked, ordinal) {
  let depth = 0;
  let seen = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const ch = masked[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      seen += 1;
      if (seen === ordinal) return raw.slice(index + 1);
    }
  }
  return null;
}

/**
 * The handler argument of a minimal-API registration -- the argument straight
 * after the template, except for `MapMethods`, whose verb list sits between the two.
 * Returns the referenced method name when the handler is a method group, and `null` when
 * it is an inline lambda, which names no method to continue into.
 */
function minimalApiHandler(content, masked, openParenIndex, templateEndIndex, ordinal) {
  const close = findMatchingParen(masked, openParenIndex);
  if (close === null) return { action: null, argsEnd: templateEndIndex };
  const argText = argumentAfterTemplate(
    content.slice(templateEndIndex, close),
    masked.slice(templateEndIndex, close),
    ordinal,
  );
  if (argText === null) return { action: null, argsEnd: close };
  const methodGroup = argText.match(METHOD_GROUP_ARGUMENT);
  return { action: methodGroup ? methodGroup[1] : null, argsEnd: close };
}

/**
 * One `route` fact per minimal-API `Map{Verb}` registration.
 *
 * The route is a fluent call on the endpoint-route builder rather than an attribute, so
 * nothing the controller-action pass reads applies. A `MapGroup` prefix -- bound to a
 * variable or chained inline -- composes into the emitted template rather than being lost,
 * and `MapMethods` contributes one fact per verb it lists. `controller` and `action` name
 * what the walk continues into: the method group when the handler is one, otherwise the
 * method whose body the lambda sits in, which is where the lambda's own call facts land.
 */
function extractMinimalApiRoutes(relPath, content, masked, classFrames, methodFrames, facts) {
  if (!content.includes('.Map')) return;
  const groups = new Map();
  MAP_GROUP_ASSIGNMENT.lastIndex = 0;
  for (let m = MAP_GROUP_ASSIGNMENT.exec(content); m; m = MAP_GROUP_ASSIGNMENT.exec(content)) {
    if (masked.slice(m.index, m.index + m[0].length).includes('MapGroup')) {
      groups.set(m[1], { receiver: m[2], template: m[3] });
    }
  }

  const found = [];
  const emit = (matchIndex, verbWord, template, openParenIndex, templateEndIndex) => {
    if (!masked.slice(matchIndex, openParenIndex + 1).includes('.Map')) return;
    const { action: methodGroup, argsEnd } = minimalApiHandler(
      content,
      masked,
      openParenIndex,
      templateEndIndex,
      verbWord === 'Methods' ? 2 : 1,
    );
    const enclosingClass = findEnclosingClass(classFrames, matchIndex);
    const enclosingMethod = findEnclosingMethod(methodFrames, matchIndex);
    const controller = enclosingClass ? enclosingClass.name : basename(relPath).replace(/\.cs$/, '');
    const action = methodGroup ?? (enclosingMethod ? enclosingMethod.name : `Map${verbWord}`);
    const verbs = [];
    if (verbWord === 'Methods') {
      for (const quoted of content.slice(templateEndIndex, argsEnd).matchAll(/"([A-Za-z]+)"/g)) {
        const upper = quoted[1].toUpperCase();
        if (HTTP_VERB_WORDS.has(upper) && !verbs.includes(upper)) verbs.push(upper);
      }
      if (verbs.length === 0) verbs.push('ANY');
    } else {
      verbs.push(verbWord.toUpperCase());
    }
    for (const verb of verbs) {
      found.push({
        at: matchIndex,
        route: fact('route', {
          file: relPath,
          line: lineAt(content, matchIndex),
          controller,
          action,
          verb,
          template,
        }),
      });
    }
  };

  const inlineGroupAt = new Set();
  INLINE_MAP_GROUP_CALL.lastIndex = 0;
  for (let m = INLINE_MAP_GROUP_CALL.exec(content); m; m = INLINE_MAP_GROUP_CALL.exec(content)) {
    const mapIndex = m.index + m[0].indexOf(`.Map${m[2]}`, m[1].length);
    inlineGroupAt.add(mapIndex);
    const openParen = content.indexOf('(', mapIndex);
    const templateEnd = m.index + m[0].length - 1;
    emit(m.index, m[2], joinTemplate(m[1], m[3]), openParen, templateEnd);
  }

  MINIMAL_API_MAP_CALL.lastIndex = 0;
  for (let m = MINIMAL_API_MAP_CALL.exec(content); m; m = MINIMAL_API_MAP_CALL.exec(content)) {
    const mapIndex = m.index + m[0].indexOf(`.Map${m[2]}`);
    if (inlineGroupAt.has(mapIndex)) continue;
    const openParen = content.indexOf('(', mapIndex);
    const templateEnd = m.index + m[0].length - 1;
    emit(m.index, m[2], joinTemplate(mapGroupPrefix(groups, m[1]), m[3]), openParen, templateEnd);
  }

  found.sort((a, b) => a.at - b.at);
  for (const entry of found) facts.push(entry.route);
}

/**
 * The attribute block that sits directly above a member, as a `[start, end)` slice
 * of `content`.
 *
 * Walks upward a line at a time, staying inside an attribute whose brackets have not closed
 * yet, so a multi-line attribute (`[SwaggerOperation( … )]`) is part of the block rather
 * than the end of it. Bracket counting reads the masked text, so a `]` inside a string or a
 * comment never closes anything.
 */
function attributeBlockStart(content, masked, headerIndex) {
  let cursor = content.lastIndexOf('\n', headerIndex - 1) + 1;
  let start = cursor;
  let depth = 0;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = content.lastIndexOf('\n', previousEnd - 1) + 1;
    const rawLine = content.slice(previousStart, previousEnd).trim();
    if (depth === 0 && !rawLine.endsWith(']')) break;
    const maskedLine = masked.slice(previousStart, previousEnd);
    depth += (maskedLine.match(/\]/g) ?? []).length - (maskedLine.match(/\[/g) ?? []).length;
    start = previousStart;
    cursor = previousStart;
  }
  return start;
}

/** The identity a route fact is deduplicated by when two passes can both see it. */
function routeSignature(routeFact) {
  return [routeFact.controller, routeFact.action, routeFact.verb, routeFact.template].join('|');
}

/**
 * One `route` fact per route-attributed method of a single-endpoint class.
 *
 * An endpoint class carries its route exactly the way a controller action does, but is
 * never a controller, and its verb attribute is routinely separated from its method by a
 * multi-line `[SwaggerOperation( … )]` the line-at-a-time controller pass cannot see past.
 * The base is matched by shape (`.WithRequest<…>.WithActionResult<…>`) rather than by name.
 * Anything the controller-action pass already emitted for this file is left alone.
 */
function extractEndpointClassRoutes(relPath, content, masked, classFrames, methodFrames, facts) {
  const endpointClasses = classFrames.filter(
    (frame) => frame.keyword === 'class' && ENDPOINT_BASE_SHAPE.test(frame.trailer ?? ''),
  );
  if (endpointClasses.length === 0) return;
  const classTemplates = classRouteTemplates(content);
  const seen = new Set(
    facts.filter((f) => f.type === 'route' && f.file === relPath).map(routeSignature),
  );

  for (const frame of endpointClasses) {
    const classTemplate = classTemplates.get(frame.name) ?? '';
    for (const method of methodFrames) {
      if (method.classRef !== frame) continue;
      if (method.isCtor) continue;
      const blockStart = attributeBlockStart(content, masked, method.headerIndex);
      if (blockStart >= method.headerIndex) continue;
      const block = content.slice(blockStart, method.headerIndex);

      const bareVerbs = [];
      const emitted = [];
      HTTP_VERB_ATTRIBUTE_CALL.lastIndex = 0;
      for (let m = HTTP_VERB_ATTRIBUTE_CALL.exec(block); m; m = HTTP_VERB_ATTRIBUTE_CALL.exec(block)) {
        const verb = m[1].toUpperCase();
        const line = lineAt(content, blockStart + m.index);
        if (m[2] === undefined) {
          bareVerbs.push({ verb, line });
          continue;
        }
        emitted.push({ verb, template: joinTemplate(classTemplate, m[2]), line });
      }
      ROUTE_ATTRIBUTE_CALL.lastIndex = 0;
      for (let m = ROUTE_ATTRIBUTE_CALL.exec(block); m; m = ROUTE_ATTRIBUTE_CALL.exec(block)) {
        const template = joinTemplate(classTemplate, m[1]);
        const line = lineAt(content, blockStart + m.index);
        const verbs = bareVerbs.length > 0 ? bareVerbs.map((b) => b.verb) : ['ANY'];
        for (const verb of verbs) emitted.push({ verb, template, line });
        bareVerbs.length = 0;
      }
      for (const bare of bareVerbs) {
        emitted.push({ verb: bare.verb, template: classTemplate, line: bare.line });
      }

      for (const entry of emitted) {
        const candidate = fact('route', {
          file: relPath,
          line: entry.line,
          controller: frame.name,
          action: method.name,
          verb: entry.verb,
          template: expandRouteTokens(entry.template, frame.name, method.name),
        });
        const signature = routeSignature(candidate);
        if (seen.has(signature)) continue;
        seen.add(signature);
        facts.push(candidate);
      }
    }
  }
}

function extractHttpOut(relPath, content, facts, patterns) {
  if (!patterns.configKeyAssignment) return;
  const lines = content.split(/\r\n|\r|\n/);
  const configVars = new Map();

  for (const line of lines) {
    const match = line.match(patterns.configKeyAssignment);
    if (match) configVars.set(match[1], match[2]);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(INTERPOLATED_URL);
    if (!match) continue;
    const [, varName, rest] = match;
    if (!configVars.has(varName)) continue;

    const template = rest.replace(/^\/+/, '');
    if (!template) continue;

    let verb;
    for (let j = i; j < Math.min(lines.length, i + 6); j += 1) {
      const verbMatch = lines[j].match(OUTBOUND_VERB_CALL);
      if (verbMatch) {
        verb = verbMatch[1].toUpperCase();
        break;
      }
    }

    const fields = { file: relPath, line: i + 1, configKey: configVars.get(varName), template };
    if (verb) fields.verb = verb;
    facts.push(fact('http_out', fields));
  }
}

function extractPublish(relPath, content, facts, messageIndex, classFrames, methodFrames, patterns) {
  patterns.publishCall.lastIndex = 0;
  let match;
  while ((match = patterns.publishCall.exec(content))) {
    const message = match[1] || match[2];
    if (!message) continue;
    if (isGenericTypeParamMessage(message, classFrames, methodFrames, match.index)) continue;
    if (
      match[1] &&
      GENERIC_TYPE_PARAM_NAME.test(message) &&
      looksLikeGenericDeclarationEcho(content, match.index + match[0].length, message)
    ) {
      continue;
    }
    const fields = { file: relPath, line: lineAt(content, match.index), message };
    const fqn = messageIndex.get(message);
    if (fqn) fields.fqn = fqn;
    facts.push(fact('publish', fields));
  }
}

function extractConsume(relPath, content, facts, patterns) {
  patterns.consumerClass.lastIndex = 0;
  let match;
  while ((match = patterns.consumerClass.exec(content))) {
    const consumer = match[1];
    const message = match[2] || match[3];
    if (!message) continue;
    facts.push(
      fact('consume', {
        file: relPath,
        line: lineAt(content, match.index),
        message,
        consumer,
      }),
    );
  }
}

function extractWorkerProcessors(relPath, content, facts, processorMessageIndex, workerQueuePrefix, patterns) {
  for (const registration of patterns.registrations) {
    registration.lastIndex = 0;
    let match;
    while ((match = registration.exec(content))) {
      const processor = match[1];
      const workType = match[2];
      if (!processor || !workType) continue;
      const line = lineAt(content, match.index);
      const fields = { file: relPath, line, workType, processor };
      const message = processorMessageIndex.get(processor);
      if (message) fields.message = message;
      facts.push(fact('worker_processor', fields));

      if (message && workerQueuePrefix) {
        facts.push(
          fact('queue_name', {
            file: relPath,
            line,
            message,
            name: `${workerQueuePrefix}${message}.{env}`,
          }),
        );
      }
    }
  }
}

function extractQueueNamesFromTopologyBindings(relPath, content, facts, workerQueuePrefix, patterns) {
  if (!workerQueuePrefix) return;
  for (const binding of patterns.topologyBindings) {
    binding.lastIndex = 0;
    let match;
    while ((match = binding.exec(content))) {
      if (!match[1] || !match[2]) continue;
      facts.push(
        fact('queue_name', {
          file: relPath,
          line: lineAt(content, match.index),
          message: match[1],
          name: `${workerQueuePrefix}${match[1]}.{env}`,
          workType: match[2],
        }),
      );
    }
  }
}

/**
 * Any class/record under a `Messaging/Messages` path, whose name ends with `Message`,
 * or that implements a known message-marker interface, is a `message_class`. Struct
 * and interface declarations never qualify.
 */
function isMessageClass(relPath, classEntry) {
  if (classEntry.keyword !== 'class' && classEntry.keyword !== 'record') return false;
  if (MESSAGE_FILE_PATH.test(relPath)) return true;
  if (MESSAGE_NAME_SUFFIX.test(classEntry.name)) return true;
  return MESSAGE_MARKER_INTERFACE.test(classEntry.trailer ?? '');
}

function extractMessageClasses(relPath, content, classFrames, facts) {
  const nsMatch = content.match(NAMESPACE_DECLARATION);
  const namespace = nsMatch ? nsMatch[1] : null;
  for (const classEntry of classFrames) {
    if (!isMessageClass(relPath, classEntry)) continue;
    facts.push(
      fact('message_class', {
        file: relPath,
        line: lineAt(content, classEntry.braceIndex),
        name: classEntry.name,
        fqn: namespace ? `${namespace}.${classEntry.name}` : classEntry.name,
      }),
    );
  }
}

/**
 * The queue-prefix constant (named by `workerPatterns.queuePrefixConstants`) holds the
 * literal prefix a worker-queue framework's topology binding combines with the message
 * type name and environment to build a queue/exchange name. Resolved once, repo-wide,
 * since the constant can live in any file the walk visits.
 */
function findWorkerQueuePrefix(files, contents, patterns) {
  if (!patterns.workerQueuePrefix) return null;
  for (const file of files) {
    const match = contents.get(file.absPath).match(patterns.workerQueuePrefix);
    if (match) return match[1];
  }
  return null;
}

/**
 * `publish`/`consume`/`worker_processor` carry `fqn` when a `message_class` fact
 * (collected across the whole walk) resolves their simple `message` name to exactly one
 * namespace. Runs after every file is processed so extraction order never matters.
 */
function backfillMessageFqn(facts) {
  const nameToFqn = new Map();
  const ambiguous = new Set();
  for (const f of facts) {
    if (f.type !== 'message_class') continue;
    if (nameToFqn.has(f.name) && nameToFqn.get(f.name) !== f.fqn) {
      ambiguous.add(f.name);
      continue;
    }
    nameToFqn.set(f.name, f.fqn);
  }
  for (const f of facts) {
    if (f.type !== 'publish' && f.type !== 'consume' && f.type !== 'worker_processor') continue;
    if (f.fqn || !f.message || ambiguous.has(f.message)) continue;
    const fqn = nameToFqn.get(f.message);
    if (fqn) f.fqn = fqn;
  }
}

function extractSignalrPush(relPath, content, facts) {
  SIGNALR_PUSH.lastIndex = 0;
  let match;
  while ((match = SIGNALR_PUSH.exec(content))) {
    facts.push(
      fact('signalr_push', {
        file: relPath,
        line: lineAt(content, match.index),
        method: match[1],
      }),
    );
  }
}

function extractExchangeName(relPath, content, facts) {
  if (!basename(relPath).endsWith('Exchanges.cs')) return;
  const lines = content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(EXCHANGE_CONSTANT);
    if (!match) continue;
    facts.push(
      fact('exchange_name', {
        file: relPath,
        line: i + 1,
        constant: match[1],
        name: match[2],
      }),
    );
  }
}

function extractDiBinding(relPath, content, facts) {
  DI_BINDING.lastIndex = 0;
  let match;
  while ((match = DI_BINDING.exec(content))) {
    facts.push(
      fact('di_binding', {
        file: relPath,
        line: lineAt(content, match.index),
        iface: match[1],
        impl: match[2],
      }),
    );
  }
}

/**
 * The concrete type a `new Impl(...)` (or `new Impl { ... }` object initializer) constructor
 * expression names, or null when `expr` names no `new` at all -- a bare identifier read back
 * through `scopeBody`'s `var IDENT = new Impl(...)` when one exists, never further than that
 * one hop. `scopeBody` is null for an expression-bodied lambda, which has no locals to chase.
 */
function implFromNewExpression(expr, scopeBody) {
  const direct = expr.match(/^new\s+(\w+)\s*[({]/);
  if (direct) return direct[1];
  if (!scopeBody) return null;
  const bareLocal = expr.match(/^(\w+)$/);
  if (!bareLocal) return null;
  const localNew = scopeBody.match(new RegExp(`\\bvar\\s+${escapeRegExp(bareLocal[1])}\\s*=\\s*new\\s+(\\w+)\\s*[({]`));
  return localNew ? localNew[1] : null;
}

/**
 * The concrete type a single-generic-arg factory registration's lambda body actually
 * constructs, or null when the body never commits to one -- a factory that only redirects
 * to another registration (`sp => sp.GetRequiredService<Other>()`) names nothing this walk
 * can trust, so it is left alone rather than guessed at. `rawBody` is everything between the
 * factory call's own parens, `param =>` included; `param` is the lambda's parameter name.
 *
 * Two shapes, mirroring how these factories are commonly written: an expression-bodied lambda
 * (`param => new Impl(...)`), where the whole expression has to be the `new`; and a
 * block-bodied one (`param => { ...; return X; }`), where only the block's own last `return`
 * counts -- read directly off a `return new Impl(...)`, or traced through one
 * `var local = new Impl(...); ...; return local;` hop. A block with no `return` resolves
 * nothing, same as one whose `return` names neither shape.
 */
function implFromFactoryBody(rawBody, param) {
  const expr = rawBody.replace(new RegExp(`^\\s*${escapeRegExp(param)}\\s*=>\\s*`), '').trim();
  if (!expr.startsWith('{')) return implFromNewExpression(expr, null);
  const closeIndex = findMatchingClose(expr, 0, '{', '}');
  const block = closeIndex == null ? expr.slice(1) : expr.slice(1, closeIndex);
  const returns = [...block.matchAll(/\breturn\s+([^;]+);/g)];
  if (returns.length === 0) return null;
  return implFromNewExpression(returns[returns.length - 1][1].trim(), block);
}

/**
 * `di_binding` facts for the single-generic-arg factory-registration shape:
 * `AddTransient<TIface>(param => new Impl(...))` and its block-bodied and local-variable
 * variants. Read over `masked` so a `new` inside a comment or a string literal (a codebase
 * has both next to real factory bodies) cannot manufacture a fact; line numbers still read
 * off `content`, which `maskCsharp` keeps position-for-position aligned with.
 */
function extractDiFactoryBinding(relPath, content, masked, facts) {
  DI_FACTORY_CALL.lastIndex = 0;
  let match;
  while ((match = DI_FACTORY_CALL.exec(masked))) {
    const iface = match[1];
    const param = match[2];
    const openParenIndex = match.index + match[0].lastIndexOf('(');
    const closeParenIndex = findMatchingParen(masked, openParenIndex);
    if (closeParenIndex == null) continue;
    const impl = implFromFactoryBody(masked.slice(openParenIndex + 1, closeParenIndex), param);
    if (!impl) continue;
    facts.push(
      fact('di_binding', {
        file: relPath,
        line: lineAt(content, match.index),
        iface,
        impl,
      }),
    );
  }
}

/** Every `options.Filters.Add(typeof(X))` call across the whole repo, first occurrence kept. */
function buildRegisteredFilterIndex(files, contents) {
  const registered = new Map();
  for (const file of files) {
    const content = contents.get(file.absPath);
    FILTER_REGISTRATION_CALL.lastIndex = 0;
    let match;
    while ((match = FILTER_REGISTRATION_CALL.exec(content))) {
      if (registered.has(match[1])) continue;
      registered.set(match[1], { file: file.relPath, line: lineAt(content, match.index) });
    }
  }
  return registered;
}

/** The status a `BadRequest(...)`/`StatusCodes.StatusXxx`/… call in `text` sets, or null. */
function statusFromExceptionText(text) {
  for (const [re, pick] of EXCEPTION_STATUS_CALLS) {
    const match = re.exec(text);
    if (match) return Number(pick(match));
  }
  return null;
}

/** Body of the `{ … }` whose opening brace follows `from`; returns [body, indexAfterBlock]. */
function blockAfterBrace(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return [null, from];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return [text.slice(open + 1, i), i + 1];
    }
  }
  return [null, from];
}

/**
 * `exception_map` facts, global scope: an `ExceptionFilterAttribute` registered through
 * `options.Filters.Add(typeof(X))` somewhere in the repo applies to every action, so the
 * status it sets for a `context.Exception is T` guard is recorded once per exception type,
 * scoped to the filter — never merged with a controller's own per-action catches, which can
 * (and do) map the same exception type to a different status.
 */
function extractGlobalExceptionFilters(relPath, content, masked, classFrames, registeredFilters, facts) {
  for (const classEntry of classFrames) {
    if (!registeredFilters.has(classEntry.name)) continue;
    if (!EXCEPTION_FILTER_BASE.test(classEntry.trailer || '')) continue;
    const bodyEnd = classEntry.endIndex ?? masked.length;
    const body = masked.slice(classEntry.startIndex, bodyEnd);
    EXCEPTION_GUARD.lastIndex = 0;
    let guard;
    while ((guard = EXCEPTION_GUARD.exec(body))) {
      const window = body.slice(guard.index, Math.min(guard.index + 900, body.length));
      const status = statusFromExceptionText(window);
      if (status === null) continue;
      facts.push(
        fact('exception_map', {
          file: relPath,
          line: lineAt(content, classEntry.startIndex + guard.index),
          scope: 'global',
          class: classEntry.name,
          exception: guard[1].split('.').pop(),
          status,
        }),
      );
    }
  }
}

/**
 * `exception_map` facts, action scope: a `catch` block inside one controller action maps
 * its exception type only for that action. The same type can surface a different status in
 * a sibling action or under the repo's global filters — each `catch` is its own fact, never
 * folded into the others, so that difference stays visible.
 */
function extractActionExceptionCatches(relPath, content, masked, methodFrames, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    if (!method.classRef.name.endsWith('Controller')) continue;
    const body = masked.slice(method.startIndex, method.endIndex);
    CATCH_CLAUSE.lastIndex = 0;
    let clause;
    while ((clause = CATCH_CLAUSE.exec(body))) {
      const [catchBody, afterIndex] = blockAfterBrace(body, clause.index + clause[0].length);
      if (catchBody === null) break;
      CATCH_CLAUSE.lastIndex = afterIndex;
      const status = statusFromExceptionText(catchBody);
      if (status === null) continue;
      facts.push(
        fact('exception_map', {
          file: relPath,
          line: lineAt(content, method.startIndex + clause.index),
          scope: 'action',
          class: method.classRef.name,
          method: method.name,
          exception: clause[1] ? clause[1].split('.').pop() : '*',
          status,
        }),
      );
    }
  }
}

function buildMessageIndex(files, contents) {
  const index = new Map();
  for (const file of files) {
    const relPath = file.relPath;
    if (!MESSAGE_FILE_PATH.test(relPath)) continue;
    const content = contents.get(file.absPath);
    const nsMatch = content.match(NAMESPACE_DECLARATION);
    if (!nsMatch) continue;
    const namespace = nsMatch[1];
    const classRe = /\bclass\s+(\w+)\b/g;
    let match;
    while ((match = classRe.exec(content))) {
      if (!index.has(match[1])) index.set(match[1], `${namespace}.${match[1]}`);
    }
  }
  return index;
}

/**
 * The processor's own class name recurs as a CRTP self-reference in bases like
 * `BatchProcessor<TProcessor, TMessage, ...>` (first type argument). Skip any
 * argument equal to the declaring class name, then unwrap `Batch<X>`/`IEnumerable<X>`
 * on whatever candidate is left so the true message type comes through.
 */
function firstNonSelfGenericArg(argsText, selfName) {
  const parts = splitTopLevel(argsText, ',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const candidate = parts.find((part) => part !== selfName);
  if (!candidate) return null;
  const batchMatch = candidate.match(/^Batch\s*<\s*(\w+)\s*>$/);
  if (batchMatch) return batchMatch[1];
  const enumerableMatch = candidate.match(/^IEnumerable\s*<\s*(\w+)\s*>$/);
  if (enumerableMatch) return enumerableMatch[1];
  return /^\w+$/.test(candidate) ? candidate : null;
}

/**
 * Maps every concrete `class X : ...SomeProcessor<...>` (any base identifier ending
 * in `Processor`) to its message type. Non-generic bases (`IAsyncWorkProcessor`,
 * `IWorkProcessor`) never match here, so processors registered against them simply
 * get no `message` -- left absent rather than guessed.
 */
function buildProcessorMessageIndex(files, contents) {
  const index = new Map();
  for (const file of files) {
    const content = contents.get(file.absPath);
    PROCESSOR_CLASS.lastIndex = 0;
    let match;
    while ((match = PROCESSOR_CLASS.exec(content))) {
      const message = firstNonSelfGenericArg(match[3], match[1]);
      if (message) index.set(match[1], message);
    }
  }
  return index;
}

/**
 * How far a controller action's argument provenance is carried down the call chain
 * before the answer stops being worth stating. Hop 0 is the action itself; hops 1..3
 * inherit a source from their caller's argument; the hop after that is recorded as
 * `unknown` rather than guessed, so a consumer can tell "we stopped looking" apart
 * from "we never looked".
 */
const MAX_PARAM_HOPS = 3;

/** `[FromX]` on an action parameter answers where the value comes from outright. */
const PARAM_ATTRIBUTE_SOURCES = Object.freeze({
  FromRoute: 'route',
  FromQuery: 'query',
  FromBody: 'body',
  FromHeader: 'header',
  FromForm: 'body',
  FromServices: 'di',
});

const ROUTE_TEMPLATE_PARAM = /\{(\w+)/g;
const SIMPLE_VALUE_TYPE = /^(?:string|char|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|Guid|DateTime|DateTimeOffset|TimeSpan)\??(?:\[\])?$/;
const FRAMEWORK_PARAM_TYPE = /^(?:CancellationToken|HttpContext|HttpRequest|HttpResponse|ClaimsPrincipal|IPrincipal|IUrlHelper)$/;
const INJECTED_PARAM_TYPE = /^I[A-Z]\w*(?:Service|Repository|Provider|Factory|Client|Accessor|Handler|Manager|Resolver|Publisher|Logger)$/;
const JWT_EXPRESSION = /\bGetJwt\s*\(|(?<![\w.])Jwt\b/;
const MEMBER_CHAIN = /^(?:await\s+)?([A-Za-z_]\w*)((?:\s*\??\.\s*[A-Za-z_]\w*)*)$/;
const LOCAL_ASSIGNMENT = /\b(?:var|[A-Za-z_][\w<>[\],.?]*)\s+([A-Za-z_]\w*)\s*=(?!=)\s*([^;]+);/g;

/**
 * Parameters with their attributes intact. `matchMethodHeader` blanks attributes before
 * it matches, so the frame's own `paramsText` cannot answer `[FromBody]`; the raw text
 * between the signature's parentheses can.
 */
function rawParamsAt(masked, headerIndex) {
  const open = masked.indexOf('(', headerIndex);
  if (open === -1) return null;
  const close = findMatchingParen(masked, open);
  if (close == null) return null;
  return masked.slice(open + 1, close);
}

function parseParamsWithAttributes(paramsText) {
  const text = (paramsText ?? '').trim();
  if (!text) return [];
  const parsed = [];
  for (const raw of splitTopLevel(text, ',')) {
    const base = parseParams(raw)[0];
    if (!base) continue;
    const attributes = [];
    const attributeRe = /\[([^[\]]*)\]/g;
    let match;
    while ((match = attributeRe.exec(raw))) attributes.push(match[1].trim());
    parsed.push({ ...base, attributes, hasDefault: stripAttributes(raw).includes('=') });
  }
  return parsed;
}

/**
 * Where one controller-action parameter comes from. An explicit `[FromX]` wins; then a
 * name the route template declares as a segment; then the types the framework hands in
 * rather than the caller. What is left follows ASP.NET Core's own default binding for an
 * `[ApiController]`: a simple value type with no attribute is read from the query string,
 * a complex one from the request body.
 */
function actionParamSource(param, templateParams) {
  for (const attribute of param.attributes) {
    const name = attribute.split('(')[0].trim();
    const source = PARAM_ATTRIBUTE_SOURCES[name];
    if (source) return { source, via: `[${name}]` };
  }
  if (templateParams.has(param.name.toLowerCase())) {
    return { source: 'route', via: `route template {${param.name}}` };
  }
  const type = param.type.replace(/\b(?:ref|out|in|params|this)\b/g, '').trim();
  if (FRAMEWORK_PARAM_TYPE.test(type) || INJECTED_PARAM_TYPE.test(type)) {
    return { source: 'di', via: `injected ${type}` };
  }
  if (SIMPLE_VALUE_TYPE.test(type)) return { source: 'query', via: 'unbound simple type' };
  if (/^[A-Za-z_]\w*$/.test(type)) return { source: 'body', via: 'unbound complex type' };
  return { source: 'unknown', via: 'unreadable parameter type' };
}

function jwtVia(text) {
  return /\bGetJwt\s*\(/.test(text) ? 'GetJwt(Request)' : 'Jwt';
}

function normaliseExpression(text) {
  return text.trim().replace(/\s+/g, '');
}

/**
 * The provenance of one argument expression. Only two shapes are read: something that
 * names the request's JWT, and a bare identifier or member chain rooted in a parameter
 * or a local this method already resolved. Anything else — an arithmetic expression, a
 * call result, an object initialiser — is left unresolved rather than guessed at.
 */
function argumentSource(argText, ownerKey, sources, locals) {
  const expression = argText.trim();
  if (expression === '') return null;
  if (JWT_EXPRESSION.test(expression)) return { source: 'jwt', via: jwtVia(expression) };
  const chain = MEMBER_CHAIN.exec(expression);
  if (!chain) return null;
  const root = chain[1];
  const known = sources.get(`${ownerKey}|${root}`) || locals.get(root);
  if (!known) return null;
  return { source: known.source, via: normaliseExpression(expression) };
}
function methodFramesByClass(fileScans) {
  const byClass = new Map();
  for (const scan of fileScans) {
    for (const frame of scan.methodFrames) {
      if (!frame.classRef || frame.endIndex == null) continue;
      const entries = byClass.get(frame.classRef.name);
      const entry = { scan, frame };
      if (entries) entries.push(entry);
      else byClass.set(frame.classRef.name, [entry]);
    }
  }
  return byClass;
}

/**
 * The three repo-wide lookups the propagation needs, read back off the facts the file
 * passes already produced: which type each field holds, which class stands behind each
 * interface, and which parameter names a route declares as path segments.
 */
function paramSourceIndexes(facts) {
  const fieldTypes = new Map();
  const implByIface = new Map();
  const templateParams = new Map();
  for (const item of facts) {
    if (item.type === 'ctor_field') {
      const fields = fieldTypes.get(item.class) || new Map();
      if (!fields.has(item.field)) fields.set(item.field, item.paramType);
      fieldTypes.set(item.class, fields);
      continue;
    }
    if (item.type === 'di_binding') {
      if (!implByIface.has(item.iface)) implByIface.set(item.iface, item.impl);
      continue;
    }
    if (item.type !== 'route') continue;
    const key = `${item.controller}.${item.action}`;
    const names = templateParams.get(key) || new Set();
    ROUTE_TEMPLATE_PARAM.lastIndex = 0;
    let match;
    while ((match = ROUTE_TEMPLATE_PARAM.exec(item.template || ''))) names.add(match[1].toLowerCase());
    templateParams.set(key, names);
  }
  return { fieldTypes, implByIface, templateParams };
}

/** An interface resolves through its `di_binding`, or by the `IFoo` -> `Foo` convention. */
function resolveReceiverClass(typeName, implByIface, byClass) {
  if (!typeName) return null;
  const bare = typeName.replace(/<.*$/, '').trim();
  if (byClass.has(bare)) return bare;
  const impl = implByIface.get(bare);
  if (impl && byClass.has(impl)) return impl;
  if (/^I[A-Z]/.test(bare) && byClass.has(bare.slice(1))) return bare.slice(1);
  return null;
}

/**
 * The overload an argument count selects: an exact arity match, else the narrowest one
 * whose extra tail parameters all carry defaults. Two overloads of the same arity are
 * not told apart — the first declared wins.
 */
function pickOverload(candidates, argCount) {
  let widened = null;
  for (const candidate of candidates) {
    const params = candidate.params;
    if (params.length === argCount) return candidate;
    if (params.length <= argCount) continue;
    if (!params.slice(argCount).every((param) => param.hasDefault)) continue;
    if (!widened || widened.params.length > params.length) widened = candidate;
  }
  return widened;
}

/**
 * Every `field.Method(` and same-class `Method(` call in one body, with the argument
 * expressions split out. Mirrors the receivers `extractMethodCalls` and `extractSelfCalls`
 * already record, so a call the walk can follow is a call this can follow too.
 */
function callSitesIn(entry, fields, methodNames) {
  const { scan, frame } = entry;
  const sites = [];
  const collect = (regex, receiverOf, methodOf, skip) => {
    regex.lastIndex = 0;
    let match;
    const body = scan.masked.slice(frame.startIndex, frame.endIndex);
    while ((match = regex.exec(body))) {
      if (skip && skip(match)) continue;
      const openIndex = frame.startIndex + match.index + match[0].length - 1;
      const closeIndex = findMatchingParen(scan.masked, openIndex);
      if (closeIndex == null) continue;
      const argsText = scan.masked.slice(openIndex + 1, closeIndex);
      const args = argsText.trim() === '' ? [] : splitTopLevel(argsText, ',');
      sites.push({ receiver: receiverOf(match), method: methodOf(match), args });
    }
  };

  if (fields.size > 0) {
    const alternation = [...fields.keys()]
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length)
      .join('|');
    collect(
      new RegExp(`(?:\\bthis\\.)?\\b(${alternation})\\.(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`, 'g'),
      (match) => fields.get(match[1]),
      (match) => match[2],
    );
  }
  collect(
    new RegExp(SELF_CALL.source, 'g'),
    () => frame.classRef.name,
    (match) => match[1],
    (match) => CSHARP_KEYWORDS.has(match[1]) || fields.has(match[1]) || !methodNames.has(match[1]),
  );
  return sites;
}

/**
 * Locals a method body binds to something already known: anything read off the request's
 * JWT, and a plain alias of a parameter or of an earlier local. Flow-insensitive — a
 * local is treated as bound for the whole body, not from its declaration onward.
 */
function localsIn(entry, ownerKey, sources) {
  const locals = new Map();
  const body = entry.scan.masked.slice(entry.frame.startIndex, entry.frame.endIndex);
  LOCAL_ASSIGNMENT.lastIndex = 0;
  let match;
  while ((match = LOCAL_ASSIGNMENT.exec(body))) {
    const [, name, rhs] = match;
    if (locals.has(name)) continue;
    if (JWT_EXPRESSION.test(rhs)) {
      locals.set(name, { source: 'jwt', via: jwtVia(rhs) });
      continue;
    }
    const chain = MEMBER_CHAIN.exec(rhs.trim());
    if (!chain) continue;
    const known = sources.get(`${ownerKey}|${chain[1]}`) || locals.get(chain[1]);
    if (known) locals.set(name, { source: known.source, via: normaliseExpression(rhs) });
  }
  return locals;
}

/**
 * `param_source` facts: where every controller action's arguments come from, and where
 * the arguments of everything it calls come from, one call hop at a time.
 *
 * Hop 0 reads the action's own signature. Each further hop maps a resolved argument
 * expression onto the callee's parameter in the same position, following a field through
 * its `ctor_field` type and its `di_binding` implementation, and reading a member access
 * on a JWT-derived object (`user.TenantId`) as JWT-derived too. Two callers that disagree
 * about one parameter make it `unknown` rather than picking a winner, and the hop past
 * `MAX_PARAM_HOPS` is recorded as `unknown` rather than followed.
 *
 * Not handled: an argument that is an expression rather than a name or member chain, a
 * value that reaches a parameter through a field rather than an argument, overloads of
 * equal arity, generic type arguments, and any caller that is not itself a route action
 * (a consumer or a processor entry point contributes nothing).
 */
function extractParamSources(fileScans, facts) {
  const byClass = methodFramesByClass(fileScans);
  const { fieldTypes, implByIface, templateParams } = paramSourceIndexes(facts);
  const paramsOf = (entry) => {
    if (!entry.params) {
      entry.params = parseParamsWithAttributes(rawParamsAt(entry.scan.masked, entry.frame.headerIndex));
    }
    return entry.params;
  };
  const methodNamesOf = (className) =>
    new Set((byClass.get(className) || []).map((entry) => entry.frame.name));

  const sources = new Map();
  const record = (entry, param, decided, fixed) => {
    const key = `${entry.frame.classRef.name}|${entry.frame.name}|${param}`;
    const existing = sources.get(key);
    if (existing) {
      if (existing.fixed || existing.source === decided.source) return;
      existing.source = 'unknown';
      existing.via = 'callers disagree';
      return;
    }
    sources.set(key, {
      file: entry.scan.relPath,
      line: lineAt(entry.scan.content, entry.frame.headerIndex),
      class: entry.frame.classRef.name,
      method: entry.frame.name,
      param,
      source: decided.source,
      via: decided.via,
      fixed: fixed === true,
    });
  };

  const queue = [];
  const seen = new Set();
  const enqueue = (entry, hop) => {
    if (seen.has(entry.frame)) return;
    seen.add(entry.frame);
    queue.push({ entry, hop });
  };

  for (const [key, names] of templateParams) {
    const dot = key.lastIndexOf('.');
    const controller = key.slice(0, dot);
    const action = key.slice(dot + 1);
    for (const entry of byClass.get(controller) || []) {
      if (entry.frame.name !== action) continue;
      for (const param of paramsOf(entry)) record(entry, param.name, actionParamSource(param, names), true);
      enqueue(entry, 0);
    }
  }

  while (queue.length > 0) {
    const { entry, hop } = queue.shift();
    const className = entry.frame.classRef.name;
    const ownerKey = `${className}|${entry.frame.name}`;
    const fields = fieldTypes.get(className) || new Map();
    const locals = localsIn(entry, ownerKey, sources);
    const beyondBound = hop + 1 > MAX_PARAM_HOPS;

    for (const site of callSitesIn(entry, fields, methodNamesOf(className))) {
      const target = resolveReceiverClass(site.receiver, implByIface, byClass);
      if (!target) continue;
      const candidates = (byClass.get(target) || [])
        .filter((candidate) => candidate.frame.name === site.method && candidate.frame !== entry.frame)
        .map((candidate) => ({ ...candidate, params: paramsOf(candidate) }));
      const callee = pickOverload(candidates, site.args.length);
      if (!callee) continue;

      let carried = false;
      for (let position = 0; position < Math.min(site.args.length, callee.params.length); position += 1) {
        const resolved = argumentSource(site.args[position], ownerKey, sources, locals);
        if (!resolved) continue;
        carried = true;
        record(
          callee,
          callee.params[position].name,
          beyondBound
            ? { source: 'unknown', via: `past the ${MAX_PARAM_HOPS}-hop bound` }
            : { source: resolved.source, via: `${ownerKey.replace('|', '.')}(${resolved.via})` },
        );
      }
      if (carried && !beyondBound) enqueue(callee, hop + 1);
    }
  }

  for (const entry of sources.values()) {
    facts.push(
      fact('param_source', {
        file: entry.file,
        line: entry.line,
        class: entry.class,
        method: entry.method,
        param: entry.param,
        source: entry.source,
        via: entry.via,
      }),
    );
  }
}

/**
 * The mediator dispatch hop -- `{mediator}.Send(request)` into the handler class
 * the request type binds to.
 *
 * A controller action that dispatches through a mediator names its real target nowhere at
 * the call site: `_mediator.Send(new GetMyOrders(...))` records only `calledMethod: 'Send'`
 * on a field declared `IMediator`, and the walk has nothing but the container interface to
 * resolve. The handler declares which request it handles by implementing a
 * generic handler interface parameterised on the request type
 * (`class GetMyOrdersHandler : IRequestHandler<GetMyOrders, IEnumerable<OrderViewModel>>`),
 * so the binding is source-level evidence sitting in a different file from the call.
 *
 * Two passes over the whole scan set, since the two halves never sit in one file:
 *
 * 1. Every class whose base list names a generic handler interface binds its first type
 *    argument (the request) to the class, and to the one method that takes that request --
 *    `Handle` under MediatR, `HandleAsync` under an equivalent hand-rolled interface,
 *    read off the parameter type rather than off either name so neither convention is
 *    hard-coded. That binding is emitted as a `di_binding` fact, the same fact
 *    `resolveReceiverClass`, `buildReceiverIndex` and the walk's `diByIface` already read
 *    with no assumption about which registration shape produced it -- a request handler
 *    registered by assembly scanning (`AddMediatR(...)`) is a DI registration the
 *    two-argument and factory-lambda passes simply cannot see.
 *
 * 2. Every `{receiver}.Send(x)` whose first argument resolves to a bound request type --
 *    `new RequestType(...)` directly, an action parameter of that type, or a local built
 *    with `new` earlier in the same body -- emits one further `method_call` carrying
 *    `receiverType: <request type>` and the handler's own entry method, exactly the fact
 *    shape described above. The walk then resolves the request type through the binding
 *    into the handler class and attaches that method, continuing as if the action had
 *    called the handler directly. The plain `Send` fact for that same call site is dropped:
 *    it is superseded, and leaving it behind would also report `unresolved: IMediator`.
 *    A `Send` whose argument binds to nothing keeps the plain call fact and its gap.
 *
 * `Publish`/notification fan-out is deliberately out of scope (one notification, many
 * handlers, a different shape), and so is a handler whose request type is one of the class's
 * own type parameters -- an open generic handler binds no concrete request.
 */
function extractMediatorDispatch(fileScans, facts) {
  const bareName = (text) => {
    const trimmed = (text || '').trim().replace(/<[\s\S]*$/, '').trim();
    const dot = trimmed.lastIndexOf('.');
    return dot === -1 ? trimmed : trimmed.slice(dot + 1);
  };

  const methodsByClass = new Map();
  for (const scan of fileScans) {
    for (const method of scan.methodFrames) {
      const classEntry = method.classRef;
      if (!classEntry) continue;
      let bucket = methodsByClass.get(classEntry);
      if (!bucket) {
        bucket = { scan, classEntry, methods: [] };
        methodsByClass.set(classEntry, bucket);
      }
      bucket.methods.push(method);
    }
  }

  const bindings = new Map();
  for (const { scan, classEntry, methods } of methodsByClass.values()) {
    if (classEntry.keyword !== 'class') continue;
    const trailer = (classEntry.trailer || '').trim();
    if (!trailer.startsWith(':')) continue;
    const baseList = trailer.slice(1).split(/\bwhere\b/)[0];
    const typeParams = typeParamNames(classEntry.typeParamsText);
    for (const rawBase of splitTopLevel(baseList, ',')) {
      const generic = rawBase.trim().match(/^([\w.]+)\s*<([\s\S]+)>$/);
      if (!generic) continue;
      if (!MEDIATOR_HANDLER_INTERFACE.test(bareName(generic[1]))) continue;
      const request = bareName(splitTopLevel(generic[2], ',')[0]);
      if (!/^\w+$/.test(request) || typeParams.has(request)) continue;
      if (bindings.has(request)) continue;
      const byParam = methods.find(
        (method) => !method.isCtor && bareName((parseParams(method.paramsText)[0] || {}).type) === request,
      );
      const entry = byParam || methods.find((method) => !method.isCtor && HANDLER_ENTRY_METHOD.test(method.name));
      if (!entry) continue;
      bindings.set(request, { handler: classEntry.name, method: entry.name });
      facts.push(
        fact('di_binding', {
          file: scan.relPath,
          line: lineAt(scan.content, classEntry.braceIndex),
          iface: request,
          impl: classEntry.name,
        }),
      );
    }
  }
  if (bindings.size === 0) return;

  const superseded = new Set();
  for (const scan of fileScans) {
    for (const method of scan.methodFrames) {
      if (!method.classRef || method.endIndex == null) continue;
      const body = scan.masked.slice(method.startIndex, method.endIndex);
      const params = parseParams(method.paramsText);
      MEDIATOR_SEND_CALL.lastIndex = 0;
      let match;
      while ((match = MEDIATOR_SEND_CALL.exec(body))) {
        const receiver = match[1].replace(/^this\./, '');
        const openIndex = match.index + match[0].length - 1;
        const closeIndex = findMatchingParen(body, openIndex);
        if (closeIndex == null) continue;
        const first = splitTopLevel(body.slice(openIndex + 1, closeIndex), ',')[0].trim();
        let request = null;
        const constructed = first.match(/^new\s+([\w.]+)\s*[({]/);
        if (constructed) {
          request = bareName(constructed[1]);
        } else if (/^\w+$/.test(first)) {
          const param = params.find((entry) => entry.name === first);
          if (param) {
            request = bareName(param.type);
          } else {
            const before = body.slice(0, match.index);
            const localRe = new RegExp(
              `\\b(?:var|[\\w.]+(?:<[^<>]*>)?)\\s+${escapeRegExp(first)}\\s*=\\s*(?:await\\s+)?new\\s+([\\w.]+)\\s*[({]`,
              'g',
            );
            let local;
            let last = null;
            while ((local = localRe.exec(before))) last = local;
            if (last) request = bareName(last[1]);
          }
        }
        const binding = request ? bindings.get(request) : null;
        if (!binding) continue;
        const line = lineAt(scan.content, method.startIndex + match.index + match[0].search(/\w/));
        facts.push(
          fact('method_call', {
            file: scan.relPath,
            line,
            class: method.classRef.name,
            method: method.name,
            field: receiver,
            calledMethod: binding.method,
            receiverType: request,
          }),
        );
        superseded.add(`${scan.relPath}|${line}|${method.classRef.name}|${method.name}|${receiver}`);
      }
    }
  }
  if (superseded.size === 0) return;
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const entry = facts[index];
    if (entry.type !== 'method_call' || entry.calledMethod !== 'Send' || entry.receiverType !== undefined) continue;
    if (superseded.has(`${entry.file}|${entry.line}|${entry.class}|${entry.method}|${entry.field}`)) {
      facts.splice(index, 1);
    }
  }
}

export async function extract(repoRoot, options = {}) {
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const patterns = compileWorkerPatterns(options.workerPatterns);
  const absolutePaths = walk(repoRoot, { extensions: ['.cs'], exclude });

  const files = absolutePaths.map((absPath) => ({
    absPath,
    relPath: toRelativePath(repoRoot, absPath),
  }));

  const contents = new Map();
  for (const file of files) {
    contents.set(file.absPath, readFileSync(file.absPath, 'utf8'));
  }

  const messageIndex = buildMessageIndex(files, contents);
  const processorMessageIndex = buildProcessorMessageIndex(files, contents);
  const workerQueuePrefix = findWorkerQueuePrefix(files, contents, patterns);
  const registeredFilters = buildRegisteredFilterIndex(files, contents);

  const facts = [];
  const fileScans = [];
  for (const file of files) {
    const content = contents.get(file.absPath);
    const masked = maskCsharp(content);
    const { classFrames, methodFrames } = scanFrames(masked);
    const expressionBodiedMethods = findExpressionBodiedMethods(masked, classFrames);
    const methodNamesByClass = buildMethodNamesByClass(methodFrames, expressionBodiedMethods);
    fileScans.push({ relPath: file.relPath, content, masked, methodFrames });

    extractRoutes(file.relPath, content, facts);
    extractRazorPageRoutes(file.relPath, file.absPath, content, classFrames, methodFrames, facts);
    extractMinimalApiRoutes(file.relPath, content, masked, classFrames, methodFrames, facts);
    extractEndpointClassRoutes(file.relPath, content, masked, classFrames, methodFrames, facts);
    extractHttpOut(file.relPath, content, facts, patterns);
    extractPublish(file.relPath, content, facts, messageIndex, classFrames, methodFrames, patterns);
    extractConsume(file.relPath, content, facts, patterns);
    extractWorkerProcessors(file.relPath, content, facts, processorMessageIndex, workerQueuePrefix, patterns);
    extractQueueNamesFromTopologyBindings(file.relPath, content, facts, workerQueuePrefix, patterns);
    extractSignalrPush(file.relPath, content, facts);
    extractExchangeName(file.relPath, content, facts);
    extractDiBinding(file.relPath, content, facts);
    extractDiFactoryBinding(file.relPath, content, masked, facts);
    extractGlobalExceptionFilters(file.relPath, content, masked, classFrames, registeredFilters, facts);
    extractActionExceptionCatches(file.relPath, content, masked, methodFrames, facts);

    extractMessageClasses(file.relPath, content, classFrames, facts);
    extractIfaceImpl(file.relPath, content, classFrames, facts);
    const fieldsByClass = extractCtorFields(file.relPath, content, masked, classFrames, methodFrames, facts);
    extractMethodCalls(file.relPath, content, masked, methodFrames, fieldsByClass, facts);
    extractServiceLocatorCalls(file.relPath, content, masked, methodFrames, fieldsByClass, facts);
    extractElementCalls(file.relPath, content, masked, methodFrames, fieldsByClass, facts);
    extractSelfCalls(file.relPath, content, masked, methodFrames, methodNamesByClass, fieldsByClass, facts);
    extractBranchPoints(file.relPath, content, masked, methodFrames, facts);
    extractRedisPublish(file.relPath, content, masked, facts, patterns);
    extractMethodSpans(file.relPath, content, methodFrames, facts);
    extractExpressionBodiedMethodSpans(file.relPath, content, expressionBodiedMethods, facts);
  }

  backfillMessageFqn(facts);
  extractParamSources(fileScans, facts);
  extractMediatorDispatch(fileScans, facts);

  return facts;
}
