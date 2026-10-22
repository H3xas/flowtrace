# 03 · a status that maps to one guard

Packet: `POST orders/v1/checkout` — four seeds; two executing tests.
Reference: U1 promoted to `disposition`, U2, U3 and U4 confirmed at `route`; one upgrade, three
confirmations.

The second test posts a body with no payment token and asserts a 400. On this route exactly
one guard returns 400 — the missing-token check U1 takes — so the assertion pins that branch
outcome and meets the packet's `disposition` rule.

The first test posts a valid token and asserts a 200. That assertion does not separate the
two declined-order seeds from the completed order. U2 is the action's 403 on a declined order,
and U3 is the 403 that the service's refused save gives. Each needs a repository refusal that no
test arranges. U4 is the completed order, whose saved order and published message are never
observed. All three stay at `route`.

The trap is symmetric: reading the 400 as just a status leaves U1 under-read, and reading the
200 as effect evidence over-reads U4.
