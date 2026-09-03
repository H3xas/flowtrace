# Benchmarks

Everything measured about flowtrace so far has been measured against flowtrace. That answers
nothing a reader asks first, which is: *why not install something off the shelf?* These
documents design and publish the run that answers it — on public corpora, against maintained
open-source tools, with the truth sealed before anything runs.

- [methodology.md](methodology.md) — the tasks, why each one exists, what is measured, the
  environment a result must disclose, and how to re-run it.
- [peers.md](peers.md) — the tools compared, what each one claims in its own words, a
  capability matrix, where peers lead, and what flowtrace does that none of them attempt.
- [agentic.md](agentic.md) — the separate protocol for measuring an agent *using* the tool,
  as opposed to what the tool hands an agent. Protocol, plus the first (preliminary) run in
  [results/](results/2026-08.md).
- [results/](results/) — one document per run, each carrying its own environment block.

## The honesty statement

This is a full-honesty comparison. It is written to be usable by someone deciding whether to
install flowtrace *or* something else, not to sell flowtrace.

1. **Gaps are published in both directions.** "Where peers lead" is a required section,
   generated mechanically per (task × metric) cell so it cannot be quietly trimmed. If a peer
   leads a cell, it is named. If flowtrace loses a whole task shape, that is printed as the
   result, not footnoted.
2. **No best-everywhere claim is made, and none is available.** Every peer here solves a
   problem it chose, and several read C# and TypeScript far better than flowtrace's regular
   expressions do. flowtrace competes on one narrow question — the cross-repository,
   cross-language join and what hangs off it — and is expected to lose elsewhere.
3. **A task a tool cannot express scores `not_attempted`, never zero.** It is excluded from
   that tool's denominators and its reason is quoted from that tool's own documentation.
   `not_attempted` is never averaged in and never called a failure.
4. **The truth for most tasks is flowtrace's own output, and that is stated rather than
   hidden.** flowtrace's correctness column on those tasks is a tautology and is published as
   one — never as a win. The comparison is carried by the columns that are not tautological:
   payload size, wall time, follow-up reach, and every peer's recall and precision against a
   hand-audited truth.
5. **Numbers travel with their corpus.** A figure from one corpus may not be set beside a
   figure from another, and neither averages into the other. Every results document names the
   corpus, its pinned commit, and the host it ran on.
6. **Unflattering measurements are not dropped.** Cold and warm timings are both published.
   Setup cost is its own line and is never amortised into a query time. A run that voids a
   task's seal publishes the void.

## Scorecard so far

eShopOnWeb corpus, sha-pinned; full tables, per-cell verdicts and the integrity caveats are
in [results/2026-08.md](results/2026-08.md).

| round | result | verdict |
| --- | --- | --- |
| Deterministic pipeline | facts, walks and `span` reconcile on the pinned corpus | measured; peer matrix not yet run |
| Agentic — 4 sealed tickets, 2 models, tool / no-tool / no-code arms | tool arms 8/8 correct, baseline arms 8/8 correct, no-code control 0/4 | **no advantage shown this run** — correctness and token cost both flat against the baseline; only the no-code floor separated |

One run per cell is an anecdote with a number attached, and is published as exactly that. The
negative finding stays on the board until the 5-run protocol confirms or retires it — this
project publishes the rounds it loses with the same prominence as the ones it wins.

## What is here, and why nothing more

The reference set outside this directory is deliberately small and is listed in
[../README.md](../README.md): getting started, the agent page, concepts, the command
reference (`flowtrace --help`, verbatim), configuration, the fact schema, scout, the area
format, and the CHANGELOG.

**`docs/benchmarks/` is where measurements go, and the only place they go.** A measurement
needs its method, its peers and its environment written down or it cannot be checked;
nothing else added here would be checkable in the same way. New prose that is not a
benchmark belongs in one of the reference documents above, or in `--help`.
