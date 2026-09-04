# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## Unreleased

New verb `routes-of <file:line | symbol | literal>`, the reverse of `trace`. It resolves a
repository-relative file and line, an exact method symbol or an exact allowlisted literal to
one fact, then reports every entry route whose complete fact-only forward walk passes through
it: one shortest `repo:file:line` witness per route, the count of further paths, and the
route's existing seeds and test evidence. Unresolved or ambiguous input exits `2` and lists
the candidates; a walk that reaches its node budget exits `4` and returns no partial set.
`--json` is deterministic and carries `schemaVersion: 1`. The pre-registered agentic round
for the verb is published under `docs/benchmarks/results/2026-08-routes-of.md`; both tool
cells failed harness integrity, so it establishes no advantage in either direction.

A `playwright` repository can be configured `"titles": true`. `extract` then runs that
repository's own installed Playwright in list mode and appends one `pw_title` fact per test
declaration the listing resolved, so a parameterised title renders as the titles it produces
(`listed`) rather than as its expression (`raw`). Nothing is fetched or installed; the package
is resolved from the repository root, and a preload written under `out/` keeps a suite that
vendors a second copy of the package listable. When the collector cannot run, extraction still
succeeds: the reason goes to stderr and into the fact set's header as `titles`, and no
`pw_title` fact is written. Configuration reference: `titles` under `repos[]`.

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

## 0.1.1

Release pipeline only; the CLI is unchanged. The single-file build normalises line endings
before bundling, so the Windows executable builds from a CRLF checkout, and `.gitattributes`
pins sources to LF. The v0.1.0 release carries no Windows binary for this reason.

## 0.1.0

Initial public release: `extract`, `join`, `render`, `trace`, `span`, `surface`, `skeleton`,
`cover`, `affected`, `scaffold`, `cases` and `readiness` over ASP.NET Core, Ionic/Angular,
React + Redux, Playwright and Cypress checkouts, with the benchmark harness, sealed-truth
protocol and first published results under `docs/benchmarks/`.
