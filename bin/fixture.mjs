import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { generateAdapters } from "../adapters/generate.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Test fixtures install the repository's own manifest around synthetic skills
 * and guidance, so a test proves what the shipped manifest does rather than
 * what a copy of it did.
 */
export async function readManifest() {
  return JSON.parse(
    await readFile(join(repositoryRoot, "manifest.json"), "utf8"),
  );
}

export async function createFixture({
  extraSkills = [],
  guidance = "# Personal guidance\n",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "personal-core-install-"));
  const overlayRoot = await mkdtemp(join(tmpdir(), "overlay-"));
  const home = await mkdtemp(join(tmpdir(), "home-"));
  const manifest = await readManifest();

  await mkdir(join(root, "guidance"), { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(root, manifest.core.guidance), guidance);
  await writeSkill(join(root, manifest.core.skills), {
    name: "alpha",
    description: "Alpha does one thing.",
  });
  await writeSkill(join(overlayRoot, ".claude", "skills"), {
    name: "review",
    description: "Overlay review.",
  });

  for (const skill of extraSkills) {
    await writeSkill(join(root, manifest.core.skills), skill);
  }

  await generateAdapters({ root });

  return { home, manifest, overlayRoot, root };
}

export async function writeSkill(
  skillsRoot,
  { description = "Collision bait.", frontmatter = "", name, openaiYaml },
) {
  const skillRoot = join(skillsRoot, name);

  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n`,
  );

  if (openaiYaml !== undefined) {
    await mkdir(join(skillRoot, "agents"), { recursive: true });
    await writeFile(join(skillRoot, "agents", "openai.yaml"), openaiYaml);
  }
}

export async function initGitRepo(root) {
  await execFileAsync("git", ["-C", root, "init"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "dev@example.com",
  ]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "dev"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
}
