# Upstream: mattpocock/skills

- URL: https://github.com/mattpocock/skills
- License: MIT, Copyright (c) 2026 Matt Pocock (see `LICENSE` beside this file)
- Pinned SHA: `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`
- Pin date: 2026-08-24 (`main` as recorded in the 2026-08-31 upstream research). A live `main` fetch on 2026-09-01 timed out from this machine, so this vendor pass did not advance the pin.
- Copied on: 2026-09-01; `ask-matt`, `improve-codebase-architecture`, and `to-questionnaire` added 2026-09-02
- Copied from: this machine's installed tree at `~/.claude/skills`

## Files taken

Whole skill directories, including sibling format docs, `agents/openai.yaml`, and bundled scripts:

- wayfinder
- grilling
- grill-me
- grill-with-docs
- domain-modeling
- research
- prototype
- triage
- to-spec
- to-tickets
- implement
- unslop
- tdd
- diagnosing-bugs
- codebase-design
- resolving-merge-conflicts
- handoff
- wait-what
- wizard
- writing-for-agents
- teach
- code-review
- git-guardrails-claude-code
- setup-matt-pocock-skills
- ask-matt
- improve-codebase-architecture
- to-questionnaire

Not taken: pstack skills, a second unslop/tdd/teach, `/analyze-chat-patterns`, and extras left for a later monthly review (`scaffold-exercises`, `technical-article-author`, and the rest of the home tree).

## Local edits

- `unslop`: keep the local Answer-shape section that upstream Matt/pstack copies lack. That is the fork. The 31-pattern body is otherwise Matt's. Its `agents/openai.yaml` is local too; upstream ships none.
- `agents/openai.yaml` in every user-invoked skill carries `policy.allow_implicit_invocation: false`, and dry-run refuses a skill whose policy disagrees with its `disable-model-invocation` frontmatter or whose `short_description` falls outside 25-64 characters. Those lines must survive re-vendoring: diff each yaml against the vendored copy before replacing it, and put the policy back if upstream drops it.
- `git-guardrails-claude-code`: copied as installed, including the bundled script's `git push` pattern. This rollout map deferred the ordinary-push patch and the Claude hook install, so the files are vendored, not patched, and the hook is not installed.
- Every other directory: no further edits in this pass.
