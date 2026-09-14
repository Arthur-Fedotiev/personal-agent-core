import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  assess,
  collectReviewItems,
  collectSnapshot,
  createState,
  parseArguments,
  parseMergeRequestReference,
  readTrustedBots,
  retryFailedJobs,
  runWatch,
  stateFilePath,
  summarizePipeline,
} from "./babysit.mjs";

// A GitLab as the backend sees it: one MR, one head pipeline with a child, and
// whatever the test changes in place between polls.
function fakeGitLab(overrides = {}) {
  const calls = [];
  const world = {
    approvals: { approvals_left: 0, approved_by: [{ user: { username: "bob" } }] },
    bridges: { 100: [{ downstream_pipeline: { id: 200, project_id: 9 } }], 200: [] },
    discussions: [],
    jobs: { 100: [{ allow_failure: false, id: 1, name: "test", stage: "test", status: "success" }], 200: [] },
    mergeRequest: {
      assignees: [{ username: "maintainer" }],
      author: { username: "maintainer" },
      detailed_merge_status: "mergeable",
      draft: false,
      has_conflicts: false,
      head_pipeline: {
        id: 100,
        project_id: 5,
        sha: "merge-ref-commit",
        source: "merge_request_event",
        status: "success",
        web_url: "https://gitlab.example.com/grp/proj/-/pipelines/100",
      },
      iid: 7,
      project_id: 5,
      references: { full: "grp/proj!7" },
      sha: "abc123",
      source_branch: "feat",
      state: "opened",
      target_branch: "main",
      title: "TW-1: do the thing",
      web_url: "https://gitlab.example.com/grp/proj/-/merge_requests/7",
    },
    reviewers: [],
    ...overrides,
  };
  const backend = {
    approvals: async () => world.approvals,
    calls,
    discussions: async () => world.discussions,
    me: async () => ({ username: "maintainer" }),
    mergeRequest: async () => world.mergeRequest,
    pipelineBridges: async (projectId, pipelineId) => world.bridges[pipelineId] ?? [],
    pipelineJobs: async (projectId, pipelineId) => world.jobs[pipelineId] ?? [],
    retryJob: async (projectId, jobId) => calls.push(["retryJob", projectId, jobId]),
    reviewers: async () => world.reviewers,
    world,
  };

  return backend;
}

const failedWorld = () => ({
  jobs: {
    100: [{ allow_failure: false, id: 1, name: "trigger", stage: "test", status: "success" }],
    200: [{ allow_failure: false, id: 20, name: "child-lint", stage: "lint", status: "failed" }],
  },
  mergeRequest: {
    ...fakeGitLab().world.mergeRequest,
    detailed_merge_status: "ci_must_pass",
    head_pipeline: { ...fakeGitLab().world.mergeRequest.head_pipeline, status: "failed" },
  },
});

test("collectSnapshot assembles the MR, the pipeline tree, the review, and the verdict", async () => {
  const backend = fakeGitLab();
  const { snapshot, state } = await collectSnapshot({ backend, iid: 7, state: createState() });

  assert.equal(snapshot.mergeRequest.reference, "grp/proj!7");
  assert.equal(snapshot.mergeRequest.canPush, true);
  assert.equal(snapshot.pipeline.status, "success");
  assert.deepEqual(snapshot.actions, ["ready_to_merge"]);
  assert.equal(snapshot.summary, "grp/proj!7 abc123 · pipeline success · ready to merge");
  assert.equal(snapshot.changed, true);
  assert.deepEqual(state.approvedBy, ["bob"]);
});

test("collectSnapshot only surfaces a review item the first time, but keeps it open", async () => {
  const backend = fakeGitLab({
    discussions: [
      {
        id: "d1",
        individual_note: false,
        notes: [{ author: { username: "bob" }, body: "Rename.", created_at: "t", id: 1, resolvable: true, resolved: false, system: false }],
      },
    ],
  });
  const first = await collectSnapshot({ backend, iid: 7, state: createState() });
  const second = await collectSnapshot({ backend, iid: 7, state: first.state });

  assert.deepEqual(first.snapshot.actions, ["process_review_items"]);
  assert.deepEqual(second.snapshot.actions, ["idle"]);
  assert.equal(second.snapshot.review.unresolvedThreads.length, 1);
  assert.deepEqual(second.snapshot.waitingOn, ["1 unresolved thread"]);
});

test("collectSnapshot remembers what it last reported, so a re-run knows whether anything moved", async () => {
  const backend = fakeGitLab();
  const first = await collectSnapshot({ backend, iid: 7, state: createState() });
  const second = await collectSnapshot({ backend, iid: 7, state: first.state });

  assert.equal(first.snapshot.changed, true);
  assert.equal(second.snapshot.changed, false);
});

test("collectSnapshot says when the MR is someone else's, so fixes are proposed, not pushed", async () => {
  const backend = fakeGitLab();
  backend.world.mergeRequest = { ...backend.world.mergeRequest, assignees: [], author: { username: "bob" } };

  const { snapshot } = await collectSnapshot({ backend, iid: 7, state: createState() });

  assert.equal(snapshot.mergeRequest.canPush, false);
});

test("retryFailedJobs retries each failed job once per call and spends the budget for that commit", async () => {
  const backend = fakeGitLab(failedWorld());
  const first = await collectSnapshot({ backend, iid: 7, state: createState() });

  assert.deepEqual(first.snapshot.actions, ["diagnose_ci_failure", "retry_failed_jobs"]);

  const result = await retryFailedJobs({ backend, snapshot: first.snapshot, state: first.state });

  assert.deepEqual(result, { reason: "retried", retriedJobIds: [20] });
  assert.deepEqual(backend.calls, [["retryJob", 9, 20]]);
  assert.deepEqual(first.state.retriesBySha, { abc123: 1 });

  first.state.retriesBySha.abc123 = 3;
  const exhausted = await collectSnapshot({ backend, iid: 7, state: first.state });
  const refused = await retryFailedJobs({ backend, snapshot: exhausted.snapshot, state: exhausted.state });

  assert.deepEqual(exhausted.snapshot.actions, ["stop_exhausted_retries"]);
  assert.equal(refused.reason, "retry budget exhausted");
  assert.equal(backend.calls.length, 1);
});

test("runWatch polls through idle snapshots and exits once the run ends", async () => {
  const backend = fakeGitLab();
  backend.world.mergeRequest = {
    ...backend.world.mergeRequest,
    detailed_merge_status: "ci_still_running",
    head_pipeline: { ...backend.world.mergeRequest.head_pipeline, status: "running" },
  };
  const events = [];
  const slept = [];
  const sleep = async (seconds) => {
    slept.push(seconds);
    if (slept.length === 2) {
      backend.world.mergeRequest = {
        ...backend.world.mergeRequest,
        detailed_merge_status: "mergeable",
        head_pipeline: { ...backend.world.mergeRequest.head_pipeline, status: "success" },
      };
    }
  };
  let clock = 0;

  const code = await runWatch({
    backend,
    emit: (event) => events.push(event),
    iid: 7,
    now: () => (clock += 1000),
    options: { interval: 60, timeout: 7200 },
    sleep,
    store: memoryStore(),
  });

  assert.equal(code, 0);
  assert.deepEqual(slept, [60, 60]);
  assert.deepEqual(
    events.map((event) => [event.event, event.snapshot?.changed ?? null, event.snapshot?.actions ?? event.reason]),
    [
      ["snapshot", true, ["idle"]],
      ["snapshot", false, ["idle"]],
      ["snapshot", true, ["ready_to_merge"]],
      ["stop", null, "ready_to_merge"],
    ],
  );
});

test("runWatch hands control back as soon as there is something for the agent to do", async () => {
  const backend = fakeGitLab(failedWorld());
  const events = [];

  const code = await runWatch({
    backend,
    emit: (event) => events.push(event),
    iid: 7,
    now: () => 0,
    options: { interval: 60, timeout: 7200 },
    sleep: async () => assert.fail("should not sleep before handing over"),
    store: memoryStore(),
  });

  assert.equal(code, 3);
  assert.deepEqual(events.at(-1), { event: "stop", reason: "diagnose_ci_failure" });
});

test("runWatch gives up after the timeout with a still-waiting stop", async () => {
  const backend = fakeGitLab({ approvals: { approvals_left: 1, approved_by: [] } });
  backend.world.mergeRequest = { ...backend.world.mergeRequest, detailed_merge_status: "not_approved" };
  const events = [];
  let clock = 0;

  const code = await runWatch({
    backend,
    emit: (event) => events.push(event),
    iid: 7,
    now: () => (clock += 3000 * 1000),
    options: { interval: 60, timeout: 7200 },
    sleep: async () => {},
    store: memoryStore(),
  });

  assert.equal(code, 2);
  assert.deepEqual(events.at(-1), { event: "stop", reason: "timeout", waitingOn: ["1 approval"] });
});

test("a trusted bot summary that is not complete counts as pending even before it is a reviewer", () => {
  const result = review({ discussions: [topLevel(reviewBot, "## Review Bot Summary\n\nAnalysing...")] });

  assert.equal(result.pendingBotReview, reviewBot);
});

test("stateFilePath keeps one file per MR under the OS temporary directory", () => {
  const path = stateFilePath({ host: "gitlab.example.com", iid: 7, projectPath: "grp/sub/proj" });

  assert.match(path, /babysit-mr\/gitlab\.example\.com\/grp__sub__proj\/7\.json$/);
});

test("usernames compare without regard to case, as GitLab reports the operator in mixed case", () => {
  const result = review({ discussions: [thread("d7", [note("Maintainer", "Tighten this type.")])] });

  assert.equal(result.newItems[0].kind, "own_request");
});

test("the script runs when invoked through a symlink, as the installed skill does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "babysit-mr-"));
  const link = join(directory, "babysit.mjs");
  await symlink(fileURLToPath(new URL("./babysit.mjs", import.meta.url)), link);

  const result = await execFileAsync("node", [link, "feature-branch"]).catch((error) => error);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot read a merge request/);
});

function memoryStore() {
  let saved = createState();

  return {
    load: async () => saved,
    save: async (state) => {
      saved = state;
    },
  };
}

const mergeRequest = (overrides = {}) => ({
  detailed_merge_status: "mergeable",
  draft: false,
  has_conflicts: false,
  sha: "abc123",
  state: "opened",
  target_branch: "main",
  ...overrides,
});

const greenPipeline = (overrides = {}) => ({
  blockers: [],
  failedJobs: [],
  pendingCount: 0,
  sha: "abc123",
  source: "push",
  status: "success",
  terminal: true,
  ...overrides,
});

const quietReview = (overrides = {}) => ({
  newItems: [],
  pendingBotReview: null,
  unresolvedThreads: [],
  ...overrides,
});

function decide(overrides = {}) {
  return assess({
    approvalsLeft: 0,
    maxRetries: 3,
    mergeRequest: mergeRequest(),
    pipeline: greenPipeline(),
    retriesUsed: 0,
    review: quietReview(),
    ...overrides,
  });
}

const item = { id: "discussion:d1", kind: "thread" };

test("assess hands a green, clean, approved MR to merge-mr and stops", () => {
  const verdict = decide();

  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.actions, ["ready_to_merge"]);
  assert.deepEqual(verdict.waitingOn, []);
});

test("assess keeps waiting while approval, threads, or the bot review are outstanding", () => {
  const verdict = decide({
    approvalsLeft: 1,
    mergeRequest: mergeRequest({ detailed_merge_status: "not_approved" }),
    review: quietReview({ pendingBotReview: reviewBot, unresolvedThreads: [item] }),
  });

  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.actions, ["idle"]);
  assert.deepEqual(verdict.waitingOn, ["1 approval", "1 unresolved thread", `${reviewBot} review`]);
});

test("assess is not ready when the green branch pipeline ran on an older commit", () => {
  const verdict = decide({ pipeline: greenPipeline({ sha: "old", source: "push" }) });

  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.waitingOn, ["a pipeline for abc123"]);
});

test("assess trusts a merged-results pipeline as the head's even though its commit differs", () => {
  const verdict = decide({ pipeline: greenPipeline({ sha: "merge-ref-commit", source: "merge_request_event" }) });

  assert.equal(verdict.ready, true);
});

test("assess asks for diagnosis and offers a retry once a failed pipeline is terminal", () => {
  const failed = greenPipeline({ failedJobs: [{ id: 20 }], status: "failed" });

  assert.deepEqual(decide({ pipeline: failed }).actions, ["diagnose_ci_failure", "retry_failed_jobs"]);
  assert.deepEqual(
    decide({ pipeline: greenPipeline({ failedJobs: [{ id: 20 }], status: "running", terminal: false }) }).actions,
    ["diagnose_ci_failure"],
  );
  assert.deepEqual(decide({ pipeline: failed, retriesUsed: 3 }).actions, ["stop_exhausted_retries"]);
});

test("assess puts review items before CI work and never retries under them", () => {
  const verdict = decide({
    pipeline: greenPipeline({ failedJobs: [{ id: 20 }], status: "failed" }),
    review: quietReview({ newItems: [item], unresolvedThreads: [item] }),
  });

  assert.deepEqual(verdict.actions, ["process_review_items", "diagnose_ci_failure"]);
});

test("assess stops for the user on manual pipelines and conflicts", () => {
  const manual = decide({ pipeline: greenPipeline({ blockers: ["pipeline 100 is waiting on manual job deploy"], status: "blocked" }) });
  const conflict = decide({ mergeRequest: mergeRequest({ detailed_merge_status: "conflict", has_conflicts: true }) });

  assert.deepEqual(manual.actions, ["blocked_on_user"]);
  assert.deepEqual(manual.blockers, ["pipeline 100 is waiting on manual job deploy"]);
  assert.deepEqual(conflict.actions, ["blocked_on_user"]);
  assert.deepEqual(conflict.blockers, ["conflicts with main; a rebase is a force push, so that is yours"]);
});

test("assess stops when the MR is merged or closed, surfacing any last items", () => {
  assert.deepEqual(decide({ mergeRequest: mergeRequest({ state: "merged" }) }).actions, ["stop_mr_closed"]);
  assert.deepEqual(
    decide({ mergeRequest: mergeRequest({ state: "closed" }), review: quietReview({ newItems: [item] }) }).actions,
    ["process_review_items", "stop_mr_closed"],
  );
});

const me = "maintainer";

let noteId = 1000;
const note = (username, body, overrides = {}) => ({
  author: { username },
  body,
  created_at: "2026-09-07T10:00:00Z",
  id: (noteId += 1),
  resolvable: true,
  resolved: false,
  system: false,
  type: "DiffNote",
  ...overrides,
});

const thread = (id, notes) => ({ id, individual_note: false, notes });
const topLevel = (username, body, overrides = {}) => ({
  id: `top-${noteId + 1}`,
  individual_note: true,
  notes: [note(username, body, { resolvable: false, type: null, ...overrides })],
});

const reviewBot = "review-bot";
const trustedBots = {
  [reviewBot]: { completeMarker: "Review Complete", summaryMarker: "Review Bot Summary" },
};

function review(overrides = {}) {
  return collectReviewItems({
    approvals: { approved_by: [] },
    discussions: [],
    me,
    previousApprovedBy: [],
    reviewers: [],
    seenItemIds: [],
    trustedBots,
    ...overrides,
  });
}

test("readTrustedBots reads the per-machine bot list and defaults to none", () => {
  assert.deepEqual(readTrustedBots(undefined), {});
  assert.deepEqual(readTrustedBots(JSON.stringify(trustedBots)), trustedBots);
});

test("a bot outside the trusted list is unknown even when it posts a summary", () => {
  const result = review({
    discussions: [topLevel(reviewBot, "## Review Bot Summary\n\nReview Complete")],
    trustedBots: {},
  });

  assert.deepEqual(result.unknownBots, [reviewBot]);
  assert.equal(result.pendingBotReview, null);
});

test("an unresolved thread from another human is a new item once, then stays open", () => {
  const discussions = [thread("d1", [note("bob", "Rename this.", { position: { new_line: 12, new_path: "src/a.ts" } })])];
  const first = review({ discussions });

  assert.equal(first.newItems.length, 1);
  assert.deepEqual(
    { ...first.newItems[0], body: undefined },
    {
      actionable: true,
      author: "bob",
      body: undefined,
      canResolve: false,
      createdAt: "2026-09-07T10:00:00Z",
      discussionId: "d1",
      file: "src/a.ts",
      id: "discussion:d1",
      kind: "thread",
      line: 12,
      participants: ["bob"],
    },
  );
  assert.equal(first.newItems[0].body, "Rename this.");

  const second = review({ discussions, seenItemIds: first.seenItemIds });

  assert.deepEqual(second.newItems, []);
  assert.equal(second.unresolvedThreads.length, 1);
});

test("a thread I started asking for a change is actionable and mine to resolve", () => {
  const result = review({ discussions: [thread("d2", [note(me, "Let's also update the README here.")])] });

  assert.equal(result.newItems[0].kind, "own_request");
  assert.equal(result.newItems[0].actionable, true);
  assert.equal(result.newItems[0].canResolve, true);
});

test("my reply inside another human's thread does not make it mine, and blocks resolving", () => {
  const result = review({
    discussions: [thread("d3", [note("bob", "Why this?"), note(me, "Because X.")])],
  });

  assert.equal(result.newItems[0].kind, "thread");
  assert.equal(result.newItems[0].canResolve, false);
  assert.deepEqual(result.newItems[0].participants, ["bob"]);
});

test("resolved threads and system notes are not items", () => {
  const result = review({
    discussions: [
      thread("d4", [note("bob", "Done?", { resolved: true })]),
      topLevel("bob", "added 2 commits", { system: true }),
    ],
  });

  assert.deepEqual(result.newItems, []);
  assert.deepEqual(result.unresolvedThreads, []);
});

test("a top-level note from another human is an item; mine is surfaced for judgement", () => {
  const result = review({
    discussions: [topLevel("bob", "Can you split this MR?"), topLevel(me, "Reminder: bump the version before merge.")],
  });

  assert.deepEqual(
    result.newItems.map((item) => [item.kind, item.actionable]),
    [
      ["note", true],
      ["own_note", "judge"],
    ],
  );
});

test("a trusted bot's inline threads are actionable and resolvable; its summary is not an item", () => {
  const result = review({
    discussions: [
      topLevel(reviewBot, "## Review Bot Summary\n\nReview Complete\nInline Comments Posted: 1"),
      thread("d5", [note(reviewBot, "HIGH: possible null dereference.")]),
    ],
    reviewers: [{ user: { username: reviewBot }, state: "reviewed" }],
  });

  assert.deepEqual(
    result.newItems.map((item) => [item.kind, item.author, item.canResolve]),
    [["thread", reviewBot, true]],
  );
  assert.equal(result.pendingBotReview, null);
});

test("an unfinished trusted bot review counts as pending, whether it has started or not", () => {
  const notStarted = review({ reviewers: [{ user: { username: reviewBot }, state: "unreviewed" }] });
  const running = review({
    discussions: [topLevel(reviewBot, "## Review Bot Summary\n\nAnalysing 12 files...")],
    reviewers: [{ user: { username: reviewBot }, state: "unreviewed" }],
  });

  assert.equal(notStarted.pendingBotReview, reviewBot);
  assert.equal(running.pendingBotReview, reviewBot);
});

test("unknown bots are reported by name and never become items", () => {
  const result = review({ discussions: [thread("d6", [note("project_42_bot_a1b2", "Coverage dropped 0.1%.")])] });

  assert.deepEqual(result.newItems, []);
  assert.deepEqual(result.unknownBots, ["project_42_bot_a1b2"]);
});

test("a reviewer requesting changes is an item until they change their mind", () => {
  const requested = review({ reviewers: [{ user: { username: "bob" }, state: "requested_changes" }] });

  assert.deepEqual(
    requested.newItems.map((item) => [item.id, item.kind, item.author]),
    [["changes_requested:bob", "changes_requested", "bob"]],
  );

  const stillRequested = review({
    reviewers: [{ user: { username: "bob" }, state: "requested_changes" }],
    seenItemIds: requested.seenItemIds,
  });
  const approved = review({
    reviewers: [{ user: { username: "bob" }, state: "approved" }],
    seenItemIds: requested.seenItemIds,
  });

  assert.deepEqual(stillRequested.newItems, []);
  assert.deepEqual(approved.seenItemIds, []);
});

test("a revoked approval is an item; a granted one is only progress", () => {
  const granted = review({ approvals: { approved_by: [{ user: { username: "bob" } }] } });
  const revoked = review({ approvals: { approved_by: [] }, previousApprovedBy: granted.approvedBy });

  assert.deepEqual(granted.newItems, []);
  assert.deepEqual(granted.approvedBy, ["bob"]);
  assert.deepEqual(
    revoked.newItems.map((item) => [item.id, item.kind]),
    [["approval_revoked:bob", "approval_revoked"]],
  );
});

const job = (overrides) => ({
  allow_failure: false,
  id: 1,
  name: "test",
  stage: "test",
  status: "success",
  web_url: "https://gitlab.example.com/grp/proj/-/jobs/1",
  ...overrides,
});

const pipeline = (overrides) => ({
  id: 100,
  project_id: 5,
  sha: "abc123",
  source: "merge_request_event",
  status: "running",
  web_url: "https://gitlab.example.com/grp/proj/-/pipelines/100",
  ...overrides,
});

test("summarizePipeline carries the head pipeline's commit and source for the ready check", () => {
  const summary = summarizePipeline([{ pipeline: pipeline({ status: "success" }), jobs: [job()] }]);

  assert.equal(summary.sha, "abc123");
  assert.equal(summary.source, "merge_request_event");
});

test("summarizePipeline reports no pipeline when the MR has none or it was skipped", () => {
  assert.equal(summarizePipeline([]).status, "none");
  assert.equal(summarizePipeline([{ pipeline: pipeline({ status: "skipped" }), jobs: [] }]).status, "none");
});

test("summarizePipeline counts pending jobs while the pipeline runs", () => {
  const summary = summarizePipeline([
    {
      pipeline: pipeline(),
      jobs: [job(), job({ id: 2, status: "running" }), job({ id: 3, status: "pending" })],
    },
  ]);

  assert.equal(summary.status, "running");
  assert.equal(summary.terminal, false);
  assert.equal(summary.pendingCount, 2);
  assert.deepEqual(summary.failedJobs, []);
});

test("summarizePipeline ignores failed jobs that are allowed to fail", () => {
  const summary = summarizePipeline([
    {
      pipeline: pipeline({ status: "success" }),
      jobs: [job(), job({ id: 2, status: "failed", allow_failure: true })],
    },
  ]);

  assert.equal(summary.status, "success");
  assert.equal(summary.terminal, true);
  assert.deepEqual(summary.failedJobs, []);
});

test("summarizePipeline surfaces a failed job in a child pipeline before the parent finishes", () => {
  const summary = summarizePipeline([
    { pipeline: pipeline(), jobs: [job({ id: 1, name: "trigger", status: "running" })] },
    {
      pipeline: pipeline({ id: 200, project_id: 9, status: "failed" }),
      jobs: [
        job({
          failure_reason: "runner_system_failure",
          id: 20,
          name: "child-lint",
          status: "failed",
          web_url: "https://gitlab.example.com/other/-/jobs/20",
        }),
      ],
    },
  ]);

  assert.equal(summary.status, "running");
  assert.equal(summary.terminal, false);
  assert.deepEqual(summary.failedJobs, [
    {
      failureReason: "runner_system_failure",
      id: 20,
      name: "child-lint",
      pipelineId: 200,
      projectId: 9,
      stage: "test",
      traceEndpoint: "projects/9/jobs/20/trace",
      webUrl: "https://gitlab.example.com/other/-/jobs/20",
    },
  ]);
});

test("summarizePipeline treats manual and canceled pipelines as blockers, never as failures", () => {
  const manual = summarizePipeline([
    { pipeline: pipeline({ status: "manual" }), jobs: [job({ status: "manual", name: "deploy" })] },
  ]);
  const canceled = summarizePipeline([
    { pipeline: pipeline({ status: "canceled" }), jobs: [job({ status: "canceled" })] },
  ]);

  assert.equal(manual.status, "blocked");
  assert.equal(manual.terminal, true);
  assert.deepEqual(manual.blockers, ["pipeline 100 is waiting on manual job deploy"]);
  assert.equal(canceled.status, "blocked");
  assert.deepEqual(canceled.blockers, ["pipeline 100 was canceled"]);
});

test("parseMergeRequestReference reads a bare iid and a !iid short reference", () => {
  assert.deepEqual(parseMergeRequestReference("26373"), { iid: 26373 });
  assert.deepEqual(parseMergeRequestReference("!26373"), { iid: 26373 });
});

test("parseMergeRequestReference reads host, project, and iid out of an MR URL", () => {
  assert.deepEqual(
    parseMergeRequestReference("https://gitlab.example.com/grp/sub/proj/-/merge_requests/7/diffs"),
    { host: "gitlab.example.com", iid: 7, projectPath: "grp/sub/proj" },
  );
});

test("parseMergeRequestReference returns null when nothing was passed", () => {
  assert.equal(parseMergeRequestReference(undefined), null);
  assert.equal(parseMergeRequestReference(""), null);
});

test("parseMergeRequestReference rejects text that is not a merge request", () => {
  assert.throws(() => parseMergeRequestReference("feature-branch"), /Cannot read a merge request/);
});

test("parseArguments defaults to watching with the agreed cadence and bounds", () => {
  assert.deepEqual(parseArguments([]), {
    interval: 60,
    mode: "watch",
    reference: undefined,
    timeout: 7200,
  });
});

test("parseArguments separates the reference from the flags", () => {
  const options = parseArguments(["!7", "--once", "--interval", "15", "--timeout", "600"]);

  assert.equal(options.reference, "!7");
  assert.equal(options.mode, "once");
  assert.equal(options.interval, 15);
  assert.equal(options.timeout, 600);
});

test("parseArguments rejects unknown flags, a second reference, and two modes", () => {
  assert.throws(() => parseArguments(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseArguments(["7", "8"]), /one merge request at a time/);
  assert.throws(
    () => parseArguments(["--once", "--retry-failed-now"]),
    /one of --once, --watch, --retry-failed-now/,
  );
  assert.throws(() => parseArguments(["--interval", "0"]), /--interval needs a whole number of seconds/);
});
