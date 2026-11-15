### Web journeys

- `trace <Component>` prints one `[mount]` hop for each page that shows a web component,
  with the browser path and the file:line of its route. `--json` gives the pages as
  `root.pages`. A component that no route reaches prints `no-page`. A render that two
  innermost routes hold prints `page-ambiguous` with both route sites. The routes, the
  status and the exit code do not change.
- A page path that two route trees declare resolves in the tree that a mount declares. If
  no tree or more than one declared tree matches, `trace` exits 2 with reason `ambiguous`
  and lists each candidate. A page path start also walks the children that its route
  element holds.
- `trace`, `span --from-component` and `chains` read the requests of a component body and
  of `render`, of an arrow bound to a local name and of a member that nothing enters. An
  inline handler arrow is one entry at its arrow site, file:line:column, and holds only the
  dispatches and calls inside it. A `dispatch(c(x))` handler names the creator `c`. A
  creator with no `effect_handler` walks the creators it dispatches, one level each.
- `span --from-component` names the holder of an arm without entry in the page and as
  `holder` in `--json`. The `trace --json` evidence of a props hop adds its `props_bind`
  fact.
- Extraction: a web `action_dispatch` or `method_call` fact carries `arrow`, the arrow
  function that holds it, with its name or its `on*` attribute. A curried arrow creator now
  spans its inner thunk. A fact set extracted again has a new facts digest. An older fact
  set reads with no error and keeps the older walk.
- An entry line of `trace` and `chains` starts with its kind word: `mount`, `update`,
  `unmount`, `effect` or `event`. Entry ids and JSON fields do not change.
- Plain `trace` of a mobile page or component lists each lifecycle hook that sends a
  request as an entry, and walks each template handler in a scope of its own. The scope
  and the status identity do not change. `--from-handler` lists no hook.
- `chains` prints one chain for each `dispatch(creator(...))` statement, in the dispatch
  form, where it printed a call chain and a dispatch chain.
