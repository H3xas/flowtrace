### Repository

- A change now adds its changelog entry as its own file under `changes/changelog/`, named
  after its branch, and leaves `CHANGELOG.md` alone. The release folds these files into
  `## Unreleased` before the version commit. The group labels of `CHANGELOG.md` are now
  `###` headings, so an entry folds under its group. The package never carries `changes/`.
- `npm test` finds the suite by the glob `selftest/*.test.js`, so a new test file needs no
  edit to `package.json`. `npm run verify` runs the same set and refuses any other value of
  the `test` script.
- `scripts/path-check.sh` exempts only itself, by its exact path. Before, every file named
  `path-check.sh`, at any depth, was skipped.
- The comment and commit-message check reads the stored commits and ignores replace refs, so
  a replacement can no longer hide an unsigned commit or a flagged message. A control
  character in a commit message no longer gives a false missing sign-off.
- `docs/fact-schema.md` lists `endLine` and `elementLine` on `page_route`.
