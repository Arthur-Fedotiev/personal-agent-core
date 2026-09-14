---
name: babysit-mr
description: Babysit a GitLab MR until it is ready for merge-mr or needs the user, fixing what the branch broke along the way.
argument-hint: "[MR iid or URL] [--once] [--interval <seconds>] [--timeout <seconds>]; defaults to the current branch's MR"
disable-model-invocation: true
---

Invoking this skill is the current-turn instruction for a long unattended run and for pushing
fixes to the MR's branch. The script watches and remembers; this document says what to do with
what it reports.

Babysitting ends at **ready to merge**, the handoff to `merge-mr`; at a **blocker** only the user
can clear; when the MR is merged or closed; or at the timeout. Merging is not part of it.

## Process

### 1. Watch

Run in the foreground from a shell inside the target repository, so glab resolves the project. The
script lives in `scripts/babysit.mjs` under this skill's base directory.

```bash
node <base-dir>/scripts/babysit.mjs $ARGUMENTS
```

It polls every 60 seconds for up to two hours, printing one JSON line per poll, and exits as soon
as `snapshot.actions` holds anything but `idle`. Exit code 3 means an action waits for you, 0 means
the run ended, 2 means the timeout passed. Report one line, the `summary`, for each snapshot whose
`changed` is true. `--once` takes a single snapshot for debugging or for a host that cannot hold a
foreground process.

With the first snapshot, read the description through `glab mr view <iid>`. No `/uploads/` image in
it means the MR has no explainer yet: say so once and name `/explainer <ticket> settled --publish` as
the step that adds one. Writing the page is not babysitting.

A review bot whose inline findings count, and whose summary gates ready to merge, is named per
machine in `BABYSIT_TRUSTED_BOTS`: a JSON object keyed by GitLab username, each with the
`summaryMarker` its summary note contains and the `completeMarker` that appears once the review is
done. Unset, every bot is reported as unknown and never holds the MR.

**Done when:** the script exited and you have read its last snapshot's `actions`.

### 2. Handle every action

| Action | What to do |
| --- | --- |
| `process_review_items` | Judge each entry in `review.newItems` with `references/heuristics.md`. Fix what is actionable and correct, commit, push, then follow the write policy below for the thread. |
| `diagnose_ci_failure` | For each entry in `pipeline.failedJobs`, read `failureReason` and the log through `glab api <traceEndpoint>`. Classify with `references/heuristics.md`. Branch-caused: fix, commit, push. Flaky or unrelated: leave the code alone and take `retry_failed_jobs` when it is offered. |
| `retry_failed_jobs` | Only for a flaky or unrelated failure, and only when no fix is about to be pushed: rerun the script with `--retry-failed-now`. It retries every failed job of the current commit once and spends one of three retries per commit. |
| `ready_to_merge` | Stop. Report, and name `/merge-mr` as the next step. |
| `blocked_on_user` | Stop. Report `blockers` verbatim. |
| `stop_mr_closed`, `stop_exhausted_retries` | Stop. Report. |

Review items come before CI work when both appear: a review fix makes a new commit, and a retry
on the commit it replaces is wasted.

Before editing, find the worktree that has the MR's `sourceBranch` checked out with
`git worktree list`. None, or unrelated uncommitted changes in it, means stop and say so.

Thread commands, with `projectId` and `iid` from `snapshot.mergeRequest`:

```bash
glab api projects/<projectId>/merge_requests/<iid>/discussions/<discussionId>/notes -f body="Fixed in <sha>: <what changed>"
glab api -X PUT "projects/<projectId>/merge_requests/<iid>/discussions/<discussionId>?resolved=true"
```

**Done when:** every action in the last snapshot is handled and, unless the run ended, the watch
from step 1 is running again in this same turn.

### 3. Report

When the run ended or timed out, reply with the MR reference, the final commit, pipeline status,
the commits you pushed, retries used, items still open with the replies you propose, and the next
step: `/merge-mr`, or the blocker.

**Done when:** the reply says where the MR stands and what happens next.

## Write policy

- Push only when `mergeRequest.canPush` is true, meaning the user is the MR's author or an
  assignee. On anyone else's MR, put the patch in chat and stop.
- Resolve only a thread whose `canResolve` is true: the user or a trusted bot started it and no other
  human took part. Post the note naming the commit first, then resolve.
- Another human's thread gets no reply and no resolution from you. Put the proposed reply in chat
  and wait for the user.
- Kind `own_request` is the user's own request on their MR; act on it. Kind `own_note` is an
  instruction only when it asks for a change.
- A trusted bot's summary note gets no reply. Replying changes its note type and breaks the
  tooling that reads it. Its inline threads are ordinary items.
- `review.unknownBots` get one line in the report and nothing else.
- Manual jobs stay unplayed, conflicts stay unrebased, and the MR's draft, open, and reviewer
  state stay as they are. Those are the user's.
