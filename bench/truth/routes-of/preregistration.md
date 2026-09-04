# Reverse-reachability agentic pre-registration

**Sealed:** 2026-08-30, before any benchmark lane ran. The inputs, truth, arms,
scoring, and run count below are fixed for this run. An invalid cell is reported as
invalid; it is not replaced after results are visible.

## Question

Does an agent given a grep-shaped point identify the complete set of HTTP entry routes
above that point more reliably or with less search when `flowtrace routes-of` is
available than when it has only ordinary repository-reading tools?

This is a narrow retrieval band, not a patch-writing benchmark. It extends the agentic
protocol in [docs/benchmarks/agentic.md](../../../docs/benchmarks/agentic.md) with one
read-only task containing four inputs. The corpus-access, arm-pairing, capture,
single-run, and honest-reporting rules remain the same.

## Corpora

- `eshoponweb` at `4da8212117e87d808d4bbc7da6286fd2147ce606`, matching
  [`bench/corpus.lock`](../../corpus.lock).
- The bundled `examples/demo-shop` from the same development tree as the verb under
  test. It has no independent corpus commit; that limitation must appear with results.

Each lane receives fresh read-only copies. The tool arm also receives facts extracted
before the lane starts and a `flowtrace` executable. The baseline receives neither the
executable nor those derived facts. No lane receives another lane's transcript or answer.

## Sealed inputs

| name | corpus | input | forced mode | why included |
|---|---|---|---|---|
| `body-line` | eshoponweb | `Web/Controllers/OrderController.cs:37` | automatic | a body line copied from a grep or stack-frame result |
| `repository-symbol` | demo-shop | `OrderRepository.SaveOrder` | `--symbol` | an exact repository method declaration |
| `publish-key` | demo-shop | `OrderPlacedMessage` | `--literal --repo api` | a publish key copied from a call site, scoped away from its consumer declaration |
| `route-template` | demo-shop | `/orders/v1/checkout` | `--literal` | an exact route-template string |

Truth is the route set found by exhaustive forward walks of every entry route over the
sealed fact sets, plus each route declaration's repository-relative file and line. The
truth file is hashed before any lane begins.

## Arms and run count

One run per lane; four lanes total.

| lane | model | effort | tools |
|---|---|---|---|
| `sonnet.base` | Claude Sonnet 5 | max | read, glob, grep, shell, git |
| `sonnet.routes` | Claude Sonnet 5 | max | the same, plus `flowtrace routes-of` and its prebuilt facts |
| `opus.base` | Claude Opus 5 | xhigh | read, glob, grep, shell, git |
| `opus.routes` | Claude Opus 5 | xhigh | the same, plus `flowtrace routes-of` and its prebuilt facts |

The base prompt is byte-identical across lanes. Tool lanes receive only the extra tool
availability paragraph recorded in `prompt.md`. Each lane has a 150k-token hard ceiling,
the ceiling used by the existing agentic protocol. A stopped or censored lane is a result,
not a retry.

## Scoring

Each of the four inputs is scored independently against `truth.json`:

- **route set (1 point):** exact normalized route keys, with zero missing and zero extra;
- **provenance (1 point):** every returned route carries its correct repository-relative
  declaration file and 1-based line.

Maximum: 8 points per lane. `correct` is 8, `partial` is 4–7, and `wrong` is 0–3.
Malformed output receives zero for cells that cannot be parsed. Empty output is not
silently interpreted as an empty route set.

Also captured without grading thresholds: input/output tokens, wall time, tool-call count,
distinct files opened, whether a tool lane actually invoked `routes-of`, and any integrity
failure. There is no pre-registered success margin. A tie or baseline win is published with
the same prominence as a tool-arm win.

## Limits fixed before the run

- Four inputs and one repetition cannot distinguish a durable effect from model variance.
- The bundled corpus is deliberately small and is not independently pinned.
- Tool arms receive a prebuilt fact index, while baseline search is index-free; setup cost
  is disclosed separately and not hidden in query time.
- The task asks for retrieval, not a patch, so it measures only the reverse-search band of
  the broader agentic protocol.
- The answer is static reachability over extracted facts, not runtime execution.
