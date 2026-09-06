# Configuration

flowtrace reads one file, `flowtrace.config.json`, from the working directory — or from
wherever `--config <path>` points. It holds the only machine-specific thing flowtrace
needs: where the repositories are.

## Where the file lives

Every path in the file resolves relative to **the file itself**, so a configuration file
that sits beside the checkouts it names works from any working directory. The simplest
layout is a workspace directory holding the checkouts, with the file next to them:

```
workspace/
  flowtrace.config.json      "root": "shop-api", "root": "shop-e2e"
  areas/                     area files, committed
  out/                       written by flowtrace, never committed
  shop-api/
  shop-e2e/
```

A monorepo works the same way with the file at its root and each `root` naming a
sub-directory, as the worked example under `examples/demo-shop` does. Do not point a `root`
at the directory that holds `out`: `scaffold` and `cases` refuse to write inside a configured
repository.

A configuration file naming absolute checkout paths is a machine-local file. Keep it out of
version control (the shipped `.gitignore` already does) and commit an example instead.
`flowtrace.config.example.json` at the repository root shows every key filled in, with the
checkouts named as siblings of the file.

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
| `titles` | no | `true` on a `playwright` repository to collect the titles its tests produce, through Playwright's own list mode; see [Playwright titles](#playwright-titles) |
| `factsProvider` | no | an external fact document for this repository — a file, or a command that prints one — and how it merges with the extraction; see [External fact provider](#external-fact-provider) |
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
- **`playwright`** — a spec suite. Tests, skips, case ids, requests, assertions, stubs, and
  with `"titles": true` the resolved titles of parameterised tests.

### Mobile Cypress roots

A mobile repository defaults to discovering end-to-end specs under `cypress/e2e` and
support commands under `cypress/support`. A shared Cypress tree can narrow either root
with the optional `cypress` object:

```json
{
  "id": "mobile",
  "kind": "mobile",
  "root": "shop-app",
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

### Playwright titles

A parameterised test declares its title as an expression — `renders a ${size} card` — and
reading the source cannot know which titles that produces. Playwright's own list mode can.
With `"titles": true` on a `playwright` repository, `extract` runs that repository's own
installed Playwright in list mode and appends one `pw_title` fact per test declaration the
listing resolved, carrying every title it produced; the tree renderer then marks such a
title `listed` instead of `raw`.

```json
{ "id": "e2e", "kind": "playwright", "root": "shop-e2e", "titles": true }
```

What it needs: `@playwright/test` installed where a `require` from the repository root would
find it, which is the suite's own `node_modules` or a hoisted workspace root, and Node to
run it. The tool resolves the package there and nowhere else; nothing is fetched, nothing is
installed, and no browser is started. The command runs with the repository as its working
directory, a 60-second limit, and a small preload written to `out/.pw-list-preload.cjs` that
pins every request for `@playwright/test` to the one installed copy, so a suite that vendors
a second copy inside a helper package still lists.

Which distributions collect titles: a checkout and the npm package, both of which run under
Node. The single-file executable from the releases page does not. It embeds its own runtime
and does not process Node's command-line options, so it cannot start list mode, and the tool
neither searches the `PATH` for a Node nor fetches one. Run that way with `"titles": true`,
`extract` reports `titles unavailable` with the reason `the single-file executable cannot run
Playwright list mode; install the npm package (flowtrace-cli) to collect titles`; the
collector resolves, writes and starts nothing, and everything else is extracted as usual.

When the collector cannot run — the tool is the single-file executable, the package is not
resolvable, its command-line entry is missing, list mode exits non-zero or times out, or its
output is not the JSON reporter's — extraction still succeeds. The extract line reads
`titles unavailable`, one stderr line names the reason, the fact set's header carries
`"titles": { "status": "failed", "reason": "…" }`, and no `pw_title` fact is written. On
success the header carries `"titles": { "status": "ok", "facts": N }`. Without the option
the header has no `titles` field and nothing is spawned.

### External fact provider

The bundled extractors read source with regular expressions and brace matching. A tool
that holds a real syntax tree — a compiler front end, a language server, a code index —
can state some facts better: a local variable's type, a lambda body as an action. A
`factsProvider` lets one repository take facts from such a tool without flowtrace learning
a compiler. One provider per repository, either a static document or a command:

```json
{ "id": "api", "kind": "backend", "root": "shop-api",
  "factsProvider": { "file": "shop-api-facts.json", "merge": "prefer-external" } }
```

```json
{ "id": "api", "kind": "backend", "root": "shop-api",
  "factsProvider": { "command": ["dotnet", "tools/export-facts.dll"], "merge": "external-only" } }
```

Exactly one of `file` or `command`, and `merge` is required — the mode changes every
number downstream, so a configuration must say which one it means. `file` resolves against
the configuration file. `command` is an argument vector: its first entry resolves against
the configuration file when it contains a path separator and is looked up on `PATH`
otherwise. The command runs with the repository root as its working directory, with
`FLOWTRACE_REPO_ID`, `FLOWTRACE_REPO_ROOT` and `FLOWTRACE_REPO_KIND` added to its
environment, a five-minute limit and a 256 MiB output limit; its stdout must be the
document below, and its stderr is shown only when it fails.

**The document** is JSON:

```json
{
  "producer": "syntax-exporter",
  "version": "1.4.0",
  "repo": "api",
  "facts": [
    { "type": "ctor_field", "file": "Controllers/OrdersController.cs", "line": 14,
      "class": "OrdersController", "field": "_orders", "paramType": "Shop.Orders.IOrderService" }
  ]
}
```

`producer` is required; `version` is optional; `repo`, when present, must equal the
repository's `id`; `facts` is an array of facts exactly as [fact-schema.md](fact-schema.md)
defines them, any type included. Nothing else in the document is read.

**What `extract` does with it.** After the extractor has run, the provider's document is
read and every fact in it is validated as an extractor's would be. Each one is then stamped
`provenance: { "producer", "version" }` and the two sets are combined under `merge`. The
written fact set's header keeps `generatedFrom` for the extraction and adds a `provider`
block — producer, version, source, mode, how many facts were supplied, kept and replaced,
and a per-type comparison of the two sources computed before the merge discarded anything.
The `extract` line says what happened: `53 facts (48 extracted, 5 from syntax-exporter,
prefer-external)`.

**Merge modes.** The unit is a *site*: one fact type at one line of one file. The value
fields — `paramType`, `template`, `endLine` — are exactly what a semantic tool corrects,
so matching on them would keep the extractor's wrong value beside the corrected one. A
provider that states a site states it completely: two calls on one line are two facts at
one site, and stating one of them replaces both.

- `prefer-external` — at every site the provider states, its facts replace the
  extractor's; sites it is silent on keep the extractor's facts.
- `external-only` — for every fact *type* the provider states, the extractor's facts of
  that type are dropped wholesale; types it is silent on keep the extractor's facts.
- `regex-only-with-diff` — the extractor's facts only. The provider's are validated and
  compared, the comparison lands in the header, and none of its facts enters the file.
  This is how a new provider is measured against the baseline before it is trusted.

**Refusals.** Any of these refuses the whole `extract` run with exit `1`, names the
provider's source and the offending record (`Fact #12 (ctor_field): missing required field
"paramType"`), and writes no fact file for that repository: a document that is not a JSON
object, a missing `producer`, a `repo` naming another repository, a `facts` that is not an
array, an unknown fact type, a missing required field, a `file` that is not
repository-relative with forward slashes, a `line` that is not a positive integer, a fact
that already carries `provenance` (the stamp is this tool's statement, never the
provider's claim), an unreadable file, a command that cannot start, exits non-zero, times
out, exceeds the output limit, or prints something other than JSON. Nothing is dropped
silently: a fact set that quietly lacked what was configured would be a number nobody
could point at a fact for.

**What readers see.** An external fact carries `provenance` in the fact file; an extracted
fact never does, and that absence is the mark. `trace` prints `[provider]` on every hop
located at a line where an externally supplied fact is stated, and its `--json` and
`--graph` nodes carry `provider: true` for the same hops. `render` adds a *Fact producers*
section counting the facts each producer contributed and, per type, where the two sources
agreed, disagreed, or saw a site the other did not. Every other command reads the merged
file as it reads any other — a fact is a fact whoever wrote it; the tag says who.

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
`IConsumer<T>` and `Publish`/`PublishAsync`, StackExchange.Redis channel publishes, and
message contracts declared under `Messaging/Messages`, `Messaging/Events`, `Messaging/Jobs`
or `Messaging/Contracts`, named `…Message`, or marked with a MassTransit message interface. A
codebase built on its own worker-queue framework registers processors, binds queues and
publishes through methods flowtrace cannot know about, and may keep its contracts elsewhere
under other names. `workerPatterns` teaches the extractor those shapes, and teaches the walk
which verb enters a consumer. Every field is an array of regex-source strings (JSON-escaped)
— `consumerEntryMethods` holds plain method names — and every field defaults to empty.

```json
"workerPatterns": {
  "registrations": ["\\.RegisterJobHandler\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "topologyBindings": ["\\bBindJobQueue\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "queuePrefixConstants": ["JOB_QUEUE_PREFIX"],
  "publishCalls": ["Enqueue"],
  "consumerBases": ["JobConsumerBase"],
  "consumerEntryMethods": ["Execute"],
  "broadcastCalls": ["BroadcastToChannel"],
  "configReads": ["ReadSetting"],
  "messagePaths": ["Bus/Types"],
  "messageSuffixes": ["Notice"]
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
  alongside the built-in `Publish` and `SubmitJob`. Whatever the verb, the message is read
  from the generic argument, the inline `new`, the saga `ctx.Init<T>(…)` initialiser, or the
  declared type of a variable passed as the first argument.
- `consumerBases` — extra consumer base-type names, matched alongside the built-in
  `BaseConsumer` and `IConsumer`.
- `consumerEntryMethods` — extra method names `trace` enters a consumer through; plain
  names, not regexes. The walk first picks every method whose parameter type hands it the
  consumed message — the message itself, or the message inside a `…Context<T>` or
  `Batch<T>` wrapper, nested either way (`ConsumeContext<T>`, `JobContext<T>`, `Batch<T>`,
  `ConsumeContext<Batch<T>>`); only when no parameter identifies one does it fall back to
  the built-in `Consume`, `Process`, `ProcessAsync` and `Run` plus these names. A consumer
  whose declared methods match neither way is marked `unresolved` rather than entered
  through a guess.
- `broadcastCalls` — extra channel-publish method names, matched alongside the built-in
  `PublishAsync` when the argument is a `Channels.X` member.
- `configReads` — helper methods whose single string argument is a configuration key
  (`_url = config.ReadSetting("Gateway")`); this is what lets the outbound-HTTP pass tie
  an interpolated URL back to a configuration key. Without it that pass is inert.
- `messagePaths` — extra repository-relative folders whose classes and records are message
  contracts (`message_class` facts), matched alongside the built-in `Messaging/Messages`,
  `Messaging/Events`, `Messaging/Jobs` and `Messaging/Contracts`. Each entry is anchored
  between path separators, so `Bus/Types` matches `src/Bus/Types/Tick.cs` and nothing under
  `Bus/TypesLegacy/`.
- `messageSuffixes` — extra class-name suffixes that mark a message contract wherever the
  class lives, matched alongside the built-in `Message`. `Event` and `Job` are deliberately
  not built in, since both are common outside messaging; a codebase that names its contracts
  that way lists them here. A contract carries the same `fqn` onto every `publish` and
  `consume` of it, which is what lets `join` tell two same-named messages apart across
  repositories and keeps them out of `messages_without_contract`.

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
| `importAliases.caseId` | string | module that exports the reporter the case-id placeholder calls; unset by default |
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
| `poll.timeoutMs` | number | whole wait, in milliseconds, of a generated read-back poll; a positive integer |
| `poll.intervalsMs` | number[] | delays, in milliseconds, between successive poll attempts; a non-empty list of positive integers |
| `worker.module` | string | module that exports the worker-publish client |
| `worker.client` | string | worker-publish client class |
| `worker.method` | string | client method that publishes the message |
| `worker.builder` | string | helper that builds the message payload |
| `clientClassTemplate` | string | feature-client class template; `{Feature}` is replaced by the feature name |
| `unresolvedRejectStatus` | number[] | accepted status choices when a rejection status is unresolved |
| `okStatus` | number | expected status for a successful request or read-back |

`caseIdPlaceholder` is the statement every generated test carries where a case id must be
supplied. The built-in one is a Playwright annotation and needs nothing imported. A
placeholder that calls a reporter instead — `tms.id('TODO')`, say — needs that reporter
imported, or the generated spec does not compile: set `importAliases.caseId` to the module
that exports it, and every generated spec then opens with an import of the placeholder's
leading identifier from that module. The two are read together; the alias alone emits
nothing, and a reporter-calling placeholder without the alias leaves the import for you to add.

`poll` bounds the read-back a generated test performs after a write that lands
asynchronously — a worker-processed message, a sink-fed effect — and is emitted into the
spec as `POLL_TIMEOUT_MS` and `POLL_INTERVALS_MS`. Either entry may be set on its own.

See `flowtrace.config.example.json` for every key with the built-in values filled in;
`importAliases.caseId` is the one key it leaves out, because its built-in value is unset.

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
