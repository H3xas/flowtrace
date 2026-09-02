# BT-01 — ground truth

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606 (verified: paths below exist
at this sha, read directly from the local clone under `bench/corpora/eshoponweb`).

## Primary fix site

- `src/Web/Features/OrderDetails/GetOrderDetailsHandler.cs` — `Handle()` builds
  `OrderWithItemsByIdSpec(request.OrderId)` and returns the order for any id, never consulting
  `request.UserName` (the field exists on `GetOrderDetails` but the handler never reads it).
- `src/ApplicationCore/Specifications/OrderWithItemsByIdSpec.cs` — the specification filters only
  by `order.Id`; it carries no buyer/owner predicate at all, so it is unscoped by construction.

## Correct pattern, already in the same codebase

- `src/Web/Features/MyOrders/GetMyOrdersHandler.cs` +
  `src/ApplicationCore/Specifications/CustomerOrdersSpecification.cs` — the sibling "my orders"
  feature scopes its specification with `Query.Where(o => o.BuyerId == buyerId)`. A correct fix
  makes `OrderWithItemsByIdSpec` (or the handler that uses it) scope by the requesting buyer in
  the same way — filtering on both `Id` and buyer identity — rather than trusting the id alone.

## Acceptance bands

- **correct** — the patch makes `GetOrderDetailsHandler` (directly or via the spec) reject/return
  nothing for an order id that does not belong to the requesting user, while still returning the
  order for its rightful owner; a test exercises both the belongs-to-me and not-mine cases.
- **partial** — the access check is added somewhere in the call chain (e.g. in a controller/page
  above the handler) rather than in the specification/handler, so the underlying query is still
  unscoped; or the fix is present but has no test covering the negative case.
- **wrong** — no scoping added, or the fix breaks the owner's own ability to view their order.

## Judge notes

`request.UserName` on `GetOrderDetails` (`src/Web/Features/OrderDetails/GetOrderDetails.cs`) is
already threaded through from the caller — the bug is that the handler ignores it, not that the
identity is unavailable. A patch that plumbs a *new* identity source in from scratch is solving a
different, harder problem than the one filed; it should not be penalized for that alone, but it
is doing more than the minimal fix requires.
