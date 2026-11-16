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
import { buildConstantIndex, resolveConstantString, scopeOf } from './csharp-constants.js';
import { buildFileControl } from './control-csharp.js';
import { keepCarriedJoinTasks } from '../control-evidence.js';

const DEFAULT_EXCLUDE = ['Tests', 'bin', 'obj', 'load-tests', 'automation', '.openapi'];

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
/** A handler passed as a method group (`app.MapGet("t", HandleAsync)`,
 * `app.MapGet("t", WidgetHandlers.ListWidgets)`) rather than as an inline lambda -- the
 * referenced method is what the walk continues into, and a type-like qualifier names the
 * class that declares it. */
const METHOD_GROUP_ARGUMENT = /^\s*(?:this\s*\.\s*)?((?:[A-Za-z_]\w*\s*\.\s*)*)([A-Za-z_]\w*)\s*(?:,|$)/;
/** The Ardalis-style single-endpoint base, matched by its shape
 * (`.WithRequest<…>.WithActionResult<…>`, `.WithoutRequest.WithResult<…>`, …) rather than by
 * a hardcoded base-type name, so a differently-named same-shape base still qualifies. */
const ENDPOINT_BASE_SHAPE = /\.\s*With(?:out)?Request\b[\s\S]{0,400}?\.\s*With(?:out)?(?:Action)?Result\b/;
const HTTP_VERB_WORDS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const INTERPOLATED_URL = /\$"\{(\w+)\}([^"]*)"/;
const OUTBOUND_VERB_CALL = /\.(Get|Post|Put|Patch|Delete)Async\s*\(/;

/** Publish-call method names built in by default -- the MassTransit
 * `IPublishEndpoint.Publish`/`PublishAsync` idiom, its job-service `SubmitJob` and the
 * request/response `Reply`. A worker-queue framework with its own publish method names adds
 * them through `workerPatterns.publishCalls`, each optionally suffixed `/N` to name the
 * 1-based argument position its message sits at when it is not the call's first argument
 * (`Defer/2`); a bare name here keeps meaning position 1. */
const DEFAULT_PUBLISH_CALLS = Object.freeze(['Publish', 'SubmitJob', 'Reply']);
/** Consumer base types built in by default -- MassTransit's `IConsumer<T>` plus the
 * plain `BaseConsumer<T>` naming convention. A framework with its own consumer base
 * classes adds them through `workerPatterns.consumerBases`. */
const DEFAULT_CONSUMER_BASES = Object.freeze(['BaseConsumer', 'IConsumer']);
/** Saga-interface names built in by default -- the MassTransit-shaped `IAmInitiatedBy<T>`.
 * A framework that names its own saga-initiator interface differently adds it through
 * `workerPatterns.sagaInterfaces`; the seam exists because that name varies far more than a
 * plain consumer base's does. */
const DEFAULT_SAGA_INTERFACES = Object.freeze(['IAmInitiatedBy']);
/** Channel-publish method names built in by default -- the StackExchange.Redis
 * `PublishAsync` idiom. Extras come from `workerPatterns.broadcastCalls`. */
const DEFAULT_BROADCAST_CALLS = Object.freeze(['PublishAsync']);
/** Repository-relative folders whose classes and records are message contracts, built in by
 * default -- `Messaging/Messages`, `Messaging/Events`, `Messaging/Jobs` and `Messaging/Contracts`.
 * Extras come from `workerPatterns.messagePaths`. */
const DEFAULT_MESSAGE_PATHS = Object.freeze(['Messaging/(?:Messages|Events|Jobs|Contracts)']);
/** Class-name suffixes that mark a message contract wherever the class lives, built in by
 * default -- `Message` only. `Event` and `Job` are too common outside messaging to assume, so an
 * estate that names its contracts that way lists them in `workerPatterns.messageSuffixes`. */
const DEFAULT_MESSAGE_SUFFIXES = Object.freeze(['Message']);

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
const NAMESPACE_DECLARATION = /namespace\s+([\w.]+)\s*[;{]/;

/** The five ways MVC options register a global filter: `Add` or `AddService`, each with a
 * `typeof(X)` argument or an `<X>` type argument, and `Add(new X(...))`. One capture group
 * per spelling, so the name is whichever group matched. */
const FILTER_REGISTRATION_CALL =
  /\.Filters\.(?:Add|AddService)\s*(?:\(\s*typeof\s*\(\s*(\w+)\s*\)\s*\)|<\s*(\w+)\s*>\s*\(\s*\))|\.Filters\.Add\s*\(\s*new\s+(\w+)\s*[({]/g;
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
/**
 * The status rules a result object adds to the exception ones: a filter or an action hands
 * MVC a result instance (`new ForbidResult()`, `new StatusCodeResult(403)`) as often as it
 * calls the controller helper of the same name. Read only for `filter_result` and
 * `sentinel_map`, so an exception filter's status reading never moves.
 */
const RESULT_STATUS_CALLS = [
  ...EXCEPTION_STATUS_CALLS.slice(0, 2),
  [/\bnew\s+StatusCodeResult\s*\(\s*(\d{3})\s*\)/, (m) => m[1]],
  [/\bStatusCode\s*=\s*(\d{3})\b/, (m) => m[1]],
  [/\bnew\s+Unauthorized(?:Object)?Result\b/, () => '401'],
  [/\bnew\s+Forbid(?:Object)?Result\b/, () => '403'],
  [/\bnew\s+NotFound(?:Object)?Result\b/, () => '404'],
  [/\bnew\s+BadRequest(?:Object)?Result\b/, () => '400'],
  [/\bnew\s+Conflict(?:Object)?Result\b/, () => '409'],
  [/\bnew\s+NoContentResult\b/, () => '204'],
  ...EXCEPTION_STATUS_CALLS.slice(2),
];
/** The filter interfaces and base a class names to run before an action, by stage. */
const AUTHORIZATION_FILTER_BASES = new Set(['IAuthorizationFilter', 'IAsyncAuthorizationFilter']);
const ACTION_FILTER_BASES = new Set(['IActionFilter', 'IAsyncActionFilter', 'ActionFilterAttribute']);
const FILTER_ENTRY_METHODS = Object.freeze({
  authorization: new Set(['OnAuthorization', 'OnAuthorizationAsync']),
  action: new Set(['OnActionExecuting', 'OnActionExecutionAsync']),
});
const TYPE_LIST_DECLARATION =
  /\b(?:static\s+)?(?:readonly\s+)?(?:Type\s*\[\s*\]|(?:List|IList|IReadOnlyList|IReadOnlyCollection|IEnumerable)\s*<\s*Type\s*>)\s+(\w+)\s*=\s*(?:new\s*(?:Type)?\s*\[\s*\]\s*|new\s+List\s*<\s*Type\s*>\s*(?:\(\s*\))?\s*)?\{([^{}]*)\}\s*;/g;
const GENERIC_REGISTRATION_CALL = /\.(?:AddScoped|AddTransient|AddSingleton|Register)\s*</g;

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
const ERROR_RETURN_TRIGGER = /\breturn\s+(?:(?:Typed)?Results\s*\.\s*)?(?:BadRequest|NotFound|Forbid|StatusCode|Unauthorized)\s*\(|\bthrow\s+new\s+\w*Exception\b/;
const GUARD_TRIGGER = /\bif\s*\([^()]*==\s*null\s*\)\s*(?:\{\s*)?return\b|\?\?\s*throw\b/;
const TOGGLE_KEYWORD = /\bIsToggleEnabled\s*\(|\bIsEnabled\s*\(\s*Toggles\.|\bFeatureToggle\b/;
const VALIDATION_KEYWORD = /\bIsValid\s*\(|\bValidate\s*\(|\.Validate\b/;

const MESSAGE_MARKER_INTERFACE = /\bICorrelatedMessage\b|\bIMessage\b|\bCorrelatedBy\s*</;
/** A saga's correlation declaration -- `ConfigureHowToFindSaga(x => x.OrderId)` or
 * `CorrelateBy(x => x.OrderId)` -- with the correlated property in the capture group. Only
 * the single-property member-access shape is read; a saga that correlates on an expression
 * more complex than that states no correlation this pass can read. */
const CORRELATION_CALL = /\b(?:ConfigureHowToFindSaga|CorrelateBy)\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)/;
/** A positional record with no body -- `record X(string Id);`, optionally `record class`, with
 * or without a base list -- opens no brace, so the frame scanner never sees it. Read over the
 * attribute-stripped masked text and ended at `;`, which a braced record never has, so a record
 * the scanner did frame is never reported twice. `record struct` is a value type and stays out. */
const POSITIONAL_RECORD = /\brecord\s+(?:class\s+)?(?!struct\b)(\w+)\s*(?:<[^<>]*>)?\s*\([^()]*\)\s*(:[^;{}]*)?;/g;

/** Split one `publishCalls` entry into its verb (a regex source) and its 1-based argument
 * index -- `Defer/2` gives `{ verb: 'Defer', index: 2 }`, a bare `Defer` gives `{ verb:
 * 'Defer', index: 1 }`. `lib/config.js` has already refused anything but a bare verb or a
 * `Verb/N` with a positive-integer `N`, so this never fails. */
function splitPublishCallEntry(entry) {
  const slash = entry.indexOf('/');
  if (slash === -1) return { verb: entry, index: 1 };
  return { verb: entry.slice(0, slash), index: Number(entry.slice(slash + 1)) };
}

/**
 * Compile the worker-queue pattern set for one extraction run. Every field of
 * `overrides` comes from the top-level `workerPatterns` configuration key, already
 * validated as regex-source strings:
 *
 * - `publishCalls`, `consumerBases`, `broadcastCalls`, `sagaInterfaces` extend the built-in
 *   alternations above with a framework's own method, base-type or saga-interface names.
 *   A `publishCalls` entry may carry a `/N` argument-position suffix (see
 *   `splitPublishCallEntry`); entries at position 1, built in and configured alike, join one
 *   alternation matched by `publishCall` below, and entries at a later position each get
 *   their own named capture group in `publishCallPositional` so `extractPublish` can tell
 *   which entry matched and at which index to look for the message.
 * - `messagePaths`, `messageSuffixes` extend the built-in folder and class-name rules that
 *   make a class or record declaration a `message_class`.
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
    messagePaths = [], messageSuffixes = [], sagaInterfaces = [],
  } = overrides;
  const publishEntries = [...DEFAULT_PUBLISH_CALLS, ...publishCalls].map(splitPublishCallEntry);
  const position1 = publishEntries.filter((entry) => entry.index === 1).map((entry) => entry.verb);
  const positionN = publishEntries.filter((entry) => entry.index > 1);
  const publish = position1.join('|');
  const consumerBase = [...DEFAULT_CONSUMER_BASES, ...consumerBases].join('|');
  const sagaInterface = [...DEFAULT_SAGA_INTERFACES, ...sagaInterfaces].join('|');
  const broadcast = [...DEFAULT_BROADCAST_CALLS, ...broadcastCalls].join('|');
  const messagePath = [...DEFAULT_MESSAGE_PATHS, ...messagePaths].join('|');
  const messageSuffix = [...DEFAULT_MESSAGE_SUFFIXES, ...messageSuffixes].join('|');
  return {
    /** A repository-relative file path inside a message-contract folder; each alternative is
     * anchored between path separators, so `Messaging/Events` never matches `Messaging/EventsLog`. */
    messageFilePath: new RegExp(`(^|/)(?:${messagePath})(/|$)`),
    /** A class or record name that ends in a message-contract suffix. */
    messageNameSuffix: new RegExp(`(?:${messageSuffix})$`),
    /** Four spellings of a position-1 publish call, the verb and the message each in their own
     * named capture group: the generic argument `Publish<T>(…)`, the inline `Publish(new T
     * …)`, the saga initialiser `PublishAsync(ctx => ctx.Init<T>(…))`, and a bare identifier as
     * the first argument (`Publish(job, ct)`), which `extractPublish` resolves to its declared
     * type. Only a verb with no configured `/N` suffix (the default index of 1) is in `publish`,
     * so a verb configured at a later position never double-matches here. */
    publishCall: new RegExp(
      `\\b(?<verbGeneric>${publish})(?:Async)?\\s*<\\s*(?<msgGeneric>\\w+)\\s*>` +
        `|\\b(?<verbNew>${publish})(?:Async)?\\s*\\(\\s*(?:await\\s+)?new\\s+(?<msgNew>\\w+)\\b` +
        `|\\b(?<verbSaga>${publish})(?:Async)?\\s*\\(\\s*\\w+\\s*=>\\s*\\w+\\s*\\.\\s*Init\\s*<\\s*(?<msgSaga>\\w+)\\s*>` +
        `|\\b(?<verbIdent>${publish})(?:Async)?\\s*\\(\\s*(?:await\\s+)?(?<msgIdent>[A-Za-z_]\\w*)\\s*[,)]`,
      'g',
    ),
    /** Every publish verb configured at an argument position other than 1, one named capture
     * group per entry (`p0`, `p1`, …, in `positionN`'s order) so a match tells `extractPublish`
     * both which verb fired and, through `positionN[i].index`, which argument of the call to
     * read the message from. `null` when every verb sits at position 1, the built-in default. */
    publishCallPositional: positionN.length > 0
      ? new RegExp(
          `\\b(?:${positionN.map((entry, i) => `(?<p${i}>${entry.verb})`).join('|')})(?:Async)?\\s*\\(`,
          'g',
        )
      : null,
    /** `{ verb, index }` in the same order as `publishCallPositional`'s `p0`, `p1`, … groups. */
    positionalPublishCalls: positionN,
    /** One base-list entry, its namespace qualifier dropped, that names a consumer base and
     * the message it consumes: `IConsumer<M>` or `BaseConsumer<Batch<M>>`. Anchored to the whole
     * entry so a base that merely begins with a consumer name (`IConsumerRegistry`) never
     * qualifies; `extractConsume` applies it to the entries the class-frame parser split. */
    consumerBaseEntry: new RegExp(
      `^(?:[\\w.]+\\.)*(?:${consumerBase})\\s*<\\s*(?:Batch\\s*<\\s*(\\w+)\\s*>|(\\w+))\\s*>$`,
    ),
    /** One base-list entry that names a saga interface and the message that initiates it --
     * `IAmInitiatedBy<M>` -- read the same way `consumerBaseEntry` reads a consumer base, but
     * with no `Batch<T>` wrapping: a saga is never initiated by a batch. `extractSaga` applies
     * it to the same class-frame base-list entries `extractConsume` reads. */
    sagaInterfaceEntry: new RegExp(`^(?:[\\w.]+\\.)*(?:${sagaInterface})\\s*<\\s*(\\w+)\\s*>$`),
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
  // The header runs from the previous brace, so a brace-less declaration before this one --
  // a positional `record Job(string Id);`, a field, an abstract method -- shares the window.
  // The declaration that owns the brace is the last statement in it: read after the last `;`.
  const ownStart = header.lastIndexOf(';') + 1;
  const own = header.slice(ownStart);
  const match = own.match(CLASS_SIGNATURE);
  if (!match) return null;
  return {
    keyword: match[1],
    name: match[2],
    typeParamsText: match[3],
    primaryParamsText: match[4],
    trailer: own.slice(match.index + match[0].length),
    matchIndex: ownStart + match.index,
    isAbstract: /\babstract\b/.test(own.slice(0, match.index)),
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
          keywordIndex: lastBoundary + classInfo.matchIndex,
          isAbstract: classInfo.isAbstract,
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

/**
 * Split a call's raw argument-list text at its top-level commas, respecting `(`, `[`, `<`
 * and `{` nesting. Unlike `splitTopLevel`, whose callers split parameter lists, generic
 * argument lists and base lists -- none of which ever contain a brace -- a call argument
 * commonly is an object initializer (`bus.Defer(delay, new T { A = 1, B = 2 })`), whose own
 * comma must never be read as an argument boundary.
 */
function splitCallArguments(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '<' || ch === '[' || ch === '(' || ch === '{') depth += 1;
    else if (ch === '>' || ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
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

function extractMethodCalls(relPath, content, masked, methodFrames, fieldsByClass, facts, control) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = callableFields(method, fieldsByClass.get(method.classRef));
    if (!fields || fields.size === 0) continue;

    const alternation = [...fields]
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length)
      .join('|');
    const callRe = new RegExp(`(?:\\bthis\\.)?\\b(${alternation})\\.(\\w+)\\s*(?:<\\s*([^<>]*)\\s*>)?\\s*\\(`, 'g');
    const body = frameBody(masked, method);

    let match;
    callRe.lastIndex = 0;
    while ((match = callRe.exec(body))) {
      const calledMethod = match[2];
      if (calledMethod === 'Result' || calledMethod === 'Value') continue;
      const typeArg = match[3] ? match[3].trim() : '';
      const at = method.startIndex + match.index;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, at),
          class: method.classRef.name,
          method: method.name,
          field: match[1],
          calledMethod,
          ...control(method, at),
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
function extractServiceLocatorCalls(relPath, content, masked, methodFrames, fieldsByClass, facts, control) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = fieldsByClass.get(method.classRef);
    if (!fields || fields.size === 0) continue;

    const alternation = [...fields]
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length)
      .join('|');
    const body = frameBody(masked, method);

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
      const at = method.startIndex + match.index;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, at),
          class: method.classRef.name,
          method: method.name,
          field: receiverType,
          calledMethod,
          ...control(method, at),
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
      const at = method.startIndex + match.index;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, at),
          class: method.classRef.name,
          method: method.name,
          field: match[1],
          calledMethod,
          ...control(method, at),
          receiverType: local.receiverType,
        }),
      );
    }
  }
}

/**
 * Line starts under the terminator rule C# itself uses: CR, LF and CRLF each end a line.
 * A CR terminates only when no LF follows it, so a CRLF pair advances the line once, on its
 * LF. Several passes here number their lines by splitting on `/\r\n|\r|\n/`; counting LF
 * alone would leave this function and `lineAt` one line behind them for every stray CR
 * earlier in the file, and offsets in a mixed-terminator file would resolve to a line that
 * holds different text than the pass which produced them saw.
 */
function computeLineStartIndices(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '\n') starts.push(i + 1);
    else if (char === '\r' && content[i + 1] !== '\n') starts.push(i + 1);
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
function extractElementCalls(relPath, content, masked, methodFrames, fieldsByClass, facts, control) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = callableFields(method, fieldsByClass.get(method.classRef));
    if (!fields || fields.size === 0) continue;
    const body = frameBody(masked, method);

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
        const at = bodyStartAbs + callMatch.index;
        facts.push(
          fact('method_call', {
            file: relPath,
            line: lineAt(content, at),
            class: method.classRef.name,
            method: method.name,
            field: collectionField,
            calledMethod,
            ...control(method, at),
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
      const at = method.startIndex + indexedMatch.index;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineAt(content, at),
          class: method.classRef.name,
          method: method.name,
          field: indexedMatch[1],
          calledMethod,
          ...control(method, at),
          elementAccess: true,
        }),
      );
    }
  }
}

/**
 * The base-list entries of a class header's trailer, split at top level and cut at a
 * `where` constraint: `: Base<A, B>, IFoo` gives `['Base<A, B>', 'IFoo']`; a header with no
 * base list gives `[]`. Each entry keeps its generic arguments and namespace qualifier.
 */
function baseListEntries(trailer) {
  if (!trailer) return [];
  let text = trailer.trim();
  if (!text.startsWith(':')) return [];
  text = text.slice(1);
  const whereMatch = text.match(/\bwhere\b/);
  if (whereMatch) text = text.slice(0, whereMatch.index);
  return splitTopLevel(text, ',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
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
  const names = [];
  for (const entry of baseListEntries(trailer)) {
    const identifier = entry.match(/^([\w.]+)/);
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
  const lineStarts = lineStartsFor(content);

  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const startLine = lineAt(content, method.startIndex);
    const methodEndLine = lineAt(content, method.endIndex);
    for (let ln = startLine; ln <= methodEndLine; ln += 1) {
      const lineStart = lineStarts[ln - 1];
      const maskedLine = visibleLine(maskedLines[ln - 1] ?? '', lineStart, method);
      const kind = classifyBranch(maskedLine);
      if (!kind) continue;

      const text = (contentLines[ln - 1] ?? '').trim().slice(0, 120);
      const base = { file: relPath, line: ln, class: method.classRef.name, method: method.name };

      if (kind === 'error_return') {
        facts.push(fact('branch_point', { ...base, kind, text, endLine: ln }));
        continue;
      }

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

const PREDICATE_CALL = /\.\s*(?:Where|Any|All|First|FirstOrDefault)\s*(?:<[^<>()]*>)?\s*\(/g;
const DECISION_TEXT_LIMIT = 120;

function isOpenBracket(c) {
  return c === '(' || c === '[' || c === '{';
}

function isCloseBracket(c) {
  return c === ')' || c === ']' || c === '}';
}

/**
 * Whether the `?` at `at` is a conditional operator: not `?.`, `?[`, part of `??`, or a
 * nullable type mark (`int? x`, `T?>`, `(int?)`). A conditional operator has its `:` at its
 * own depth before the expression ends.
 */
function isConditionalMark(body, at) {
  const next = body[at + 1];
  if (next === '.' || next === '[' || next === '?' || body[at - 1] === '?') return false;
  if (next === ')' || next === '>' || next === ',' || next === ']' || next === ';' || next === '=') return false;
  const after = /^\s*([A-Za-z_]\w*)\s*([=;,)])/.exec(body.slice(at + 1, at + 200));
  if (after && !(after[2] === '=' && body[at + 1 + after[0].length] === '=')) return false;
  return conditionalColon(body, at) !== null;
}

/** The `:` that closes the conditional operator whose `?` is at `at`, or null. */
function conditionalColon(body, at) {
  let depth = 0;
  let nested = 0;
  for (let i = at + 1; i < body.length; i += 1) {
    const c = body[i];
    if (isOpenBracket(c)) depth += 1;
    else if (isCloseBracket(c)) {
      if (depth === 0) return null;
      depth -= 1;
    } else if (depth === 0) {
      if (c === ';' || c === ',') return null;
      if (c === '?' && body[i + 1] === '?') {
        i += 1;
        continue;
      }
      if (c === '?' && body[i + 1] !== '.' && body[i + 1] !== '[' && body[i - 1] !== '?') nested += 1;
      else if (c === ':' && body[i + 1] !== ':' && body[i - 1] !== ':') {
        if (nested === 0) return i;
        nested -= 1;
      }
    }
  }
  return null;
}

/** Where the operand that starts after `from` ends: the last character before the end of its
 * expression (`;`, a top-level `,` or `:`, or a bracket that closes an outer one). */
function operandEnd(body, from) {
  let depth = 0;
  let last = from - 1;
  for (let i = from; i < body.length; i += 1) {
    const c = body[i];
    if (isOpenBracket(c)) depth += 1;
    else if (isCloseBracket(c)) {
      if (depth === 0) return last;
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === ',' || (c === ':' && body[i + 1] !== ':' && body[i - 1] !== ':'))) return last;
    if (!/\s/.test(c)) last = i;
  }
  return last;
}

/** Where the operand that ends before `to` starts, read back to an assignment, a `return`,
 * an opening bracket, a top-level `,`, `;`, `?`, `:` or `??`, or a lambda arrow. */
function operandStart(body, to) {
  let depth = 0;
  let first = to + 1;
  for (let i = to; i >= 0; i -= 1) {
    const c = body[i];
    if (isCloseBracket(c)) depth += 1;
    else if (isOpenBracket(c)) {
      if (depth === 0) return first;
      depth -= 1;
    } else if (depth === 0) {
      if (c === ';' || c === ',' || c === ':') return first;
      if (c === '?' && body[i + 1] !== '.' && body[i + 1] !== '[') return first;
      if (c === '=' && !'=!<>'.includes(body[i - 1] ?? '') && body[i + 1] !== '=' && body[i + 1] !== '>') return first;
      if (c === '>' && body[i - 1] === '=') return first;
      if (/\w/.test(c) && !/\w/.test(body[i + 1] ?? '')) {
        const word = body.slice(identifierStart(body, i), i + 1);
        if (word === 'return' || word === 'await' || word === 'yield' || word === 'throw') return first;
      }
    }
    if (!/\s/.test(c)) first = i;
  }
  return first;
}

function decisionText(content, from, to) {
  return content.slice(from, to + 1).replace(/\s+/g, ' ').trim().slice(0, DECISION_TEXT_LIMIT);
}

/**
 * The decisions an expression makes, which no statement states: each conditional operator
 * (`ternary`, its condition as text), each `??` (`coalesce`, the expression as text) and each
 * lambda passed to `Where`, `Any`, `All`, `First` or `FirstOrDefault` (`predicate`, the lambda
 * body as text). A `??` whose right side throws is a guard, and `??=` assigns, so neither is
 * a choice here. One fact per operator, at the line of its operator or call.
 */
function extractExpressionDecisions(relPath, content, masked, starts, frames, facts) {
  for (const frame of frames) {
    if (!frame.classRef || frame.endIndex == null) continue;
    const body = frameBody(masked, frame);
    const offset = frame.startIndex;
    const lineOf = (i) => lineFromStarts(starts, offset + i);
    const base = { file: relPath, class: frame.classRef.name, method: frame.name };
    const found = [];
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '?') continue;
      if (body[i + 1] === '?') {
        const after = i + 2;
        i += 1;
        if (body[after] === '=') continue;
        if (/^\s*throw\b/.test(body.slice(after, after + 40))) continue;
        const start = operandStart(body, i - 2);
        const end = operandEnd(body, after);
        if (start > i - 2 || end < after) continue;
        found.push({ at: i - 1, kind: 'coalesce', text: decisionText(content, offset + start, offset + end), end });
        continue;
      }
      if (!isConditionalMark(body, i)) continue;
      const start = operandStart(body, i - 1);
      if (start > i - 1) continue;
      const colon = conditionalColon(body, i);
      found.push({ at: i, kind: 'ternary', text: decisionText(content, offset + start, offset + i - 1), end: operandEnd(body, colon + 1) });
    }
    PREDICATE_CALL.lastIndex = 0;
    let match;
    while ((match = PREDICATE_CALL.exec(body))) {
      const open = match.index + match[0].length - 1;
      const close = findMatchingParen(body, open);
      if (close == null) continue;
      const lambda = /^\s*(?:\(\s*[^()]*\)|[A-Za-z_]\w*)\s*=>/.exec(body.slice(open + 1, close));
      if (!lambda) continue;
      const bodyStart = open + 1 + lambda[0].length;
      const end = operandEnd(body, bodyStart);
      found.push({ at: match.index + 1, kind: 'predicate', text: decisionText(content, offset + bodyStart, offset + Math.min(end, close - 1)), end });
    }
    found.sort((a, b) => a.at - b.at);
    for (const item of found) {
      if (item.text === '') continue;
      facts.push(fact('branch_point', { ...base, line: lineOf(item.at), kind: item.kind, text: item.text, endLine: Math.max(lineOf(item.at), lineOf(item.end)) }));
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

/**
 * A frame's body with the extents of the lambda handlers registered inside it blanked,
 * length preserved, so a registering method never reads a lambda's calls, branches or
 * catches as its own; the lambda's frame reads them as its body.
 */
function frameBody(masked, frame) {
  let body = masked.slice(frame.startIndex, frame.endIndex);
  for (const [start, end] of frame.holes || []) {
    const from = Math.max(start, frame.startIndex) - frame.startIndex;
    const to = Math.min(end, frame.endIndex) - frame.startIndex;
    if (to > from) body = body.slice(0, from) + ' '.repeat(to - from) + body.slice(to);
  }
  return body;
}

/**
 * One line of a frame as the frame sees it: what lies before its start, after its end or
 * inside a lambda registered in it is blanked, so a registering method's `if` on the
 * registration line stays the method's and never the lambda's, and the reverse.
 */
function visibleLine(line, lineStart, frame) {
  const holes = frame.holes || [];
  if (holes.length === 0 && lineStart >= frame.startIndex && lineStart + line.length <= frame.endIndex) return line;
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const at = lineStart + i;
    const hidden = at < frame.startIndex || at >= frame.endIndex || holes.some(([start, end]) => at >= start && at < end);
    out += hidden ? ' ' : line[i];
  }
  return out;
}

/** The class fields a frame can call through: a lambda handler's own parameters shadow
 * same-named fields, as a parameter does in the language. */
function callableFields(method, fields) {
  if (!method.lambda || !fields || fields.size === 0) return fields;
  const own = new Set(parseParams(method.paramsText).map((param) => param.name));
  return new Set([...fields].filter((name) => !own.has(name)));
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
function looksLikeGenericDeclarationEcho(masked, matchEndIndex, name) {
  const window = masked.slice(matchEndIndex, matchEndIndex + name.length + 8);
  const re = new RegExp(`^\\s*\\(\\s*${escapeRegExp(name)}\\b`);
  return re.test(window);
}

/**
 * The parameter types of a signature, as written, for the optional `paramTypes` field
 * of a `method_span`: what lets the walk tell which method of a consumer takes the
 * message it consumes. Attributes, the `ref`/`out`/`in`/`this`/`params` modifiers and
 * default values are not part of the type; an array rank is, which is why the list is read
 * off the source at the signature rather than off the frame's attribute-blanked text.
 * Omitted for a parameterless method.
 */
function paramTypesField(masked, headerIndex, fallbackParamsText) {
  const text = (rawParamsAt(masked, headerIndex) ?? fallbackParamsText ?? '').trim();
  if (!text) return {};
  const types = splitTopLevel(text, ',')
    .map((raw) => raw.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').split('=')[0].trim())
    .map((entry) => entry.replace(/^(?:(?:ref|out|in|this|params)\s+)+/, ''))
    .map((entry) => entry.split(/\s+/))
    .filter((tokens) => tokens.length >= 2)
    .map((tokens) => tokens.slice(0, -1).join(' '));
  return types.length > 0 ? { paramTypes: types } : {};
}

/**
 * One `method_span` per method/constructor body the brace scanner already
 * delimited: `line` is the signature's own start line, `endLine` its matching
 * closing brace. Lets the joiner attach file-level facts (`publish`,
 * `redis_publish`, `signalr_push`, `http_out`) to the method that actually
 * contains them instead of to the whole file. `paramTypes` carries the signature's
 * parameter types so the walk can pick a method by what it takes.
 */
function extractMethodSpans(relPath, content, masked, methodFrames, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineAt(content, method.headerIndex),
        endLine: lineAt(content, method.endIndex),
        class: method.classRef.name,
        method: method.name,
        ...paramTypesField(masked, method.headerIndex, method.paramsText),
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
    results.push({
      name: match[1],
      paramsText: match[2],
      classEntry,
      matchIndex: match.index,
      bodyIndex: match.index + match[0].length,
      semicolonIndex,
    });
  }
  return results;
}

function extractExpressionBodiedMethodSpans(relPath, content, masked, expressionBodiedMethods, facts) {
  for (const entry of expressionBodiedMethods) {
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineAt(content, entry.matchIndex),
        endLine: lineAt(content, entry.semicolonIndex),
        class: entry.classEntry.name,
        method: entry.name,
        ...paramTypesField(masked, entry.matchIndex, entry.paramsText),
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
function extractSelfCalls(relPath, content, masked, methodFrames, methodNamesByClass, fieldsByClass, facts, control) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const methodNames = methodNamesByClass.get(method.classRef);
    if (!methodNames || methodNames.size === 0) continue;
    const fieldNames = callableFields(method, fieldsByClass.get(method.classRef)) ?? new Set();

    const body = frameBody(masked, method);
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
          ...control(method, method.startIndex + match.index),
        }),
      );
    }
  }
}

/**
 * The pseudo-frame an expression-bodied method gives the call passes: its body runs from
 * after `=>` to its `;`, and a lambda handler registered inside it is a hole, as it is in a
 * block body, so its calls stay the lambda's own.
 */
function expressionFrames(expressionBodiedMethods, methodFrames) {
  return expressionBodiedMethods.map((entry) => {
    const holes = methodFrames
      .filter((frame) => frame.lambda && frame.headerIndex >= entry.bodyIndex && frame.endIndex != null && frame.endIndex <= entry.semicolonIndex)
      .map((frame) => [frame.headerIndex, frame.endIndex + 1]);
    return {
      name: entry.name,
      isCtor: false,
      paramsText: entry.paramsText,
      classRef: entry.classEntry,
      headerIndex: entry.matchIndex,
      startIndex: entry.bodyIndex,
      endIndex: entry.semicolonIndex,
      expressionBodied: true,
      ...(holes.length > 0 ? { holes } : {}),
    };
  });
}

const MEMBER_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'async', 'sealed', 'abstract',
  'new', 'readonly', 'partial', 'extern', 'unsafe',
]);
const MEMBER_DECLARATION =
  /([A-Za-z_][\w.]*(?:\s*<[^;{}()=]*?>)?(?:\s*\[\s*\])*\??)\s+([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:where\b[^{;=]*)?(?=\{|=>|;)/g;
const NOT_A_TYPE = new Set([
  'return', 'new', 'await', 'throw', 'else', 'yield', 'case', 'goto', 'in', 'is', 'as', 'typeof', 'nameof', 'sizeof',
  'default', 'using', 'lock', 'when', 'where', 'operator', 'explicit', 'implicit', 'event', 'if', 'while', 'for',
  'foreach', 'switch', 'catch', 'fixed', 'checked', 'unchecked', 'not', 'and', 'or', 'var',
]);

/** The modifiers written before the declaration at `index`, read back over whitespace. */
function modifiersBefore(masked, index) {
  const found = new Set();
  let i = index;
  for (;;) {
    let end = i;
    while (end > 0 && /\s/.test(masked[end - 1])) end -= 1;
    let start = end;
    while (start > 0 && /\w/.test(masked[start - 1])) start -= 1;
    const word = masked.slice(start, end);
    if (!MEMBER_MODIFIERS.has(word)) return found;
    found.add(word);
    i = start;
  }
}

/**
 * The method declarations of one repository, as the chain links read them: per class (or
 * interface, record, struct) the methods it declares with their return types and whether
 * they are static, every base and interface it names, and every static extension method by
 * the type of its `this` parameter. Names are simple names; overloads of one name in one
 * type are one entry.
 */
function buildTypeIndex(scans) {
  const types = new Map();
  const extensions = new Map();
  const typeEntry = (name) => {
    if (!types.has(name)) types.set(name, { bases: new Set(), methods: new Map() });
    return types.get(name);
  };
  for (const scan of scans) {
    const { masked, classFrames, methodFrames } = scan;
    for (const frame of classFrames) {
      const entry = typeEntry(frame.name);
      const trailer = String(frame.trailer ?? '').replace(/\bwhere\b[\s\S]*$/, '');
      const colon = trailer.indexOf(':');
      if (colon === -1) continue;
      for (const part of splitTopLevel(trailer.slice(colon + 1), ',')) {
        const base = bareTypeName(part);
        if (base) entry.bases.add(base);
      }
    }
    MEMBER_DECLARATION.lastIndex = 0;
    let match;
    while ((match = MEMBER_DECLARATION.exec(masked))) {
      const returnText = match[1].trim();
      if (NOT_A_TYPE.has(returnText) || MEMBER_MODIFIERS.has(returnText)) continue;
      if (findEnclosingMethod(methodFrames, match.index)) continue;
      const owner = findEnclosingClass(classFrames, match.index);
      if (!owner || match[2] === owner.name) continue;
      const modifiers = modifiersBefore(masked, match.index);
      const isStatic = modifiers.has('static');
      const methods = typeEntry(owner.name).methods;
      if (!methods.has(match[2])) methods.set(match[2], { returnTypes: new Set(), instance: false, isStatic: false });
      const method = methods.get(match[2]);
      method.returnTypes.add(returnText.replace(/\s+/g, ''));
      if (isStatic) method.isStatic = true;
      else method.instance = true;
      const first = splitTopLevel(match[3], ',')[0] ?? '';
      const self = isStatic ? /^\s*this\s+([\s\S]+?)\s+[A-Za-z_]\w*\s*$/.exec(stripAttributes(first)) : null;
      if (self) {
        const target = bareTypeName(self[1]);
        if (!extensions.has(target)) extensions.set(target, new Map());
        const byName = extensions.get(target);
        if (!byName.has(match[2])) byName.set(match[2], new Map());
        const byClass = byName.get(match[2]);
        if (!byClass.has(owner.name)) byClass.set(owner.name, new Set());
        byClass.get(owner.name).add(returnText.replace(/\s+/g, ''));
      }
    }
  }
  return { types, extensions };
}

/** Every base and interface the repository declares for `name`, nearest first, never `name`. */
function ancestorsOf(index, name) {
  const out = [];
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length > 0) {
    const current = index.types.get(queue.shift());
    if (!current) continue;
    for (const base of current.bases) {
      if (seen.has(base)) continue;
      seen.add(base);
      out.push(base);
      queue.push(base);
    }
  }
  return out;
}

function oneReturnType(returnTypes) {
  return returnTypes.size === 1 ? [...returnTypes][0] : null;
}

/**
 * The one method a call `<receiver of type typeName>.methodName(…)` can reach, in the order
 * C# member lookup takes: an instance method of the type itself, then one of an interface or
 * base the repository declares for it, then an extension method on the type or on one of
 * those. Only the first tier that has a candidate counts, and it must have exactly one
 * declaring type, or the call reaches no known method.
 */
function chainTarget(index, typeName, methodName) {
  if (!typeName) return null;
  const own = index.types.get(typeName)?.methods.get(methodName);
  if (own && own.instance) return { receiverType: typeName, returnType: oneReturnType(own.returnTypes) };
  const ancestors = ancestorsOf(index, typeName);
  const inherited = ancestors.filter((base) => index.types.get(base)?.methods.get(methodName)?.instance);
  if (inherited.length > 0) {
    if (inherited.length > 1) return null;
    return { receiverType: inherited[0], returnType: oneReturnType(index.types.get(inherited[0]).methods.get(methodName).returnTypes) };
  }
  const extension = new Map();
  for (const target of [typeName, ...ancestors]) {
    for (const [owner, returnTypes] of index.extensions.get(target)?.get(methodName) ?? []) {
      if (!extension.has(owner)) extension.set(owner, new Set());
      for (const returnType of returnTypes) extension.get(owner).add(returnType);
    }
  }
  if (extension.size !== 1) return null;
  const [[owner, returnTypes]] = [...extension];
  return { receiverType: owner, returnType: oneReturnType(returnTypes) };
}

const TASK_TYPE = /^(?:(?:global::)?System\.Threading\.Tasks\.)?(?:Task|ValueTask)<([\s\S]+)>$/;

/** The simple name a type text is looked up by: `Ns.User?` and `User` are one type. */
function lookupName(typeText) {
  const text = String(typeText ?? '').replace(/^global::/, '').replace(/\?$/, '').trim();
  if (text === '' || text.includes('[')) return null;
  return bareTypeName(text) || null;
}

function isIdentifierChar(c) {
  return c !== undefined && /\w/.test(c);
}

function skipSpaceBack(text, i) {
  let j = i;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  return j;
}

function identifierStart(text, end) {
  let i = end;
  while (i > 0 && isIdentifierChar(text[i - 1])) i -= 1;
  return i;
}

/** The `open` bracket that matches the `close` bracket at `end`, read backwards. */
function matchingOpenBack(text, end, open, close) {
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (text[i] === close) depth += 1;
    else if (text[i] === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

const LOCAL_DECLARED = (name) =>
  new RegExp(`(?<![\\w.])([A-Za-z_][\\w.]*(?:\\s*<[^;{}()=]*?>)?\\??)\\s+${escapeRegExp(name)}\\s*(?:=(?!=)|;|\\bin\\b)`, 'g');
const LOCAL_NEW = (name) => new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)\\s*(?:<[^<>()]*>)?\\s*[({]`, 'g');

/** The declared type of the local `name` nearest before `at`: a typed declaration or a
 * `var name = new T(…)`. `undefined` when no local of that name is declared before it, null
 * when one is but its type is not written. */
function localType(body, name, at) {
  let best = null;
  for (const [pattern, typed] of [
    [LOCAL_DECLARED(name), true],
    [LOCAL_NEW(name), true],
    [new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=(?!=)`, 'g'), false],
    [new RegExp(`\\b(?:out|foreach\\s*\\(\\s*)var\\s+${escapeRegExp(name)}\\b`, 'g'), false],
  ]) {
    let match;
    while ((match = pattern.exec(body)) && match.index < at) {
      const text = typed ? match[1].trim() : null;
      if (typed && (NOT_A_TYPE.has(text) || MEMBER_MODIFIERS.has(text))) continue;
      if (!best || match.index > best.index) best = { index: match.index, type: text };
    }
  }
  return best ? best.type : undefined;
}

/**
 * The static type of the expression in `body` that ends at `end`, as the chain links know
 * it, with how it was reached: `field` and `this` receivers and the locator call are the
 * ones the plain call passes already write facts for. Null when the type is not known.
 */
function expressionType(body, end, scope, depth = 0) {
  if (depth > 64) return null;
  const j = skipSpaceBack(body, end);
  if (j < 0) return null;
  if (body[j] === ')') {
    const open = matchingOpenBack(body, j, '(', ')');
    if (open == null) return null;
    let k = skipSpaceBack(body, open - 1);
    let typeArg = null;
    if (body[k] === '>') {
      const lt = matchingOpenBack(body, k, '<', '>');
      if (lt == null) return null;
      typeArg = body.slice(lt + 1, k).trim();
      k = skipSpaceBack(body, lt - 1);
    }
    if (isIdentifierChar(body[k])) {
      const start = identifierStart(body, k);
      const name = body.slice(start, k + 1);
      const before = skipSpaceBack(body, start - 1);
      if (body[before] === '.') {
        const receiver = expressionType(body, before - 1, scope, depth + 1);
        if (!receiver) return null;
        if ((name === 'GetRequiredService' || name === 'GetService') && typeArg && receiver.kind === 'field') {
          return { type: typeArg, kind: 'locator' };
        }
        const target = chainTarget(scope.index, lookupName(receiver.type), name);
        return target && target.returnType ? { type: target.returnType, kind: 'call' } : null;
      }
      const qualified = qualifiedNewType(body, start, k);
      if (qualified) return { type: qualified, kind: 'new' };
      if (!CSHARP_KEYWORDS.has(name)) {
        const target = chainTarget(scope.index, scope.className, name);
        return target && target.returnType ? { type: target.returnType, kind: 'call' } : null;
      }
    }
    const inner = body.slice(open + 1, j);
    const awaited = /^\s*await\s+/.exec(inner);
    if (awaited) {
      const result = expressionType(body, j - 1, scope, depth + 1);
      const unwrapped = result && TASK_TYPE.exec(String(result.type).replace(/\s+/g, ''));
      return unwrapped ? { type: unwrapped[1], kind: 'call' } : null;
    }
    return null;
  }
  if (!isIdentifierChar(body[j])) return null;
  const start = identifierStart(body, j);
  const name = body.slice(start, j + 1);
  const before = skipSpaceBack(body, start - 1);
  if (body[before] === '.') return null;
  if (name === 'this') return { type: scope.className, kind: 'this' };
  if (CSHARP_KEYWORDS.has(name) || /^\d/.test(name)) return null;
  const local = localType(body, name, start);
  if (local !== undefined) return local ? { type: local, kind: 'local', name } : null;
  const param = scope.params.find((entry) => entry.name === name);
  if (param) return { type: param.type.replace(/^(?:ref|in|out|this|params|scoped)\s+/, ''), kind: 'param', name };
  const field = scope.fieldTypes.get(name);
  if (field) return { type: field, kind: 'field', name };
  return null;
}

/** The type named by `new Ns.T(` when the identifier from `start` to `end` ends such a
 * `new`, else null. */
function qualifiedNewType(body, start, end) {
  let head = start;
  for (;;) {
    const dot = skipSpaceBack(body, head - 1);
    if (body[dot] !== '.') break;
    const prev = skipSpaceBack(body, dot - 1);
    if (!isIdentifierChar(body[prev])) return null;
    head = identifierStart(body, prev);
  }
  const keywordEnd = skipSpaceBack(body, head - 1);
  if (keywordEnd < 2 || body.slice(keywordEnd - 2, keywordEnd + 1) !== 'new' || isIdentifierChar(body[keywordEnd - 3])) return null;
  return body.slice(head, end + 1).replace(/\s+/g, '');
}

const CHAIN_LINK = /\.\s*([A-Za-z_]\w*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/g;

/**
 * One `method_call` per link of a member-access chain whose receiver has a known static type
 * and whose method is one known target. A link on a constructor field, on `this` or after a
 * service-locator call has its fact from the plain call passes, and a link on a handler
 * parameter from the handler pass, so none of them is written again; its type still carries
 * the chain to the next link.
 */
function extractChainCalls(fileScans, typeIndex, facts) {
  const fieldTypesByClass = new Map();
  const written = new Set();
  const siteKey = (file, line, className, method, field, calledMethod) => JSON.stringify([file, line, className, method, field, calledMethod]);
  for (const item of facts) {
    if (item.type === 'method_call') written.add(siteKey(item.file, item.line, item.class, item.method, item.field, item.calledMethod));
    if (item.type !== 'ctor_field' || item.method !== undefined) continue;
    const key = `${item.file}|${item.class}`;
    if (!fieldTypesByClass.has(key)) fieldTypesByClass.set(key, new Map());
    fieldTypesByClass.get(key).set(item.field, item.paramType);
  }
  for (const scan of fileScans) {
    const { relPath, masked, starts } = scan;
    for (const frame of scan.callFrames ?? []) {
      if (!frame.classRef || frame.endIndex == null) continue;
      const body = frameBody(masked, frame);
      const scope = {
        index: typeIndex,
        className: frame.classRef.name,
        params: parseParams(frame.paramsText),
        fieldTypes: fieldTypesByClass.get(`${relPath}|${frame.classRef.name}`) ?? new Map(),
      };
      CHAIN_LINK.lastIndex = 0;
      let match;
      while ((match = CHAIN_LINK.exec(body))) {
        const receiver = expressionType(body, match.index - 1, scope);
        if (!receiver || receiver.kind === 'field' || receiver.kind === 'this' || receiver.kind === 'locator') continue;
        const receiverName = lookupName(receiver.type);
        const target = chainTarget(typeIndex, receiverName, match[1]);
        if (!target) continue;
        const at = frame.startIndex + match.index + match[0].indexOf(match[1]);
        const line = lineFromStarts(starts, at);
        if (receiver.name && written.has(siteKey(relPath, line, frame.classRef.name, frame.name, receiver.name, match[1]))) continue;
        facts.push(
          fact('method_call', {
            file: relPath,
            line,
            class: frame.classRef.name,
            method: frame.name,
            field: receiverName,
            calledMethod: match[1],
            receiverType: target.receiverType,
            ...scan.control(frame, at),
          }),
        );
      }
    }
  }
}

function toRelativePath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split('\\').join('/');
}

/** Line starts built once per text while an `extract` run is active, so a pass that
 * reports many offsets in one file does not walk it from the start on each lookup. It is
 * null outside a run, where a lone lookup keeps nothing, and a run that throws clears it
 * too, so no index outlives the text it was built for. */
let runLineStarts = null;

function lineStartsFor(content) {
  if (runLineStarts === null) return computeLineStartIndices(content);
  let starts = runLineStarts.get(content);
  if (starts === undefined) {
    starts = computeLineStartIndices(content);
    runLineStarts.set(content, starts);
  }
  return starts;
}

/** The 1-based line holding `index`, under the same terminator rule as
 * `computeLineStartIndices` — the two have to agree or an offset and the line it is
 * reported on describe different text. */
export function lineAt(content, index) {
  return lineFromStarts(lineStartsFor(content), index);
}

/** A whitespace character that does not end a line. */
function isInlineSpace(c) {
  return c !== '\n' && c !== '\r' && c !== undefined && /\s/.test(c);
}

/**
 * One attribute section `[A, B(…)]` whose `[` is at `open`, read off the masked text by
 * bracket depth, so a section may span lines and hold a collection expression. Each
 * attribute keeps its name, the raw text of its argument list (`undefined` for a bare
 * attribute) and where that list starts. Null when the section never closes before the end of
 * its statement, or when a part of it is not an attribute.
 *
 * A brace belongs to an argument (`Tags = new[] { "a" }`) only inside an argument list; one
 * outside it is the start or end of a body, so the `[` began an expression, not a section.
 */
function attributeSectionAt(content, masked, open) {
  let depth = 0;
  let parens = 0;
  let braces = 0;
  let close = null;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === ';') return null;
    if (c === '(') parens += 1;
    else if (c === ')') parens -= 1;
    else if (c === '{' || c === '}') {
      if (parens <= 0) return null;
      braces += c === '{' ? 1 : -1;
      if (braces < 0) return null;
    } else if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === null) return null;
  const attributes = [];
  let partStart = open + 1;
  let nesting = 0;
  let angle = 0;
  for (let i = open + 1; i <= close; i += 1) {
    const c = masked[i];
    if (i < close && (c === '(' || c === '[')) nesting += 1;
    else if (i < close && (c === ')' || c === ']')) nesting -= 1;
    else if (i < close && nesting === 0 && c === '<') angle += 1;
    else if (i < close && nesting === 0 && c === '>') angle -= 1;
    if (i < close && !(c === ',' && nesting === 0 && angle === 0)) continue;
    const attribute = attributePart(content, masked, partStart, i);
    if (!attribute) return null;
    attributes.push(attribute);
    partStart = i + 1;
  }
  return { attributes, end: close + 1 };
}

/** One attribute of a section, `Name`, `Name<T>` or `Name(…)`, between `from` and `to`. */
function attributePart(content, masked, from, to) {
  const text = masked.slice(from, to);
  const head = /^\s*([A-Za-z_][\w.]*)\s*(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>\s*)?/.exec(text);
  if (!head) return null;
  const rest = from + head[0].length;
  if (masked.slice(rest, to).trim() === '') return { name: head[1], arg: undefined, index: from + text.search(/\S/) };
  if (masked[rest] !== '(') return null;
  const closeParen = findMatchingParen(masked, rest);
  if (closeParen == null || closeParen >= to || masked.slice(closeParen + 1, to).trim() !== '') return null;
  return {
    name: head[1],
    arg: content.slice(rest + 1, closeParen),
    argStart: rest + 1,
    argEnd: closeParen,
    index: from + text.search(/\S/),
  };
}

/**
 * The attribute sections written from `lineStart` to the end of the line the last of them
 * closes on, when that is all the lines hold: stacked sections (`[A][B]`), a section over
 * several lines and a trailing comment, which masking has blanked, all read. Null for any
 * other line.
 */
function attributeLineAt(content, masked, lineStart) {
  let i = lineStart;
  while (isInlineSpace(masked[i])) i += 1;
  if (masked[i] !== '[') return null;
  const attributes = [];
  for (;;) {
    const section = attributeSectionAt(content, masked, i);
    if (!section) return null;
    attributes.push(...section.attributes);
    let j = section.end;
    while (isInlineSpace(masked[j])) j += 1;
    if (masked[j] === '[') {
      i = j;
      continue;
    }
    if (j >= masked.length || masked[j] === '\n' || masked[j] === '\r') return { attributes, end: j };
    return null;
  }
}

/**
 * The lines of a file as the attribute passes read them: a run of attribute sections as one
 * entry carrying its attributes, every other line as itself. A line that masking leaves blank
 * (empty, or a comment alone) is skipped, as an empty line always was.
 */
function attributedLines(content, masked, starts) {
  const lines = content.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineStart = starts[i];
    const lineEnd = i + 1 < starts.length ? starts[i + 1] : masked.length;
    if (masked.slice(lineStart, lineEnd).trim() === '') continue;
    const section = attributeLineAt(content, masked, lineStart);
    if (section) {
      out.push({
        attributes: section.attributes.map((attribute) => ({ ...attribute, line: lineFromStarts(starts, attribute.index) })),
      });
      i = lineFromStarts(starts, section.end) - 1;
      continue;
    }
    out.push({ text: lines[i], index: lineStart, line: i + 1 });
  }
  return out;
}

const UNRESOLVED_TEXT_LIMIT = 120;

/**
 * The value of an attribute's route argument: its first positional argument (a named one,
 * `Name = …`, is no template) read as a constant string expression. `{ value }` when it has
 * one value, `{ value: '', unresolved: { text, line } }` when it has none the reader can
 * establish, `{ value: '' }` when the attribute states no template.
 */
function routeArgument(content, masked, attribute, scope, constants) {
  if (attribute.arg === undefined) return { value: '' };
  for (const [start, end] of topLevelRanges(masked, attribute.argStart, attribute.argEnd)) {
    const part = masked.slice(start, end);
    if (/^\s*[A-Za-z_]\w*\s*=(?!=)/.test(part)) continue;
    const label = /^\s*[A-Za-z_]\w*\s*:(?!:)/.exec(part);
    const from = label ? start + label[0].length : start;
    const raw = content.slice(from, end);
    if (raw.trim() === '') return { value: '' };
    const value = resolveConstantString(raw, masked.slice(from, end), scope, constants);
    if (value !== null) return { value };
    const text = raw.trim().replace(/\s+/g, ' ').slice(0, UNRESOLVED_TEXT_LIMIT);
    return { value: '', unresolved: { text, line: attribute.line } };
  }
  return { value: '' };
}

/** `[start, end)` ranges of `masked` between `from` and `to`, split at top-level commas. */
function topLevelRanges(masked, from, to) {
  const ranges = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, to]);
  return ranges;
}

/** The first unresolved argument of a route, in source order, as the optional fact field. */
function unresolvedField(...parts) {
  const found = parts.find((part) => part && part.unresolved);
  return found ? { unresolvedArgument: found.unresolved } : {};
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

function extractRoutes(relPath, content, masked, starts, classFrames, constants, facts) {
  let sawClass = false;
  let controllerName = null;
  let classTemplate = { value: '' };
  let scope = scopeOf(null, classFrames, masked);
  let pendingAttrs = [];

  for (const entry of attributedLines(content, masked, starts)) {
    if (entry.attributes) {
      pendingAttrs.push(...entry.attributes);
      continue;
    }
    const line = entry.text;

    if (!sawClass) {
      const classMatch = line.match(/\bclass\s+(\w+)\b/);
      if (classMatch) {
        sawClass = true;
        controllerName = classMatch[1];
        const frame = classFrames.find((candidate) => candidate.name === controllerName && candidate.keywordIndex >= entry.index) ?? null;
        scope = scopeOf(frame, classFrames, masked);
        const routeAttr = pendingAttrs.find((a) => a.name === 'Route');
        classTemplate = routeAttr ? routeArgument(content, masked, routeAttr, scope, constants) : { value: '' };
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
            const own = routeArgument(content, masked, attr, scope, constants);
            const template = expandRouteTokens(joinTemplate(classTemplate.value, own.value), controllerName, action);
            facts.push(
              fact('route', {
                file: relPath,
                line: attr.line,
                controller: controllerName,
                action,
                verb,
                template,
                ...unresolvedField(classTemplate, own),
              }),
            );
          }

          if (routeAttrs.length > 0) {
            for (const routeAttr of routeAttrs) {
              const own = routeArgument(content, masked, routeAttr, scope, constants);
              const template = expandRouteTokens(joinTemplate(classTemplate.value, own.value), controllerName, action);
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
                    ...unresolvedField(classTemplate, own),
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
                  template: expandRouteTokens(joinTemplate(classTemplate.value, ''), controllerName, action),
                  ...unresolvedField(classTemplate),
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
 * Every class-level `[Route(…)]` argument in this file, by class name, as `routeArgument`
 * gives it.
 *
 * Read through the same attribute reader as the controller-action pass, and shared by the
 * Razor Page and endpoint-class passes so all three agree on what a class-level route
 * override looks like.
 */
function classRouteTemplates(content, masked, starts, classFrames, constants) {
  const byClass = new Map();
  let pending = [];
  for (const entry of attributedLines(content, masked, starts)) {
    if (entry.attributes) {
      pending.push(...entry.attributes);
      continue;
    }
    const classMatch = entry.text.match(/\bclass\s+(\w+)\b/);
    if (classMatch) {
      const routeAttr = pending.find((a) => a.name === 'Route');
      if (routeAttr) {
        const frame = classFrames.find((candidate) => candidate.name === classMatch[1] && candidate.keywordIndex >= entry.index) ?? null;
        byClass.set(classMatch[1], routeArgument(content, masked, routeAttr, scopeOf(frame, classFrames, masked), constants));
      }
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
function extractRazorPageRoutes(relPath, absPath, content, masked, starts, classFrames, methodFrames, constants, facts) {
  if (!RAZOR_PAGE_CODE_BEHIND.test(relPath)) return;
  if (methodFrames.length === 0) return;
  const derived = razorPagePath(relPath);
  const directive = razorPageRouteTemplate(absPath);
  const classTemplates = classRouteTemplates(content, masked, starts, classFrames, constants);

  for (const frame of methodFrames) {
    const match = frame.name.match(RAZOR_PAGE_HANDLER);
    if (!match) continue;
    if (!content.startsWith('public', frame.headerIndex)) continue;
    const className = frame.classRef ? frame.classRef.name : basename(relPath).replace(/\.cshtml\.cs$/, '');
    const handler = match[2].replace(/Async$/, '');
    const override = classTemplates.get(className);
    const overrides = Boolean(override && (override.value || override.unresolved));
    const base = overrides
      ? composePageRoute(override.value.replace(/^\/+|\/+$/g, ''), '')
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
        ...(overrides ? unresolvedField(override) : {}),
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
 * Where the `ordinal`-th argument after the route template starts, counting commas the
 * nesting depth leaves at the top level so a verb array or a lambda parameter list never
 * counts as an argument boundary. An offset into `masked`, or null when there is no such
 * argument.
 */
function argumentOffsetAfterTemplate(masked, ordinal) {
  let depth = 0;
  let seen = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const ch = masked[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      seen += 1;
      if (seen === ordinal) return index + 1;
    }
  }
  return null;
}

/**
 * The extent of an inline lambda handler between `from` and `to`: `(params) => { body }`
 * or `(params) => expression`, with an optional `async`/`static` in front. A single
 * parameter written without parentheses declares no type, so it is not a handler the walk
 * could type and is left alone.
 */
function lambdaExtent(masked, from, to) {
  let i = skipWhitespace(masked, from);
  for (;;) {
    const modifier = masked.slice(i, i + 8).match(/^(?:async|static)\b/);
    if (!modifier) break;
    i = skipWhitespace(masked, i + modifier[0].length);
  }
  if (masked[i] !== '(') return null;
  const paramsOpen = i;
  const paramsClose = findMatchingParen(masked, paramsOpen);
  if (paramsClose === null || paramsClose >= to) return null;
  i = skipWhitespace(masked, paramsClose + 1);
  if (masked.slice(i, i + 2) !== '=>') return null;
  i = skipWhitespace(masked, i + 2);
  if (masked[i] === '{') {
    const bodyClose = findMatchingClose(masked, i, '{', '}');
    if (bodyClose === null || bodyClose > to) return null;
    return { paramsOpen, paramsClose, bodyStart: i + 1, bodyEnd: bodyClose };
  }
  return { paramsOpen, paramsClose, bodyStart: i, bodyEnd: to };
}

/**
 * The handler argument of a minimal-API registration -- the argument straight
 * after the template, except for `MapMethods`, whose verb list sits between the two.
 * A method group yields the referenced method name (`action`) and, when the group is
 * qualified by a type-like name, the class that declares it (`owner`); an inline lambda
 * yields its extent (`lambda`) so the registration can stand it up as the route's own
 * action.
 */
function minimalApiHandler(content, masked, openParenIndex, templateEndIndex, ordinal) {
  const none = (argsEnd) => ({ action: null, owner: null, lambda: null, argsEnd });
  const close = findMatchingParen(masked, openParenIndex);
  if (close === null) return none(templateEndIndex);
  const offset = argumentOffsetAfterTemplate(masked.slice(templateEndIndex, close), ordinal);
  if (offset === null) return none(close);
  const from = templateEndIndex + offset;
  const methodGroup = content.slice(from, close).match(METHOD_GROUP_ARGUMENT);
  if (methodGroup) {
    const qualifier = methodGroup[1].replace(/\s+/g, '').split('.').filter(Boolean);
    const last = qualifier.length > 0 ? qualifier[qualifier.length - 1] : null;
    return { action: methodGroup[2], owner: last && /^[A-Z]\w*$/.test(last) ? last : null, lambda: null, argsEnd: close };
  }
  return { action: null, owner: null, lambda: lambdaExtent(masked, from, close), argsEnd: close };
}

/**
 * One `route` fact per minimal-API `Map{Verb}` registration.
 *
 * The route is a fluent call on the endpoint-route builder rather than an attribute, so
 * nothing the controller-action pass reads applies. A `MapGroup` prefix -- bound to a
 * variable or chained inline -- composes into the emitted template rather than being lost,
 * and `MapMethods` contributes one fact per verb it lists. `controller` and `action` name
 * what the walk continues into. A method group names the method itself, and the class a
 * type-like qualifier names. An inline lambda is the route's own action: it is pushed onto
 * the file's method frames as `<registering method>(<VERBS> <template>)` under the enclosing
 * class, so the field, call, branch, span and parameter passes read its body and its
 * parameter list exactly as they read a method's, while the registering method reads its
 * own body with the lambda's extent blanked (`holes`). `handler` on the fact says which
 * shape the route took.
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
    const handler = minimalApiHandler(
      content,
      masked,
      openParenIndex,
      templateEndIndex,
      verbWord === 'Methods' ? 2 : 1,
    );
    const { argsEnd } = handler;
    const enclosingClass = findEnclosingClass(classFrames, matchIndex);
    const enclosingMethod = findEnclosingMethod(methodFrames, matchIndex);
    const fileClass = basename(relPath).replace(/\.cs$/, '');
    const controller = handler.owner ?? (enclosingClass ? enclosingClass.name : fileClass);
    let action = handler.action ?? (enclosingMethod ? enclosingMethod.name : `Map${verbWord}`);
    const verbs = [];
    if (verbWord === 'Methods') {
      const handlerOffset = argumentOffsetAfterTemplate(masked.slice(templateEndIndex, argsEnd), 2);
      const verbsEnd = handlerOffset === null ? argsEnd : templateEndIndex + handlerOffset;
      for (const quoted of content.slice(templateEndIndex, verbsEnd).matchAll(/"([A-Za-z]+)"/g)) {
        const upper = quoted[1].toUpperCase();
        if (HTTP_VERB_WORDS.has(upper) && !verbs.includes(upper)) verbs.push(upper);
      }
      if (verbs.length === 0) verbs.push('ANY');
    } else {
      verbs.push(verbWord.toUpperCase());
    }
    let handlerKind;
    if (handler.action) {
      handlerKind = 'method';
    } else if (handler.lambda) {
      handlerKind = 'lambda';
      action = `${action}(${verbs.join('|')} ${template})`;
      methodFrames.push({
        name: action,
        isCtor: false,
        paramsText: content.slice(handler.lambda.paramsOpen + 1, handler.lambda.paramsClose),
        typeParamsText: enclosingMethod ? enclosingMethod.typeParamsText : undefined,
        classRef: enclosingClass ?? { name: controller, keyword: 'class', trailer: '', startIndex: 0, endIndex: null, braceIndex: -1 },
        headerIndex: handler.lambda.paramsOpen,
        startIndex: handler.lambda.bodyStart,
        endIndex: handler.lambda.bodyEnd,
        lambda: true,
      });
      if (enclosingMethod) {
        enclosingMethod.holes = [...(enclosingMethod.holes || []), [handler.lambda.paramsOpen, handler.lambda.bodyEnd + 1]];
      }
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
          ...(handlerKind ? { handler: handlerKind } : {}),
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
 * The parameters of a minimal-API handler -- an inline lambda, or the method a method
 * group names -- that the framework resolves from the container rather than from the
 * request: every parameter that is neither a framework type nor bound from the route, the
 * query or the body. Each becomes a `ctor_field` scoped to that one action by `method`, and
 * every call through it in the handler body a `method_call` naming its type as
 * `receiverType`, so the walk and the surface resolve it the way they resolve a
 * constructor-injected field. Runs over every file, since a method group may name a
 * method declared in another one; a method group naming no method the scan set declares
 * loses its `handler` tag.
 */
function extractHandlerParameters(fileScans, facts) {
  const byClass = methodFramesByClass(fileScans);
  const targets = new Map();
  for (const item of facts) {
    if (item.type !== 'route' || !item.handler) continue;
    let resolved = false;
    for (const entry of byClass.get(item.controller) || []) {
      if (entry.frame.name !== item.action) continue;
      resolved = true;
      let target = targets.get(entry.frame);
      if (!target) {
        target = { entry, templateParams: new Set() };
        targets.set(entry.frame, target);
      }
      ROUTE_TEMPLATE_PARAM.lastIndex = 0;
      let match;
      while ((match = ROUTE_TEMPLATE_PARAM.exec(item.template || ''))) {
        target.templateParams.add(match[1].toLowerCase());
      }
    }
    // A method group the scan set declares no method for (a field's instance method, a
    // class in another repository) is a route whose handler nothing here can walk into;
    // the tag would promise a resolution that never happens.
    if (!resolved && item.handler === 'method') delete item.handler;
  }
  for (const { entry, templateParams } of targets.values()) {
    const { scan, frame } = entry;
    const params = parseParamsWithAttributes(rawParamsAt(scan.masked, frame.headerIndex));
    const body = frameBody(scan.masked, frame);
    const line = lineAt(scan.content, frame.headerIndex);
    for (const param of params) {
      const type = param.type.replace(/\b(?:ref|out|in|params|this)\b/g, '').trim();
      if (FRAMEWORK_PARAM_TYPE.test(type)) continue;
      if (actionParamSource(param, templateParams).source !== 'di') continue;
      facts.push(
        fact('ctor_field', {
          file: scan.relPath,
          line,
          class: frame.classRef.name,
          method: frame.name,
          field: param.name,
          paramType: type,
        }),
      );
      const callRe = new RegExp(`\\b${escapeRegExp(param.name)}\\s*\\.\\s*(\\w+)\\s*(?:<\\s*[^<>]*\\s*>)?\\s*\\(`, 'g');
      let call;
      while ((call = callRe.exec(body))) {
        if (call[1] === 'Result' || call[1] === 'Value') continue;
        const at = frame.startIndex + call.index;
        facts.push(
          fact('method_call', {
            file: scan.relPath,
            line: lineAt(scan.content, at),
            class: frame.classRef.name,
            method: frame.name,
            field: param.name,
            calledMethod: call[1],
            ...scan.control(frame, at),
            receiverType: type,
          }),
        );
      }
    }
  }
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
    const maskedLine = masked.slice(previousStart, previousEnd);
    // Read off the masked text, so a trailing comment after the last `]` ends no block.
    if (depth === 0 && !maskedLine.trim().endsWith(']')) break;
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
function extractEndpointClassRoutes(relPath, content, masked, starts, classFrames, methodFrames, constants, facts) {
  const endpointClasses = classFrames.filter(
    (frame) => frame.keyword === 'class' && ENDPOINT_BASE_SHAPE.test(frame.trailer ?? ''),
  );
  if (endpointClasses.length === 0) return;
  const classTemplates = classRouteTemplates(content, masked, starts, classFrames, constants);
  const seen = new Set(
    facts.filter((f) => f.type === 'route' && f.file === relPath).map(routeSignature),
  );

  for (const frame of endpointClasses) {
    const classTemplate = classTemplates.get(frame.name) ?? { value: '' };
    const scope = scopeOf(frame, classFrames, masked);
    for (const method of methodFrames) {
      if (method.classRef !== frame) continue;
      if (method.isCtor) continue;
      const blockStart = attributeBlockStart(content, masked, method.headerIndex);
      if (blockStart >= method.headerIndex) continue;
      const attributes = [];
      for (let ln = lineFromStarts(starts, blockStart); ln <= starts.length && starts[ln - 1] < method.headerIndex; ln += 1) {
        const section = attributeLineAt(content, masked, starts[ln - 1]);
        if (!section) continue;
        for (const attribute of section.attributes) attributes.push({ ...attribute, line: lineFromStarts(starts, attribute.index) });
        ln = lineFromStarts(starts, section.end);
      }

      const bareVerbs = [];
      const emitted = [];
      for (const attribute of attributes) {
        const verbMatch = attribute.name.match(HTTP_VERB_ATTRIBUTE);
        if (!verbMatch) continue;
        const verb = verbMatch[1].toUpperCase();
        if (attribute.arg === undefined) {
          bareVerbs.push({ verb, line: attribute.line });
          continue;
        }
        const own = routeArgument(content, masked, attribute, scope, constants);
        emitted.push({ verb, template: joinTemplate(classTemplate.value, own.value), line: attribute.line, parts: [classTemplate, own] });
      }
      for (const attribute of attributes) {
        if (attribute.name !== 'Route') continue;
        const own = routeArgument(content, masked, attribute, scope, constants);
        const template = joinTemplate(classTemplate.value, own.value);
        const verbs = bareVerbs.length > 0 ? bareVerbs.map((b) => b.verb) : ['ANY'];
        for (const verb of verbs) emitted.push({ verb, template, line: attribute.line, parts: [classTemplate, own] });
        bareVerbs.length = 0;
      }
      for (const bare of bareVerbs) {
        emitted.push({ verb: bare.verb, template: classTemplate.value, line: bare.line, parts: [classTemplate] });
      }

      for (const entry of emitted) {
        const candidate = fact('route', {
          file: relPath,
          line: entry.line,
          controller: frame.name,
          action: method.name,
          verb: entry.verb,
          template: expandRouteTokens(entry.template, frame.name, method.name),
          ...unresolvedField(...entry.parts),
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

const BUILTIN_TYPE_KEYWORDS = new Set([
  'string', 'object', 'int', 'long', 'bool', 'byte', 'char', 'decimal', 'double', 'float', 'short',
  'uint', 'ulong', 'ushort', 'sbyte', 'dynamic',
]);
const COLLECTION_TYPES = 'IEnumerable|IAsyncEnumerable|List|IList|ICollection|IReadOnlyCollection|IReadOnlyList|HashSet|ISet|Queue|Stack';

/** The last segment of a possibly qualified type name (`Messaging.Jobs.ReindexJob` -> `ReindexJob`). */
function lastSegment(typeName) {
  const dot = typeName.lastIndexOf('.');
  return dot === -1 ? typeName : typeName.slice(dot + 1);
}

/**
 * A declared type as a publish message: a plain (possibly qualified, possibly nullable)
 * identifier resolves to its last segment; a generic, array or tuple type names no single
 * message and is reported with `reason`. C# keywords other than the built-in value and
 * string types are not types at all and resolve to nothing.
 */
function typeAsMessage(typeText, reason) {
  const text = (typeText ?? '').replace(/^(?:ref|in|out|this|params)\s+/, '').replace(/\?$/, '').trim();
  if (text === '' || text === 'var') return null;
  if (CSHARP_KEYWORDS.has(text) && !BUILTIN_TYPE_KEYWORDS.has(text)) return null;
  if (/^[\w.]+$/.test(text)) return { type: lastSegment(text) };
  return { type: null, unresolved: reason };
}

/** The element type of a collection-typed declaration text (`List<T>`, `IEnumerable<T>`, `T[]`). */
function elementTypeOf(typeText) {
  const text = (typeText ?? '').trim();
  const generic = text.match(new RegExp(`^(?:[\\w.]+\\.)?(?:${COLLECTION_TYPES})\\s*<\\s*([\\w.]+)\\s*>$`));
  if (generic) return lastSegment(generic[1]);
  const array = text.match(/^([\w.]+)\s*\[\s*\]$/);
  if (array) return lastSegment(array[1]);
  return null;
}

/**
 * The element type of the collection a bare identifier names, from the nearest declaration
 * before `before` in the method body (`var xs = new List<T>()`, `List<T> xs = …`, `T[] xs`,
 * `foreach (var xs in …)` is not one) or from a parameter of the method; null when unknown.
 */
function collectionElementType(body, name, before, params) {
  const n = escapeRegExp(name);
  const declarations = [
    [new RegExp(`\\bvar\\s+${n}\\s*=\\s*(?:await\\s+)?new\\s+((?:[\\w.]+\\.)?(?:${COLLECTION_TYPES})\\s*<\\s*[\\w.]+\\s*>)`, 'g'), (m) => elementTypeOf(m[1])],
    [new RegExp(`\\bvar\\s+${n}\\s*=\\s*(?:await\\s+)?new\\s+([\\w.]+)\\s*\\[`, 'g'), (m) => lastSegment(m[1])],
    [new RegExp(`\\b((?:[\\w.]+\\.)?(?:${COLLECTION_TYPES})\\s*<\\s*[\\w.]+\\s*>|[\\w.]+\\s*\\[\\s*\\])\\s+${n}\\s*[=;)]`, 'g'), (m) => elementTypeOf(m[1])],
  ];
  let best = null;
  for (const [pattern, read] of declarations) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body))) {
      if (match.index >= before) break;
      const element = read(match);
      if (element && (!best || match.index > best.index)) best = { index: match.index, element };
    }
  }
  if (best) return best.element;
  const param = params.find((entry) => entry.name === name);
  return param ? elementTypeOf(param.type) : null;
}

/** Lambda parameter names and types out of a header: `x`, `(x)`, `(T x)`, `(a, b)`. */
function lambdaParams(headerText) {
  const text = headerText.trim();
  const inner = text.startsWith('(') ? text.slice(1, -1) : text;
  return splitTopLevel(inner, ',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const tokens = part.split(/\s+/);
      return tokens.length === 1 ? { name: tokens[0], type: null } : { name: tokens[tokens.length - 1], type: tokens.slice(0, -1).join(' ') };
    });
}

/** Index one past a non-block lambda body that starts at `from`: the enclosing argument's end. */
function lambdaExpressionEnd(body, from) {
  let depth = 0;
  for (let i = from; i < body.length; i += 1) {
    const c = body[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
  }
  return body.length;
}

/**
 * The lambda whose parameter `name` is in force at `at`, if the call sits inside one:
 * the nearest `name =>` / `(…name…) =>` header before `at` whose body contains `at`. Returns
 * the parameter's declared type when the header states one, otherwise the identifier the
 * lambda is a `Select`/`ForEach` argument of (`items.Select(x => …)`), or null for either.
 */
function enclosingLambdaParameter(body, name, at) {
  const n = escapeRegExp(name);
  const header = new RegExp(`(\\b${n}\\b|\\([^()]*\\b${n}\\b[^()]*\\))\\s*=>`, 'g');
  let found = null;
  let match;
  while ((match = header.exec(body))) {
    if (match.index >= at) break;
    const param = lambdaParams(match[1]).find((entry) => entry.name === name);
    if (!param) continue;
    const arrowEnd = match.index + match[0].length;
    const bodyStart = skipWhitespace(body, arrowEnd);
    const bodyEnd = body[bodyStart] === '{' ? findMatchingClose(body, bodyStart, '{', '}') : lambdaExpressionEnd(body, bodyStart);
    if (bodyEnd == null || at < bodyStart || at > bodyEnd) continue;
    found = { index: match.index, type: param.type };
  }
  if (!found) return null;
  let cursor = found.index - 1;
  while (cursor >= 0 && /\s/.test(body[cursor])) cursor -= 1;
  const receiver = body[cursor] === '('
    ? body.slice(0, cursor).match(/([A-Za-z_]\w*)\s*\.\s*(?:Select|ForEach)\s*$/)
    : null;
  return { index: found.index, type: found.type, receiver: receiver ? receiver[1] : null };
}

/**
 * The nearest declaration of `name` before `at` in a method body, read as a message type:
 * `var x = new T`, `x = new T`, `T x = …`, `T x;`, `T x = new(…)`, `foreach (T x in …)`,
 * `foreach (var x in xs)` through the collection's element type, `out T x`, `is T x`.
 * A `var` initialised from anything but `new` names no type and is reported as such.
 */
function nearestLocalDeclaration(body, name, at, params) {
  const n = escapeRegExp(name);
  const local = () => ({ type: null, unresolved: 'local-variable' });
  const typed = (text) => typeAsMessage(text, 'local-variable');
  const candidates = [
    [new RegExp(`(?<![\\w.])(?:var\\s+)?${n}\\s*=\\s*(?:await\\s+)?new\\s+([\\w.]+)\\b`, 'g'), (m) => typed(m[1])],
    [new RegExp(`\\bvar\\s+${n}\\s*=[^;]*?\\bas\\s+([\\w.]+)\\s*;`, 'g'), (m) => typed(m[1])],
    [new RegExp(`\\bvar\\s+${n}\\s*=(?!=)`, 'g'), () => local()],
    [new RegExp(`\\b([\\w.]+(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(?:\\s*\\[\\s*\\])?\\??)\\s+${n}\\s*(?:=(?!=)|;)`, 'g'), (m) => typed(m[1])],
    [new RegExp(`\\bforeach\\s*\\(\\s*(var|[\\w.]+(?:<[^<>]*>)?)\\s+${n}\\s+in\\s+([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g'), (m) => {
      if (m[1] !== 'var') return typed(m[1]);
      const source = m[2].trim();
      const element = /^[A-Za-z_]\w*$/.test(source) ? collectionElementType(body, source, m.index, params) : null;
      return element ? { type: element } : local();
    }],
    [new RegExp(`\\bout\\s+(var|[\\w.]+)\\s+${n}\\b`, 'g'), (m) => (m[1] === 'var' ? local() : typed(m[1]))],
    [new RegExp(`\\bis\\s+([\\w.]+)\\s+${n}\\b`, 'g'), (m) => typed(m[1])],
  ];
  let best = null;
  for (const [pattern, read] of candidates) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body))) {
      if (match.index >= at) break;
      const result = read(match);
      if (!result) continue;
      if (!best || match.index > best.index || (match.index === best.index && result.type && !best.result.type)) {
        best = { index: match.index, result };
      }
    }
  }
  return best ? best.result : null;
}

/** The method body (brace-bodied or expression-bodied) a call index sits in, with its parameters. */
function enclosingScope(masked, callIndex, methodFrames, expressionBodiedMethods) {
  const method = findEnclosingMethod(methodFrames, callIndex);
  if (method) {
    return { startIndex: method.startIndex, endIndex: method.endIndex, params: parseParams(method.paramsText) };
  }
  const expression = expressionBodiedMethods.find((entry) => callIndex >= entry.matchIndex && callIndex <= entry.semicolonIndex);
  if (expression) {
    return { startIndex: expression.matchIndex, endIndex: expression.semicolonIndex + 1, params: parseParams(expression.paramsText) };
  }
  return null;
}

/**
 * The message type a bare identifier passed to a publish call stands for, read from the
 * enclosing method: the parameter of a lambda the call sits inside (a typed one directly,
 * an untyped one through the collection a `Select`/`ForEach` iterates), else the nearest
 * preceding local, `foreach`, `out` or `is` declaration, else the method's own parameter.
 * Returns `{ type }`, or `{ type: null, unresolved }` naming why the type could not be read:
 * `lambda-parameter`, `local-variable`, `parameter-type` or `unknown-identifier`. Reported
 * rather than guessed, so a publish site never disappears for want of a type.
 */
function resolveArgumentType(masked, name, callIndex, methodFrames, expressionBodiedMethods) {
  const scope = enclosingScope(masked, callIndex, methodFrames, expressionBodiedMethods);
  if (!scope) return { type: null, unresolved: 'unknown-identifier' };
  const body = masked.slice(scope.startIndex, scope.endIndex);
  const at = callIndex - scope.startIndex;
  const lambda = enclosingLambdaParameter(body, name, at);
  if (lambda) {
    if (lambda.type) return typeAsMessage(lambda.type, 'parameter-type') ?? { type: null, unresolved: 'parameter-type' };
    const element = lambda.receiver ? collectionElementType(body, lambda.receiver, lambda.index, scope.params) : null;
    return element ? { type: element } : { type: null, unresolved: 'lambda-parameter' };
  }
  const local = nearestLocalDeclaration(body, name, at, scope.params);
  if (local) return local;
  const param = scope.params.find((entry) => entry.name === name);
  if (param) return typeAsMessage(param.type, 'parameter-type') ?? { type: null, unresolved: 'parameter-type' };
  return { type: null, unresolved: 'unknown-identifier' };
}

/**
 * One `publish` per position-1 publish-verb call: the message is the generic argument
 * (`Publish<T>(…)`), the inline `new T`, the saga initialiser (`PublishAsync(ctx =>
 * ctx.Init<T>(…))`), or the type of a bare identifier argument resolved by
 * `resolveArgumentType`. A site whose identifier's type cannot be read still emits, with
 * `message: null` and `unresolved` naming why. A generic type parameter (`TMessage`) is
 * never a message, however the call spells it. Every fact also carries `verb`, the verb
 * text `publishCall` matched (never the `Async` suffix), lower-cased. Verbs configured at a
 * later argument position (`Verb/N`, `N` > 1) never reach this pass at all -- `publish` in
 * `compileWorkerPatterns` excludes them -- and are read by `extractPositionalPublish` below.
 */
function extractPublish(relPath, content, masked, facts, messageIndex, classFrames, methodFrames, expressionBodiedMethods, patterns) {
  patterns.publishCall.lastIndex = 0;
  let match;
  while ((match = patterns.publishCall.exec(masked))) {
    const groups = match.groups;
    const verb = (groups.verbGeneric ?? groups.verbNew ?? groups.verbSaga ?? groups.verbIdent).toLowerCase();
    let message = groups.msgGeneric || groups.msgNew || groups.msgSaga || null;
    let unresolved = null;
    if (!message) {
      const identifier = groups.msgIdent;
      if (!identifier || CSHARP_KEYWORDS.has(identifier)) continue;
      const resolved = resolveArgumentType(masked, identifier, match.index, methodFrames, expressionBodiedMethods);
      message = resolved.type;
      unresolved = resolved.unresolved ?? null;
    }
    if (message && isGenericTypeParamMessage(message, classFrames, methodFrames, match.index)) continue;
    if (
      groups.msgGeneric &&
      GENERIC_TYPE_PARAM_NAME.test(message) &&
      looksLikeGenericDeclarationEcho(masked, match.index + match[0].length, message)
    ) {
      continue;
    }
    const fields = { file: relPath, line: lineAt(content, match.index), message, verb };
    if (unresolved) fields.unresolved = unresolved;
    const fqn = message ? messageIndex.get(message) : undefined;
    if (fqn) fields.fqn = fqn;
    facts.push(fact('publish', fields));
  }
}

/**
 * One `publish` per call to a verb `workerPatterns.publishCalls` configured at an argument
 * position other than 1 (`Defer/2`). The call's arguments are split at their top-level
 * commas (`splitCallArguments`, brace-aware since an argument is commonly an object
 * initializer); an index the call has too few arguments to reach emits nothing, exactly as
 * `resolveArgumentType` never guesses. The message at the configured position is read by the
 * same two rules a position-1 bare identifier already resolves through -- an inline `new T`,
 * or `resolveArgumentType`'s typed-local/parameter/lambda-parameter chase for a bare
 * identifier -- since the argument's shape does not depend on where in the call it sits. An
 * argument that is neither shape emits nothing, the same silence a position-1 call whose
 * first argument matches none of `publishCall`'s four spellings already has.
 */
function extractPositionalPublish(relPath, content, masked, facts, messageIndex, classFrames, methodFrames, expressionBodiedMethods, patterns) {
  if (!patterns.publishCallPositional) return;
  patterns.publishCallPositional.lastIndex = 0;
  let match;
  while ((match = patterns.publishCallPositional.exec(masked))) {
    const slot = patterns.positionalPublishCalls.findIndex((_, i) => match.groups[`p${i}`] !== undefined);
    if (slot === -1) continue;
    const verb = match.groups[`p${slot}`].toLowerCase();
    const { index } = patterns.positionalPublishCalls[slot];
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findMatchingParen(masked, openParenIndex);
    if (closeParenIndex == null) continue;
    const args = splitCallArguments(masked.slice(openParenIndex + 1, closeParenIndex));
    if (args.length < index) continue;
    const argText = args[index - 1].trim();
    const newMatch = argText.match(/^(?:await\s+)?new\s+(\w+)\b/);
    let message;
    let unresolved = null;
    if (newMatch) {
      message = newMatch[1];
    } else {
      const identMatch = argText.match(/^(?:await\s+)?([A-Za-z_]\w*)$/);
      if (!identMatch || CSHARP_KEYWORDS.has(identMatch[1])) continue;
      const resolved = resolveArgumentType(masked, identMatch[1], match.index, methodFrames, expressionBodiedMethods);
      message = resolved.type;
      unresolved = resolved.unresolved ?? null;
    }
    if (message && isGenericTypeParamMessage(message, classFrames, methodFrames, match.index)) continue;
    const fields = { file: relPath, line: lineAt(content, match.index), message, verb };
    if (unresolved) fields.unresolved = unresolved;
    const fqn = message ? messageIndex.get(message) : undefined;
    if (fqn) fields.fqn = fqn;
    facts.push(fact('publish', fields));
  }
}

/**
 * One `consume` per base-list entry that names a consumer base -- `IConsumer<M>`,
 * `BaseConsumer<Batch<M>>`, a `workerPatterns.consumerBases` name -- read off the class frames
 * the brace scanner already parsed. A primary constructor between the class name and the base
 * list, attributes inside it, a generic class and a nested generic therefore all go through the
 * one header parser. An abstract class consumes nothing at runtime and is skipped; a class
 * implementing several consumer interfaces consumes each message. `line` is the `class`
 * keyword's own line; `fqn` is added afterwards by `backfillMessageFqn`.
 */
function extractConsume(relPath, content, classFrames, facts, patterns) {
  for (const classEntry of classFrames) {
    if (classEntry.keyword !== 'class' || classEntry.isAbstract) continue;
    for (const entry of baseListEntries(classEntry.trailer)) {
      const match = entry.match(patterns.consumerBaseEntry);
      if (!match) continue;
      const message = match[1] || match[2];
      if (!message) continue;
      facts.push(
        fact('consume', {
          file: relPath,
          line: lineAt(content, classEntry.keywordIndex),
          message,
          consumer: classEntry.name,
        }),
      );
    }
  }
}

/**
 * One `saga` per class implementing a saga interface (`workerPatterns.sagaInterfaces`,
 * default `IAmInitiatedBy`): `initiatedBy` lists the message type argument of every
 * saga-interface base-list entry, `handles` lists the message type argument of every
 * consumer-base entry the same class declares -- the identical entries `extractConsume`
 * reads, so a `consume` fact for a message the saga also handles is entirely unaffected;
 * this pass never touches `extractConsume` or emits `consume` itself, so a reader ignoring
 * `saga` sees the walk unchanged. `correlation` is the property a `ConfigureHowToFindSaga` or
 * `CorrelateBy` lambda names, read over the class body, or `null` when the class states none.
 * `line` is the `class` keyword's own line, matching `extractConsume`'s convention. A class
 * with a saga interface but no consumer base still emits `saga`, with `handles: []` -- the
 * class is stated, not silently dropped for lacking one.
 */
function extractSaga(relPath, content, masked, classFrames, facts, patterns) {
  for (const classEntry of classFrames) {
    if (classEntry.keyword !== 'class' || classEntry.isAbstract || classEntry.endIndex == null) continue;
    const initiatedBy = [];
    const handles = [];
    for (const entry of baseListEntries(classEntry.trailer)) {
      const sagaMatch = entry.match(patterns.sagaInterfaceEntry);
      if (sagaMatch) {
        initiatedBy.push(sagaMatch[1]);
        continue;
      }
      const consumeMatch = entry.match(patterns.consumerBaseEntry);
      if (consumeMatch) handles.push(consumeMatch[1] || consumeMatch[2]);
    }
    if (initiatedBy.length === 0) continue;
    const body = masked.slice(classEntry.startIndex, classEntry.endIndex);
    const correlationMatch = body.match(CORRELATION_CALL);
    facts.push(
      fact('saga', {
        file: relPath,
        line: lineAt(content, classEntry.keywordIndex),
        saga: classEntry.name,
        initiatedBy,
        handles,
        correlation: correlationMatch ? correlationMatch[1] : null,
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
 * Any class/record under a message-contract folder (`patterns.messageFilePath`), whose name
 * ends in a message-contract suffix (`patterns.messageNameSuffix`), or that implements a known
 * message-marker interface, is a `message_class`. Struct and interface declarations never
 * qualify.
 */
function isMessageClass(relPath, classEntry, patterns) {
  if (classEntry.keyword !== 'class' && classEntry.keyword !== 'record') return false;
  if (patterns.messageFilePath.test(relPath)) return true;
  if (patterns.messageNameSuffix.test(classEntry.name)) return true;
  return MESSAGE_MARKER_INTERFACE.test(classEntry.trailer ?? '');
}

/**
 * One `message_class` per qualifying declaration: framed classes and records at their opening
 * brace, plus the brace-less positional records (`POSITIONAL_RECORD`) at their `record` keyword.
 */
function extractMessageClasses(relPath, content, masked, classFrames, facts, patterns) {
  const nsMatch = masked.match(NAMESPACE_DECLARATION);
  const namespace = nsMatch ? nsMatch[1] : null;
  const emit = (name, index) => {
    facts.push(
      fact('message_class', {
        file: relPath,
        line: lineAt(content, index),
        name,
        fqn: namespace ? `${namespace}.${name}` : name,
      }),
    );
  };
  for (const classEntry of classFrames) {
    if (!isMessageClass(relPath, classEntry, patterns)) continue;
    emit(classEntry.name, classEntry.braceIndex);
  }
  if (!/\brecord\b/.test(masked)) return;
  const stripped = stripAttributes(masked);
  POSITIONAL_RECORD.lastIndex = 0;
  let match;
  while ((match = POSITIONAL_RECORD.exec(stripped))) {
    const entry = { keyword: 'record', name: match[1], trailer: match[2] ?? '' };
    if (!isMessageClass(relPath, entry, patterns)) continue;
    emit(entry.name, match.index);
  }
}

/**
 * The queue-prefix constant (named by `workerPatterns.queuePrefixConstants`) holds the
 * literal prefix a worker-queue framework's topology binding combines with the message
 * type name and environment to build a queue/exchange name. Resolved once, repo-wide,
 * since the constant can live in any file the walk visits. Reads the raw text: the
 * prefix is the string literal itself, which masking blanks.
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

function extractDiBinding(relPath, content, masked, facts) {
  DI_BINDING.lastIndex = 0;
  let match;
  while ((match = DI_BINDING.exec(masked))) {
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

/** Every global filter registration across the whole repo, in source order, first occurrence kept. */
function buildRegisteredFilterIndex(files, maskedByPath) {
  const registered = new Map();
  for (const file of files) {
    const content = maskedByPath.get(file.absPath);
    FILTER_REGISTRATION_CALL.lastIndex = 0;
    let match;
    while ((match = FILTER_REGISTRATION_CALL.exec(content))) {
      const name = match[1] || match[2] || match[3];
      if (registered.has(name)) continue;
      registered.set(name, { file: file.relPath, line: lineAt(content, match.index) });
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

/** The status a result expression (`new ForbidResult()`, `BadRequest()`, …) answers, or null. */
function statusFromResultText(text) {
  for (const [re, pick] of RESULT_STATUS_CALLS) {
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
    const body = frameBody(masked, method);
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

function buildMessageIndex(files, maskedByPath, patterns) {
  const index = new Map();
  for (const file of files) {
    const relPath = file.relPath;
    if (!patterns.messageFilePath.test(relPath)) continue;
    const content = maskedByPath.get(file.absPath);
    const nsMatch = content.match(NAMESPACE_DECLARATION);
    if (!nsMatch) continue;
    const namespace = nsMatch[1];
    const classRe = /\b(?:class|record(?:\s+class|\s+struct)?)\s+(\w+)\b/g;
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
function buildProcessorMessageIndex(files, maskedByPath) {
  const index = new Map();
  for (const file of files) {
    const content = maskedByPath.get(file.absPath);
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
/** Any other interface is injected too: a request cannot bind to one. The collection and
 * form-file interfaces are the exceptions, since those the framework does bind. */
const INTERFACE_PARAM_TYPE = /^I[A-Z]\w*(?:<[^<>]*>)?$/;
const BOUND_INTERFACE_TYPE = /^I(?:Enumerable|AsyncEnumerable|List|Collection|ReadOnlyList|ReadOnlyCollection|Dictionary|ReadOnlyDictionary|Form(?:File|FileCollection|Collection))\b/;
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
  if (
    FRAMEWORK_PARAM_TYPE.test(type) ||
    INJECTED_PARAM_TYPE.test(type) ||
    (INTERFACE_PARAM_TYPE.test(type) && !BOUND_INTERFACE_TYPE.test(type))
  ) {
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
    const key = `${item.controller}|${item.action}`;
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
    const body = frameBody(scan.masked, frame);
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
    const bar = key.indexOf('|');
    const controller = key.slice(0, bar);
    const action = key.slice(bar + 1);
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
      const body = frameBody(scan.masked, method);
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
        const at = method.startIndex + match.index + match[0].search(/\w/);
        const line = lineAt(scan.content, at);
        facts.push(
          fact('method_call', {
            file: scan.relPath,
            line,
            class: method.classRef.name,
            method: method.name,
            field: receiver,
            calledMethod: binding.method,
            ...scan.control(method, at),
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

/** One-based line of `index` from precomputed line starts: a pass reporting many sites never rescans the file. */
function lineFromStarts(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** `Ns.FooAttribute` and `Foo` name one attribute, the way `[Foo]` and `[FooAttribute]` do in C#. */
function attributeName(name) {
  const bare = lastSegment(String(name || '').trim());
  return bare.length > 'Attribute'.length && bare.endsWith('Attribute') ? bare.slice(0, -'Attribute'.length) : bare;
}

function bareTypeName(entry) {
  const identifier = String(entry || '').trim().match(/^([\w.]+)/);
  return identifier ? lastSegment(identifier[1]) : '';
}

/**
 * The `if (…) <statement>` whose `if` keyword sits at `ifIndex`: its condition, the controlled
 * statement with its braces dropped, and where that statement starts and ends.
 */
function ifStatementAt(masked, ifIndex) {
  const open = masked.indexOf('(', ifIndex);
  if (open === -1) return null;
  const close = findMatchingParen(masked, open);
  if (close == null) return null;
  const bodyStart = skipWhitespace(masked, close + 1);
  if (masked[bodyStart] === '{') {
    const end = findMatchingClose(masked, bodyStart, '{', '}');
    if (end == null) return null;
    return { condition: masked.slice(open + 1, close).trim(), body: masked.slice(bodyStart + 1, end).trim(), bodyStart, end: end + 1 };
  }
  const end = findStatementEnd(masked, bodyStart);
  if (end == null) return null;
  return { condition: masked.slice(open + 1, close).trim(), body: masked.slice(bodyStart, end + 1).trim(), bodyStart, end: end + 1 };
}

/** The `else` (or `else if (…)`) statement right after `afterIndex`, as `{ start, end }`, or null. */
function elseSpanAt(masked, afterIndex) {
  const start = skipWhitespace(masked, afterIndex);
  if (masked.slice(start, start + 4) !== 'else' || /\w/.test(masked[start + 4] ?? '')) return null;
  let cursor = skipWhitespace(masked, start + 4);
  if (masked.slice(cursor, cursor + 2) === 'if' && !/\w/.test(masked[cursor + 2] ?? '')) {
    const open = skipWhitespace(masked, cursor + 2);
    if (masked[open] !== '(') return null;
    const close = findMatchingParen(masked, open);
    if (close == null) return null;
    cursor = close + 1;
  }
  const bodyStart = skipWhitespace(masked, cursor);
  const end = masked[bodyStart] === '{' ? findMatchingClose(masked, bodyStart, '{', '}') : findStatementEnd(masked, bodyStart);
  return end == null ? null : { start, end: end + 1 };
}

/** Every `if` statement between `from` and `to`, each with the `else` that follows it, if any. */
function ifStatementsIn(masked, from, to) {
  const statements = [];
  const re = /\bif\s*\(/g;
  re.lastIndex = from;
  let match;
  while ((match = re.exec(masked)) && match.index < to) {
    const statement = ifStatementAt(masked, match.index);
    if (!statement) continue;
    const elseSpan = elseSpanAt(masked, statement.end);
    statements.push({
      ...statement,
      index: match.index,
      elseStart: elseSpan ? elseSpan.start : null,
      elseEnd: elseSpan ? elseSpan.end : null,
    });
  }
  return statements;
}

/**
 * The single call an expression is: `[await] [this.]field.Method(…)` or `[await] Method(…)`,
 * with an optional `.ConfigureAwait(…)`. `field` is `this` for a call on the class itself. A
 * chain, an operator or anything after the closing parenthesis makes it no call.
 */
function callOfExpression(text) {
  const expression = String(text || '')
    .trim()
    .replace(/^await\s+/, '')
    .replace(/\.\s*ConfigureAwait\s*\(\s*(?:true|false)\s*\)\s*$/, '');
  const match = /^(?:this\s*\.\s*)?(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/.exec(expression);
  if (!match || CSHARP_KEYWORDS.has(match[2]) || (match[1] && CSHARP_KEYWORDS.has(match[1]) && match[1] !== 'base')) return null;
  const close = findMatchingParen(expression, match[0].length - 1);
  if (close !== expression.length - 1) return null;
  return { field: match[1] ?? 'this', calledMethod: match[2] };
}

/** The `var name = <expr>;` nearest before `before` in `body`, as `{ expr, end }`, or null. */
function localInitializer(body, name, before) {
  const re = new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=(?!=)\\s*`, 'g');
  let found = null;
  let match;
  while ((match = re.exec(body)) && match.index < before) {
    const end = findStatementEnd(body, match.index + match[0].length);
    if (end == null) continue;
    found = { expr: body.slice(match.index + match[0].length, end), end: end + 1 };
  }
  return found;
}

const JUMP_STATEMENT = /^(?:return\b[^;]*|break|throw\b[^;]*);$/;
const LAST_JUMP = /(?:^|[;}])\s*((?:return\b[^;]*|break|throw\b[^;]*);)$/;

/**
 * The `if` statement as a stop, with `body` its jump: a single jump, or a block whose last
 * statement is the jump and whose other statements hold no jump. A block stop also names the
 * lines of the statements before the jump, `rejectFrom` to `rejectTo`. Anything else is null.
 */
function stopStatement(masked, starts, statement) {
  if (JUMP_STATEMENT.test(statement.body)) return statement;
  if (masked[statement.bodyStart] !== '{') return null;
  const last = LAST_JUMP.exec(statement.body);
  if (!last) return null;
  const before = statement.body.slice(0, statement.body.length - last[1].length).trimEnd();
  if (before === '' || /\b(?:return|break|throw|continue|goto)\b/.test(before)) return null;
  const innerStart = skipWhitespace(masked, statement.bodyStart + 1);
  return {
    ...statement,
    body: last[1],
    rejectFrom: lineFromStarts(starts, innerStart),
    rejectTo: lineFromStarts(starts, innerStart + before.length - 1),
  };
}

/**
 * The test a pipeline loop makes of each step before it runs it: `if (!step.G(…)) continue;`,
 * or `if (step.G(…)) { … }` whose body holds another call on the step. `from` and `to` bound
 * the `if` head, so the step call is never read from the test itself.
 */
function stepGateIn(masked, loopStart, loopEnd, loopVar) {
  const name = escapeRegExp(loopVar);
  const negated = new RegExp(`^!\\s*(?:await\\s+)?${name}\\s*\\.\\s*(\\w+)\\s*\\(.*\\)$`);
  const positive = new RegExp(`^(?:await\\s+)?${name}\\s*\\.\\s*(\\w+)\\s*\\(.*\\)$`);
  for (const statement of ifStatementsIn(masked, loopStart, loopEnd)) {
    const condition = statement.condition.replace(/\s+/g, ' ');
    const test = negated.exec(condition);
    const held = positive.exec(condition);
    const runsInside = held && new RegExp(`\\b${name}\\s*\\.\\s*(?!${escapeRegExp(held[1])}\\b)\\w+\\s*\\(`).test(statement.body);
    if ((test && statement.body === 'continue;') || runsInside) {
      return { method: (test || held)[1], from: statement.index, to: statement.bodyStart };
    }
  }
  return null;
}

/**
 * The stop rule of each `foreach` over a collection field, read off the loop body:
 *
 * - `flag-return`: `if ([!]arg.Flag) return X;` before or after the step call, `X` named in
 *   `returns`;
 * - `flag-break`: `if (arg.Flag) break;`, the first allow ending the loop, with `after` naming
 *   the first statement past the loop that tests the flag;
 * - `bool-return`: `if (![await] step.M(arg)) return X;`, the step's own answer deciding;
 * - `none`: no statement in the loop ends it.
 *
 * Any other `return`, `break` or `throw` in the body, or a second stop statement, is a rule the
 * walk cannot read: `form: "unresolved"`, `reason: "stop-rule"`. `argType` is the declared type
 * of the step call's first argument, which picks a step's overload.
 */
function extractLoopStops(relPath, content, masked, starts, methodFrames, fieldsByClass, expressionBodiedMethods, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const fields = callableFields(method, fieldsByClass.get(method.classRef));
    if (!fields || fields.size === 0) continue;
    const body = frameBody(masked, method);
    FOREACH_HEADER.lastIndex = 0;
    let header;
    while ((header = FOREACH_HEADER.exec(body))) {
      const openParen = header.index + header[0].length - 1;
      const closeParen = findMatchingParen(body, openParen);
      if (closeParen == null) continue;
      const headerText = body.slice(openParen + 1, closeParen);
      const inMatch = headerText.match(/\bin\b/);
      if (!inMatch) continue;
      const collection = headerText.slice(inMatch.index + inMatch[0].length).trim().match(BARE_FIELD_REF);
      if (!collection || !fields.has(collection[1])) continue;
      const loopVar = headerText.slice(0, inMatch.index).trim().split(/\s+/).pop();
      if (!loopVar || !/^\w+$/.test(loopVar)) continue;
      const span = resolveControlledSpan(masked, content, method.startIndex + closeParen + 1);
      if (!span) continue;
      const loopStart = method.startIndex + skipWhitespace(body, closeParen + 1);
      const loopEnd = span.afterIndex;
      const loopText = masked.slice(loopStart, loopEnd);
      const gate = stepGateIn(masked, loopStart, loopEnd, loopVar);
      const callRe = new RegExp(`\\b${escapeRegExp(loopVar)}\\s*\\.\\s*(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(`, 'g');
      let call = callRe.exec(loopText);
      while (call && gate && loopStart + call.index >= gate.from && loopStart + call.index < gate.to) call = callRe.exec(loopText);
      if (!call) continue;
      const callOpen = loopStart + call.index + call[0].length - 1;
      const callClose = findMatchingParen(masked, callOpen);
      if (callClose == null) continue;
      const argText = (splitCallArguments(masked.slice(callOpen + 1, callClose))[0] || '').trim();
      const arg = /^[A-Za-z_]\w*$/.test(argText) ? argText : null;
      const argType = arg ? resolveArgumentType(masked, arg, callOpen, methodFrames, expressionBodiedMethods).type : null;
      const base = {
        file: relPath,
        line: lineFromStarts(starts, method.startIndex + header.index),
        endLine: lineFromStarts(starts, loopEnd - 1),
        class: method.classRef.name,
        method: method.name,
        field: collection[1],
        step: call[1],
        stepLine: lineFromStarts(starts, loopStart + call.index),
        ...(arg ? { arg } : {}),
        ...(argType ? { argType } : {}),
        ...(gate
          ? {
              gate: {
                method: gate.method,
                line: lineFromStarts(starts, gate.from),
                text: (content.slice(gate.from).split(/\r\n|\r|\n/)[0] ?? '').trim().slice(0, 120),
              },
            }
          : {}),
      };

      const stops = ifStatementsIn(masked, loopStart, loopEnd)
        .map((statement) => stopStatement(masked, starts, statement))
        .filter(Boolean);
      const jumps = [...loopText.matchAll(/\b(?:return|break|throw)\b/g)].map((jump) => loopStart + jump.index);
      const contained = jumps.every((at) => stops.some((stop) => at >= stop.bodyStart && at < stop.end));
      if (!contained || stops.length > 1) {
        facts.push(fact('loop_stop', { ...base, form: 'unresolved', reason: 'stop-rule' }));
        continue;
      }
      if (stops.length === 0) {
        facts.push(fact('loop_stop', { ...base, form: 'none' }));
        continue;
      }
      const [stop] = stops;
      if (stop.rejectFrom !== undefined) {
        base.rejectFrom = stop.rejectFrom;
        base.rejectTo = stop.rejectTo;
      }
      const condition = stop.condition.replace(/\s+/g, ' ');
      const returned = stop.body.startsWith('return') ? stop.body.replace(/^return\s*/, '').replace(/;$/, '').trim() : null;
      const flag = arg ? new RegExp(`^(!)?\\s*${escapeRegExp(arg)}\\s*\\.\\s*(\\w+)$`).exec(condition) : null;
      const stepTest = new RegExp(`^!\\s*(?:await\\s+)?${escapeRegExp(loopVar)}\\s*\\.\\s*${escapeRegExp(call[1])}\\s*\\(.*\\)$`).test(condition);
      const position = stop.index < loopStart + call.index ? 'before' : 'after';
      if (flag && returned !== null) {
        facts.push(
          fact('loop_stop', { ...base, form: 'flag-return', flag: flag[2], negated: flag[1] === '!', position, returns: returned }),
        );
      } else if (flag && stop.body === 'break;') {
        const rest = masked.slice(loopEnd, method.endIndex);
        const test = new RegExp(`\\b(?:if\\s*\\([^;{]*|return\\s+[^;]*)\\b${escapeRegExp(arg)}\\s*\\.\\s*${escapeRegExp(flag[2])}\\b`).exec(rest);
        facts.push(
          fact('loop_stop', {
            ...base,
            form: 'flag-break',
            flag: flag[2],
            negated: flag[1] === '!',
            ...(test ? { after: lineFromStarts(starts, loopEnd + test.index) } : {}),
          }),
        );
      } else if (stepTest && returned !== null) {
        facts.push(fact('loop_stop', { ...base, form: 'bool-return', returns: returned }));
      } else {
        facts.push(fact('loop_stop', { ...base, form: 'unresolved', reason: 'stop-rule' }));
      }
    }
  }
}

/**
 * `param.Flag = <value>;` in any method, for a `Flag` some loop's stop rule reads: the write a
 * step makes to stop the pipeline it runs in. `value` is `true`, `false` or `expression`.
 */
function extractFlagWrites(scans, facts) {
  const flags = new Set(facts.filter((entry) => entry.type === 'loop_stop' && entry.flag).map((entry) => entry.flag));
  if (flags.size === 0) return;
  const members = [...flags].map(escapeRegExp).join('|');
  for (const scan of scans) {
    const lines = scan.content.split(/\r\n|\r|\n/);
    for (const method of scan.methodFrames) {
      if (!method.classRef || method.endIndex == null) continue;
      const params = parseParams(method.paramsText).map((param) => escapeRegExp(param.name));
      if (params.length === 0) continue;
      const body = frameBody(scan.masked, method);
      const re = new RegExp(`(?<![\\w.])(${params.join('|')})\\s*\\.\\s*(${members})\\s*=(?!=)\\s*([^;]+);`, 'g');
      for (const write of body.matchAll(re)) {
        const value = write[3].trim();
        const line = lineFromStarts(scan.starts, method.startIndex + write.index);
        const call = value === 'true' || value === 'false' ? null : callOfExpression(value);
        facts.push(
          fact('flag_write', {
            file: scan.relPath,
            line,
            class: method.classRef.name,
            method: method.name,
            member: write[2],
            value: value === 'true' || value === 'false' ? value : 'expression',
            param: write[1],
            text: (lines[line - 1] ?? '').trim().slice(0, 120),
            ...(call ? { call: { ...(call.field ? { field: call.field } : {}), calledMethod: call.calledMethod } } : {}),
          }),
        );
      }
    }
  }
}

/**
 * Each `return false;` and `return null;` in a method body. One written inside an `if` (or its
 * `else`) carries `ifLine` and that line's `text`: the condition the sentinel answers.
 */
function extractSentinelReturns(relPath, content, masked, starts, methodFrames, facts) {
  const contentLines = content.split(/\r\n|\r|\n/);
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null) continue;
    const body = frameBody(masked, method);
    const returns = [...body.matchAll(/\breturn\s+(false|null)\s*;/g)];
    if (returns.length === 0) continue;
    const statements = ifStatementsIn(masked, method.startIndex, method.endIndex);
    for (const sentinel of returns) {
      const at = method.startIndex + sentinel.index;
      let owner = null;
      for (const statement of statements) {
        const inThen = at >= statement.bodyStart && at < statement.end;
        const inElse = statement.elseStart !== null && at >= statement.elseStart && at < statement.elseEnd;
        if (!inThen && !inElse) continue;
        const start = inThen ? statement.index : statement.elseStart;
        if (!owner || start > owner.start) owner = { start };
      }
      const line = lineFromStarts(starts, at);
      const ifLine = owner ? lineFromStarts(starts, owner.start) : null;
      facts.push(
        fact('sentinel_return', {
          file: relPath,
          line,
          class: method.classRef.name,
          method: method.name,
          value: sentinel[1],
          ...(ifLine !== null ? { ifLine, text: (contentLines[ifLine - 1] ?? '').trim().slice(0, 120) } : {}),
        }),
      );
    }
  }
}

/**
 * A method that returns a call's value unchanged: `return [await] _f.M(…);`, the same through
 * one `var r = … ; return r;` with no write to `r` between, or an expression body
 * `=> [await] _f.M(…);`. A sentinel the callee returns reaches this method's caller as it is.
 */
function extractReturnFlows(relPath, content, masked, starts, methodFrames, expressionBodiedMethods, facts) {
  const emit = (classRef, methodName, at, call) => {
    facts.push(
      fact('return_flow', {
        file: relPath,
        line: lineFromStarts(starts, at),
        class: classRef.name,
        method: methodName,
        field: call.field,
        calledMethod: call.calledMethod,
      }),
    );
  };
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null || method.isCtor) continue;
    const body = frameBody(masked, method);
    for (const ret of body.matchAll(/\breturn\s+/g)) {
      const from = ret.index + ret[0].length;
      const end = findStatementEnd(body, from);
      if (end == null) continue;
      const expression = body.slice(from, end).trim();
      let call = callOfExpression(expression);
      if (!call && /^[A-Za-z_]\w*$/.test(expression) && !CSHARP_KEYWORDS.has(expression)) {
        const local = localInitializer(body, expression, ret.index);
        const between = local ? body.slice(local.end, ret.index) : '';
        const written = new RegExp(`(?<![\\w.])${escapeRegExp(expression)}\\s*(?:[-+*/|&^?]?=(?!=)|\\+\\+|--)`).test(between);
        if (local && !written) call = callOfExpression(local.expr);
      }
      if (call) emit(method.classRef, method.name, method.startIndex + ret.index, call);
    }
  }
  for (const entry of expressionBodiedMethods) {
    const arrow = masked.indexOf('=>', entry.matchIndex);
    if (arrow === -1 || arrow > entry.semicolonIndex) continue;
    const call = callOfExpression(masked.slice(arrow + 2, entry.semicolonIndex));
    if (call) emit(entry.classEntry, entry.name, entry.matchIndex, call);
  }
}

/** The `?` and `:` of a top-level conditional expression, or null when the text is none. */
function conditionalParts(text) {
  let depth = 0;
  let question = -1;
  let nested = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === '?' && text[index + 1] !== '.' && text[index + 1] !== '?' && text[index - 1] !== '?') {
      if (question === -1) question = index;
      else nested += 1;
    } else if (depth === 0 && char === ':' && question !== -1) {
      if (nested > 0) nested -= 1;
      else return { condition: text.slice(0, question).trim(), whenTrue: text.slice(question + 1, index).trim(), whenFalse: text.slice(index + 1).trim() };
    }
  }
  return null;
}

/**
 * Which value of `local` a condition singles out, and on which side: `r is not null` /
 * `r != null` send `null` to the false side, `r is null` / `r == null` to the true side, `r`
 * sends `false` to the false side and `!r` to the true side.
 */
function sentinelTest(condition, local) {
  const name = escapeRegExp(local);
  const text = condition.replace(/\s+/g, ' ').trim();
  if (new RegExp(`^${name} (?:is not null|!= ?null)$|^${name}!= ?null$`).test(text)) return { sentinel: 'null', side: 'false' };
  if (new RegExp(`^${name} ?(?:is null|== ?null)$`).test(text)) return { sentinel: 'null', side: 'true' };
  if (new RegExp(`^${name}$`).test(text)) return { sentinel: 'false', side: 'false' };
  if (new RegExp(`^! ?${name}$`).test(text)) return { sentinel: 'false', side: 'true' };
  return null;
}

/**
 * The `return Y;` a sentinel falls through to when `statement` sends it to its false side:
 * the statement's body is one `return` and nothing else, it has no `else`, and the very next
 * statement is the return. Any other shape is no fallthrough the status rules may read.
 */
function fallthroughReturn(masked, statement) {
  if (statement.elseStart !== null) return null;
  const own = findStatementEnd(statement.body, 0);
  if (own == null || own !== statement.body.length - 1) return null;
  const next = skipWhitespace(masked, statement.end);
  if (!/^return\b/.test(masked.slice(next, next + 7))) return null;
  const stop = findStatementEnd(masked, next);
  if (stop == null) return null;
  return { index: next, arm: masked.slice(next + 'return'.length, stop).trim() };
}

/**
 * How a method answers a sentinel a call hands back: `var r = [await] _f.M(…);` and then
 * `return <test on r> ? A : B;`, `if (<test on r>) return X;`, or, when the test sends the
 * sentinel to its false side, the `return Y;` that follows such an `if`. `status` is what the
 * arm the sentinel takes answers, read by the result status rules; a test or an arm those
 * rules cannot read states nothing.
 */
function extractSentinelMaps(relPath, content, masked, starts, methodFrames, facts) {
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null || method.isCtor) continue;
    const body = frameBody(masked, method);
    for (const local of body.matchAll(/\bvar\s+([A-Za-z_]\w*)\s*=(?!=)\s*/g)) {
      const end = findStatementEnd(body, local.index + local[0].length);
      if (end == null) continue;
      const call = callOfExpression(body.slice(local.index + local[0].length, end));
      if (!call) continue;
      const name = local[1];
      let mapped = null;
      for (const ret of body.slice(end).matchAll(/\breturn\s+/g)) {
        const from = end + ret.index + ret[0].length;
        const stop = findStatementEnd(body, from);
        if (stop == null) continue;
        const parts = conditionalParts(body.slice(from, stop));
        const test = parts ? sentinelTest(parts.condition, name) : null;
        if (test) {
          mapped = { at: end + ret.index, sentinel: test.sentinel, arm: test.side === 'true' ? parts.whenTrue : parts.whenFalse };
          break;
        }
      }
      for (const statement of ifStatementsIn(masked, method.startIndex + end, method.endIndex)) {
        const at = statement.index - method.startIndex;
        if (mapped && at > mapped.at) break;
        const test = sentinelTest(statement.condition, name);
        if (!test || !/^return\b/.test(statement.body)) continue;
        if (test.side === 'true') {
          mapped = { at, sentinel: test.sentinel, arm: statement.body.replace(/^return\s*/, '') };
          break;
        }
        const fallthrough = fallthroughReturn(masked, statement);
        if (!fallthrough) continue;
        mapped = { at: fallthrough.index - method.startIndex, sentinel: test.sentinel, arm: fallthrough.arm };
        break;
      }
      if (!mapped) continue;
      const status = statusFromResultText(mapped.arm);
      if (status === null) continue;
      facts.push(
        fact('sentinel_map', {
          file: relPath,
          line: lineFromStarts(starts, method.startIndex + mapped.at),
          class: method.classRef.name,
          method: method.name,
          field: call.field,
          calledMethod: call.calledMethod,
          sentinel: mapped.sentinel,
          status,
          local: name,
        }),
      );
    }
  }
}

/** The registration methods a pipeline class composes its steps through: `void M(T p) { _f.Add(p); }`. */
function buildRegistrationIndex(scans) {
  const index = new Map();
  for (const scan of scans) {
    for (const method of scan.methodFrames) {
      if (!method.classRef || method.endIndex == null || method.isCtor) continue;
      const params = parseParams(method.paramsText);
      if (params.length !== 1) continue;
      const body = frameBody(scan.masked, method);
      const added = new RegExp(`^\\s*(?:this\\s*\\.\\s*)?(_?\\w+)\\s*\\.\\s*Add\\s*\\(\\s*${escapeRegExp(params[0].name)}\\s*\\)\\s*;\\s*$`).exec(body);
      if (!added) continue;
      const key = method.classRef.name;
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(method.name, added[1]);
    }
  }
  return index;
}

/**
 * The step a registration call's argument names: `ctx.GetRequiredService<X>()`,
 * `ctx.GetService<X>()` on the factory's own parameter, or `new X(…)`. Anything else is no
 * type the walk can read.
 */
function stepTypeOf(argument, param) {
  const text = argument.trim();
  const resolved = new RegExp(`^${escapeRegExp(param)}\\s*\\.\\s*(?:GetRequiredService|GetService)\\s*<\\s*([\\w.]+)\\s*>\\s*\\(\\s*\\)$`).exec(text);
  if (resolved) return lastSegment(resolved[1]);
  const constructed = /^new\s+([\w.]+)\s*(?:\(|\{)/.exec(text);
  if (constructed && /[)}]$/.test(text)) return lastSegment(constructed[1]);
  return null;
}

/**
 * `step_composition` facts: the ordered steps of a pipeline's collection field, from the three
 * compositions the source states outright.
 *
 * - `factory`: a DI factory lambda that builds `var p = new P(…)`, calls P's registration
 *   methods on it and returns it. Each call's step, in source order.
 * - `typeof-list`: a literal list of `typeof(X)` only, which the constructor maps through the
 *   container (`GetRequiredService(t)`) into the field. The list's order.
 * - `enumerable`: an injected `IEnumerable<I>` the constructor assigns to the field, ordered by
 *   the `Add*<I, X>()` registrations, which must all sit in one method body.
 *
 * A composition the walk cannot read states `steps: null` and `reason`: `step-expression` (a
 * step argument or list entry of another shape), `registration-site` (the class adds steps
 * itself as well), `factory-count` (more than one factory builds the class),
 * `registration-order` (registrations in more than one method) or `no-registration`.
 */
function extractStepCompositions(scans, facts) {
  const registrations = buildRegistrationIndex(scans);
  const byField = new Map();
  const add = (entry) => {
    const key = `${entry.class}|${entry.field}`;
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key).push(entry);
  };

  const selfAdds = new Set();
  for (const scan of scans) {
    for (const method of scan.methodFrames) {
      const owned = method.classRef ? registrations.get(method.classRef.name) : null;
      if (!owned || owned.has(method.name)) continue;
      const body = frameBody(scan.masked, method);
      for (const [registration, field] of owned) {
        const re = new RegExp(`(?<![\\w.])(?:this\\s*\\.\\s*)?(?:${escapeRegExp(registration)}|${escapeRegExp(field)}\\s*\\.\\s*Add)\\s*\\(`);
        if (re.test(body)) selfAdds.add(`${method.classRef.name}|${field}`);
      }
    }
  }

  for (const scan of scans) {
    DI_FACTORY_CALL.lastIndex = 0;
    let match;
    while ((match = DI_FACTORY_CALL.exec(scan.masked))) {
      const param = match[2];
      const openParen = match.index + match[0].lastIndexOf('(');
      const closeParen = findMatchingParen(scan.masked, openParen);
      if (closeParen == null) continue;
      const lambda = scan.masked.slice(openParen + 1, closeParen).replace(new RegExp(`^\\s*${escapeRegExp(param)}\\s*=>\\s*`), '');
      const trimmed = lambda.trim();
      let className = null;
      let block = '';
      let local = null;
      if (trimmed.startsWith('{')) {
        const blockEnd = findMatchingClose(trimmed, 0, '{', '}');
        block = blockEnd == null ? trimmed.slice(1) : trimmed.slice(1, blockEnd);
        const returns = [...block.matchAll(/\breturn\s+(\w+)\s*;/g)];
        if (returns.length === 0) continue;
        local = returns[returns.length - 1][1];
        const built = new RegExp(`\\bvar\\s+${escapeRegExp(local)}\\s*=\\s*new\\s+([\\w.]+)\\s*[({]`).exec(block);
        if (!built) continue;
        className = lastSegment(built[1]);
      } else {
        const built = /^new\s+([\w.]+)\s*[({]/.exec(trimmed);
        if (!built) continue;
        className = lastSegment(built[1]);
      }
      const owned = registrations.get(className);
      if (!owned) continue;
      const blockOffset = scan.masked.indexOf(trimmed.slice(0, 1), openParen + 1);
      for (const [registration, field] of owned) {
        const steps = [];
        let reason = null;
        if (local) {
          const callRe = new RegExp(`(?<![\\w.])${escapeRegExp(local)}\\s*\\.\\s*${escapeRegExp(registration)}\\s*\\(`, 'g');
          let call;
          while ((call = callRe.exec(block))) {
            const open = call.index + call[0].length - 1;
            const close = findMatchingParen(block, open);
            if (close == null) break;
            const type = stepTypeOf(block.slice(open + 1, close), param);
            if (!type) {
              reason = 'step-expression';
              break;
            }
            steps.push({ type, file: scan.relPath, line: lineFromStarts(scan.starts, blockOffset + 1 + call.index) });
          }
        }
        add({
          class: className,
          field,
          source: 'factory',
          file: scan.relPath,
          line: lineFromStarts(scan.starts, match.index),
          steps: reason ? null : steps,
          reason,
        });
      }
    }
  }

  const registered = new Map();
  for (const scan of scans) {
    GENERIC_REGISTRATION_CALL.lastIndex = 0;
    let match;
    while ((match = GENERIC_REGISTRATION_CALL.exec(scan.masked))) {
      const open = match.index + match[0].length - 1;
      const close = findMatchingClose(scan.masked, open, '<', '>');
      if (close == null) continue;
      const parts = splitTopLevel(scan.masked.slice(open + 1, close), ',').map((part) => part.replace(/\s+/g, ''));
      if (parts.length !== 2 || !/^\s*\(\s*\)/.test(scan.masked.slice(close + 1, close + 8))) continue;
      const method = findEnclosingMethod(scan.methodFrames, match.index);
      const entry = {
        impl: lastSegment(parts[1].replace(/<.*$/, '')),
        file: scan.relPath,
        line: lineFromStarts(scan.starts, match.index),
        site: method ? `${scan.relPath}|${method.startIndex}` : `${scan.relPath}|file`,
      };
      if (!registered.has(parts[0])) registered.set(parts[0], []);
      registered.get(parts[0]).push(entry);
    }
  }

  for (const scan of scans) {
    for (const classEntry of scan.classFrames) {
      if (classEntry.endIndex == null) continue;
      const classBody = scan.masked.slice(classEntry.startIndex, classEntry.endIndex);
      TYPE_LIST_DECLARATION.lastIndex = 0;
      let list;
      while ((list = TYPE_LIST_DECLARATION.exec(classBody))) {
        const name = list[1];
        const assignment = new RegExp(`(?<![\\w.])(?:this\\s*\\.\\s*)?(_?\\w+)\\s*=(?!=)([^;]*\\b${escapeRegExp(name)}\\b[^;]*\\b(?:GetRequiredService|GetService)\\s*\\([^;]*);`).exec(classBody);
        if (!assignment || assignment[1] === name) continue;
        const entriesOffset = classEntry.startIndex + list.index + list[0].indexOf('{') + 1;
        const steps = [];
        let reason = null;
        let cursor = 0;
        for (const raw of splitTopLevel(list[2], ',')) {
          const entry = raw.trim();
          const at = list[2].indexOf(raw, cursor);
          cursor = at + raw.length;
          if (entry === '') continue;
          const typed = /^typeof\s*\(\s*([\w.]+)\s*\)$/.exec(entry);
          if (!typed) {
            reason = 'step-expression';
            break;
          }
          steps.push({ type: lastSegment(typed[1]), file: scan.relPath, line: lineFromStarts(scan.starts, entriesOffset + at + raw.indexOf(entry)) });
        }
        add({
          class: classEntry.name,
          field: assignment[1],
          source: 'typeof-list',
          file: scan.relPath,
          line: lineFromStarts(scan.starts, classEntry.startIndex + list.index),
          steps: reason ? null : steps,
          reason,
        });
      }
    }
    for (const ctor of scan.methodFrames) {
      if (!ctor.isCtor || !ctor.classRef || ctor.endIndex == null) continue;
      const body = frameBody(scan.masked, ctor);
      for (const raw of splitTopLevel(rawParamsAt(scan.masked, ctor.headerIndex) ?? ctor.paramsText ?? '', ',')) {
        const param = stripAttributes(raw).replace(/=.*$/, '').trim();
        const typed = /^(?:[\w.]+\.)?IEnumerable\s*<([\s\S]+)>\s+(\w+)$/.exec(param);
        if (!typed) continue;
        const element = typed[1].replace(/\s+/g, '');
        const assigned = new RegExp(`(?<![\\w.])(?:this\\s*\\.\\s*)?(_?\\w+)\\s*=(?!=)\\s*${escapeRegExp(typed[2])}\\s*(?:\\.\\s*To(?:List|Array)\\s*\\(\\s*\\))?\\s*;`).exec(body);
        if (!assigned) continue;
        const entries = registered.get(element) || [];
        const sites = new Set(entries.map((entry) => entry.site));
        const reason = entries.length === 0 ? 'no-registration' : sites.size > 1 ? 'registration-order' : null;
        add({
          class: ctor.classRef.name,
          field: assigned[1],
          source: 'enumerable',
          file: scan.relPath,
          line: lineFromStarts(scan.starts, ctor.headerIndex),
          steps: reason ? null : entries.map((entry) => ({ type: entry.impl, file: entry.file, line: entry.line })),
          reason,
        });
      }
    }
  }

  for (const [key, entries] of byField) {
    const [first] = entries;
    let { steps, reason } = first;
    if (entries.length > 1) {
      steps = null;
      reason = 'factory-count';
    } else if (selfAdds.has(key) && first.source === 'factory') {
      steps = null;
      reason = 'registration-site';
    }
    facts.push(
      fact('step_composition', {
        file: first.file,
        line: first.line,
        class: first.class,
        field: first.field,
        source: first.source,
        steps,
        ...(reason ? { reason } : {}),
      }),
    );
  }
}

/** `[A]`, `[B(…), C]` written directly above the member at `index`, by attribute name. */
function attributesAbove(content, masked, index) {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const start = attributeBlockStart(content, masked, index);
  const names = [];
  for (const group of masked.slice(start, lineStart).matchAll(/\[([^[\]]*)\]/g)) {
    for (const part of splitTopLevel(group[1], ',')) {
      const name = part.trim().match(/^([A-Za-z_][\w.]*)/);
      if (name) names.push(attributeName(name[1]));
    }
  }
  return names;
}

/** The `typeof(X)` names an exemption test reads, when it reads the action's filter descriptors. */
function exemptionNames(text) {
  if (!/\bFilterDescriptors\b/.test(text)) return [];
  return [...text.matchAll(/\btypeof\s*\(\s*([\w.]+)\s*\)/g)].map((match) => attributeName(match[1]));
}

/**
 * The framework filters a request meets before its action, as facts:
 *
 * - `auth_filter`: a class implementing an authorization filter interface (`stage:
 *   "authorization"`) or an action filter interface or base (`stage: "action"`), one fact per
 *   entry method. `exemptions` are the attributes an early `return;` skips the filter for:
 *   its condition, or one local that condition reads, names `typeof(X)` in the action's filter
 *   descriptors. `order` is a literal `Order` the class states.
 * - `filter_result`: each `context.Result = <expr>;` in an entry method whose status the result
 *   rules read.
 * - `filter_use`: a filter registered globally (`scope: "global"`, `position` its registration
 *   order), or an attribute naming a filter or an exemption on a controller (`scope:
 *   "controller"`) or an action (`scope: "action"`).
 * - `class_base`: a class's base class, when the repository declares it.
 *
 * An exception filter never states either of the first two: its `OnException` is no entry.
 */
function extractFilterFacts(scans, registeredFilters, facts) {
  const declared = new Set();
  for (const scan of scans) {
    for (const classEntry of scan.classFrames) {
      if (classEntry.keyword === 'class') declared.add(classEntry.name);
    }
  }
  const filterNames = new Set();
  const interesting = new Set();
  for (const scan of scans) {
    for (const classEntry of scan.classFrames) {
      if (classEntry.keyword !== 'class' || classEntry.endIndex == null) continue;
      const bases = baseListEntries(classEntry.trailer).map(bareTypeName);
      const base = bases.find((name) => name && !/^I[A-Z]/.test(name));
      if (base && declared.has(base)) {
        facts.push(
          fact('class_base', { file: scan.relPath, line: lineFromStarts(scan.starts, classEntry.braceIndex), class: classEntry.name, base }),
        );
      }
      const stage = bases.some((name) => AUTHORIZATION_FILTER_BASES.has(name))
        ? 'authorization'
        : bases.some((name) => ACTION_FILTER_BASES.has(name))
          ? 'action'
          : null;
      if (!stage) continue;
      const entries = scan.methodFrames.filter(
        (method) => method.classRef === classEntry && method.endIndex != null && FILTER_ENTRY_METHODS[stage].has(method.name),
      );
      if (entries.length === 0) continue;
      const classBody = scan.masked.slice(classEntry.startIndex, classEntry.endIndex);
      const order = /\bOrder\b\s*(?:=>|\{\s*get\s*;\s*(?:(?:private\s+)?set\s*;\s*)?\}\s*=|=(?!=))\s*(-?\d+)\s*;/.exec(classBody);
      const name = attributeName(classEntry.name);
      filterNames.add(name);
      interesting.add(name);
      for (const entry of entries) {
        const context = (parseParams(entry.paramsText)[0] || {}).name;
        if (!context) continue;
        const body = frameBody(scan.masked, entry);
        const exemptions = new Set();
        for (const statement of ifStatementsIn(scan.masked, entry.startIndex, entry.endIndex)) {
          if (statement.body !== 'return;') continue;
          const condition = statement.condition;
          let names = exemptionNames(condition);
          const bare = /^([A-Za-z_]\w*)$/.exec(condition.trim());
          if (names.length === 0 && bare) {
            const local = localInitializer(body, bare[1], statement.index - entry.startIndex);
            if (local) names = exemptionNames(local.expr);
          }
          for (const exempt of names) exemptions.add(exempt);
        }
        for (const exempt of exemptions) interesting.add(exempt);
        facts.push(
          fact('auth_filter', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, entry.headerIndex),
            class: classEntry.name,
            name,
            stage,
            method: entry.name,
            exemptions: [...exemptions].sort(),
            ...(order ? { order: Number(order[1]) } : {}),
          }),
        );
        const resultRe = new RegExp(`(?<![\\w.])${escapeRegExp(context)}\\s*\\.\\s*Result\\s*=(?!=)\\s*([^;]+);`, 'g');
        for (const result of body.matchAll(resultRe)) {
          const status = statusFromResultText(result[1]);
          if (status === null) continue;
          facts.push(
            fact('filter_result', {
              file: scan.relPath,
              line: lineFromStarts(scan.starts, entry.startIndex + result.index),
              class: classEntry.name,
              method: entry.name,
              status,
            }),
          );
        }
      }
    }
  }
  if (interesting.size === 0) return;

  let position = 0;
  for (const [registered, site] of registeredFilters) {
    const name = attributeName(registered);
    if (!filterNames.has(name)) continue;
    facts.push(fact('filter_use', { file: site.file, line: site.line, filter: name, scope: 'global', position }));
    position += 1;
  }
  for (const scan of scans) {
    for (const classEntry of scan.classFrames) {
      if (classEntry.keyword !== 'class' || classEntry.endIndex == null) continue;
      for (const name of attributesAbove(scan.content, scan.masked, classEntry.keywordIndex)) {
        if (!interesting.has(name)) continue;
        facts.push(
          fact('filter_use', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, classEntry.keywordIndex),
            filter: name,
            scope: 'controller',
            class: classEntry.name,
          }),
        );
      }
    }
    for (const method of scan.methodFrames) {
      if (!method.classRef || method.isCtor) continue;
      for (const name of attributesAbove(scan.content, scan.masked, method.headerIndex)) {
        if (!interesting.has(name)) continue;
        facts.push(
          fact('filter_use', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, method.headerIndex),
            filter: name,
            scope: 'action',
            class: method.classRef.name,
            method: method.name,
          }),
        );
      }
    }
  }
}

/**
 * Every class the repository declares, by name, with the bare names its header lists. The
 * first declaration of a name wins, as `class_base` reads it.
 */
function buildClassTable(scans) {
  const table = new Map();
  for (const scan of scans) {
    for (const frame of scan.classFrames) {
      if (frame.keyword !== 'class' || frame.endIndex == null || table.has(frame.name)) continue;
      table.set(frame.name, { frame, scan, bases: baseListEntries(frame.trailer).map(bareTypeName).filter(Boolean) });
    }
  }
  return table;
}

/**
 * The repository classes from `name` up its base-class line, most derived first, and every
 * bare base name on the way. Only a base the repository declares is followed: a framework
 * base ends the line, and its name is still collected.
 */
function baseChain(table, name) {
  const classes = [];
  const names = new Set();
  let current = table.get(name);
  while (current && !classes.includes(current)) {
    classes.push(current);
    for (const base of current.bases) names.add(base);
    const next = current.bases.find((base) => table.has(base));
    current = next ? table.get(next) : null;
  }
  return { classes, names };
}

/** The modifier words written in front of a declaration's name. */
function modifierWords(masked, headerIndex, name) {
  const header = masked.slice(headerIndex, masked.indexOf('(', headerIndex));
  const at = header.lastIndexOf(name);
  return new Set((at === -1 ? header : header.slice(0, at)).split(/[^\w]+/).filter(Boolean));
}

/** The methods one class declares itself, block-bodied and expression-bodied, in source order. */
function declaredMethods(entry) {
  const { scan, frame } = entry;
  const methods = [];
  for (const method of scan.methodFrames) {
    if (method.classRef !== frame || method.isCtor || method.lambda || method.endIndex == null) continue;
    methods.push({ name: method.name, headerIndex: method.headerIndex });
  }
  for (const method of scan.expressionBodiedMethods) {
    if (method.classEntry !== frame) continue;
    methods.push({ name: method.name, headerIndex: method.matchIndex });
  }
  return methods
    .sort((a, b) => a.headerIndex - b.headerIndex)
    .map((method) => ({ ...method, modifiers: modifierWords(scan.masked, method.headerIndex, method.name) }));
}

/**
 * The methods a class can be entered through, the most derived declaration of each name
 * kept: the class's own first, then each repository base class in turn.
 */
function inheritedMethods(chain) {
  const byName = new Map();
  for (const entry of chain.classes) {
    for (const method of declaredMethods(entry)) {
      if (!byName.has(method.name)) byName.set(method.name, { ...method, owner: entry });
    }
  }
  return [...byName.values()];
}

const HUB_BASE = 'Hub';
const HUB_CONNECTION_EVENTS = new Set(['OnConnectedAsync', 'OnDisconnectedAsync']);
const ACTOR_BASE = 'ReceiveActor';
const ACTOR_RECEIVE_CALL = /(?<![\w.])(Receive(?:Async)?)\s*<\s*([\w.]+)\s*>\s*\(/g;

function entryFact(kind, classEntry, method, extra = {}) {
  const owner = method.owner;
  return fact('entry', {
    file: owner.scan.relPath,
    line: lineFromStarts(owner.scan.starts, method.headerIndex),
    kind,
    class: classEntry.frame.name,
    method: method.name,
    ...(owner !== classEntry ? { declaringClass: owner.frame.name } : {}),
    ...extra,
  });
}

/**
 * `entry` facts: the hub methods, the actor handlers and the configured entry points of
 * every concrete class. A class reached as an entry is walked by `routes-of` the way a
 * route is, so a method only such a class calls still has an answer.
 */
function extractEntries(scans, classTable, actorHandlers, entryPoints, facts) {
  for (const classEntry of classTable.values()) {
    if (classEntry.frame.isAbstract) continue;
    const chain = baseChain(classTable, classEntry.frame.name);
    if (chain.names.has(HUB_BASE)) {
      for (const method of inheritedMethods(chain)) {
        if (method.modifiers.has('static')) continue;
        if (!method.modifiers.has('public') && !HUB_CONNECTION_EVENTS.has(method.name)) continue;
        facts.push(entryFact('hub', classEntry, method));
      }
    }
    if (chain.names.has(ACTOR_BASE)) {
      for (const handler of actorHandlers.filter((item) => item.classFrame === classEntry.frame)) {
        facts.push(
          fact('entry', {
            file: classEntry.scan.relPath,
            line: handler.line,
            kind: 'actor',
            class: classEntry.frame.name,
            method: handler.method,
            message: handler.message,
          }),
        );
      }
    }
    for (const point of entryPoints) {
      if (!point.bases.some((base) => chain.names.has(base))) continue;
      const methods = inheritedMethods(chain);
      for (const name of point.methods) {
        const method = methods.find((item) => item.name === name);
        if (method) facts.push(entryFact(point.kind, classEntry, method));
      }
    }
  }
}

/**
 * The delegate one call argument passes, the argument starting after `openParen`: a method
 * group (`Handle`, `this.Handle`), or a lambda with a bare (`ct =>`) or parenthesized
 * parameter list and a block or expression body. `argEnd` is where the argument ends.
 */
function delegateArgument(masked, openParen) {
  const close = findMatchingParen(masked, openParen);
  if (close === null) return null;
  let argEnd = close;
  let depth = 0;
  for (let i = openParen + 1; i < close; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      argEnd = i;
      break;
    }
  }
  const from = skipWhitespace(masked, openParen + 1);
  const group = /^(?:this\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(masked.slice(from, argEnd));
  if (group) return { kind: 'method-group', name: group[1], argEnd, close };
  let i = from;
  for (;;) {
    const modifier = masked.slice(i, i + 8).match(/^(?:async|static)\b/);
    if (!modifier) break;
    i = skipWhitespace(masked, i + modifier[0].length);
  }
  let paramsText;
  if (masked[i] === '(') {
    const paramsClose = findMatchingParen(masked, i);
    if (paramsClose === null || paramsClose >= argEnd) return null;
    paramsText = masked.slice(i + 1, paramsClose);
    i = paramsClose + 1;
  } else {
    const bare = /^[A-Za-z_]\w*/.exec(masked.slice(i, argEnd));
    if (!bare) return null;
    paramsText = bare[0];
    i += bare[0].length;
  }
  i = skipWhitespace(masked, i);
  if (masked.slice(i, i + 2) !== '=>') return null;
  i = skipWhitespace(masked, i + 2);
  if (masked[i] === '{') {
    const bodyClose = findMatchingClose(masked, i, '{', '}');
    if (bodyClose === null || bodyClose > argEnd) return null;
    return { kind: 'lambda', paramsOpen: from, paramsText, bodyStart: i + 1, bodyEnd: bodyClose, argEnd, close };
  }
  return { kind: 'lambda', paramsOpen: from, paramsText, bodyStart: i, bodyEnd: argEnd, argEnd, close };
}

/**
 * Stand a lambda delegate up as a method frame of its own, and blank its extent in the
 * method that writes it, so the calls in the lambda belong to the lambda and never to the
 * method that registers or queues it.
 */
function addDelegateFrame(scan, enclosing, name, delegate) {
  const frame = {
    name,
    isCtor: false,
    paramsText: delegate.paramsText,
    typeParamsText: enclosing.typeParamsText,
    classRef: enclosing.classRef,
    headerIndex: delegate.paramsOpen,
    startIndex: delegate.bodyStart,
    endIndex: delegate.bodyEnd,
    lambda: true,
  };
  scan.methodFrames.push(frame);
  enclosing.holes = [...(enclosing.holes || []), [delegate.paramsOpen, delegate.bodyEnd + 1]];
  return frame;
}

/** A frame name no other frame of the class uses: `base`, then `base#2`, `base#3`, … */
function uniqueFrameName(scan, classRef, base) {
  const taken = new Set(scan.methodFrames.filter((method) => method.classRef === classRef).map((method) => method.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/**
 * The `Receive<T>(…)` handlers of every actor class. A method-group handler names the
 * method; a lambda handler becomes a frame of its own named after the call, before any call
 * pass runs, so the calls in its body are the handler's.
 */
function readActorHandlers(scans, classTable) {
  const handlers = [];
  for (const classEntry of classTable.values()) {
    if (!baseChain(classTable, classEntry.frame.name).names.has(ACTOR_BASE)) continue;
    const { scan, frame } = classEntry;
    const owners = scan.methodFrames.filter((method) => method.classRef === frame && method.endIndex != null && !method.lambda);
    for (const owner of owners) {
      const body = frameBody(scan.masked, owner);
      ACTOR_RECEIVE_CALL.lastIndex = 0;
      let match;
      while ((match = ACTOR_RECEIVE_CALL.exec(body))) {
        const at = owner.startIndex + match.index;
        const openParen = owner.startIndex + match.index + match[0].length - 1;
        const delegate = delegateArgument(scan.masked, openParen);
        if (!delegate) continue;
        const message = lastSegment(match[2]);
        let method;
        if (delegate.kind === 'method-group') method = delegate.name;
        else method = addDelegateFrame(scan, owner, uniqueFrameName(scan, frame, `${match[1]}<${message}>`), delegate).name;
        handlers.push({ classFrame: frame, method, message, line: lineFromStarts(scan.starts, at) });
      }
    }
  }
  return handlers;
}

const QUEUE_DELEGATE_PARAMETER =
  /\b([A-Za-z_]\w*)\s*\(\s*Func\s*<\s*CancellationToken\s*,\s*(?:Value)?Task\s*>\s+[A-Za-z_]\w*\s*\)/g;
const RECEIVER_CALL = /(?<![\w.])((?:this\s*\.\s*)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;

/**
 * Every repository type that declares a method taking one cancellation-token delegate,
 * `Func<CancellationToken, Task>` or `Func<CancellationToken, ValueTask>`: the shape of a
 * background work queue, whatever the type is called.
 */
function buildQueueShapeIndex(scans) {
  const index = new Map();
  for (const scan of scans) {
    for (const match of scan.masked.matchAll(QUEUE_DELEGATE_PARAMETER)) {
      const owner = findEnclosingClass(scan.classFrames, match.index);
      if (!owner) continue;
      if (!index.has(owner.name)) index.set(owner.name, new Set());
      index.get(owner.name).add(match[1]);
    }
  }
  return index;
}

/**
 * The calls that hand a delegate to a background queue: by shape (the receiver field's
 * type declares the method with a cancellation-token delegate parameter) or by name
 * (`workerPatterns.backgroundCalls`). The whole call is blanked in the method that writes
 * it, so the queue method itself is never read as a call, and a lambda delegate becomes a
 * frame of its own. The facts wait on the scan until the file's facts are written.
 */
function readQueueCalls(scans, backgroundCalls) {
  const shapes = buildQueueShapeIndex(scans);
  const configured = new Set(backgroundCalls);
  if (shapes.size === 0 && configured.size === 0) return;
  for (const scan of scans) {
    scan.queueFacts = [];
    const ctorFacts = [];
    extractCtorFields(scan.relPath, scan.content, scan.masked, scan.classFrames, scan.methodFrames, ctorFacts);
    const fieldTypes = new Map(
      ctorFacts.filter((item) => item.method === undefined).map((item) => [`${item.class}|${item.field}`, bareTypeName(item.paramType)]),
    );
    const owners = scan.methodFrames.filter((method) => method.classRef && method.endIndex != null && !method.lambda);
    for (const owner of owners) {
      const declared = new Set(
        scan.methodFrames.filter((method) => method.classRef === owner.classRef && !method.lambda).map((method) => method.name),
      );
      for (const method of scan.expressionBodiedMethods) if (method.classEntry === owner.classRef) declared.add(method.name);
      const body = frameBody(scan.masked, owner);
      for (const call of body.matchAll(RECEIVER_CALL)) {
        const receiver = call[1].replace(/^this\s*\.\s*/, '');
        const calledMethod = call[2];
        const fieldType = fieldTypes.get(`${owner.classRef.name}|${receiver}`);
        const rule = fieldType && shapes.get(fieldType)?.has(calledMethod) ? 'shape' : configured.has(calledMethod) ? 'config' : null;
        if (!rule) continue;
        const start = owner.startIndex + call.index;
        const delegate = delegateArgument(scan.masked, start + call[0].length - 1);
        if (!delegate) continue;
        if (delegate.kind === 'method-group' && !declared.has(delegate.name)) continue;
        const line = lineFromStarts(scan.starts, start);
        const target =
          delegate.kind === 'method-group'
            ? delegate.name
            : addDelegateFrame(scan, owner, uniqueFrameName(scan, owner.classRef, `${calledMethod}(delegate)`), delegate).name;
        owner.holes = [...(owner.holes || []), [start, delegate.close + 1]];
        scan.queueFacts.push(
          fact('queue_call', {
            file: scan.relPath,
            line,
            class: owner.classRef.name,
            method: owner.name,
            receiver: fieldType || receiver,
            calledMethod,
            delegate: delegate.kind,
            target,
            rule,
          }),
        );
      }
    }
  }
}

const TO_DICTIONARY_ASSIGNMENT =
  /(?<![\w.])(?:this\s*\.\s*)?(_?[A-Za-z]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*ToDictionary\s*\(\s*(\w+)\s*=>\s*\3\s*\.\s*(\w+)\s*(?:,\s*(\w+)\s*=>\s*\5\s*)?\)\s*;/g;
const ENUMERABLE_PARAMETER = /^(?:System\.Collections\.Generic\.)?IEnumerable\s*<\s*([\w.]+)\s*>$/;
const KEYED_INDEXER_CALL = /(?<![\w.])(?:this\s*\.\s*)?(_?[A-Za-z]\w*)\s*\[\s*([^\[\];]+?)\s*\]\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
const KEYED_LOCAL = /(?<![\w.])(?:var|([A-Za-z_][\w.]*))\s+([A-Za-z_]\w*)\s*=\s*(?:this\s*\.\s*)?(_?[A-Za-z]\w*)\s*\[\s*([^\[\];]+?)\s*\]\s*;/g;
const KEYED_TRY_GET =
  /(?<![\w.])(?:this\s*\.\s*)?(_?[A-Za-z]\w*)\s*\.\s*TryGetValue\s*\(\s*([^,();]+?)\s*,\s*out\s+(?:var|([A-Za-z_][\w.]*))\s+([A-Za-z_]\w*)\s*\)/g;

/**
 * `keyed_collection` facts: a constructor that stores an injected `IEnumerable<I>` as a
 * dictionary keyed by one property of the element, the element itself the value.
 */
function readKeyedCollections(relPath, starts, masked, methodFrames, facts) {
  const keyed = new Map();
  for (const ctor of methodFrames) {
    if (!ctor.isCtor || !ctor.classRef || ctor.endIndex == null) continue;
    const params = new Map(parseParams(ctor.paramsText).map((param) => [param.name, param.type.replace(/\s+/g, '')]));
    const body = frameBody(masked, ctor);
    for (const match of body.matchAll(TO_DICTIONARY_ASSIGNMENT)) {
      const element = ENUMERABLE_PARAMETER.exec(params.get(match[2]) || '');
      if (!element) continue;
      const item = fact('keyed_collection', {
        file: relPath,
        line: lineFromStarts(starts, ctor.startIndex + match.index),
        class: ctor.classRef.name,
        field: match[1],
        iface: lastSegment(element[1]),
        key: match[4],
        param: match[2],
      });
      keyed.set(`${item.class}|${item.field}`, item);
      facts.push(item);
    }
  }
  return keyed;
}

/**
 * `keyed_call` facts: a call of an element method through a keyed collection, by an
 * indexer (`_f[k].M(…)`), through a local read from it (`var v = _f[k]; v.M(…)`) or
 * through `TryGetValue(k, out var v)` then `v.M(…)`.
 */
/** Members every object has: a call of one runs no implementation of the collection's interface. */
const OBJECT_MEMBERS = new Set(['GetType', 'ToString', 'Equals', 'GetHashCode']);

function readKeyedCalls(relPath, starts, masked, methodFrames, keyed, facts) {
  const calls = [];
  for (const method of methodFrames) {
    if (!method.classRef || method.endIndex == null || method.isCtor) continue;
    const body = frameBody(masked, method);
    const collection = (field) => keyed.get(`${method.classRef.name}|${field}`);
    const push = (field, calledMethod, key, form, at) => {
      if (OBJECT_MEMBERS.has(calledMethod)) return;
      const item = fact('keyed_call', {
        file: relPath,
        line: lineFromStarts(starts, method.startIndex + at),
        class: method.classRef.name,
        method: method.name,
        field,
        calledMethod,
        key: key.replace(/\s+/g, ''),
        form,
      });
      calls.push(item);
      facts.push(item);
    };
    for (const match of body.matchAll(KEYED_INDEXER_CALL)) {
      if (collection(match[1])) push(match[1], match[3], match[2], 'indexer', match.index);
    }
    const throughLocal = (re, form, pick) => {
      for (const match of body.matchAll(re)) {
        const { field, key, type, local } = pick(match);
        const entry = collection(field);
        if (!entry || (type && lastSegment(type) !== entry.iface)) continue;
        const after = body.slice(match.index + match[0].length);
        const offset = match.index + match[0].length;
        const callRe = new RegExp(`(?<![\\w.])${escapeRegExp(local)}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
        for (const call of after.matchAll(callRe)) push(field, call[1], key, form, offset + call.index);
      }
    };
    throughLocal(KEYED_LOCAL, 'local', (match) => ({ type: match[1], local: match[2], field: match[3], key: match[4] }));
    throughLocal(KEYED_TRY_GET, 'try-get', (match) => ({ field: match[1], key: match[2], type: match[3], local: match[4] }));
  }
  return calls;
}

/** The constant one key property returns, read off the raw text: `E.Member` or a literal. */
const KEY_VALUE = '([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)+|"[^"\\n]*"|\'[^\'\\n]*\'|-?\\d+(?:\\.\\d+)?|true|false)';

function keyPropertyValue(text, property) {
  const name = escapeRegExp(property);
  const forms = [
    new RegExp(`\\b${name}\\s*=>\\s*${KEY_VALUE}\\s*;`),
    new RegExp(`\\b${name}\\s*\\{\\s*get\\s*;\\s*\\}\\s*=\\s*${KEY_VALUE}\\s*;`),
    new RegExp(`\\b${name}\\s*\\{\\s*get\\s*\\{\\s*return\\s+${KEY_VALUE}\\s*;\\s*\\}\\s*\\}`),
    new RegExp(`\\b${name}\\s*\\{\\s*get\\s*=>\\s*${KEY_VALUE}\\s*;\\s*\\}`),
  ];
  for (const re of forms) {
    const match = re.exec(text);
    if (match) return { value: match[1], index: match.index };
  }
  return null;
}

/**
 * `key_property` facts: for each keyed collection, the key each implementation of its
 * element interface returns, read in the class itself or a repository base class. A class
 * whose key the reader cannot read gets no fact.
 */
function extractKeyProperties(classTable, facts) {
  const wanted = new Map();
  for (const item of facts) {
    if (item.type !== 'keyed_collection') continue;
    if (!wanted.has(item.iface)) wanted.set(item.iface, new Set());
    wanted.get(item.iface).add(item.key);
  }
  if (wanted.size === 0) return;
  for (const classEntry of classTable.values()) {
    const chain = baseChain(classTable, classEntry.frame.name);
    for (const [iface, keys] of wanted) {
      if (!chain.names.has(iface)) continue;
      for (const property of keys) {
        for (const owner of chain.classes) {
          const { scan, frame } = owner;
          const text = scan.content.slice(frame.startIndex, frame.endIndex);
          const found = keyPropertyValue(text, property);
          if (!found) continue;
          facts.push(
            fact('key_property', {
              file: scan.relPath,
              line: lineFromStarts(scan.starts, frame.startIndex + found.index),
              class: classEntry.frame.name,
              property,
              value: found.value,
            }),
          );
          break;
        }
      }
    }
  }
}

const GATEWAY_TABLE_KEY = 'UpstreamPathTemplate';
const DELEGATING_HANDLER = /\.\s*AddDelegatingHandler\s*<\s*([\w.]+)\s*>\s*\(\s*([^()]*?)\s*\)/g;
const USE_MIDDLEWARE = /\.\s*UseMiddleware\s*<\s*([\w.]+)\s*>\s*\(\s*\)/g;
const USE_GATEWAY = /\.\s*UseOcelot\s*\(/;

/**
 * JSON text with comments and trailing commas blanked, outside strings only, so a
 * hand-edited gateway table still reads. Each blanked character becomes a space and each
 * newline stays, so an offset into the result is an offset into the source.
 */
function tolerantJsonText(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      out += text.slice(start, index + 1);
      index += 1;
    } else if (char === '/' && text[index + 1] === '/') {
      const start = index;
      while (index < text.length && text[index] !== '\n') index += 1;
      out += ' '.repeat(index - start);
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      out += text[next] !== '}' && text[next] !== ']' ? char : ' ';
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
}

/**
 * `gateway_route` facts from each `.json` file that holds a gateway route table: one per
 * route and upstream verb, at the line of that route's upstream template. A file that holds
 * the key but does not parse gives one `gateway_table` fact and no route.
 */
function readGatewayTables(repoRoot, paths, facts) {
  for (const absPath of paths) {
    const content = readFileSync(absPath, 'utf8');
    if (!content.includes(GATEWAY_TABLE_KEY)) continue;
    const relPath = toRelativePath(repoRoot, absPath);
    const text = tolerantJsonText(content.replace(/^\uFEFF/, ' '));
    let table;
    try {
      table = JSON.parse(text);
    } catch (error) {
      facts.push(fact('gateway_table', { file: relPath, line: 1, state: 'unreadable', reason: error.message }));
      continue;
    }
    const routes = table && (Array.isArray(table.Routes) ? table.Routes : Array.isArray(table.ReRoutes) ? table.ReRoutes : null);
    if (!routes) continue;
    // Only property keys inside the route array count: comments are blank by now, and an
    // aggregate that names the same key can stand before the array.
    const arrayAt = new RegExp(`(?<!\\\\)"${Array.isArray(table.Routes) ? 'Routes' : 'ReRoutes'}"\\s*:\\s*\\[`).exec(text);
    const keyLines = [...text.slice(arrayAt?.index ?? 0).matchAll(new RegExp(`(?<!\\\\)"${GATEWAY_TABLE_KEY}"\\s*:`, 'g'))].map(
      (match) => lineAt(content, (arrayAt?.index ?? 0) + match.index),
    );
    let seen = 0;
    for (const route of routes) {
      const keyed = route && typeof route === 'object' && Object.hasOwn(route, GATEWAY_TABLE_KEY);
      const line = keyed ? (keyLines[seen] ?? 1) : 1;
      if (keyed) seen += 1;
      if (!route || typeof route.UpstreamPathTemplate !== 'string') continue;
      const hosts = (Array.isArray(route.DownstreamHostAndPorts) ? route.DownstreamHostAndPorts : [])
        .filter((entry) => entry && typeof entry.Host === 'string')
        .map((entry) => (entry.Port !== undefined ? `${entry.Host}:${entry.Port}` : entry.Host));
      for (const verb of stringList(route.UpstreamHttpMethod)) {
        facts.push(
          fact('gateway_route', {
            file: relPath,
            line,
            verb: verb.toUpperCase(),
            template: route.UpstreamPathTemplate,
            downstreamVerb: (typeof route.DownstreamHttpMethod === 'string' && route.DownstreamHttpMethod !== ''
              ? route.DownstreamHttpMethod
              : verb
            ).toUpperCase(),
            downstreamTemplate: typeof route.DownstreamPathTemplate === 'string' ? route.DownstreamPathTemplate : '',
            hosts,
            handlers: stringList(route.DelegatingHandlers),
          }),
        );
      }
    }
  }
}

/**
 * `gateway_handler` facts for each `AddDelegatingHandler<T>(…)` call, `global` its literal
 * argument; `gateway_middleware` facts for each `UseMiddleware<T>()` that runs before
 * `UseOcelot()` in the method that calls it, numbered in source order.
 */
function extractGatewayRegistrations(scans, facts) {
  for (const scan of scans) {
    for (const match of scan.masked.matchAll(DELEGATING_HANDLER)) {
      facts.push(
        fact('gateway_handler', {
          file: scan.relPath,
          line: lineFromStarts(scan.starts, match.index),
          handler: lastSegment(match[1]),
          global: match[2] === 'true',
        }),
      );
    }
    for (const method of scan.methodFrames) {
      if (method.endIndex == null || method.lambda) continue;
      const body = frameBody(scan.masked, method);
      const gateway = USE_GATEWAY.exec(body);
      if (!gateway) continue;
      let position = 0;
      for (const match of body.slice(0, gateway.index).matchAll(USE_MIDDLEWARE)) {
        position += 1;
        facts.push(
          fact('gateway_middleware', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, method.startIndex + match.index),
            middleware: lastSegment(match[1]),
            position,
          }),
        );
      }
    }
  }
}

const PROFILE_BASE = 'Profile';
const CREATE_MAP = /(?<![\w.])CreateMap\s*<\s*([\w.]+)\s*,\s*([\w.]+)\s*>\s*\(/g;
/** The members of one map statement that name a class the mapper runs: `[regex, role, method]`. */
const MAP_MEMBERS = [
  [/\bConvertUsing\s*<\s*([\w.]+)\s*(?:,[^<>]*)?>\s*\(/g, 'converter', 'Convert'],
  [/\bConvertUsing\s*\(\s*new\s+([\w.]+)\s*[({]/g, 'converter', 'Convert'],
  [/\bMapFrom\s*<\s*([\w.]+)\s*(?:,[^<>]*)?>\s*\(/g, 'resolver', 'Resolve'],
  [/\b(?:AfterMap|BeforeMap)\s*<\s*([\w.]+)\s*>\s*\(/g, 'action', 'Process'],
];
const MAPPER_INTERFACE = 'IMapper';
const MAPPER_CALL = /(?<![\w.])(?:this\s*\.\s*)?(_?[A-Za-z]\w*)\s*\.\s*Map\s*<\s*([\w.]+)\s*(?:,\s*([\w.]+)\s*)?>\s*\(/g;

/**
 * `mapper_map` facts: each converter, resolver or action class a `CreateMap<S, D>()`
 * statement of a `Profile` subclass names, read up to the statement's `;` so a member
 * converter inside `ForMember` belongs to the map it configures.
 */
function extractMapperMaps(classTable, facts) {
  for (const classEntry of classTable.values()) {
    if (!baseChain(classTable, classEntry.frame.name).names.has(PROFILE_BASE)) continue;
    const { scan, frame } = classEntry;
    const body = scan.masked.slice(frame.startIndex, frame.endIndex);
    for (const map of body.matchAll(CREATE_MAP)) {
      const from = frame.startIndex + map.index + map[0].length;
      const end = findStatementEnd(scan.masked, from) ?? frame.endIndex;
      const statement = scan.masked.slice(from, end);
      const found = [];
      for (const [re, role, method] of MAP_MEMBERS) {
        for (const member of statement.matchAll(re)) found.push({ at: from + member.index, target: lastSegment(member[1]), role, method });
      }
      for (const member of found.sort((a, b) => a.at - b.at)) {
        facts.push(
          fact('mapper_map', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, member.at),
            class: frame.name,
            source: lastSegment(map[1]),
            dest: lastSegment(map[2]),
            target: member.target,
            method: member.method,
            role: member.role,
          }),
        );
      }
    }
  }
}

/** `mapper_call` facts: `<field>.Map<D>(…)` and `<field>.Map<S, D>(…)` on an `IMapper` constructor field. */
function extractMapperCalls(scans, facts) {
  const mapperFields = new Set(
    facts
      .filter((item) => item.type === 'ctor_field' && item.method === undefined && bareTypeName(item.paramType) === MAPPER_INTERFACE)
      .map((item) => `${item.class}|${item.field}`),
  );
  if (mapperFields.size === 0) return;
  for (const scan of scans) {
    for (const method of scan.methodFrames) {
      if (!method.classRef || method.endIndex == null || method.isCtor) continue;
      const body = frameBody(scan.masked, method);
      for (const call of body.matchAll(MAPPER_CALL)) {
        if (!mapperFields.has(`${method.classRef.name}|${call[1]}`)) continue;
        facts.push(
          fact('mapper_call', {
            file: scan.relPath,
            line: lineFromStarts(scan.starts, method.startIndex + call.index),
            class: method.classRef.name,
            method: method.name,
            field: call[1],
            dest: lastSegment(call[3] ?? call[2]),
            ...(call[3] ? { source: lastSegment(call[2]) } : {}),
          }),
        );
      }
    }
  }
}

export async function extract(repoRoot, options = {}) {
  runLineStarts = new Map();
  try {
    return extractFacts(repoRoot, options);
  } finally {
    runLineStarts = null;
  }
}

function extractFacts(repoRoot, options = {}) {
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const patterns = compileWorkerPatterns(options.workerPatterns);
  const absolutePaths = walk(repoRoot, { extensions: ['.cs'], exclude });

  const files = absolutePaths.map((absPath) => ({
    absPath,
    relPath: toRelativePath(repoRoot, absPath),
  }));

  // Every pass that matches code structure reads the masked text, where comments and
  // string literals are blanked to spaces so a `// bus.Publish<T>(…)` remark or a literal
  // can never produce a fact; offsets and line numbers are unchanged, so `lineAt` runs on
  // either. The raw text stays for the passes that read a literal (route templates,
  // configuration keys, hub method names, queue prefixes) and for configured whole regexes,
  // which are free to capture from a string argument. Each pass says which at its call.
  const contents = new Map();
  const maskedByPath = new Map();
  for (const file of files) {
    const content = readFileSync(file.absPath, 'utf8');
    contents.set(file.absPath, content);
    maskedByPath.set(file.absPath, maskCsharp(content));
  }

  const messageIndex = buildMessageIndex(files, maskedByPath, patterns);
  const processorMessageIndex = buildProcessorMessageIndex(files, maskedByPath);
  const workerQueuePrefix = findWorkerQueuePrefix(files, contents, patterns); // literal prefix
  const registeredFilters = buildRegisteredFilterIndex(files, maskedByPath);

  const framesByPath = new Map();
  for (const file of files) {
    const masked = maskedByPath.get(file.absPath);
    framesByPath.set(file.absPath, { relPath: file.relPath, content: contents.get(file.absPath), masked, ...scanFrames(masked) });
  }
  const constants = buildConstantIndex([...framesByPath.values()]);
  const typeIndex = buildTypeIndex([...framesByPath.values()]);

  // Frames are read for every file before any fact is written: the entry and queue passes
  // need classes from other files, and a delegate they stand up as a frame of its own must
  // exist before the call passes attribute the calls inside it.
  const fileScans = files.map((file) => {
    const content = contents.get(file.absPath);
    const masked = maskedByPath.get(file.absPath);
    const { classFrames, methodFrames } = framesByPath.get(file.absPath);
    const expressionBodiedMethods = findExpressionBodiedMethods(masked, classFrames);
    const starts = lineStartsFor(content);
    // The control reader looks a frame up when a call asks, so the delegate frames the
    // queue pass adds below still get their control evidence.
    const control = buildFileControl(content, masked, starts, methodFrames);
    return { relPath: file.relPath, absPath: file.absPath, content, masked, methodFrames, classFrames, expressionBodiedMethods, starts, control };
  });
  const classTable = buildClassTable(fileScans);
  const actorHandlers = readActorHandlers(fileScans, classTable);
  readQueueCalls(fileScans, options.workerPatterns?.backgroundCalls ?? []);

  const facts = [];
  for (const scan of fileScans) {
    const file = scan;
    const { content, masked, classFrames, methodFrames, expressionBodiedMethods, starts, control } = scan;
    const methodNamesByClass = buildMethodNamesByClass(methodFrames, expressionBodiedMethods);

    // Attribute extents from the masked text, route arguments from the raw text.
    extractRoutes(file.relPath, content, masked, starts, classFrames, constants, facts);
    extractRazorPageRoutes(file.relPath, file.absPath, content, masked, starts, classFrames, methodFrames, constants, facts);
    extractMinimalApiRoutes(file.relPath, content, masked, classFrames, methodFrames, facts);
    extractEndpointClassRoutes(file.relPath, content, masked, starts, classFrames, methodFrames, constants, facts);
    // Raw text: configuration keys and interpolated URL templates.
    extractHttpOut(file.relPath, content, facts, patterns);
    // Masked text: the call-site pattern and the variable lookups; `content` for line numbers.
    extractPublish(file.relPath, content, masked, facts, messageIndex, classFrames, methodFrames, expressionBodiedMethods, patterns);
    extractPositionalPublish(file.relPath, content, masked, facts, messageIndex, classFrames, methodFrames, expressionBodiedMethods, patterns);
    // Masked text through the class frames; `content` for line numbers.
    extractConsume(file.relPath, content, classFrames, facts, patterns);
    extractSaga(file.relPath, content, masked, classFrames, facts, patterns);
    // Raw text: the configured whole regexes may capture a work type from a string argument.
    extractWorkerProcessors(file.relPath, content, facts, processorMessageIndex, workerQueuePrefix, patterns);
    extractQueueNamesFromTopologyBindings(file.relPath, content, facts, workerQueuePrefix, patterns);
    // Raw text: the hub method name and the exchange constant are string literals.
    extractSignalrPush(file.relPath, content, facts);
    extractExchangeName(file.relPath, content, facts);
    // Masked text: a registration names two types and no literal.
    extractDiBinding(file.relPath, content, masked, facts);
    extractDiFactoryBinding(file.relPath, content, masked, facts);
    extractGlobalExceptionFilters(file.relPath, content, masked, classFrames, registeredFilters, facts);
    extractActionExceptionCatches(file.relPath, content, masked, methodFrames, facts);

    extractMessageClasses(file.relPath, content, masked, classFrames, facts, patterns);
    extractIfaceImpl(file.relPath, content, classFrames, facts);
    const fieldsByClass = extractCtorFields(file.relPath, content, masked, classFrames, methodFrames, facts);
    if (scan.queueFacts) facts.push(...scan.queueFacts);
    // An expression body is a method body to the call passes only: no statement-level
    // decision can be written inside one.
    const callFrames = [...methodFrames, ...expressionFrames(expressionBodiedMethods, methodFrames)];
    extractMethodCalls(file.relPath, content, masked, callFrames, fieldsByClass, facts, control);
    extractServiceLocatorCalls(file.relPath, content, masked, callFrames, fieldsByClass, facts, control);
    const keyedCollections = readKeyedCollections(file.relPath, starts, masked, methodFrames, facts);
    const elementFrom = facts.length;
    extractElementCalls(file.relPath, content, masked, methodFrames, fieldsByClass, facts, control);
    if (keyedCollections.size > 0) {
      // An indexer call through a keyed collection is a keyed call, not a call on every element.
      const keyedCalls = readKeyedCalls(file.relPath, starts, masked, methodFrames, keyedCollections, facts);
      const sites = new Set(keyedCalls.filter((item) => item.form === 'indexer').map((item) => `${item.class}|${item.method}|${item.field}|${item.calledMethod}|${item.line}`));
      for (let i = facts.length - 1; i >= elementFrom; i -= 1) {
        const item = facts[i];
        if (item.type === 'method_call' && item.elementAccess === true && sites.has(`${item.class}|${item.method}|${item.field}|${item.calledMethod}|${item.line}`)) facts.splice(i, 1);
      }
    }
    extractSelfCalls(file.relPath, content, masked, callFrames, methodNamesByClass, fieldsByClass, facts, control);
    scan.callFrames = callFrames;
    extractBranchPoints(file.relPath, content, masked, methodFrames, facts);
    extractExpressionDecisions(file.relPath, content, masked, starts, callFrames, facts);
    // Masked text: loop bodies, sentinel returns and the calls whose values pass through.
    extractLoopStops(file.relPath, content, masked, starts, methodFrames, fieldsByClass, expressionBodiedMethods, facts);
    extractSentinelReturns(file.relPath, content, masked, starts, methodFrames, facts);
    extractReturnFlows(file.relPath, content, masked, starts, methodFrames, expressionBodiedMethods, facts);
    extractSentinelMaps(file.relPath, content, masked, starts, methodFrames, facts);
    // Masked text: the channel is a `Channels.X` member, never a literal.
    extractRedisPublish(file.relPath, content, masked, facts, patterns);
    extractMethodSpans(file.relPath, content, masked, methodFrames, facts);
    extractExpressionBodiedMethodSpans(file.relPath, content, masked, expressionBodiedMethods, facts);
  }

  backfillMessageFqn(facts);
  extractHandlerParameters(fileScans, facts);
  extractChainCalls(fileScans, typeIndex, facts);
  extractParamSources(fileScans, facts);
  extractMediatorDispatch(fileScans, facts);
  extractStepCompositions(fileScans, facts);
  extractFlagWrites(fileScans, facts);
  extractFilterFacts(fileScans, registeredFilters, facts);
  extractEntries(fileScans, classTable, actorHandlers, options.entryPoints ?? [], facts);
  extractMapperMaps(classTable, facts);
  extractKeyProperties(classTable, facts);
  extractMapperCalls(fileScans, facts);
  extractGatewayRegistrations(fileScans, facts);
  readGatewayTables(repoRoot, walk(repoRoot, { extensions: ['.json'], exclude }), facts);
  extractEmailSenders(fileScans, options.email, facts);

  return keepCarriedJoinTasks(facts);
}

const CONST_STRING_RE = /\bpublic\s+(?:new\s+)?const\s+string\s+(\w+)\s*=\s*("(?:[^"\\\n]|\\.)*")\s*;/g;
const SENDER_VALUE = String.raw`("(?:[^"\\\n]|\\.)*"|[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)`;

function innermostClass(classFrames, index) {
  let best = null;
  for (const frame of classFrames) {
    if (frame.startIndex <= index && (frame.endIndex === null || index < frame.endIndex) && (!best || frame.startIndex > best.startIndex)) best = frame;
  }
  return best;
}

function csharpString(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return literal.slice(1, -1);
  }
}

/**
 * One `email_sender` fact for each class member that `email.senders` names, written as
 * `string <Member> => <value>;` or `string <Member> { get; } = <value>;`. The value is a string
 * literal, or a `<Class>.<NAME>` reference to a `public const string` that any file of the
 * repository declares in a class of that name. A reference that resolves to no constant or to
 * two gives `id: null` and a `reason`. It runs only when senders are configured.
 */
function extractEmailSenders(fileScans, email, facts) {
  if (!email || !Array.isArray(email.senders) || email.senders.length === 0) return;
  const constants = new Map();
  for (const scan of fileScans) {
    CONST_STRING_RE.lastIndex = 0;
    let m;
    while ((m = CONST_STRING_RE.exec(scan.content))) {
      if (scan.masked[m.index] !== scan.content[m.index]) continue;
      const owner = innermostClass(scan.classFrames, m.index);
      if (!owner) continue;
      const key = `${owner.name}.${m[1]}`;
      constants.set(key, [...(constants.get(key) || []), csharpString(m[2])]);
    }
  }
  const found = [];
  for (const { member } of email.senders) {
    const forms = [
      new RegExp(String.raw`\bstring\s+${member}\s*=>\s*${SENDER_VALUE}\s*;`, 'g'),
      new RegExp(String.raw`\bstring\s+${member}\s*\{\s*get\s*;\s*\}\s*=\s*${SENDER_VALUE}\s*;`, 'g'),
    ];
    for (const scan of fileScans) {
      for (const form of forms) {
        form.lastIndex = 0;
        let m;
        while ((m = form.exec(scan.content))) {
          if (scan.masked[m.index] !== scan.content[m.index]) continue;
          const owner = innermostClass(scan.classFrames, m.index);
          if (!owner) continue;
          const value = m[1];
          let resolved;
          if (value.startsWith('"')) resolved = { id: csharpString(value) };
          else {
            const parts = value.split('.').map((part) => part.trim());
            const ref = parts.slice(-2).join('.');
            const values = constants.get(ref) || [];
            if (values.length === 1) resolved = { id: values[0], constant: ref };
            else resolved = { id: null, constant: ref, reason: values.length === 0 ? 'no-constant' : 'two-constants' };
          }
          found.push(
            fact('email_sender', {
              file: scan.relPath,
              line: lineAt(scan.content, m.index),
              class: owner.name,
              member,
              ...resolved,
            }),
          );
        }
      }
    }
  }
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0)));
  facts.push(...found);
}
