# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## [Unreleased]

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
