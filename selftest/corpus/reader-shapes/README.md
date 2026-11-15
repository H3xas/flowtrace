# reader-shapes

A small invented Playwright suite for a pottery studio, "Kiln Row". No real product, company
or code base is behind it. It holds only the shapes that the Playwright reader read before
its shared lexer, its fixture reader and its const folding came in: test declarations,
skipped blocks, case ids, direct and helper requests, client classes, status and effect
assertions, route stubs, stub helpers and backend classes.

`expected-facts.json` holds the facts that the reader gave for `suite/` before those changes.
`selftest/playwright-reader.test.js` extracts `suite/` again and compares the two, so a
change to the reader that moves one of these shapes shows up as a diff.

Two later additions are also in the file. Each `pw_test` has `eligibility` and `guards`. The
`tms.id(row.id)` call in the `ROWS` loop gives one `evaluated` `case_id` for each row.

`mockCalls` is `["stubEverything"]` and `patchCalls` is `["seedKilns"]` for the comparison.
