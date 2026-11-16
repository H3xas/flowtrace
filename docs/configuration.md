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
| `caseId` | no | callees whose first argument is a test-management case id, below |
| `testEnvironment` | no | the environment values a skip guard in a Playwright spec is read against, below |
| `backend` | no | the calls that mock or patch the backend of a browser test, below |
| `email` | no | the test calls that read an email and the backend members that name one, below |
| `workerPatterns` | no | a worker-queue framework's own extraction patterns, below |
| `entryPoints` | no | the base classes whose methods start backend work with no route in front of them, below |
| `scout` | no | `{ "bin": "<path or command>" }` — the code index used for graph hops |
| `scaffold` | no | the target harness's conventions, used by `scaffold` |
| `scope` | no | the node-ref patterns `scope` reads as a server-side authorization point, below |

## `repos[]`

| key | required | meaning |
|---|---|---|
| `id` | yes | unique short name; names the fact file and `--repo` |
| `kind` | yes | `backend` · `mobile` · `contracts` · `playwright` · `web` · `email-templates` |
| `root` | yes | path to the checkout |
| `exclude` | no | glob patterns skipped during the walk |
| `role` | no | `["api"]` · `["worker"]` · `["contracts"]` — what this repository *is*, when one kind serves two purposes |
| `scout` | no | `true` to allow code-index hops into this repository |
| `titles` | no | `true` on a `playwright` repository to collect the titles its tests produce, through Playwright's own list mode; see [Playwright titles](#playwright-titles) |
| `exceptionStatuses` | no | `backend` only: the status a thrown exception type answers when nothing in the code maps it; see [Exception statuses](#exception-statuses) |
| `factsProvider` | no | an external fact document for this repository — a file, or a command that prints one — and how it merges with the extraction; see [External fact provider](#external-fact-provider) |
| `srcSubpath` | no | `web` only: source subdirectory to walk (default `src`) |
| `cypressSubpath` | no | `web` only: sibling Cypress suite, relative to `root` |
| `mounts` | no | `web` only: the browser path a routed component is mounted at when its host is outside this repository; see [Web page mounts and assumptions](#web-page-mounts-and-assumptions) |
| `routeAssumptions` | no | `web` only: the value of a condition a `<Route>` sits under; see [Web page mounts and assumptions](#web-page-mounts-and-assumptions) |
| `featureRoots` | no | `mobile` only: source roots to walk instead of the single default |
| `cypress` | no | `mobile` only: allowlisted Cypress discovery roots, below |
| `templates` | yes for `email-templates` | `email-templates` only: the template files and the selectors of their id and subject; see [Email templates](#email-templates) |

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
- **`email-templates`** — a repository of JSON email templates. One `email_template` fact for
  each file that `templates.files` matches.

### Exception statuses

An application can convert an exception to a status in middleware or in a base class that
the backend extractor does not read. Then a thrown type reads as an unhandled `500` fault.
`exceptionStatuses` on a `backend` repository gives the status for each such type:

```json
{ "id": "api", "kind": "backend", "root": "../api",
  "exceptionStatuses": { "TicketBadRequestException": 400, "SeatUnauthorizedException": 401 } }
```

Each key is a simple type name, with no namespace and no type arguments. Each value is an
integer from 400 to 599. Any other shape refuses the configuration with one message that
names the repository: `config <file>: repos[<i>] (<id>): exceptionStatuses must map a simple
exception type name to an integer status from 400 to 599 on a backend repository`. The key
on a repository that is not `backend` gives the same refusal.

A thrown type reads its status in this order:

1. a `catch` of the type in the action that the walk reached the throw from;
2. a registered global exception filter that maps the type;
3. the `exceptionStatuses` table of the repository that throws it.

A table never overrides the first two, and the table of one repository never applies to a
throw in another repository. A throw below the primary depth that maps to a `4xx` status is
its own outcome, as a primary reject is. A throw that maps to a `5xx` status, or to nothing,
stays a demoted fault. The tree and `trace` keep the label `throw X (500)`, and `span` and
the HTML tree show the mapped status beside it.

### Web page mounts and assumptions

`trace <browser path>` composes a page's path from the `<Route>` declarations the web
extractor records. The outermost routed component is anchored by source when a root render
(`createRoot(…).render(…)`, `ReactDOM.render`) or a router `basename` says where it lives.
A library whose routes are mounted by a host application in another repository states
neither; its routes are then read from `/` and, when the library's own `navigate()` literals
agree on a first segment, behind that prefix too — both answers are tagged `inferred mount`.
`mounts` replaces those guesses with the path the host really uses:

```json
{
  "id": "partners-ui",
  "kind": "web",
  "root": "partners-ui",
  "mounts": { "PartnerRoutes": "/portal" },
  "routeAssumptions": { "features.pruningPlanner": true }
}
```

Each key of `mounts` names the component that owns the `<Routes>`; the value is a browser
path starting with `/`. A configured mount is reported as `configuration` in the answer's
mount chain, and a start below that component that uses a different prefix no longer
resolves. A URL that ends in a path declared below an unmounted component, behind a prefix
nothing declares, fails with `missing-mount` and names the component to list here.

A `<Route>` written inside a condition (`{cond ? <Route …/> : <Route …/>}`, `{cond && <Route …/>}`)
carries that condition as a guard. Two routes on one path in the two arms of a condition are
alternatives, and a start that reaches them is ambiguous. `routeAssumptions` maps a
condition's source text — whitespace collapsed, as the candidates print it — to `true` or
`false`; the arm that disagrees is dropped and every value used appears under
`mount.assumptions` in the answer. A leading `!` is honoured; nothing else is evaluated.

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

Omitting the key is a silent no-op, not a default-on: a configuration without `"titles"` on
its `playwright` repository spawns nothing, writes no `pw_title` fact and carries no `titles`
field in the header, so a suite whose titles were never collected reads exactly like a suite
whose titles are all literal. If a copied or generated configuration loses these facts, this
key is the first thing to check.

How the two sides are joined: on `(spec file, declaration ordinal)`. Recent Playwright
versions report list-mode positions in *transformed* source, so a reported line names
nothing in the file the extractor read. A transform renumbers lines but does not reorder
declarations, so the listing's specs are collapsed to declaration sites — every spec
reported at one position is one site, which is how a parameterised declaration keeps all of
its instance titles — and the Nth site of a file is joined to the Nth declaration the
extractor found in it.

A spec file resolves either every declaration or none. Two guards must hold first. The two
sides must count the same number of declarations in the file. Each declaration whose title the
source states must find that title at its own site. If either guard fails, the whole file is
refused, because one missed declaration shifts every ordinal after it. Its titles then stay
`raw` and the header counts the file under `refused`. A missing title is visible, but a wrong
one would not be.

The title check reads the title argument in the spec file:

- A string literal, or a template with no `${`, must be the runner title exactly. Its escapes
  are read first, so `'it\'s open'` is held to `it's open`.
- A template with literal parts must match those parts in their order, with any text in the
  place of each `${…}`. So `` `refunds a ${kind} now` `` passes `refunds a sale now`.
- A title inside a configured case-id wrapper is held to containment: see [`caseId`](#caseid).
- An identifier, a member path, a call, a template with no literal part and each other computed
  title rest on their ordinal.

The check reads the whole argument, so a title longer than the 160 characters of
`pw_test.test` is compared in full.

What it needs: `@playwright/test` installed where a `require` from the configured repository
root finds it, and Node to run it. Node looks in `node_modules` under the root first, then in
`node_modules` of each parent directory, so a suite's own copy comes before a hoisted workspace
copy. Nothing is fetched, nothing is installed, and no browser is started. The command runs with the repository as its working
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
success the header carries `"titles": { "status": "ok", "facts": N, "refused": M }`, where
`M` counts the spec files the guards above refused. Without the option the header has no
`titles` field and nothing is spawned.

### Email templates

An `email-templates` repository has a `templates` object. `files` is a non-empty array of
globs, relative to `root`, and only `.json` files are read. `id` and `subject` are selectors.

```json
{ "id": "mail", "kind": "email-templates", "root": "shop-mail",
  "templates": {
    "files": ["templates/**/*.json"],
    "id": "meta.template.code",
    "subject": "channels[kind=email].sections[role=subject].text"
  } }
```

A selector is dotted keys. A key can carry a `[field=value]` filter. The filter picks the one
element of an array whose `field` holds `value`. A selector that matches no element or two, or
a value that is not a string, gives a null value and a reason
([fact-schema.md](fact-schema.md#test-evidence)). The loader refuses, with one message that
names `templates`, a value that is not of this shape. A `templates` key on another kind is
refused.

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
a per-type comparison of the two sources computed before the merge discarded anything, and a
digest of the provider's facts. Everything but `source` identifies the fact set in a snapshot
and an edge export, so the same facts read from a different checkout path keep their identity.
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

- `calls` — callee names whose call sites carry case ids. Ids resolved either way join the
  test's `case_id` fact ([fact-schema.md](fact-schema.md)).

A configured callee is read in two places. In both, its first argument is the case id, and
later arguments are not read for an id:

- In a test body, `tms.id(9001)` and `tms.id(9001, 'note')` both give the id `9001`.
- In title position, as a wrapper, `test(tms.id(9001, 'refunds a sale'), …)` gives the id
  `9001`, and the second argument, `refunds a sale`, is the title. A wrapper with one argument
  holds a title and no id. The same is true for `test.skip(`, `test.only(` and `test.fixme(`,
  and for a call written over several lines. The fact is on the line of the `test(` call.

The first argument resolves when it is a number, a quoted string, an array of those, or a row
property such as `row.id` of a same-file `for (const row of ROWS)` over an array of object
literals. An empty string, an empty array and `'TODO'` are placeholders and give no fact. The
title text and the arguments after the first are never read as an id.

Any other first argument goes to a bounded reader of the spec file. It reads a value written in
the same file: a `const` with an initializer, an object or array literal, a key such as
`ids['a|alpha']` or `` ids[`${g}|${row.name}`] ``, a ternary, `&&`, `||` and `===`. It also reads
the bindings of the `for…of` and `forEach` loops that enclose the call. Each loop instance that
the argument reads gives one `case_id` fact with `source: "evaluated"` and `instance`, the loop
bindings it read, such as `{ "g": false, "row.name": "alpha" }`. The facts are in loop order,
outer loop first. A site gives 64 instances at most. A site past that limit gives one unresolved
record.

The reader does not read a function parameter, a call result, `process.env`, a `let` or `var`
binding, or an imported value. Such an argument, and a key that is absent from its map, gives
one unresolved record. That is a `case_id` fact with `ids: []`, `source: "unresolved"` and
`expression`, the argument text on one line, cut at 160 characters. A loop instance that
resolves no id also carries its `instance`. So each id in a fact is written in its own spec file.

Title collection ([Playwright titles](#playwright-titles)) holds a wrapped title to
containment. The wrapper's second argument is the title argument. Each title that the runner
reports at the declaration's site must contain a string-literal title argument, or match the
literal parts of a template one. So `refunds a sale (Case 9001)` and `[9001] refunds a sale`
both pass `tms.id(9001, 'refunds a sale')`, and any other title refuses the spec file. A title
argument of another shape rests on its position. Containment has a limit: a misaligned file in
which each shifted wrapped title occurs inside the runner title that it meets resolves with the
titles of those sites. Without the entry, the wrapper is opaque and the declaration rests on its
position in the file alone.

A configured name is matched only as a whole callee. `x.tms.id(9001)` is a call of a member of
`x`, not of `tms.id`, so it gives no id.

## `testEnvironment`

The playwright extractor writes `eligibility` on each `pw_test` fact: whether the spec file says
that the test runs ([fact-schema.md](fact-schema.md#test-evidence)). A skip guard such as
`test.skip(process.env.E2E_ENV !== 'dev', 'dev only')` depends on the environment of the run.
`testEnvironment` names those values. It defaults to none.

```json
"testEnvironment": {
  "E2E_ENV": "dev"
}
```

Each value is a string. The extractor reads `process.env.NAME` from this object and never from
the shell that runs `flowtrace`. A guard that reads a name the object does not hold, or any
other value it cannot read, is `unknown`, and a test under an `unknown` guard is never counted as
one that runs. Without the key, every guard that reads `process.env` is `unknown`.

## `backend`

The playwright extractor writes one `pw_backend` fact for each test. The fact says whether
the test runs on a real backend, on patched responses or on a mocked backend
([fact-schema.md](fact-schema.md#test-evidence)). It reads `.route(` handlers, `routeFromHAR(`
calls and the helpers of the repository by itself. A suite can also mock its backend through
a call that it cannot read, such as a fixture package outside the repository. `backend` names
those calls. Both lists default to none, so no call name is built in.

```json
"backend": {
  "mockCalls": ["mockAllEndpoints"],
  "patchCalls": ["seedCart", "fixtures.priceList"]
}
```

- `mockCalls`: calls that replace every endpoint the test reaches. A test that reaches one of
  them is `mocked`.
- `patchCalls`: calls that answer some requests and let the others through. A test that
  reaches one of them is `patched`, unless a mock call also reaches it.

An entry is a callee as written: an identifier, or a dotted chain of identifiers. A bare entry
matches a bare call and a member call (`seedCart` matches `seedCart(page)` and
`fixtures.seedCart(page)`). A dotted entry matches only that callee as written, after the
extractor removes white space and changes each `?.` to `.`. So `fixtures.priceList` matches
`fixtures.priceList(page)`, `fixtures?.priceList(page)` and `fixtures . priceList(page)`. It
does not match `catalog.priceList(page)`, `other.fixtures.priceList(page)` or
`this.fixtures.priceList(page)`. To match the last one, write the entry
`this.fixtures.priceList`. The extractor does not read the body of a function with a
configured name, because the entry decides the call. A name in a comment or in a string
never matches.

A configured call also counts when a Playwright fixture that the test uses makes it, before
the fixture calls `use(`. A call under `if (<option>)` in a fixture counts only when the
option value that `test.use` or the option default gives makes the branch run
([fact-schema.md](fact-schema.md#test-evidence)).

The loader refuses, with one message that names `backend`, a value that is not an object, a
key other than `mockCalls` and `patchCalls`, a list that is not an array of call names, and a
name in both lists. A repeated name in one list counts once.

The Cypress readers use the same lists. A name matches the command `cy.<name>(`, and the class
goes into a `cypress_backend` fact for each Cypress test.

## `email`

`email` names the test calls that read an email and the backend members that name one. Without
the key, no extractor gives an email fact.

```json
"email": {
  "reads": [{ "call": "readMail", "subject": "0.subject" }],
  "senders": [{ "member": "EmailCode" }]
}
```

- `reads`: each entry has a `call` and the position of its subject. A `call` is a callee as
  written, as in `backend`. A Cypress test reads with the command `cy.<call>(`. `subject` is an
  argument index, or `"<index>.<key>"` for a key of an object argument. Each test that reaches
  the call gives one `email_read` fact.
- `senders`: each entry names a class `member`. A backend repository gives one `email_sender`
  fact for each class that defines the member as a string.

`cover` links each email read to one template by its subject and to one sender by the template
id ([cli.md](cli.md)). The loader refuses, with one message that names `email`, a value that is
not an object, an unknown key, and an entry that is not of this shape.

## `workerPatterns`

The backend extractor recognises public messaging idioms out of the box — MassTransit's
`IConsumer<T>` and `Publish`/`PublishAsync`/`SubmitJob`/`Reply`, StackExchange.Redis channel
publishes, `IAmInitiatedBy<T>` sagas, and message contracts declared under
`Messaging/Messages`, `Messaging/Events`, `Messaging/Jobs` or `Messaging/Contracts`, named
`…Message`, or marked with a MassTransit message interface. A codebase built on its own
worker-queue framework registers processors, binds queues and publishes through methods
flowtrace cannot know about, names its saga-initiator interface differently, and may keep its
contracts elsewhere under other names. `workerPatterns` teaches the extractor those shapes,
and teaches the walk which verb enters a consumer. Every field is an array of regex-source
strings (JSON-escaped) — `consumerEntryMethods` and `backgroundCalls` hold plain method names, and a
`publishCalls` entry may carry a `/N` suffix (see below) — and every field defaults to empty.

```json
"workerPatterns": {
  "registrations": ["\\.RegisterJobHandler\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "topologyBindings": ["\\bBindJobQueue\\s*<\\s*(\\w+)\\s*>\\s*\\(\\s*JobKind\\.(\\w+)"],
  "queuePrefixConstants": ["JOB_QUEUE_PREFIX"],
  "publishCalls": ["Enqueue", "Defer/2"],
  "consumerBases": ["JobConsumerBase"],
  "consumerEntryMethods": ["Execute"],
  "broadcastCalls": ["BroadcastToChannel"],
  "configReads": ["ReadSetting"],
  "messagePaths": ["Bus/Types"],
  "messageSuffixes": ["Notice"],
  "sagaInterfaces": ["IAmTriggeredBy"],
  "backgroundCalls": ["Schedule"]
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
  alongside the built-in `Publish`, `SubmitJob` and `Reply`. Whatever the verb, the message is
  read from the generic argument, the inline `new`, the saga `ctx.Init<T>(…)` initialiser, or
  the declared type of a variable passed as the first argument — unless the entry names a
  later argument position after a slash (`Defer/2`, 1-based; a bare name keeps meaning
  position 1), in which case only the two shapes that make sense at an arbitrary position
  apply: an inline `new` there, or the declared type of a variable there, read by the same
  rule a first-argument variable already is. An index the call does not have that many
  arguments to reach emits nothing rather than guessing. Every `publish` fact carries `verb`,
  the matched call name lower-cased, whichever spelling or position produced it.
- `consumerBases` — extra consumer base-type names, matched alongside the built-in
  `BaseConsumer` and `IConsumer`.
- `sagaInterfaces` — extra saga-interface names, matched alongside the built-in
  `IAmInitiatedBy`. A base-list entry naming one, `IAmTriggeredBy<OrderPlaced>` say, emits a
  `saga` fact for the class ([fact-schema.md](fact-schema.md#backend)) in addition to
  whatever `consume` facts its own `consumerBases` entries already produce — this field never
  changes what counts as a consumer, only what counts as a saga.
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
- `backgroundCalls` — method names whose call hands its delegate argument to a background
  queue; plain names, not regexes. The extractor already finds a queue by its shape: a
  receiver type that declares a method whose delegate parameter takes a `CancellationToken`.
  This field names the queue calls whose receiver the repository does not declare. Each call
  gives a `queue_call` fact with `rule: "config"`, and the walk shows one queue node with the
  delegate's calls under it (via `queued`).

## `entryPoints`

A backend method can start work with no route in front of it. The extractor finds two such
entries by itself: each public method of a SignalR `Hub` class, and each message handler that
an actor class registers. `entryPoints` names more of them. Each entry is an object with
three fields:

```json
"entryPoints": [
  { "kind": "timer", "bases": ["TimedJob"], "methods": ["Tick"] }
]
```

- `kind` — a lowercase name of letters, digits and hyphens. It cannot be `route`, `hub` or
  `actor`.
- `bases` — base class names. A class that has one of them in its base chain is an entry
  class. An abstract class is not.
- `methods` — method names. Each method of that name that the class declares or inherits
  gives one `entry` fact with that `kind`.

`routes-of` walks each entry the same way it walks a route, and it lists the entries that
reach the point. A malformed `entryPoints` value stops the run with one message that states
the full shape.

## `scope`

The area's server-side authorization point, for the `scope` verb: the first node on a
route's own walk whose ref matches one of these regexes.

```json
"scope": {
  "gatePatterns": ["Authorize", "Permission", "Policy", "Entitlement", "Claims"]
}
```

- `gatePatterns` — whole regexes (JSON-escaped) matched against a walked node's `ref`
  (a method's `Class.Method`, an injected interface or class name, a database or message
  ref). Defaults to the five shown above when the key is omitted. This is a naming
  heuristic, not a guarantee: a check named something else is invisible to it, and a name
  that merely contains one of these words is reported as a gate whether or not anything
  actually enforces it.

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

## `split`

```json
"split": { "ticketPrefix": "#0000" }
```

Optional. `ticketPrefix` is written in front of every commit subject `split` drafts, separated
by one space (`#0000 feat(orders): add orders client`), and the emitted script's header then
says to replace it with the real id. Use whatever token your tracker convention puts first —
an issue reference as above, or a project key with a placeholder number. With no `split`
object, or no `ticketPrefix`, a drafted subject is a plain Conventional Commit
(`feat(orders): add orders client`) and nothing has to be replaced; that is the default. The
value must be a non-empty string without whitespace.

## Worked example

`examples/demo-shop/flowtrace.config.json` produces a non-trivial trace and every edge kind
the edge export carries across repositories: two backends, a web client with a Cypress suite
and a Playwright suite.

```json
{
  "out": "out",
  "workerPatterns": { "consumerBases": ["IJobConsumer"] },
  "repos": [
    { "id": "api", "kind": "backend", "root": "backend", "role": ["api"] },
    { "id": "e2e", "kind": "playwright", "root": "e2e", "titles": true },
    { "id": "shopfront", "kind": "web", "root": "shopfront", "cypressSubpath": "cypress" },
    { "id": "stock", "kind": "backend", "root": "stock" }
  ]
}
```
