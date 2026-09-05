---
name: Bug report
about: Something the tool does that its documentation says it should not
title: ''
labels: bug
assignees: ''
---

## What happened

A clear description of the incorrect output or behavior.

## Command and output

The exact `flowtrace` command you ran, and its full output (or the relevant excerpt).

```
paste here
```

## Expected

What you expected instead, and which documented behavior (README, `docs/`, `flowtrace --help`)
led you to expect it.

## Environment

- flowtrace version: `flowtrace --version` or the `version` field of `package.json`
- Node version: `node --version`
- OS:
- Installed via: npm global install / single-file executable / checkout

## Minimal reproduction

If the bug depends on the shape of the source it extracts from, a small snippet (using
invented names, not code from a real or private codebase) that reproduces it is the fastest
path to a fix. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for how a change should make
itself visible in the worked example.

## Vulnerability?

If this report describes a security vulnerability, please do not file it here — see
[SECURITY.md](../../SECURITY.md) instead.
