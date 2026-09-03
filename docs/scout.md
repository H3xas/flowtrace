# The optional code index

The walk reads facts first. When the facts say nothing about a class — an interface with no
registration in the extracted set, a call into a repository nobody configured — the node
prints `unresolved`, and that is a complete answer: flowtrace does not guess.

Configure a code index and it gets one more hop instead. flowtrace shells out to `scout`,
a standalone code-index CLI, for three questions:

| question | scout command | used by |
|---|---|---|
| what does this symbol reference? | `refs <symbol>` | `trace`, to continue past an unresolved node |
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

## Isolation

Every invocation runs with `SCOUT_REGISTRY` and `SCOUT_CONTENT_DB` forced to files under
flowtrace's own `out` directory, so a trace never reads or writes the index stores you use
interactively.

## Failure is not an error

The wrapper never throws. A missing binary, a repository with no index, a non-zero exit, an
unknown symbol — all produce an empty edge list marked `unavailable`, and the walk prints
the node as unresolved with `graph: unavailable` beside it. A trace without an index is a
smaller trace, not a failed one.
