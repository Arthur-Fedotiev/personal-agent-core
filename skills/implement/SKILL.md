---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch. If `docs/agents/commit-trailers.md` exists, label the commit per its convention with any decisions, rejected alternatives, or settled terms this work resolves — pull the gist from the spec, the tickets, or this session's grilling, don't re-derive it.
