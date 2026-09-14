import { collectSkills, generateAdapters, readSkills } from "../adapters/generate.mjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isCloudAgent(env = process.env) {
  return Boolean(
    env.CURSOR_CLOUD_AGENT ||
      env.CURSOR_AGENT_ENVIRONMENT === "cloud" ||
      env.CLAUDE_CODE_REMOTE,
  );
}

export async function runDryRun({
  env = process.env,
  gitSha,
  home = homedir(),
  hostSkillRoots,
  overlayRoot,
  root,
} = {}) {
  const errors = [];

  if (isCloudAgent(env)) {
    errors.push(
      "Refuse: personal core cannot install in a Cloud Agent. Use the skills the target repository commits.",
    );
    return { errors, ok: false, proposed: [] };
  }

  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  );
  const { drift } = await generateAdapters({ check: true, root });

  if (drift.length > 0) {
    errors.push(
      `Generated adapters have drift:\n${drift.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const coreSkills = await readSkills(join(root, manifest.core.skills));
  const collisionRoots = [
    ...(hostSkillRoots ?? (await discoverHostSkillRoots(home))),
  ];

  if (overlayRoot) {
    if (await hasSkillsRoot(overlayRoot)) {
      collisionRoots.push({ origin: "overlay", root: skillsRootOf(overlayRoot) });
    } else {
      errors.push(`Overlay skills not found: ${skillsRootOf(overlayRoot)}`);
    }
  }

  const hostSkillOrigins = new Map();

  for (const { origin, root: hostRoot } of collisionRoots) {
    for (const skill of await collectSkills(hostRoot)) {
      hostSkillOrigins.set(skill.name, origin);
    }
  }

  for (const skill of coreSkills) {
    if (hostSkillOrigins.has(skill.name)) {
      errors.push(
        `Skill name collision with ${hostSkillOrigins.get(skill.name)}: ${skill.name}`,
      );
    }
  }

  errors.push(...findCodexDrift(coreSkills));

  const resolvedHome = resolve(home);
  const sha =
    gitSha ??
    (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const clients = Object.values(manifest.clients);
  // Claude and Cursor share one skills home, so the same link is proposed once.
  const skillsHomes = [
    ...new Set(clients.map((client) => expandHome(client.skillsHome, home))),
  ];
  const links = [
    ...clients.map((client) => ({
      from: join(root, client.guidance.source),
      to: expandHome(client.guidance.home, home),
    })),
    ...skillsHomes.flatMap((skillsHome) =>
      coreSkills.map((skill) => ({
        from: join(root, manifest.core.skills, skill.name),
        to: join(skillsHome, skill.name),
      })),
    ),
  ];
  const proposed = [
    ...links,
    {
      from: sha,
      to: join(resolvedHome, ".config", "agent-core", "previous", "snapshot.json"),
    },
    {
      from: sha,
      to: join(resolvedHome, ".config", "agent-core", "installed.json"),
    },
  ];

  // A missing overlay is already an error above, so only a real path guards the writes.
  const overlayReal =
    overlayRoot && (await ifMissing(realpath(overlayRoot), undefined));

  if (overlayReal) {
    for (const write of proposed) {
      if (write.to.startsWith(`${overlayReal}/`) || write.to === overlayReal) {
        errors.push(`Refuse: proposed write into overlay: ${write.to}`);
      }
    }
  }

  const shadowed = new Set();

  for (const client of clients) {
    if (!client.shadowTree) {
      continue;
    }

    for (const path of await findShadowedSkills({
      coreSkills,
      shadowTree: expandHome(client.shadowTree, home),
    })) {
      shadowed.add(path);
    }
  }

  const stale = await findStaleLinks({
    home: resolvedHome,
    links,
    root,
  });

  return {
    errors,
    ok: errors.length === 0,
    overlayRoot,
    proposed,
    shadowed: [...shadowed],
    stale,
  };
}

/**
 * The overlay is a sibling checkout that commits its own skills, which a
 * Cloud Agent gets without a personal install. Those skills share the host
 * skill list with the core, so dry-run checks them for collisions and install
 * never writes into the checkout. An explicit path is taken as given and a
 * missing one is an error. The default sibling counts only while it carries
 * skills, so a machine without it, or with an unrelated `web` directory,
 * installs with no overlay.
 */
export async function resolveOverlayRoot({ explicit, fallback }) {
  if (explicit) {
    return explicit;
  }

  return (await hasSkillsRoot(fallback)) ? fallback : undefined;
}

function skillsRootOf(overlayRoot) {
  return join(overlayRoot, ".claude", "skills");
}

async function hasSkillsRoot(overlayRoot) {
  const stats = await ifMissing(stat(skillsRootOf(overlayRoot)), undefined);

  return stats?.isDirectory() === true;
}

export function formatReport(result) {
  if (!result.ok) {
    return result.errors.join("\n");
  }

  const lines = [
    "Manifest valid.",
    "No skill-name collisions.",
    "Generated adapters match.",
    result.overlayRoot ? "Overlay untouched." : "No overlay.",
    "Proposed writes (not applied):",
    ...result.proposed.map((write) => `- ${write.to} <- ${write.from}`),
  ];

  if (result.shadowed?.length) {
    lines.push(
      "Shadowing copies to remove:",
      ...result.shadowed.map((path) => `- ${path}`),
    );
  }

  if (result.stale?.length) {
    lines.push(
      "Links from an earlier install to remove:",
      ...result.stale.map((path) => `- ${path}`),
    );
  }

  return lines.join("\n");
}

const shortDescriptionLength = { max: 64, min: 25 };

/**
 * Codex reads a skill's invocation policy from `agents/openai.yaml` and ignores
 * Claude's `disable-model-invocation` frontmatter, so a skill that disagrees
 * with itself is user-invoked in one host and model-invoked in the other. The
 * same file's `short_description` is Codex's UI blurb and has a fixed range.
 */
function findCodexDrift(coreSkills) {
  const errors = [];

  for (const skill of coreSkills) {
    const implicitInvocation = skill.codex?.implicitInvocation;

    if (skill.disableModelInvocation && implicitInvocation !== false) {
      errors.push(
        `User-invoked skill needs policy.allow_implicit_invocation: false in agents/openai.yaml: ${skill.name}`,
      );
    }

    if (!skill.disableModelInvocation && implicitInvocation === false) {
      errors.push(
        `Model-invoked skill must not set policy.allow_implicit_invocation: false: ${skill.name}`,
      );
    }

    const shortDescription = skill.codex?.shortDescription;

    if (shortDescription === undefined) {
      continue;
    }

    const length = [...shortDescription].length;

    if (length < shortDescriptionLength.min || length > shortDescriptionLength.max) {
      errors.push(
        `short_description must be ${shortDescriptionLength.min}-${shortDescriptionLength.max} characters in agents/openai.yaml: ${skill.name} (${length})`,
      );
    }
  }

  return errors;
}

/**
 * A client also scans its shadow tree, so a stale copy of a core skill there
 * is listed beside or instead of the installed link. Install snapshots the
 * copy and takes it out of the way.
 */
async function findShadowedSkills({ coreSkills, shadowTree }) {
  const coreNames = new Set(coreSkills.map((skill) => skill.name));
  const entries = await ifMissing(readdir(shadowTree, { withFileTypes: true }), []);

  return entries
    .filter((entry) => entry.isDirectory() && coreNames.has(entry.name))
    .map((entry) => join(shadowTree, entry.name));
}

/**
 * A link the previous install wrote to a destination this manifest no longer
 * proposes, such as a retired skills home or a removed skill, would otherwise
 * stay behind and be listed twice or dangle. Only a symlink still pointing into
 * this repository counts; anything the user put in its place is left alone.
 */
async function findStaleLinks({ home, links, root }) {
  const installed = await readJsonIfPresent(
    join(home, ".config", "agent-core", "installed.json"),
  );
  const proposedDestinations = new Set(links.map((link) => link.to));
  const stale = [];

  for (const destination of installed?.destinations ?? []) {
    if (proposedDestinations.has(destination)) {
      continue;
    }

    if (await isLinkInto(destination, root)) {
      stale.push(destination);
    }
  }

  return stale;
}

async function isLinkInto(path, root) {
  const stats = await ifMissing(lstat(path), undefined);

  return (
    stats?.isSymbolicLink() === true &&
    (await readlink(path)).startsWith(join(root, "/"))
  );
}

function expandHome(path, home) {
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }
  return path;
}

/**
 * Every tree a host reads skills from besides the skills home is a collision
 * source: Claude plugins, Codex plugins, and the skills Codex bundles. A core
 * skill with the same name would be listed twice or lose to the host's copy.
 */
async function discoverHostSkillRoots(home) {
  const codexHome = join(home, ".codex");
  const installedPlugin = (root) => ({ origin: "installed plugin", root });

  return [
    ...(await readClaudePluginSkillRoots(home)).map(installedPlugin),
    ...(await readCodexPluginSkillRoots(codexHome)).map(installedPlugin),
    { origin: "Codex system skill", root: join(codexHome, "skills", ".system") },
  ];
}

async function readClaudePluginSkillRoots(home) {
  const installed = await readJsonIfPresent(
    join(home, ".claude", "plugins", "installed_plugins.json"),
  );
  const roots = [];

  for (const entries of Object.values(installed?.plugins ?? {})) {
    for (const entry of entries) {
      if (!entry.installPath) {
        continue;
      }
      roots.push(join(entry.installPath, "skills"));
    }
  }

  return roots;
}

// Codex caches plugins as <marketplace>/<plugin>/<version>/skills.
async function readCodexPluginSkillRoots(codexHome) {
  let roots = [join(codexHome, "plugins", "cache")];

  for (let depth = 0; depth < 3; depth += 1) {
    const next = [];

    for (const root of roots) {
      next.push(...(await listDirectories(root)));
    }

    roots = next;
  }

  return roots.map((root) => join(root, "skills"));
}

async function listDirectories(path) {
  const entries = await ifMissing(readdir(path, { withFileTypes: true }), []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

async function readJsonIfPresent(path) {
  const source = await ifMissing(readFile(path, "utf8"), undefined);

  return source === undefined ? undefined : JSON.parse(source);
}

/**
 * Most of what dry-run reads under the home directory may not exist yet.
 * A missing path, or a file where a directory was expected, yields the
 * fallback; every other error still surfaces.
 */
async function ifMissing(promise, fallback) {
  try {
    return await promise;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return fallback;
    }
    throw error;
  }
}
