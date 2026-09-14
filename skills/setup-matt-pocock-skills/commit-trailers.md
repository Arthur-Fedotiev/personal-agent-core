# Commit Trailers

How the engineering skills record decisions, rejected alternatives, domain terms, and lessons — as trailers on real code commits. This is the baseline, on regardless of whether this repo also maintains `CONTEXT.md` / `docs/adr/` via `/domain-modeling`. When it does, the commit that lands a glossary entry or a new ADR carries the matching trailer too — the doc is the browsable copy; the trailer is what keeps `git log --grep` complete.

## Vocabulary

A trailer is a `Key: value` line at the end of a commit message, after a blank line, in the [git trailer](https://git-scm.com/docs/git-interpret-trailers) format. Every key carries the `Compound-` prefix, so every one of these commits greps as a single family regardless of which key fired. Four keys:

- **`Compound-Decision:`** — a decision made and its answer, one line. `Compound-Decision: retry webhook delivery 3x with backoff, not queue-and-replay`
- **`Compound-Rejected:`** — an alternative considered and turned down, when the rejection itself is non-obvious. `Compound-Rejected: GraphQL — REST already covers every consumer`
- **`Compound-Term:`** — a domain term's meaning, when this commit is what settles it in code, not just a diff that happens to use the word. `Compound-Term: cancellation = voiding before fulfillment`
- **`Compound-Lesson:`** — a bug's root cause and the fix, or a review finding that generalizes past this one diff. `Compound-Lesson: retry loop retried on 4xx responses too — only 5xx and timeouts are retryable`

Same bar as an ADR for `Compound-Decision:`/`Compound-Rejected:`: use one only when it's hard to reverse, surprising without the context, or the result of a real trade-off. `Compound-Lesson:` has a different bar — it's warranted whenever the fix (from `/diagnosing-bugs`) or the finding (from `/code-review`) would otherwise repeat, not just when it's hard to reverse. Multiple trailers, even multiple of the same key, can stack on one commit.

## Attach to the commit the decision produced

Whenever code changes because of a decision — now, or in a later session that picks the ticket back up — add its trailer to that commit, however small the diff. Pull the one-line gist from wherever the decision was made (a wayfinder ticket, this session's grilling round, a diagnosing-bugs feedback loop, a code-review finding) rather than re-deriving it. One commit, one trailer block; never a standalone doc-only commit for this.

## When no code will ever follow

A decision that closes a question without producing code — ruling something out of scope, rejecting an alternative that was never built — has nothing to attach to. This is the only case where `git commit --allow-empty` with just the trailer is correct; default to attaching first.

## Finding them later

An empty commit isn't reachable through `git blame` or `git log -- <file>` — nothing points at it. Find it, or any trailer, by grepping the prefix directly:

```
git log --all -P --grep '^Compound-'
```

Add `--grep '^Compound-Decision:'` (or whichever key) to narrow to one kind. Run this before assuming a decision was never made — the same habit as reading `CONTEXT.md` for a glossary, if this repo also maintains one.
