# Concepts

flowtrace answers four questions about an HTTP route, and every answer is built out of the
same four things: **facts**, the **flow**, a **walk**, and **seeds**.

## Facts

A fact is the smallest thing an extractor can state about a repository: "this file declares
this route at this line", "this class injects this interface", "this method calls this
member on that field", "this spec intercepts this URL". Nothing more.

`flowtrace extract` walks each configured repository with the extractor for its `kind` and
writes `out/facts/<repo>.json` — a header (repo id, kind, the git HEAD it was read at) plus
a flat array of facts. Extraction is the only step that reads source code; every later step
reads facts.

Extractors are heuristic. They do not parse C# or TypeScript — they recognise a set of
common idioms with regular expressions and brace matching. That has a cost (an unusual
idiom is invisible) and a benefit (no toolchain, no build, no language server, and a
repository that does not compile still extracts). See [fact-schema.md](fact-schema.md) for
the fact types and their fields.

## The flow

`flowtrace join` reads every fact set and matches caller-side calls to server-side routes
by normalised template. The result, `out/flow.json`, is the *boundary* view: which routes
have a caller, which callers name a route nothing declares, which routes nobody calls.

Templates on either side are normalised before comparison — a `{productId}` on the server
and a `${id}` on the caller are the same segment. `aliases` in the configuration file
rewrite a route prefix when a gateway serves one path under another name.

## The walk

`flowtrace trace <start>` walks forward from a start to everything it reaches: the
controller action, the branches inside it, the services it holds through
constructor-injected fields, the repositories those reach, the messages they publish and
the consumers of those messages. It reads facts only; it never re-extracts.

Two things keep the tree readable:

- **Folding.** The first time a node appears it prints in full; every later appearance is
  one line pointing at the first. A repository shared by nine callers prints its subtree
  once, not nine times. `--no-fold` turns this off.
- **Sinks.** A node that writes to a database, publishes a message, pushes over SignalR or
  calls out over HTTP is a **sink** — the observable end of a path. Everything between the
  route and a sink is plumbing.

When facts run out — an interface with no registration, a call into a repository that was
not extracted — the walk can consult a code index (see [scout.md](scout.md)) for one more
hop. Without one, the node prints `unresolved`, which is an answer too.

## Seeds

A **seed** is one distinguishable way through the route: a specific combination of
branch outcomes, ending in a status code or a set of sinks. The walk collects the branch
points on each path and enumerates them.

```
U1  error_return@39=taken                             → 400 BadRequest              #5a6423a0
U2  error_return@39=not-taken, error_return@45=taken  → 403 Forbidden               #ca37457e
U3  error_return@39=not-taken, error_return@45=not-taken → db SaveOrder, ⇝ OrderPlaced  #31ba2067
```

The `#key` is stable across runs as long as the branch text does not change, so a seed can
be referred to by name in a spec, a case sheet or a review.

Seeds are the denominator flowtrace uses everywhere a percentage would otherwise be
guessed. A seed is either reachable from a black-box caller or it is not: a branch whose
deciding value comes only from a JWT claim or an injected dependency cannot be forced by an
API-level test, and `scaffold` and `cases` drop it into a footer instead of pretending
otherwise.

## Evidence tiers

`flowtrace cover --area <area>` puts the test evidence next to the seeds. Evidence is
whatever the fact sets already hold: a Playwright request to a URL, a Cypress
`cy.intercept`, an assertion inside a test that also names the route.

Four tiers, weakest first:

| tier | what it means |
|---|---|
| `none` | no executing test names this route |
| `skipped-only` | the only tests naming it are skipped |
| `route` | an executing test names the route |
| `path` / `disposition` | a test names the route *and* asserts something that pins this seed's branch outcome |

The load-bearing honesty is in the third row. An intercept proves the request reached the
route; it does not prove which way through it. So every seed of a route carries that
route's route-level evidence, and nothing is promoted to `path` without an assertion that
actually distinguishes one seed from another. flowtrace never reports a coverage percentage
it cannot point at a fact for.

## Areas

An **area** is a fixed list of route keys — the denominator of a coverage run, written by
hand and committed. See [../areas/README.md](../areas/README.md).

## Affected

`flowtrace affected --diff <range> --area <area>` intersects a diff with the forward walk:
which routes in the area does this change reach, and which specs hold evidence for those
routes. It prints the specs to run, and — the part a coverage report cannot give you — the
affected routes that hold *no* evidence at all, at the moment of the diff.

Widening is always a printed rung, never a silent one. If the selection is too large a
share of the suite, if a fact set is stale, if a changed file sits under no known project,
flowtrace refuses the narrow answer and says to run everything, with the reason on stderr.
