# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## [Unreleased]

Extraction:

- A `playwright` repository writes one `pw_backend` fact for each `pw_test`. Its class is
  `real`, `patched` or `mocked`. If the reader cannot tell, the class is `unknown` with a
  `reason`.
  The fact lists the call sites that decided the class. The reader follows the test body and
  the hooks of the file and of each enclosing `test.describe` block. It also follows the
  helpers that those regions call, in the same file and across the repository. Comments and
  string contents never count.
- The new top-level `backend` configuration key names the calls that mock (`mockCalls`) or
  patch (`patchCalls`) a backend, for a suite whose mock lives outside the repository. No call
  name is built in. A malformed value is refused with one message that names `backend`.
- `pw_stub` gains `handler`: what its route handler does (`fulfill`, `fetch-fulfill`,
  `abort`, `spy` or `unresolved`). The set of `pw_stub` facts and the `cover` output do not
  change.

Pipeline, sentinel and filter outcomes:

- `trace --seeds`, `span` and `cover` list each refusal of a backend pipeline step as its own
  fault outcome, with its status and file:line. A refusal is a stop-flag write, a `false` or
  `null` return, a throw or a status return in the step's own method.
- The walk reads the step order from the source. It reads registration calls in a DI factory,
  a literal `typeof(...)` list and an injected `IEnumerable<T>` with its `Add*<T, X>()`
  registrations. It walks a resolved list in that order, with no fan-out cap.
- A resolved step runs one level below its pipeline method, as before. Only its refusals count
  at the depth of the pipeline method. Its other branches, helpers and callees keep their
  depth.
- A `return false` or `return null` inside an `if`, which reaches the action unchanged, is an
  outcome. Its status comes from the action's `?:` conditional or `if` on the value. If the
  walk cannot read that form, the outcome stays in the list with
  `statusReason: "status-unmapped"` and no status.
- An authorization or action filter with a source body adds one outcome for each
  `context.Result` it assigns. This applies to a filter registered globally and to a filter
  set as an attribute on the action, its controller or a base controller. An action that
  carries an attribute that the filter's early return names gets no outcome from that
  filter. An exception filter is never read as a refusal.
- Seeds of a globally registered filter carry `gate.shared: true`. They count in the route's
  seeds, so the `span` ledger and the `cover` seed set stay equal. The `cover` totals and
  headline also give their count as `shared-gate`. A toggle in a shared gate decides only
  that gate's outcomes.
- If the walk cannot read the step list, its order, the stop rule or a step overload, the
  pipeline is `unresolved` with a reason. `trace`, `span` and `cover` show the reason, and the
  `cover` totals count these pipelines. An unresolved pipeline adds no step outcome, and its
  tree keeps the name-sorted fan-out.
- Extraction writes ten new fact types: `step_composition`, `loop_stop`, `flag_write`,
  `sentinel_return`, `return_flow`, `sentinel_map`, `auth_filter`, `filter_result`,
  `filter_use` and `class_base`. `docs/fact-schema.md` describes them.
- Compatibility: every existing seed key stays, so stored verdicts, packets and snapshots
  still match. A new outcome is a new key. Every new JSON field is absent where it does not
  apply. A fact set written before this release holds none of the new facts. With it, the
  walk gives the earlier tree, and each pipeline loop shows `composition-not-extracted`. Run
  `extract` again for the new outcomes, then write the `check` baseline again.

Worked example:

- `examples/demo-shop/e2e/ui/storefront.pw.ts` adds a UI spec with a hook that patches the
  catalog response and a block on the live catalog.
- Three routes gain one sentinel outcome each: `POST orders/v1/checkout` (403),
  `POST orders/v1/replay` (404) and `POST stock/v1/reservations` (409). The pinned edge export
  is written again for the new fact types.
- The checkout entries 03, 05 and 06 of the calibration golden set hold the fresh checkout
  packet, which has four seeds. Their verdicts, expected outcomes and notes name the new 403
  seed. The stale hash of entry 05 is again the hash of the swapped enumeration.
- The golden packet `calibration/01-status-only.packet.json` is again the packet that
  `cover --area checkout --packets` writes for `GET catalog/v1/products`. It now holds the
  route patch of the storefront spec as a third candidate, and its note says why that patch
  promotes no seed. The packet hash, the seeds and the verdict do not change. The
  `worked-example` stage of `npm run verify` now writes the checkout packets into
  `examples/demo-shop/out/checkout-packets/` and compares each golden packet byte for byte with
  the written packet of its route. A golden packet that differs, a route with no packet on one
  side, or a packet that cannot be read or paired fails the stage.

Component span:

- `span --from-component` accepts a mobile (Ionic) component, page or service and writes the
  same page and `--json` model as for a web one. A mobile name no longer exits `2` with a
  refusal. A start in a repository that is neither web nor mobile still exits `2`, and its
  message names both kinds.
- On a mobile start, each template event binding of kind `call` is an `event` entry, and each
  Angular or Ionic lifecycle hook the class itself declares is a `mount`, `update` or
  `unmount` entry. Each entry keeps its own arms, so two handlers that call two methods of one
  injected service no longer fold into one.
- A request that no entry reaches prints once as an arm without entry. A request that an entry
  reaches is not counted again there. A method, service or component node that the depth or
  node budget cut prints as a `walk-limit` arm.
- Known gap: a gateway call written over more than one line states no fact, so a handler that
  reaches only such a call shows as an entry that reaches no route.
- `trace` and `--from-handler` output on a mobile start, and web `span --from-component`
  output, do not change.

## 0.4.1

The first 0.4 release. The `v0.4.0` tag was created in error on the 0.3.0 tree and was never
published to npm.

Provenance:

- A fact set's identity in a snapshot and an edge export now carries its facts provider:
  producer, version, merge mode, counts, comparison and a digest of the provider's own facts.
  Two exports over the same extraction, one with a provider and one without, no longer share
  a `provenance.id`, and neither do two provider documents that compare to the extraction with
  equal counts under `regex-only-with-diff`. The provider's file or command is never part of
  the identity, so the same facts keep their id wherever the checkout sits, and no filesystem
  path reaches a snapshot or an export. The facts header's `provider` block gains `digest`.
- A fact set with no revision witness states `"headSha": null` in its identity instead of
  omitting the field.
- `join --snapshot` writes `schemaVersion` 2. A schemaVersion 1 snapshot is refused by
  `join --against` (exit 4) with an instruction to retake it.
- `join --export-edges` adds `provenance.factSetsWithoutEdges`, the fact sets no record names,
  so a fact set in the envelope never reads as a witness for edges it did not produce. The
  record shape and `schemaVersion` 1 are unchanged.

Worked example:

- `examples/demo-shop` gains a second backend (`stock`) and a web client with a Cypress suite
  (`shopfront`), so the pinned edge export carries `calls`, `tests`, `publishes` and
  `consumes`, including a message published in one backend and consumed in the other.
- `scripts/check-pinned-export.mjs` no longer strips provenance to compare. The id is
  re-derived, every record's `provenance` must equal it, each regenerated fact set's `headSha`
  must be the checkout's HEAD, `dirty` and `dirtyDigest` must agree, and `fileCount` is
  compared. The CI workflow and the exports README name the two checks for what they are:
  canonical structural and provenance equality against the pinned copy, and literal byte
  equality of two exports within one checkout.

Extraction:

- Playwright declaration counting no longer mistakes two other constructs for a test. A
  `test.skip(condition, reason)` guard written inside a test body was counted as a declaration
  and its condition stored as the title, and a `test` reached through a member access — a
  regular expression's `.test(...)`, a matcher object's — was counted as well. A declaration is
  now recognised by ending in the function that holds its body, and a member `test` is not
  Playwright's. `pw_test` counts go **down** in suites that use either shape, and the withdrawn
  facts are the ones whose titles were fragments of unrelated expressions.
- A Playwright title written as a configured `caseId.calls` wrapper resolves instead of refusing
  its spec file. The title the runner reports sits inside the wrapper, so it is compared against
  the unwrapped string; a wrapper that is not configured, a template, and a title supplied as an
  identifier by a table all resolve on their position in the file, as templates already did.
  Suites that wrap every title kept almost no titles before this. A title is read as text, so a
  title whose text reads as a single identifier, a dotted path or a call — `checkout`,
  `cart.badge`, `retries (twice)` — is treated as dynamic and resolves on its position in the
  file rather than being compared verbatim, even when the source wrote it as a quoted string.
- A C# file containing a bare carriage return is no longer mis-numbered. `lineAt` and
  `computeLineStartIndices` counted lines by `\n` alone while several other passes split on
  any terminator, so from the first stray `\r` onward the two disagreed by the number of
  stray `\r`s seen; the masking pass then gated line text against the drifted offset and
  blanked whole lines, dropping `branch_point` facts for live `if`/`else` statements. All
  three readers now treat CR, LF and CRLF alike. Fact counts in such files go up. Files with
  no bare `\r` are byte-identical.
- A Playwright title is joined to its declaration by the declaration's ordinal within its spec
  file rather than by a reported line number, so a suite whose runner reports transformed-source
  positions resolves its titles onto the declarations that produced them. A spec file whose two
  sides cannot be shown to line up resolves nothing rather than guessing, which renders as `raw`
  and is counted in the fact-set header.

## 0.3.0

Gates:

- `join --against` no longer passes a comparison it never ran: under `--fail-on`, a non-empty
  `skipped` set exits `5`, because a boundary that was never compared is not evidence that the
  boundary is unchanged. `--allow-skipped` restores the plain exit-by-finding behaviour for a
  caller that wants it, and is refused on any other verb.
- `join --export-edges` refuses the whole export when an edge's code end is missing its repo,
  file or line, and leaves any previously written file untouched — a partial edge set read by a
  code index is worse than no edge set.
- The worked example now pins a public `flowtrace-edges` export, so a change to the export shape
  is caught by the example's own check rather than by a consumer.

Index adapter:

- Every edge kind the graph declares is read, instead of a frozen three. A graph that gains a
  kind is no longer silently narrowed on the way in.
- The dotnet test filter answers for itself which inbound kinds are strong enough to select a
  test class: a shared base type, a shared member type, a member call, constructor injection, an
  implemented interface and an overridden method each mean the referencing class is compiled
  against the changed shape. A bare namespace import stays visible in the counts but never
  selects a class on its own.

Repository:

- CI guards comment hygiene on every run and requires a signed-off commit.

## 0.2.0

Dual-licensed MIT OR Apache-2.0.

New verbs:

- `scope --area <file|name>` — the area's whole route universe before an edit: one line per
  route, an `automation: yes|no` flag from `cover`'s executing-evidence state, and the
  authorization point the route's walk passes through, named by `scope.gatePatterns`.
- `routes-of <file:line | symbol | literal>` — the reverse of `trace`: every entry route whose
  complete fact-only walk passes through one point, with one shortest witness per route.
- `split` — a branch diff becomes ordered, capped commit slices, one concern each, every slice
  checked on its own with `affected` and the touched area's own compiler, written out as an inert
  shell script outside every configured repository.
- `check --area <file|name>` — fail a build when an area's `cover` seed totals or per-route parity
  drop against a baseline committed beside the area file. `--write-baseline` is the only producer,
  and stale facts exit `4` rather than passing.
- `calibrate --golden <dir> --verdicts <dir>` — pin a reader's verdicts against a golden set,
  merged through the path `cover --verdicts` uses. A golden set built from the worked example
  ships with the package.
- `join --snapshot <file>` and `join --against <file>` — write a verifiable snapshot of the joined
  boundary and compare a later join to it: routes, paths, seeds, effects and evidence levels, with
  `--fail-on` to gate on a family or a kind.
- `join --export-edges <file>` — the joined cross-repo edges in one versioned, provenance-tagged
  file a code index can import, byte-identical over unchanged facts.

Extraction:

- Message consumers are read off the parsed class declaration, so a C# 12 primary constructor, a
  consumer base anywhere in the base list and several `IConsumer<T>` interfaces on one class all
  emit their `consume` facts.
- A class or record under `Messaging/Messages`, `Events`, `Jobs` or `Contracts` is a message
  contract with no suffix or marker interface; `workerPatterns.messagePaths` and `messageSuffixes`
  extend both rules.
- A publish whose argument is a variable resolves the message from that variable's declaration in
  the enclosing method; a site whose type cannot be read is still reported, with `unresolved`
  naming why, under `publish_unresolved`. `SubmitJob` and `Reply` are built-in publish verbs.
- A publish verb may take its message in a later argument: a `workerPatterns.publishCalls` entry
  may name the position after a slash (`Defer/2`), so `bus.Defer(delay, msg)` is no longer
  invisible. Every `publish` fact now carries `verb`, the matched call name lower-cased.
- A class implementing a saga interface — `workerPatterns.sagaInterfaces`, defaulting to
  `IAmInitiatedBy` — emits a `saga` fact naming the messages that initiate it, the messages it
  handles and the property it correlates on. Its `consume` facts are unaffected.
- The publish, DI-binding and repository-index passes read the comment- and string-masked text, so
  an idiom written in a comment or a literal produces no fact. Line numbers are unchanged.
- A minimal-API route whose handler is an inline lambda is walked into the lambda: it becomes the
  route's action, its injected parameters are that action's fields, and its body owns the branches,
  calls and publishes. A method-group handler is walked as the method it names.

Walk:

- A consumer reached over a publish hop is entered through the method whose parameter carries the
  message it consumes, falling back to a verb list that now includes a job consumer's `Run`. A
  consumer that matches neither is marked `unresolved` rather than entered through a guess.

Facts:

- A repository may name one external fact provider — a file or a command. Its document is validated
  against the schema, every fact it supplies is stamped with its producer, and the two sources are
  merged or substituted under a mode the configuration states. `trace` marks a hop backed by an
  external fact; `render` counts facts per producer and the disagreements.
- Staleness distinguishes facts extracted at another commit from facts that only predate an
  uncommitted edit. `affected` still exits `4` for the first and now runs for the second, carrying
  the warnings and their kinds in `--json`; `check` refuses both, because a gate compares against a
  committed baseline.

Fixes:

- The configuration validator accepts the two `scaffold` fields the scaffold already read and
  defaulted, `poll` and `importAliases.caseId`, so a reporter-calling placeholder can compile.
- A `playwright` repository configured `"titles": true` has its own installed Playwright run in
  list mode during `extract`, appending one `pw_title` fact per resolved test declaration. Nothing
  is fetched or installed, and a collector that cannot run leaves extraction succeeding with the
  reason in the header. Run as the single-file executable, the collector refuses before it resolves
  or spawns anything, with a reason naming the distribution and the npm package that can.

Documentation: the README is an entry page, with the step-by-step tour in
`docs/getting-started.md`, an agent guide in `docs/agent-guide.md`, and `docs/cli.md` carrying
`flowtrace --help` verbatim and checked in CI for drift. `CONTRIBUTING.md` and `SECURITY.md` are
new, and the example configuration names its checkouts as siblings of the file.

## 0.1.1

Release pipeline only; the CLI is unchanged. The single-file build normalises line endings
before bundling, so the Windows executable builds from a CRLF checkout, and `.gitattributes`
pins sources to LF. The v0.1.0 release carries no Windows binary for this reason.

## 0.1.0

Initial public release: `extract`, `join`, `render`, `trace`, `span`, `surface`, `skeleton`,
`cover`, `affected`, `scaffold`, `cases` and `readiness` over ASP.NET Core, Ionic/Angular,
React + Redux, Playwright and Cypress checkouts, with the benchmark harness, sealed-truth
protocol and first published results under `docs/benchmarks/`.
