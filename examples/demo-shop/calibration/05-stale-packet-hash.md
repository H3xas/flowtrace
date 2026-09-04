# 05 · a hash from another run

Packet: `POST orders/v1/checkout` — three seeds; two executing tests.
Reference: every seed stays at `route`; all three entries refused as `stale-verdict`.

The verdict names its seeds `U1`, `U2`, `U3` with no `key`, and its `packetHash` is the hash
the route would carry if U1 and U2 had been enumerated the other way round. Positional ids
only mean something against the enumeration they were written for; when the hash does not
match, the merge cannot tell whether `U1` still means the missing-token seed, so it applies
nothing and reports each entry as stale. The reading inside the entries is sound — it is the
reading 03 accepts — and it is still refused.

This is a refusal entry rather than a reading: a reader given the packet writes the current
hash and the keys, and would never produce this verdict. It is in the set so that a change to
the merge that quietly relaxes the hash check, or a harness that repairs old verdicts, fails
the build. Reproduce it by copying the reference verdict as it is.
