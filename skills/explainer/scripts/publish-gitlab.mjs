#!/usr/bin/env node

// Uploads a rendered explainer PNG to a GitLab project and prints the Markdown
// that embeds it in a merge request description. Node's own fetch does the
// multipart POST: glab below 1.91 JSON-encodes `-F file=@…` and answers 400,
// and curl would be one more thing to depend on.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseArguments(argv) {
  const options = { host: undefined, png: undefined, project: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--host" || argument === "--project") {
      const value = argv[index + 1];
      index += 1;

      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} needs a value`);
      }
      options[argument.slice(2)] = value;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (options.png !== undefined) {
      throw new Error(`Publish one PNG at a time; got both ${options.png} and ${argument}`);
    }

    options.png = argument;
  }

  if (options.png === undefined) {
    throw new Error("Usage: publish-gitlab.mjs <page.png> [--project <group/repo>] [--host <gitlab host>]");
  }

  options.png = resolve(options.png);
  return options;
}

/**
 * Every remote shape git accepts becomes a host and a project path: the
 * scp-like `git@host:group/repo.git` is rewritten to an ssh URL first, every
 * other form already parses as a URL. Credentials and ports in the URL are
 * ignored; the API is reached over https on the bare hostname.
 */
export function parseRemote(url) {
  const trimmed = url.trim();
  const scpLike = trimmed.match(/^([^@/:]+@)?([^:/]+):(?!\/\/)(.+)$/);
  const normalized = scpLike ? `ssh://${scpLike[1] ?? ""}${scpLike[2]}/${scpLike[3]}` : trimmed;
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Cannot read a GitLab project from remote "${url}"`);
  }

  const projectPath = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");

  if (!parsed.hostname || !projectPath.includes("/")) {
    throw new Error(`Cannot read a GitLab project from remote "${url}"`);
  }

  return { host: parsed.hostname, projectPath };
}

export async function originRemote(cwd, exec = execFileAsync) {
  const { stdout } = await exec("git", ["-C", cwd, "remote", "get-url", "origin"]);
  return stdout.trim();
}

export function uploadsUrl({ apiBase, projectPath }) {
  return `${apiBase}/api/v4/projects/${encodeURIComponent(projectPath)}/uploads`;
}

export async function upload({ apiBase, fetch: fetchFn = fetch, png, projectPath, token }) {
  const body = new FormData();
  // The third argument becomes filename= on the part; without it GitLab names the upload "blob".
  body.append("file", new Blob([await readFile(png)], { type: "image/png" }), basename(png));
  const url = uploadsUrl({ apiBase, projectPath });
  const response = await fetchFn(url, { body, headers: { "PRIVATE-TOKEN": token }, method: "POST" });

  if (!response.ok) {
    throw new Error(`GitLab answered ${response.status} ${response.statusText} for POST ${url}`);
  }

  const { full_path: fullPath, markdown } = await response.json();
  return { markdown, url: `${apiBase}${fullPath}` };
}

export async function publish({ cwd = process.cwd(), env = process.env, exec, fetch: fetchFn, host, png, project }) {
  const token = env.GITLAB_TOKEN;

  if (!token) {
    throw new Error("GITLAB_TOKEN is not set; export a token with api scope in this shell");
  }

  const remote = host && project ? undefined : parseRemote(await originRemote(cwd, exec));
  const target = {
    host: host ?? env.GITLAB_HOST ?? remote.host,
    projectPath: project ?? remote.projectPath,
  };
  const uploaded = await upload({
    apiBase: `https://${target.host}`,
    fetch: fetchFn,
    png,
    projectPath: target.projectPath,
    token,
  });

  return { ...target, ...uploaded };
}

/**
 * Publish adapter contract. One file per host, `scripts/publish-<host>.mjs`.
 * It takes the PNG path as its only positional argument, reads credentials
 * from the environment and nowhere else, works out the target project from
 * the repository it runs in unless told otherwise, and prints the snippet to
 * paste into that host's description on stdout, with everything else on
 * stderr. The skill calls the adapter that matches the target repo's host;
 * this is the only one so far.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await publish(options);

  console.error(`Uploaded ${basename(options.png)} to ${result.host}/${result.projectPath}: ${result.url}`);
  console.log(result.markdown);
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
    console.error(`publish-gitlab: ${error.message}`);
    process.exitCode = 1;
  }
}
