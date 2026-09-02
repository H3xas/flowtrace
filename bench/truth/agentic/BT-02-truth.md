# BT-02 — ground truth

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606 (verified: paths below exist
at this sha, read directly from the local clone under `bench/corpora/eshoponweb`).

## Primary fix site

- `src/PublicApi/CatalogItemEndpoints/UpdateCatalogItemEndpoint.cs` — `HandleAsync()` builds
  `CatalogItem.CatalogItemDetails details = new(request.Name, request.Description,
  request.Price)`, then calls `existingItem.UpdateDetails(details)`, `UpdateBrand(...)`,
  `UpdateType(...)`. None of `request.PictureBase64`, `request.PictureUri` or
  `request.PictureName` are read anywhere in the method — the picture fields on the request are
  silently discarded.
- `src/PublicApi/CatalogItemEndpoints/UpdateCatalogItemEndpoint.UpdateCatalogItemRequest.cs` —
  confirms the three picture properties exist on the request DTO, so the data reaches the
  endpoint; it is dropped inside `HandleAsync`, not lost in transit or model binding.

## Correct pattern, already in the same codebase

- `src/PublicApi/CatalogItemEndpoints/CreateCatalogItemEndpoint.cs` — `HandleAsync()` passes
  `request.PictureUri` into the `CatalogItem` constructor when creating a new item, and the
  entity exposes an `UpdatePictureUri(...)`-style mutator (see `CatalogItem` in
  `ApplicationCore/Entities`). The fix threads the update endpoint's picture field(s) through the
  same way, calling the entity's picture-update method instead of leaving it untouched.

## Acceptance bands

- **correct** — the patch makes `UpdateCatalogItemEndpoint.HandleAsync` apply at least
  `PictureUri` (or the field(s) the fix targets) to `existingItem` before `UpdateAsync`, and a
  test proves a `PUT` with a new picture value is reflected in the entity afterward.
- **partial** — the picture value is applied but not persisted correctly (e.g. applied to the DTO
  response only, not to `existingItem` before save), or the fix has no test.
- **wrong** — the picture fields remain unused, or the patch changes unrelated fields.
