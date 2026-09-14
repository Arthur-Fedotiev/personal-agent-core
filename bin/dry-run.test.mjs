import assert from "node:assert/strict";
import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { formatReport, resolveOverlayRoot, runDryRun } from "./dry-run.mjs";
import { createFixture, writeSkill } from "./fixture.mjs";

const codexPolicy = (allowImplicitInvocation) =>
  `policy:\n  allow_implicit_invocation: ${allowImplicitInvocation}\n`;

function dryRun(fixture, overrides = {}) {
  return runDryRun({
    env: {},
    gitSha: "abc123",
    home: fixture.home,
    overlayRoot: fixture.overlayRoot,
    hostSkillRoots: [],
    root: fixture.root,
    ...overrides,
  });
}

test("refuses to run in a Cloud Agent", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture, { env: { CURSOR_CLOUD_AGENT: "1" } });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Cloud Agent/);
});

test("does not treat a local Cursor agent as a Cloud Agent", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture, { env: { CURSOR_AGENT: "1" } });

  assert.equal(result.ok, true);
});

test("fails when a generated adapter was hand-edited", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, "generated/cursor/personal-core.mdc"),
    "hand edit\n",
  );

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /generated\/cursor\/personal-core\.mdc/);
});

test("fails when a core skill name collides with a nested overlay skill", async () => {
  const fixture = await createFixture();
  await writeSkill(join(fixture.overlayRoot, ".claude", "skills", "group"), {
    name: "alpha",
    description: "Nested overlay alpha.",
  });
  await mkdir(join(fixture.overlayRoot, ".claude", "skills", "docs-only"), {
    recursive: true,
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /collision with overlay: alpha/);
});

test("fails when a core skill name collides with the overlay", async () => {
  const fixture = await createFixture({ extraSkills: [{ name: "review" }] });

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /collision with overlay: review/);
});

test("fails when a core skill name collides with an installed plugin", async () => {
  const fixture = await createFixture();
  const pluginSkills = join(fixture.home, "plugin-skills");
  await writeSkill(pluginSkills, { name: "alpha", description: "Plugin alpha." });

  const result = await dryRun(fixture, {
    hostSkillRoots: [{ origin: "installed plugin", root: pluginSkills }],
  });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /collision with installed plugin: alpha/,
  );
});

test("reports proposed home links without writing them", async () => {
  const fixture = await createFixture();
  const before = await readdir(fixture.home);

  const result = await dryRun(fixture, { gitSha: "deadbeef" });

  assert.equal(result.ok, true);
  assert.deepEqual(await readdir(fixture.home), before);
  assert.ok(
    result.proposed.some(
      (write) => write.to === join(fixture.home, ".cursor/rules/personal-core.mdc"),
    ),
  );
  assert.ok(
    result.proposed.some(
      (write) => write.to === join(fixture.home, ".claude/CLAUDE.md"),
    ),
  );
  assert.ok(
    result.proposed.some(
      (write) => write.to === join(fixture.home, ".claude/skills/alpha"),
    ),
  );
  assert.ok(
    result.proposed.some((write) =>
      write.to.endsWith(".config/agent-core/previous/snapshot.json"),
    ),
  );
});

test("proposes Codex guidance and a link in the Codex skills home", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
  assert.ok(
    result.proposed.some(
      (write) => write.to === join(fixture.home, ".codex/AGENTS.md"),
    ),
  );
  assert.ok(
    result.proposed.some(
      (write) => write.to === join(fixture.home, ".agents/skills/alpha"),
    ),
  );
});

test("proposes one link per skills home, not one per client", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture);

  const claudeLinks = result.proposed.filter(
    (write) => write.to === join(fixture.home, ".claude/skills/alpha"),
  );

  assert.equal(claudeLinks.length, 1);
});

test("fails when a user-invoked skill leaves Codex free to fire it", async () => {
  const fixture = await createFixture({
    extraSkills: [
      { name: "beta", frontmatter: "disable-model-invocation: true\n" },
    ],
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /User-invoked skill needs policy\.allow_implicit_invocation: false in agents\/openai\.yaml: beta/,
  );
});

test("accepts a user-invoked skill that also tells Codex not to fire it", async () => {
  const fixture = await createFixture({
    extraSkills: [
      {
        name: "beta",
        frontmatter: "disable-model-invocation: true\n",
        openaiYaml: codexPolicy(false),
      },
    ],
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
});

test("fails when a model-invoked skill is hidden from Codex only", async () => {
  const fixture = await createFixture({
    extraSkills: [{ name: "beta", openaiYaml: codexPolicy(false) }],
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /Model-invoked skill must not set policy\.allow_implicit_invocation: false: beta/,
  );
});

test("reports a core skill shadowed in the Cursor shadow tree", async () => {
  const fixture = await createFixture();
  const shadow = join(fixture.home, ".cursor", "skills", "alpha");
  await writeSkill(join(fixture.home, ".cursor", "skills"), {
    name: "alpha",
    description: "Stale Cursor copy.",
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.shadowed, [shadow]);
  assert.match(formatReport(result), /Shadowing copies to remove:\n- .*\.cursor\/skills\/alpha/);
  assert.deepEqual(await readdir(shadow), ["SKILL.md"]);
});

test("does not report an unrelated skill in the Cursor shadow tree", async () => {
  const fixture = await createFixture();
  await writeSkill(join(fixture.home, ".cursor", "skills"), {
    name: "loop-me",
    description: "Laptop extra.",
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.shadowed, []);
});

test("fails when a core skill name collides with a Codex system skill", async () => {
  const fixture = await createFixture();
  await writeSkill(join(fixture.home, ".codex", "skills", ".system"), {
    name: "alpha",
    description: "Codex bundled alpha.",
  });

  const result = await dryRun(fixture, { hostSkillRoots: undefined });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /collision with Codex system skill: alpha/,
  );
});

test("fails when a core skill name collides with a cached Codex plugin", async () => {
  const fixture = await createFixture();
  await writeSkill(
    join(fixture.home, ".codex", "plugins", "cache", "market", "plugin", "1.0.0", "skills"),
    { name: "alpha", description: "Codex plugin alpha." },
  );

  const result = await dryRun(fixture, { hostSkillRoots: undefined });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /collision with installed plugin: alpha/,
  );
});

test("fails when a Codex short_description falls outside 25-64 characters", async () => {
  const fixture = await createFixture({
    extraSkills: [
      {
        name: "beta",
        openaiYaml: 'interface:\n  short_description: "Too short"\n',
      },
      {
        name: "gamma",
        openaiYaml: `interface:\n  short_description: "${"x".repeat(65)}"\n`,
      },
    ],
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /short_description must be 25-64 characters in agents\/openai\.yaml: beta \(9\)/,
  );
  assert.match(
    result.errors.join("\n"),
    /short_description must be 25-64 characters in agents\/openai\.yaml: gamma \(65\)/,
  );
});

test("accepts a Codex short_description inside 25-64 characters", async () => {
  const fixture = await createFixture({
    extraSkills: [
      {
        name: "beta",
        openaiYaml:
          'interface:\n  display_name: "Beta"\n  short_description: "Twenty-five characters ok"\n',
      },
    ],
  });

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
});

test("reports links an earlier install left in a retired skills home", async () => {
  const fixture = await createFixture();
  const retired = join(fixture.home, ".codex", "skills", "alpha");
  const replaced = join(fixture.home, ".codex", "skills", "beta");
  const foreign = join(fixture.home, ".codex", "skills", "gamma");
  await mkdir(join(fixture.home, ".codex", "skills"), { recursive: true });
  await symlink(join(fixture.root, "skills", "alpha"), retired);
  await writeSkill(join(fixture.home, ".codex", "skills"), { name: "beta" });
  await symlink("/somewhere/else/gamma", foreign);
  await mkdir(join(fixture.home, ".config", "agent-core"), { recursive: true });
  await writeFile(
    join(fixture.home, ".config", "agent-core", "installed.json"),
    `${JSON.stringify({ sha: "old", destinations: [retired, replaced, foreign] })}\n`,
  );

  const result = await dryRun(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.stale, [retired]);
  assert.match(formatReport(result), /Links from an earlier install to remove:\n- .*\.codex\/skills\/alpha/);
  assert.ok((await lstat(retired)).isSymbolicLink());
});

test("reports no stale links when nothing was installed before", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture);

  assert.deepEqual(result.stale, []);
});

test("runs with no overlay when none is given", async () => {
  const fixture = await createFixture();

  const result = await dryRun(fixture, { overlayRoot: undefined });

  assert.equal(result.ok, true);
  assert.match(formatReport(result), /^No overlay\.$/m);
});

test("fails without crashing when the given overlay does not exist", async () => {
  const fixture = await createFixture();
  const missing = join(fixture.home, "missing-web");

  const result = await dryRun(fixture, { overlayRoot: missing });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /Overlay skills not found: .*missing-web\/\.claude\/skills/,
  );
});

test("resolveOverlayRoot takes an explicit path as given", async () => {
  const fixture = await createFixture();
  const missing = join(fixture.home, "missing-web");

  assert.equal(
    await resolveOverlayRoot({ explicit: missing, fallback: fixture.overlayRoot }),
    missing,
  );
});

test("resolveOverlayRoot uses the default sibling only while it carries skills", async () => {
  const fixture = await createFixture();
  const unrelated = join(fixture.home, "web");
  await mkdir(unrelated, { recursive: true });

  assert.equal(
    await resolveOverlayRoot({ fallback: fixture.overlayRoot }),
    fixture.overlayRoot,
  );
  assert.equal(await resolveOverlayRoot({ fallback: unrelated }), undefined);
  assert.equal(
    await resolveOverlayRoot({ fallback: join(fixture.home, "absent") }),
    undefined,
  );
});
