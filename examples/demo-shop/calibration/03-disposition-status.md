# 03 · a status that maps to one guard

Packet: `POST orders/v1/checkout` — three seeds; two executing tests.
Reference: U1 promoted to `disposition`, U2 and U3 confirmed at `route`; one upgrade, two
confirmations.

The second test posts a body with no payment token and asserts a 400. On this route exactly
one guard returns 400 — the missing-token check U1 takes — so the assertion pins that branch
outcome and meets the packet's `disposition` rule.

The first test posts a valid token and asserts a 200. A 200 is what both remaining seeds
answer with, so it does not separate the declined order (U2, which needs a repository refusal
no test arranges) from the completed order (U3, whose saved order and published message are
never observed). Both stay at `route`.

The trap is symmetric: reading the 400 as just a status leaves U1 under-read, and reading the
200 as effect evidence over-reads U3.
