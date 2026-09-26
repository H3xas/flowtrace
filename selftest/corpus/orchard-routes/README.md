# Orchard routes matrix

An invented React client — an orchard planner — whose only purpose is to pin how
`flowtrace trace <browser path>` turns a nested browser URL into one page entry, or into a
named reason it cannot. No real product, company or codebase is behind it, and it has no
backend: joining a page's requests to backend routes is pinned by the journey pack in
`../greenhouse-alerts`.

`matrix.json` lists one row per question: the start, the configuration it runs under, and
either the page entry expected (`<file>#<component>`, repository-relative) or the failure
reason expected. Every expectation was written from the source below.
`selftest/page-routes.test.js` runs every row and checks the detail behind it.

## What the source declares

- `src/index.tsx` renders `OrchardApp` inside `<BrowserRouter basename="/orchard">`, so that
  root is mounted by source, not by guess.
- `OrchardApp` nests routes as JSX children of a `/` layout route: an index route, a `rows`
  layout with its own index and `:rowId` children, an absolute `/harvest/*` child whose element
  holds its own `<Routes>`, a `<Navigate>` redirect, two routes on one path in the two arms of
  a feature condition, a route wrapped in an access component, a `reports/*` wildcard, a route
  whose path is an expression, and a `shed/*` route whose element declares its routes as
  objects.
- `HarvestRoutes` mounts a lazily imported page inside `Suspense`.
- `PartnerRoutes` and `AuditRoutes` are exported and rendered by nothing here: whatever mounts
  them is outside this source. Both declare `ledger`, each through its own lazy binding named
  `LedgerPage`.
- Two files declare a component named `RowDetail`; `OrchardApp` imports one of them.
- Two `navigate('/orchard/…')` literals are the only evidence of an `/orchard` prefix outside
  the router's own `basename`.

## Configurations

- `orchard.config.json` supplies nothing beyond the repository.
- `orchard-mounted.config.json` supplies a mount for `PartnerRoutes` and a value for the
  `features.pruningPlanner` condition, so the same questions show what a caller-provided
  mount and assumption change, and that both stay visible in the answer.
