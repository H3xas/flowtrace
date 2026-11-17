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
