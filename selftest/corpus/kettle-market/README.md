# kettle-market

An invented storefront, "Kettle Market", with one ASP.NET Core controller (`backend/`) and one
Playwright suite (`suite/`). No real product, company or code base is behind it. The suite
holds the shapes that decide whether a browser test runs on a real backend, on patched
responses or on a mocked backend. `selftest/backend-class.test.js` reads it.

## Layout

- `kettle.config.json` names both repositories. Its `backend` key names `stubEveryEndpoint` as
  a full-mock call, and `seedBasket` and `fixtures.priceList` as patch calls.
- `kettle.area.txt` lists the controller's routes, for `cover`.
- `suite/tests/` holds two specs under the `tests/` convention. `describe-hooks.spec.ts` has a
  mocked `test.describe` block with an inner block, a live block and a skipped block.
  `file-hook.spec.ts` has a hook at file level.
- `suite/e2e/*.pw.ts` holds the UI specs, one file for each group of shapes:
  - `basket.pw.ts`: same-file helpers with a fetch-then-fulfill handler and a fulfill handler,
    a helper declared in a describe block, and a same-file function with the name of a
    repo-wide stub helper.
  - `spies.pw.ts`: continue, fallback and abort handlers, a repo-wide fall-back helper, and a
    handler that fulfills on one branch only.
  - `comments.pw.ts`: stubs in a line comment, in a block comment and in a string, and a stub
    inside a template interpolation.
  - `catalog.pw.ts`: the configured full-mock call, a patch call that no file defines, and a
    dotted patch call next to a callee that only shares its last name.
  - `storefront.pw.ts`: page-object methods that reach repo-wide helpers, at one and two
    levels, and two helpers that call each other.
  - `unreadable.pw.ts`: a test body passed by reference, an imported route handler, a method
    name that two repo-wide helpers share, and a hook passed by reference.
  - `precedence.pw.ts`: one test for each pair of classes, a HAR replay, a skipped test and a
    hook written after its test.
- `suite/helpers/` and `suite/pages/` hold the repo-wide helpers and page objects.
- `base-facts.json` pins the `pw_stub` and `pw_test` facts of `suite` and of the worked
  example's `e2e` repository, as the extractor of the implementation base wrote them.
- `golden.mjs` writes that file.

## Regenerating `base-facts.json`

The file pins the base extractor, so a newer one is compared with it and never written into
it. Run the base commit's own CLI over the current inputs:

```
git archive <base commit> lib bin package.json | tar -x -C <empty directory>
node selftest/corpus/kettle-market/golden.mjs --cli <empty directory>/bin/flowtrace.js \
  > selftest/corpus/kettle-market/base-facts.json
```

A change to the corpus or to the worked example's `e2e` repository needs this step in the same
diff.
