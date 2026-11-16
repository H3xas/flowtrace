# coverage — area harbor.area

**1/3 area routes with executing evidence · 0 skipped-only · 2 none · 6 seeds · 3 shared-gate · 0 path · 1 disposition**

evidence is per route: an intercept proves the request reached the route, not which way through it, so every seed of a route carries that route's evidence. path and disposition need a reader.

Glyphs: `■` route observed · `◆` path (reader) · `◈` disposition (reader) · `◪` skipped-only · `□` none.

## Pages

A page is a screen, not a route: it never enters the route index below, and carries only the coverage of the routes it reaches.

| page | component | repo | handlers | routes | pw |
|---|---|---|---|---|---|
| `/greenhouse/*` | GreenhouseShell | web | 0 | 2 | 1/2 |
| `/greenhouse/alerts/watchers` (inferred mount) | WatcherPreferencesPage | web | 4 | 1 | 1/1 |
| `/greenhouse/overview` (inferred mount) | ZoneOverviewPanel | web | 2 | 1 | 0/1 |
| `/greenhouse/zones/:zoneId/*` (inferred mount) | ZoneRoutes | web | 0 | 2 | 1/2 |

## Matrix

### ◈■ `GET glasshouse/v1/zones/*/watchers`

GET glasshouse/v1/zones/*/watchers — `src/Controllers/ZoneWatchersController.cs:22`

2 seeds · 1 intercept (1 executing, 0 skipped) · match exact · cypress none (0) · playwright none (0) · 1 from shared gates

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | reject=taken  [shared gate RelayCheckFilter] | → 403 Forbidden | ◈ disposition | 3 | 0 | tests/watchers.spec.ts :: a grower the relay ledger refuses gets no watchers (8) — expect status 403 |
| U2 | happy path | reads 1 | ■ route | 0 | 0 | tests/watchers.spec.ts :: a grower the relay ledger refuses gets no watchers |

### □□ `GET glasshouse/v1/zones/*/readings`

GET glasshouse/v1/zones/*/readings — `src/Controllers/ZoneReadingsController.cs:19`

2 seeds · no intercept evidence · cypress none (0) · playwright none (0) · 1 from shared gates

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | reject=taken  [shared gate RelayCheckFilter] | → 403 Forbidden | □ none | 3 | 0 | — |
| U2 | happy path | reads 1 | □ none | 0 | 0 | — |

### □□ `POST glasshouse/v1/zones/*/harvest-plan`

POST glasshouse/v1/zones/*/harvest-plan — `src/Controllers/HarvestPlanController.cs:19`

2 seeds · no intercept evidence · cypress none (0) · playwright none (0) · 1 from shared gates

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | reject=taken  [shared gate RelayCheckFilter] | → 403 Forbidden | □ none | 3 | 0 | — |
| U2 | happy path | db HarvestPlanRepository.InsertPlan · reads 12 | □ none | 0 | 3 | — |

## Gaps

key (level, branch, sink): level ascending, then branch weight descending, then sink weight descending, then route key — tiers, never a sum

branch weight  error_return · validation 3 · toggle 2 · guard 1 · plain 0   ·   sink weight  db write 3 · publish 2 · push · http 1 · db read · nothing 0

| level | branch | sink | seeds | dispositions | sinks |
|---|---|---|---|---|---|
| □ none | 3 | 0 | `GET glasshouse/v1/zones/*/readings#U1` | reject=taken | → 403 Forbidden |
| □ none | 3 | 0 | `POST glasshouse/v1/zones/*/harvest-plan#U1` | reject=taken | → 403 Forbidden |
| □ none | 0 | 3 | `POST glasshouse/v1/zones/*/harvest-plan#U2` | happy path | db HarvestPlanRepository.InsertPlan · reads 12 |
| □ none | 0 | 0 | `GET glasshouse/v1/zones/*/readings#U2` | happy path | reads 1 |

## What the suite focuses on

Intercepts per area route — how much of the suite points at each route.

| route | intercepts | executing | skipped | specs |
|---|---|---|---|---|
| `GET glasshouse/v1/zones/*/watchers` | 1 | 1 | 0 | 1 |
| `GET glasshouse/v1/zones/*/readings` | 0 | 0 | 0 | 0 |
| `POST glasshouse/v1/zones/*/harvest-plan` | 0 | 0 | 0 | 0 |

Tests per spec, for every spec that names an area route.

| spec | tests | skipped | skipped share | intercepts | area routes |
|---|---|---|---|---|---|
| `tests/watchers.spec.ts` | 1 | 0 | 0% | 1 | 1 |

## Levels that need a reader

`path` and `disposition` are reported as `needs-reader` on every route. What would promote them:

- `path` — an assertion on a response field only produced on that path, a follow-up read that observes the effect, or an assertion on a push effect
- `disposition` — an asserted status or body that maps to exactly one error_return, validation or guard, or a toggle set and read with the toggled assertion

Intercepts skipped as evidence: 0 with no path, 0 matching no route, 0 with an unknown base.

## Cypress vs Playwright parity

Per route: an executing `cypress_intercept` vs an executing `pw_stub` of kind `route` (not `opaque`) — the Playwright UI E2E harness, never the unrelated backend-API one.

cypress-only 0 · playwright-only 0 · both 0 · neither 3 · 0 opaque stubs (never joined).

| route | cypress | playwright | cypress specs | playwright specs |
|---|---|---|---|---|
| `GET glasshouse/v1/zones/*/watchers` | □ none | □ none | 0 | 0 |
| `GET glasshouse/v1/zones/*/readings` | □ none | □ none | 0 | 0 |
| `POST glasshouse/v1/zones/*/harvest-plan` | □ none | □ none | 0 | 0 |
