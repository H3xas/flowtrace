# Greenhouse alerts journey pack

An invented two-repository product — a React + Redux `web` client and an ASP.NET Core
`backend` service — in which a grower chooses which growers watch a greenhouse zone's alerts.
No real product, company or codebase is behind it. It exists to pin, against a fixed
denominator, how well flowtrace answers a small set of cross-repository journey questions, so a
later change to discovery, lifecycle handling, call ordering or traversal limits shows its
before and after in its own diff instead of against a refreshed cache.

The pack is verification, not a walkthrough: it is not shipped in the npm package and it is not
the worked example (`examples/demo-shop` is).

## What the fixture contains

- Nested route mounts: `/greenhouse/*` mounts a shell, the shell mounts `zones/:zoneId/*`, and
  the zone routes mount a lazily imported watcher page inside a per-route `Suspense` wrapper.
- Two initialisation styles: a class component that loads readings in `componentDidMount`, and a
  function component that loads watchers in a `useEffect`.
- Click handlers beside them: an acknowledge button on the class component and the selected save
  handler on the watcher page, which dispatches a thunk.
- Gateway requests under `greenhouse/`, served by backend routes under `glasshouse/`, joined only
  through the configured alias in `greenhouse.config.json`.
- A save that checks the caller's identity, looks the zone up, checks edit access, records an
  audit entry, filters the selected watchers for eligibility, rejects an empty selection, writes
  the watchers, recomputes an irrigation schedule only when the zone has one, refreshes a cache and
  records a second audit entry — each statement on its own line.
- Success and failure notices in the UI after the save request settles.
- A report request whose URL is built at run time for an endpoint no repository in the pack
  declares: the honest answer there is an unresolved marker, never a concrete edge.
- A harvest-plan route whose handler performs twelve prerequisite lookups, each through its own
  service, before it reaches the business write through a writer service.

## The expected ledger

`expected.json` (`format: "flowtrace-journey-expected"`, `schemaVersion: 1`) was written from
this source alone, before anything was observed. It holds:

- `sites`: one row per source statement a case asks about — `repo`, `file` relative to that
  repository's root, 1-based `line`, an `anchor` that must occur on that line, and the `symbol` the
  site names. A call site's symbol is its callee (`Class.Method` of the implementation on the
  backend, the action creator or handler on the web side); a page or mount names its component; a
  route names its controller action. A site no symbol names alone — a branch, a gateway request, a
  mount whose element is a wrapper — has `symbol: null` and can only be found by its file and line.
- `unknowns`: statements whose target cannot be established from source, with the reason.
- `runs`: one `flowtrace trace` start per question, the walk flags it uses (`--depth`,
  `--max-nodes`, `--seeds`, `--expand` only), whether its assertions are the routes or the sinks it
  reports, and `reach` — every site of that kind the source says the start reaches.
- `cases`: the question, the sites and unknowns it expects, and its assertions — `before` (one site
  is reported ahead of another), `reached-from` (a site is reached from another, optionally through
  a named join such as `alias`) and `at-site` (each listed site is found at its own line).
- `vocabulary`: the ten classifications a case may carry — `resolved`, `discovery`, `lifecycle`,
  `join`, `ordering`, `budget`, `stale-input`, `configuration`, `unsupported`, `unresolved-cause`.

`selftest/journey-ledger.test.js` checks that the ledger is valid, that every site still sits on
the line its anchor names, and that every file here is tracked.

## Budgets

The two harvest-plan runs differ only in `--max-nodes`: 24, below the at least thirty-six nodes
the twelve prerequisite chains take before the writer is reached, and 400, at least four times
the pack's backend method count. Both values belong to this case alone. Nothing here states a safe
default budget, and neither `stats.budgetHit: false` nor `seedsTruncated: 0` is a claim that a walk
saw the whole program.

## Extending the pack

- Case, run, site and unknown ids are stable: never renamed, never reused.
- A change to an expected row lands in its own commit that states the correction and cites the
  source line it follows, never together with a change to an observed result.
- New cases may be added to the ledger; each new site is written from the source before anything
  is observed for it.
