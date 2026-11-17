### Route matching

- A literal caller segment matches a `{param}` route segment, with the new match kind
  `parameter`. So a gateway call or a test request to `users/42` reaches the route
  `users/{id}`. The kind is tried only after `exact`, `prefix`, `alias` and `suffix` find
  nothing, so a caller that matched a route before matches the same route. A parameter match
  also applies after an alias rewrite (kind `alias`) and in a tail match (kind `suffix`). If
  two candidates have equal rank, the caller matches no route. `join` `calls` edges, `trace`,
  `span`, `span --from-component` and `cover` can reach routes they did not reach before.
- A `span` caller row that matched by `parameter` says `parameter match`. Other caller rows do
  not change.
- `join` and `cover` read a Cypress intercept pattern and a Playwright route stub pattern as
  a glob, segment by segment. A trailing `*` stays inside its segment, so `api/users*` no
  longer matches `api/users/42`. A trailing `**` takes one or more segments, also when literal
  text comes before it, as in `api/items**`. A `${…}` span
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
  stub, a pattern with no path or a request with an unknown base, its `reason`
  (`opaque`, `no-path` or `unresolved-base`). A pattern that starts with `?` or `filter.`
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
- The new fact kinds and fields of this release change the status identity in the same way. The
  kinds are `cypress_backend`, `pw_visit`, `cypress_visit`, `email_read`, `email_template` and
  `email_sender`. The fields are `testLine` and the `handler` of a `cypress_intercept`. The `tests/`
  stubs are new facts of an old kind. The status identity is a digest of the fact sets that a walk
  reads. So after an extract, a walk that reads such a fact set has another `status.identity`.
  No other field of a `trace` answer changes. A route key does not change.
- Both Cypress readers give `cypress_intercept` the optional field `handler`, with the words
  `pw_stub` uses. The reader supports a closed list of handler forms. No handler gives `spy`. A
  string, template or array literal gives `fulfill`. A static response object of plain
  `key: value` parts gives `fulfill`, or `abort` with one `forceNetworkError: true`. A function,
  or a function name that the file declares once, is read by its calls. There, `.reply(` gives
  `fulfill` and `.destroy(` gives `abort`. A `res.send(` in a `.continue(` callback or in a
  `response` or `before:response` listener gives `fetch-fulfill`. A function that only reads
  the request gives `spy`. Every other handler,
  such as an object with a spread or a function followed by `.bind(…)`, gives `unresolved`. The
  two readers give the same word for the same source.
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
  its hooks, and the functions and Cypress commands those call. A string literal, or a template
  literal with no `${`, gives its text as the path. Every other path gives `path: null` and
  `reason: "not-literal"`.
- `cover` shows the inferred page reach of each route. A visit path loses its origin, query and
  fragment, and then matches a page path by the route comparator. A page also answers under the
  app-root mount of its repository, and a trailing `*` takes the rest of the path. Each route
  gets `pageReach`: the tests by backend class that visit a page whose page walk reaches the
  route, with executing and skipped tests apart. `notes.visits` counts the visits that matched,
  matched no page, matched two pages of equal rank, or could not be read. The text and Markdown
  reports label the line as inferred. Page reach is not named evidence, so the route state,
  levels, evidence counts and parity do not change.
- The configuration accepts a top-level `email` object. `email.reads` lists the calls that read
  an email, each with the position of its subject: an argument index, or `"<index>.<key>"` for a
  key of an object argument. `email.senders` lists the backend class members that name an email.
  Without the key, no extractor gives an email fact. A malformed value is one refusal that names
  `email`.
- A repository of the new kind `email-templates` has a `templates` object with `files` (globs),
  and `id` and `subject` selectors. A selector is dotted keys, and a key can carry a
  `[field=value]` filter that picks one array element. A malformed value is one refusal that
  names `templates`.
- `extract` reads email reads. With `email.reads`, a call to a configured name gives one
  `email_read` fact for each Playwright or Cypress test that reaches it through its body, its
  hooks, its helpers or a Cypress command (a Cypress read is the command `cy.<call>(`). The fact
  has `spec`, `test`, `testLine`, `call`, `subject`, `skipped` and `where`, and the `file` and
  `line` of the call. The reader supports a closed list of subject forms. A string literal gives
  its text. A template literal gives its text with each `${…}` as `*`. A name gives the value of
  a one-declarator `const` whose whole initializer is one of these literals. The `const` is in a
  block that holds the call, before the call, with no nearer binding of the name. A key of an
  object literal of plain `key: value` parts gives the value of that key, read by the same
  rules. Every other subject gives `subject: null` and
  `reason: "unreadable-subject"`. A test whose title is not a literal gives `test: null`.
- `extract` reads an `email-templates` repository. Each JSON file that a `templates.files` glob
  matches gives one `email_template` fact with `id`, `subject`, `file` and `line`. Each `{{…}}`
  and `{{{…}}}` placeholder of the subject becomes `*`. A selector that matches no element or two
  gives a null value and a `reason` (`id-no-element`, `subject-two-elements` and so on), and a file
  that does not parse gives `reason: "unread-file"`.
- `extract` reads email senders in backend classes. With `email.senders`, a member written as
  `string <Member> => <value>;` or `string <Member> { get; } = <value>;` gives one `email_sender`
  fact with `class`, `member` and `id`, nested classes included. A value is a string literal, or a
  `<Class>.<NAME>` reference to a `public const string` in any file of the repository, named in
  `constant`. A reference to no constant or to two gives `id: null` and a `reason`. A regular
  literal gives its value with its escapes decoded. A verbatim literal and a raw literal on one
  line give their text. Every other value, such as a raw literal on two or more
  lines, an interpolated string or a concatenation, gives `id: null` and
  `reason: "unread-literal"`. A member or a constant inside a C# comment or string gives nothing.
- `cover` lists the email reads of the area under `emails.entries`. Each read links to one
  `email_template` by its subject and to one `email_sender` by the template id. The link state is
  `linked`, `no-subject`, `no-template`, `ambiguous-template`, `no-sender` or `ambiguous-sender`,
  and an ambiguous state names its candidates. A `*` of a read matches only a `*` of a template. A
  read is in the area when its test has named evidence on an area route, or when its sender is a
  node of an area route walk. `emails.outsideArea` counts the other reads. The text and markdown
  reports label a link as a static match, not proof of delivery. No route state, level or parity
  changes.
- In a `templates.files` glob, a `**/` takes zero or more whole directories, so
  `templates/**/welcome.json` does not select `templates/notwelcome.json`. The `exclude` globs
  keep their rule.
