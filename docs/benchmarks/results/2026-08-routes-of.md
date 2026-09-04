# Reverse-reachability agentic result — 2026-08-30

> **Preliminary — one run per cell, and no valid tool contrast.** This document publishes
> two four-lane rounds exactly because neither produced a valid `routes-of` tool cell. It is
> a harness result, not evidence that the verb helps or hurts an agent. The sealed
> [registration](../../../bench/truth/routes-of/preregistration.md),
> [prompt](../../../bench/truth/routes-of/prompt.md),
> [truth](../../../bench/truth/routes-of/truth.json), and
> [correction registration](../../../bench/truth/routes-of/rerun/preregistration.md) remain
> unchanged.

## Environment

```
host        12-core arm64 workstation · 64 GiB RAM · local SSD    node v23.11.0
flowtrace   uncommitted pre-release development tree; no commit sha
run         2026-08-30 · one run per lane · model API, no in-lane web access
models      claude-sonnet-5 (max) · claude-opus-5 (xhigh)
harness     Claude Code 2.1.251 · restricted mode · streamed transcript in correction
corpora     eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606
            demo-shop @ bundled with the development tree under test, no independent sha
setup       tool lanes received prebuilt facts; extraction time is excluded
```

Fresh corpus copies were used per lane. All four pinned checkouts were clean after the
correction, and the four bundled-corpus copies remained byte-identical. The model-facing
prompt prohibited edits, installs, and network use.

## Run integrity — read before the scores

The first round used single-result JSON capture. Its tool lanes received the executable and
the tool paragraph, but restricted command policy denied every attempted invocation. That
capture retained denial counts but not successful read-tool calls or distinct files, and its
exact driver argv was not retained. The two tool cells have `tool_integrity: none`; the round
does not meet the agentic protocol's transcript requirements.

The pre-registered correction switched to streamed JSON and allowed the exact command pattern
`flowtrace routes-of *` while keeping restricted mode. Both tool-lane models first probed
`flowtrace --help`, which was outside that exact pattern and was denied. Each then completed
the task with ordinary repository-reading tools and never issued an allowed `routes-of`
query. The correction registration requires at least one completed query, so both tool cells
again have `tool_integrity: none`. They are invalid and were not retried.

There is a second protocol defect. The registered `publish-key` command scopes the literal to
repository `api`, but that repository contains both the publish fact and the consumer fact.
The implemented command therefore returns a deterministic ambiguity between
`src/Messaging/OrderPlacedConsumer.cs:6` and `src/Services/OrderService.cs:43`; the scope does
not isolate the publish site as the registration claimed. The truth was not changed after the
run. This cell cannot measure a direct one-command answer under the sealed prompt.

Finally, every lane wrapped its answer in a Markdown fence; one also emitted prose before the
fence. The sealed parser contract says JSON only and gives malformed cells zero. The official
strict score is therefore 0/8 for every otherwise scoreable lane. Fence-stripped diagnostic
scores appear separately and do not replace the official scores.

## Round 1

Token columns are the Claude Code counters: new input, cache-created input, cache-read input,
then output. The first-round capture did not retain tool-call or distinct-file counts.

| lane | tool integrity | strict | diagnostic | wall ms | turns | tokens: in / create / read / out | cost USD |
|---|---|---:|---:|---:|---:|---:|---:|
| `sonnet.base` | n/a | 0/8 | 7/8 | 410,857 | 35 | 36 / 39,644 / 505,848 / 37,331 | 0.6345 |
| `sonnet.routes` | none — invalid | 0/8 | 7/8 | 176,934 | 29 | 28 / 59,826 / 601,482 / 15,958 | 0.5207 |
| `opus.base` | n/a | 0/8 | 4/8 | 79,079 | 24 | 28 / 16,165 / 154,316 / 6,262 | 0.3968 |
| `opus.routes` | none — invalid | 0/8 | 7/8 | 104,893 | 23 | 26 / 28,836 / 189,384 / 7,951 | 0.5834 |

Recorded command denials were 0, 2, 3, and 4 in table order. They are not total tool-call
counts.

The diagnostic scoring below strips only the outer fence, then applies the sealed two points
per input. It shows why the malformed outputs would otherwise differ.

| lane | body line | repository symbol | publish key | route template | total |
|---|---:|---:|---:|---:|---:|
| `sonnet.base` | 1/2 | 2/2 | 2/2 | 2/2 | 7/8 |
| `sonnet.routes` | 1/2 | 2/2 | 2/2 | 2/2 | 7/8 |
| `opus.base` | 1/2 | 1/2 | 1/2 | 1/2 | 4/8 |
| `opus.routes` | 1/2 | 2/2 | 2/2 | 2/2 | 7/8 |

The three 7/8 lanes returned correct provenance but left the body-line route as the raw
`Order/Detail/{orderId}` template instead of the normalized `order/detail/*` key. The Opus
baseline retained raw or leading-slash route spellings for all four inputs, so only its four
provenance points survived diagnostic scoring.

## Harness correction

`files` counts distinct paths supplied to the `Read` tool. Shell grep results are not silently
converted into opened-file counts.

| lane | tool integrity | strict | diagnostic | wall ms | turns | calls | files | denials | tokens: in / create / read / out | cost USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `sonnet.base` | n/a | 0/8 | 2/8 | 432,542 | 36 | 35 | 14 | 2 | 36 / 57,417 / 554,302 / 39,143 | 0.7334 |
| `sonnet.routes` | none — invalid | 0/8 | 7/8 | 225,571 | 38 | 37 | 9 | 3 | 52 / 54,097 / 825,295 / 19,891 | 0.5819 |
| `opus.base` | n/a | 0/8 | 0/8 | 109,178 | 21 | 20 | 11 | 1 | 16 / 22,886 / 90,758 / 8,738 | 0.4941 |
| `opus.routes` | none — invalid | 0/8 | 7/8 | 104,457 | 31 | 30 | 14 | 2 | 32 / 24,997 / 241,511 / 7,880 | 0.5693 |

| lane | body line | repository symbol | publish key | route template | total |
|---|---:|---:|---:|---:|---:|
| `sonnet.base` | 0/2 | 1/2 | 1/2 | 0/2 | 2/8 |
| `sonnet.routes` | 1/2 | 2/2 | 2/2 | 2/2 | 7/8 |
| `opus.base` | 0/2 | 0/2 | 0/2 | 0/2 | 0/8 |
| `opus.routes` | 1/2 | 2/2 | 2/2 | 2/2 | 7/8 |

Both correction baselines confused handler lines with route-declaration lines: 32 instead of
31 in the pinned corpus and 37 instead of 36 in the bundled corpus. The Sonnet baseline also
treated the leading slash on the registered route-template literal as an unresolved source
string; the Opus baseline returned non-normalized route strings throughout. Both nominal tool
arms found the declared provenance manually, but their tool-integrity failure excludes them
from an arm comparison.

## Correction command

The placeholder below expands byte-for-byte to the sealed base prompt. Tool lanes append the
sealed tool paragraph and prepend `.benchmark/bin` to `PATH`. Sonnet uses `--model sonnet
--effort max`; Opus uses `--model opus --effort xhigh`.

```
claude --restricted --strict-mcp-config --disable-slash-commands \
  --tools 'Read,Glob,Grep,Bash' \
  --allowedTools 'Read Glob Grep Bash(pwd) Bash(ls *) Bash(rg *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git grep *) Bash(git ls-files *) Bash(git rev-parse *) Bash(git blame *)' \
  --permission-mode dontAsk --no-session-persistence \
  --model <model> --effort <effort> --max-budget-usd 2 \
  --output-format stream-json --verbose -p '<sealed base prompt>'
```

The tool-lane allowlist adds `Bash(flowtrace routes-of *)`. Restricted mode's own read-only
shell policy also admitted ordinary inspection commands; write and web tools were unavailable.

## Finding

This run establishes no agentic advantage or disadvantage for `routes-of`. It establishes
three narrower facts: the first harness did not expose a usable tool transcript, the correction
still produced no completed tool query, and the registered publish input conflicts with the
command's honest ambiguity contract. A future comparison needs a new seal, not another retry:
its tool policy must decide whether help is available, and its publish input must identify one
fact without changing the implementation to favor the benchmark.
