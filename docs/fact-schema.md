# Fact schema

A fact is one statement an extractor makes about one line of one file. `flowtrace extract`
writes them to `out/facts/<repo>.json`; every later step reads only facts.

## File shape

```json
{
  "repo": "api",
  "kind": "backend",
  "generatedFrom": "backend",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "headSha": "…",
  "dirty": false,
  "fileCount": 9,
  "facts": [ … ]
}
```

The git fields are stamped when the root is a git checkout and git is on `PATH`, and are
what later steps compare against to warn that a fact set has gone stale. A non-git checkout
extracts perfectly well; it simply carries no baseline, so nothing warns.

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
| `component` | `name`, `selector`, `role` | a component is declared; `role` is `page`, `container`, `component`, `hook` or `service` |
| `renders` | `from`, `to` | one component's template renders another |
| `template_handler` | `component`, `event`, `handler`, `kind` | a template or JSX binds an event to a handler |
| `injects` | `from`, `to` | a class is given another as a dependency |
| `gateway_call` | `service`, `method`, `verb`, `template`, `resolved` | a service issues an HTTP call; `resolved` is false when the URL could not be made literal |
| `action_def` | `action` | an action type is declared |
| `action_dispatch` | `class`, `method`, `action` | a body dispatches an action |
| `effect_handler` | `class`, `field`, `actions`, `endLine` | a body handles dispatched actions and issues HTTP |
| `props_bind` | `component`, `prop`, `target` | a `connect` map binds a creator to a prop |

### Test evidence

| type | fields | stated when |
|---|---|---|
| `pw_test` | `spec`, `test`, `skipped` | a Playwright test is declared |
| `pw_request` | `spec`, `test`, `verb`, `template`, `resolved` | a test issues a request |
| `pw_assert` | `spec`, `test`, `kind` | a test asserts something |
| `pw_stub` | `spec`, `test`, `kind` | a test stubs a response |
| `cypress_test` | `spec`, `test`, `skipped` | a Cypress test is declared |
| `cypress_intercept` | `spec`, `test`, `verb`, `pattern` | a Cypress spec or support file intercepts a URL |
| `case_id` | `spec`, `ids`, `source` | a test names test-management case ids — `source` is `annotation` for a `case-id` annotation push, `literal` for a literal argument of a configured case-id call, `table` for one row of a same-file data table the test iterates |
| `pw_title` | `spec`, `titles` | *(optional)* the titles a collector resolved at one `pw_test` declaration line, one per parameter instance |

A `cypress_intercept` written in a support command carries no enclosing test and is exactly
as much proof that a route is exercised as one written inline. There is no Cypress assertion
fact, which is why Cypress evidence can never reach the `path` tier — the schema records no
basis for it.

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
evaluates each parameterised title, and one fact per resolved declaration line carries the
titles it produced. Without the option, or when the collector could not run, a reader keeps
the title *expression* as written and labels it `raw`; the fact set's header says which of
the two happened.

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
  "generatedFrom": "flowtrace 0.1.1",
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
    }
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
before the merge, because afterwards the losing facts are gone. Extracted facts keep their
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
