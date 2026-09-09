# Pinned edge export

`flowtrace-edges.json` in this directory is `join --export-edges` run over the worked
example (`examples/demo-shop`), committed so a code index can vendor a real file instead
of inventing one from the format description alone. The worked-example CI step
regenerates it on every run and checks the regeneration against this copy.

- **Format id**: `flowtrace-edges` (the `format` field). A code index should refuse
  anything else rather than guess.
- **Schema version**: `1` (the `schemaVersion` field, and `provenance.formatVersion`).
  Every record is exactly `{ kind, from, to, key, provenance }` with `additionalProperties:
  false`; `from`/`to` are exactly `{ repo, ref, file, line }`; a message end carries
  `repo: "message"` with `file`/`line` both `null`.
- **`provenance.id`**: a digest over the producer's name and version, the format version,
  and every fact set's identity — which repository, which extractor, the git commit and
  dirty state the facts were read at, and a digest of the facts themselves. It flips
  whenever any of those does: a facts change, a re-extraction at another commit, a
  different working-tree state, or a tool upgrade. An importer keys on it to decide
  whether to drop and replace previously-imported rows wholesale; it says nothing about
  the record shape, which `format` and `schemaVersion` already pin. Because it is derived
  from the commit this copy happened to be extracted at, it — and the `headSha`/`dirty`/
  `dirtyDigest`/`fileCount` fields it is built from — will differ from what regenerating
  this file at a later commit produces even when nothing about the edges themselves has
  changed; the worked-example CI check accounts for exactly that when it compares the two.
