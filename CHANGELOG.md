# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## Unreleased

A `workerPatterns.publishCalls` entry may now name a later argument position after a slash
(`Defer/2`, 1-based; a bare name keeps meaning position 1), so a bus verb whose message is
not its first argument (`bus.Defer(TimeSpan.FromMinutes(5), due)`) is no longer invisible.
The message at that position is resolved by the same rules a first-argument variable already
is: an inline `new`, or the declared type of a variable there. An index the call does not
have that many arguments to reach emits nothing rather than guessing, and an invalid entry
(`Defer/0`, `Defer/x`, `Defer/2/3`) is refused by `validateConfig`. Every `publish` fact now
carries `verb`, the matched call name lower-cased (`PublishAsync` and `Publish` both read
`publish`); `Reply` joins the built-in `Publish` and `SubmitJob`.

A class implementing a saga interface — `workerPatterns.sagaInterfaces`, defaulting to
`IAmInitiatedBy` — now emits a `saga` fact naming the messages that initiate it
(`initiatedBy`), the messages it handles (`handles`, read off the same base-list entries
`consume` already reads), and the property a `ConfigureHowToFindSaga`/`CorrelateBy` lambda
correlates on (`correlation`, `null` when the class states none). The class's own `consume`
facts are entirely unaffected — this is an additional fact, not a replacement — so a reader
that ignores `saga` sees the walk unchanged. See
[fact-schema.md](docs/fact-schema.md#backend) and
[configuration.md](docs/configuration.md#workerpatterns).

License changed to MIT OR Apache-2.0.

New verb `routes-of <file:line | symbol | literal>`, the reverse of `trace`. It resolves a
repository-relative file and line, an exact method symbol or an exact allowlisted literal to
one fact, then reports every entry route whose complete fact-only forward walk passes through
it: one shortest `repo:file:line` witness per route, the count of further paths, and the
route's existing seeds and test evidence. Unresolved or ambiguous input exits `2` and lists
the candidates; a walk that reaches its node budget exits `4` and returns no partial set.
`--json` is deterministic and carries `schemaVersion: 1`. The pre-registered agentic round
for the verb is published under `docs/benchmarks/results/2026-08-routes-of.md`; both tool
cells failed harness integrity, so it establishes no advantage in either direction.

The backend extractor reads message consumers off the parsed class declaration instead of a
separate pattern, so a consumer written with a C# 12 primary constructor
(`class X(IStore store, ILogger<X> log) : IConsumer<T>`) emits its `consume` fact like any
other, attributes with parentheses inside the parameter list and generic loggers included. A
consumer base in any position of the base list qualifies, a class implementing several
`IConsumer<T>` interfaces consumes each message, a namespace-qualified base and a nested
`Batch<T>` resolve as before, and abstract classes stay silent. The worked example's
`OrderPlacedConsumer` now takes its repository and logger through a primary constructor, so
`trace` shows the consumer's own subtree beneath the bus hop.

Message contracts are recognised under `Messaging/Events`, `Messaging/Jobs` and
`Messaging/Contracts` as well as `Messaging/Messages`, and a brace-less positional record
(`record OrderShipped(string OrderId);`) counts like a class. Two `workerPatterns` fields extend
the rules for a codebase that keeps its contracts elsewhere: `messagePaths` adds folders and
`messageSuffixes` adds class-name suffixes beside the built-in `Message`. The worked example's
bus type is now the plain `OrderPlacedEvent` under `Messaging/Events`.

A publish call whose argument is a variable — `var job = new ReindexJob(…); await
bus.SubmitJob(job, ct)`, `Publish(completed, ct)` — resolves the message from the variable's
declaration in the enclosing method: a lambda parameter (through the collection a `Select` or
`ForEach` iterates), the nearest local, `foreach`, `out` or `is` declaration, or the method's
parameter. A site whose type cannot be read is still a `publish` fact, with `message: null` and
`unresolved` naming why, and `render` lists those sites under `publish_unresolved` rather than
counting them as publishes without a consumer; `trace` shows them as a leaf. `SubmitJob` is a
built-in publish verb, and the saga initialiser `PublishAsync(ctx => ctx.Init<T>(…))` resolves
`T`. The worked example's event consumer now submits a fulfilment job through a variable, and
a second consumer picks it up.

The backend extractor's publish pass, DI-binding pass and the repository-wide indexes of
message, processor and filter declarations now read the comment- and string-masked text the
other passes already use, so a documentation comment that spells `SubmitJob<T>` or a string
that quotes a `Publish(new …)` call produces no fact. Line numbers are unchanged: masking keeps
every offset. The passes that read a string literal — route templates, configuration keys, hub
method names, exchange and queue-prefix constants, and the configured worker-registration
patterns — keep the raw text and say so at the call.

A `playwright` repository can be configured `"titles": true`. `extract` then runs that
repository's own installed Playwright in list mode and appends one `pw_title` fact per test
declaration the listing resolved, so a parameterised title renders as the titles it produces
(`listed`) rather than as its expression (`raw`). Nothing is fetched or installed; the package
is resolved from the repository root, and a preload written under `out/` keeps a suite that
vendors a second copy of the package listable. When the collector cannot run, extraction still
succeeds: the reason goes to stderr and into the fact set's header as `titles`, and no
`pw_title` fact is written. List mode needs Node, which a checkout and the npm package run
under; the single-file executable embeds its runtime and cannot start it, so run that way the
collector refuses with a reason that names the distribution and the npm package that can,
before anything is resolved, written or spawned. Configuration reference: `titles` under
`repos[]`.

New verb `split`: a branch diff becomes ordered, capped commit slices, one concern per
slice — a feature package before the specs that consume it, config before the tests that
depend on it — each checked with the area's own project-scoped `tsc` and the `affected` spec
list for its files, with a Conventional Commit subject drafted from what the diff carries.
The output is a shell script written outside every configured repository; `split` runs no
mutating git command itself. A configured `split.ticketPrefix` goes in front of every drafted
subject; without one, subjects are plain Conventional Commits.

New verb `calibrate --golden <dir> --verdicts <dir>`: a reader's verdicts for a fixed golden
set are merged through the same path `cover --verdicts` uses and each golden packet is
reported as agreed or as the list of ways it disagreed — seed level, rejection reason,
upgrade and confirmation counts — so a reader whose judgment drifts fails a build before it
moves a coverage number. Exit `0` every packet agrees, `1` any disagreement, `2` usage; no
configuration file is read. A golden set built from the worked example's own packets ships
under `examples/demo-shop/calibration` with reference verdicts beside it, and CI checks the
set against those verdicts on every push.

The README is now an entry page and the
step-by-step tour moved to `docs/getting-started.md`, which takes a first-time reader — a person
or an AI agent — from install to a first answer about their own repositories, with the
expected output at every step. `docs/agent-guide.md` states how an agent sets the tool up, what
to paste into its instructions and how to relay the output without overstating it.
`docs/cli.md` carries `flowtrace --help` verbatim; `scripts/docs-check.mjs` regenerates it,
and CI fails when it drifts or when a relative link in any document does not resolve.
`docs/README.md` indexes the set; `CONTRIBUTING.md` and `SECURITY.md` are new. The example
configuration names its checkouts as siblings of the file (`shop-api`) rather than parents of
it (`../shop-api`), matching the worked example's layout.

The configuration validator now accepts the two `scaffold` fields the scaffold already read
and defaulted. `poll` — `timeoutMs`, a positive integer, and `intervalsMs`, a non-empty list
of positive integers — bounds the read-back a generated test polls for after an
asynchronous write. `importAliases.caseId` names the module a reporter-calling
`caseIdPlaceholder` imports its reporter from. Before, a configuration setting either field
did not load at all, and a placeholder that called a reporter produced a spec that could not
compile because its import was unreachable from configuration. With neither field set,
generated output is unchanged. Configuration reference: `poll` and `importAliases.caseId`
under `scaffold`.

A consumer reached over a publish hop is entered through the method that takes the
message it consumes — `Consume(ConsumeContext<T>)`, `Run(JobContext<T>)`, a `Batch<T>` or
the message itself — read off the parameter types the backend extractor now records on
every `method_span` as `paramTypes`. When no parameter names the message, the walk falls
back to a verb list that now includes the job consumer's `Run` beside `Consume`, `Process`
and `ProcessAsync`; `workerPatterns.consumerEntryMethods` adds a framework's own verbs. A
consumer whose declared methods match neither way is marked `unresolved` instead of being
entered through a guess. The worked example gains a job consumer behind the order-placed
message, so `trace OrderPlacedConsumer` walks through to the fulfilment handler's branch
and repository write.

A minimal-API route registered with an inline lambda is walked into the lambda. The
lambda is the route's own action, named `<registering method>(<VERBS> <template>)` under
the registering class: its parameters that the framework injects (any interface, or
`[FromServices]`) are the action's fields, scoped to it by `method` on the `ctor_field`
fact, with every call through them carrying `receiverType`; its body-bound parameters are
`param_source`s; and its body owns the branch, call, publish and sink facts that used to
land on the registering method. `return Results.NotFound()` and the other `Results.`/
`TypedResults.` shapes classify as error returns. A method-group handler
(`MapPost("/x", WidgetHandlers.Save)`) resolves to the class the qualifier names and gets
the same parameter treatment across files. The worked example gains `POST orders/v1/replay`
registered that way.

A repository can be configured with a `factsProvider`: a JSON fact document, or a command
whose stdout is one, written by a tool that holds a real syntax tree. `extract` validates
every fact it supplies against the schema, stamps each one `provenance: { producer, version }`,
and combines the two sources under a required `merge` mode — `prefer-external` replaces
the extractor's facts at every site (type, file, line) the provider states, `external-only`
replaces every fact type it states, `regex-only-with-diff` keeps the extractor's facts and
records the comparison only. The header records both producers and a per-type comparison;
an invalid record, a foreign repository id, a fact claiming its own provenance, or a command
that fails refuses the whole run and names the record. An extracted fact never carries
`provenance`, so the two are always told apart: `trace` prints `[provider]` on every hop
located at an externally stated fact (`--json` and `--graph` carry `provider: true`), and
`render` gains a *Fact producers* section counting facts per producer and the disagreements.
Configuration reference: `factsProvider` under `repos[]`; fact schema: `provenance` and the
`provider` header block.

`join --snapshot <file>` writes one portable, versioned bundle of the current fact sets, the
aliases and sink patterns the join and the walk read, and every repository identity the facts
carry — `schemaVersion: 1`, no timestamp, so two runs over unchanged facts write the same bytes.
`join --against <file>` compares such a snapshot with the current facts without touching a
repository and reports what changed on the joined boundary: a joined path added, removed or
reshaped and a call newly without a route; a seed added, removed or changed; an effect added or
removed; an evidence level gained or lost. Both sides are derived with one implementation and
the current configuration, identities are semantic (a moved line, a renamed spec or a reordered
declaration is not drift), and identical states print an explicit no-drift line. `--json` is
deterministic and carries `schemaVersion: 1`; `--fail-on <kinds>` turns a selected family or
kind into exit `1`, usage errors exit `2`, and an unreadable, incompatible or tampered snapshot
exits `4` with no partial comparison. Both formats are new and may change between minor versions.

`join --export-edges <file>` writes the joined cross-repo edges in a versioned file a code index
can import (`schemaVersion: 1`, `format: "flowtrace-edges"`): one record per joined edge in
exactly the join contract's shape — `kind`, `from` and `to` as `{ repo, ref, file, line }`, the
join `key` — plus a `provenance` field naming the export it came from. The envelope carries the
producer, the format version, the configuration the join read and every fact set's identity
once, under an id a facts change flips, so an importer can drop or replace imported rows
wholesale. Only joined edges export: `calls` and `tests` matched to a route action, and the
`publishes`, `consumes` and `enqueues` edges of a message that has both a publisher and a matched
consumer, the message end carrying `repo: "message"` and no file or line exactly as the join
states it. Records are sorted and deduplicated and no timestamp is written, so two exports over
unchanged facts are the same bytes. The format is new and may change between minor versions.

New verb `check`: a gate that compares an area's current `cover` seed totals and per-route
parity against a committed `<area>.baseline.json` beside the area file and fails the build
on any drop. Exit `0` no regression, `1` regression, `2` usage, `4` when the facts are
behind the repository HEAD, the baseline was captured from an older fact snapshot, or no
baseline exists; `4` is never collapsed into `0`. `--write-baseline` writes the current run
as the baseline instead of comparing and is refused by the same staleness rule.

## 0.1.1

Release pipeline only; the CLI is unchanged. The single-file build normalises line endings
before bundling, so the Windows executable builds from a CRLF checkout, and `.gitattributes`
pins sources to LF. The v0.1.0 release carries no Windows binary for this reason.

## 0.1.0

Initial public release: `extract`, `join`, `render`, `trace`, `span`, `surface`, `skeleton`,
`cover`, `affected`, `scaffold`, `cases` and `readiness` over ASP.NET Core, Ionic/Angular,
React + Redux, Playwright and Cypress checkouts, with the benchmark harness, sealed-truth
protocol and first published results under `docs/benchmarks/`.
