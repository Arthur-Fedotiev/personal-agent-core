# Classifying failures and review items

## A failed job is branch-caused when

- `failureReason` is `script_failure` and the log points at code the branch touched: compile,
  type-check, lint, unit or integration tests, snapshots, static analysis in those areas.
- The pipeline configuration or build scripts changed in this MR and the failure is deterministic.

Fix it in the source branch, commit, push. Read the log before reading the diff; the log says
where, the diff says whether it is yours.

## A failed job is flaky or unrelated when

- `failureReason` is `runner_system_failure`, `stuck_or_timeout_failure`, `job_execution_timeout`,
  `scheduler_failure`, `data_integrity_failure`, or `api_failure`.
- The log shows a registry, Artifactory, DNS, or network timeout while fetching dependencies, a
  runner that never started, or a service outage.
- A test unrelated to the branch fails non-deterministically with a known flake pattern.

Leave tests, build scripts, CI configuration, dependency pins, and infrastructure code alone. Wait
for `retry_failed_jobs`, and when the budget of three retries per commit is spent, report the
persistent failure as a blocker.

When the log is ambiguous, read it once more with the diff beside it before choosing a retry.

## Address a review item when

- The comment is technically correct and the change fits the branch.
- The change does not contradict the user's intent or recent guidance.
- The change needs no unrelated refactor.

## Put a review item to the user instead when

- It needs clarification, a product or design decision, or cross-team coordination.
- It only needs a written answer or a disagreement, so the deliverable is a reply, and replies to
  other humans are the user's.
- The worktree holding the source branch has unrelated uncommitted changes.

## Stop for the user when

The script already stops on manual, canceled, or conflicting MRs and on a spent retry budget.
Beyond those:

- glab authentication or permissions fail.
- The push is rejected.
- A fix would touch a file the MR does not already change, and the reason is not obvious.
