# flowtrace

Trace an HTTP route through the code that serves it, put the test evidence that covers it
next to the result, and turn a diff into the specs that must run.

It reads source with regular expressions rather than a compiler, so it needs no build, no
toolchain and no language server — and it works across repository boundaries, which is where
the question usually lives: a request leaves a client in one checkout and is served in
another.

Today it understands ASP.NET Core (C#), Ionic/Angular and React + Redux (TypeScript),
Playwright and Cypress.

[Install](#install) · [Quickstart](#quickstart) · [Your own repositories](#your-own-repositories)
· [For AI agents](#for-ai-agents) · [Commands](#commands) · [Documentation](#documentation)
· [Benchmarks](#benchmarks) · [Limitations](#limitations) · [Contributing](#contributing)
· [License](#license)

## Install

```
npm i -g flowtrace-cli
```

The npm package is `flowtrace-cli` — the bare name belongs to an unrelated flow-based-programming
tool — and the binary it installs is `flowtrace`. Zero runtime dependencies; Node 20 or newer.

Or download a single-file executable for Linux, macOS or Windows from the
[releases page](https://github.com/H3xas/flowtrace/releases) — no Node install required. Or
run from a checkout with `node bin/flowtrace.js`.

## Quickstart

The repository ships a worked example under `examples/demo-shop`: a small ASP.NET Core
service with a catalog and an orders controller, and a Playwright suite that covers some of
it. Nothing to set up:

```
cd examples/demo-shop
flowtrace extract
flowtrace join
flowtrace trace "POST orders/v1/checkout" --seeds
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
            │  └─ ■ OrderRepository  api  src/DataAccess/OrderRepository.cs:15  [db·write]
            ├─ IPublishEndpoint  api  src/Services/OrderService.cs:22  [ctor]
            │  └─ InMemoryPublishEndpoint  api  src/Messaging/InMemoryPublishEndpoint.cs:7  [di]
            │     └─ InMemoryPublishEndpoint.Publish  api  src/Messaging/InMemoryPublishEndpoint.cs:7  [body]  graph: unavailable
            └─ OrderPlacedEvent  bus  src/Services/OrderService.cs:43  [publish]
               └─ OrderPlacedConsumer  api  src/Messaging/OrderPlacedConsumer.cs:13  [message·fqn]
                  └─ OrderPlacedConsumer.Consume  api  src/Messaging/OrderPlacedConsumer.cs:16  [body]
                     ├─ ILogger<OrderPlacedConsumer>  api  src/Messaging/OrderPlacedConsumer.cs:13  [ctor]  unresolved
                     ├─ IOrderRepository  api  src/Messaging/OrderPlacedConsumer.cs:13  [ctor]
                     │  └─ ↑ OrderRepository (see above, ×2)
                     └─ FulfilOrderJob  bus  src/Messaging/OrderPlacedConsumer.cs:20  [publish]
                        └─ OrderFulfilmentConsumer  api  src/Messaging/OrderFulfilmentConsumer.cs:11  [message·fqn]
                           └─ OrderFulfilmentConsumer.Consume  api  src/Messaging/OrderFulfilmentConsumer.cs:14  [body]
                              ├─ IProductRepository  api  src/Messaging/OrderFulfilmentConsumer.cs:11  [ctor]
                              │  └─ ■ ProductRepository  api  src/DataAccess/ProductRepository.cs:13  [db·read]
                              └─ ILogger<OrderFulfilmentConsumer>  api  src/Messaging/OrderFulfilmentConsumer.cs:11  [ctor]  unresolved

use-case seeds (3):
U1  error_return@39=taken  → 400 BadRequest  #5a6423a0
U2  error_return@39=not-taken, error_return@45=taken  → 403 Forbidden  #ca37457e  [unknown: placed ← unresolved]
U3  error_return@39=not-taken, error_return@45=not-taken  → ■ db OrderRepository.SaveOrder, ⇝ OrderPlacedEvent → OrderPlacedConsumer [api] → ■ db OrderRepository.MarkPlaced → ■ db ProductRepository.GetById  #31ba2067
    also on path: if@OrderService.PlaceOrder:38

3 sinks · 3 branch points (3 primary) · 1 repo (api) · via: body 7, ctor 7, di 5, literal 1, message 2, publish 2 · 1 graph hop unavailable
```

`graph: unavailable` marks a hop the walk could not extend without a code index
configured; it stops there rather than guessing. `[unknown: placed ← unresolved]` marks a
branch condition that could not be traced back to something a caller controls; it is
reported as unknown rather than assumed reachable.

Then `flowtrace cover --area checkout` puts the existing tests next to those seeds, and
`span`, `cases` and `scaffold` turn the gaps into a tester's page, case sheets and starting
specs. The full tour, with every command's output, is
[docs/getting-started.md](docs/getting-started.md).

## Your own repositories

Put `flowtrace.config.json` in the directory that holds your checkouts and name them:

```
workspace/
  flowtrace.config.json
  shop-api/       an ASP.NET Core checkout
  shop-e2e/       a Playwright checkout
```

```json
{
  "out": "out",
  "repos": [
    { "id": "api", "kind": "backend", "root": "shop-api", "role": ["api"] },
    { "id": "e2e", "kind": "playwright", "root": "shop-e2e" }
  ]
}
```

`kind` is one of `backend` (ASP.NET Core), `contracts` (message and DTO definitions),
`mobile` (Ionic/Angular), `web` (React + Redux) or `playwright` (a spec suite). Paths resolve
relative to the configuration file. Then `flowtrace extract`, `flowtrace join`, and trace a
route. Step by step, with the expected output at each step and a table of what to do when
something is off: [docs/getting-started.md](docs/getting-started.md). Every key:
[docs/configuration.md](docs/configuration.md); every key at its built-in value:
`flowtrace.config.example.json`.

## For AI agents

The output is deterministic, every line carries a `file:line`, and a gap in what the tool
knows prints as a gap. That makes it a good tool to hand to an agent, and
[docs/agent-guide.md](docs/agent-guide.md) says how: the setup an agent can run unassisted, a block to
paste into the agent's instructions, which command answers which question, and the reading
rules that keep the tool's honesty intact in the agent's answer.

## Commands

| command | question |
|---|---|
| `extract` | what does each repository state about itself? |
| `join` | which client calls reach which server routes, and which do not? |
| `render` | write the joined route report and one flow page per called route. |
| `trace` | what actually runs when this route is called — branches, services, database writes, published messages, consumers? |
| `routes-of` | I hold a grep hit, a stack frame or a message name — which entry routes run through it? |
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

Every flag: [docs/cli.md](docs/cli.md), which is `flowtrace --help` verbatim.

## Documentation

[docs/README.md](docs/README.md) lists every document and when to read it. The short
version: [getting started](docs/getting-started.md), [for agents](docs/agent-guide.md),
[concepts](docs/concepts.md), [command reference](docs/cli.md),
[configuration](docs/configuration.md), [area files](areas/README.md),
[fact schema](docs/fact-schema.md), [the optional code index](docs/scout.md).

## Benchmarks

How this compares to the tools an agent could install instead — joern, ast-grep, semgrep,
code-graph-rag, serena, aider's repo map, with ripgrep as the floor — on public, sha-pinned
corpora, with the truth sealed before anything runs. Gaps are published in both directions
and no best-everywhere claim is made: several peers read C# and TypeScript better than these
regular expressions do.

The method, the peers, the agent-in-the-loop protocol, the scorecard so far and the results
are under [docs/benchmarks/](docs/benchmarks/README.md); [bench/](bench/README.md) holds the
pins and the commands. The first agentic run showed no advantage over the baseline, and is
published as exactly that.

## Limitations

- Extraction is heuristic, not a parse. An idiom the patterns do not recognise is invisible;
  the fix is to widen a regular expression in `lib/extract/`, and the patterns are grouped at
  the top of each file for exactly that. Comments and string literals are blanked before the
  patterns run, so an idiom written in prose is not read as code.
- Language and framework support is what is listed above, no more.
- `affected` reads diffs through `git`, so the repository it reads must be a git checkout.
- Coverage is evidence overlay, not instrumentation. It reports what the tests *say* they
  touch, from their own source; it never runs them.
- The test suite is not part of this repository or the published package. It runs privately
  before each release, against corpora that are not public. The public verification is the
  worked example under `examples/demo-shop`, which CI runs end to end on every push.
- `span --from-component` covers the `web` repository kind only. A mobile-kind name is
  refused with its reason rather than answered partially.
- A minimal-API route is walked into its inline lambda, or into the method a method-group
  handler names. A handler held in a delegate variable, and a route filter, are not walked.
- A consumer is entered through the method whose parameter carries the message it consumes,
  or failing that through a known entry verb. A consumer that matches neither is reported as
  unresolved rather than entered through a guessed method.
- `routes-of` searches extracted facts only. Its literal mode is exact and allowlisted; it
  does not scan source, expand a concrete URL into a template, or use the optional code index.
- A parameterised Playwright title is the expression as written unless that repository is
  configured `"titles": true`, which runs its own installed Playwright in list mode during
  `extract` and appends the titles the listing resolves. A checkout and the npm package can
  do that; the single-file executable reports the titles as unavailable and extracts the rest.

## Contributing

Branch, pull request, green CI: [CONTRIBUTING.md](CONTRIBUTING.md) has the constraints a
change must keep, the single-file build subset among them. Vulnerabilities go through
[SECURITY.md](SECURITY.md), never a public issue. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md). [GOVERNANCE.md](GOVERNANCE.md) describes how the
project is run and how someone becomes a reviewer or maintainer;
[MAINTAINERS.md](MAINTAINERS.md) lists who holds that role today.
[ROADMAP.md](ROADMAP.md) lists capabilities under consideration.

Semantic versioning from `0.x` — the CLI surface may still change between minor versions.
What changed in each release is in [CHANGELOG.md](CHANGELOG.md). The current release is
`0.1.1`.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for
inclusion in this project by you, as defined in the Apache-2.0 license, shall be
dual-licensed as above, without any additional terms or conditions.
