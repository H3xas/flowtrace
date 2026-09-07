# areas

An **area** is a newline list of route keys — one feature's HTTP surface, named so a
coverage run has a fixed denominator.

```
flowtrace cover --area checkout          # areas/checkout.txt
flowtrace cover --area path/to/list.txt  # any file
```

`--area <name>` resolves to `areas/<name>.txt` next to the installed package; `--area
<path>` reads any file. `trace --area`, `scaffold --area` and `cases --area` read the same
format.

## Format

- One route key per line.
- A route key is `<VERB> <template>`: an uppercase HTTP verb, one space, and the route
  template exactly as `trace` resolves it — no leading slash, `*` for every parameter
  segment. `POST orders/v1/cart/items`, `GET catalog/v1/products/*`.
- Blank lines and lines starting with `#` are ignored.
- Repeats are dropped.

A key that no longer resolves becomes a `cover` row carrying an `error` and no seeds,
rather than failing the run — a stale file degrades visibly instead of silently.

## Why the list is written by hand

An area file is committed, reviewed and re-derived deliberately. It is not computed at run
time: the denominator *is* the argument, so it has to be inspectable and stable between
runs, and a route entering or leaving an area has to show up as a reviewable change.

Write down the selection rule next to the file, so the next person can re-derive it. A rule
usually reads "every route reached by these caller-side services" or "every route under
these templates" — the first survives refactors better, because a URL-prefix rule silently
misses a route the feature calls from a neighbouring prefix.

## Baselines

`flowtrace check --area <file>` compares the area's current coverage against
`<name>.baseline.json` beside the area file and fails on any drop. The baseline is written
only on request, by `check --area <file> --write-baseline`, from facts that are current for
every repository; it is committed and reviewed like the area file itself, and a compare run
that finds none, or one captured from an older fact snapshot, refuses with exit `4` rather
than inventing a reference.

## Regenerating

Print the route inventory of the entry point, apply the rule, sort, and review the diff:

```
flowtrace trace CheckoutPage --json | jq -r '.routes[].key' | sort
```

## Shipped example

`checkout.txt` is the area of the worked example in `examples/demo-shop` — five routes
across a catalog and an orders service. It exists so `flowtrace cover --area checkout`
has something to run against out of the box; delete it once you have your own.
