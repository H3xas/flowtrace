# reef-ledger

An invented dive log service: a small ASP.NET Core backend and a React client. Every name is
invented. The `test-evidence-*.test.js` files copy this directory, run `extract` over the
copy and read what the verbs print.

## What each file is for

| File | What it holds |
|---|---|
| `backend/src/Controllers/DiverController.cs` | `GET reef/v1/divers/me` beside `GET reef/v1/divers/{diverId}`, and `GET reef/v1/divers/{diverId}/logs`. |
| `web/src/actions/logs.ts` | A gateway call to `/reef/v1/divers/guide-7/logs`, a literal segment where the route has a parameter. |
| `web/src/logs/GuideLogsPanel.tsx` | A component that dispatches the action, so `span --from-component` reaches the route. |
| `web/src/http/httpClient.ts` | The gateway client the action calls. |
| `backend/src/Controllers/SiteController.cs` | Four site routes, one of them reached by no spec. |
| `web/cypress/e2e/sites.cy.ts` | A Cypress intercept of `GET reef/v1/sites`. |
| `suite/tests/sites.spec.ts` | Playwright API requests: two name a route, one names none. |
| `suite/ui/sites.pw.ts` | Playwright route stubs: one names a route, one names no path, one names no route, and one helper call names no URL. |
| `suite/ui/panels.ts` | The stub helper that loops over its own URL list, so no call site names its URL. |
| `reef.area.txt` | The site routes `cover` reads. |
