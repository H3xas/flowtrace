# Agentic protocol

> **First results published — preliminary, 1 run per cell** — the "Agentic run 2026-08-25" section of [results/2026-08.md](results/2026-08.md); this document is the protocol, and that preliminary banner sits atop the results until five runs exist.

[methodology.md](methodology.md) measures what a tool hands an agent for one question, with no
model in the loop. This measures the other half: whether an agent **solving a real ticket** does
it better with the tool than without. Those are different questions and their numbers never mix.

## Lanes

Two models, two arms each — four lanes per ticket.

| lane | model | reasoning effort | toolset |
|---|---|---|---|
| `sonnet.base` | Sonnet 5 | max | file read, glob, grep, shell, git |
| `sonnet.ft` | Sonnet 5 | max | the same, plus flowtrace |
| `opus.base` | Opus 5 | xhigh | file read, glob, grep, shell, git |
| `opus.ft` | Opus 5 | xhigh | the same, plus flowtrace |

**Tool availability is the only difference between an arm and its baseline.** Same prompt, same
repository state, same effort setting, same time and step budget. The token budget is 150k per
lane, hard stop. A lane that reaches the step or token budget stops and is recorded as stopped,
not retried.

## Tickets

Tickets are drawn from the open issue trackers of the pinned public corpora in
[`bench/corpus.lock`](../../bench/corpus.lock), plus the bundled `examples/demo-shop` where a
corpus has too few open tickets of a usable shape. A ticket qualifies when it is:

- **Real** — filed by someone other than this project, before this benchmark existed.
- **Reproducible at the pin** — the described behaviour is present at the pinned sha.
- **Checkable** — success is decidable from the repository, not from a maintainer's opinion:
  a failing test that must pass, a described behaviour a new test can pin, or a stated
  invariant a reviewer can verify against source.
- **In scope for at least one lane's toolset** — a ticket no arm could plausibly reach is
  reported as out of scope before the run, not discovered as a zero afterwards.

**2026-08-25 — ticket sourcing for run 1.** Maintainer-authored tickets are permitted in place
of externally-filed issues for this run; disclosed in any results that use them.
Externally-filed sourcing remains preferred from the next run.

The ticket list, each ticket's verbatim statement, and its acceptance criteria are
**pre-registered and sealed before any lane runs**, by the same sealing rules the deterministic
run uses, under `bench/truth/agentic/`. A ticket added or reworded after a lane has run voids
that ticket for that run.

## Running a lane

1. A fresh clone of the corpus at its pinned sha, per lane. No lane sees another lane's clone,
   output, transcript or diff.
2. The prompt is the ticket statement verbatim, plus a fixed preamble naming the repository and
   the definition of done. The preamble is identical across all four lanes; the `.ft` lanes get
   one extra sentence stating that flowtrace is installed and pointing at `--help`.
3. The lane runs to a patch, or to its budget. Transcript, tool calls, token counts and the final
   diff are captured verbatim.
4. Nothing is re-run to improve it. A failed lane is a result.

## Judging

Judging is **blind**, run by Claude Fable 5: arm labels, model names and tool traces are stripped
from the diff before the judge sees it, and it scores against the sealed acceptance criteria and
a fixed rubric. A judge that can identify the arm from the diff records that it could — the fact
is published.

Per lane, per ticket:

| metric | definition |
|---|---|
| `solved` | the sealed acceptance criteria are met, judged blind |
| `tests` | does the repository's own suite pass at the patched state? |
| `tool_calls` | count, split by tool |
| `tokens` | input and output, as the harness counts them |
| `wall_ms` | end to end, including tool time |
| `files_opened` | distinct files read, as a proxy for search effort |
| `stopped` | reached the step or time budget without a patch |

## Reporting rules

- **Single-run results carry the banner at the top of this document, verbatim.** One run per lane per ticket is an anecdote with a number attached, and is labelled one.
- Per-ticket rows are published, not only aggregates: with four lanes and a handful of tickets,
  an average hides more than it shows.
- A lane that solved a ticket *without* the tool is reported as prominently as one that solved
  it with. If the baselines win, that is the finding.
- Model versions, effort settings, harness version and the date are part of the environment
  block, because a lane's behaviour is not stable across model releases and this benchmark
  cannot pretend otherwise.

## What this cannot show

It cannot separate the tool from the prompt: an agent told a tool exists uses it, and some of any
delta is that instruction rather than the tool's output. It cannot generalise past the ticket
shapes drawn — a corpus's open tickets are whatever its maintainers happened to file. And with
one run per lane it cannot distinguish a real effect from model variance at all, which is the
whole reason the 5-run protocol exists and this document says so before publishing a number.
