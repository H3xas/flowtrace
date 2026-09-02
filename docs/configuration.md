# Configuration

flowtrace reads one file, `flowtrace.config.json`, from the working directory — or from
wherever `--config <path>` points. It holds the only machine-specific thing flowtrace
needs: where the repositories are.

Every path in the file resolves relative to **the file itself**, so a configuration file
that sits beside the checkouts it names works from any working directory.

A configuration file naming absolute checkout paths is a machine-local file. Keep it out of
version control (the shipped `.gitignore` already does) and commit
`flowtrace.config.example.json` instead.

## Top level

| key | required | meaning |
|---|---|---|
| `out` | yes | output directory; facts, flow, reports and scaffolds land under it |
| `repos` | yes | non-empty array of repositories, below |
| `aliases` | no | route-prefix rewrites the join step applies when a call finds no route |
| `sinks` | no | what makes a class a data sink, below |
| `caseId` | no | call shapes whose literal arguments are test-management case ids, below |
| `workerPatterns` | no | a worker-queue framework's own extraction patterns, below |
| `scout` | no | `{ "bin": "<path or command>" }` — the code index used for graph hops |
| `scaffold` | no | the target harness's conventions, used by `scaffold` |

## `repos[]`

| key | required | meaning |
|---|---|---|
| `id` | yes | unique short name; names the fact file and `--repo` |
| `kind` | yes | `backend` · `mobile` · `contracts` · `playwright` · `web` |
| `root` | yes | path to the checkout |
| `exclude` | no | glob patterns skipped during the walk |
| `role` | no | `["api"]` · `["worker"]` · `["contracts"]` — what this repository *is*, when one kind serves two purposes |
| `scout` | no | `true` to allow code-index hops into this repository |
| `srcSubpath` | no | `web` only: source subdirectory to walk (default `src`) |
| `cypressSubpath` | no | `web` only: sibling Cypress suite, relative to `root` |
| `featureRoots` | no | `mobile` only: source roots to walk instead of the single default |
| `cypress` | no | `mobile` only: allowlisted Cypress discovery roots, below |

### Kinds

- **`backend`** — ASP.NET Core over `.cs`. Routes, controller actions, branch points,
  constructor injection, DI registrations, MassTransit publish/consume, worker-queue
  processors, SignalR pushes, data-access sinks.
- **`contracts`** — the same extractor, for a repository that holds message and DTO
  definitions but no routes.
- **`mobile`** — Ionic/Angular over `.ts` and `.html`. Components, selectors, template
  handlers, injected services, gateway calls, and a Cypress suite if one is present.
- **`web`** — React + TypeScript with classic Redux. Components, `connect` bindings, JSX
  handlers, action creators that issue HTTP, and a sibling Cypress suite.
- **`playwright`** — a spec suite. Tests, skips, case ids, requests, assertions, stubs.

### Mobile Cypress roots

A mobile repository defaults to discovering end-to-end specs under `cypress/e2e` and
support commands under `cypress/support`. A shared Cypress tree can narrow either root
with the optional `cypress` object:

```json
{
  "id": "mobile",
  "kind": "mobile",
  "root": "/path/to/mobile-checkout",
  "cypress": {
    "e2e": "cypress/e2e/checkout",
    "support": "cypress/support/checkout"
  }
}
```

Both paths are relative to the repository root. Either subkey may be omitted: `e2e`
defaults to `cypress/e2e`, and `support` defaults to `cypress/support`. Each configured
path replaces its corresponding default rather than adding another discovery root, so a
sibling subtree outside the allowlist contributes no tests or intercepts.

## `aliases[]`

```json
"aliases": [{ "from": "catalog/", "to": "inventory/" }]
```

Applied by `join` when a caller-side call matches no declared route: the prefix is rewritten
and the match retried. This is for a gateway that serves one prefix under another name — it
is not a general rewrite engine, and each entry should be traceable to a real routing rule.

## `sinks`

What makes a reached class an observable end rather than plumbing.

```json
"sinks": {
  "db": ["/DataAccess/", "Repository", "Store"],
  "writePrefixes": ["Insert", "Update", "Upsert", "Save", "Delete", "Create"],
  "readPrefixes": ["Get", "Find", "Fetch", "Load", "Read", "List", "Query"]
}
```

`db` entries match a class's file path or its name. The prefixes classify a called method as
a write or a read, which is what makes `db·write` heavier than `db·read` in the gap
ranking. Each key falls back to a built-in default when omitted.

## `caseId`

The playwright extractor recognises one case-id shape out of the box — the neutral
`test.info().annotations.push({ type: 'case-id', description: '…' })` annotation push whose
description is a string literal. A suite that tags tests through its own helper does it with
a call flowtrace cannot know about. `caseId` names those callees. It defaults to none.

```json
"caseId": {
  "calls": ["tms.id"]
}
```

- `calls` — callee names whose call sites carry case ids: the entry `tms.id` makes every
  string-literal argument of a `tms.id(...)` site a case id. Ids resolved either way join
  the test's `case_id` fact ([fact-schema.md](fact-schema.md)).

## `workerPatterns`

The backend extractor recognises public messaging idioms out of the box — MassTransit's
`IConsumer<T>` and `Publish`/`PublishAsync`, StackExchange.Redis channel publishes. A
codebase built on its own worker-queue framework registers processors, binds queues and
publishes through methods flowtrace cannot know about. `workerPatterns` teaches the
extractor those shapes. Every field is an array of regex-source strings (JSON-escaped),
and every field defaults to empty.

```json
"workerPatterns": {
  "registrations": ["\\.RegisterJobHandler\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "topologyBindings": ["\\bBindJobQueue\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "queuePrefixConstants": ["JOB_QUEUE_PREFIX"],
  "publishCalls": ["Enqueue"],
  "consumerBases": ["JobConsumerBase"],
  "broadcastCalls": ["BroadcastToChannel"],
  "configReads": ["ReadSetting"]
}
```

- `registrations` — whole regexes for the framework's registration idiom
  (`services.RegisterJobHandler<InvoiceHandler>(JobKind.Invoice)` in the invented example).
  Capture group 1 must be the processor type, group 2 the work-type name; each match emits
  a `worker_processor` fact.
- `topologyBindings` — whole regexes for a queue-topology binding call, same capture
  contract with the message type in group 1; each match emits a `queue_name` fact once a
  queue prefix is known.
- `queuePrefixConstants` — names of the constant whose string literal is the queue-name
  prefix. The constant is matched in any class, however that class is named.
- `publishCalls` — extra publish method names, matched with an optional `Async` suffix
  alongside the built-in `Publish`.
- `consumerBases` — extra consumer base-type names, matched alongside the built-in
  `BaseConsumer` and `IConsumer`.
- `broadcastCalls` — extra channel-publish method names, matched alongside the built-in
  `PublishAsync` when the argument is a `Channels.X` member.
- `configReads` — helper methods whose single string argument is a configuration key
  (`_url = config.ReadSetting("Gateway")`); this is what lets the outbound-HTTP pass tie
  an interpolated URL back to a configuration key. Without it that pass is inert.

## `scout`

```json
"scout": { "bin": "devscout" }
```

Optional. See [scout.md](scout.md).

## `scaffold`

The vocabulary of the harness `flowtrace scaffold` writes into: spec root and suffix, import
aliases, role names, the API-context factory, the case-id placeholder, the worker-publish
client, status conventions. Every value is a placeholder for something in *your* harness —
the built-in defaults are a shape, not a recommendation. Every key is optional; nested
objects may override only the entries they need.

| key | type | meaning |
|---|---|---|
| `specRoot` | string | directory that receives generated route specs |
| `specSuffix` | string | suffix appended to every generated spec name |
| `workerRoot` | string | directory that receives worker-shaped specs |
| `importAliases.fixtures` | string | module that exports the Playwright fixtures |
| `importAliases.utils` | string | module that exports the API factory, API base and roles |
| `importAliases.features` | string | module prefix for feature client imports |
| `importAliases.generated` | string | module prefix for generated helpers |
| `roles.default` | string | role used for an ordinary successful request |
| `roles.denied` | string | role used for an unauthorised or forbidden request |
| `roles.member` | string | additional member-role vocabulary available to the harness |
| `contextFactory.store` | string | API-context factory class or store name |
| `contextFactory.instance` | boolean | whether the generated file constructs the factory store |
| `contextFactory.instanceVariable` | string | variable that holds the constructed factory store |
| `contextFactory.method` | string | factory method that returns a request context |
| `contextFactory.as` | string | exported role-map name passed to the factory method |
| `contextFactory.api` | string | exported API-base expression passed to the factory method |
| `contextFactory.fixtures` | string[] | Playwright fixtures destructured by each generated test |
| `contextFactory.variable` | string | local variable that receives the request context |
| `caseIdPlaceholder` | string | statement left where a case id must be supplied |
| `worker.module` | string | module that exports the worker-publish client |
| `worker.client` | string | worker-publish client class |
| `worker.method` | string | client method that publishes the message |
| `worker.builder` | string | helper that builds the message payload |
| `clientClassTemplate` | string | feature-client class template; `{Feature}` is replaced by the feature name |
| `unresolvedRejectStatus` | number[] | accepted status choices when a rejection status is unresolved |
| `okStatus` | number | expected status for a successful request or read-back |

See `flowtrace.config.example.json` for every key with the built-in values filled in.

## Worked example

`examples/demo-shop/flowtrace.config.json` is the smallest configuration that produces a
non-trivial trace: two repositories, no options.

```json
{
  "out": "out",
  "repos": [
    { "id": "api", "kind": "backend", "root": "backend", "role": ["api"] },
    { "id": "e2e", "kind": "playwright", "root": "e2e" }
  ]
}
```
