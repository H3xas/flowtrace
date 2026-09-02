# Changelog

Semantic versioning from `0.x`: the CLI surface may still change between minor versions.

## 0.1.1

Release pipeline only; the CLI is unchanged. The single-file build normalises line endings
before bundling, so the Windows executable builds from a CRLF checkout, and `.gitattributes`
pins sources to LF. The v0.1.0 release carries no Windows binary for this reason.

## 0.1.0

Initial public release: `extract`, `join`, `render`, `trace`, `span`, `surface`, `skeleton`,
`cover`, `affected`, `scaffold`, `cases` and `readiness` over ASP.NET Core, Ionic/Angular,
React + Redux, Playwright and Cypress checkouts, with the benchmark harness, sealed-truth
protocol and first published results under `docs/benchmarks/`.
