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

# In a linked worktree .git is a pointer file naming a home path, which --exclude-dir cannot match.
set +e
hits="$(grep -rInE "$pattern" . \
  --exclude-dir=.git \
  --exclude=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=out \
  --exclude-dir=corpora \
  --exclude=path-check.sh)"
status=$?
set -e

# grep answers 1 when nothing matched and 2 or more when it could not read what it walked.
# A tree the scan failed to walk is not a clean tree, so only exit 1 may fall through.
if [ "$status" -gt 1 ]; then
  echo "path-check: the scan could not read the tree (grep exit $status)" >&2
  exit 2
fi

if [ -n "$hits" ]; then
  echo "path-check: absolute machine paths found" >&2
  echo "$hits" >&2
  exit 1
fi

exit 0
