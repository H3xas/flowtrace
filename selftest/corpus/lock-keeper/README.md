# lock-keeper

An invented canal lock: a small ASP.NET Core backend, a React client and an Ionic app. Every
name is invented. `selftest/caller-gates.test.js` copies this directory, runs `extract` over
the copy, and reads the `caller_gate` records and the gates and caller cases of `trace`.

## What each file is for

| File | What it holds |
|---|---|
| `web/src/passages/PassageDesk.ts` | One method for each decision form that can gate a call. The arm forms are `if`, `else`, `else if`, `case`, ternary arms, and right operands of `&&`, `\|\|` and `??`. One `case` clause is an earlier clause's fall-through target. An unparenthesized `&&`/`\|\|` mix comes in both orders. The exit forms are `return`, `throw`, an exit in an enclosing block, a callback or another method, an exit in one arm, `break`, `continue`, and exits in a `try` and a `catch`. The calls go through `import * as api from '../api'`. A display ternary and a call inside a condition gate nothing. In `sameRoute`, one method has a gated and an ungated call to one route. `oneLine` and `lineMix` put two calls on one line. |
| `mobile/src/app/features/passages/passage-desk.service.ts` | The same method bodies in an `@Injectable` class, with the calls on the injected field `this.api`. |
| `web/src/passages/PassagePanel.tsx` | A component whose `submit()` holds `if (form.valid) { api.save(x); }`, a handler that calls inside a condition, and a display ternary in `render()`. |
| `web/src/passages/KeeperPanel.tsx` | A component with two nested `if` statements around one call, which give two caller cases. |
| `web/src/passages/HarborPanel.tsx` | Two handlers that reach one gated method, one of them under its own gate, and a call under a mixed `\|\|`/`&&` chain. |
| `web/src/api.ts`, `web/src/http/httpClient.ts` | The module functions that send the two requests. |
| `mobile/src/app/features/passages/passage-api.service.ts`, `mobile/src/app/features/core/gateway.service.ts` | The mobile service and gateway that send the same two requests. |
| `backend/` | The two routes, `POST lock/v1/passages` and `GET lock/v1/passages/{passageId}`. |

The tests find each line by its text. A change to a file must keep the method names and call
texts that the tests use.
