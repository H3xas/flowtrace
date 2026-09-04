# Reverse-reachability lane prompt

## Base prompt

You are evaluating reverse reachability in two pinned public code corpora. Work read-only:
do not edit files, install software, or use the network.

For each input below, identify every HTTP entry route whose static call walk reaches the
point. Return JSON only, using this exact shape:

```json
{
  "answers": [
    {
      "name": "input name",
      "routes": [
        { "repo": "repository id", "route": "VERB normalized/path", "file": "repository-relative declaration path", "line": 1 }
      ]
    }
  ]
}
```

Keep `answers` in the input order and routes sorted by route, repo, file, then line. An
empty `routes` array means you proved that no entry route reaches the resolved point; do
not use it for uncertainty. Report route declaration provenance, not the point's own
location. Do not add explanation outside the JSON.

Inputs:

1. `body-line`, corpus `eshoponweb`: `Web/Controllers/OrderController.cs:37`
2. `repository-symbol`, corpus `demo-shop`: exact symbol `OrderRepository.SaveOrder`
3. `publish-key`, corpus `demo-shop`: exact publish literal `OrderPlacedMessage`, scoped to repository `api`
4. `route-template`, corpus `demo-shop`: exact route-template literal `/orders/v1/checkout`

Corpus directories are `eshoponweb/` and `demo-shop/`. Use repository id `eshop` for
eshoponweb and the configured demo-shop repository id for demo-shop routes.

## Tool-arm addition

`flowtrace` is installed and prebuilt fact configs are available. You may run
`flowtrace routes-of <point> --config .benchmark/eshop.config.json --json` for the first
input and the corresponding `.benchmark/demo.config.json` for the other inputs, adding
the forced mode and repository scope stated above. This paragraph is absent from baseline
lanes; everything else is identical.
