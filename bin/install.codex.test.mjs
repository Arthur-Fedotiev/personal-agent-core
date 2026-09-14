import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createFixture } from "./fixture.mjs";
import { runInstall } from "./install.mjs";

const execFileAsync = promisify(execFile);

// Codex CLI is not on PATH on this machine; the ChatGPT desktop app bundles it.
const codexBinary =
  process.env.CODEX_BINARY ?? "/Applications/ChatGPT.app/Contents/Resources/codex";

/**
 * `codex debug prompt-input` renders the prompt Codex would send, which is the
 * only place the host's own view of a skills home and AGENTS.md is observable.
 */
test(
  "Codex lists the installed skills home and reads the installed guidance",
  { skip: existsSync(codexBinary) ? false : `${codexBinary} is not installed` },
  async () => {
    const fixture = await createFixture({
      extraSkills: [
        {
          name: "beta",
          description: "Beta runs only when named.",
          frontmatter: "disable-model-invocation: true\n",
          openaiYaml:
            'interface:\n  short_description: "Beta runs only when the user names it"\npolicy:\n  allow_implicit_invocation: false\n',
        },
      ],
      guidance: "# Personal guidance\n\nCODEX-GUIDANCE-MARKER\n",
    });
    const workspace = await mkdtemp(join(tmpdir(), "codex-workspace-"));

    assert.equal(
      (
        await runInstall({
          env: {},
          gitSha: "deadbeef",
          home: fixture.home,
          overlayRoot: fixture.overlayRoot,
          hostSkillRoots: [],
          root: fixture.root,
        })
      ).ok,
      true,
    );

    const { stdout } = await execFileAsync(codexBinary, ["debug", "prompt-input"], {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: join(fixture.home, ".codex"),
        HOME: fixture.home,
      },
    });
    const texts = JSON.parse(stdout).flatMap((message) =>
      (message.content ?? []).map((part) => part.text ?? ""),
    );
    const skillsInstructions = texts.find((text) =>
      text.includes("<skills_instructions>"),
    );

    assert.ok(skillsInstructions, "Codex emitted no skills instructions");

    const skillsHome = await realpath(
      join(fixture.home, ".agents", "skills"),
    );
    const rootId = skillsInstructions.match(
      new RegExp(`- \`(r\\d+)\` = \`${escapeRegExp(skillsHome)}\``),
    )?.[1];

    assert.ok(rootId, `Codex did not list ${skillsHome} as a skill root`);
    assert.match(
      skillsInstructions,
      new RegExp(`- alpha: Alpha does one thing\\. \\(file: ${rootId}/alpha/SKILL\\.md\\)`),
    );
    assert.doesNotMatch(skillsInstructions, /- beta:/);
    assert.ok(
      texts.some((text) => text.includes("CODEX-GUIDANCE-MARKER")),
      "Codex did not read the installed AGENTS.md",
    );
  },
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
