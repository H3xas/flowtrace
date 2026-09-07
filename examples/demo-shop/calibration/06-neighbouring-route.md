# 06 · a verdict for the route next door

Packet: `POST orders/v1/checkout` — three seeds; two executing tests.
Reference: every seed stays at `route`; the file refused once as `unknown-id`.

The verdict is a correct reading of the cart route — the one 02 accepts — filed against the
checkout packet. The merge looks up the route the verdict names in the report built from this
packet, finds no such route, and refuses the whole file before it reads a single seed.
Nothing about the cart read reaches the checkout seeds.

As with 05, no reader produces this from the packet; it pins that evidence never leaks
across routes. Reproduce it by copying the reference verdict as it is.
