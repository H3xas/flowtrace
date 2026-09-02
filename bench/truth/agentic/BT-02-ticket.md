# BT-02

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606

**Statement**

Updating a catalog item's picture through the admin API (`PUT api/catalog-items`) reports
success but the picture is never actually changed — the response still shows the old image, and
it stays that way after refresh. None of the other fields have this problem: name, description,
price, brand and type all update correctly through the same endpoint.

Find out why the picture update is silently dropped and fix it so a `PUT` that supplies new
picture data actually updates the stored picture, consistent with how the rest of the endpoint
behaves.

**Definition of done:** a patch that makes the picture fields take effect on update, plus a
passing test that fails against the pre-patch code and passes against the patch.
