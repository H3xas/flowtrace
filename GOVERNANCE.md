# Governance

## Today

flowtrace has one maintainer. That person merges pull requests, cuts releases, and has final
say on design questions. This document describes how that changes as other people take on
sustained responsibility for the project, and what stays true regardless of who holds the
maintainer role.

## Roles

**Contributor.** Anyone who opens an issue, submits a pull request, or otherwise
participates in the project under [CONTRIBUTING.md](CONTRIBUTING.md). No approval is needed
to become a contributor.

**Reviewer.** A contributor who has, over a sustained period, submitted or reviewed changes
that showed working knowledge of a specific area of the codebase (an extractor, the render
layer, the release pipeline) without needing significant rework. A reviewer may be asked for
a review on pull requests touching that area and their approval carries weight in the
maintainer's merge decision, but a reviewer does not merge.

**Maintainer.** A reviewer who has, over a sustained period, shown good judgment across the
whole project — not just one area — including on contested design questions, backward
compatibility, and the constraints in [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers can
merge pull requests, cut releases, and triage issues.

## How someone moves up the ladder

Promotion is proposed by an existing maintainer, based on a visible track record in the
project's public history (pull requests, reviews, issue discussion) — not on tenure or
request. There is no fixed contribution count or time window; the criterion is judgment
demonstrated in public, reviewable work. A promotion is announced in a pull request that
adds the person to [MAINTAINERS.md](MAINTAINERS.md) (or a `reviewers` list if the project
adopts one), so the change itself is part of the project's history and open to comment
before it merges.

Nothing here entitles a contributor to a role; it describes the bar a maintainer applies
when deciding to extend one.

## Decision making

Most decisions — a bug fix, a documented extractor widening, a new command flag consistent
with the existing CLI shape — are made by lazy consensus: a pull request that has been open
for review, has no unresolved objection from a maintainer, and passes CI can be merged
without a formal vote.

A change that breaks the constraints in [CONTRIBUTING.md](CONTRIBUTING.md) (zero runtime
dependencies, the single-file build subset, the documented exit-code and `--json` contract),
or that changes what the tool claims to prove versus what it can actually prove from facts,
needs explicit maintainer sign-off, not just the absence of an objection.

When there is more than one maintainer and they disagree, the discussion stays public on the
pull request or issue until consensus is reached; there is no private tie-breaking vote
defined today. If the project grows enough that this stops working, this document is the
place that changes, through the same public pull-request process as everything else.

## Removing a maintainer or reviewer

A maintainer or reviewer who becomes unreachable, or whose conduct violates
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), can be removed by the remaining maintainers through
a pull request against [MAINTAINERS.md](MAINTAINERS.md), same as a promotion.

## License

This project is licensed under the terms in [README.md](README.md#license) (MIT OR
Apache-2.0, contributor's choice on submission per both licenses' contribution clauses). No
future governance decision relicenses the project's existing contributions away from the
rights already granted under those terms, or into a license that revokes them; a change to
the license terms for new contributions going forward is a maintainer decision made in the
open, same as any other, and does not reach back to code already released.

## Changing this document

Like any other change, by pull request, reviewed in the open.
