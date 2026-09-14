import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  extractProposedMessage,
  parseArguments,
  parseMergeRequestReference,
  renderCommitMessages,
} from "./squash-merge.mjs";

const execFileAsync = promisify(execFile);

const mergeRequest = {
  references: { full: "grp/proj!7" },
  source_branch: "feat",
  target_branch: "master",
  title: "TW-1: do the thing",
  web_url: "https://gitlab.example.com/grp/proj/-/merge_requests/7",
};

const proposed = "TW-1: do the thing properly\n\nBody line.\n\nCompound-Decision: x";

// The web repo's project templates, CRLF and all, as the API returns them.
const webProject = {
  merge_commit_template:
    "[%{target_branch}] %{issues} %{title} Merge from '%{source_branch}'\r\n\r\n%{title}\r\n\r\n%{issues}\r\n\r\nSee merge request %{reference}",
  merge_method: "merge",
  squash_commit_template:
    "[%{target_branch}] %{issues} %{title} Squash merge from '%{source_branch}'\r\n\r\n%{title}\r\n\r\n%{issues}\r\n\r\nSee merge request %{reference}",
};

function renderedBody(header) {
  return [
    header,
    "",
    "TW-1: do the thing properly",
    "",
    "Body line.",
    "",
    "Compound-Decision: x",
    "",
    "See merge request grp/proj!7",
    "",
  ].join("\n");
}

test("parseMergeRequestReference reads a bare iid", () => {
  assert.equal(parseMergeRequestReference("26373"), 26373);
});

test("parseMergeRequestReference reads a !iid short reference", () => {
  assert.equal(parseMergeRequestReference("!26373"), 26373);
});

test("parseMergeRequestReference reads the iid out of an MR URL", () => {
  assert.equal(
    parseMergeRequestReference("https://gitlab.example.com/grp/proj/-/merge_requests/26404"),
    26404,
  );
});

test("parseMergeRequestReference returns null when nothing was passed", () => {
  assert.equal(parseMergeRequestReference(undefined), null);
  assert.equal(parseMergeRequestReference(""), null);
});

test("parseMergeRequestReference rejects text that is not a merge request", () => {
  assert.throws(() => parseMergeRequestReference("feature-branch"), /Cannot read a merge request/);
});

test("parseArguments separates the reference from the flags", () => {
  assert.deepEqual(parseArguments(["26373", "--dry-run", "--repo", "grp/proj"]), {
    dryRun: true,
    reference: "26373",
    repo: "grp/proj",
  });
});

test("parseArguments rejects unknown flags and a second reference", () => {
  assert.throws(() => parseArguments(["--force"]), /Unknown argument/);
  assert.throws(() => parseArguments(["1", "2"]), /one merge request/);
  assert.throws(() => parseArguments(["--repo"]), /--repo needs/);
});

test("extractProposedMessage takes the fenced block between the markers", () => {
  const description = [
    "## Summary",
    "",
    "Words for reviewers.",
    "",
    "<details>",
    "<summary>Proposed squash commit message (not for review)</summary>",
    "",
    "<!-- squash-message -->",
    "```",
    proposed,
    "```",
    "<!-- /squash-message -->",
    "",
    "</details>",
  ].join("\n");

  assert.equal(extractProposedMessage(description), proposed);
});

test("extractProposedMessage accepts plain text between the markers", () => {
  const description = `intro\n<!-- squash-message -->\n${proposed}\n<!-- /squash-message -->\noutro`;

  assert.equal(extractProposedMessage(description), proposed);
});

test("extractProposedMessage falls back to the fenced block under the summary line", () => {
  const description = [
    "```ts",
    "const reviewerSnippet = 1;",
    "```",
    "",
    "<details>",
    "<summary>Proposed squash commit message (not for review)</summary>",
    "",
    "```",
    proposed,
    "```",
    "",
    "</details>",
  ].join("\r\n");

  assert.equal(extractProposedMessage(description), proposed);
});

test("extractProposedMessage returns null when the description has no block", () => {
  assert.equal(extractProposedMessage("## Summary\n\nJust a description."), null);
  assert.equal(
    extractProposedMessage("<details>\n<summary>Proposed squash commit message</summary>\n\nno fence\n</details>"),
    null,
  );
  assert.equal(extractProposedMessage("<!-- squash-message -->\n\n<!-- /squash-message -->"), null);
});

test("renderCommitMessages swaps the squash template body for the proposed message", () => {
  const { blankedTokens, squashMessage } = renderCommitMessages({
    mergeRequest,
    project: webProject,
    proposed,
  });

  assert.equal(squashMessage, renderedBody("[master]  TW-1: do the thing Squash merge from 'feat'"));
  assert.deepEqual(blankedTokens, []);
});

test("renderCommitMessages puts the same body on the merge commit", () => {
  const { mergeMessage } = renderCommitMessages({
    mergeRequest,
    project: webProject,
    proposed,
  });

  assert.equal(mergeMessage, renderedBody("[master]  TW-1: do the thing Merge from 'feat'"));
});

test("renderCommitMessages writes no merge message for a fast-forward project", () => {
  const { mergeMessage, squashMessage } = renderCommitMessages({
    mergeRequest,
    project: { ...webProject, merge_method: "ff" },
    proposed,
  });

  assert.equal(mergeMessage, null);
  assert.equal(squashMessage, renderedBody("[master]  TW-1: do the thing Squash merge from 'feat'"));
});

test("renderCommitMessages uses the proposed message alone when the project has no templates", () => {
  const empty = renderCommitMessages({
    mergeRequest,
    project: { merge_commit_template: "", merge_method: "merge", squash_commit_template: "" },
    proposed,
  });

  assert.equal(empty.squashMessage, `${proposed}\n`);
  assert.equal(empty.mergeMessage, `${proposed}\n`);

  const missing = renderCommitMessages({
    mergeRequest,
    project: { merge_commit_template: null, merge_method: "merge", squash_commit_template: null },
    proposed,
  });

  assert.equal(missing.squashMessage, `${proposed}\n`);
  assert.equal(missing.mergeMessage, `${proposed}\n`);
});

test("renderCommitMessages inserts the proposed message after a header-only template", () => {
  const { mergeMessage, squashMessage } = renderCommitMessages({
    mergeRequest,
    project: {
      merge_commit_template: "%{title} merged (%{reference})",
      merge_method: "merge",
      squash_commit_template: "%{title} (%{reference})",
    },
    proposed,
  });

  assert.equal(squashMessage, `TW-1: do the thing (grp/proj!7)\n\n${proposed}\n`);
  assert.equal(mergeMessage, `TW-1: do the thing merged (grp/proj!7)\n\n${proposed}\n`);
});

test("renderCommitMessages reports the tokens it blanked across both templates", () => {
  const { blankedTokens, mergeMessage, squashMessage } = renderCommitMessages({
    mergeRequest,
    project: {
      merge_commit_template: "%{title}\n\n%{title}\n\nReviewed by %{reviewers} at %{url}",
      merge_method: "merge",
      squash_commit_template: "%{title}\n\n%{title}\n\nApproved by %{approved_by} at %{url}",
    },
    proposed,
  });

  assert.equal(
    squashMessage,
    `TW-1: do the thing\n\n${proposed}\n\nApproved by  at ${mergeRequest.web_url}\n`,
  );
  assert.equal(
    mergeMessage,
    `TW-1: do the thing\n\n${proposed}\n\nReviewed by  at ${mergeRequest.web_url}\n`,
  );
  assert.deepEqual(blankedTokens, ["approved_by", "reviewers"]);
});

test("the script runs when invoked through a symlink, as the installed skill does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "merge-mr-"));
  const link = join(directory, "squash-merge.mjs");
  await symlink(fileURLToPath(new URL("./squash-merge.mjs", import.meta.url)), link);

  const result = await execFileAsync("node", [link, "feature-branch", "--dry-run"]).catch(
    (error) => error,
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot read a merge request/);
});
