# 01 · a status assertion and nothing else

Packet: `GET catalog/v1/products` — two seeds; one executing test, one skipped test.
Reference: both seeds confirmed at `route`; no upgrade.

The executing test requests the listing with a category and checks for a 200. That is enough
to show the request reached the route, which is where both seeds already stand. It says
nothing about what the listing returned, so the read behind U2 is not observed, and it never
takes the missing-category branch behind U1.

The 400 assertion in the second candidate would pin U1 to `disposition` if it ran. It is a
`test.skip`, so it is not evidence for any level; a reader that counts it has promoted a seed
on a test that never executed.

A reader agrees with this entry by writing one entry per seed at `route`. The merge counts
both as confirmations and applies no upgrade.
