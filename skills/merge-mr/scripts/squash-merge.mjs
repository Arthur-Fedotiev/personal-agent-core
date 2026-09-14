#!/usr/bin/env node

// GitLab takes custom commit messages only at merge time, and the project's
// commit templates belong to the whole team. So the personal message format
// (subject, body, Compound-* trailers) rides in the MR description and gets
// applied here, when the merge request is accepted through the API.
//
// A squashed merge into a project that writes merge commits produces two
// commits: the squash commit, and the merge commit that has it as a second
// parent. Only the merge commit sits on the target branch's first-parent path,
// so the same body goes on both and the trailers survive either reading.

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const START_MARKER = /<!--\s*squash-message\s*-->/;
const END_MARKER = /<!--\s*\/squash-message\s*-->/;
const SUMMARY_LINE = /^.*<summary>[^<]*squash commit message.*$/im;
const FENCED_BLOCK = /^[ \t]*```[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/m;
const TEMPLATE_TOKEN = /%\{(\w+)\}/g;

export function parseArguments(argv) {
  const options = { dryRun: false, reference: undefined, repo: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--repo" || argument === "-R") {
      options.repo = argv[index + 1];
      index += 1;

      if (!options.repo) {
        throw new Error("--repo needs OWNER/REPO");
      }
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (options.reference !== undefined) {
      throw new Error(`Merge one merge request at a time; got both ${options.reference} and ${argument}`);
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
    return Number(bare[1]);
  }

  const url = input.match(/\/merge_requests\/(\d+)/);

  if (url) {
    return Number(url[1]);
  }

  throw new Error(
    `Cannot read a merge request from "${input}". Pass an iid such as 26373, !26373, or the MR URL.`,
  );
}

/**
 * The block between the squash-message markers wins. Older descriptions only
 * have the fenced block under a "Proposed squash commit message" summary, so
 * that is the fallback, and there the fence is required because everything
 * after the summary line is otherwise the rest of the details element.
 */
export function extractProposedMessage(description) {
  const text = description.replace(/\r\n/g, "\n");
  const marked = markedRegion(text);

  if (marked !== null) {
    return blockContent(marked, { allowPlain: true });
  }

  const summary = text.match(SUMMARY_LINE);

  if (summary) {
    return blockContent(text.slice(summary.index + summary[0].length), { allowPlain: false });
  }

  return null;
}

function markedRegion(text) {
  const start = text.match(START_MARKER);

  if (!start) {
    return null;
  }

  const afterStart = text.slice(start.index + start[0].length);
  const end = afterStart.match(END_MARKER);

  return end ? afterStart.slice(0, end.index) : afterStart;
}

function blockContent(region, { allowPlain }) {
  const fenced = region.match(FENCED_BLOCK);

  if (!fenced && !allowPlain) {
    return null;
  }

  const content = (fenced ? fenced[1] : region).trim();

  return content === "" ? null : content;
}

/**
 * Renders both of the project's commit templates, so the squash commit and the
 * merge commit carry the same proposed body and trailers.
 *
 * A fast-forward project replays the squash commit onto the target branch
 * without a merge commit, so it gets no merge message.
 */
export function renderCommitMessages({ mergeRequest, project, proposed }) {
  const blankedTokens = new Set();
  const squashMessage = renderTemplate({
    blankedTokens,
    mergeRequest,
    proposed,
    template: project.squash_commit_template,
  });
  const mergeMessage =
    project.merge_method === "ff"
      ? null
      : renderTemplate({
          blankedTokens,
          mergeRequest,
          proposed,
          template: project.merge_commit_template,
        });

  return { blankedTokens: [...blankedTokens].sort(), mergeMessage, squashMessage };
}

/**
 * Renders one template the way GitLab would, then replaces the template's
 * standalone %{title} body line with the proposed message, so the team's
 * header and footer stay and the body is ours.
 *
 * %{issues} is the GitLab issues the MR closes; Jira-tracked projects leave it
 * empty, so it renders empty here too. Tokens that need extra API calls
 * (approvers, reviewers, commits) render empty and are collected for the
 * caller to report.
 */
function renderTemplate({ blankedTokens, mergeRequest, proposed, template }) {
  const body = proposed.trim();
  const lines = (template ?? "").replace(/\r\n/g, "\n").split("\n");

  if (lines.join("").trim() === "") {
    return `${body}\n`;
  }

  const values = {
    issues: "",
    reference: mergeRequest.references.full,
    source_branch: mergeRequest.source_branch,
    target_branch: mergeRequest.target_branch,
    title: mergeRequest.title,
    url: mergeRequest.web_url,
  };
  const bodyIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "%{title}");
  const rendered = lines.map((line, index) =>
    index === bodyIndex
      ? body
      : line.replace(TEMPLATE_TOKEN, (_, token) => {
          if (Object.hasOwn(values, token)) {
            return values[token];
          }
          blankedTokens.add(token);
          return "";
        }),
  );

  if (bodyIndex === -1) {
    rendered.splice(1, 0, "", body);
  }

  const message = rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();

  return `${message}\n`;
}

function glab(args) {
  return execFileSync("glab", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function currentBranchMergeRequestIid(repoFlags) {
  try {
    return JSON.parse(glab(["mr", "view", "--output", "json", ...repoFlags])).iid;
  } catch {
    throw new Error("No open merge request for the current branch. Pass the MR iid or URL.");
  }
}

function printMessage(label, message) {
  console.log(`--- ${label} ---`);
  console.log(message.trimEnd());
  console.log("-".repeat(label.length + 8));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoFlags = options.repo ? ["-R", options.repo] : [];
  const iid = parseMergeRequestReference(options.reference) ?? currentBranchMergeRequestIid(repoFlags);
  const mergeRequest = JSON.parse(glab(["api", `projects/:id/merge_requests/${iid}`, ...repoFlags]));
  const project = JSON.parse(glab(["api", "projects/:id", ...repoFlags]));
  const reference = mergeRequest.references.full;

  console.log(`${reference}  ${mergeRequest.title}`);
  console.log(
    `${mergeRequest.source_branch} -> ${mergeRequest.target_branch}  (state: ${mergeRequest.state}, merge status: ${mergeRequest.detailed_merge_status})`,
  );

  if (project.squash_option === "never") {
    throw new Error(`${project.path_with_namespace} does not allow squashing, so there is no squash commit message to set.`);
  }

  const proposed = extractProposedMessage(mergeRequest.description ?? "");

  if (proposed === null) {
    throw new Error(
      `${reference} has no proposed squash commit message. Add the fenced block between <!-- squash-message --> and <!-- /squash-message --> to the description, then rerun.`,
    );
  }

  const { blankedTokens, mergeMessage, squashMessage } = renderCommitMessages({
    mergeRequest,
    project,
    proposed,
  });

  if (blankedTokens.length > 0) {
    console.log(`Template tokens rendered empty: ${blankedTokens.map((token) => `%{${token}}`).join(", ")}`);
  }

  printMessage("squash commit message", squashMessage);

  if (mergeMessage === null) {
    console.log(`${project.path_with_namespace} merges fast-forward, so it writes no merge commit.`);
  } else {
    printMessage("merge commit message", mergeMessage);
  }

  if (options.dryRun) {
    console.log("Dry run. Nothing merged.");
    return;
  }

  if (mergeRequest.state !== "opened") {
    throw new Error(`${reference} is ${mergeRequest.state}, so there is nothing to merge.`);
  }

  // glab's auto-merge default means a running pipeline queues the merge instead
  // of failing it. Source-branch removal is left to the MR's own setting.
  const merge = spawnSync(
    "glab",
    [
      "mr",
      "merge",
      String(iid),
      "--squash",
      "--squash-message",
      squashMessage.trimEnd(),
      ...(mergeMessage === null ? [] : ["--message", mergeMessage.trimEnd()]),
      "--yes",
      ...repoFlags,
    ],
    { stdio: "inherit" },
  );

  process.exitCode = merge.status ?? 1;
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
    console.error(`squash-merge: ${error.message}`);
    process.exitCode = 1;
  }
}
