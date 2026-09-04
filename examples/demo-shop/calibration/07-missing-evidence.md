# 07-missing-evidence

`GET orders/v1/cart` · an upgrade claimed with no evidence entry; rejected as missing-evidence and the seed stays route.

Rule: an accepted upgrade needs at least one evidence entry.

The same read as the follow-up-read entry, promoted to `path` without citing anything. An upgrade is a claim about a test, and a claim with no evidence entry cannot be checked, so the merge rejects it as `missing-evidence` and the seed keeps its `route` floor. Confirmations may go uncited; upgrades may not.
