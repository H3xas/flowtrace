### Route matching

- A literal caller segment matches a `{param}` route segment, with the new match kind
  `parameter`. So a gateway call or a test request to `users/42` reaches the route
  `users/{id}`. The kind is tried only after `exact`, `prefix`, `alias` and `suffix` find
  nothing, so a caller that matched a route before matches the same route. A parameter match
  also applies after an alias rewrite (kind `alias`) and in a tail match (kind `suffix`). If
  two candidates have equal rank, the caller matches no route. `join` `calls` edges, `trace`,
  `span`, `span --from-component` and `cover` can reach routes they did not reach before.
- A `span` caller row names its match kind when the match is not `exact`.

### Join

- `join` gives a `tests` edge for each Playwright API request and each Playwright route stub
  that names a route, beside the Cypress intercept edges. It reads them as `cover` does. Each
  internal edge carries `source`, and an unjoined entry names its `source` and, for an opaque
  stub or a pattern with no path, its `reason`. A pattern that starts with `?` or `filter.`
  and holds a `/` is now matched, as `cover` matches it.
- The pinned worked-example export carries the `e2e` suite's `tests` edges, so its
  `provenance.factSetsWithoutEdges` is empty. The record shape does not change.
