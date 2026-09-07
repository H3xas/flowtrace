#!/usr/bin/env python3
"""require-signoff: refuse a `git commit` Bash command that carries neither
a `-s`/`--signoff` flag nor a literal `Signed-off-by:` trailer, so a missing
sign-off is caught before the DCO check in CI ever sees it.

Reads a single Claude Code PreToolUse hook JSON payload from stdin. For a
Bash tool call whose command contains `git commit`, it looks for signoff
evidence in the command text; on a miss it prints a deny decision to
stdout, a one-line reason to stderr, and exits 2. Any other tool call, or a
Bash command with no `git commit` in it, exits 0 without printing anything.
Never raises: a payload it cannot parse is treated as nothing to flag.

Python 3 standard library only.
"""

import json
import re
import sys

# Matches `git commit` with any intervening flags/arguments and whitespace
# (`git -C /tmp/x commit`, `git  commit`), stopping at a pipe/list separator
# so it does not reach into a following command.
COMMIT_RE = re.compile(r"\bgit\b[^|;&]*\bcommit\b")

# `--signoff` on its own, or a short-flag cluster carrying a lowercase `s`
# (`-s`, `-am -s`, `-sm`, `-asm`, ...). `-S` (GPG-sign) is a different flag
# and is deliberately not matched here: it never lowercases to plain `s`.
SIGNOFF_LONG_RE = re.compile(r"(?:^|\s)--signoff\b")
SIGNOFF_SHORT_RE = re.compile(r"(?:^|\s)-[a-zA-Z]*s[a-zA-Z]*(?=\s|$)")
SIGNOFF_TRAILER_RE = re.compile(r"Signed-off-by:\s*\S")


def has_signoff(command):
    return bool(
        SIGNOFF_LONG_RE.search(command)
        or SIGNOFF_SHORT_RE.search(command)
        or SIGNOFF_TRAILER_RE.search(command)
    )


def build_reason():
    return (
        'require-signoff: git commit carries no -s/--signoff flag and no '
        'Signed-off-by: trailer. Every commit needs a Developer Certificate '
        'of Origin sign-off: git commit -s -m "...".'
    )


def emit_deny(event_name):
    reason = build_reason()
    payload = {
        "hookSpecificOutput": {
            "hookEventName": event_name or "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(payload))
    print(reason, file=sys.stderr)


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return 0

    try:
        if not isinstance(data, dict):
            return 0

        tool_name = data.get("tool_name")
        tool_input = data.get("tool_input") or {}
        event_name = data.get("hook_event_name")

        if tool_name != "Bash" or not isinstance(tool_input, dict):
            return 0

        command = tool_input.get("command", "")
        if not isinstance(command, str) or not COMMIT_RE.search(command):
            return 0

        if has_signoff(command):
            return 0

        emit_deny(event_name)
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
