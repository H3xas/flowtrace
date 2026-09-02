# BT-04

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606

**Statement**

Support wants to look up a catalog item by typing part of its name into the admin tooling, the
way they can already filter by brand and type on `GET api/catalog-items`. Right now there is no
way to filter the paged catalog list by name at all, and support cannot rely on customers or
agents getting the exact capitalization right.

Add a name filter to the paged catalog items listing that does a case-insensitive, partial match
against the item name, alongside the existing brand/type filters — same pagination behaviour as
the rest of the endpoint.

**Definition of done:** a patch that adds the filter, plus a passing test that proves a partial,
mixed-case query matches the intended item(s) and excludes non-matches.
