# The optional code index

The walk reads facts first. When the facts say nothing about a class — an interface with no
registration in the extracted set, a call into a repository nobody configured — the node
prints `unresolved`, and that is a complete answer: flowtrace does not guess.

Configure a code index and it gets one more hop instead. flowtrace shells out to `scout`,
a standalone code-index CLI, for three questions:

| question | scout command | used by |
|---|---|---|
| what does this symbol reference? | `refs <symbol> --out` | `trace`, to continue past an unresolved node |
| who references this symbol? | `refs <symbol> --json` | `affected --dotnet-filter`, to find test classes |
| what does changing this file reach? | `impact <file> --hops N --json` | `affected --hops`, to widen a changed set |

## Pointing flowtrace at it

Either in the configuration file:

```json
"scout": { "bin": "devscout" }
```

or in the environment, which wins when the file omits the key:

```
export FLOWTRACE_SCOUT_BIN=devscout
```

The value is a path — absolute, or relative to the configuration file — or a bare command
name, which is looked up on `PATH` at spawn time. Nothing in flowtrace assumes an install
location.

Then mark the repositories the index covers:

```json
{ "id": "api", "kind": "backend", "root": "shop-api", "scout": true }
```

Only a repository with `scout: true` is ever consulted.

## Concurrent lookups

The query verbs that read the index run their lookups as child processes, a bounded number at
the same time. A walk that needs a lookup the cache does not hold answers it from the index in
the next pass, until a pass needs nothing new. The verb output does not change: the walk order,
the depth, the fan-out caps and the printed lines stay as they are.

Two inputs set the limit:

| input | meaning |
|---|---|
| `scout.concurrency` in the configuration file | the limit, when the file sets it |
| `FLOWTRACE_SCOUT_CONCURRENCY` in the environment | the limit, when the file does not set `scout.concurrency` |

The file value wins over the variable. A blank variable counts as absent. When neither sets the
limit, it is `min(8, os.availableParallelism())`. A limit of 1 runs one lookup at a time, which
gives the serial order back without a release. Each value must be an integer of at least 1, and
a value that is not one fails the configuration load with one message that names the key or the
variable, before any verb runs.

## Isolation

Every invocation runs with `SCOUT_REGISTRY` and `SCOUT_CONTENT_DB` forced to files under
flowtrace's own `out` directory, so a trace never reads or writes the index stores you use
interactively.

## Failure is not an error

The wrapper never throws. A missing binary, a repository with no index, a failed run and a
reply that is no whole answer all produce an empty edge list marked `unavailable`, and the
walk prints the node as unresolved with `graph: unavailable` beside it. A trace without an
index is a smaller trace, not a failed one.

An unknown symbol is an answer for an outbound lookup. The index says that it holds no such
symbol, and the edge list is empty and not marked `unavailable`. The node still has no graph
edges, but its stop reads `index-no-match` (or `not-declared` for a class that no
repository declares), not `provider-unavailable`. The inbound and impact lookups keep the
older rule: for them, a reply that names no match is marked `unavailable`.

A `refs --out` reply is an answer only in two forms. The first is the index's own
`no symbol matches` line. The second is an `outbound:` section in which each kind lists as
many rows as its header line shows. Any other reply, also one with exit 0, is a lookup that
the index did not answer.
