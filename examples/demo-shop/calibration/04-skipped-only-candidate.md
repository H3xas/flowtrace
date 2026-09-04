# 04 · the only candidate is skipped

Packet: `POST orders/v1/cart/items` — two seeds; one candidate, and it is a `test.skip`.
Reference: both seeds stay at `skipped`; both reader entries refused as `not-executed`.

The skipped test posts an item with no quantity and asserts a 400, which is exactly the
assertion that would pin U1's guard. It has never run. The mechanics leave the route at
`skipped`, and the merge refuses every entry a reader writes against a seed in that state,
whatever level it claims — `skipped`, `route` or `disposition` all end as `not-executed`.

What the entry pins is that the refusal happens, and happens once per seed. The reference
answers for both seeds at the floor and cites the skipped test as the reason nothing moved.
A reader that answers only for U1, or leaves the packet out, produces a different rejection
count and disagrees.
