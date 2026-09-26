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

## Replaying the pack

`npm test` runs it: `selftest/journey-pack.test.js` copies the pack to a temporary directory,
captures it, replays it and fails when the projection differs from the committed
`observed.json`. It needs no network, credentials, code index or runtime collector. By hand, from
the repository root, with any scratch directory in place of `<scratch>`:

```
node scripts/journey-pack.mjs capture --config selftest/corpus/greenhouse-alerts/greenhouse.config.json --bundle <scratch>/bundle
node scripts/journey-pack.mjs replay  --config selftest/corpus/greenhouse-alerts/greenhouse.config.json --bundle <scratch>/bundle \
  --cases selftest/corpus/greenhouse-alerts/expected.json --out <scratch>/run-1 \
  --expect selftest/corpus/greenhouse-alerts/observed.json
```

Capture extracts into a staging directory inside the bundle, takes one `join --snapshot`, and
promotes it only when the content every extractor could read is unchanged from before
extraction to after it and nothing else under the roots was written. Promotion is a single rename
of the `current` pointer, so an interrupted capture leaves the previous bundle as it was. The
`capture.lock` file is written under a temporary name and linked into place, so it never exists
without its holder's process id and host; a capture stopped by a signal at any point leaves
either no lock or a complete one, plus staging and temporary files, and the next capture
reclaims a lock whose process no longer runs on this host and sweeps the rest. Two leftovers are
refused as `capture-in-progress` naming the file rather than guessed about, and need removing by
hand once no capture is running: a `capture.lock` that cannot be read as a lock (this harness
never writes one), and a `capture.lock.reclaim` left by a capture stopped while it was removing
a stale lock. Replay
copies the promoted bundle, lets flowtrace check the snapshot's own digests, runs only `join` and
`trace` with a pinned environment and no code index, and ends with a second `join --snapshot`
whose fact sets must equal the bundle's. Both steps write a manifest (`capture.json` inside the
bundle, `replay.json` beside the run output) naming the tool build, the Node version, the
normalised configuration digest, every fact set identity as the snapshot states it, the content
digest and scope rule per repository, and every command run with its exit code and diagnostics.
A field the harness cannot establish is written `unknown`. A replay refuses a capture manifest
of another format, schema version or step (`bundle-mismatch`), and one whose tool, Node,
snapshot, configuration, per-repository fact set or content, or code-index identity is
`unknown`, missing or null (`identity-unknown`, naming the field), so none of them is ever
accepted as a baseline.

Replaying the same bundle twice produces byte-identical `projection.json` files.

Exit codes: 0 success; 1 the projection drifted from `--expect` (every moved case is named) or a
classification contradicts its observations; 2 usage, or a ledger that is invalid or no longer
anchored to its source; 3 a named refusal — `capture-in-progress`, `provider-document-missing`,
`extract-failed`, `join-failed`, `capture-source-changed`, `source-written-during-capture`,
`titles-collector-failed`, `bundle-missing`, `bundle-mismatch`, `identity-unknown`,
`config-changed-since-capture`, `source-unavailable`, `source-changed-since-capture`,
`facts-digest-mismatch`, `snapshot-refused`, `facts-changed-during-replay` or
`manifest-path-leak`; 4 an unexpected internal error. A configuration that cannot be read is a
usage error.

The same harness can replay a configuration kept outside this repository. Its ledger, bundle and
results stay with that configuration, and its results are reported on their own, never pooled
with this pack's.

## The observed projection

`observed.json` (`format: "flowtrace-journey-observed"`, `schemaVersion: 1`) is what the
harness derives from the `--json` answers; it holds no path, sha, digest, timestamp or version,
and it reads only the fields its match rule names, so a field added to `--json` for another
reason does not move it.

- `runs`: per run, the exit code, how the start resolved (`resolved`, `ambiguous`,
  `unresolved`, `error`), `stats.budgetHit`, the number of nodes marked unresolved, and `outside`
  — each route or sink the run asserts that matches no site in its `reach`.
- `cases`: per case, each expected site with whether it was `found`, `by` its file and line
  (`site`), its symbol, or `both`, and the join that reached it (`match`); each unknown with
  whether a node sits at it (`seen`), carries an unresolved marker (`marked`), or asserts a route
  anyway (`asserted`); each assertion with whether it `held` and why not; the raw `counts`; and
  `falselyComplete` — the answer exited 0 with no budget hit and no unresolved marker while an
  expected site is missing.
- `classification` and `evidence` are written by a person after reading the case's raw output
  against its question. A case may read `resolved` only when its start resolved, every site was
  found, every assertion held, every unknown is marked and none asserted, and it is not falsely
  complete; `unresolved-cause` must name the evidence that would decide it. The gate checks both.

Match rule `match/1`: a site is found by a node of the walk, in order, when that node sits at the
site's file and line, when the edge that reached it carries evidence at that file and line (a
node stands on a declaration; the call that reached it is recorded on its edge), or when the node,
in the site's repository, answers to the site's symbol. A folded node stands for the node it
refers to. The `sinks` and `branches` lists are read too: they carry every walked sink and branch
in full, including those beneath a folded node whose subtree `nodes` leaves out, so such a record
can be found, but nothing is shown to reach it and it is ordered after everything the tree shows. `before` compares the first matching nodes in the order `trace --json` reports them,
which is walk order rather than source order; `reached-from` holds when the site's node descends
from the other site's node or was reached by an edge evidenced at the other site.

The report printed by `replay` (and written as `report.txt`) gives every case on its own line with
raw counts, then totals whose ratios sit beside their numerators and denominators. It makes no
accuracy claim.

## Budgets

The two harvest-plan runs differ only in `--max-nodes`: 24, below the at least thirty-six nodes
the twelve prerequisite chains take before the writer is reached, and 400, at least four times
the pack's backend method count. Both values belong to this case alone. Nothing here states a safe
default budget, and neither `stats.budgetHit: false` nor `seedsTruncated: 0` is a claim that a walk
saw the whole program.

## Extending the pack

- Case, run, site and unknown ids are stable: never renamed, never reused.
- A change that alters any observed case fails `npm test` until the same change rewrites
  `observed.json` (`replay … --write selftest/corpus/greenhouse-alerts/observed.json`) and a person
  classifies every case the rewrite left `null`, so each repair shows its before and after in its
  own diff.
- A change to an expected row lands in its own commit that states the correction and cites the
  source line it follows, never together with a change to an observed result.
- New cases may be added to the ledger; each new site is written from the source before anything
  is observed for it.
