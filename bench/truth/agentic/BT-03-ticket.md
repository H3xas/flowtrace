# BT-03

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606

**Statement**

The paged catalog items API (`GET api/catalog-items`) is consistently slow — every call takes at
least a second before any data comes back, even on an otherwise idle box with a tiny catalog.
Other catalog endpoints are fast.

Investigate what is adding the fixed latency to this endpoint specifically and either remove it
or, if it is there for a real reason, document why in a code comment so the next person does not
file this same ticket again.

**Definition of done:** a patch that removes the fixed latency (or a patch that leaves it with a
comment explaining a real, stated reason it must stay), plus a note in the PR description of
which choice was made and why.
