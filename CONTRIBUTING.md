# Contributing

Thank you for looking at the tool closely enough to want to change it. This page is the
whole process.

## Branch and pull request

`main` is protected. Every change, including a one-line documentation fix, arrives on a
branch and through a pull request; CI runs on the pull request and must be green before a
merge. Commit messages are plain English in the `type(scope): subject` form the history
already uses (`fix(extract): …`, `docs: …`, `ci: …`).

## Developer Certificate of Origin

Every commit must be signed off:

```
git commit -s -m "fix(extract): recognise the new attribute shape"
```

`-s` appends a `Signed-off-by: Your Name <you@example.com>` trailer, which is your
certification that you wrote the change or otherwise have the right to submit it under the
[Developer Certificate of Origin](https://developercertificate.org/) and this project's
license (see [README.md#license](README.md#license)). CI rejects a pull request carrying an
unsigned commit; `git commit --amend -s` (or `git rebase --exec 'git commit --amend --no-edit
-s' <base>` for several commits) fixes one after the fact.

The trailer is what is checked, commit by commit: `npm run verify` reads the message of every
commit in the range out of the commit object, so nothing about the command that wrote the
commit stands in for a trailer the commit does not carry.

## Running from a checkout

There is no build and there are no dependencies to install.

```
node bin/flowtrace.js --help
```

The worked example is the fastest feedback loop, and it is exactly what CI runs:

```
cd examples/demo-shop
node ../../bin/flowtrace.js extract
node ../../bin/flowtrace.js join
node ../../bin/flowtrace.js cover --area checkout
node ../../bin/flowtrace.js span "POST orders/v1/checkout"
```

Before opening a pull request, run the one command CI runs, from the repository root:

```
npm run verify
```

It works through the inventory below, stops at the first stage that fails, and prints that
stage's command, its output and the repair it permits. While working, `--only` narrows it
(`npm run verify -- --only suite,docs`) and `--commit-range <range>` chooses the commits the
commit-artifact stages read. Both are conveniences: CI runs the whole inventory.

Two stages read text the editor hooks also read, and the difference between them is worth
knowing before trusting either. `.claude/hooks/comment-hygiene.py` refuses a comment, or a
commit message, as it is written; the `public-text` stage runs the same policy over what is
already saved. They share the rules and the file scope — code files, never prose — but they
are not the same run: the hook sees the text of one edit or write and skips a file the scan
would read, while the scan reads every tracked code file and nothing else. A hit in either
names the class it broke and the file or commit it sits on.

## Tests

The regression suite is not part of this repository or the published package. It runs
privately before every release, against corpora that are not public. What a contributor can
rely on is the worked example under `examples/demo-shop`, which CI runs end to end on Node 20,
22 and 24 for every push and pull request.

A change to an extractor or to a walk should therefore make itself visible there: extend the
demo shop with the idiom the change recognises, and quote the new `trace` or `cover` output
in the pull request. A change nobody can see in the worked example is hard to review.

Alongside that, `selftest/` holds a public, synthetic suite over invented fixtures that
exercises the CLI's outer contract — argument parsing, `--help`, exit codes, `--json` shapes,
error envelopes — run with `npm test`. `npm run verify` runs it as its first stage, and fails
before running anything when the `test` script omits a file the suite holds. It does not
replace the private regression suite or
the worked example; it is the layer a stranger's pull request is verified against before a
maintainer looks at it. See [selftest/README.md](selftest/README.md).

## What CI verifies

Every push and pull request against `main` runs `npm run verify` on Node 20, 22 and 24: that
command and no step of its own. This list and the workflow therefore cannot drift apart —
adding a check means adding a stage, and a stage no one documents fails the suite.

| stage | what it proves |
|---|---|
| `suite` | every test file under `selftest/` is named by the `test` script, and all of them pass with none skipped |
| `cli-smoke` | `node bin/flowtrace.js --help` answers from a checkout with no install step |
| `worked-example` | `examples/demo-shop` extracts, joins, exports twice byte-identically, matches its pinned export, and runs cover, span, surface, skeleton, check and calibrate |
| `machine-paths` | no absolute home path, Windows user path or `file://` URL anywhere in the tree |
| `public-text` | every tracked file can be read, and the shared comment and commit-message policy is clean |
| `commit-signoff` | every commit in the range carries its `Signed-off-by:` trailer |
| `docs` | `docs/cli.md` is `flowtrace --help` verbatim and every relative link resolves |
| `config` | `flowtrace.config.example.json` loads through the loader the CLI uses, and every key it sets is documented |
| `package` | `npm pack --dry-run` describes a tarball carrying what a reader needs and nothing that belongs to the checkout |

The commit stages read the commits under review: CI passes the pull request's range, and a
local run reads the commits on the current branch. Outside a checkout, or with no base branch
to compare against, they fail naming `--commit-range` rather than reporting commits they
never read.

A release additionally builds and signs the single-file executables and the npm tarball; see
[RELEASING.md](RELEASING.md).

## Constraints that will fail a release if broken

- **Zero runtime dependencies.** `package.json` has none and stays that way.
- **Node 20 or newer**, no transpilation. Use what Node 20 ships.
- **The single-file build subset.** `scripts/build-sea.mjs` inlines the module graph itself
  and supports only relative imports, `node:` builtins and `import.meta.url`. No re-exports
  (`export … from`), no dynamic `import()`, no top-level `await` in `bin/flowtrace.js`. Run
  `node scripts/build-sea.mjs` locally when in doubt (it fetches `postject` through `npx`);
  the release workflow runs it on three operating systems.
- **No machine paths.** `scripts/path-check.sh` fails on any absolute home path, Windows
  user path or `file://` URL. Examples use neutral placeholders such as `shop-api`.
- **Sources are LF.** `.gitattributes` enforces it; the bundler reads line ends literally.

## Documentation

`flowtrace --help` is the flag reference and `docs/cli.md` is its verbatim copy. After
changing help text in `bin/flowtrace.js`, regenerate and commit:

```
node scripts/docs-check.mjs --write
```

Everything else about the documentation set is listed in [docs/README.md](docs/README.md).
New prose belongs in one of those documents or in `--help`; a new measurement belongs under
`docs/benchmarks/` with its method and environment, as
[docs/benchmarks/README.md](docs/benchmarks/README.md) requires.

## Extending an extractor

The recognised idioms are regular expressions grouped at the top of each file under
`lib/extract/`. Widening one is the intended way to teach flowtrace a new shape; the fact it
emits must already exist in [docs/fact-schema.md](docs/fact-schema.md), or that document
gains the new type in the same pull request.

## Releases

Maintainers only. A `v*` tag builds the single-file executables and the npm tarball, signs
and attests both, attaches them to a GitHub release with a checksum file and an SBOM, and
publishes to npm via Trusted Publishing. See [RELEASING.md](RELEASING.md) for the full
pipeline and its one-time setup. Release tags are never moved or deleted; a broken release is
superseded by the next patch version.
