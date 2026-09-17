# Pinned edge export

`flowtrace-edges.json` in this directory is `join --export-edges` run over the worked
example (`examples/demo-shop`), committed so a code index can vendor a real file instead
of inventing one from the format description alone. The worked example has four
repositories: two backends (`api`, `stock`), a web client (`shopfront`, with a Cypress
suite) and a Playwright suite (`e2e`). Between them the export carries every edge kind the
example can join:

- `calls`: the client's gateway service calling a `stock` route.
- `tests`: the client's Cypress spec intercepting that same `stock` route.
- `publishes` and `consumes`: messages published and consumed inside `api`, and one
  published in `stock` and consumed in `api`.

## Format

- **Format id**: `flowtrace-edges` (the `format` field). A code index should refuse
  anything else rather than guess.
- **Schema version**: `1` (the `schemaVersion` field, and `provenance.formatVersion`).
  Every record is exactly `{ kind, from, to, key, provenance }` with `additionalProperties:
  false`; `from`/`to` are exactly `{ repo, ref, file, line }`; a message end carries
  `repo: "message"` with `file`/`line` both `null`.

## What a `tests` edge claims

A `tests` record's `from` end is a spec, not code: `ref` is the test's title and `file` the
spec that declares the intercept, where a `calls` record's `from` is a service method and the
file it is written in. It states that the spec's intercept pattern matches that route action.
It never states that the route's interior ran: an intercept can stub the response entirely,
and nothing in a static export observed an execution. Read it as "a spec names this route",
not as coverage of what the route does.

For a `web` repository the spec's `file` is relative to its configured `cypressSubpath`, not
to the repository root: the `shopfront` spec here is `e2e/reservations.cy.ts`, which sits at
`shopfront/cypress/e2e/reservations.cy.ts`.

## Provenance

- **`provenance.id`**: sha1 over `[producer, formatVersion, factSets]`, as JSON, first 16
  hex characters. It flips whenever any fact-set identity does: a facts change, a
  re-extraction at another commit, a different working-tree state, a different facts
  provider, or a tool upgrade. An importer keys on it to decide whether to drop and replace
  previously-imported rows wholesale; it says nothing about the record shape, which
  `format` and `schemaVersion` already pin. Every record's `provenance` is that same id.
- **`provenance.factSets`**: one identity per fact set, in repository order: `repo`, `kind`,
  `generatedFrom`, the revision witness (`headSha`, `dirty`, `dirtyDigest`, `fileCount`),
  `titles` when the title collector ran, `provider` when a facts provider contributed, and
  `digest`, a sha1 of the facts themselves.
  - `headSha` is always present. `null` means the facts were extracted from a root that is
    not a git checkout and carry no revision witness; it is never equal to a commit.
  - `provider` names the second producer by `producer`, `version`, `merge`, `supplied`,
    `kept`, `replaced`, `comparison` and `digest`, a sha1 of the provider's own facts. It
    never carries the file or command the facts were read from, so the same facts give the
    same id wherever the checkout sits and no filesystem path is published.
- **`provenance.factSetsWithoutEdges`**: the repositories whose fact set is in `factSets`
  but that no record names at either end. Here that is `e2e`: `join` builds a `tests` edge
  from a Cypress intercept, not from a Playwright request, so the Playwright suite
  contributes no edge and the export says so rather than leaving it to read as a witness for
  edges it never produced.

## The two checks CI runs

The worked-example CI job regenerates this file and runs two different checks on it.

- **Repeat export**: two consecutive `join --export-edges` runs over the same facts are
  compared with `cmp`. This is literal byte equality within one checkout, and says only that
  the export is deterministic.
- **Pinned export**: `scripts/check-pinned-export.mjs`, run from inside the checkout the
  regeneration was extracted from, compares it with this copy. This is canonical structural
  and provenance equality against the pinned copy, not byte equality. The copy was extracted
  at an earlier commit, so `provenance.id`, each
  record's `provenance`, and each fact set's `headSha`, `dirty` and `dirtyDigest` are not
  compared with it. Each is bound instead: the id is re-derived from its own block, every
  record's `provenance` must equal it, the regeneration's `headSha` must be the checkout's
  HEAD, and `dirty` must be a boolean whose `dirtyDigest` is the empty-input sha1 exactly
  when the tree was clean. Everything else, `fileCount` and every `provider` field included,
  must match, and a failure names each field that differs. Outside a checkout it refuses
  instead of comparing: an extraction with no git root carries no `headSha`, `dirty` or
  `fileCount`, so there is nothing to bind the regeneration to and nothing to compare with a
  copy that has one. The checks a file must pass on its own, with no checkout, are also run by
  the public contract suite (`selftest/export-invariants.js`).
