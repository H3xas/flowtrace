### The walk

- `trace <start> --view source-flow` shows the calls of each body at their own call sites, in
  the order the source supports. Each line names the call site as `file:line:column` first and
  the callee declaration second. Guard arms, loop bodies, `await`, a concurrent launch and its
  join, and callbacks show as marks. A call whose order the facts cannot place goes into an
  unknown-order group that names the reason. `--html` writes the same tree. See
  `docs/source-flow.md`.
- `--view dependency` is the default. Its tree starts with one line that says the calls are
  grouped by callee and are not in call order. No other dependency output changes.
- `trace --json` adds `view`. Under `--view source-flow` it also adds `sourceFlow`, with its own
  `schemaVersion` and `evidence: "static"`. The nodes, edges and `stats` are the same in both
  views. `--graph` and `--mermaid` with `--view source-flow` exit 2.

### Extraction

- A `backend` or `web` repository gives each C# `method_call` and each web call fact a
  `column` and a `control` field, and the facts header declares `controlEvidence: 1`. Existing
  fields keep their values. A fact set from an older extraction keeps its dependency view, and
  under `--view source-flow` its bodies read `no-control-evidence` until the next `extract`.
  See `docs/fact-schema.md`.
