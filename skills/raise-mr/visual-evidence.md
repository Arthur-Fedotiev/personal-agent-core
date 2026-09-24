# Before and after screenshots in the web repo

Screenshots of the served app, taken through the `ui-browser` Chrome DevTools MCP. Worked once for
TW-166910 (RFM dealer quote input, 2026-09-24). Everything runs from the checkout that holds the
change.

## 1. Serve the app on the fixed code

```bash
npx bazel run //apps/<app>:serve > /tmp/<ticket>-serve.log 2>&1 &
until grep -q "compiled successfully" /tmp/<ticket>-serve.log; do sleep 5; done
```

The dealer app is `twi-dealer-software-app`, the customer app `twi-app`; both answer on
`http://localhost:4200/`. The serve builds once and does not watch sources: after any edit, kill it
(`pkill -f "<app>:serve"`) and start it again.

## 2. Start a Chrome the MCP can drive

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/<ticket>-chrome \
  --no-first-run --window-size=1400,900 about:blank &
```

`ui-browser` connects to port 9222. `new_page`, `navigate_page`, `evaluate_script` and
`take_screenshot` are enough; `take_screenshot` only writes inside the workspace, so use
`.scratch/<ticket>/` (not ignored by git: never `git add -A`).

## 3. Open the page with real data

Dealer or customer pages authenticate against dev through the local override, and the route ends
in the **full list id** (`List_MM.DD.YYYY_HH:MM:SS-<owner>;EL<item>` with `;` as `%3B`):

```
http://localhost:4200/?twDevAuthOverride=<user>:<dealer>:<profile>&rs=1#/<route>/<full list id>
```

The values Artur uses come from the NLI debug redirect dialog (`libs/list-ticket-nli/src/lib/debug-list-redirect`), which builds this exact URL; ask him for the override rather than guessing it.

A page with a mock data layer (`provide...DataLayer({ useMockApi: true })` in its module) renders
without the backend, but the list id still needs the `-<owner>;EL...` suffix or the dispatcher
throws `Cannot determine owner from list id`. Mock edits are local only and revert before the next
commit.

## 4. Check the state, then shoot

Confirm the element is in the state the screenshot claims before taking it, with `evaluate_script`:
`classList`, `getComputedStyle(...).paddingRight`, `getBoundingClientRect()` of the parts involved.
Then `take_screenshot` with `filePath: <workspace>/.scratch/<ticket>/after-page.png`, and read the
row's `getBoundingClientRect()` and `devicePixelRatio` for the crop.

```bash
sips -c <h*dpr> <w*dpr> --cropOffset <y*dpr> <x*dpr> after-row.png   # offset 0 0 centres; use >= 1
```

## 5. The before shot

```bash
git checkout origin/master -- <changed style files>
# restart the serve (step 1), reload the page, repeat step 4 into before-*.png
git checkout HEAD -- <changed style files>
```

Confirm the pre-fix numbers in the same `evaluate_script` (for TW-166910: padding 42px vs 44px)
so the two images are known to differ by the fix alone.

## 6. Tear down

Kill the serve and the Chrome you started; keep `.scratch/<ticket>/` until the images are on the
MR, then delete it.
