# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## Unreleased

Documentation only; the CLI is unchanged. The README is now an entry page and the
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
