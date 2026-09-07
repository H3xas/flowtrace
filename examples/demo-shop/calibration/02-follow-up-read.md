# 02 · a follow-up read observed

Packet: `GET orders/v1/cart` — one seed; one executing test.
Reference: the seed is promoted to `path`; one upgrade.

The test reads the cart and, after the status check, asserts that the body has an `items`
property. The body is what this read serves and nothing else on the route produces it, so
the assertion observes the path itself rather than the fact that a request arrived. That is
the packet's `path` rule met on its first clause.

A reader that stops at `route` here has under-read: the status line alone would justify
that, but the test does not stop at the status line. The merge accepts the upgrade because
the entry names the seed by its key, carries the packet's hash and cites the test.
