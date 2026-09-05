# Roadmap

This describes capabilities under consideration, not a schedule. Nothing here is a
commitment or has a date attached; see [CHANGELOG.md](CHANGELOG.md) for what has actually
shipped. Anyone can propose, challenge, or pick up an item here — open an issue and
reference this document.

## Extraction

- Widen the regular-expression extractors as new idioms surface in real codebases, following
  the process in [CONTRIBUTING.md](CONTRIBUTING.md#extending-an-extractor).
- Explore where a parse-based pass (rather than pattern matching) would remove a whole class
  of blind spot, without giving up the no-build, no-toolchain property that lets the tool run
  against a checkout with nothing installed.
- Broaden framework coverage beyond ASP.NET Core, Ionic/Angular, React + Redux, Playwright and
  Cypress, driven by contributed extractors rather than a fixed target list.

## Cross-repository resolution

- Reduce the hops a walk marks `graph: unavailable` when no optional code index is
  configured, by teaching more of the walk to resolve from facts alone.
- Grow the contract an optional code index can implement (see
  [docs/scout.md](docs/scout.md)) so more tools, not just one, can plug into the `scout`
  hook.

## Coverage and evidence

- Extend the assertion-surface and coverage-overlay model to more test frameworks, keeping
  the rule that a claim about test evidence must point at the assertion that produced it.
- Improve `affected`'s framework-native selection (the `nx`/`dotnet-filter` style integrations)
  as more build tools are contributed.

## Distribution

- Keep the release pipeline's supply-chain posture (signed, attested, checksummed,
  SBOM-accompanied artifacts) current with what the ecosystem expects, without adding runtime
  dependencies to the tool itself.

## Community

- Grow the reviewer and maintainer ladder described in [GOVERNANCE.md](GOVERNANCE.md) as
  contributors take on sustained responsibility for specific areas.
- Publish more of the benchmark corpora and protocol under
  [docs/benchmarks/](docs/benchmarks/README.md) so comparisons against other tools are easier
  for a third party to reproduce and challenge.
