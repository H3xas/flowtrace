# Getting started

From install to a first answer about your own code in about ten minutes. Every block below
is copy-paste, and every expected output is quoted from a real run. The steps are the same
whether a person or an AI agent performs them; [agent-guide.md](agent-guide.md) adds what to write into
a repository's instructions once the setup works.

Contents: [1. Install](#1-install) · [2. Try it on the worked example](#2-try-it-on-the-worked-example)
· [3. Point it at your own repositories](#3-point-it-at-your-own-repositories)
· [4. A working setup looks like this](#4-a-working-setup-looks-like-this)
· [5. When something is off](#5-when-something-is-off) · [6. What to commit](#6-what-to-commit)

## 1. Install

Pick one:

```
npm i -g flowtrace-cli            # needs Node 20 or newer; installs the `flowtrace` binary
```

or download the single-file executable for Linux, macOS or Windows from the
[releases page](https://github.com/H3xas/flowtrace/releases) and put it on your `PATH`, or run
straight from a checkout with `node bin/flowtrace.js` in place of `flowtrace` everywhere below.

Check:

```
flowtrace --help | head -1
```

```
usage: flowtrace <command> [options]
```

## 2. Try it on the worked example

The repository ships a small ASP.NET Core service and a Playwright suite under
`examples/demo-shop`. Its configuration is already written, so this is the fastest way to
see what every command prints.

```
git clone https://github.com/H3xas/flowtrace.git
cd flowtrace/examples/demo-shop
flowtrace extract
flowtrace join
```

```
extract api (backend): 91 facts -> out/facts/api.json
extract e2e (playwright): 15 facts -> out/facts/e2e.json
join 2 fact sets: 4 edges -> out/flow.json
```

Trace one route to everything it reaches, and enumerate its distinct outcomes (seeds):

```
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

Two markers are worth knowing on day one. `graph: unavailable` says the walk could not
extend past a hop without a code index configured ([scout.md](scout.md)); the walk stops
there rather than guessing. `[unknown: placed ← unresolved]` says a branch condition could
not be traced back to something a caller controls, so it is reported as unknown rather than
assumed reachable.

Now put the existing test evidence next to those seeds for the whole `checkout` area. The
bare name resolves to `areas/checkout.txt` inside the package; your own areas are passed as
paths.

```
flowtrace cover --area checkout
```

```
area checkout   3/5 area routes with executing evidence · 0 skipped-only · 2 none · 10 seeds · 0 path · 1 disposition
…
■■  GET catalog/v1/products  2 seeds · 2 intercepts (1 executing, 1 skipped) · match exact · …
  ■ U1  error_return=taken   → 400 BadRequest   route b3/s0   catalog.spec.ts :: lists the products of a category | …
  ■ U2  happy path           reads 1            route b0/s0   catalog.spec.ts :: lists the products of a category | …

□□  GET catalog/v1/products/*  2 seeds · no intercept evidence · …
  □ U1  error_return=taken   → 404 NotFound     none b3/s0    —
  □ U2  happy path           reads 1            none b0/s0    —
…
gaps  4 uncovered seeds in 4 groups, top 4
```

A filled square is a seed some executing test reaches; an empty one is a gap. The `gaps`
list at the end is ranked, so the first line is the most valuable missing test.

Three more commands turn that into work products, all under `out/`:

```
flowtrace span "POST orders/v1/checkout"        # one HTML page per route, outcome first, for a tester
flowtrace cases --area checkout --dry-run       # plain-English case sheets for the uncovered seeds
flowtrace scaffold --area checkout --dry-run    # starting Playwright specs for the same seeds
```

```
span POST orders/v1/checkout: 3 outcomes — 1 tested, 2 inherited-only, 0 untested (reconciles with cover: 3/3 seeds) -> out/span/post-orders-v1-checkout.html
```

Everything flowtrace writes lands under `out/` next to the configuration file: facts in
`out/facts/`, the boundary view in `out/flow.json`, the report in `out/report.md`, pages in
`out/span/`, drafts in `out/cases/` and `out/scaffold/`. Delete the directory and run
`extract` again to start over.

## 3. Point it at your own repositories

### 3.1 Choose a layout

flowtrace reads one file, `flowtrace.config.json`, and resolves every path in it relative to
the file itself. The simplest layout is a workspace directory holding the checkouts, with the
configuration beside them:

```
workspace/
  flowtrace.config.json      names the repositories below
  areas/                     your area files (step 3.7)
  out/                       written by flowtrace; never committed
  shop-api/                  an ASP.NET Core checkout        → "root": "shop-api"
  shop-e2e/                  a Playwright checkout           → "root": "shop-e2e"
```

A monorepo works the same way with the file at its root and the roots naming
sub-directories, exactly as `examples/demo-shop/flowtrace.config.json` does. Do not point a
root at the directory that holds `out/`: `scaffold` and `cases` refuse to write inside a
configured repository.

### 3.2 Write the configuration

```
cd workspace
cat > flowtrace.config.json <<'JSON'
{
  "out": "out",
  "repos": [
    { "id": "api", "kind": "backend", "root": "shop-api", "role": ["api"] },
    { "id": "e2e", "kind": "playwright", "root": "shop-e2e" }
  ]
}
JSON
```

Keep the repositories you have, delete the rest, and pick `kind` from this table:

| you have | `kind` | `root` points at |
|---|---|---|
| an ASP.NET Core service (C#) | `backend` | the checkout; controllers anywhere beneath it |
| a repository of message and DTO classes, no routes | `contracts` | the checkout |
| an Ionic/Angular app | `mobile` | the checkout (`featureRoots` narrows it) |
| a React + Redux app | `web` | the checkout (`srcSubpath` defaults to `src`) |
| a Playwright suite | `playwright` | the suite's checkout |

Two or more repositories of the same kind are fine; give each a distinct `id`. Every other
key is optional and documented in [configuration.md](configuration.md);
`flowtrace.config.example.json` at the repository root shows all of them filled in.

### 3.3 Extract

```
flowtrace extract
```

```
extract api (backend): <n> facts -> out/facts/api.json
extract e2e (playwright): <n> facts -> out/facts/e2e.json
```

One line per repository with a fact count. A count of `0` is the signal to stop and check
the `root` and `kind` (see [section 5](#5-when-something-is-off)); nothing downstream can
work from an empty fact set.

### 3.4 Join and read the report

```
flowtrace join
flowtrace render
```

`out/report.md` is the boundary view: which routes have a caller, which caller-side calls
name a route nothing declares, and which routes nobody calls. With only a backend and a
Playwright suite configured every route is listed under "Routes with no mobile caller" —
that is expected, since a spec is evidence, not a caller. Add a `mobile` or `web`
repository and the joined routes each get a page under `out/flows/`.

To list the route keys the facts declare, in the form every later command takes:

```
node -e "for (const f of JSON.parse(require('fs').readFileSync('out/facts/api.json')).facts) if (f.type === 'route') console.log(f.verb, f.template)"
```

For the worked example that prints:

```
GET catalog/v1/products
GET catalog/v1/products/{productId}
GET orders/v1/cart
POST orders/v1/cart/items
POST orders/v1/checkout
```

### 3.5 Trace a route

```
flowtrace trace "POST orders/v1/checkout" --seeds
```

Quote the key: it contains a space. A parameter segment may be written as the facts declare
it (`{productId}`) or as `*`; the tool prints `*`, and area files use `*`. Other shapes of
the same walk: `--mermaid` prints a flowchart, `--html <file>` writes a self-contained page,
`--json` emits the tree for a program.

### 3.6 Walk back from a grep hit

`trace` starts at a route. Mid-investigation you usually hold the other end: a line from a
grep result or a stack frame, a method name, a message class. `routes-of` takes that point
and reports every entry route whose complete walk passes through it, with one witness chain.

```
flowtrace routes-of "src/Services/OrderService.cs:43"
```

```
resolved file OrderService.PlaceOrder — api:src/Services/OrderService.cs:35
routes: 1 (complete across 5 entry routes)

POST orders/v1/checkout — api:src/Controllers/OrdersController.cs:36
  witness: shortest of 1 path
    start route POST orders/v1/checkout — api:src/Controllers/OrdersController.cs:36
    literal action OrdersController.Checkout — api:src/Controllers/OrdersController.cs:36
    ctor class IOrderService — api:src/Controllers/OrdersController.cs:14
    di class OrderService — api:src/Services/OrderService.cs:21
    body method OrderService.PlaceOrder — api:src/Services/OrderService.cs:35
  route evidence: route; 2 executing, 0 skipped
  …
note: route evidence is attached to the route and does not prove that the resolved point executed
```

A `file:line` resolves to the narrowest enclosing method the facts know; a bare or
class-qualified method name (`OrderRepository.SaveOrder`) resolves by exact declaration; an
exact literal such as a route template or a message class resolves against an allowlist of
fact fields, never against source text. When more than one fact matches, the command lists
the candidates and exits `2` instead of choosing:

```
flowtrace routes-of "OrderPlacedEvent" --literal
```

```
flowtrace: ambiguous point "OrderPlacedEvent" (2 candidates):
  consume.message="OrderPlacedEvent" — api:src/Messaging/OrderPlacedConsumer.cs:10
  publish.message="OrderPlacedEvent" — api:src/Services/OrderService.cs:43
```

`--symbol` and `--literal` force one resolution mode, `--repo <id>` narrows the point but
not the routes above it, and `--json` emits the same answer for a program. A route in the
set carries the route's own test evidence; the closing note is literal, and worth repeating
when relaying the answer.

### 3.7 Write an area file

`cover`, `affected`, `scaffold` and `cases` need a denominator, and flowtrace will not invent
one. An area is a committed list of route keys, one per line, with the selection rule written
above it so the next reader can re-derive it:

```
mkdir -p areas
cat > areas/checkout.txt <<'TXT'
# checkout — every route the cart and checkout flow reaches.
GET catalog/v1/products
GET catalog/v1/products/*
POST orders/v1/checkout
TXT
```

Format details in [../areas/README.md](../areas/README.md).

### 3.8 Cover

```
flowtrace cover --area areas/checkout.txt
```

The first line is the headline: routes with executing evidence over routes in the area, then
seeds by tier. `--json` emits the whole report; `--md out/checkout.md` writes it as a page.

### 3.9 Turn a diff into the specs that must run

```
flowtrace affected --diff main...HEAD --area areas/checkout.txt
flowtrace affected --diff main...HEAD --area areas/checkout.txt --playwright-args
```

`--diff` takes anything `git diff` takes; `--staged` reads the index; with neither the
working tree is read. The exit code is the answer's shape: `0` a list was produced, `3`
nothing was affected, `4` the selection was widened to the whole suite with the reason on
stderr, `2` usage, `1` refusal. Facts behind the repository's HEAD are one of the widening
reasons, so run `extract` first in a fresh checkout.

### 3.10 Optional: a code index for the hops facts cannot make

Configure [devscout](https://github.com/H3xas/devscout-rs) or any other tool speaking the
same contract and mark the repositories it covers with `"scout": true`. Every
`graph: unavailable` hop becomes one more step. Setup and isolation rules in
[scout.md](scout.md); a trace without an index is a smaller trace, not a failed one.

## 4. A working setup looks like this

- `flowtrace extract` prints a non-zero fact count for every repository.
- `out/report.md` lists your routes under one of its headings.
- `flowtrace trace "<VERB template>"` on one of those keys prints a tree with at least one
  branch or sink beneath the action.
- `flowtrace cover --area areas/<name>.txt` prints a headline of the form `N/M area routes
  with executing evidence`.
- `flowtrace affected --diff <range> --area areas/<name>.txt` exits `0` or `3` on a diff that
  touches production source.

## 5. When something is off

| what you see | why | what to do |
|---|---|---|
| `flowtrace: config: no configuration file at …/flowtrace.config.json` | run from a directory without the file | `cd` to the workspace, or pass `--config <path>` |
| `flowtrace: config …: "repos[0].kind" must be one of backend, mobile, contracts, playwright, web` | typo in `kind` | pick from the table in 3.2 |
| `flowtrace: walk: root does not exist: …` | `root` resolved against the file's directory, not your shell's | make it relative to the configuration file |
| `extract api (backend): 0 facts` | the root holds no source of that kind, or `exclude` swallows it | point `root` at the checkout that holds the controllers; narrow `exclude` |
| `flowtrace: no page, component, service, route, method or class matches "…"` | the start is not a key the facts declare | list the keys as in 3.4; quote the argument |
| `flowtrace: facts for api are stale (extracted at …) — run flowtrace extract --repo api` | the repository moved since the last extract | run `flowtrace extract`; `affected` treats this as a widening and exits `4` |
| `graph: unavailable` on a hop | no code index configured | expected; see 3.10 |
| `[unknown: x ← unresolved]` on a seed | a branch condition no caller controls, or the trace-back gave up within its three-hop bound | not an error; the seed is reported as unknown, never as covered |
| `--area checkout` reads the package's own example instead of yours | a bare name resolves inside the package | pass the path: `--area areas/checkout.txt` |

Errors exit `1`; a usage or configuration error exits `2` and prints the help text under the
message.

## 6. What to commit

- `flowtrace.config.json`, when its roots are relative and the layout is shared by the team.
  A file naming machine-specific absolute paths stays local; commit an example instead.
- `areas/*.txt`, always: the denominator is a reviewed artefact.
- Never `out/`. Add it to the workspace's `.gitignore`.

Next: [concepts.md](concepts.md) for what facts, seeds and evidence tiers mean;
[cli.md](cli.md) for every flag; [agent-guide.md](agent-guide.md) to hand the setup to an AI agent.
