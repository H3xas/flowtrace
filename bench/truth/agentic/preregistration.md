# Agentic pre-registration — flowtrace

**Sealed:** 2026-08-25, before any lane has run. Predictions in this document are not adjusted
after any lane result is seen; a rerun of any part of this document is a new document, not an
edit to this one.

**Scope:** the 4 sealed tickets in this directory (BT-01..BT-04) against eshoponweb @
4da8212117e87d808d4bbc7da6286fd2147ce606, under the 4 lanes defined in
[`docs/benchmarks/agentic.md`](../../../docs/benchmarks/agentic.md): `sonnet.base`, `sonnet.ft`,
`opus.base`, `opus.ft`. Budget: 150k tokens per lane, hard stop.

## Why these predictions lean skeptical of the tool

flowtrace's core capability is the cross-repository route-to-consumer join and spec-coverage
walk. None of BT-01..BT-04 are cross-repository or route-join-shaped tasks — they are
single-repository ASP.NET Core bugs and one small feature addition, entirely inside
`eshoponweb`. The honest prior is that the joins `flowtrace --help`'s verbs build (`trace`,
`span`, `cover`, `cases`, `affected`) do not target what these four tickets need, so
the `.ft` arm is predicted to win on search-cost tokens at best, and not to move the
solved-or-not needle much. This is stated before any lane runs specifically so it can be checked
against, not adjusted toward, afterward.

## Predicted median tokens per ticket per lane

| ticket | `sonnet.base` | `sonnet.ft` | `opus.base` | `opus.ft` |
|---|---|---|---|---|
| BT-01 | 42k | 40k | 55k | 52k |
| BT-02 | 28k | 27k | 35k | 34k |
| BT-03 | 14k | 14k | 18k | 18k |
| BT-04 | 50k | 47k | 62k | 58k |

Rationale: BT-03 is a one-line, one-file finding (`Task.Delay(1000)` at the top of a method) —
predicted near-floor tokens for every lane, and the smallest `.ft` delta of the four, because
there is nothing for the tool to shortcut. BT-01 and BT-04 require reading multiple files across
`ApplicationCore`/`PublicApi`/`Web` — predicted the largest `.ft` deltas, purely from fewer
exploratory `grep`/`read` cycles, not from the tool understanding the domain. Opus lanes are
predicted higher than Sonnet at the same ticket because `xhigh` effort is predicted to read more
broadly before committing to a patch.

## Predicted correct-or-partial count (out of 4 tickets), per lane

| lane | predicted correct-or-partial |
|---|---|
| `sonnet.base` | 3 / 4 |
| `sonnet.ft` | 3 / 4 |
| `opus.base` | 4 / 4 |
| `opus.ft` | 4 / 4 |

Rationale: BT-03 and BT-02 are predicted solved by every lane (single-file, mechanically
findable once the file is opened). BT-01 is predicted solved by every lane too — the fix pattern
already exists in the same repo (`GetMyOrdersHandler`/`CustomerOrdersSpecification`), which a
careful read of `ApplicationCore/Specifications/` surfaces regardless of tool. BT-04 is predicted
the one Sonnet-base and Sonnet-ft miss or only partially solve (four files touched consistently,
including a name filter added to *both* the count and paged specifications) — predicted the
highest-variance ticket of the four, and the one most likely to separate lanes on correctness
rather than just tokens. This yields identical predicted counts across `.base`/`.ft` per model —
the tool is predicted **not** to change whether a ticket is solved, only how many tokens it
costs to get there.

## Falsification margins

Stated before any lane runs; a margin's failure is recorded against the tool, not quietly
dropped.

1. **Correctness margin.** For flowtrace to be credited with a real correctness effect in a
   model's pair of lanes, `.ft`'s solved count must exceed `.base`'s by at least 1 (out of 4
   tickets), for that model. Given the predicted counts above (`.ft` == `.base` per model), the
   default expectation is that this margin is **not** met — if it is, it is a genuine surprise
   worth flagging, not confirmation of a prior.
2. **Token margin.** For flowtrace to be credited with a real cost effect, `.ft`'s median tokens
   must be at least 10% lower than `.base`'s median tokens, on the same ticket, for at least 3 of
   the 4 tickets. Below that margin, any observed gap is recorded as noise from a single run, per
   the 1-run banner already on `agentic.md`, not as a finding.
3. **Failure of both margins** on a model's pair of lanes is recorded, verbatim, as: "flowtrace
   gave the `.ft` arm no measurable advantage over `.base` on this ticket set, at this effort
   level, in this run." That sentence is pre-written here so it cannot be softened after the
   fact if it is what happens.

## Void-control design

flowtrace's own protocol (`agentic.md`) does not currently mandate a no-repository control; this
section adds one for this run, using the same "written down before any lane runs, checked
against the sealed acceptance criteria" discipline the rest of this document uses, mirroring the
no-repository control devscout-rs's protocol requires.

**Design:** for each of the 4 tickets, one additional lane — `void` — receives the exact ticket
statement and preamble text used by `sonnet.base`, but no repository clone, no `flowtrace.js`,
no shell, no file tools at all: the model answers from the prompt alone. The judge scores the
`void` lane's answer against the same sealed acceptance criteria used for every other lane,
blind, in the same batch.

**Purpose:** if `void` scores near `sonnet.base` or `sonnet.ft` on a ticket, that ticket is
answerable from the prompt and model priors alone — eShopOnWeb is a widely-used reference
application and may sit in training data — and any lane's "solved" on that ticket is reported
separately from the headline, not folded into the tool-vs-no-tool comparison. **Predicted `void`
result:** 0 / 4 solved outright (a `void` lane cannot cite a repo-relative file or line, which
the sealed truth files require for a `correct` grade on every ticket here), but partial credit is
plausible on BT-03 specifically — "an unconditional artificial delay near the top of a slow
list endpoint" is a generic enough guess that a model could produce it without ever seeing the
repository. Any `void` score above 0/4 correct-or-partial is reported next to the headline table,
not folded into it.
