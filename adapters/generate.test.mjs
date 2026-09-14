import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readManifest } from "../bin/fixture.mjs";
import { buildGuidance, generateAdapters } from "./generate.mjs";

const guidance = "# Personal guidance\n\nKeep this canonical.\n";

test("wraps guidance in rule frontmatter for the cursor-rule format", () => {
  const cursorRule = buildGuidance({ format: "cursor-rule", guidance });

  assert.match(
    cursorRule,
    /^---\ndescription: Personal agent guidance\nalwaysApply: true\n---/,
  );
  assert.match(cursorRule, /Keep this canonical\./);
});

test("leaves guidance bare for the markdown format", () => {
  const markdown = buildGuidance({ format: "markdown", guidance });

  assert.doesNotMatch(markdown, /^---/);
  assert.match(markdown, /Keep this canonical\./);
});

test("generates no skill catalog in either format", () => {
  for (const format of ["cursor-rule", "markdown"]) {
    const generated = buildGuidance({ format, guidance });

    assert.doesNotMatch(generated, /Personal-core skills/);
    assert.doesNotMatch(generated, /\/alpha/);
  }
});

test("refuses a guidance format no client can read", () => {
  assert.throws(() => buildGuidance({ format: "toml", guidance }), /Unknown guidance format: toml/);
});

test("writes one generated adapter per client, Codex included", async () => {
  const { manifest, root } = await createFixture();

  await generateAdapters({ root });

  assert.equal(
    await readFile(join(root, manifest.clients.codex.guidance.source), "utf8"),
    await readFile(join(root, manifest.clients.claude.guidance.source), "utf8"),
  );
  assert.deepEqual((await generateAdapters({ check: true, root })).drift, []);
});

test("check mode reports a hand-edited generated adapter", async () => {
  const { manifest, root } = await createFixture();

  await generateAdapters({ root });
  await writeFile(
    join(root, manifest.clients.cursor.guidance.source),
    "hand edit\n",
  );

  const result = await generateAdapters({ check: true, root });

  assert.deepEqual(result.drift, [manifest.clients.cursor.guidance.source]);
  assert.equal(
    await readFile(join(root, manifest.clients.cursor.guidance.source), "utf8"),
    "hand edit\n",
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-core-adapters-"));
  const manifest = await readManifest();

  await mkdir(join(root, "guidance"), { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(root, manifest.core.guidance), guidance);

  return { manifest, root };
}
