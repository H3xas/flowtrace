# BT-01

**Corpus:** eshoponweb @ 4da8212117e87d808d4bbc7da6286fd2147ce606

**Statement**

Order Details returns other customers' orders when the order id is guessed or enumerated. A
signed-in shopper can view the full detail of any order in the system — line items, totals,
shipping address — by requesting a valid order id that does not belong to them.

Fix it so a shopper can only retrieve their own orders; requesting another buyer's order id must
behave the same way as an order id that does not exist (no data returned). Add or update a test
that proves the fix.

**Definition of done:** a patch that closes the access gap, plus a passing test that fails
against the pre-patch code and passes against the patch.
