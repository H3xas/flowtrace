### Extraction

- The Playwright reader uses one shared lexer. A regex literal with a `/`, a quote or a
  bracket no longer ends a test early or hides a route stub, and a comment inside a template
  interpolation is not read as a call.
- A `test(` call that the reader cannot close, or a test whose reading fails, still gives its
  `pw_test`, with the new optional field `unread` (`unbalanced-call` or `reader-failure`), and
  an `unknown` `pw_backend` with the same reason. The other tests of the spec keep their facts.
- `pw_backend` reads Playwright fixtures: the regions of the fixtures that a test uses, its
  hooks use and the `auto` fixtures, before their `use(` call. A stub there gives a site with
  `where: "fixture"`. A stub under an option fixture counts only when the `test.use` value or
  the option default runs it. New reasons: `unread-fixture` and `unread-option`.
- A fixture with a readable type types the receiver of a helper call in a test, so the call
  gives its request instead of `ambiguous-receiver`.
- A parenthesized test or hook reference, such as `test('t', (shared))`, is read as a
  reference. A dotted `backend` entry matches only the callee as written, so
  `fixtures.seed` no longer matches `other.fixtures.seed()` or `this.fixtures.seed()`.
- An aliased helper import reaches its helper. A `.route(` inside a string no longer marks a
  helper as a stub. An `export { type Name }` entry exports no value.
- A URL const folds with no trailing `;`, with `as const`, through another const, through a
  local `const url`, and in a `+` concatenation.
- A `pw_request` whose first path segment is an interpolation that the reader cannot fold
  gets `reason: "unresolved-base"`. `cover` gives it no evidence and counts it in the new
  `notes.intercepts.unresolvedBase`, and its text and Markdown output name that count.
