# 01 · a status assertion and nothing else

Packet: `GET catalog/v1/products` — two seeds; three candidates: one executing test, one
skipped test and one route patch.
Reference: both seeds confirmed at `route`; no upgrade.

The executing test requests the listing with a category and checks for a 200. That is enough
to show the request reached the route, which is where both seeds already stand. It says
nothing about what the listing returned, so the read behind U2 is not observed, and it never
takes the missing-category branch behind U1.

The 400 assertion in the second candidate would pin U1 to `disposition` if it ran. It is a
`test.skip`, so it is not evidence for any level; a reader that counts it has promoted a seed
on a test that never executed.

The third candidate is the route patch in `ui/storefront.pw.ts`. A helper registers it outside
any test block, so the packet names no test for it and shows the lines around the call
instead. The patch fetches the live listing and halves the prices the page renders. At most,
that shows a request reaches the route, where both seeds already stand. The one assertion in
the window reads page text, `Half price`. That text is not a response field that only one path
produces. It is not an asserted status or body either. So the patch meets neither rule the
packet states, and it promotes neither seed.

A reader agrees with this entry by writing one entry per seed at `route`. The merge counts
both as confirmations and applies no upgrade.
