### Extraction

- A test that names its case id through a configured `caseId.calls` wrapper in title
  position, such as `test(tms.id(9001, 'refunds a sale'), …)`, gets a `case_id` fact. The
  first argument of a configured call is the case id, in title position and in a test body.
  The second argument of a wrapper is its title. The call can span several lines.
- A configured call whose first argument no reader resolves (an identifier, a subscript, a
  call, a template, a conditional) gives a new `case_id` record with `source: "unresolved"`,
  `ids: []` and `expression`, the argument text. Before, the call gave no fact.
- Title collection holds the title of a configured wrapper to containment, not to equality.
  Each title that the runner reports at the site must contain the title argument, so text that
  the wrapper adds to the title no longer refuses the spec file.
- A configured call whose first argument is a same-file value now gives its ids: a `const`, an
  object or array literal, a literal or ternary key, and the bindings of the `for…of` and
  `forEach` loops around the call. Each loop instance gives one `case_id` fact with
  `source: "evaluated"` and `instance`, the loop bindings it read, in loop order. A site gives
  64 instances at most. A function parameter, a call result, `process.env`, a `let` or `var`
  binding, an imported value, an absent key and a site past the limit give the unresolved
  record, which now also carries `instance` for one loop instance that resolves no id.
- Title collection reads the title argument from the spec file. A string literal is compared
  after its escapes are read. A template with literal parts must match those parts in their
  order. A wrapped template must contain them. A computed title rests on its position. A title
  longer than 160 characters is compared in full.
- A configured case-id call is matched only as a whole callee, so `x.tms.id(9001)` gives no
  id for `tms.id`.
- Each `pw_test` fact carries `eligibility`, one of `static-skip`, `environment-skip`,
  `unknown` and `eligible`, and `guards`, the conditional skip guards that apply to the test
  with the value each one reads. `skipped` is `true` exactly when the test is a static skip.
  A bare `test.skip()` at the top of a file now skips every test in it, and a test inside
  `test.describe.fixme(` is skipped.
- A new configuration key, `testEnvironment`, holds the environment values that a skip guard
  reads, such as `{ "E2E_ENV": "dev" }`. The extractor never reads them from the shell.
- The facts digest of a Playwright fact set changes with these fields, so the status identity
  of a walk over it and the identities of a `join` snapshot or edge export change with it.
- Title collection documents its resolution order for `@playwright/test`: under the configured
  root first, then in each parent directory.

### Reports

- `cover` counts only an eligible Playwright test as one that runs. A test that is a static
  skip, an environment skip or unknown is skipped, and its requests and stubs with it. A fact
  set with no `eligibility` keeps the `skipped` rule.
- The `span` page shows an unresolved case id as `case id not read: <expression>`, so a test
  that names a case id is never shown with no case id.
