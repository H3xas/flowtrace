# Public contract suite

This is not the regression suite described in [../CONTRIBUTING.md#tests](../CONTRIBUTING.md#tests)
— that one runs privately, against corpora that are not public, and proves the extraction
heuristics are correct against real code shapes.

What lives here instead is a small, public suite over an invented fixture
(`corpus/gizmo-shop/`, a fictional catalog service — no real product, company or codebase),
run with `node --test` (no dependency, dev or otherwise). It exists so that a stranger's
pull request is verified by CI without needing access to anything private, and it checks the
CLI's outer contract:

- Argument parsing: `--help`/`-h`, an unrecognised command, a missing `--config` file.
- `--json` output shapes for `extract`, `join`, `trace`, `routes-of` and `affected`,
  including that identical facts trace to byte-identical JSON.
- The documented exit codes, including the commands (`routes-of`, `affected`) whose failure
  is itself a JSON envelope rather than a bare stderr line.

It does not exercise every extractor idiom, every command, or every flag — that is what the
private suite and the worked example (`examples/demo-shop`) are for. A change to `lib/extract/`
or to a walk should still make itself visible in the worked example, per
[../CONTRIBUTING.md](../CONTRIBUTING.md); a change to the argument parser, an exit code, or a
`--json` envelope shape should extend this suite instead.

Run it with:

```
npm test
```

## Layout

- `helpers.js` — spawns `bin/flowtrace.js` as a subprocess (never imports `lib/` directly,
  so what's tested is what a user actually runs) and gives each test its own disposable copy
  of the corpus.
- `corpus/gizmo-shop/` — a minimal invented ASP.NET-Core-shaped backend: one controller, one
  service, one repository, reachable by `flowtrace extract`.
- `*.test.js` — one file per contract area.
