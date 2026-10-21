# lantern-depot

An invented storage depot, "Lantern Depot", with shelves, bins and crates. It has two ASP.NET
Core controllers (`backend/`) and one Playwright API suite (`depot/`). No real product,
company or code base is behind it. The suite reaches its requests through helper functions,
helper classes and clients, the shapes that decide which request a test call leads to.
`selftest/helper-requests.test.js` reads it.

## Layout

- `lantern.config.json` names both repositories.
- `lantern.area.txt` lists the controller routes, for `cover`.
- `depot/clients/` holds the clients. Each one takes the request context as a constructor
  parameter property and builds its URLs from module consts:
  - `shelf-client.ts`, `bin-client.ts` and `crate-client.ts` each define their own `base`.
    `crate-client.ts` has a method named `delete`, and both `bin-client.ts` and
    `crate-client.ts` have a method named `close`.
  - `ledger-client.ts` imports `ledgerRoot` from `ledger-paths.ts`. `archive-client.ts`
    defines its own `ledgerRoot` with another value and does not export it.
  - `north-zone-client.ts` and `south-zone-client.ts` each define `area` with another value.
    `gate-client.ts` uses `area`, which it neither defines nor imports, and `dockRoot`, which
    only `dock-paths.ts` defines.
- `depot/helpers/` holds the helpers:
  - `tidy.ts` and `shelf-steps.ts`: a top-level arrow helper calls a helper class method,
    which calls two client methods through a typed field.
  - `sweep.ts`: a helper function with three client calls on a typed parameter (one plain,
    one inside an `expect` argument and one inside an arrow function), and three classes
    that make the same calls through a field. The classes type the field by a constructor
    parameter property, by a field declaration and by a `new` assignment in the constructor.
  - `audit.ts`: a request in a top-level function.
  - `stub.ts`: a helper that stubs a route and also calls a client, and a helper that calls
    it.
  - `ambiguous.ts`: a call on an untyped parameter whose method two clients define.
  - `deep.ts`: four helpers in a line, so that a test reaches a request in four bodies or
    needs five.
  - `cycle.ts`: two helpers that call each other on the way to a request, and two that call
    each other with no request.
- `depot/tests/` holds one spec for each group of shapes: `shelves`, `sweep`, `bins`
  (requests inside and before an `expect`), `scope`, `audit`, `stub`, `ambiguous`, `depth`
  and `direct`.
- `base-facts.json` holds the facts of the other Playwright corpora and of
  `examples/demo-shop`, as the extractor wrote them before it followed helper calls.
  `capture.mjs` writes it. Run it with the CLI of the commit the file pins:

  ```
  node selftest/corpus/lantern-depot/capture.mjs --cli <checkout>/bin/flowtrace.js > selftest/corpus/lantern-depot/base-facts.json
  ```
