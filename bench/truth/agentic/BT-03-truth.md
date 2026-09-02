# BT-03 — ground truth

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606 (verified: path below exists at
this sha, read directly from the local clone under `bench/corpora/eshoponweb`).

## Primary fix site

- `src/PublicApi/CatalogItemEndpoints/CatalogItemListPagedEndpoint.cs`, `HandleAsync()`, line 42:
  `await Task.Delay(1000);` is the first statement in the method, unconditional, with no
  feature flag and no comment. It runs before the count query, the paged query, or any mapping —
  it is pure added latency, not a debounce, throttle, or rate-limit gate tied to any condition.

## Acceptance bands

- **correct** — the patch removes the `Task.Delay(1000)` call outright (the endpoint has no
  other artificial latency anywhere else), and the endpoint still returns correct paged results;
  or, if the patch instead keeps a delay, it must be justified with a comment that states a real,
  checkable reason (e.g. a citation to an issue, a rate-limit requirement) — an invented
  justification not backed by anything in the repository does not qualify.
- **partial** — the delay is reduced but not removed with no stated justification, or removed but
  a regression is introduced in the surrounding pagination logic.
- **wrong** — the delay is left in place with no comment, or the patch touches unrelated code
  while leaving `Task.Delay(1000)` untouched.
