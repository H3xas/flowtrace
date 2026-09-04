# Reverse-reachability harness-correction pre-registration

**Sealed:** 2026-08-30, after the first registered round completed and before any
correction lane ran.

The first round remains a result. Its two tool lanes received the tool paragraph and a
valid executable on `PATH`, but the restricted command policy denied every attempted
`flowtrace` invocation. Both are therefore `tool_integrity: none`; they are not relabelled
as successful tool exposures and their answers remain in the dated result.

This correction is a new four-lane run, not a replacement. It changes only the harness:

- lanes still use fresh disposable corpus copies and the byte-identical sealed prompt;
- the agent command policy permits shell commands inside those disposable copies, while
  the prompt continues to require read-only work and no network use;
- streaming JSON captures successful tool calls as well as denials;
- a tool lane is valid only if its transcript contains at least one completed
  `flowtrace routes-of` invocation;
- post-lane `git status` verifies that the pinned corpus was not modified.

The original corpora, four inputs, prompt, truth, model/effort pairs, 150k-token ceiling,
one-run count, and 8-point scoring rubric are unchanged. Their sealed hashes are in
`../manifest.json`. One correction run is made for each of `sonnet.base`,
`sonnet.routes`, `opus.base`, and `opus.routes`. A stopped, censored, modified-corpus, or
tool-integrity failure is reported and is not run again.

The correction is required to measure the registered tool contrast at all; it is not
triggered by whether the first-round answers were favorable. The dated result publishes
both rounds and keeps their scores separate.
