# 02-follow-up-read

`GET orders/v1/cart` · a follow-up read whose body assertion observes the state the route serves; the seed reaches path.

Rule: an assertion on a response field only produced on that path, a follow-up read that observes the effect, or an assertion on a push effect.

The route has one seed: the read itself. Its candidate test asserts the status and then a field of the response body (`items`). A body field is something this path produces and a status is not, so the `path` rule ("an assertion on a response field only produced on that path") applies and the merge accepts one upgrade. A reader that stops at `route` here is under-reading.
