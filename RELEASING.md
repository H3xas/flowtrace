# Releasing

Maintainers only. Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which:

1. Builds the single-file executables for Linux, macOS and Windows (`binaries`), attests
   their build provenance, and signs each one keylessly with `cosign sign-blob` (a
   `<file>.sigstore.json` bundle per binary).
2. Packs the npm tarball, generates a CycloneDX SBOM (`npm sbom --sbom-format cyclonedx`),
   attests the tarball's provenance, and signs it the same way (`npm-tarball`).
3. Downloads everything attached to the release so far and writes one `SHA256SUMS` covering
   every asset (`checksums`).
4. Publishes the package to npm using Trusted Publishing — no long-lived npm token stored in
   this repository (`publish-npm`).

Release tags are never moved or deleted; a broken release is superseded by the next patch
version, same as before this pipeline existed.

## Verifying a release

```
# Provenance attestation (requires the GitHub CLI)
gh attestation verify flowtrace-linux-x64 --owner H3xas

# Sigstore keyless signature
cosign verify-blob --bundle flowtrace-linux-x64.sigstore.json \
  --certificate-identity-regexp 'https://github.com/H3xas/flowtrace/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  flowtrace-linux-x64

# Checksums
sha256sum -c SHA256SUMS
```

## One-time npm Trusted Publishing setup

This is done once, by hand, on npmjs.com — it is not something a workflow can do on its own
behalf, and it is not performed as part of this change. Whoever holds publish rights on the
`flowtrace-cli` package does this once:

1. Sign in to [npmjs.com](https://www.npmjs.com) and open the `flowtrace-cli` package's
   **Settings**.
2. Under **Trusted Publisher**, choose **GitHub Actions** and fill in:
   - Organization or user: `H3xas`
   - Repository: `flowtrace`
   - Workflow filename: `release.yml`
   - Environment: leave blank unless the workflow is later scoped to a GitHub Environment.
3. Save. No token is generated or stored — publishing authenticates through the OIDC token
   the `publish-npm` job already requests via `permissions: id-token: write`.
4. Confirm the account's npm CLI story is current: Trusted Publishing needs npm 11.5.0 or
   newer, which is why the workflow runs `npm install -g npm@latest` immediately before
   `npm publish`.

Until this is configured, the `publish-npm` job fails at the publish step; the `binaries`,
`npm-tarball` and `checksums` jobs are unaffected and still produce a fully signed, attested,
checksummed GitHub release.
