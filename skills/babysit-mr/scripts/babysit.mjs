#!/usr/bin/env node

// Babysitting an MR means following its pipeline, review threads, and
// mergeability until it is ready to merge, blocked on a person, or gone. The
// agent cannot reliably remember across an hour of polling which review items
// it already surfaced or how many times a job was retried, so that state lives
// here, in a file under the OS temporary directory, and each snapshot ends in
// an `actions` list the agent acts on.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleepFor } from "node:timers/promises";

const MODES = ["--once", "--watch", "--retry-failed-now"];
const SECONDS_FLAGS = ["--interval", "--timeout"];
const MAX_RETRIES = 3;

const camelCase = (flag) => flag.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

export function parseArguments(argv) {
  const options = { interval: 60, mode: "watch", reference: undefined, timeout: 7200 };
  let modeFlag;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (MODES.includes(argument)) {
      if (modeFlag !== undefined) {
        throw new Error(`Pass one of --once, --watch, --retry-failed-now; got ${modeFlag} and ${argument}`);
      }
      modeFlag = argument;
      options.mode = camelCase(argument);
      continue;
    }

    if (SECONDS_FLAGS.includes(argument)) {
      const value = Number(argv[index + 1]);
      index += 1;

      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${argument} needs a whole number of seconds`);
      }
      options[camelCase(argument)] = value;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (options.reference !== undefined) {
      throw new Error(`Babysit one merge request at a time; got both ${options.reference} and ${argument}`);
    }

    options.reference = argument;
  }

  return options;
}

export function parseMergeRequestReference(input) {
  if (input === undefined || input === "") {
    return null;
  }

  const bare = input.match(/^!?(\d+)$/);

  if (bare) {
    return { iid: Number(bare[1]) };
  }

  const url = input.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);

  if (url) {
    return { host: url[1], iid: Number(url[3]), projectPath: url[2] };
  }

  throw new Error(
    `Cannot read a merge request from "${input}". Pass an iid such as 26373, !26373, or the MR URL.`,
  );
}

const PENDING_JOB_STATUSES = new Set([
  "created",
  "pending",
  "preparing",
  "running",
  "waiting_for_resource",
  "scheduled",
]);

/**
 * The head pipeline comes first, then every pipeline a bridge job triggered,
 * however deep. Only the head pipeline's status decides where the MR stands;
 * the children matter for the jobs they failed, which the head reports as a
 * single failed bridge at best.
 *
 * A job allowed to fail never counts. A manual or canceled pipeline is a
 * blocker for the user, not a failure to diagnose: playing a manual job is a
 * deploy in some repositories.
 */
export function summarizePipeline(pipelines) {
  const head = pipelines[0]?.pipeline;
  const failedJobs = [];
  let pendingCount = 0;

  for (const { pipeline, jobs } of pipelines) {
    for (const job of jobs) {
      if (PENDING_JOB_STATUSES.has(job.status)) {
        pendingCount += 1;
      }

      if (job.status === "failed" && !job.allow_failure) {
        failedJobs.push({
          failureReason: job.failure_reason ?? null,
          id: job.id,
          name: job.name,
          pipelineId: pipeline.id,
          projectId: pipeline.project_id,
          stage: job.stage,
          traceEndpoint: `projects/${pipeline.project_id}/jobs/${job.id}/trace`,
          webUrl: job.web_url,
        });
      }
    }
  }

  const status = headStatus(head);
  const blockers = [];

  if (status === "blocked") {
    blockers.push(
      head.status === "canceled"
        ? `pipeline ${head.id} was canceled`
        : `pipeline ${head.id} is waiting on manual job ${manualJobNames(pipelines).join(", ")}`,
    );
  }

  return {
    blockers,
    failedJobs,
    pendingCount,
    sha: head?.sha ?? null,
    source: head?.source ?? null,
    status,
    terminal: status !== "running",
    webUrl: head?.web_url ?? null,
  };
}

function headStatus(head) {
  if (!head || head.status === "skipped") {
    return "none";
  }

  if (head.status === "success" || head.status === "failed") {
    return head.status;
  }

  if (head.status === "manual" || head.status === "scheduled" || head.status === "canceled") {
    return "blocked";
  }

  return "running";
}

function manualJobNames(pipelines) {
  return pipelines.flatMap(({ jobs }) => jobs.filter((job) => job.status === "manual").map((job) => job.name));
}

const BOT_USERNAME = /(^|[_.-])bot([_.-]|\d|$)/i;
const SNIPPET_LENGTH = 200;

/**
 * Review bots whose findings are worth acting on, keyed by GitLab username.
 * Such a bot posts a summary note first and inline threads after it, and the
 * two are not atomic, so its review is pending until the summary carries the
 * complete marker. The bots belong to a GitLab host, not to this repository,
 * so they are named per machine:
 *
 *   BABYSIT_TRUSTED_BOTS='{"<username>":{"summaryMarker":"...","completeMarker":"..."}}'
 */
export function readTrustedBots(source = process.env.BABYSIT_TRUSTED_BOTS) {
  return source ? JSON.parse(source) : {};
}

/**
 * Turns the MR's discussions, reviewers, and approvals into review items, the
 * things the babysitter must look at, and separates the ones not surfaced
 * before. Seen ids are pruned to items that still exist, so a thread that is
 * reopened, or a reviewer who asks for changes a second time, surfaces again.
 */
export function collectReviewItems({
  approvals,
  discussions,
  me,
  previousApprovedBy,
  reviewers,
  seenItemIds,
  trustedBots = readTrustedBots(),
}) {
  const items = [];
  const unresolvedThreads = [];
  const unknownBots = new Set();
  const botSummaries = new Map();
  // GitLab usernames are unique without regard to case, and /user reports the
  // operator's chosen casing while notes may carry another.
  const isMe = (username) => username.toLowerCase() === me.toLowerCase();
  const isTrustedBot = (username) => Object.hasOwn(trustedBots, username);
  const isUnknownBot = (username) => !isTrustedBot(username) && BOT_USERNAME.test(username);

  for (const discussion of discussions) {
    const notes = discussion.notes.filter((entry) => !entry.system);
    const first = notes[0];

    if (!first) {
      continue;
    }

    const startedBy = first.author.username;

    if (isUnknownBot(startedBy)) {
      unknownBots.add(startedBy);
      continue;
    }

    const summary = isTrustedBot(startedBy) && trustedBots[startedBy].summaryMarker;

    if (summary && first.body.includes(summary)) {
      botSummaries.set(startedBy, first.body.includes(trustedBots[startedBy].completeMarker));
      continue;
    }

    const unresolved = notes.some((entry) => entry.resolvable && !entry.resolved);
    const humans = [...new Set(notes.map((entry) => entry.author.username))].filter(
      (username) => !isMe(username) && !isTrustedBot(username),
    );
    const base = {
      author: startedBy,
      body: snippet(first.body),
      createdAt: first.created_at,
      discussionId: discussion.id,
      file: first.position?.new_path ?? first.position?.old_path ?? null,
      line: first.position?.new_line ?? first.position?.old_line ?? null,
      participants: humans,
    };

    if (unresolved) {
      const item = {
        ...base,
        actionable: true,
        canResolve: humans.length === 0,
        id: `discussion:${discussion.id}`,
        kind: isMe(startedBy) ? "own_request" : "thread",
      };
      items.push(item);
      unresolvedThreads.push(item);
      continue;
    }

    if (discussion.individual_note) {
      items.push({
        ...base,
        actionable: isMe(startedBy) ? "judge" : true,
        canResolve: false,
        id: `note:${first.id}`,
        kind: isMe(startedBy) ? "own_note" : "note",
      });
    }
  }

  for (const reviewer of reviewers) {
    if (reviewer.state === "requested_changes") {
      items.push(reviewItem("changes_requested", reviewer.user.username));
    }
  }

  const approvedBy = approvals.approved_by.map((entry) => entry.user.username);

  for (const username of previousApprovedBy) {
    if (!approvedBy.includes(username)) {
      items.push(reviewItem("approval_revoked", username));
    }
  }

  // A trusted bot's review is pending while it is a reviewer without a complete
  // summary, or while it has posted a summary that is not complete yet.
  const trustedReviewers = reviewers.map((reviewer) => reviewer.user.username).filter(isTrustedBot);
  const pendingBotReview =
    [...new Set([...trustedReviewers, ...botSummaries.keys()])].find((username) => botSummaries.get(username) !== true) ??
    null;
  const seen = new Set(seenItemIds);
  const newItems = items.filter((item) => !seen.has(item.id));

  return {
    approvedBy,
    items,
    newItems,
    pendingBotReview,
    seenItemIds: items.map((item) => item.id),
    unknownBots: [...unknownBots],
    unresolvedThreads,
  };
}

function reviewItem(kind, username) {
  return {
    actionable: true,
    author: username,
    body: null,
    canResolve: false,
    createdAt: null,
    discussionId: null,
    file: null,
    id: `${kind}:${username}`,
    kind,
    line: null,
    participants: [username],
  };
}

function snippet(body) {
  const line = body.trim().split("\n")[0];

  return line.length > SNIPPET_LENGTH ? `${line.slice(0, SNIPPET_LENGTH - 1)}…` : line;
}

const CONFLICT_STATUSES = new Set(["conflict", "need_rebase"]);

/**
 * Decides what the babysitter does next. Ready to merge is the handoff to
 * merge-mr and ends the run; so does anything only the user can clear. Review
 * items come before CI work because a review fix makes a new commit, and
 * retrying jobs on the commit it replaces is wasted.
 */
export function assess({ approvalsLeft, maxRetries, mergeRequest, pipeline, retriesUsed, review }) {
  const actions = [];
  const blockers = [...pipeline.blockers];
  const hasNewItems = review.newItems.length > 0;
  const waitingOn = outstanding({ approvalsLeft, mergeRequest, pipeline, review });

  if (mergeRequest.has_conflicts || CONFLICT_STATUSES.has(mergeRequest.detailed_merge_status)) {
    blockers.push(`conflicts with ${mergeRequest.target_branch}; a rebase is a force push, so that is yours`);
  }

  if (mergeRequest.state !== "opened") {
    return verdict(hasNewItems ? ["process_review_items", "stop_mr_closed"] : ["stop_mr_closed"]);
  }

  if (blockers.length > 0) {
    return verdict(hasNewItems ? ["process_review_items", "blocked_on_user"] : ["blocked_on_user"]);
  }

  if (waitingOn.length === 0 && !hasNewItems) {
    return verdict(["ready_to_merge"], true);
  }

  if (hasNewItems) {
    actions.push("process_review_items");
  }

  if (pipeline.failedJobs.length > 0) {
    if (pipeline.terminal && retriesUsed >= maxRetries) {
      actions.push("stop_exhausted_retries");
    } else {
      actions.push("diagnose_ci_failure");

      if (pipeline.terminal && !hasNewItems) {
        actions.push("retry_failed_jobs");
      }
    }
  }

  return verdict(actions.length > 0 ? actions : ["idle"]);

  function verdict(chosen, ready = false) {
    return { actions: chosen, blockers, ready, waitingOn };
  }
}

// A merged-results pipeline runs on a merge commit, not the source head, and
// the REST API keeps the source commit to itself. GitLab attaches a merge
// request pipeline as the MR's head pipeline only when it was built from the
// current diff head, so that source is the proof; a branch pipeline is compared
// by commit.
function isForHead(pipeline, mergeRequest) {
  return pipeline.status !== "none" && (pipeline.source === "merge_request_event" || pipeline.sha === mergeRequest.sha);
}

function outstanding({ approvalsLeft, mergeRequest, pipeline, review }) {
  const waitingOn = [];

  if (!isForHead(pipeline, mergeRequest)) {
    waitingOn.push(`a pipeline for ${mergeRequest.sha}`);
  } else if (pipeline.status === "running") {
    waitingOn.push(`the pipeline (${pipeline.pendingCount} pending)`);
  } else if (pipeline.status === "failed") {
    waitingOn.push(`a green pipeline (${pipeline.failedJobs.length} failed)`);
  }

  if (mergeRequest.draft) {
    waitingOn.push("leaving draft");
  }

  if (approvalsLeft > 0) {
    waitingOn.push(`${approvalsLeft} approval${approvalsLeft === 1 ? "" : "s"}`);
  }

  if (review.unresolvedThreads.length > 0) {
    const count = review.unresolvedThreads.length;
    waitingOn.push(`${count} unresolved thread${count === 1 ? "" : "s"}`);
  }

  if (review.pendingBotReview) {
    waitingOn.push(`${review.pendingBotReview} review`);
  }

  if (waitingOn.length === 0 && mergeRequest.detailed_merge_status !== "mergeable") {
    waitingOn.push(`GitLab merge status ${mergeRequest.detailed_merge_status}`);
  }

  return waitingOn;
}

const ENDING_ACTIONS = new Set(["blocked_on_user", "ready_to_merge", "stop_exhausted_retries", "stop_mr_closed"]);
// Guards against a trigger cycle; real trees are one or two levels deep.
const MAX_PIPELINE_DEPTH = 3;

export function createState() {
  return {
    approvedBy: [],
    lastChangeKey: null,
    lastSnapshotAt: null,
    retriesBySha: {},
    seenItemIds: [],
    version: 1,
  };
}

export function stateFilePath({ host, iid, projectPath }) {
  return join(tmpdir(), "babysit-mr", host, projectPath.replaceAll("/", "__"), `${iid}.json`);
}

function fileStore(path) {
  return {
    load: async () => {
      try {
        return { ...createState(), ...JSON.parse(await readFile(path, "utf8")) };
      } catch (error) {
        if (error.code === "ENOENT") {
          return createState();
        }
        throw error;
      }
    },
    save: async (state) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

/**
 * One poll: reads the MR, walks its pipeline tree, collects review items, and
 * decides. Mutates and returns the state so the caller can persist it. The
 * change key of the last report lives in the state, so `changed` is true only
 * when something moved since any earlier run, not since process start.
 */
export async function collectSnapshot({ backend, iid, now = Date.now, state, trustedBots }) {
  const [me, mergeRequest] = await Promise.all([backend.me(), backend.mergeRequest(iid)]);
  const [approvals, reviewers, discussions, pipelines] = await Promise.all([
    backend.approvals(iid),
    backend.reviewers(iid),
    backend.discussions(iid),
    pipelineTree(backend, mergeRequest.head_pipeline),
  ]);
  const pipeline = summarizePipeline(pipelines);
  const review = collectReviewItems({
    approvals,
    discussions,
    me: me.username,
    previousApprovedBy: state.approvedBy,
    reviewers,
    seenItemIds: state.seenItemIds,
    trustedBots,
  });
  const retriesUsed = state.retriesBySha[mergeRequest.sha] ?? 0;
  const verdict = assess({
    approvalsLeft: approvals.approvals_left,
    maxRetries: MAX_RETRIES,
    mergeRequest,
    pipeline,
    retriesUsed,
    review,
  });
  const people = [mergeRequest.author, ...mergeRequest.assignees].map((user) => user.username.toLowerCase());
  const summarized = {
    assignees: mergeRequest.assignees.map((user) => user.username),
    author: mergeRequest.author.username,
    canPush: people.includes(me.username.toLowerCase()),
    detailedMergeStatus: mergeRequest.detailed_merge_status,
    draft: mergeRequest.draft,
    iid: mergeRequest.iid,
    projectId: mergeRequest.project_id,
    reference: mergeRequest.references.full,
    sha: mergeRequest.sha,
    sourceBranch: mergeRequest.source_branch,
    state: mergeRequest.state,
    targetBranch: mergeRequest.target_branch,
    title: mergeRequest.title,
    webUrl: mergeRequest.web_url,
  };

  const snapshot = {
    ...verdict,
    me: me.username,
    mergeRequest: summarized,
    pipeline,
    retries: { max: MAX_RETRIES, used: retriesUsed },
    review: {
      approvalsLeft: approvals.approvals_left,
      approvedBy: review.approvedBy,
      newItems: review.newItems,
      pendingBotReview: review.pendingBotReview,
      unknownBots: review.unknownBots,
      unresolvedThreads: review.unresolvedThreads,
    },
  };
  const key = changeKey(snapshot);
  snapshot.changed = key !== state.lastChangeKey;
  snapshot.summary = summarize(snapshot);

  state.lastSnapshotAt = now();
  state.lastChangeKey = key;
  state.seenItemIds = review.seenItemIds;
  state.approvedBy = review.approvedBy;

  return { snapshot, state };
}

async function pipelineTree(backend, head, depth = 0) {
  if (!head || depth > MAX_PIPELINE_DEPTH) {
    return [];
  }

  const [jobs, bridges] = await Promise.all([
    backend.pipelineJobs(head.project_id, head.id),
    backend.pipelineBridges(head.project_id, head.id),
  ]);
  // A bridge that never produced a downstream pipeline is the failure itself.
  const orphanBridges = bridges.filter((bridge) => !bridge.downstream_pipeline);
  const children = await Promise.all(
    bridges
      .filter((bridge) => bridge.downstream_pipeline)
      .map((bridge) => pipelineTree(backend, bridge.downstream_pipeline, depth + 1)),
  );

  return [{ jobs: [...jobs, ...orphanBridges], pipeline: head }, ...children.flat()];
}

function summarize(snapshot) {
  const parts = [`${snapshot.mergeRequest.reference} ${snapshot.mergeRequest.sha}`, `pipeline ${snapshot.pipeline.status}`];

  if (snapshot.review.newItems.length > 0) {
    parts.push(`${snapshot.review.newItems.length} new review item${snapshot.review.newItems.length === 1 ? "" : "s"}`);
  }

  if (snapshot.ready) {
    parts.push("ready to merge");
  } else if (snapshot.blockers.length > 0) {
    parts.push(`blocked: ${snapshot.blockers.join("; ")}`);
  } else if (snapshot.waitingOn.length > 0) {
    parts.push(`waiting on ${snapshot.waitingOn.join(", ")}`);
  }

  return parts.join(" · ");
}

/**
 * The script's one write. Retries every failed job of the current commit once
 * and counts it against that commit's budget, so a flaky rerun never becomes
 * an endless one.
 */
export async function retryFailedJobs({ backend, snapshot, state }) {
  const refusal = retryRefusal(snapshot);

  if (refusal) {
    return { reason: refusal, retriedJobIds: [] };
  }

  for (const job of snapshot.pipeline.failedJobs) {
    await backend.retryJob(job.projectId, job.id);
  }

  state.retriesBySha[snapshot.mergeRequest.sha] = snapshot.retries.used + 1;

  return { reason: "retried", retriedJobIds: snapshot.pipeline.failedJobs.map((job) => job.id) };
}

function retryRefusal(snapshot) {
  if (snapshot.mergeRequest.state !== "opened") {
    return "MR is no longer open";
  }

  if (snapshot.blockers.length > 0) {
    return "blocked on the user";
  }

  if (snapshot.pipeline.failedJobs.length === 0) {
    return "no failed jobs";
  }

  if (!snapshot.pipeline.terminal) {
    return "pipeline still running";
  }

  if (snapshot.retries.used >= snapshot.retries.max) {
    return "retry budget exhausted";
  }

  return null;
}

function changeKey(snapshot) {
  return JSON.stringify([
    snapshot.mergeRequest.sha,
    snapshot.mergeRequest.state,
    snapshot.mergeRequest.detailedMergeStatus,
    snapshot.pipeline.status,
    snapshot.pipeline.pendingCount,
    snapshot.pipeline.failedJobs.map((job) => job.id),
    snapshot.review.unresolvedThreads.map((item) => item.id),
    snapshot.review.pendingBotReview,
    snapshot.waitingOn,
    snapshot.actions,
  ]);
}

/**
 * Polls through idle snapshots and returns as soon as the agent has something
 * to do, because an agent holding a foreground process cannot act until it
 * exits. It reloads the state every poll so a retry run in between is not
 * overwritten. Exit codes: 0 the run ended, 2 timed out, 3 an action is
 * waiting for the agent.
 */
export async function runWatch({ backend, emit, iid, now = Date.now, options, sleep, store }) {
  const startedAt = now();

  for (;;) {
    const state = await store.load();
    const { snapshot } = await collectSnapshot({ backend, iid, now, state });
    await store.save(state);
    emit({ event: "snapshot", nextPollSeconds: options.interval, snapshot });

    const action = snapshot.actions.find((candidate) => candidate !== "idle");

    if (action) {
      emit({ event: "stop", reason: action });
      return ENDING_ACTIONS.has(action) ? 0 : 3;
    }

    if ((now() - startedAt) / 1000 >= options.timeout) {
      emit({ event: "stop", reason: "timeout", waitingOn: snapshot.waitingOn });
      return 2;
    }

    await sleep(options.interval);
  }
}

const PAGE_SIZE = 100;

/**
 * GitLab through `glab api`. It has no repo flag, so a project other than the
 * current directory's is named by its URL-encoded path in the endpoint, with
 * `--hostname` when the MR URL named another host. Lists are paged by hand
 * because `--paginate` prints one JSON document per page.
 */
export function createGlabBackend({ host, projectPath } = {}) {
  const hostFlags = host ? ["--hostname", host] : [];
  const project = projectPath ? encodeURIComponent(projectPath) : ":id";
  const mergeRequests = (iid) => `projects/${project}/merge_requests/${iid}`;
  let me;

  function api(endpoint, extra = []) {
    const output = glab(["api", endpoint, ...hostFlags, ...extra]);

    return output.trim() === "" ? null : JSON.parse(output);
  }

  async function list(endpoint) {
    const results = [];

    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const batch = api(`${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`) ?? [];
      results.push(...batch);

      if (batch.length < PAGE_SIZE) {
        return results;
      }
    }
  }

  return {
    approvals: async (iid) => api(`${mergeRequests(iid)}/approvals`),
    currentBranchMergeRequestIid: async () => {
      try {
        return JSON.parse(glab(["mr", "view", "--output", "json"])).iid;
      } catch {
        throw new Error("No open merge request for the current branch. Pass the MR iid or URL.");
      }
    },
    discussions: async (iid) => list(`${mergeRequests(iid)}/discussions`),
    me: async () => (me ??= api("user")),
    mergeRequest: async (iid) => api(mergeRequests(iid)),
    pipelineBridges: async (projectId, pipelineId) => list(`projects/${projectId}/pipelines/${pipelineId}/bridges`),
    pipelineJobs: async (projectId, pipelineId) => list(`projects/${projectId}/pipelines/${pipelineId}/jobs`),
    retryJob: async (projectId, jobId) => api(`projects/${projectId}/jobs/${jobId}/retry`, ["-X", "POST"]),
    reviewers: async (iid) => list(`${mergeRequests(iid)}/reviewers`),
  };
}

function glab(args) {
  try {
    return execFileSync("glab", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error.stderr ?? "").trim() || error.message;
    throw new Error(`glab ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
}

function println(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const reference = parseMergeRequestReference(options.reference);
  const backend = createGlabBackend(reference ?? {});
  const iid = reference?.iid ?? (await backend.currentBranchMergeRequestIid());
  // The state file is keyed by where the MR lives, which only the MR itself
  // knows when the argument was a bare iid.
  const statePath = stateFilePath(parseMergeRequestReference((await backend.mergeRequest(iid)).web_url));
  const store = fileStore(statePath);

  if (options.mode === "watch") {
    process.exitCode = await runWatch({
      backend,
      emit: println,
      iid,
      options,
      sleep: (seconds) => sleepFor(seconds * 1000),
      store,
    });
    return;
  }

  const state = await store.load();
  const { snapshot } = await collectSnapshot({ backend, iid, state });
  const retry = options.mode === "retryFailedNow" ? await retryFailedJobs({ backend, snapshot, state }) : undefined;
  await store.save(state);
  println({ ...snapshot, retry, stateFile: statePath });
}

// The installed skill is a symlink into this repository and Node loads modules
// by their real path, so the invoked path is resolved the same way before it is
// compared with import.meta.url. Otherwise main never runs through the link.
function isEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await main();
  } catch (error) {
    console.error(`babysit: ${error.message}`);
    process.exitCode = 1;
  }
}
