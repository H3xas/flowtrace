# Results — YYYY-MM

<!-- Copy this file to results/YYYY-MM.md and delete every instruction comment before publishing.
     The rules below are not optional; they are what makes a number from this repository worth
     reading:
     - Integrity caveats come FIRST, before any number.
     - Every number carries the command that produced it and the corpus pin it ran against.
     - Findings are published in both directions: a round the tool loses is published with the
       same prominence as a round it wins. A negative result is a result.
     - One run per cell is labelled preliminary in the banner; a claim requires the 5-run
       protocol in methodology.md.
     - A refuted claim from an earlier document is carried forward marked refuted, never
       deleted. -->

> **Status: preliminary / N-run series / superseded by results/YYYY-MM.md.** State the runs per
> cell and, if preliminary, exactly what would upgrade it.

## Environment

| field | value |
| --- | --- |
| flowtrace | version + the commit the run used |
| host | machine class; note if not a CI runner |
| Node | version |
| peer versions | one line per arm, exact versions |
| corpus | name @ sha, matching `bench/corpus.lock` |
| date | run date |

## Run integrity — read before any number

<!-- Attrition (lanes lost and why), censoring, whether budgets were enforced or advisory,
     blinding strength (blind to model? blind to arm?), any reconstructed figures, any lane
     that did not actually use its assigned tool. If a category has nothing to report, write
     "none" — an omitted category reads as unchecked, not clean. -->

## <Lane name — one section per lane run>

<!-- Lanes this template anticipates: the deterministic pipeline (extract/join/trace/span on
     the pinned corpus), the code-graph peer matrix (roster in peers.md), the test-selection
     lane (dotnet-affected, Nx affected, VSTest TIA — table in peers.md), CodeQL once its
     public-corpus arm runs, and the agentic protocol (agentic.md). Delete what did not run;
     never fill a lane from documentation claims. -->

### Protocol

<!-- What was asked, verbatim or by seal: point at bench/truth/<lane>/ manifest + sealed
     preregistration. Arms, budgets, judge and its blinding, all fixed before the first lane. -->

### Per-cell results

| task / ticket | arm A | arm B | ... |
| --- | --- | --- | --- |

### Metrics

<!-- Only metrics with a sealed denominator: precision/recall against the sealed truth, wall
     time, tokens where a model is in the loop. Under each table, the exact command that
     produced the raw rows. Label every proxy metric as a proxy. -->

## Findings — both directions

<!-- Bullets. Each claim scoped to this run ("on this corpus, this run"), never wider. What cut
     against flowtrace listed with the same prominence as what favoured it. Pre-registered
     predictions compared against outcomes, misses stated plainly. -->

## Refuted and retired claims

<!-- Carried forward from earlier result documents: claim, where it was made, what refuted it.
     This section only grows. -->

## What would change these findings

<!-- The registered next measurement: more runs, a bigger corpus, the missing arm. If nothing
     is registered, say the findings are final for this series. -->
