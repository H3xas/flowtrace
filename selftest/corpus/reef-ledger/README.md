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
