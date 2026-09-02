#!/usr/bin/env bash
#
# A published tool must not carry the machine it was written on. This checks for
# absolute home paths, Windows user paths and file:// URLs anywhere in the tree.
#
# Untracked working directories are skipped the way node_modules/, dist/ and out/
# already are: bench/corpora/ holds third-party clones this repository never publishes.
#
# It is deliberately a path check and nothing more. A denylist of names to keep out
# of a public repository is itself a list of those names, so this file holds none:
# the rule here is shape-based and readable in full.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pattern='/Users/[a-zA-Z0-9._-]+|/home/[a-zA-Z0-9._-]+|[A-Za-z]:\\Users\\|file:///'

hits="$(grep -rInE "$pattern" . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=out \
  --exclude-dir=corpora \
  --exclude=path-check.sh || true)"

if [ -n "$hits" ]; then
  echo "path-check: absolute machine paths found" >&2
  echo "$hits" >&2
  exit 1
fi

exit 0
