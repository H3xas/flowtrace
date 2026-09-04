# 04-skipped-only-candidate

`GET catalog/v1/products` · the only candidate is a skipped test; a promotion is rejected as not-executed and the seeds stay skipped.

Rule: a seed whose mechanical level is none or skipped never ran, so no verdict can promote it.

The packet is the catalog listing with its candidates reduced to the one skipped test; the packet hash is unchanged because it covers the route and its seeds, not the candidates. The excerpt reads like disposition evidence — it asserts the 400 the missing-category guard answers — but a skipped test never ran. The mechanical floor is `skipped`, the merge rejects the promotion as `not-executed`, and both seeds stay where they were.
