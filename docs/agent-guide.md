# flowtrace for AI agents

An agent asked "which tests must run for this change" or "what does this endpoint actually
do" answers well only when it has something to point at. flowtrace gives it that: every line
of output carries a `file:line`, the same input produces the same output byte for byte, and a
gap in what the tool knows prints as a gap rather than a guess. This page states how to set
it up for an agent, what to write into the repository's instructions, and how the output is
to be read.

## Setup

The steps in [getting-started.md](getting-started.md) are the setup; an agent can run them
unassisted. In a fresh workspace, an agent should:

1. Install (`npm i -g flowtrace-cli`) or confirm `flowtrace --help` answers.
2. Write `flowtrace.config.json` beside the checkouts, one `repos[]` entry per repository,
   following the `kind` table in [getting-started.md](getting-started.md#32-write-the-configuration).
3. Run `flowtrace extract` and stop on any `0 facts` line until the root is right.
4. Run `flowtrace join`, then list the route keys (step 3.4 there) and write at least one
   area file under `areas/`.
5. Commit `flowtrace.config.json` and `areas/`, ignore `out/`.

Nothing here needs a build, a running service or network access; the whole setup is file
reads plus one optional child process for a configured code index.

## Give the agent the map

Paste this into the instructions file the agent reads for the workspace (`CLAUDE.md`,
`AGENTS.md`, `.cursorrules`, a system prompt) and edit the two placeholders:

```markdown
## flowtrace

This workspace is indexed by flowtrace (`flowtrace --help`). Configuration:
`flowtrace.config.json` in <workspace directory>; area files under `areas/`; everything the
tool writes is under `out/` and is never committed. The main area file is `areas/<name>.txt`.

Before answering what a route does, what a change reaches, or which tests cover something:

1. `flowtrace extract && flowtrace join` — refresh the facts. Takes seconds. Facts behind
   HEAD make `affected` exit 4; re-run this rather than reasoning around it.
2. `flowtrace trace "<VERB template>" --seeds` — what runs, and the distinct outcomes.
3. `flowtrace cover --area areas/<name>.txt` — which of those outcomes a test already pins.
4. `flowtrace affected --diff <base>...HEAD --area areas/<name>.txt --json` — the specs to
   run. Exit 0: a list; 3: nothing affected; 4: widened, run the whole suite, reason on
   stderr; 2: usage; 1: refusal.

Rules: quote the output rather than paraphrasing it. `unresolved` and `graph: unavailable`
mean unknown, not absent. Never state a coverage figure the output does not print. Never
fill in a case id, a response-field claim or a helper name the tool left as `TODO`.
```

## Command order

The first two commands write files; every other command reads them. Run in this order and
the rest is stateless:

| question | command | reads |
|---|---|---|
| refresh what the repositories say | `flowtrace extract` then `flowtrace join` | source, then `out/facts/` |
| what does this route run, and what can it do | `flowtrace trace "<key>" --seeds --json` | facts |
| what does this screen or component reach | `flowtrace trace <ComponentName> --expand` | facts |
| which outcomes do tests already pin | `flowtrace cover --area <file> --json` | facts |
| which specs must run for this diff | `flowtrace affected --diff <range> --area <file> --json` | facts + `git diff` |
| which `dotnet test` filter covers this diff | `flowtrace affected --diff <range> --area <file> --dotnet-filter` | facts + `git diff` |
| where can I observe what this route writes | `flowtrace surface "<key>" --json` | facts |
| draft the missing tests | `flowtrace scaffold --area <file> --dry-run`, `flowtrace skeleton "<key>"` | facts |
| draft the missing cases for a person | `flowtrace cases --area <file> --dry-run` | facts |
| one page for a tester | `flowtrace span "<key>"` | facts |

`--json` exists on `trace`, `cover`, `affected`, `surface`, `skeleton` and `readiness`;
`trace --area <file>` emits one JSON array for a list of keys. The terminal form is for
showing a person; the JSON form is for deciding. Field lists per command are in
[cli.md](cli.md).

## Reading the output honestly

flowtrace is built around one rule: it never reports a number it cannot point at a fact for.
An agent relaying its output keeps that rule intact by observing the following.

- **A route key is `<VERB> <template>`**, quoted, exactly as the facts declare it. When a
  start does not match, the tool says so and exits `2`; do not retry with a guessed key,
  list the keys instead (getting-started, step 3.4).
- **`unresolved` and `graph: unavailable` are answers.** They mark the point where facts ran
  out. Report the hop as unknown; do not describe what "probably" lies past it.
- **`[unknown: x ← unresolved]` on a seed** means the branch condition could not be traced
  to a caller-controlled source. The seed is neither reachable nor unreachable; say so.
- **Evidence is per route, not per path.** An intercept proves a request reached the route.
  A seed reaches the `path` or `disposition` tier only when an assertion distinguishes it.
  Do not upgrade a `route`-tier seed in prose.
- **Counts are seeds, not lines.** `3/5 area routes with executing evidence · 10 seeds` is
  the whole claim. There is no line-coverage figure to derive from it.
- **Exit `4` from `affected` means "run everything", with the reason on stderr.** Stale
  facts, a repository with no facts, a config-only diff, a selection above `--max-share` are
  all such reasons. Relay the reason; do not narrow the list by hand.
- **`TODO` is a boundary.** `scaffold`, `skeleton` and `cases` leave the case id, the
  response-field claim and an unknown helper as placeholders because those are judgments,
  not walks. Leave them for a person unless that person has asked the agent to decide.
- **Runs are reproducible.** No timestamps in `span`, `surface` or `skeleton` output; the
  same facts yield the same bytes. A difference between two runs is a difference in the
  facts, which means a difference in the source.

## What flowtrace does not do

- It runs no tests. Coverage is what the tests' own source says they touch.
- It parses nothing. Extraction is regular expressions and brace matching; an idiom the
  patterns do not recognise is invisible, and the fix is a wider pattern in `lib/extract/`.
- It reads only the kinds listed in [configuration.md](configuration.md#kinds): ASP.NET Core,
  Ionic/Angular, React + Redux, Playwright and Cypress.
- It reaches no network. The only child processes are `git` for diffs and the code index
  binary you configure, and that one runs with its stores forced under `out/`.
