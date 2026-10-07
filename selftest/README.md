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

It also holds one journey pack (`corpus/greenhouse-alerts/`), which is not a contract check
but a pinned denominator: a set of cross-repository questions whose expected source sites were
written from the fixture before anything was observed, replayed through
`scripts/journey-pack.mjs` and compared with a committed projection of what flowtrace answers
today. A change that moves any of those answers must update the projection in its own diff; the
pack's own README says how.

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
  service, one repository, reachable by `flowtrace extract`. It also holds one deliberately
  malformed file, `backend/src/Repositories/WidgetLedgerRepository.cs`, stored with mixed
  line terminators (its first method ends its lines CR CR LF, the rest of the file ends LF)
  and exempted from the repository's `eol=lf` normalisation in `.gitattributes`. It is the
  smallest shape that makes the two line models inside `lib/extract/backend.js` disagree;
  the file's own head comment says what it is for.
- `corpus/widget-cart/` — a minimal invented Playwright suite: one spec with five test
  declarations, plus `pw-list-transformed.json`, a list-mode report of that same suite whose
  positions are shifted the way a transformed source shifts them, so the title join is pinned
  against a report whose lines do not match the spec's own.
- `corpus/widget-kiosk/` — a minimal invented Playwright suite covering every shape that
  decides whether a title resolves: a skipped declaration versus a `test.skip` guard written
  inside a body, a `test` reached through a member access, a title wrapped in a configured
  case-id call, and a title supplied as a table identifier — plus a listing whose positions
  sit below the source so nothing can resolve by line.
- `corpus/greenhouse-alerts/` — the journey pack: an invented React + Redux client and
  ASP.NET Core service, the expected ledger (`expected.json`), the committed observed projection
  (`observed.json`) and a README with the formats, the replay commands and the rules for tickets
  that extend it. The harness that captures and replays it lives in `scripts/journey-pack.mjs`
  and `scripts/journey-pack/`, and is not shipped in the npm package.
- `journey-helpers.js` — a disposable copy of the journey pack and the harness run as a
  subprocess.
- `export-invariants.js` — the checks a `flowtrace-edges` document must satisfy on its own,
  with no checkout, no git and no second document to compare against; deliberately
  independent of `lib/`, so an implementation that drifts from its own documentation fails
  instead of agreeing with itself.
- `*.test.js` — one file per contract area, run against the CLI through `helpers.js` — with
  two exceptions: `scout-contract.test.js` imports `lib/scout.js` and `lib/dotnet.js`
  directly, because the code index binary that would otherwise have to be faked for a CLI
  run is off the table for a public fixture, and the functions it covers are pure parsing
  and selection logic with no process or filesystem behavior of their own to observe; and
  `pw-titles-contract.test.js` imports `lib/extract/pw-titles.js` directly for the same
  reason, since the CLI path would spawn the suite's own installed Playwright. The four
  `journey-*.test.js` files run the journey harness as a subprocess where they can, and import
  its modules (never `lib/`) where they cannot: capture's phase hooks, which is how a source edit,
  an interruption or a lock taken over by another capture is placed between two steps of one
  capture, and the pure ledger and projection functions.
- `path-check.test.js` — runs a repository script, `scripts/path-check.sh`, not the CLI: each
  case copies it into a disposable tree beside a hand-written linked-worktree `.git` pointer file.
- `verify.test.js` — covers the canonical command, `scripts/verify.mjs`: the pure functions
  that decide whether the suite is the whole suite and whether the package carries what it
  should, the report a failing stage prints, and the command itself spawned over the stages
  that need no suite run — including a copy of the command whose own input is missing, which
  must report the stage rather than a stack trace. Its cases read the repository rather than a
  fixture too: the workflow must run that command and nothing else and must cover every branch
  a change is integrated through, and CONTRIBUTING.md must name every stage and every branch,
  so the documented coverage and the enforced one move together.
- `docs-check.test.js` — runs `scripts/docs-check.mjs` against a disposable copy of the
  checkout's `bin/`, `lib/` and markdown, one case per way the documentation drifts: a link to
  a file that is not there, a fragment naming no heading, `docs/cli.md` missing or behind
  `--help`, a file that cannot be read, a checkout whose own file listing fails, a git that
  cannot say whether this is a checkout, and a tree outside git, which is walked.
- `config-check.test.js` — runs `scripts/config-check.mjs` against the shipped example and
  against examples written into a disposable directory: a shape the loader rejects, a
  repository kind that does not exist, a key the documentation never names, a file that is
  absent, malformed or unreadable, and a document that is missing or unreadable.
