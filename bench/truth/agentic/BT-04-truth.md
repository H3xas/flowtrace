# BT-04 — ground truth

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606 (verified: paths below exist at
this sha, read directly from the local clone under `bench/corpora/eshoponweb`; one path corrected
during sealing — see note).

## Primary fix site (all four, threaded together)

- `src/ApplicationCore/Specifications/CatalogFilterSpecification.cs` — used for the `CountAsync`
  call; currently filters only on `CatalogBrandId`/`CatalogTypeId`. Needs a name predicate added.
- `src/ApplicationCore/Specifications/CatalogFilterPaginatedSpecification.cs` — used for the
  `ListAsync` (paged) call; same brand/type-only filter plus `Skip`/`Take`. Needs the same name
  predicate added, consistently with the count specification above.
- `src/PublicApi/CatalogItemEndpoints/CatalogItemListPagedEndpoint.ListPagedCatalogItemRequest.cs`
  — **path correction:** the ticket's assumed bare filename `ListPagedCatalogItemRequest.cs` does
  not exist; the actual file is nested under the compound name
  `CatalogItemListPagedEndpoint.ListPagedCatalogItemRequest.cs` (confirmed by directory listing
  of `src/PublicApi/CatalogItemEndpoints/`). It carries `PageSize`, `PageIndex`,
  `CatalogBrandId`, `CatalogTypeId` — no name field; one must be added and passed through the
  constructor.
- `src/PublicApi/CatalogItemEndpoints/CatalogItemListPagedEndpoint.cs` — `AddRoute()` reads route
  parameters and constructs the request; `HandleAsync()` builds both specifications above. Both
  need the new query parameter threaded through.

## Distractor, not the target

- `src/ApplicationCore/Specifications/CatalogItemNameSpecification.cs` exists and does a name
  match (`Query.Where(item => catalogItemName == item.Name)`), but it is an **exact,
  case-sensitive** match used only for duplicate-name checking in `CreateCatalogItemEndpoint`. It
  is not wired into the paged listing and is not case-insensitive; an answer that just reuses it
  unmodified for this ticket does not satisfy "case-insensitive, partial match."

## Acceptance bands

- **correct** — a name query parameter is added to the paged listing, applied identically in both
  the count and paged specifications, does a case-insensitive substring match (not exact-equals),
  and a test proves a partial, mixed-case query matches and a non-matching query excludes.
- **partial** — the filter is added to only one of the two specifications (count/list disagree),
  or is case-sensitive, or is exact-match rather than partial, or has no test.
- **wrong** — no name filter added, or the existing exact-match `CatalogItemNameSpecification` is
  substituted unmodified as "the fix."
