## What this changes and why

## How it's verified

For a change to `lib/extract/` or to a walk, quote the new output from the worked example
(`examples/demo-shop`) here — see [CONTRIBUTING.md](../CONTRIBUTING.md#tests). For a
documentation-only change, note that `node scripts/docs-check.mjs` passes.

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md), including the constraints that will
      fail a release if broken (zero runtime dependencies, Node 20+, the single-file build
      subset, no machine paths, LF line endings).
- [ ] `bash scripts/path-check.sh` and `node scripts/docs-check.mjs` pass locally.
- [ ] Every commit is signed off (`git commit -s`) per the [Developer Certificate of
      Origin](../CONTRIBUTING.md#developer-certificate-of-origin) — required for this pull
      request to be merged.
