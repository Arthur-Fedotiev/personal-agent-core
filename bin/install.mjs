import { homedir } from "node:os";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { runDryRun } from "./dry-run.mjs";

export async function runInstall(options = {}) {
  const result = await runDryRun(options);

  if (!result.ok) {
    return result;
  }

  const home = options.home ?? homedir();
  const previousRoot = join(home, ".config", "agent-core", "previous");
  const linkWrites = result.proposed.filter(
    (write) =>
      !write.to.endsWith(".config/agent-core/previous/snapshot.json") &&
      !write.to.endsWith(".config/agent-core/installed.json"),
  );
  const sha = result.proposed.find((write) =>
    write.to.endsWith(".config/agent-core/installed.json"),
  ).from;

  await mkdir(previousRoot, { recursive: true });

  // The snapshot is the way back to the state before the first cutover, so a
  // later install adds unrecorded paths instead of overwriting what it finds.
  const previous = await readSnapshot(previousRoot);
  const recorded = new Set(previous.entries.map((entry) => entry.to));
  const entries = [...previous.entries];

  for (const write of linkWrites) {
    if (recorded.has(write.to)) {
      continue;
    }

    entries.push(await snapshotPath(write.to, previousRoot));
  }

  const removals = [...(result.shadowed ?? []), ...(result.stale ?? [])];

  for (const path of removals) {
    if (recorded.has(path)) {
      continue;
    }

    entries.push(await snapshotPath(path, previousRoot));
  }

  await writeFile(
    join(previousRoot, "snapshot.json"),
    `${JSON.stringify({ sha: previous.sha ?? sha, entries }, null, 2)}\n`,
  );

  for (const write of linkWrites) {
    await mkdir(dirname(write.to), { recursive: true });
    await rm(write.to, { recursive: true, force: true });
    await symlink(write.from, write.to);
  }

  for (const path of removals) {
    await rm(path, { recursive: true, force: true });
  }

  await mkdir(join(home, ".config", "agent-core"), { recursive: true });
  await writeFile(
    join(home, ".config", "agent-core", "installed.json"),
    `${JSON.stringify(
      {
        sha,
        destinations: linkWrites.map((write) => write.to),
      },
      null,
      2,
    )}\n`,
  );

  return { ...result, ok: true };
}

async function readSnapshot(previousRoot) {
  try {
    const snapshot = JSON.parse(
      await readFile(join(previousRoot, "snapshot.json"), "utf8"),
    );

    return { sha: snapshot.sha, entries: snapshot.entries ?? [] };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { sha: undefined, entries: [] };
    }
    throw error;
  }
}

async function snapshotPath(path, previousRoot) {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { to: path, kind: "missing" };
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    return { to: path, kind: "symlink", target: await readlink(path) };
  }

  const relativePath = relative(join(previousRoot, "..", "..", ".."), path);
  const stored = join("files", relativePath);

  await mkdir(dirname(join(previousRoot, stored)), { recursive: true });
  await cp(path, join(previousRoot, stored), { recursive: true });

  return {
    to: path,
    kind: stats.isDirectory() ? "directory" : "file",
    relative: stored,
  };
}
