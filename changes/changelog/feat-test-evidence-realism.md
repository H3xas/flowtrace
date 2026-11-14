### Route matching

- A literal caller segment matches a `{param}` route segment, with the new match kind
  `parameter`. So a gateway call or a test request to `users/42` reaches the route
  `users/{id}`. The kind is tried only after `exact`, `prefix`, `alias` and `suffix` find
  nothing, so a caller that matched a route before matches the same route. A parameter match
  also applies after an alias rewrite (kind `alias`) and in a tail match (kind `suffix`). If
  two candidates have equal rank, the caller matches no route. `join` `calls` edges, `trace`,
  `span`, `span --from-component` and `cover` can reach routes they did not reach before.
- A `span` caller row names its match kind when the match is not `exact`.
- `join` and `cover` read a Cypress intercept pattern and a Playwright route stub pattern as
  a glob, segment by segment. A trailing `*` stays inside its segment, so `api/users*` no
  longer matches `api/users/42`. A trailing `**` takes one or more segments. A `${…}` span
  is a value, not a glob: alone in its segment it meets only a route parameter, so an
  intercept of `` `api/items/${id}` `` no longer reaches the literal route `api/items/featured`.
  A span at the end of literal text, as in `` `api/items${query}` ``, stands for the route
  `api/items` and for a longer one. A Playwright request template is read as before.
- A glob or value pattern that two routes fit with equal rank names neither route. `join`
  lists it in `intercepts_without_route` with `reason: "ambiguous"` and its `candidates`.
  `cover` counts it in `notes.intercepts.ambiguous`, and the text and Markdown intercepts
  line names the count. So a `**` pattern that reached the first sorted route before can now
  leave that route.

### Join

- `join` gives a `tests` edge for each Playwright API request and each Playwright route stub
  that names a route, beside the Cypress intercept edges. It reads them as `cover` does. Each
  internal edge carries `source`, and an unjoined entry names its `source` and, for an opaque
  stub or a pattern with no path, its `reason`. A pattern that starts with `?` or `filter.`
  and holds a `/` is now matched, as `cover` matches it.
- The pinned worked-example export carries the `e2e` suite's `tests` edges, so its
  `provenance.factSetsWithoutEdges` is empty. The record shape does not change.

### Extraction

- A Playwright `pw_stub` pattern keeps a part of its URL that the reader cannot read as one
  `${…}` span with the source text of the part, as a `cypress_intercept` pattern does. Before,
  such a part became `*`, which read as a glob that the test author wrote. A `pw_request`
  template keeps its text. Extract again to get the new pattern text.
- A route stub whose pattern keeps a call, an index, an operator or a longer member chain
  as a `${…}` span now has `resolved: false`. A bare name or a `name.prop` span keeps
  `resolved: true`, as a path parameter. A stub that the endpoint registry names and a
  `pw_request` keep their `resolved` value. Extract again to get the new value.
- A Playwright spec under `tests/` now gives `pw_stub` facts for its `page.route(` calls and
  its stub helper calls, as a `.pw.ts` spec does. The reader builds the endpoint registry and
  the stub helper index when only `tests/` specs exist. `cover` counts these stubs as
  Playwright stub evidence, so a route and the parity summary can gain evidence. Extract
  again to get the new facts.
