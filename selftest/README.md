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
- `corpus/widget-till/` — an invented Playwright suite and a one-route backend for case ids in
  a configured call: a wrapper in title position on every declaration form and over several
  lines, body calls, a same-file table, arguments no reader resolves, and a misaligned file.
  It has three configurations (both callees, the body call alone, none) and `pw-list.json`, a
  listing whose wrapped titles carry the text the wrapper adds; `title-wrapper-case-ids.test.js`
  reads it.
- `corpus/widget-ledger/` — an invented Playwright suite for case ids that the bounded reader
  evaluates: a same-file map read in nested loops, literal and ternary keys, a block-local
  `const`, an array element and a destructured row, and each argument it refuses, with a loop
  product at the 64-instance limit and one past it. `case-id-maps.test.js` reads it.
- `corpus/widget-gate/` — an invented Playwright suite and a four-route backend for test
  eligibility: static skips, environment guards at file, describe, hook and test scope, guards
  that cannot be read, and a `test.describe.fixme(` stub spec. It has three configurations (no
  `testEnvironment`, `E2E_ENV` set to `dev`, set to `stage`) and `gate.area.txt`;
  `test-eligibility.test.js` reads it.
- `corpus/greenhouse-alerts/` — the journey pack: an invented React + Redux client and
  ASP.NET Core service, the expected ledger (`expected.json`), the committed observed projection
  (`observed.json`) and a README with the formats, the replay commands and the rules for tickets
  that extend it. The harness that captures and replays it lives in `scripts/journey-pack.mjs`
  and `scripts/journey-pack/`, and is not shipped in the npm package.
- `corpus/orchard-routes/` — an invented React client whose routes nest every way the
  browser-path lookup reads (JSX children, a component's own `<Routes>`, index routes,
  parameters, wildcards, lazy imports, redirects, guarded alternatives, unmounted roots, forms it
  does not model), with `matrix.json` naming the page entry or failure reason each URL must give;
  `page-routes.test.js` runs it through the CLI.
- `corpus/kettle-market/`: an invented storefront suite with the shapes that decide whether a
  browser test runs on a real backend, on patched responses or on a mocked backend. Its
  `base-facts.json` holds the `pw_stub` and `pw_test` facts that the extractor wrote before it
  read backends, and `golden.mjs` writes that file. `backend-class.test.js` runs the corpus
  through the CLI. The corpus README lists its spec groups.
- `corpus/nursery-mobile/` — an invented Ionic app (a page, a rendered child component, one
  injected service, NgRx actions and an effect) and a small ASP.NET Core backend it calls.
  `mobile-component-span.test.js` runs `span --from-component` over it. The fixture's README
  states the header counts each run must give and how the two committed `trace` goldens were
  captured.
- `corpus/kiln-yard/`: an invented pottery yard with a backend, a React client and an Ionic
  app. Its web and mobile files hold each decision form the extractors read, and the text that
  must give none. `caller-decisions.test.js` runs it through the CLI, one `Caller decisions
  AC-n:` test for each acceptance rule. One case imports `buildRuntimeIndex` and
  `runtimeSummary` of `lib/runtime-cover.js`, because a corpus with more than 200 decisions
  would be too large to read. `decisions-verb.test.js` builds its own git working trees in a
  temporary directory, one `Decisions verb AC-n:` test for each acceptance rule.
- `corpus/ferry-tickets/`: an invented ferry ticket office, with two backend repositories and
  one web client. Each file group holds one C# form the backend extractor reads: attribute
  sections, constant route arguments, expression bodies and chain links, expression
  decisions, sentinel fallthroughs, one-line branch labels, configured exception statuses
  and a gated pipeline. `csharp-reading.test.js` runs it through the CLI, one `CSharp
  reading AC-n:` test for each acceptance rule. The corpus README lists its file groups.
- `corpus/tidepool-mobile/` and `corpus/tidepool-web/`: an invented Angular app and an
  invented React app. Their templates hold each display condition form, transfer form and
  trace step that the client condition reader reads, each trace reason, and each region
  state. `client-conditions.test.js` runs both through the extractors, one `Client conditions
  AC-n:` test for each acceptance rule. It also imports `lib/extract/client-conditions.js`
  for the hop limit and the trace limit, because a corpus that reaches those limits is too
  large to read. `client-conditions-outputs.test.js` runs the query verbs on each corpus
  and on the worked example, with and without the new facts, and compares the outputs.
- `corpus/bakery-orders/` and `corpus/bakery-gates/`: an invented bakery backend. Its
  pipelines take their steps from a DI factory, a `typeof(...)` list or an injected
  `IEnumerable<T>`. Their steps write a stop flag, return `false` or `null`, or throw. The
  gates corpus adds authorization and action filters, registered globally or set as
  attributes. `pipeline-rejects.test.js` runs both through the CLI, one `Pipeline rejects
  AC-n:` test for each acceptance rule.
- `corpus/lantern-depot/`: an invented storage depot, with an ASP.NET Core backend and a
  Playwright API suite whose tests reach their requests through helper functions, helper
  classes and clients. Its `base-facts.json` holds the `pw_test`, `pw_request`, `pw_assert`
  and `pw_stub` facts of the other Playwright corpora and of the worked example, as the
  extractor wrote them before it followed helper calls. `capture.mjs` writes that file.
  `helper-requests.test.js` runs the corpus through the CLI, one `Helper request evidence
  AC-n:` test for each acceptance rule. One case imports `requestIndex` of `lib/skeleton.js`,
  because that reader has no command of its own to run. The corpus README lists its spec
  groups.
- `corpus/tidewater-ferry/`: an invented ferry service, with an ASP.NET Core backend, a
  mirrored backend and a React/Redux client. It holds the call-site shapes the source-flow
  view reads: guards, switch arms, try/catch/finally, conditional expressions, loops, awaits,
  task launches and joins, callbacks, promise launches and continuations. The mirror reverses
  the declaration order, the service names and the registration order, so the two trees must
  agree on call-site order. `source-flow.test.js` runs one `Source flow AC-n:` test for each
  acceptance rule.
- `corpus/quarry-dispatch/`: an invented dispatch backend and a small React client. Each
  file exists for one partial-result case: a wide survey chain before a write, eight
  validations past the seed cap, a two-binding DI choice, a collection of seventeen
  interface implementations, an action that calls nothing, and a gateway call whose template
  the web extractor cannot resolve. `partial-result.test.js` runs it through the CLI with one
  `Partial result AC-n:` test for each acceptance rule, and calls `trace()` in process for the
  code-index case the public corpus cannot supply.
- `corpus/willow-lending/`: an invented lending backend whose service calls classes from
  packages that no file of the corpus declares, and one interface with no implementation.
  `stopped-walk.test.js` runs it with a stand-in code index binary, so one route stops only
  at the edge of the configured repositories and the other also stops at an unresolved
  target. The same file runs `quarry-dispatch` and `kiln-yard` through each reading verb, one
  `Stopped walk AC-n:` test for each acceptance rule.
- `corpus/kite-club/`: an invented kite club, with an ASP.NET Core backend, a React client
  with its Cypress suite, an Ionic app and a Playwright suite. It holds one route that a
  thunk, a function nothing calls and an Ionic service post to, and a screen shape for each
  hop and gap of `chains`. `route-chains.test.js` runs it through the CLI, one `Route chains
  AC-n:` test for each acceptance rule. One case imports `callersOf` of `lib/span.js`,
  because no command prints the callers of a route as data. The corpus README lists each
  shape and the chain it gives.
- `corpus/regatta-desk/`: an invented race office, with an ASP.NET Core backend, a React and
  Redux client and an Ionic app with NgRx. It holds the component shapes of the web
  journeys: body and `render` dispatches, inline and named arrows, nested thunks, pages of a
  component, two route trees and Ionic lifecycle hooks. `web-journeys.test.js` runs it
  through the CLI, one `Web journeys AC-n:` test for each acceptance rule. `base-facts/` and
  `base-capture.json` hold what the base code wrote and printed for it. The corpus README
  lists each shape and the rule that reads it.
- `corpus/lantern-console/`: an invented settings console with an ASP.NET Core backend, a
  React service, an Ionic service, and Cypress suites for both clients. One app request and
  five Cypress requests name the same route, so `cypress-evidence.test.js` can count the
  `calls` edges and the `tests` edges apart. A second route is intercepted only by a page
  model. The corpus README lists its files.
- `dependency-goldens.js` and `corpus/dependency-goldens.json`: the dependency answer of each
  corpus, as the release branch renders it. A change that moves the dependency view on purpose
  writes the golden again with `--write`. The record holds the exit
  status and the sha256 of stdout and stderr for six outputs of every start. `--write` captures
  it and `--check` compares it. The label line and the `view` key are the only stated
  additions, so both are taken off before the comparison.
- `seed-goldens.js` and `corpus/seed-goldens/`: the `trace --seeds --json` and `cover --json`
  output of each corpus with backend routes, written by `node selftest/seed-goldens.js
  --write` with the engine before the pipeline outcomes. `pipeline-rejects.test.js` makes sure
  that each corpus still prints every golden seed key. A corpus with no pipeline, sentinel or
  filter must print the same bytes.
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
- `build-sea.test.js` and `corpus/bundle-shapes/` — import the bundler of
  `scripts/build-sea.mjs`, not the CLI, and run the bundles it writes: the CLI itself and an
  invented module whose comments, strings, template literals and regex literals spell imports
  and exports it does not have. Each inlined module must carry exactly the export names a
  dynamic `import()` of it gives, and each bundle must print what the source prints. The test
  also imports the modules the bundle inlines, since their real export names are the
  reference. It never makes a binary: the build's own start check is covered with stand-in
  executables.
- `verify.test.js` — covers the canonical command, `scripts/verify.mjs`: the pure functions
  that decide whether the suite is the whole suite and whether the package carries what it
  should, the report a failing stage prints, and the command itself spawned over the stages
  that need no suite run — including a copy of the command whose own input is missing, which
  must report the stage rather than a stack trace. Its cases read the repository rather than a
  fixture too: the workflow must run that command and nothing else and must cover every branch
  a change is integrated through, and CONTRIBUTING.md must name every stage and every branch,
  so the documented coverage and the enforced one move together.
- `docs-check.test.js` — runs `scripts/docs-check.mjs` against a disposable copy of the
  checkout's `bin/`, `lib/` and markdown, one case per way the documentation drifts or the
  check loses sight of the tree: a link to a file that is not there, a fragment naming no
  heading, `docs/cli.md` missing or behind `--help`, a file that cannot be read, a checkout
  whose own file listing fails, a git that cannot say whether this is a checkout, a checkout
  whose own pointer no longer resolves, git pointed at another checkout by the environment, a
  directory the walk cannot list, and a tree outside git, which is walked.
- `config-check.test.js` — runs `scripts/config-check.mjs` against the shipped example and
  against examples written into a disposable directory: a shape the loader rejects, a
  repository kind that does not exist, a key the documentation never names, a file that is
  absent, malformed or unreadable, and a document that is missing or unreadable.
