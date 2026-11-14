# widget-gate

An invented gate suite. Its spec files hold each form that decides whether a Playwright test
runs: a skip or fixme declaration, a skipped or fixme describe at two depths, a guard with no
condition, and guards with a condition at file, describe, hook and test scope. One spec file
holds guards whose condition cannot be read: an imported binding, a `let` binding, a call, and
a variable the configuration does not name.

`gate.config.json` names no environment values, `gate-dev.config.json` and
`gate-stage.config.json` name `E2E_ENV`. `gate.area.txt` lists the four routes for `cover`.
`ui/parked.pw.ts` stubs a route inside a fixme describe.

`test-eligibility.test.js` runs the corpus through the CLI, one `Test eligibility AC-n:` test
for each acceptance rule.
