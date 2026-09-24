---
name: raise-mr
description: Raise a GitLab MR for the current branch with Artur's description shape, the squash-message block, and before/after screenshots when the change is visual.
disable-model-invocation: true
---

Invoking this skill is the current-turn instruction to push the current branch and open its MR.
Merging is not part of it; that is `merge-mr`.

## Process

### 1. Confirm the branch carries the work

```bash
git status -sb && git log --oneline origin/master..HEAD
```

Every commit starts with the Jira key. The working tree holds nothing but this iteration; anything
else is stashed or left uncommitted on purpose and named in the report.

**Done when:** the commits to ship are listed and the tree is clean of stray edits.

### 2. Collect the evidence

Verification is what already ran: name the exact targets and their result. A visual change (styles,
layout, a new control) also needs a **before** and an **after** screenshot of the real component,
taken with [`visual-evidence.md`](visual-evidence.md). Unit specs that measure CSS geometry are not
evidence; leave them out.

**Done when:** every claim the description will make has a command result or an image behind it.

### 3. Write the description

Follow the repository template if it has one. Otherwise:

- First line: the Jira link and, when it exists, the parent or related ticket, plus where the
  defect was seen.
- `## What the user sees`: one `Before:` sentence and one `After:` sentence. Place the screenshots
  here, before above after, each with a one-line caption.
- `## Why`: the cause in the code, named by file and mechanism.
- `## Change`: one bullet per file that matters to a reviewer.
- `## Verification`: the targets and flags that ran.
- `## Not in this MR`: only what a reviewer would otherwise ask about.
- A collapsed `<details>` block titled `Squash commit message (not for review)` holding a fenced
  block between `<!-- squash-message -->` and `<!-- /squash-message -->`: the squash subject and
  body, the `Compound-*` trailers, and the attribution lines the session requires. `merge-mr` reads
  it, so it is the durable record of the decisions.

Apply `/unslop`. Release-branch MRs use the `RB_nnn -> TW-a, TW-b: what` title and a shorter body
(title as H1, one bullet per Jira with its master MR).

**Done when:** the description reads cold, and the squash block would be a correct commit on its
own.

### 4. Push and create

```bash
git push -u origin "$(git branch --show-current)"
glab mr create --title "TW-nnnnnn: <what changes>" --target-branch master \
  --assignee @me --squash-before-merge --remove-source-branch --yes \
  --description "$(cat <<'EOF'
...
EOF
)"
```

Images go in after creation when they are files: upload with `glab api projects/:fullpath/uploads
-F "file=@<path>"`, take the returned `markdown`, and put it into the description through
`glab mr update <iid> --description`. Pasting in the GitLab UI works as well and is Artur's default.

**Done when:** `glab mr view <iid>` shows the description, the squash block, and the images.

### 5. Close the loop

Comment on the Jira with the bare MR number and one sentence on the fix (the Jira MCP mangles
`!` and underscores). Report the MR URL, the commits, what was verified, and what was left out.
