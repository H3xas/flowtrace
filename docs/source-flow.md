# Source-flow view

`flowtrace trace <start> --view source-flow` shows the calls of each body at their own call
sites, in the order the source supports. The default view groups calls by callee and is not in
call order. Both views read the same walk and the same facts. Only the projection differs.

The view is static. It states where a call is written, not that the program ran. A body whose
facts cannot place the calls goes into an unknown-order group with a reason.

## The flag

```text
flowtrace trace <start> [--view dependency|source-flow] [--seeds] [--json] [--html <file>]
```

`dependency` is the default. Each other value exits 2, writes no stdout and names the two
values on stderr. `--graph` and `--mermaid` have no source-flow view and exit 2 with it.

Both views start with the same result status lines: the start, the freshness of the facts and
any limits of the answer. A blank line follows. Then one line names the projection:

```text
dependency view: calls grouped by callee, not in call order (--view source-flow shows call order)
source-flow view: calls at their call sites, in the order the source supports (static evidence)
```

## What a line says

An invocation line starts with its call site, `file:line:column`. Then come ` → `, the callee
declaration, the repository, the declaration site and the hop tag. Marks follow.

```text
src/Services/BoardingService.cs:21:13  ◇ if (request.PassengerId == null)
└─  then
   └─ src/Services/BoardingService.cs:23:23 → PassengerAccess.ResolveIdentityAsync  backend  src/Access/PassengerAccess.cs:15  [body]  await
src/Services/BoardingService.cs:26:19 → RouteLookup.FindRouteAsync  backend  src/Lookup/RouteLookup.cs:13  [body]  await
```

| mark | means |
|---|---|
| `◇ <head>` | a guard, a switch, a try, or a conditional expression |
| `↻ <head>` | a loop body, repeatable, with no iteration count |
| `⌁ callback <form> to <host>` | a callback whose scheduling the source does not state |
| `⋈ <form> (<locals>)` | a join: `await`, `Task.WhenAll`, `Task.WhenAny`, `Promise.all`, `Promise.allSettled` |
| `await` | the call heads the chain an `await` operand is |
| `launch <local>` | the call starts a task that a join names |
| `launched, not joined` | the call starts a task that nothing joins |
| `↑ <label> (body shown at <site>)` | the callee body printed above, under the call at `<site>` |
| `↑ <label> (body hidden at <site>, use --expand-infra)` | the callee body is inside a shared call that is collapsed at `<site>` |
| `↺ <label> (recursion, active at <site>)` | the call re-enters the body that the call at `<site>` entered, or `the start` |
| `infrastructure: <n> invocations, <m> walk stops hidden (use --expand-infra)` | a shared call, collapsed: its calls do not print |
| `infrastructure` | a shared call under `--expand-infra`: its calls print under it |
| `stop: <reason>` | the walk stopped here: `unresolved-target`, `depth`, `node-budget`, `unscoped-hop`, `code-index-unavailable` or `cycle-guard` |
| `? order unknown: <reason>` | a group of calls the facts cannot order |

The trailer counts invocations, bodies, unknown-order groups and walk stops. If the walk ran
out of nodes, the trailer adds `node budget reached`.

A shared call is a call into a body that many classes take in their constructors, such as an
audit trail or a logger. It collapses to its own line, at its own call site, and the mark
states how many invocations and walk stops it hides. With `--expand-infra`, the same line
prints and its calls print under it. A later call to a body inside a collapsed shared call
says where that body is hidden. The JSON is the same with and without `--expand-infra`.

## Order

An invocation is one call occurrence. Two calls to one method are two invocations. Two calls
on one line are two invocations, told apart by their columns. A callee declared once is one
body, and a later call points back at it.

Order comes only from the call site. Within one frame path, steps sort by line, column and
occurrence. A construct sorts by its own site. The arms of an `if`, `switch` or conditional
expression are alternatives. A loop body is repeatable. A join sorts at its own site, and
never before the last task it names. A join written inside a guard, loop, try part or
callback prints in that construct. The facts state the frames around the join itself. A
`.then` or `.catch` written on a `Promise.all` or `Promise.allSettled` follows that join. A
pipeline whose steps the source registers keeps that run order.

Nothing sorts by callee name, declaration line or registration order.

## Unknown order

A group names one reason from a closed list:

| reason | stated when |
|---|---|
| `no-control-evidence` | the fact set declares no control-evidence version, so run `extract` again |
| `provider-facts` | an external provider supplied the call |
| `mobile-body` | the body belongs to a mobile repository |
| `control-evidence-unreadable` | a field the projection cannot read, two calls that state one frame or one join differently, or a join that names a task no call of the body carries. All calls of the body go into the group, and the detail names the field |
| `code-index` | a hop the code index made, whose order it does not state |
| `publish`, `bus-consumer`, `worker`, `push`, `http-out` | a message or network hop |
| `independent-entries` | entries the source states separately |
| `interface-fanout` | a call that fans out to known implementations |
| `unscoped` | under `--unscoped`, the calls the class makes in its other bodies. Each is an `unscoped-hop` stop |
| `async-form` | `Promise.race`, `Promise.any` and other async forms |
| `unclassified-hop` | a hop kind the projection has no rule for |

## JSON

`--json` adds `view` as its first key. Under `--view source-flow` it also adds `sourceFlow` as
its last key:

```json
{
  "view": "source-flow",
  "root": { },
  "sourceFlow": {
    "schemaVersion": 1,
    "evidence": "static",
    "controlEvidence": { "backend": 1, "web": 1 },
    "walk": { "budgetHit": false },
    "root": { "kind": "hop", "declaration": { }, "body": { "steps": [] } },
    "frontier": [{ "reason": "depth", "node": "n9", "site": { } }],
    "counts": { "bodies": 2, "invocations": 10, "unordered": 0, "frontier": 7 }
  }
}
```

Without `view` and `sourceFlow`, the dependency answer and the source-flow answer are
byte-equal. `sourceFlow` has its own `schemaVersion`, so it can gain keys without changing the
walk's answer.

### The `sourceFlow` member

- `controlEvidence` maps each repository to the version its facts declare, or `null`.
- `walk.budgetHit` is the walk's node-budget state. If the stats state whether the walk
  finished, `walk.complete` appears.
- `root` is the first hop. Its `body.steps` are the calls of that body.
- `frontier` lists every walk stop, with its reason, node, site and the invocation that
  reached it.
- `counts` counts bodies, invocations, unknown-order groups and frontier stops.

A step is one of:

- `invocation`: `id`, `factSet`, `occurrence`, `site`, `caller`, `declaration`, `node`,
  optional `await`, `task`, `infra`, `hidden`, `continuations`, and a `target`. A shared call
has `infra: true` and `hidden: { invocations, stops }`, the counts that a collapsed line
states.
- `branch`: `form`, `id`, `site`, `text`, `arms` (each with its own `steps`).
- `try`: `id`, `site`, `text`, `body`, `catches`, `finally`.
- `loop`: `form`, `id`, `site`, `text`, `repeatable`, `steps`.
- `join`: `form`, `id`, `site`, `tasks`, optional `continuations`.
- `callback`: `form`, `id`, `site`, `host`, `scheduling`, `steps`.
- `unordered`: `reason`, optional `form` and `detail`, `sites`, `steps`.
- a hop: `node`, `declaration`, `site`, optional `body`.

An invocation `id` is `inv-` and the first 16 hex characters of a sha1. The sha1 covers the
fact-set digest, the caller declaration, the call site and the occurrence. Two calls at two
sites are always two ids.

A `target` is one of:

- `{ body }`: the callee's body, printed here.
- `{ see, reason }`: a body shown above (`shown-above`) or active (`recursion`). `see` is the
  id of the invocation that holds the body, or the root node id for the start.
- `{ hop }`: a hop the call reaches.
- `{ sink: true }`: a data sink.
- `{ stop }`: the walk stopped at this call.
- `{ targets, order }`: a pipeline whose steps run in `step-composition` order.

## HTML

`--html <file> --view source-flow` writes a self-contained page. Its tree text is byte-equal to
the terminal tree, and it fetches nothing.
