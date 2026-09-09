# Comments

Code shows how; a comment earns its place only by carrying a *why* the code
can't. Test intent belongs in the test itself or a fixture's own README. A
hook and CI reject narrative "Case X:" notes, file:line citations, tracker
ids, tool/model names, and test narration ("probes", "exercises the") in
comments and commit messages.

Bad:  `// Case a: retries land in bursts -- probes the backoff window`
Good: `// Backoff windows must not overlap or two retries collide on the same slot`

Scan: `python3 .claude/hooks/comment-hygiene.py --scan`
Scan commits: `python3 .claude/hooks/comment-hygiene.py --scan-commits origin/main..HEAD`
Verify the scanner itself: `python3 .claude/hooks/comment-hygiene.py --selfcheck`

# Commit sign-off

Every commit needs a `Signed-off-by:` trailer (see CONTRIBUTING.md). A local
hook refuses a `git commit` that carries neither `-s`/`--signoff` nor a
literal `Signed-off-by:` trailer before it ever reaches the DCO check in CI.
