# 06-neighbouring-route

`POST orders/v1/checkout` · a verdict written against a neighbouring route; the merge has no such route and rejects it.

Rule: a verdict is merged into the route it names, and a route the packet does not hold is unknown.

The packet is the checkout route; the verdict answers for the cart route beside it — a correct reading of the wrong packet. The merge looks the verdict's route up in the report it was handed, finds nothing, and rejects the whole file as `unknown-id`. Evidence naming a neighbouring route never reaches this route's seeds.
