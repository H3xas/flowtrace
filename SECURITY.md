# Security

## Reporting a vulnerability

Report privately through GitHub:
[github.com/H3xas/flowtrace/security/advisories/new](https://github.com/H3xas/flowtrace/security/advisories/new).
Please do not open a public issue for a suspected vulnerability. You will get an
acknowledgement, a fix or a reasoned decline, and credit in the release notes if you want it.

## Supported versions

The latest release on the current `0.x` minor line. A fix ships as the next patch version;
earlier versions are not patched.

## What the tool does, for a reviewer

flowtrace is a command-line program that reads source files under the roots named in
`flowtrace.config.json` and writes under the `out` directory named there. It makes no
network requests. It spawns two kinds of child process: `git`, for `affected --diff` and for
recording the HEAD a fact set was read at, and the optional code-index binary named by
`scout.bin` or `FLOWTRACE_SCOUT_BIN`, which runs with its own stores forced under `out/`.
It has no runtime dependencies. The single-file executables on the releases page are built
by the release workflow in this repository from the tagged source; the npm package is the
same source with no build step.

A path in the configuration file is trusted: the tool reads whatever it is pointed at. Treat
a configuration file from an untrusted source like any other script.
