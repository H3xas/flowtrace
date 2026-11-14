### Extraction

- The web and the mobile extractor write one `caller_gate` record for each call site that a
  caller decision gates. A record holds the site fields of its call fact, an ordinal, and the
  gates of the call. The extractor finds the site by the source offset of the call, so two
  calls on one line keep their own gates. The `join --against` of an older flowtrace refuses a
  snapshot that holds these records. See `docs/fact-schema.md`.
- The caller decision scanner reads four more forms correctly. A regex literal after the `)`
  of an `if`, `while`, `for` or `with` head gives no decision. An unparenthesized JSX element
  over lines is one operand. The bracket around a `?` tells an optional method type from a
  ternary. An unbraced nested `else` binds once, to the nearest `if`.

### The walk

- In the dependency view, `trace` from a web or mobile start prints a `◇ gate` line under
  each hop that a caller decision gates. The line holds the condition, the kind and arm, the
  outcome of each value and the decision id. `--json` adds `callerGates` to the node. With
  `--seeds`, a `caller cases` block follows the seeds, and `--json` adds `callerCases`. There
  is one case for each distinct gate. A case holds the value that skips the call, the gates
  each path passes first and the routes below the skipped call. Gates change no seed and no
  other reader. `--view source-flow`, `--graph` and `--mermaid` show none.

### Decisions

- A `changed-later` row of `decisions` has `replacedBy`: the commit that replaced the line
  and the listed revision that holds that commit, or `null`. The text row adds
  `replaced by <commit> in <revision>`.
