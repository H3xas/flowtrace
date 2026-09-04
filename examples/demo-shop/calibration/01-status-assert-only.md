# 01-status-assert-only

`POST orders/v1/checkout` · a 200 status assertion on the request and nothing else; every seed stays at route.

Rule: a verdict naming the seed's current level is a confirmation, not an upgrade: the reader looked and chose not to promote.

Tempting wrong level: `path` for U3. The test does post a valid checkout and asserts on the response, so it reads like effect evidence. But `expect(response.status()).toBe(200)` is the status every non-rejecting seed of this route returns: it proves the request ran, which is the `route` floor the seed already sits at, and names nothing the order write alone produces. All three seeds are confirmed at `route`; the merge counts three confirmations and no upgrade.
