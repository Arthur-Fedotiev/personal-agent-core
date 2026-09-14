---
name: merge-mr
description: Squash-merge a GitLab MR, putting the commit message proposed in its description on both the squash and the merge commit.
argument-hint: "[MR iid or URL] [--dry-run]; defaults to the current branch's MR"
disable-model-invocation: true
---

Invoking this skill is the current-turn instruction to merge that personal guidance requires. The
script does the merge; this document is what to run and what to report.

## Process

### 1. Merge

Run the script from a shell whose working directory is inside the target repository, so glab
resolves the project. The script lives in `scripts/squash-merge.mjs` under this skill's base
directory. Pass the user's arguments through unchanged.

```bash
node <base-dir>/scripts/squash-merge.mjs $ARGUMENTS
```

It reads the MR and both of the project's commit templates, swaps each template body for the
proposed message from the description, prints the assembled messages, and merges with auto-merge,
so a running pipeline queues the merge rather than failing it. A squashed merge writes two
commits, and only the merge commit sits on the target branch's first-parent path, so the proposed
body and its trailers go on both. A fast-forward project writes no merge commit, and the script
says so in place of a merge message. Source-branch removal follows the MR's own setting.
`--dry-run` stops after printing the messages.

**Done when:** the script printed the assembled messages and then merged, queued, or exited with
an error.

### 2. Report

Reply with the MR reference, the proposed message's subject line, and whether it merged now or is
queued behind the pipeline.

When the script exits with an error, quote it and stop. A description without the proposed block
gets the block first, following the "Pull and merge requests" guidance, then a rerun.

**Done when:** the reply says what happened to the MR in one or two sentences.
