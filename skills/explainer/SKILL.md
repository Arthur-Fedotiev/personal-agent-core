---
name: explainer
description: Write one ticket's explainer page from the fixed template, as a Diagnosis and/or a settled or proposed Resolution; render it to PNG and publish it to GitLab on request.
argument-hint: "[ticket] [settled|proposed] [--png] [--publish]"
disable-model-invocation: true
---

An **explainer** is one standalone HTML page that explains one ticket's work to a reviewer. It is
a **Diagnosis** (what the user sees, why, where each piece comes from), a **Resolution** (what
changes), or both in that order, never reversed or interleaved. A Resolution has a **tense**:
**settled** when the change shipped, **proposed** when it is a candidate. The page's style and
section skeleton live in `references/template.html`; every explainer is a filled copy of it, so
pages stop drifting. `--publish` implies `--png`.

## Process

### 1. Read the arguments

The ticket names the output directory and the meta line. The tense is never inferred: a page with
a Resolution and no `settled` or `proposed` argument stops here and asks. Diagnosis is on by
default; drop it only when the page is a companion to an explainer that already carries it.

**Done when:** you can name the blocks, the tense, and whether a PNG or an upload is wanted.

### 2. Choose the output path

Write to `.scratch/<ticket>/<ticket>-<two-or-three-words>-explainer.html` inside the target repo
when a ticket is known and `git check-ignore -q .scratch` succeeds there. Otherwise write to the OS
temporary directory. Never commit the page.

**Done when:** the directory exists and the slug is fixed.

### 3. Fill the template

Copy `references/template.html` and edit the copy. The `<style>` stays as it is; the body keeps
only the sections this page needs, in this order, and the tense block that does not apply is
deleted whole. Sections are dropped, never reordered; numbering is automatic.

| Block | Sections, in order |
| --- | --- |
| Every page | `h1`, then `.meta`: ticket · MR · branch · commit · pipeline · date, unknowns omitted |
| Diagnosis | Symptom (mock-up or screenshot, then a table of where and when) → How it went (numbered, wrong turns named; optional) → Evidence (table with a Data link column) → Root cause (mechanism, then a `.flow`) |
| Resolution, settled | The fix (before/after in `.two`, change table by package) → Flow after the change (optional) → Verification (table, red then green) → Deploy order and follow-ups (callout, then list) → Links |
| Resolution, proposed | What you would see (mock-up) → The edits (`pre.diff` per file) → Flow after the change (`.lanes`) → Alternatives (one lane each, rejected ones named) → Comparison and recommendation (`table.grid`, then the recommendation) |

Section names are fixed. A descriptive tail goes in `<h2>Root cause <small>why it wrapped</small></h2>`.
The components are named in the template's `<style>` comments and the body shows each once; the
colour vocabulary is `ok`, `bad`, `warn`, `muted` everywhere.

Mock-ups reproduce the real application inside `.mock`, which resets the font and neutralises the
page's table and heading rules. Use the library (`.dlg`, `.bap`, `.plain`) when it fits. When the
page needs UI the library lacks, measure the application's real CSS and write it in the
`/* page-specific */` block at the end of `<style>`, together with any one-off geometry such as a
column pin or a historical variant of a component. A component moves into the template's library
only when a second page needs it; edit the template in this skill then, not the page. A row that
needs more than the column, such as two dialogs side by side, takes `.wide`.

Mock-up or screenshot: a mock-up when the point is a mechanism or a state that does not exist yet;
a screenshot when the point is proof of what the application showed. Inline a screenshot as a
`data:` URI in `.shot` so the page stays one file, and keep it under 1 MB.

Writing: apply `unslop`. No emojis. Link to MRs, tickets, journals and commits instead of
restating them. Name the wrong hypothesis when there was one. Every Evidence row carries a Data
link. Verification wording is red, then green. The Deploy callout is the one thing an operator
must not miss.

**Done when:** the page opens from disk, every section present is in the order above, the meta
line has no placeholder left, and the page-specific block holds only this page's CSS.

### 4. Render, with `--png` or `--publish`

```bash
node <base-dir>/scripts/render.mjs <page.html>
```

The PNG lands beside the page at 2x, 1000 CSS px wide, or 1240 when a row uses `.wide`; `--width`
overrides. It runs over the installed Chrome with no browser download and, after the first run,
no network. Look at the PNG: it is what the reviewer sees. A clipped code block or a wrapped card
is fixed in the page and re-rendered, never left for the reader.

**Done when:** the PNG exists and you have looked at it.

### 5. Publish, with `--publish`

Run from a shell inside the target repo, so the project comes from `origin`:

```bash
node <base-dir>/scripts/publish-gitlab.mjs <page.png>
```

It needs `GITLAB_TOKEN` in the environment and reads it from nowhere else; `GITLAB_HOST` or
`--host` names the API host when it differs from the remote's. It prints the Markdown that embeds
the image; paste that into the MR description or comment. Uploading is an external write and
happens only when `--publish` was given in the current turn.

**Done when:** the Markdown is in the MR text, or handed to the user to paste.

### 6. Report

Reply with the page path and an `open` command for it, the PNG path when rendered, and the
Markdown when published.
