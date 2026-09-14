#!/usr/bin/env node

// An explainer reaches a merge request only as an image, because GitLab strips
// <style>, style attributes and data: URIs from descriptions. This renders the
// page to a 2x PNG over the Chrome already on the machine: one Playwright launch
// through the npx cache, no browser download and no network after the first
// run, with two raw Chrome launches as the fallback when npx cannot start.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const run = (file, args) => execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });

const PLAYWRIGHT = "playwright-core@1.63.0";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The column fills 1000 CSS px. A page with a .wide row is laid out for 1240,
// which is what two 520 px dialogs side by side need.
export const WIDTHS = { column: 1000, wide: 1240 };

export function parseArguments(argv) {
  const options = { html: undefined, png: undefined, width: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--width") {
      const value = Number(argv[index + 1]);
      index += 1;

      if (!Number.isInteger(value) || value < 320) {
        throw new Error("--width needs a whole number of CSS pixels, 320 or more");
      }
      options.width = value;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (options.html === undefined) {
      options.html = argument;
      continue;
    }

    if (options.png === undefined) {
      options.png = argument;
      continue;
    }

    throw new Error(`Render one page at a time; got ${options.html}, ${options.png} and ${argument}`);
  }

  if (options.html === undefined) {
    throw new Error("Usage: render.mjs <page.html> [page.png] [--width <css px>]");
  }

  options.html = resolve(options.html);
  options.png = resolve(options.png ?? defaultPngPath(options.html));
  return options;
}

export function defaultPngPath(html) {
  return `${html.replace(/\.html?$/i, "")}.png`;
}

export function renderWidth(source, explicit) {
  if (explicit !== undefined) {
    return explicit;
  }

  return /class="[^"]*\bwide\b[^"]*"/.test(source) ? WIDTHS.wide : WIDTHS.column;
}

export function playwrightArguments({ html, png, width }) {
  return [
    "-y",
    "--prefer-offline",
    PLAYWRIGHT,
    "screenshot",
    "--channel",
    "chrome",
    "--full-page",
    "--color-scheme=light",
    "--device=Desktop Chrome HiDPI",
    `--viewport-size=${width},100`,
    html,
    png,
  ];
}

/**
 * Chrome's --screenshot captures exactly --window-size and nothing computes the
 * content height, so a copy of the page stamps its own scrollHeight onto <html>
 * and --dump-dom, which runs scripts before printing, hands it back. The page
 * itself stays script-free.
 */
export function measureProbe(source) {
  return source.replace(
    /<\/body>/i,
    "<script>document.documentElement.dataset.h=document.documentElement.scrollHeight</script></body>",
  );
}

export function readMeasuredHeight(dom) {
  const match = dom.match(/data-h="(\d+)"/);

  if (!match) {
    throw new Error("Chrome did not report the page height");
  }

  return Number(match[1]);
}

// preferredColorScheme=1 is kLight in Blink's enum; a dark-mode Mac renders dark without it.
export function chromeMeasureArguments({ probe, width }) {
  return [
    "--headless",
    "--disable-gpu",
    "--dump-dom",
    `--window-size=${width},100`,
    "--blink-settings=preferredColorScheme=1",
    probe,
  ];
}

export function chromeScreenshotArguments({ html, png, width, height }) {
  return [
    "--headless",
    "--disable-gpu",
    `--screenshot=${png}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=2",
    "--blink-settings=preferredColorScheme=1",
    html,
  ];
}

export async function renderWithPlaywright(options, { exec = run } = {}) {
  await exec("npx", playwrightArguments(options));
}

export async function renderWithChrome(options, { chrome = CHROME, exec = run } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "explainer-render-"));

  try {
    const probe = join(directory, "measure.html");
    await writeFile(probe, measureProbe(await readFile(options.html, "utf8")));
    const { stdout } = await exec(chrome, chromeMeasureArguments({ probe, width: options.width }));
    const height = readMeasuredHeight(stdout);
    await exec(chrome, chromeScreenshotArguments({ ...options, height }));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function render(options, deps = {}) {
  const source = await readFile(options.html, "utf8");
  const resolved = { ...options, width: renderWidth(source, options.width) };

  try {
    await renderWithPlaywright(resolved, deps);
    return { ...resolved, via: "playwright" };
  } catch (error) {
    await renderWithChrome(resolved, deps);
    return { ...resolved, playwrightError: firstLine(error.message), via: "chrome" };
  }
}

export function pngSize(buffer) {
  if (buffer.toString("latin1", 1, 4) !== "PNG") {
    throw new Error("Not a PNG");
  }

  return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) };
}

const firstLine = (text) => text.split("\n").find((line) => line.trim()) ?? text;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await render(options);
  const { width, height } = pngSize(await readFile(result.png));
  const note = result.playwrightError ? ` (playwright failed: ${result.playwrightError})` : "";

  console.log(`${result.png} ${width}x${height} via ${result.via}${note}`);
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
    console.error(`render: ${error.message}`);
    process.exitCode = 1;
  }
}
