# flowtrace

Trace an HTTP route through the code that serves it, put the test evidence that covers it
next to the result, and turn a diff into the specs that must run.

It reads source with regular expressions rather than a compiler, so it needs no build, no
toolchain and no language server — and it works across repository boundaries, which is where
the question usually lives: a request leaves a client in one checkout and is served in
another.

Today it understands ASP.NET Core (C#), Ionic/Angular and React + Redux (TypeScript),
Playwright and Cypress.

## What it answers

| command | question |
|---|---|
| `extract` | what does each repository state about itself? |
| `join` | which client calls reach which server routes, and which do not? |
| `render` | write the joined route report and one flow page per called route. |
| `trace` | what actually runs when this route is called — branches, services, database writes, published messages, consumers? |
| `cover` | which distinguishable ways through this feature's routes does a test actually pin down? |
| `affected` | I changed these files — which specs must run, and which affected routes have no test at all? |
| `scaffold` | write a starting spec for each gap. |
| `cases` | write a plain-English case sheet for each gap, for a person to judge. |
| `readiness` | per feature area: routes reached, sinks by class, seeds by reachability. |
| `span` | one self-contained page per route, outcome first — what can happen, which outcomes a test already pins, what to do about the rest. |
| `surface` | where can the state this route writes be read back? |
| `skeleton` | write the spec that calls the route and observes that read-back. |
| `all` | run `extract`, `join` and `render` in sequence. |

The honesty rule underneath all of it: **flowtrace never reports a number it cannot point at
a fact for.** An intercept proves a request reached a route; it does not prove which way
through it. So a route's evidence never silently becomes a path's evidence, and a branch no
black-box caller can force is reported as unreachable rather than counted as a gap.

## Install

```
npm i -g flowtrace-cli
```

The npm package is `flowtrace-cli` — the bare name belongs to an unrelated flow-based-programming
tool — and the binary it installs is `flowtrace`. Zero runtime dependencies; Node 20 or newer.

Or download a single-file executable for Linux, macOS or Windows from the repository's
GitHub releases page — no Node install required. Or run from a checkout:

```
node bin/flowtrace.js --help
```

## Quickstart

The repository ships a worked example under `examples/demo-shop`: a small ASP.NET Core
service with a catalog and an orders controller, and a Playwright suite that covers some of
it. Every command below runs against it with no setup.

```
cd <checkout>
node bin/flowtrace.js extract --config examples/demo-shop/flowtrace.config.json
node bin/flowtrace.js join    --config examples/demo-shop/flowtrace.config.json
```

Now trace a route to its sinks, with the seeds it enumerates:

```
node bin/flowtrace.js trace "POST orders/v1/checkout" \
  --config examples/demo-shop/flowtrace.config.json --seeds
```

```
POST orders/v1/checkout  api  src/Controllers/OrdersController.cs:36  [start]
└─ OrdersController.Checkout  api  src/Controllers/OrdersController.cs:36  [literal]
   ├─ ◇ 39-42  if (request == null || string.IsNullOrEmpty(request.PaymentToken))  → 400 BadRequest  [branch:error_return]
   ├─ ◇ 45-48  if (!placed)  → 403 Forbidden  [branch:error_return]
   └─ IOrderService  api  src/Controllers/OrdersController.cs:14  [ctor]
      └─ OrderService  api  src/Services/OrderService.cs:21  [di]
         └─ OrderService.PlaceOrder  api  src/Services/OrderService.cs:35  [body]
            ├─ ◇ 38-41  if (!accepted)  [branch:if]
            ├─ IOrderRepository  api  src/Services/OrderService.cs:21  [ctor]
            │  └─ ■ OrderRepository  api  src/DataAccess/OrderRepository.cs:14  [db·write]
            ├─ IPublishEndpoint  api  src/Services/OrderService.cs:22  [ctor]
            │  └─ InMemoryPublishEndpoint  api  src/Messaging/InMemoryPublishEndpoint.cs:7  [di]
            │     └─ InMemoryPublishEndpoint.Publish  api  src/Messaging/InMemoryPublishEndpoint.cs:7  [body]  graph: unavailable
            └─ OrderPlacedMessage  bus  src/Services/OrderService.cs:43  [publish]
               └─ OrderPlacedConsumer  api  src/Messaging/OrderPlacedConsumer.cs:6  [message·fqn]  graph: unavailable

use-case seeds (3):
U1  error_return@39=taken  → 400 BadRequest  #5a6423a0
U2  error_return@39=not-taken, error_return@45=taken  → 403 Forbidden  #ca37457e  [unknown: placed ← unresolved]
U3  error_return@39=not-taken, error_return@45=not-taken  → ■ db OrderRepository.SaveOrder, ⇝ OrderPlacedMessage → OrderPlacedConsumer [api]  #31ba2067
    also on path: if@OrderService.PlaceOrder:38

1 sink · 3 branch points (3 primary) · 1 repo (api) · via: body 5, ctor 3, di 3, literal 1, message 1, publish 1 · 2 graph hop unavailable
```

`graph: unavailable` marks a hop flowtrace could not extend past without a call-graph backend (`scout`)
configured — the bus-side classes here have no further calls to follow, so the walk stops honestly
instead of guessing. [devscout](https://github.com/H3xas/devscout-rs) is a public code-index CLI that
targets this contract. `[unknown: placed ← unresolved]` marks a branch condition whose value flowtrace
could not trace back to a caller-controlled source through the three-hop bound — it is reported as
unknown rather than assumed reachable or not.

Then put the existing test evidence next to those seeds, for the whole `checkout` area:

```
node bin/flowtrace.js cover --area checkout \
  --config examples/demo-shop/flowtrace.config.json
```

```
area checkout   3/5 area routes with executing evidence · 0 skipped-only · 2 none · 10 seeds · 0 path · 1 disposition

■■  GET catalog/v1/products  2 seeds · 2 intercepts (1 executing, 1 skipped)
  ■ U1  error_return=taken   → 400 BadRequest   route   catalog.spec.ts :: lists the products of a category
  ■ U2  happy path           reads 1            route   catalog.spec.ts :: lists the products of a category

□□  GET catalog/v1/products/*  2 seeds · no intercept evidence
  □ U1  error_return=taken   → 404 NotFound     none    —
  □ U2  happy path           reads 1            none    —
…
```

Other shapes of the same walk: `--mermaid` (a flowchart), `--html <file>` (a self-contained
page), `--json`, `--cover-overlay` (colour every route node by its evidence tier).

`flowtrace cases --area checkout --dry-run` turns the uncovered seeds into plain-English case
sheets; `flowtrace scaffold --area checkout --dry-run` turns them into starting specs.

## One route, for a tester

`trace` and `cover` answer a developer's question — "what runs", "what is covered". A tester
asks a different one, before opening any code: *what can this endpoint do to me, which of
those outcomes does a test already pin down, and where would I look to tell?* `span` writes
that as one self-contained HTML page:

```
node bin/flowtrace.js span "POST orders/v1/checkout" \
  --config examples/demo-shop/flowtrace.config.json
```

```
span POST orders/v1/checkout: 3 outcomes — 1 tested, 2 inherited-only, 0 untested
  (reconciles with cover: 3/3 seeds) -> out/span/post-orders-v1-checkout.html
```

Every outcome the route can produce becomes one ledger row, ordered worst-known-first, each
tagged `tested`, `inherited only` or `untested`, and the counts reconcile with `cover` by
construction rather than by a second opinion. A `tested` row names the spec, the resolved
title and the case ids a `case_id` fact carries — never an id the tool made up. An
`untested` row carries the Given/When/Then `cases` would have written for it. The page ends
with a strip stating what a static read cannot know, so nothing on it reads as a runtime
claim.

`span --from-component <name>` starts from the screen instead of the route key, resolving a
web component through its dispatches and effects to the routes it reaches — and printing the
arms that do not resolve rather than guessing them. A name declared in more than one file is
ambiguous, not silently picked: the command lists the candidates until `--file <substring>`
narrows it to one.

Two more verbs answer "where would I observe it":

```
node bin/flowtrace.js surface  "POST orders/v1/checkout" --config examples/demo-shop/flowtrace.config.json
node bin/flowtrace.js skeleton "POST orders/v1/checkout" --config examples/demo-shop/flowtrace.config.json
```

`surface` walks from each store the route writes back out to the safe-verb endpoints that
read that same state, printing the chain fact by fact; a chain it cannot complete prints as a
gap naming what stopped it. `skeleton` turns that surface into a spec: one test per written
state, calling the route and reading the state back through an endpoint the surface itself
derived. Which *response field* reflects a write is a judgment, not a walk — the skeleton
marks that claim unfilled unless a cached `surface_verdict` fact supplies it, with the
file:line the reading rests on.

## Your own repositories

Copy `flowtrace.config.example.json` to `flowtrace.config.json`, point `repos[].root` at
your checkouts, and delete what you do not have:

```json
{
  "out": "out",
  "repos": [
    { "id": "api", "kind": "backend", "root": "../shop-api", "role": ["api"] },
    { "id": "e2e", "kind": "playwright", "root": "../shop-e2e" }
  ]
}
```

`kind` is one of `backend` (ASP.NET Core), `contracts` (message and DTO definitions),
`mobile` (Ionic/Angular), `web` (React + Redux) or `playwright` (a spec suite). Paths
resolve relative to the configuration file. The file names machine-local checkouts, so it is
gitignored by default — commit the example instead.

Full reference: [docs/configuration.md](docs/configuration.md).

## Area config format

`cover`, `affected`, `scaffold` and `cases` all need a denominator, and flowtrace will not
invent one. An **area** is a committed newline list of route keys:

```
# checkout — every route the demo shop's cart and checkout flow reaches.
GET catalog/v1/products
GET catalog/v1/products/*
GET orders/v1/cart
POST orders/v1/cart/items
POST orders/v1/checkout
```

Details and a regeneration recipe in [areas/README.md](areas/README.md).

## Documentation

- [docs/concepts.md](docs/concepts.md) — facts, the flow, the walk, seeds, evidence tiers
- [docs/configuration.md](docs/configuration.md) — every configuration key
- [docs/fact-schema.md](docs/fact-schema.md) — every fact type and its fields
- [docs/scout.md](docs/scout.md) — the optional code index for graph hops
- [areas/README.md](areas/README.md) — the area file format
- `flowtrace --help` — the full flag reference, which is the most detailed of the lot

## Benchmarks

How this compares to the tools an agent could install instead — joern, ast-grep, semgrep,
code-graph-rag, serena, aider's repo map, with ripgrep as the floor — on public, sha-pinned
corpora, with the truth sealed before anything runs. Gaps are published in both directions and
no best-everywhere claim is made: several peers read C# and TypeScript better than these regular
expressions do.

[docs/benchmarks/](docs/benchmarks/README.md) holds the method, the peers, the agent-in-the-loop
protocol and the results; [bench/](bench/README.md) holds the pins and the commands. The first agentic (model-in-the-loop) run is now published in
[docs/benchmarks/results/2026-08.md](docs/benchmarks/results/2026-08.md) — preliminary, one run
per cell, its integrity caveats leading; the wider public-corpus peer matrix is still pending.

**Scorecard** so far (eShopOnWeb corpus, sha-pinned; full tables, per-cell verdicts and the
integrity caveats are in [docs/benchmarks/results/2026-08.md](docs/benchmarks/results/2026-08.md)):

| round | result | verdict |
| --- | --- | --- |
| Deterministic pipeline | facts, walks and `span` reconcile on the pinned corpus | measured; peer matrix not yet run |
| Agentic — 4 sealed tickets, 2 models, tool / no-tool / no-code arms | tool arms 8/8 correct, baseline arms 8/8 correct, no-code control 0/4 | **no advantage shown this run** — correctness and token cost both flat against the baseline; only the no-code floor separated |

One run per cell is an anecdote with a number attached, and is published as exactly that. The
negative finding stays on the board until the 5-run protocol confirms or retires it — this
project publishes the rounds it loses with the same prominence as the ones it wins.

## Limitations

- Extraction is heuristic, not a parse. An idiom the patterns do not recognise is invisible;
  the fix is to widen a regular expression in `lib/extract/`, and the patterns are grouped at
  the top of each file for exactly that.
- Language and framework support is what is listed above, no more.
- `affected` reads diffs through `git`, so the repository it reads must be a git checkout.
- Coverage is evidence overlay, not instrumentation. It reports what the tests *say* they
  touch, from their own source; it never runs them.
- The test suite is not part of this repository or the published package. It runs privately
  before each release, against corpora that are not public. The public verification is the
  worked example under `examples/demo-shop`, which CI runs end to end on every push.
- `span --from-component` covers the `web` repository kind only. A mobile-kind name is
  refused with its reason rather than answered partially.

## Release and versioning

Semantic versioning, from `0.x` — the CLI surface may still change between minor versions.
What changed in each one is in [CHANGELOG.md](CHANGELOG.md).
The current release is `0.1.1`; its source repository is
[H3xas/flowtrace](https://github.com/H3xas/flowtrace).

The single-file build inlines the module graph itself and supports only relative imports,
`node:` builtins and `import.meta.url` — no re-exports, no dynamic `import()`. Keep new code
inside that subset or the release build fails.

## License

Licensed under the [MIT license](LICENSE).
