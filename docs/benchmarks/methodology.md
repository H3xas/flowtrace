# Methodology

Deterministic by construction: every arm is a scripted invocation, every answer captured
verbatim, a fixed scorer grading it. **No model is anywhere in this loop** — nothing here
measures reasoning and nothing produces a patch. It measures what a tool hands an agent for one
question: how much of the answer is in the payload, what it costs in bytes and seconds, and
whether it lets the agent take the next hop without opening a file. For the agent-in-the-loop
question, see [agentic.md](agentic.md).

## Corpora

Two public corpora, pinned by sha in [`bench/corpus.lock`](../../bench/corpus.lock).

| corpus | what it is | tasks it can carry |
|---|---|---|
| `examples/demo-shop` (bundled) | a small ASP.NET Core service plus a Playwright suite, configured as two repo ids | every task, at toy scale — including the repo-boundary join and the evidence overlay |
| `dotnet-architecture/eShopOnWeb` (pinned) | a real ASP.NET Core reference application with a git history | `route-consumer`, `sink`, `affected` at realistic size |

A corpus that cannot exercise a task prints `not_exercised`, never a substitute. Both are small next to a production system — a stated limit on external validity.

## The tasks

| task | the question | truth source |
|---|---|---|
| `route-consumer` | which caller reaches route X? | the `calls` edges keyed X, each caller's `{repo, file, line, ref}` |
| `boundary-join` | does the client literal in repo A hit route R in repo B? | the same edges for positives; the unjoined-call and unjoined-intercept sets for negatives |
| `evidence` | which specs exercise route X? | `cover --area <area> --json` — each route's Cypress and Playwright evidence |
| `affected` | I changed these files — which specs must run? | a published commit list from the pinned corpus, replayed as `affected --diff <sha>^..<sha> --json`, `specs[]` frozen |
| `sink` | does route X reach a publish, a consumer or a database sink? | `trace "<route>" --json` — the walk's sink set, by class |

**Every task but `sink` and `affected` splits in half, and that split makes the run fair.** The
`.a` half is expressible inside one repository — locate this literal's call site, or the specs
naming it — and every arm attempts it; the `.b` half is the join, attempted only by an arm whose
roster row says `yes` or `partial`. `sink` has no `.b` (route-rooted, one repository: level
ground for a single-repository C# tool, and where flowtrace's regexes are weakest) and `affected` no `.a` (no peer takes a diff). Negative tasks expect the empty set; a named row loses precision.

## Sealing the truth

Truth files live under `bench/truth/`, sha256'd into `manifest.json`, written **before any arm
runs**; a task whose truth is re-derived afterwards is void and re-runs from a fresh seal. Two
rules keep a self-derived truth meaningful: **10 % of every task's truth rows are verified by
hand** before sealing — sample, verifier and any correction ship with the seal, one wrong row
voids it — and flowtrace's correctness there is a labelled tautology, the comparison resting on the columns below that are not.

## What is measured

- **Correctness** — recall and precision against sealed truth, both published raw beside the
  grade so a reader can regrade: `correct` at recall ≥ 0.75 with at most 2 rows outside truth,
  `partial` at recall ≥ 0.40, else `wrong`. Negatives invert.
- **Payload** — bytes of stdout as captured, and `tokens = ceil(bytes / 4)`. A stated proxy: with
  no model in the loop this is what a tool *would* put in a context window, not what one spent.
- **Wall time** — `ms_cold`, the first call after that arm's index is built; `ms_warm`, the
  median of three immediate repeats. **Setup cost is its own table, never amortised in.**
- **Follow-up reach** — a row REACHES when it carries a repo-relative path, a 1-based line and a
  provenance token; on the join tasks both ends must reach in one row, since one end is no answer.

## Fairness rules

1. One pin, one clone per arm, from `bench/corpus.lock`, with `origin` removed.
2. Each peer is configured from its own README, per language, and that config is published. No
   undocumented flag is invented to help a peer, and none to hurt one.
3. Single-repository tools are scored on single-repository cells only, decided mechanically by the roster's cross-repo column rather than case by case.
4. **Index sanity check before scoring**: each arm resolves one route symbol and one TypeScript
   symbol known to exist at the pin. An arm that silently indexed nothing is reported as not
   having indexed — never as having answered wrongly.
5. One invocation template per (arm, task), frozen with a sha256 and checked byte-identical at
   run time. No per-task tuning for any arm, flowtrace included.
6. A peer with no multi-repository notion may be run per repository and its payloads
   concatenated — but **the join must be visible in the payload**. If the answer needs the harness
   to notice a string on one side equals one on the other, that arm scores `not_attempted`.
7. flowtrace runs through the same harness, capture, parser contract and scorer as every peer.

## Environment disclosure

Every results document opens with this block, filled in. A result without it is not a result.
The host line is deliberately de-identified: core count, architecture, RAM, and storage
class only — never a CPU vendor or model, disk product, or OS name/version.

```
host      <cores>-core <arch> workstation · <ram> · <storage class>    node  <version>
flowtrace <version or commit sha>            run  <ISO date> · runs <n> · warm repeats <n>
corpora   <corpus id> @ <40-char sha>         one line each, matching bench/corpus.lock
peers     <arm> <version>                     one line each, as the tool itself reports it
setup     <arm> <install ms> <index ms> <bytes on disk> <network/JVM/container/LSP needed?>
commands  <the exact argv of every step, in order>
```

## Re-running it

[`bench/README.md`](../../bench/README.md) covers fetching each pinned corpus, verifying it
against `bench/corpus.lock`, pointing the verbs at it, and timing them with `hyperfine`. A run
that cannot reproduce a published number on the same pin is a bug report worth filing.
