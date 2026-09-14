import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export async function runRestore({ home = homedir(), root } = {}) {
  const snapshotPath = join(home, ".config", "agent-core", "previous", "snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const previousRoot = join(home, ".config", "agent-core", "previous");

  for (const entry of snapshot.entries) {
    await rm(entry.to, { recursive: true, force: true });

    if (entry.kind === "missing") {
      continue;
    }

    await mkdir(dirname(entry.to), { recursive: true });

    if (entry.kind === "symlink") {
      await symlink(entry.target, entry.to);
      continue;
    }

    await cp(join(previousRoot, entry.relative), entry.to, { recursive: true });
  }

  await execFileAsync("git", ["-C", root, "checkout", "--force", snapshot.sha]);

  return { ok: true };
}
