# reader-shapes

A small invented Playwright suite for a pottery studio, "Kiln Row". No real product, company
or code base is behind it. It holds only the shapes that the Playwright reader read before
its shared lexer, its fixture reader and its const folding came in: test declarations,
skipped blocks, case ids, direct and helper requests, client classes, status and effect
assertions, route stubs, stub helpers and backend classes.

`expected-facts.json` holds the facts that the reader gave for `suite/` before those changes.
`selftest/playwright-reader.test.js` extracts `suite/` again and compares the two, so a
change to the reader that moves one of these shapes shows up as a diff.

`mockCalls` is `["stubEverything"]` and `patchCalls` is `["seedKilns"]` for the comparison.
