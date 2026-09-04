# 05-stale-packet-hash

`POST orders/v1/checkout` · seeds named by position under a packet hash from another run; every entry is rejected as stale.

Rule: a verdict naming a seed by position only is trusted while its packet hash still matches this run.

The verdict names its seeds by position (`U1`, `U2`, `U3`) with no stable key, and carries a packet hash that is not this run's. Positional ids do not survive a re-extract — a branch added or a phantom split collapsed renumbers them — so the merge rejects all three entries as `stale-verdict` and applies nothing, even though the first one would have been a correct disposition reading against a current hash.
