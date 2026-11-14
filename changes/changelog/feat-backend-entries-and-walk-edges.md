### Extraction

- A `backend` repository writes `entry` facts for SignalR hub methods, actor message
  handlers and the base classes that the new `entryPoints` configuration key names. It also
  writes facts for mapper profiles and calls, background queue calls, keyed collections and
  their calls, and gateway route tables, delegating handlers and middleware. The new
  `workerPatterns.backgroundCalls` key names queue calls that the extractor cannot find by
  their shape. A `loop_stop` whose stop is a block that ends in its jump carries
  `rejectFrom` and `rejectTo`. See [docs/fact-schema.md](docs/fact-schema.md#backend).

### The walk

- A mapper call reaches the converters, resolvers and actions of its maps (via `mapper`).
  Work handed to a background queue is one queue node with the delegate's calls under it
  (via `queued`). A call through a keyed collection reaches each implementation (via
  `keyed_dispatch`, inferred), and a constant key keeps only the implementations that match
  it. A route that a gateway table forwards walks the gateway middleware and handlers, then
  the downstream call as an `http_out` sink (via `gateway`).
- In a pipeline loop that can stop, each step after the first carries `conditional: true`
  and prints `conditional`. A block stop is read: the statements before its jump run under
  each step's reject, and the reject seed prints them as `before the reject`. When only the
  stop rule is unreadable, the steps are still walked in registration order and the
  pipeline stays `unresolved: stop-rule`.

### `routes-of`

- `routes-of --json` carries `schemaVersion: 2`. A route that reaches the point only through
  a global filter is now answered, with a `gate` hop in its witness. The walk also starts at
  each backend entry, and the entries that reach the point are listed in `entries`, with
  `entryCount` and `completeness.entriesWalked`. The verdict is `entries` when only entries
  reach the point. An entry walk that does not complete gives the `incomplete` verdict.
