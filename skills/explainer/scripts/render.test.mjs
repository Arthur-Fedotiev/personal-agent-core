import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  WIDTHS,
  chromeMeasureArguments,
  chromeScreenshotArguments,
  defaultPngPath,
  measureProbe,
  parseArguments,
  playwrightArguments,
  pngSize,
  readMeasuredHeight,
  render,
  renderWidth,
  renderWithChrome,
} from "./render.mjs";

const execFileAsync = promisify(execFile);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("the PNG lands beside the page unless a second path is given", () => {
  const options = parseArguments(["/tmp/x/page.html"]);

  assert.equal(options.png, "/tmp/x/page.png");
  assert.equal(defaultPngPath("/tmp/x/page.htm"), "/tmp/x/page.png");
  assert.equal(parseArguments(["page.html", "/out/shot.png"]).png, "/out/shot.png");
});

test("--width takes whole CSS pixels and everything else is refused", () => {
  assert.equal(parseArguments(["page.html", "--width", "1240"]).width, 1240);
  assert.throws(() => parseArguments(["page.html", "--width", "abc"]), /whole number/);
  assert.throws(() => parseArguments(["page.html", "--width", "100"]), /320 or more/);
  assert.throws(() => parseArguments(["--full-page", "page.html"]), /Unknown argument/);
  assert.throws(() => parseArguments(["a.html", "a.png", "b.html"]), /one page at a time/);
  assert.throws(() => parseArguments([]), /Usage/);
});

test("the width follows the page: 1000 for the column, 1240 when a row uses .wide", () => {
  assert.equal(renderWidth('<div class="row">'), WIDTHS.column);
  assert.equal(renderWidth('<div class="row wide">'), WIDTHS.wide);
  assert.equal(renderWidth('<div class="widen">'), WIDTHS.column);
  assert.equal(renderWidth('<div class="row wide">', 1600), 1600);
});

test("the Playwright command drives the installed Chrome at 2x and full page", () => {
  const args = playwrightArguments({ html: "/p/page.html", png: "/p/page.png", width: 1000 });

  assert.deepEqual(args.slice(0, 3), ["-y", "--prefer-offline", "playwright-core@1.63.0"]);
  assert.equal(args[args.indexOf("--channel") + 1], "chrome");
  assert.ok(args.includes("--full-page"));
  assert.ok(args.includes("--device=Desktop Chrome HiDPI"));
  assert.ok(args.includes("--viewport-size=1000,100"));
  assert.deepEqual(args.slice(-2), ["/p/page.html", "/p/page.png"]);
});

test("the probe stamps scrollHeight on <html> and the dump gives it back", () => {
  const probe = measureProbe("<html><body><p>hi</p></body></html>");

  assert.match(probe, /<script>document\.documentElement\.dataset\.h=document\.documentElement\.scrollHeight<\/script><\/body>/);
  assert.equal(readMeasuredHeight('<html lang="en" data-h="2865" data-w="1000">'), 2865);
  assert.throws(() => readMeasuredHeight("<html></html>"), /did not report/);
});

test("raw Chrome measures at 1x and shoots at 2x with the light scheme forced", () => {
  const measure = chromeMeasureArguments({ probe: "/t/measure.html", width: 1240 });
  const shot = chromeScreenshotArguments({ height: 700, html: "/p/page.html", png: "/p/page.png", width: 1240 });

  assert.ok(measure.includes("--dump-dom"));
  assert.ok(measure.includes("--window-size=1240,100"));
  assert.ok(measure.includes("--blink-settings=preferredColorScheme=1"));
  assert.ok(!measure.includes("--force-device-scale-factor=2"));
  assert.ok(shot.includes("--screenshot=/p/page.png"));
  assert.ok(shot.includes("--window-size=1240,700"));
  assert.ok(shot.includes("--force-device-scale-factor=2"));
  assert.ok(shot.includes("--blink-settings=preferredColorScheme=1"));
});

test("pngSize reads the IHDR chunk", () => {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(2000, 16);
  header.writeUInt32BE(5730, 20);

  assert.deepEqual(pngSize(header), { height: 5730, width: 2000 });
  assert.throws(() => pngSize(Buffer.from("not a png")), /Not a PNG/);
});

async function pageInTemp(source) {
  const directory = await mkdtemp(join(tmpdir(), "explainer-render-test-"));
  const html = join(directory, "page.html");
  await writeFile(html, source);
  return { directory, html, png: join(directory, "page.png") };
}

test("render prefers Playwright and never touches Chrome when it succeeds", async () => {
  const { html, png } = await pageInTemp('<html><body class="row wide">x</body></html>');
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, args]);
    return { stdout: "" };
  };

  const result = await render({ html, png, width: undefined }, { exec });

  assert.equal(result.via, "playwright");
  assert.equal(result.width, WIDTHS.wide);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "npx");
});

test("render falls back to two Chrome launches and feeds the measured height into the shot", async () => {
  const { html, png } = await pageInTemp("<html><body>x</body></html>");
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, args]);

    if (file === "npx") {
      throw new Error("npm ERR! network request failed\nmore detail");
    }

    if (args.includes("--dump-dom")) {
      const probe = await readFile(args.at(-1), "utf8");
      assert.match(probe, /dataset\.h=/);
      return { stdout: '<html data-h="777">' };
    }

    return { stdout: "" };
  };

  const result = await render({ html, png, width: undefined }, { chrome: "/fake/chrome", exec });

  assert.equal(result.via, "chrome");
  assert.equal(result.playwrightError, "npm ERR! network request failed");
  assert.deepEqual(calls.map(([file]) => file), ["npx", "/fake/chrome", "/fake/chrome"]);
  assert.ok(calls[2][1].includes("--window-size=1000,777"));
  assert.ok(calls[2][1].includes(`--screenshot=${png}`));
});

const hasChrome = await access(CHROME).then(() => true, () => false);

test("raw Chrome renders a real page at 2x with the measured height", { skip: !hasChrome && "Google Chrome is not installed" }, async () => {
  const { html, png } = await pageInTemp(
    '<!doctype html><html><head><meta name="color-scheme" content="only light"></head><body style="margin:0"><div style="height:600px">tall</div></body></html>',
  );

  await renderWithChrome({ html, png, width: 1000 });

  assert.deepEqual(pngSize(await readFile(png)), { height: 1200, width: 2000 });
});

test("the script runs when invoked through a symlink, as the installed skill does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "explainer-"));
  const link = join(directory, "render.mjs");
  await symlink(fileURLToPath(new URL("./render.mjs", import.meta.url)), link);

  const result = await execFileAsync("node", [link]).catch((error) => error);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: render\.mjs/);
});
