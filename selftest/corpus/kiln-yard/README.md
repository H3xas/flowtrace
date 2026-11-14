# kiln-yard

An invented pottery yard: a small ASP.NET Core backend, a React client and an Ionic app.
Every name is invented. `selftest/caller-decisions.test.js` copies this directory, runs
`extract` over the copy, and reads the web and mobile `branch_point` facts it writes.

## What each file is for

| File | What it holds |
|---|---|
| `web/src/forms/DecisionForms.ts` | Each decision form inside a class method, and in `quiet()` the text that must give no decision: strings, a template literal, comments, a regex literal, optional chaining, logical assignments and type syntax. A field initializer and a module constant sit outside every method body. The method of the module-level `helpers` object literal is a span of `helpers`. |
| `mobile/src/app/features/forms/decision-forms.service.ts` | The same class body as the web file, on the same lines, in an `@Injectable` class. |
| `web/src/forms/FormsPanel.tsx` | JSX text with `?`, `&&`, `\|\|` and `??`, beside JSX expression containers that hold real decisions. |
| `web/src/ledger/LedgerService.ts`, `mobile/src/app/features/tally/tally.service.ts` | A class whose `pick()` holds a decision and makes no call, so a class start that read caller decisions would list it. |
| `web/src/kiln/KilnPanel.tsx`, `web/src/actions/firings.ts` | A component that dispatches a creator calling the backend route. |
| `backend/` | One route, `GET kiln/v1/kilns/{kilnId}/firings`, and the service it calls, each with a decision. |

The tests write their own coverage reports from the line numbers of these files, so a change
to a file moves the line numbers that the tests state.
