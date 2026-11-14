# lantern-console

An invented settings console. It has an ASP.NET Core backend, a React client and an Ionic
client, and each client has a Cypress suite. No real product, company or code base is behind
it. One route carries one request from app code and five requests from Cypress files. So a
reader can count app callers and test evidence apart on the same key.
`selftest/cypress-evidence.test.js` copies this directory, runs `extract` and `join` over the
copy, and then reads `cover` and `span`.

## Layout

- `lantern.config.json` names the three repositories. The `web` entry reads its suite through
  `cypressSubpath: "cypress"`, which sits outside `src`. The `mobile` entry reads
  `cypress/e2e` and `cypress/support` by default.
- `lantern.area.txt` lists the two routes for `cover`.
- `backend/src/Controllers/SettingsController.cs` declares `GET lanterns/v1/settings` and
  `GET lanterns/v1/audit`.
- `web/src/services/settings.service.ts` calls the settings route through
  `httpClient.getGatewayClient().get(...)`.
- `web/cypress/e2e/settings.cy.js`, `web/cypress/support/commands.js` and
  `web/cypress/pages/settings.page.js` each intercept the settings route.
  `web/cypress/pages/settings.page.js` also intercepts the audit route.
- `mobile/src/app/features/settings/console-settings.service.ts` calls the settings route
  through a `GatewayService` field.
- `mobile/cypress/e2e/settings.cy.ts` and `mobile/cypress/support/commands.ts` each intercept
  the settings route.

## What the test expects

The settings route has two `calls` edges, one from each app service file, and five `tests`
edges, one from each Cypress file. The audit route has one `tests` edge from the page model,
no `calls` edge, and it stays in `unjoined.routes_without_caller`. `cover` counts five
intercepts for the settings route and one for the audit route. The span page for the settings
route names only the two app service files as call sites.
