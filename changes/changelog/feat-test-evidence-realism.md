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
- `pw_request`, `pw_stub` and `cypress_intercept` facts get the optional field `testLine`: the
  declaration line of the test that holds the call, or `null` outside a test. Two tests with the
  same title in one spec now have different owner lines. Facts extracted again have a new facts
  digest, so the `trace` status identity and the export identities change once.
- Both Cypress readers give `cypress_intercept` the optional field `handler`, with the words
  `pw_stub` uses: `spy` for no handler, a `req.continue()` that changes nothing or a handler that
  only reads the request; `fulfill` for a static response or a `req.reply(`; `fetch-fulfill` for
  a `res.send(` in a `req.continue(` callback or a `response` or `before:response` listener;
  `abort` for `req.destroy(` or `forceNetworkError`; `unresolved` for a handler the file does not
  define or a request handed to other code. The two readers give the same word for the same
  source.
- Both Cypress readers give each `cypress_test` one `cypress_backend` fact in the shape of
  `pw_backend`: `real`, `patched`, `mocked` or `unknown`, with the sites that decided it. The
  reader follows the test body, the `before` and `beforeEach` hooks of the file and of each
  enclosing `describe` or `context`, the functions of the same file and the custom commands that
  `Cypress.Commands.add(` defines in the suite. A `backend.mockCalls` or `backend.patchCalls`
  name matches `cy.<name>(`, and a `cy.intercept(` counts by its handler. `validateFacts`
  refuses a `cypress_backend` without `backend` or `sites`. The Playwright and Cypress readers
  share one region engine.
- `cover` shows the backend realism of named evidence. Each entry is joined to the class fact of
  its test by repository, spec and `testLine`, and gets `backend` (the class, or `none`),
  `handler` and `reach`: `stubbed`, `backend`, `blocked` or `unknown`. A spy beside a fulfilled
  stub of the same route in the same test takes the reach of that stub. Each route gets
  `realism`, with counts for executing and skipped entries apart and the entries themselves, and
  `--json` gets a `realism` total. The text and Markdown reports show a realism line for each
  route with named evidence. The route state, levels, evidence counts and parity do not change.
- `extract` reads page visits. A `page.goto(` call gives a `pw_visit` fact and a `cy.visit(`
  call gives a `cypress_visit` fact, with `spec`, `test`, `testLine`, `path`, `skipped` and
  `where`. They are read from the regions that decide the backend class of the test: its body,
  its hooks, and the functions and Cypress commands those call. A path that is not a string
  literal gives `path: null` and `reason: "not-literal"`.
- `cover` shows the inferred page reach of each route. A visit path loses its origin, query and
  fragment, and then matches a page path by the route comparator. A page also answers under the
  app-root mount of its repository, and a trailing `*` takes the rest of the path. Each route
  gets `pageReach`: the tests by backend class that visit a page whose page walk reaches the
  route, with executing and skipped tests apart. `notes.visits` counts the visits that matched,
  matched no page, matched two pages of equal rank, or could not be read. The text and Markdown
  reports label the line as inferred. Page reach is not named evidence, so the route state,
  levels, evidence counts and parity do not change.
