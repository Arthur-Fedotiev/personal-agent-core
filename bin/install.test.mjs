import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseArguments } from "./agent-core";
import { createFixture, initGitRepo, writeSkill } from "./fixture.mjs";
import { runInstall } from "./install.mjs";
import { runRestore } from "./restore.mjs";

const execFileAsync = promisify(execFile);

function install(fixture, overrides = {}) {
  return runInstall({
    env: {},
    home: fixture.home,
    overlayRoot: fixture.overlayRoot,
    hostSkillRoots: [],
    root: fixture.root,
    ...overrides,
  });
}

test("parseArguments accepts install and restore", () => {
  assert.deepEqual(parseArguments(["install", "--home", "/tmp/fake-home"]), {
    command: "install",
    home: "/tmp/fake-home",
  });
  assert.deepEqual(parseArguments(["restore", "--overlay", "/tmp/web"]), {
    command: "restore",
    overlayRoot: "/tmp/web",
  });
});

test("install writes home links and snapshot without touching the overlay", async () => {
  const fixture = await createFixture();
  const overlayMarker = join(fixture.overlayRoot, "DO_NOT_TOUCH");
  await writeFile(overlayMarker, "planted\n");
  await writeSkill(join(fixture.home, ".claude", "skills"), {
    name: "loop-me",
    description: "Extra.",
  });
  await mkdir(join(fixture.home, ".cursor", "rules"), { recursive: true });
  await writeFile(
    join(fixture.home, ".cursor", "rules", "personal-core.mdc"),
    "old cursor guidance\n",
  );

  const result = await install(fixture, { gitSha: "deadbeef" });

  assert.equal(result.ok, true);
  assert.equal(
    await readlink(join(fixture.home, ".cursor/rules/personal-core.mdc")),
    join(fixture.root, "generated/cursor/personal-core.mdc"),
  );
  assert.equal(
    await readlink(join(fixture.home, ".claude/CLAUDE.md")),
    join(fixture.root, "generated/claude/CLAUDE.md"),
  );
  assert.equal(
    await readlink(join(fixture.home, ".claude/skills/alpha")),
    join(fixture.root, "skills/alpha"),
  );
  assert.equal(
    await readlink(join(fixture.home, ".codex/AGENTS.md")),
    join(fixture.root, "generated/codex/AGENTS.md"),
  );
  assert.equal(
    await readlink(join(fixture.home, ".agents/skills/alpha")),
    join(fixture.root, "skills/alpha"),
  );
  assert.equal(
    await readFile(join(fixture.home, ".claude/skills/loop-me/SKILL.md"), "utf8"),
    "---\nname: loop-me\ndescription: Extra.\n---\n",
  );
  assert.equal(await readFile(overlayMarker, "utf8"), "planted\n");

  const snapshot = JSON.parse(
    await readFile(
      join(fixture.home, ".config/agent-core/previous/snapshot.json"),
      "utf8",
    ),
  );
  assert.equal(snapshot.sha, "deadbeef");
  const cursorEntry = snapshot.entries.find((entry) =>
    entry.to.endsWith(".cursor/rules/personal-core.mdc"),
  );
  assert.equal(cursorEntry.kind, "file");
  assert.equal(
    await readFile(
      join(fixture.home, ".config/agent-core/previous", cursorEntry.relative),
      "utf8",
    ),
    "old cursor guidance\n",
  );

  const installed = JSON.parse(
    await readFile(
      join(fixture.home, ".config/agent-core/installed.json"),
      "utf8",
    ),
  );
  assert.equal(installed.sha, "deadbeef");
  assert.ok(
    installed.destinations.includes(
      join(fixture.home, ".cursor/rules/personal-core.mdc"),
    ),
  );

  assert.ok((await lstat(join(fixture.home, ".claude/skills/alpha"))).isSymbolicLink());
});

test("a second install keeps the pre-cutover snapshot", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.home, ".cursor", "rules"), { recursive: true });
  await writeFile(
    join(fixture.home, ".cursor", "rules", "personal-core.mdc"),
    "old cursor guidance\n",
  );

  for (const sha of ["deadbeef", "cafef00d"]) {
    assert.equal((await install(fixture, { gitSha: sha })).ok, true);
  }

  const snapshot = JSON.parse(
    await readFile(
      join(fixture.home, ".config/agent-core/previous/snapshot.json"),
      "utf8",
    ),
  );
  const cursorEntry = snapshot.entries.find((entry) =>
    entry.to.endsWith(".cursor/rules/personal-core.mdc"),
  );

  assert.equal(snapshot.sha, "deadbeef");
  assert.equal(cursorEntry.kind, "file");
  assert.equal(
    await readFile(
      join(fixture.home, ".config/agent-core/previous", cursorEntry.relative),
      "utf8",
    ),
    "old cursor guidance\n",
  );
});

test("install snapshots and removes a shadowing Cursor copy that restore returns", async () => {
  const fixture = await createFixture();
  await initGitRepo(fixture.root);
  const shadow = join(fixture.home, ".cursor", "skills", "alpha");
  const extra = join(fixture.home, ".cursor", "skills", "loop-me");
  await writeSkill(join(fixture.home, ".cursor", "skills"), {
    name: "alpha",
    description: "Stale Cursor copy.",
  });
  await writeSkill(join(fixture.home, ".cursor", "skills"), {
    name: "loop-me",
    description: "Laptop extra.",
  });

  assert.equal((await install(fixture)).ok, true);

  await assert.rejects(lstat(shadow), { code: "ENOENT" });
  assert.equal(
    await readFile(join(extra, "SKILL.md"), "utf8"),
    "---\nname: loop-me\ndescription: Laptop extra.\n---\n",
  );

  assert.equal((await runRestore({ home: fixture.home, root: fixture.root })).ok, true);
  assert.equal(
    await readFile(join(shadow, "SKILL.md"), "utf8"),
    "---\nname: alpha\ndescription: Stale Cursor copy.\n---\n",
  );
});

test("install refuses a Cloud Agent", async () => {
  const fixture = await createFixture();

  const result = await install(fixture, {
    env: { CURSOR_CLOUD_AGENT: "1" },
    gitSha: "deadbeef",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Cloud Agent/);
  await assert.rejects(
    readFile(join(fixture.home, ".config/agent-core/installed.json")),
    { code: "ENOENT" },
  );
});

test("install refuses a planted skill-name collision", async () => {
  const fixture = await createFixture({ extraSkills: [{ name: "review" }] });

  const result = await install(fixture, { gitSha: "deadbeef" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /collision with overlay: review/);
  await assert.rejects(
    lstat(join(fixture.home, ".claude/skills/review")),
    { code: "ENOENT" },
  );
});

test("restore returns previous home files and pins the clone SHA", async () => {
  const fixture = await createFixture();
  await initGitRepo(fixture.root);
  const { stdout: sha } = await execFileAsync("git", [
    "-C",
    fixture.root,
    "rev-parse",
    "HEAD",
  ]);
  await mkdir(join(fixture.home, ".cursor", "rules"), { recursive: true });
  await mkdir(join(fixture.home, ".claude"), { recursive: true });
  await writeFile(
    join(fixture.home, ".cursor", "rules", "personal-core.mdc"),
    "old cursor guidance\n",
  );
  await writeFile(join(fixture.home, ".claude", "CLAUDE.md"), "old claude\n");

  assert.equal((await install(fixture)).ok, true);

  await writeFile(join(fixture.root, "guidance/AGENTS.personal.md"), "# later\n");
  await execFileAsync("git", [
    "-C",
    fixture.root,
    "add",
    "guidance/AGENTS.personal.md",
  ]);
  await execFileAsync("git", ["-C", fixture.root, "commit", "-m", "later"]);

  const restored = await runRestore({
    home: fixture.home,
    root: fixture.root,
  });
  assert.equal(restored.ok, true);
  assert.equal(
    await readFile(
      join(fixture.home, ".cursor/rules/personal-core.mdc"),
      "utf8",
    ),
    "old cursor guidance\n",
  );
  assert.equal(
    await readFile(join(fixture.home, ".claude/CLAUDE.md"), "utf8"),
    "old claude\n",
  );
  await assert.rejects(lstat(join(fixture.home, ".claude/skills/alpha")), {
    code: "ENOENT",
  });
  await assert.rejects(lstat(join(fixture.home, ".agents/skills/alpha")), {
    code: "ENOENT",
  });
  const { stdout: restoredSha } = await execFileAsync("git", [
    "-C",
    fixture.root,
    "rev-parse",
    "HEAD",
  ]);
  assert.equal(restoredSha.trim(), sha.trim());
});

test("restore does not revert overlay git", async () => {
  const fixture = await createFixture();
  await initGitRepo(fixture.root);
  await initGitRepo(fixture.overlayRoot);
  const { stdout: overlaySha } = await execFileAsync("git", [
    "-C",
    fixture.overlayRoot,
    "rev-parse",
    "HEAD",
  ]);
  await mkdir(join(fixture.home, ".claude"), { recursive: true });
  await writeFile(join(fixture.home, ".claude", "CLAUDE.md"), "old claude\n");

  assert.equal((await install(fixture)).ok, true);
  await writeFile(
    join(fixture.overlayRoot, ".claude", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: later overlay.\n---\n",
  );
  await execFileAsync("git", [
    "-C",
    fixture.overlayRoot,
    "add",
    ".claude/skills/review/SKILL.md",
  ]);
  await execFileAsync("git", ["-C", fixture.overlayRoot, "commit", "-m", "later overlay"]);

  assert.equal((await runRestore({ home: fixture.home, root: fixture.root })).ok, true);

  const { stdout: overlayAfter } = await execFileAsync("git", [
    "-C",
    fixture.overlayRoot,
    "rev-parse",
    "HEAD",
  ]);
  assert.notEqual(overlayAfter.trim(), overlaySha.trim());
});

test("install removes links an earlier install left in a retired skills home", async () => {
  const fixture = await createFixture();
  await initGitRepo(fixture.root);
  const retiredManifest = structuredClone(fixture.manifest);
  retiredManifest.clients.codex.skillsHome = "~/.codex/skills";
  await writeFile(
    join(fixture.root, "manifest.json"),
    `${JSON.stringify(retiredManifest, null, 2)}\n`,
  );
  assert.equal((await install(fixture)).ok, true);
  assert.ok((await lstat(join(fixture.home, ".codex/skills/alpha"))).isSymbolicLink());

  await writeFile(
    join(fixture.root, "manifest.json"),
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );
  assert.equal((await install(fixture)).ok, true);

  await assert.rejects(lstat(join(fixture.home, ".codex/skills/alpha")), {
    code: "ENOENT",
  });
  assert.ok((await lstat(join(fixture.home, ".agents/skills/alpha"))).isSymbolicLink());
  const installed = JSON.parse(
    await readFile(join(fixture.home, ".config/agent-core/installed.json"), "utf8"),
  );
  assert.ok(!installed.destinations.includes(join(fixture.home, ".codex/skills/alpha")));

  assert.equal((await runRestore({ home: fixture.home, root: fixture.root })).ok, true);
  await assert.rejects(lstat(join(fixture.home, ".codex/skills/alpha")), {
    code: "ENOENT",
  });
  await assert.rejects(lstat(join(fixture.home, ".agents/skills/alpha")), {
    code: "ENOENT",
  });
});
