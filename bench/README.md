# bench

The runnable side of [docs/benchmarks](../docs/benchmarks/README.md): how to put the existing
verbs on a pinned corpus and time them. No framework, no new code — the verbs under test are the
shipped ones and everything below is a command you can read.

```
bench/
  corpus.lock     the pinned corpora; the anchor every results document must agree with
  corpora/        clones, one per pinned corpus (gitignored)
  truth/          sealed truth files + manifest.json, written before any arm runs
```

## Fetch and verify a corpus

Clone at the pin, then check the sha against `corpus.lock` before running anything — a clone that does not match the lock is not the corpus the numbers were measured on.

```
mkdir -p bench/corpora
git clone https://github.com/dotnet-architecture/eShopOnWeb bench/corpora/eshoponweb
git -C bench/corpora/eshoponweb checkout 4da8212117e87d808d4bbc7da6286fd2147ce606
git -C bench/corpora/eshoponweb rev-parse HEAD
grep eshoponweb bench/corpus.lock
```

The two shas must be identical. `affected` reads diffs through `git`, so keep the checkout a real
git repository, not a tarball. Leave `origin` only if you intend to re-pin: a benchmark run
removes it so nothing can drift mid-run.

## Point the verbs at it

`demo-shop` ships a config and needs none written:

```
node bin/flowtrace.js extract --config examples/demo-shop/flowtrace.config.json
node bin/flowtrace.js join    --config examples/demo-shop/flowtrace.config.json
```

For a cloned corpus, write one config beside the clone. This covers the pinned ASP.NET Core corpus, whose projects live under `src/`:

```json
{
  "out": "out",
  "repos": [
    { "id": "eshop", "kind": "backend", "root": "corpora/eshoponweb/src", "role": ["api"] }
  ]
}
```

Save it as `bench/eshoponweb.config.json` — config paths resolve relative to the config file. Then:

```
node bin/flowtrace.js extract --config bench/eshoponweb.config.json
node bin/flowtrace.js join    --config bench/eshoponweb.config.json
node bin/flowtrace.js trace "<route key>" --config bench/eshoponweb.config.json --json
```

`flowtrace --help` lists every verb and flag; the task table in
[methodology.md](../docs/benchmarks/methodology.md) says which verb answers which task.

## Time them

[`hyperfine`](https://github.com/sharkdp/hyperfine) is the suggested timer: it separates warm-up from measured runs, which is exactly the cold/warm split the methodology requires.

```
# cold: one measured run per fresh index, warm-up disabled
hyperfine --warmup 0 --runs 1 \
  'node bin/flowtrace.js trace "<route key>" --config bench/eshoponweb.config.json --json'

# warm: one warm-up, then the median of three
hyperfine --warmup 1 --runs 3 \
  'node bin/flowtrace.js trace "<route key>" --config bench/eshoponweb.config.json --json'
```

Setup cost — the `extract` and `join` passes, and any peer's install and index build — is timed the same way but reported in its own table, never amortised into a query time.

Payload is measured on stdout exactly as captured — separately from the timing run, with no formatter in between:

```
node bin/flowtrace.js trace "<route key>" --config bench/eshoponweb.config.json --json | wc -c
```

## Before publishing a number

1. The corpus sha matches `corpus.lock`.
2. The truth for that task was sealed *before* the run, and its sha256 has not moved.
3. The environment block in [methodology.md](../docs/benchmarks/methodology.md) is filled in —
   de-identified host description, runtime versions, every command, and the corpus shas.
4. The result lands in `docs/benchmarks/results/<yyyy-mm>.md`, next to its environment block,
   never in a README or a commit message on its own.
