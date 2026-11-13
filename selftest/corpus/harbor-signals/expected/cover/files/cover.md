# coverage — area harbor.area

**0/3 area routes with executing evidence · 0 skipped-only · 3 none · 3 seeds · 0 path · 0 disposition**

evidence is per route: an intercept proves the request reached the route, not which way through it, so every seed of a route carries that route's evidence. path and disposition need a reader.

Glyphs: `■` route observed · `◆` path (reader) · `◈` disposition (reader) · `◪` skipped-only · `□` none.

## Pages

A page is a screen, not a route: it never enters the route index below, and carries only the coverage of the routes it reaches.

| page | component | repo | handlers | routes | pw |
|---|---|---|---|---|---|
| `/greenhouse/*` | GreenhouseShell | web | 0 | 2 | 0/2 |
| `/greenhouse/alerts/watchers` (inferred mount) | WatcherPreferencesPage | web | 4 | 1 | 0/1 |
| `/greenhouse/overview` (inferred mount) | ZoneOverviewPanel | web | 2 | 1 | 0/1 |
| `/greenhouse/zones/:zoneId/*` (inferred mount) | ZoneRoutes | web | 0 | 2 | 0/2 |

## Matrix

### □ `GET glasshouse/v1/zones/*/watchers`

GET glasshouse/v1/zones/*/watchers — `src/Controllers/ZoneWatchersController.cs:22`

1 seed · no intercept evidence · cypress none (0) · playwright none (0) · seed count partial (unknown: provider-unavailable 1)

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | happy path | reads 1 | □ none | 0 | 0 | — |

### □ `GET glasshouse/v1/zones/*/readings`

GET glasshouse/v1/zones/*/readings — `src/Controllers/ZoneReadingsController.cs:19`

1 seed · no intercept evidence · cypress none (0) · playwright none (0)

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | happy path | reads 1 | □ none | 0 | 0 | — |

### □ `POST glasshouse/v1/zones/*/harvest-plan`

POST glasshouse/v1/zones/*/harvest-plan — `src/Controllers/HarvestPlanController.cs:19`

1 seed · no intercept evidence · cypress none (0) · playwright none (0)

| seed | dispositions | sinks | level | branch | sink | evidence |
|---|---|---|---|---|---|---|
| U1 | happy path | db HarvestPlanRepository.InsertPlan · reads 12 | □ none | 0 | 3 | — |

## Gaps

key (level, branch, sink): level ascending, then branch weight descending, then sink weight descending, then route key — tiers, never a sum

branch weight  error_return · validation 3 · toggle 2 · guard 1 · plain 0   ·   sink weight  db write 3 · publish 2 · push · http 1 · db read · nothing 0

| level | branch | sink | seeds | dispositions | sinks |
|---|---|---|---|---|---|
| □ none | 0 | 3 | `POST glasshouse/v1/zones/*/harvest-plan#U1` | happy path | db HarvestPlanRepository.InsertPlan · reads 12 |
| □ none | 0 | 0 | `GET glasshouse/v1/zones/*/readings#U1` | happy path | reads 1 |
| □ none | 0 | 0 | `GET glasshouse/v1/zones/*/watchers#U1` | happy path | reads 1 |

## What the suite focuses on

Intercepts per area route — how much of the suite points at each route.

| route | intercepts | executing | skipped | specs |
|---|---|---|---|---|
| `GET glasshouse/v1/zones/*/readings` | 0 | 0 | 0 | 0 |
| `GET glasshouse/v1/zones/*/watchers` | 0 | 0 | 0 | 0 |
| `POST glasshouse/v1/zones/*/harvest-plan` | 0 | 0 | 0 | 0 |

Tests per spec, for every spec that names an area route.

| spec | tests | skipped | skipped share | intercepts | area routes |
|---|---|---|---|---|---|

## Levels that need a reader

`path` and `disposition` are reported as `needs-reader` on every route. What would promote them:

- `path` — an assertion on a response field only produced on that path, a follow-up read that observes the effect, or an assertion on a push effect
- `disposition` — an asserted status or body that maps to exactly one error_return, validation or guard, or a toggle set and read with the toggled assertion

Intercepts skipped as evidence: 0 with no path, 0 matching no route.

## Cypress vs Playwright parity

Per route: an executing `cypress_intercept` vs an executing `pw_stub` of kind `route` (not `opaque`) — the Playwright UI E2E harness, never the unrelated backend-API one.

cypress-only 0 · playwright-only 0 · both 0 · neither 3 · 0 opaque stubs (never joined).

| route | cypress | playwright | cypress specs | playwright specs |
|---|---|---|---|---|
| `GET glasshouse/v1/zones/*/watchers` | □ none | □ none | 0 | 0 |
| `GET glasshouse/v1/zones/*/readings` | □ none | □ none | 0 | 0 |
| `POST glasshouse/v1/zones/*/harvest-plan` | □ none | □ none | 0 | 0 |
