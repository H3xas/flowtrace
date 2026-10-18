# Fact schema

A fact is one statement an extractor makes about one line of one file. `flowtrace extract`
writes them to `out/facts/<repo>.json`; every later step reads only facts.

## File shape

```json
{
  "repo": "api",
  "kind": "backend",
  "generatedFrom": "flowtrace <version>",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "headSha": "…",
  "dirty": false,
  "dirtyDigest": "…",
  "fileCount": 9,
  "titles": { "status": "ok", "facts": 12, "refused": 0 },
  "facts": [ … ]
}
```

The git fields are stamped when the root is a git checkout and git is on `PATH`, and are
what later steps compare against to warn that a fact set has gone stale. `dirtyDigest` is
part of that same stamp: a fingerprint of the working tree's changed paths, present whenever
the other git fields are. `titles` is not a git field: it appears only on a `playwright`
repository configured `"titles": true`, and states what the title collector did (`status`
`ok` or `failed`). A non-git checkout extracts perfectly well; it simply carries no
baseline, so nothing warns — that fact set's *identity* inside a `join --snapshot` or
`join --export-edges` document still states a revision witness, as `"headSha": null`, rather
than omitting the field.

A repository configured with a `factsProvider` also carries a `provider` block between the
git fields and `facts`; see [Externally supplied facts](#externally-supplied-facts).

## Every fact

Required on all: `type`, `file` (repository-relative, forward slashes), `line` (1-based).
Each type adds its own required fields; optional fields may be added freely and are carried
through untouched.

One optional field has a fixed meaning on every type: `provenance`, present only on a fact
an external provider supplied, `{ "producer": "…", "version": "…" }`. A fact the bundled
extractor read never carries it. The absence is the mark, and a provider cannot set it
(see below).

### Backend

| type | fields | stated when |
|---|---|---|
| `route` | `controller`, `action`, `verb`, `template` | a controller action declares an HTTP route; a minimal-API registration adds `handler` (`lambda`, or `method` for a method group naming a method the repository declares), and a lambda's `action` is `<registering method>(<VERBS> <template>)` |
| `http_out` | `configKey`, `template` | the service calls out over HTTP to another service |
| `publish` | `message`, `verb` | a message is published to the bus; `message` is `null` and `unresolved` names why when the argument's type could not be read; `verb` is the matched call name lower-cased (`publish`, `send`, `defer`, `submitjob`, `reply`, an `Async` suffix dropped either way) |
| `consume` | `message`, `consumer` | a class consumes a message type |
| `saga` | `saga`, `initiatedBy`, `handles`, `correlation` | a class implements a saga interface (`workerPatterns.sagaInterfaces`, default `IAmInitiatedBy`); `initiatedBy` and `handles` are message-type-name arrays read off the class's own base list, and `correlation` is the property a `ConfigureHowToFindSaga`/`CorrelateBy` lambda names, or `null` when the class states none. The class still emits its own `consume` facts for whichever messages its base list names through a consumer base, so a reader that ignores `saga` sees the walk unchanged |
| `worker_processor` | `workType`, `processor` | a processor is registered against a work type |
| `signalr_push` | `method` | a SignalR hub method is pushed to clients |
| `redis_publish` | `channel` | a broadcast is published to a channel |
| `exchange_name` | `name`, `constant` | an exchange name constant is declared |
| `queue_name` | `message`, `name` | a queue name is derived for a message |
| `message_class` | `name`, `fqn` | a message type is declared |
| `di_binding` | `iface`, `impl` | an interface is registered to an implementation |
| `ctor_field` | `class`, `field`, `paramType` | a class holds a constructor-injected field; with `method`, a parameter the framework injects into that one handler |
| `method_call` | `class`, `method`, `field`, `calledMethod` | a body calls a member on an injected field; optional `receiverType` names the receiver's type when the field is not a constructor field |
| `method_span` | `class`, `method`, `endLine` | a method body's extent; optional `paramTypes` lists the signature's parameter types as written |
| `branch_point` | `class`, `method`, `kind`, `text`, `endLine` | a body branches; `kind` is `error_return`, `validation`, `toggle`, `guard`, `if` or `switch` |
| `param_source` | `class`, `method`, `param`, `source`, `via` | where a parameter's value comes from — `body`, `query`, `route`, `jwt`, `injected` |
| `exception_map` | `scope`, `class`, `exception`, `status` | an exception type is converted to a status — `scope` is `global` for a registered exception filter, `action` for a `catch` inside one controller action |

`param_source` is what makes seed reachability answerable: a branch reading only `jwt` or
`injected` values cannot be forced by a black-box caller.

### Caller side (mobile and web)

| type | fields | stated when |
|---|---|---|
| `component` | `name`, `selector`, `role` | a component is declared; `role` is `page`, `container`, `component`, `hook` or `service`; optional `lazy` is the module a `lazy(() => import(...))` binding loads; `exports`, on every web component, lists each name its module exports it under, `default` included, and is `[]` for a component the module declares without exporting; a render's `source` binds only a component whose `exports` holds the imported name, and a web component without `exports` binds no import |
| `renders` | `from`, `to` | one component's template renders another; optional `source` is the module the rendering file imports `to` from; optional `imported` is the name that module exports it under when it is not `to` itself — `default` for a default import, `A` for `{ A as B }`, the member for a namespace tag `<NS.A>` |
| `template_handler` | `component`, `event`, `handler`, `kind` | a template or JSX binds an event to a handler |
| `injects` | `from`, `to` | a class is given another as a dependency |
| `gateway_call` | `service`, `method`, `verb`, `template`, `resolved` | a service issues an HTTP call; `resolved` is false when the URL could not be made literal |
| `action_def` | `action` | an action type is declared |
| `action_dispatch` | `class`, `method`, `action` | a body dispatches an action |
| `effect_handler` | `class`, `field`, `actions`, `endLine` | a body handles dispatched actions and issues HTTP |
| `props_bind` | `component`, `prop`, `target` | a `connect` map binds a creator to a prop |
| `component_entry` | `component`, `kind`, `trigger`, `handler`, `guards` | execution reaches a component: a class lifecycle callback, a hook effect, the cleanup an effect returns, or a trigger the extractor cannot read |
| `page_route` | `owner`, `path` | a web `<Route>` element, as written: `owner` is the component declaring it and `path` its own path (`''` for an index or pathless route). Optional: `index`, `layout` (it has child routes), `parentLine`/`parentColumn` (the enclosing `<Route>`), `pathLine`, `element` with `elementFile`/`elementName` when the element's import resolves, `lazyLine`/`lazySpecifier` when the element is a lazy binding, `wrappers`, `guards` (`{ kind: "condition", text, branch }` or `{ kind: "wrapper", text }`), `redirect`/`redirectLine` for a `<Navigate>`, and `unsupported` — `path-expression`, `optional-segment`, `element-expression`, `redirect-expression`, `route-expression` or `route-object` — for a form the lookup will not guess through. A `<Route>` held by an `if (…) { … }` block carries that test as a `guards` condition, unevaluated like any other; one built inside a loop, a `switch` or an object literal keeps `route-expression` |
| `page_route` (from a route array) | as above | the same fact for an entry of an array a `.map` renders as `<Route>`: `file`/`line`/`column` stay the rendering `.map`'s `<Route>` site, and `entryFile`/`entryLine`/`entryColumn` name the array entry the values came from, with `arrayFile`/`arrayName` naming the iterated constant or the prop it arrived as. An entry's guard carries its own `file`, which is the entry's, not the render site's. `unsupported` adds `route-array-expression` (a computed or concatenated array, or an entry that is not an object literal), `route-array-unresolved` (no readable array behind the iterated name), `route-array-ambiguous` (more than one prop site supplies it), `filter-expression` (a `.filter` predicate that is not one property of the loop binding) and `filter-property` (an entry the filter names by a property it does not state) |
| `page_mount` | `path`, `source` | where a routed tree is mounted: `source` `app-root` (a root render; `component` names what it renders) or `router` (a router element inside `component`), with `path` the router's literal `basename` or `/`; an unreadable basename has `path: ""` and `unsupported: "basename-expression"` and cannot anchor a page; or `inferred`, the prefix the library's own `navigate()` literals agree on, with `evidence` counting them |

A `component_entry` names one way execution reaches a component, on the site it was
written at. `kind` is `mount`, `update`, `unmount`, `effect`, `cleanup`, `event` or
`unknown`; `trigger` is the name it was written under (`componentDidMount`, `useEffect`,
a hook the extractor does not read); `handler` is the callback or handler it names, and is
`null` when the trigger *is* its own callback. `guards` lists, in source order, the
conditions that gate the calls inside the entry. Optional: `column` is the trigger's
1-based column, which with `line` is the site — two declarations can share a line, and one
line is then not a site; `deps` is an effect's dependency list as written — `[]` when none
was written — `endLine` closes the entry's span, `unresolved` names why the trigger could
not be followed (`custom-hook`, `dynamic-callback`), and `method` is the key the calls
inside the entry attribute to.

An entry states a declaration, never how many times React runs the body and never an
order between two entries. A JSX `on*` binding is an entry too; its identity comes from
the `template_handler` fact that states it, with the event as its trigger. A `use…` call
the extractor does not read is one entry per call site, so two calls of one unread hook
are two sites rather than one name.

Optional on `action_dispatch`: `continuesFile` and `continuesLine` name the gateway call
whose response handler this dispatch is written inside, and `outcome` is `success` or
`failure` for which of that call's handlers it is. The field is stated only where the
source states the relation — a `.then` or `.catch` callback — never inferred from two
statements sharing a body. Optional on `template_handler`: the `column` of the binding.

### Test evidence

| type | fields | stated when |
|---|---|---|
| `pw_test` | `spec`, `test`, `skipped` | a Playwright test is declared — not a `test.skip(condition, reason)` guard written inside a test body, and not a `test` reached through a member access (a regular expression's `.test(...)`, a matcher object's) |
| `pw_request` | `spec`, `test`, `verb`, `template`, `resolved` | a test issues a request |
| `pw_assert` | `spec`, `test`, `kind` | a test asserts something |
| `pw_stub` | `spec`, `test`, `kind` | a test stubs a response; `handler` says what its route handler does |
| `pw_backend` | `spec`, `test`, `skipped`, `backend`, `sites` | one per `pw_test`: whether the test runs on a real backend, on patched responses or on a mocked backend |
| `cypress_test` | `spec`, `test`, `skipped` | a Cypress test is declared |
| `cypress_intercept` | `spec`, `test`, `verb`, `pattern` | a Cypress spec or support file intercepts a URL |
| `case_id` | `spec`, `ids`, `source` | a test names test-management case ids — `source` is `annotation` for a `case-id` annotation push, `literal` for a literal argument of a configured case-id call, `table` for one row of a same-file data table the test iterates |
| `pw_title` | `spec`, `titles` | *(optional)* the titles a collector resolved for one `pw_test` declaration, one per parameter instance; its `line` is that declaration's *source* line |

A `cypress_intercept` written in a support command carries no enclosing test and is exactly
as much proof that a route is exercised as one written inline. There is no Cypress assertion
fact, which is why Cypress evidence can never reach the `path` tier — the schema records no
basis for it.

`pw_backend` is written for every `pw_test`, at the same `file` and `line` and with the same
`spec`, `test` and `skipped`. `backend` is one of four classes:

- `mocked`: a call named in `backend.mockCalls` reaches the test
  ([configuration.md](configuration.md#backend)).
- `patched`: a route handler answers a request (`route.fulfill`, with or without
  `route.fetch` first), a `routeFromHAR(` call replays an archive, or a call named in
  `backend.patchCalls` reaches the test.
- `unknown`: the test reaches a region that the reader cannot read, and no mock or patch
  decides the class. `reason` says which region: `body-by-reference` (a test body or a hook
  passed by name), `named-handler` (a route handler named by a function that its file does
  not declare), `unread-handler` (a handler that calls none of `fulfill`, `fetch`, `continue`,
  `fallback` and `abort` on its route), `ambiguous-helper` (a bare call name whose
  repo-wide functions reach different kinds), or `unread-file` (the reader could not parse the
  spec file).
- `real`: none of the above.

The precedence is `mocked`, then `patched`, then `unknown`, then `real`, and only an `unknown`
fact carries `reason`. A test is read through its own body, the `beforeEach` and `beforeAll`
hooks at file level and of every `test.describe` block that encloses it, and every function
that those regions call. A function of the same file wins over a repo-wide class method or
top-level function of the same name. The walk follows calls to a fixed point, so a cycle
ends it. Comments and string contents are never read as calls.

`sites` lists the calls that decided the class, sorted by line. A site has `line`, `where`
(`test`, `hook` or `helper`) and `kind`, and can have `call`, `via` and `at`:

| `kind` | the deciding call |
|---|---|
| `mock` | a call named in `backend.mockCalls` |
| `patch` | a call named in `backend.patchCalls` |
| `fulfill` | a `.route(` handler that calls `fulfill` |
| `fetch-fulfill` | a `.route(` handler that calls `fetch` and then `fulfill` |
| `har` | a `routeFromHAR(` call |
| `abort` | a `.route(` handler that calls `abort` and not `fulfill` |
| `spy` | a `.route(` handler that calls only `continue` or `fallback` |
| `unresolved` | a region the reader cannot read |

An `abort` or a `spy` site never changes the class: a spy shows that the test makes the
request, and an abort removes a request. `call` is the callee as written. `via` lists the
functions between the test and the deciding call, in call order, with a method written as
`Class.method`. `at` gives the `file` and `line` of the deciding call when another file holds
it. A site `line` is always a line of the spec: the deciding call's own line when the spec
holds it, else the line of the test's call into `via`.

`pw_stub.handler` comes from the same reader: `fulfill`, `fetch-fulfill`, `abort`, `spy` or
`unresolved`. A direct `page.route(` stub takes the kind of its own handler. A stub helper call
takes the kind that every repo-wide helper of that name agrees on, else `unresolved`. The field
adds nothing to the set of `pw_stub` facts, and `cover` reads neither field.

`case_id` resolves only three shapes and refuses the rest: a
`test.info().annotations.push({ type: 'case-id', description: '…' })` whose description is
a string literal, a literal argument of a configured case-id call (`caseId.calls` in the
configuration file — an entry like `tms.id` matches `tms.id(...)` sites; none are
configured out of the box), or a member expression whose object is the loop binding of a
same-file `for (const row of ROWS)` over an array of object literals. A subscript, a
computed value, a template or a cross-file table stays absent rather than being
approximated — the id a tester pastes into a case tool is never invented.

`pw_title` is written by `extract` for a `playwright` repository configured `"titles": true`
(see [configuration.md](configuration.md#playwright-titles)): Playwright's own list mode
evaluates each parameterised title, and one fact per resolved declaration carries the titles
it produced. The listing is joined to the source on `(spec file, declaration ordinal)`, not
on any line the runner reports — those are positions in transformed source — so a fact's
`line` is always the *source* line of the declaration it belongs to, the same line the
`pw_test` fact for that declaration carries. A spec file whose two sides cannot be shown to
line up resolves nothing at all rather than a shifted set. Without the option, when the
collector could not run, or for a refused file, a reader keeps the title *expression* as
written and labels it `raw`; the fact set's header says which of the three happened.

### Derived and judged

| type | fields | stated when |
|---|---|---|
| `assertion_surface` | `route`, `status`, `chain` | `surface --out <file>` records where the state one route writes can be read back; `status` is `resolved` (adds `state`, `observe`) or `gap` (adds `reason`) |
| `surface_verdict` | `route`, `state`, `observe`, `field`, `reflects` | a human or agent read the projection path and recorded whether a response field of `observe` reflects the write; a refusal is `reflects: false`, an unread correlation is absent |

These two are the only facts not produced by an extractor. `assertion_surface` is a
derivation this tool can redo from the same fact sets at any time; `surface_verdict` is a
judgment it cannot make, cached so `skeleton` can quote it instead of guessing.

## Externally supplied facts

A repository configured with a `factsProvider` ([configuration.md](configuration.md#external-fact-provider))
takes facts from a second producer. The provider's document is `{ "producer", "version"?,
"repo"?, "facts" }`, its facts validated by the rules below, and every one that enters the
file is stamped `provenance`. The header records the second producer and how the two
compared, while `generatedFrom` still names the extraction that wrote the file:

```json
{
  "repo": "api",
  "kind": "backend",
  "generatedFrom": "flowtrace <version>",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "provider": {
    "producer": "syntax-exporter",
    "version": "1.4.0",
    "source": { "file": "/workspace/shop-api-facts.json" },
    "merge": "prefer-external",
    "supplied": 37,
    "kept": 37,
    "replaced": 12,
    "comparison": {
      "ctor_field": { "extracted": 20, "external": 22, "agreed": 9, "disagreed": 3, "externalOnly": 10, "extractedOnly": 8 }
    },
    "digest": "4b1f0c9e2d7a58e3b6c1f90a7d2e4c8b5a3f6e10"
  },
  "facts": [
    { "type": "ctor_field", "file": "Controllers/OrdersController.cs", "line": 14,
      "class": "OrdersController", "field": "_orders", "paramType": "Shop.Orders.IOrderService",
      "provenance": { "producer": "syntax-exporter", "version": "1.4.0" } }
  ]
}
```

`source` is `{ "file" }` or `{ "command": [ … ] }` as configured. `supplied` counts the
facts the provider gave, `kept` how many of them entered the array, `replaced` how many
extracted facts were dropped in their favour. In `comparison`, `extracted` and `external`
count facts per type; `agreed`, `disagreed`, `externalOnly` and `extractedOnly` count
*sites* — one type at one line of one file — that both stated identically, both stated
differently, only the provider stated, only the extractor stated. The comparison is computed
before the merge, because afterwards the losing facts are gone. `digest` is a sha1 over the
provider's facts as it supplied them, before any stamp or merge.

Every field of this block except `source` is part of the fact set's identity in a snapshot and
an edge export. `source` is left out because it is a location on one machine: the same facts
read from another checkout must keep the same identity, and an identity is published.
`digest` stands in for it, and is what still tells two provider documents apart under
`regex-only-with-diff`, where none of the provider's facts enter the array. Extracted facts keep their
order and come first; the provider's follow in the order it gave them.

## Validation

`fact(type, fields)` throws on an unknown type, a missing required field, a `file` that is
not repository-relative with forward slashes, or a `line` that is not a positive integer.
`validateFacts(array)` checks a whole set and reports the first bad entry by index and type.
Both live in `lib/facts.js`; an extractor cannot emit a malformed fact by accident.
`parseProviderDocument(document)` applies the same checks to an external provider's document
and additionally refuses a fact that already carries `provenance`, so the stamp is always
this tool's own statement.

## Reverse-resolution fields

`routes-of` adds no fact types and never scans source. Literal mode searches this complete
allowlist:

| meaning | fact field |
|---|---|
| route template | `route.template`, `gateway_call.template` |
| method-call target | `method_call.calledMethod` |
| publish or consume key | `publish.message`, `consume.message` |
| spec-evidence string | `cypress_test.test`, `pw_test.test` |

Route-template fields use the same route normalizer as `join`; all other fields compare the
whole string exactly. Substrings, regular expressions, fuzzy matches, concrete URLs standing
in for parameterised templates, metadata fields and raw file contents do not resolve.

The forward walker carries the identity and `repo:file:line` of these source facts on the
edges they create. That edge provenance is how reverse membership for a call, publish,
consume or gateway literal is proved. A spec title joins through the existing route-evidence
index instead; it remains route-level evidence and does not claim that the queried point ran.
