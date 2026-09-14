import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseArguments, parseRemote, publish, upload, uploadsUrl } from "./publish-gitlab.mjs";

const execFileAsync = promisify(execFile);

test("one PNG, optional --project and --host", () => {
  const options = parseArguments(["out/page.png", "--project", "group/repo", "--host", "gitlab.example.com"]);

  assert.match(options.png, /\/out\/page\.png$/);
  assert.equal(options.project, "group/repo");
  assert.equal(options.host, "gitlab.example.com");
  assert.throws(() => parseArguments([]), /Usage/);
  assert.throws(() => parseArguments(["a.png", "b.png"]), /one PNG at a time/);
  assert.throws(() => parseArguments(["a.png", "--host"]), /--host needs a value/);
  assert.throws(() => parseArguments(["a.png", "--form"]), /Unknown argument/);
});

test("every remote shape yields the host and the project path", () => {
  assert.deepEqual(parseRemote("git@gitlab.example.com:group/repo.git"), { host: "gitlab.example.com", projectPath: "group/repo" });
  assert.deepEqual(parseRemote("https://gitlab.example.com/org/ui/web.git"), { host: "gitlab.example.com", projectPath: "org/ui/web" });
  assert.deepEqual(parseRemote("ssh://git@gitlab.example.com:2222/org/ui/web.git"), { host: "gitlab.example.com", projectPath: "org/ui/web" });
  assert.deepEqual(parseRemote("https://oauth2:tok@gitlab.com/group/sub/repo"), { host: "gitlab.com", projectPath: "group/sub/repo" });
  assert.deepEqual(parseRemote("git@gitlab.com:group/sub/repo/\n"), { host: "gitlab.com", projectPath: "group/sub/repo" });
  assert.throws(() => parseRemote("https://gitlab.com/repo"), /Cannot read a GitLab project/);
  assert.throws(() => parseRemote("not a remote"), /Cannot read a GitLab project/);
});

test("the uploads URL encodes the project path", () => {
  assert.equal(
    uploadsUrl({ apiBase: "https://gitlab.example.com", projectPath: "group/sub/repo" }),
    "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Frepo/uploads",
  );
});

// A GitLab as the wire sees it: records the one request and answers like the docs' example.
async function fakeGitLab(status = 201) {
  const seen = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.body = Buffer.concat(chunks).toString("latin1");
      seen.headers = request.headers;
      seen.method = request.method;
      seen.url = request.url;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          alt: "page",
          full_path: "/-/project/1234/uploads/66dbcd21/page.png",
          markdown: "![page](/uploads/66dbcd21/page.png)",
          url: "/uploads/66dbcd21/page.png",
        }),
      );
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
    seen,
  };
}

async function pngInTemp() {
  const directory = await mkdtemp(join(tmpdir(), "explainer-publish-"));
  const png = join(directory, "page.png");
  await writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
  return png;
}

test("upload posts one multipart part named file with the PNG's filename and type", async () => {
  const gitlab = await fakeGitLab();
  const png = await pngInTemp();

  try {
    const result = await upload({ apiBase: gitlab.apiBase, png, projectPath: "group/repo", token: "glpat-test" });

    assert.equal(gitlab.seen.method, "POST");
    assert.equal(gitlab.seen.url, "/api/v4/projects/group%2Frepo/uploads");
    assert.equal(gitlab.seen.headers["private-token"], "glpat-test");
    assert.match(gitlab.seen.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(gitlab.seen.body, /Content-Disposition: form-data; name="file"; filename="page\.png"/);
    assert.match(gitlab.seen.body, /Content-Type: image\/png/);
    assert.equal(result.markdown, "![page](/uploads/66dbcd21/page.png)");
    assert.equal(result.url, `${gitlab.apiBase}/-/project/1234/uploads/66dbcd21/page.png`);
  } finally {
    await gitlab.close();
  }
});

test("a non-2xx answer is an error naming the status", async () => {
  const gitlab = await fakeGitLab(403);
  const png = await pngInTemp();

  try {
    await assert.rejects(
      upload({ apiBase: gitlab.apiBase, png, projectPath: "group/repo", token: "t" }),
      /GitLab answered 403/,
    );
  } finally {
    await gitlab.close();
  }
});

test("publish refuses to run without GITLAB_TOKEN", async () => {
  await assert.rejects(publish({ env: {}, png: "/x/page.png" }), /GITLAB_TOKEN is not set/);
});

test("publish derives host and project from origin; --host, GITLAB_HOST and --project override", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: "git@gitlab.example.com:group/repo.git\n" };
  };
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ init, url });
    return { json: async () => ({ full_path: "/f", markdown: "![x](/u)" }), ok: true };
  };
  const png = await pngInTemp();

  const derived = await publish({ cwd: "/repo", env: { GITLAB_TOKEN: "t" }, exec, fetch: fetchFn, png });
  assert.deepEqual(calls, [["git", "-C", "/repo", "remote", "get-url", "origin"]]);
  assert.equal(derived.host, "gitlab.example.com");
  assert.equal(derived.projectPath, "group/repo");
  assert.equal(seen[0].url, "https://gitlab.example.com/api/v4/projects/group%2Frepo/uploads");
  assert.equal(seen[0].init.headers["PRIVATE-TOKEN"], "t");

  const viaEnv = await publish({ cwd: "/repo", env: { GITLAB_HOST: "gitlab.other.com", GITLAB_TOKEN: "t" }, exec, fetch: fetchFn, png });
  assert.equal(viaEnv.host, "gitlab.other.com");

  const explicit = await publish({ env: { GITLAB_TOKEN: "t" }, exec, fetch: fetchFn, host: "h.example.com", png, project: "a/b" });
  assert.equal(calls.length, 2, "an explicit host and project skip git");
  assert.equal(explicit.url, "https://h.example.com/f");
});

test("the script runs when invoked through a symlink, as the installed skill does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "explainer-"));
  const link = join(directory, "publish-gitlab.mjs");
  await symlink(fileURLToPath(new URL("./publish-gitlab.mjs", import.meta.url)), link);

  const result = await execFileAsync("node", [link]).catch((error) => error);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: publish-gitlab\.mjs/);
});
