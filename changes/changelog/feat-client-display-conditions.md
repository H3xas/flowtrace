### Extraction

- The mobile and web extractors record the display conditions of component templates, and
  the values that a parent passes to a child component. Five new fact types hold them:
  `display_condition`, `client_transfer`, `client_assignment`, `client_read` and
  `client_scan`. Each read of a field has traces back to the place that gives the value. A
  trace that the reader cannot follow ends with a named reason. Each template region states whether
  the reader read all of it. The reader holds no list of field names. No command changes.
  See `docs/fact-schema.md`.
- The new facts join the `facts` array of each fact file. So a fact set extracted again has
  a new facts digest, and the identities that hash the digest change with it. These are the
  `status.identity` of `trace`, `span` and `chains`, the `provenance.id` of an edge export,
  and the set identities of a `join --snapshot` document. A snapshot taken before reports
  drift for that set.
- The fact count of a set changes with its facts, in the `extract` line and in the "Fact
  producers" table of the `render` report. A file whose only facts are new facts is a file
  that the extractor read. So `decisions` reads that file with blame, and a member-scoped
  `affected` widening keeps an edge to it.
