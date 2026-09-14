---
name: good-push
description: Commit this session's current iteration and push the branch. Use when the user says good push or just push.
---

An **iteration** is the files and intent this session produced, not whatever else happens to be dirty.

This phrase authorizes a commit of those files and an ordinary `git push` in the same turn.

## Process

### 1. Scope the iteration

From the conversation, name the absolute paths this session edited and the change they make.

**Done when:** you can list those paths and say in one line what the commit is for.

### 2. Find the checkout that holds them

The session's starting directory is a guess, not the answer. A repository can have several linked checkouts, and the same relative path exists in each one, so committing in the wrong tree ships a stale copy of the file you meant.

```bash
git rev-parse --show-toplevel
git worktree list
```

Match the iteration's absolute paths against those roots. The tree that contains them is the **target tree**, and every later command runs against it with `git -C <target-tree>`.

Ask, then stop, when the paths straddle two trees, or when they belong to no listed tree.

**Done when:** one target tree holds every path in the iteration.

### 3. Read the target tree's state

```bash
git -C <target-tree> status -sb
git -C <target-tree> diff && git -C <target-tree> diff --cached
git -C <target-tree> log -5 --oneline
```

Ask, then stop, when the tree carries changes that are not from this iteration.

A clean target tree whose `HEAD` lacks the iteration means the edits are not where you think they are. Go back to step 2 rather than pushing this branch.

Personal guidance still binds: secrets, protected or release branches, and other hard stops.

**Done when:** the tree's uncommitted set is this iteration only, or its `HEAD` already carries it.

### 4. Commit if dirty

Stage the iteration's paths and commit in the target tree. Match its recent `git log` style. Apply `/unslop` to the message. If `docs/agents/commit-trailers.md` exists, attach trailers for decisions this session settled. Search first:

```bash
git -C <target-tree> log --all -P --grep '^Compound-'
```

**Done when:** the target tree's `HEAD` contains the iteration, or there was nothing to commit.

### 5. Push

`git -C <target-tree> push`, or `git -C <target-tree> push -u origin HEAD` if that branch has no upstream.

**Done when:** the upstream includes the target tree's `HEAD`, or you reported the push error and stopped.

### 6. Report

Reply with the commit subject, short SHA, and the branch it went to. Name the target tree when it is not the session's starting directory. If it was already clean and in sync, say so and stop.
