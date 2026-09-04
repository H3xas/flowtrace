# 03-disposition-status

`POST orders/v1/checkout` · an asserted status that maps to exactly one guard; that seed reaches disposition, the others stay route.

Rule: an asserted status or body that maps to exactly one error_return, validation or guard, or a toggle set and read with the toggled assertion.

Tempting wrong level: `route` for U1, because a status assertion usually proves only that the request ran. Here the asserted status is `400`, and exactly one guard on this route answers it — the missing-token check the seed takes. The `disposition` rule ("an asserted status that maps to exactly one error_return, validation or guard") applies to that seed alone. U2 and U3 are confirmed at `route`.
