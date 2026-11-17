### Reports

- The `trace --html` tree page of the dependency view puts the status lines, the frontier
  lines and the dependency label into its tree text, in the order that the terminal prints
  them. The page without its markup on the tree-text runs is again byte-identical to the
  terminal tree, with and without `--cover-overlay`. The page still shows the result status
  and the frontier in its status note. The source-flow view does not change.
- The `span` page and the component `span` page show the start line of the result status
  without its `file:line`. The location sits in its own expander, "where the walk starts",
  next to the frontier expander. Two runs over the same facts give the same bytes. No flag
  changes.

### Extraction

- A mobile `client_transfer` whose child tag has no `-` now names its component. If one
  component declares a plain tag such as `<glow>`, the fact has `targetComponent` and
  `targetFile`, and the child's `client_read` trace crosses to the binding that the parent
  wrote on the tag, as `docs/fact-schema.md` states. Before, only a tag with a `-` found
  its component. The match is by the declared selector, so a native tag that has the same
  name as a declared plain selector also matches. The facts of a mobile repository that
  binds a plain tag change, and its facts `digest` and `status.identity` change with them.

### Repository

- `docs/scout.md` no longer lists an unknown symbol among the replies that mark an outbound
  lookup `unavailable`. The index answers an unknown symbol, and the lookup is empty and not
  marked `unavailable`. The inbound and impact lookups keep their rule. No answer changes.
