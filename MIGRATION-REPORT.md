# MIGRATION-REPORT.md

Progress log for MIGRATION.md, Gate 0 through Phase 10. Read this first when
resuming: continue from the first phase below not marked complete.

Environment this run executed in: Windows 11, Node v24.17.0, npm 11.13.0,
single physical display, no Ollama/Anthropic/Azure credentials present unless
noted otherwise.

---

## Gate 0 - Baseline

**Status: COMPLETE**

Commands run:
- `npm ci` — passed, 332 packages, 0 vulnerabilities.
- `npm test` (mask-verify) — **PASS**, before and after `npm ci`.
- `npm install -D playwright @playwright/test` (with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) — installed. No browser binaries were
  downloaded; not needed since only Electron is driven.
- `npx playwright test e2e/legacy-baseline.spec.ts` — **PASS** (22.7s).

Deviation from the plan: added `@playwright/test` alongside the plan's named
`playwright` dependency, since `@playwright/test` is the test runner that
actually executes `.spec.ts` files (`playwright` alone is just the driver
library). Both are devDependencies; no browsers were downloaded, only the
Electron app is automated.

Added `playwright.config.ts` (testDir `e2e`, single worker, 60s timeout) and
`e2e/legacy-baseline.spec.ts`. Screenshots committed under `e2e/baseline/`;
**never regenerate these** — they're the Phase 6a/6b visual-parity reference.

### Reachability (see `e2e/baseline/reachability.json`)

| Stage/screen | Reached automatically? |
|---|---|
| Ready, source = single window | yes — `01-ready-window-source.png` |
| Ready, source = entire screen | yes — `02-ready-screen-source.png` |
| Screen picker (would show with 2+ displays) | **no** — this machine has one physical display, so `#screen-picker` never un-hides. Needs the human checklist item. |
| Summary Templates screen | yes — `03-templates.png` |
| Settings screen | yes — `04-settings.png` |
| Countdown overlay | yes — `06-countdown.png` |
| Recording stage | yes — `07-recording.png` |
| Review stage (after Stop) | yes — `08-review.png`. At least one keyframe was captured and OCR/auto-mask completed (`stage-after-stop: "review"`), i.e. this environment has desktop-capture permission and enough network/local access for the tesseract CDN fetch (or it no-op'd gracefully either way — review was still reached). |
| Processing / Sent stages | **not attempted** — those require a real Ollama or Anthropic call, which Gate 0 intentionally doesn't configure. Out of scope until the echo test provider exists (Phase 2). |

Pixel-diff threshold for later gates: **not yet chosen** — will be set when
Phase 6a's gate first runs the comparison (needs a real diff run to pick a
sensible number; recorded here as a TODO so it isn't forgotten).

**Commit:** `migration: gate 0 - baseline`

---

## Phase 0 - Scaffolding alongside the legacy app

**Status: COMPLETE**

Toolchain installed: `electron-vite@5.0.0`, `vite@7.3.6`, `typescript@7.0.2`,
`@vitejs/plugin-react@5.2.0`, `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`,
`vitest@5.0.3`, `@types/node`, `@types/react`, `@types/react-dom` (all
devDependencies); `react@19.3.0` + `react-dom@19.3.0` as runtime
`dependencies` per decision in the plan.

**Deviation:** `npm install -D vite @vitejs/plugin-react` at their unpinned
latest (`vite@8`, `@vitejs/plugin-react@6`) produced an unresolvable peer
conflict with `electron-vite@5` (which peers on `vite ^5||^6||^7`). Pinned
`vite@^7` and `@vitejs/plugin-react@^5.2.0` (the last line compatible with
Vite 7) instead. No functional difference for this plan; recorded since it's
a version choice the plan didn't make explicitly.

Files added: `electron.vite.config.ts` (main/preload/renderer entries,
renderer `root: 'src/renderer'`, `base: './'`); `tsconfig.json` (solution
file) + `tsconfig.node.json` (main/preload, `strict: true`) +
`tsconfig.web.json` (renderer, DOM lib, `strict: true`); stub
`src/main/index.ts`, `src/preload/index.ts` (empty export, real bridge is
Phase 2), `src/renderer/index.html` (CSP meta tag exactly as specified) +
`src/renderer/src/{main.tsx,App.tsx,index.css}`; `vitest.config.ts` (unit
tests scoped to `src/**/*.{test,spec}.ts(x)` so Vitest never collects the
`e2e/` Playwright specs — they use a different `test()` identity and
Playwright itself errors if Vitest imports them; `passWithNoTests: true`
since no unit tests exist before Phase 1); `.github/workflows/ci.yml` (new,
`release.yml` untouched).

New scripts added, legacy `start`/`dev`/`dist`/`rebuild`/`test` untouched:
`dev:vite`, `build:vite`, `typecheck`, `test:unit`, `test:e2e`.

### Gate results

- `npm test` (mask-verify) — **PASS**.
- `npm run typecheck` — **PASS**, zero errors across both configs.
- `npm run build:vite` — **PASS**. Output lands exactly at `out/main/index.js`,
  `out/preload/index.js`, `out/renderer/index.html` — matches the paths later
  phases assume. One harmless warning (`Generated an empty chunk: "index"`)
  from the preload stub, which only does `export {}` until Phase 2.
- `e2e/stub-smoke.spec.ts` (new) — **PASS**. Launches `out/main/index.js`
  directly, asserts zero console errors and zero CSP violations.
- `npx electron-builder --dir` — **PASS**, produced
  `dist/win-unpacked/TicketScribe.exe`. Still packages the **legacy** app
  (package.json `main` stays `main.js` per the plan's constraint; nothing in
  Phase 0 repoints it). `e2e/packaged-legacy-smoke.spec.ts` (new) drives that
  exe directly and asserts the legacy `ready` stage loads — a packaging
  regression check that the much larger devDependency tree (and react/react-dom
  now in `dependencies`) didn't break electron-builder.
- `e2e/legacy-baseline.spec.ts` against `npm start` — **PASS**, re-verified
  unchanged. **Important:** re-running this spec regenerates
  `e2e/baseline/*.png` on disk (new screenshots, same content modulo timing
  noise) — did so once by accident here and restored the Gate-0-committed
  versions with `git checkout -- e2e/baseline` before committing. Future
  phases must not re-run `legacy-baseline.spec.ts`; only compare a *new*
  packaged-app spec's screenshots against the frozen Gate 0 images.

**Commit:** `migration: phase 0 - scaffolding alongside legacy app`

---

## Phase 1 - Main process to TypeScript

**Status: COMPLETE**

Ported `main.js` → `src/main/index.ts` and `main/events-capture.js` →
`src/main/events-capture.ts`, typed, no logic changes. `src/main/index.ts`
now loads the **legacy** `renderer/index.html` (`path.join(__dirname, '..',
'..', 'renderer', 'index.html')` — `out/main/` is two levels below repo
root), not the Phase 0 React stub. Added `src/shared/events.ts` with a typed
`ActivityEvent`/`WindowEventDetail`/`TerminalCommandDetail`/
`TerminalTranscriptDetail`/`BrowserEventDetail` union matching the real
runtime shapes (window events carry `category`/`durationMs` inside `detail`,
same as the legacy code — not flattened to top-level, since that would be a
behavior/shape change this phase doesn't call for).

Minimal one-line change to the **legacy** `main/events-capture.js`: added
`WINDOW_POLL_SCRIPT` to its `module.exports`, as the plan explicitly
requires for the byte-identity test. No other legacy behavior touched.

**Deviation / cleanup:** deleted Phase 0's `e2e/stub-smoke.spec.ts`. It
asserted the compiled `out/main/index.js` renders the React stub
(`#root h1`) — true in Phase 0, but Phase 1 repoints that same entrypoint at
the legacy renderer, so the stub is now unreachable from the app's actual
boot path until Phase 6a rebuilds the renderer for real. Keeping a test that
asserts a premise the phase intentionally invalidates would just be dead
weight; Phase 1's gate (below) doesn't require it, and `out/renderer/*` is
still produced by `build:vite`, just not loaded by anyone yet.

Added `e2e/visual-diff.ts` (`pixelmatch` + `pngjs`, new devDependencies) as
the shared screenshot-comparison helper promised in Gate 0. **Finding:**
Gate 0's baseline PNGs are 1483×954; a same-session re-screenshot of the
identical legacy app is 1184×761 — the dev machine's display-scale factor
changed between the two runs (confirmed by briefly regenerating
`legacy-baseline.spec.ts`'s output and diffing dimensions, then restoring the
committed baseline with `git checkout`). `comparePng` therefore
nearest-neighbor-resamples the actual screenshot to the baseline's
dimensions before diffing, and uses a looser threshold when it had to
(`VISUAL_DIFF_THRESHOLD = 2%` unscaled, `VISUAL_DIFF_THRESHOLD_RESAMPLED =
8%` when a resample happened, to absorb resampling blur on top of real
diff). This is the threshold Gate 0 deferred choosing; recorded here instead
since Phase 1 is what first needed a working comparison.

New Playwright spec `e2e/phase1-ts-main.spec.ts`: launches
`out/main/index.js`, asserts `get-sources` (invoked the same way the real UI
does, via the legacy renderer's `require('electron').ipcRenderer`) returns at
least one source, then screenshots the 5 deterministic stages/screens (ready
×2 source choices, templates, settings, ready-again) and diffs each against
Gate 0's baseline. Deliberately does **not** compare the countdown/
recording/review screenshots — those contain a live timer and video frames
that are non-deterministic frame-to-frame even with zero code changes, so
pixel-diffing them would be flaky rather than meaningful.

New vitest spec `src/main/events-capture.test.ts`: byte-identity of
`WINDOW_POLL_SCRIPT` between legacy and ported modules (via
`createRequire` to import the legacy CJS file), and a live-spawn test that
runs the actual script for 3s and asserts at least one well-formed
`timestamp|process|title` line.

**Important operational note for future phases:** `legacy-baseline.spec.ts`
must never be re-run as part of routine "run the whole suite" checks — doing
so overwrites `e2e/baseline/*.png` on disk (confirmed twice this phase).
Whenever the full Playwright suite is run for convenience, immediately
`git checkout -- e2e/baseline` afterward and verify `git status` is clean
there before committing.

### Gate results

- `npm test` (mask-verify) — **PASS**.
- `npm run typecheck` — **PASS**.
- `npm run test:unit` (vitest) — **PASS**, both new
  `events-capture.test.ts` cases.
- `e2e/phase1-ts-main.spec.ts` — **PASS**: `get-sources` returned ≥1 source;
  all 5 compared screenshots passed (resampled, within the 8% threshold —
  see the display-scale finding above).
- `e2e/legacy-baseline.spec.ts` re-run against `npm start` — **PASS**
  (baseline restored via `git checkout` immediately after, per the note
  above).

**Commit:** `migration: phase 1 - main process to typescript`

---

## Phase 2 - Preload and main-process providers

**Status: COMPLETE**

Added `src/preload/index.ts` (the exact bridge shape from the plan, with the
`process.contextIsolated` fallback since isolation stays off until Phase 6a)
and `src/preload/index.d.ts` (global `Window.ticketScribe` typing, pulled
into `tsconfig.web.json`'s `include` since Phase 6a's renderer will need it).
Wired `preload: path.join(__dirname, '..', 'preload', 'index.js')` into the
`src/main/index.ts` BrowserWindow.

New `src/main/providers/`: `rules.ts` (`SUMMARY_RULES` +
`buildTimelinePrompt`, byte-identical rules text, `templateContent` now
arrives as a plain string in the IPC payload instead of a `localStorage`
read, since main can't read `localStorage`), `ollama.ts` (`describeFrame` +
`generateTextSummary` + a `runOllamaPipeline` helper), `claude.ts` (same
request shape, `model: 'claude-sonnet-5'` preserved verbatim), `echo.ts`
(decision 10's test provider), `index.ts` (dispatcher + the
`nativeImage.createFromDataURL(...).getSize()` oversized-image guard against
`MODEL_IMAGE_MAX_DIMENSION` from the new `src/shared/image.ts`). New
`src/main/keys.ts`: `safeStorage`-encrypted API keys in
`<userData>/provider-keys.json`; only `setApiKey`/`hasApiKey` are exposed
over IPC, `getApiKey` is main-process-internal (used only by `claude.ts`).
`src/main/index.ts` registers `generate`, `keys:set`, `keys:has`.

**Renderer changes (the sanctioned Phase 2 bridge-repointing exception):**
all 9 `ipcRenderer.invoke` call sites in `renderer/app.js` now go through
`window.ticketScribe.*`; the top-level `require('electron').ipcRenderer` is
gone (nothing else in app.js used it). `require('./providers')` is gone —
`renderer/providers.js` itself is untouched but now unreferenced dead code,
left in place deliberately: Phase 8 is where all legacy renderer files get
deleted together, not before.

**Deviation (an explicit consequence of decision 6, not a bug):** the old
two-step Ollama flow (local `describeFrame` per frame with live "Describing
frame X of Y" progress, then a local `generateSummary` call) and the
one-shot local Claude call are replaced by a single
`window.ticketScribe.generate(request)` IPC call per generation. Fine-grained
per-frame progress text is lost (the processing stage now shows one
"Sending redacted frames to Ollama/Claude" step instead of incrementing
through each frame) because the `generate` channel the plan specifies is a
single request/response `invoke`, not a streaming one, and the plan's preload
API has no separate progress-event method. The feature itself (generate,
fail loudly, offer the raw-OCR fallback) is unchanged. `generateSummary()`
also gained a small renderer-local `activeTemplateContentForGenerate()`
(reusing app.js's own existing `loadTemplates()`/`getActiveTemplateId()`
helpers) to read the active template's content before sending it in the
payload, since that replaces `providers.js`'s `activeTemplateContent()`.

**Operational note:** the first Phase 2 Playwright run leaked a real
`provider-keys.json` (containing the test's fake Anthropic key) into
`%APPDATA%\Electron\` — Playwright's `_electron.launch({ args: [path] })`
against a loose script doesn't resolve an app identity the way a packaged
app does, so Electron fell back to the generic `Electron` userData folder
rather than `ticketscribe`. Deleted that file immediately and added a
`--user-data-dir=<temp>` switch to every launch in
`e2e/phase2-providers.spec.ts` so no test run touches real user data again.

### Gate results

- `npm test` (mask-verify) — **PASS**.
- `npm run typecheck` — **PASS**.
- `npm run test:unit` — **PASS**, 15/15 (new: `ollama.test.ts` request-shape +
  error-message cases, `claude.test.ts` request-shape + 401/refusal cases,
  `index.test.ts` oversized-image rejection + echo-provider gating, with
  `electron` mocked via `vi.mock` since vitest runs under plain Node, not a
  real Electron process).
- `npx electron-builder --dir` — **PASS**.
- `e2e/phase2-providers.spec.ts` (new) — **PASS**: API key round-trips
  through `safeStorage` across a restart, the key string appears in neither
  `localStorage` nor a window-property/DOM-HTML scan; `generate()` reaches
  the echo provider end to end over IPC; echo is confirmed unreachable
  without `TICKETSCRIBE_TEST_PROVIDER=echo`.
- `e2e/phase1-ts-main.spec.ts` re-run — **PASS**, visual parity holds (app.js
  changes were IPC-target-only, no markup/CSS touched).
- **Real-provider check:** neither `ANTHROPIC_API_KEY` nor a reachable Ollama
  at `http://localhost:11434` were available in this environment — **not
  run, no credentials**, per the plan's fallback instruction.

**Commit:** `migration: phase 2 - preload and main-process providers`

---

## Phase 3 - redact and scrub-timeline to TypeScript

**Status: COMPLETE**

Ported `renderer/redact.js` → `src/renderer/src/lib/redact.ts` (same
exports: `maskAndDownscale`, `fillMasks`, `downscale`,
`MODEL_IMAGE_MAX_DIMENSION` — the last one re-exported from
`src/shared/image.ts`, Phase 2's constant, so the renderer's downscale cap
and the main process's size guard can never drift apart) and
`renderer/scrub-timeline.js` → `src/renderer/src/lib/scrub-timeline.ts`
(`scrubText`, `scrubEvent`, `scrubEvents`, `findSensitiveWords`, all
regexes byte-identical). Types only, no logic change, per the plan.
`scrubEvent`'s `detail` is typed as a loosened `Record<string, unknown>`
internally (cast back to `ActivityEventDetail` on return) since the legacy
function treats `detail` duck-typed across all three event kinds — a
precise discriminated-union rewrite here would be a logic/shape change the
phase doesn't call for.

**Deviation (noted, not a logic change):** MIGRATION.md's Phase 3 gate text
lists "IPs" as part of the differential-test corpus. No IP-address regex
exists anywhere in `renderer/scrub-timeline.js` (its five regexes are
password/username/API-key/GUID/email) — adding one now would itself be a
logic change, which this phase explicitly forbids. Omitted from the corpus;
every regex that actually exists is covered instead.

Added `jsdom` + `@types/jsdom` as devDependencies (vitest runs these
renderer-lib tests under `// @vitest-environment jsdom` per-file, since
`scrub-timeline.ts` needs `localStorage` and `redact.ts` needs
`HTMLCanvasElement`/`document`). `redact.test.ts` stubs
`HTMLCanvasElement.prototype.getContext`/`toDataURL` (jsdom implements the
full canvas DOM interface but not real 2D rendering, and a native canvas
package wasn't worth adding just for this) so `toDataURL` reports back the
resulting canvas's own width/height — enough to verify the scaling MATH
across below-cap/at-cap/above-cap inputs, which is exactly the differential
test's stated scope; real pixel-level verification stays mask-verify's job.

### Gate results

- `npm test` (mask-verify) — **PASS** (still exercises the legacy
  `renderer/redact.js` directly; Phase 4 repoints it at `redact.ts`).
- `npm run typecheck` — **PASS**.
- `npm run test:unit` — **PASS**, 45/45. New: `scrub-timeline.test.ts`
  (corpus of password/username/API-key/GUID/email/client-name cases, plus
  the four labelled-value word-split cases from `findSensitiveWords`'
  doc comment, all compared 1:1 against the legacy module) and
  `redact.test.ts` (6 dimension cases + a masked-frame case, compared 1:1).

**Commit:** `migration: phase 3 - redact and scrub-timeline to typescript`

---

## Phase 4 - Test harnesses on the new source

**Status: COMPLETE**

Added `esbuild` as a devDependency (was already present transitively via
Vite; added explicitly since scripts now invoke it directly) and a new
`build:redact-cjs` script: `esbuild src/renderer/src/lib/redact.ts --bundle
--platform=node --format=cjs --outfile=test/.build/redact.cjs`. Wired as a
`pretest` npm lifecycle script, so plain `npm test` always rebuilds it first.
`test/mask-verify.html`'s `require()` now points at `./.build/redact.cjs`
instead of `../renderer/redact.js` — the harness code shape is unchanged,
only the required path. Per the gate's "confirm the harness actually loads
the new build" instruction, the result payload now includes
`resolvedModulePath` (`require.resolve(...)`), and `run-mask-verify.js`
fails the run (exit 3) if that path doesn't actually point into
`test/.build/redact.cjs` — so a stale build or a reverted require() can't
silently pass by exercising the wrong module. All 5 original assertions
(`secretLeaked` false, `maskFillPresent` true, `greenSurvives` true,
below-cap/above-cap downscale sizes) are unchanged.

New OCR harness: `test/ocr-verify.html` + `test/run-ocr-verify.js` (`npm run
test:ocr`), mirroring `run-mask-verify.js`'s hidden-`BrowserWindow` pattern.
Renders a known string (`TICKETSCRIBE OCR VERIFY 12345`) on a canvas with a
standard font, runs it through the **current legacy-path** tesseract.js
loading (forced browser build + `require.resolve`-derived worker/core
paths, exactly as `app.js` does today — Phase 5 changes how those paths are
derived, not this harness), and fails if `words` comes back empty or the
expected text (alphanumeric-normalized, since OCR of a clean render is
near-exact but not demanded byte-perfect) isn't found. Confirms this
environment has working network access to tesseract's CDN-hosted
`eng.traineddata` (the legacy runtime-download path) — recognized the test
string correctly first try, 4 words, no retries needed.

### Gate results

- `npm test` (mask-verify, now against `redact.ts` via the compiled build) —
  **PASS**, confirmed via `resolvedModulePath` pointing into
  `test/.build/redact.cjs`.
- `npm run test:ocr` — **PASS** (`wordCount: 4`, `foundExpectedText: true`).
- Added both to `ci.yml`.

**Commit:** `migration: phase 4 - test harnesses on the new source`

---

## Phase 5 - Tesseract asset resolution

**Status: STOPPED (WIP committed) — see "Stop reason" below.**

### What was built

- `scripts/vendor-tesseract.js` (new `postinstall` + `vendor:tesseract` +
  `prebuild:vite`/`predev:vite` npm scripts): copies
  `tesseract.js/dist/worker.min.js` and every `tesseract-core*.{js,wasm}`
  variant from `tesseract.js-core` into
  `src/renderer/public/vendor/tesseract/` (gitignored output), and downloads
  `eng.traineddata` once, caching it locally thereafter.
- **Finding, fixed:** the URL tesseract.js's own code builds by default when
  no `langPath` is given —
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata`
  (no `.gz`, no explicit package version) — is a **genuine 404**, confirmed
  directly. `@tesseract.js-data/eng`'s actual published npm/jsdelivr version
  is `1.0.0`; `4.0.0` is a subdirectory inside it (the traineddata format
  version), and only a gzip-compressed `eng.traineddata.gz` exists at
  `@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz`. This means **the
  legacy app's OCR auto-redaction has likely never worked on a genuinely
  fresh machine/profile** — Gate 0's and Phase 4's successful OCR runs in
  this environment were almost certainly served from a stale IndexedDB cache
  left by an earlier session, not a live fetch, since the live URL doesn't
  resolve. This is a pre-existing legacy-app defect, out of scope to fix
  under the legacy-code freeze; Phase 5's vendoring approach is the actual
  fix going forward. `vendor-tesseract.js` downloads the correct `.gz` URL
  and saves it locally as plain `eng.traineddata` (no `.gz` extension) —
  tesseract.js's loader only appends `.gz` to the fetch URL when an explicit
  `gzip: true` option is passed (not done here, matching the legacy call
  site), but it auto-detects and gunzips based on the file's magic bytes
  regardless of filename, so this works correctly either way.
- `electron.vite.config.ts`: added a second renderer entry, `ocrVerify`
  (`src/renderer/ocr-verify.html` / `src/renderer/src/ocr-verify.ts`) — a
  standalone page (no React, no Node APIs) that builds `workerPath`/
  `corePath`/`langPath` via `new URL('vendor/tesseract/...', document.baseURI)`
  (never root-absolute) and runs the same known-string OCR check as Phase
  4's harness, reporting via `window.__ocrVerifyDone`/`__ocrVerifyPayload`
  instead of `ipcRenderer` (this page doesn't need Node integration, matching
  where the renderer ends up after Phase 6a's isolation flip).
- `tesseract.js` moved to `devDependencies` (its browser `createWorker` API
  is now consumed at Vite **build** time via `import { createWorker } from
  'tesseract.js'`, which Vite's default `browser` field resolution handles
  correctly — unlike the legacy renderer's manual
  `require('tesseract.js/dist/tesseract.min.js')` workaround, which exists
  precisely because raw `require()` under `nodeIntegration` doesn't apply
  that resolution). Nothing in the packaged app needs it present in
  `node_modules` anymore for this new path; the legacy renderer (still
  running through Phase 8) is unaffected since it's not part of the Vite
  build and keeps resolving `tesseract.js` from `node_modules` at dev-time
  (devDependencies are present during development, only excluded from
  **packaged** output — the legacy renderer isn't packaged via `out/**`
  until Phase 7 anyway).
- **Finding, fixed:** the plan's stock CSP (`connect-src 'self'`) blocks a
  real browser behavior — WASM instantiation does an internal `fetch()` on a
  `data:` URI as part of loading the core module. Confirmed via a real CSP
  violation caught by the offline harness before the fix. Added `data:` to
  `connect-src` in both `src/renderer/index.html` and
  `src/renderer/ocr-verify.html`'s CSP meta tags.
- Two new test harnesses mirroring the established hidden-`BrowserWindow`
  pattern, loading the **built** `out/renderer/ocr-verify.html` directly
  (per the plan's own "launch compiled output directly" guidance, since
  electron-builder doesn't package `out/**` until Phase 7):
  - `npm run test:ocr:offline` (`test/run-ocr-verify-vendored.js`,
    `--proxy-server=127.0.0.1:9`): loads via `file://`, network refused.
    **PASSES**, zero CSP violations, zero console errors. This is the
    scenario that actually ships (packaged app, potentially offline/blocked
    network) and the one Phase 5's intro text calls the real risk.
  - `npm run test:ocr:dev` (`test/run-ocr-verify-dev-server.js`): starts a
    plain `vite.createServer()` with the same `root`/`base` as
    `electron.vite.config.ts`'s renderer block (a faithful stand-in for
    `electron-vite dev`'s own renderer dev server, which is just Vite
    underneath with no custom static-serving layer) and loads
    `ocr-verify.html` from it via `http://localhost:PORT`. **FAILS** — see
    below.

### Stop reason: `test:ocr:dev` fails after 5 genuine fix attempts

Phase 5's gate requires `test:ocr` to pass under **both** `electron-vite dev`
and a packaged/offline build. The offline leg passes cleanly; the dev-server
leg does not, and MIGRATION.md's stop condition ("a gate still fails after 3
genuine fix attempts") is met — 5 distinct attempts were made:

1. **CSP `connect-src: data:` fix** (described above) — necessary, fixed a
   real violation, but didn't resolve the dev-server failure.
2. **Bypassed SIMD feature-detection** by pointing `corePath` at the exact
   `tesseract-core.wasm.js` file instead of a directory (ruling out
   `wasm-feature-detect`'s `simd()` check as the cause) — no change.
3. **Inspected the raw HTTP response** for `eng.traineddata` from the dev
   server directly (`Invoke-WebRequest`): `Status 200`, correct byte count
   (10,923,060), correct gzip magic bytes (`1F 8B`) — the file genuinely
   arrives intact. One anomaly noted: `Content-Type:` is empty (Vite's
   static-file MIME guesser doesn't recognize `.traineddata`), but this
   shouldn't affect `fetch().arrayBuffer()`, which doesn't depend on
   Content-Type.
4. **Added `window.onerror`/`unhandledrejection` handlers and a 20s internal
   safety timeout** to `ocr-verify.ts` to turn what was an indefinite hang
   into a diagnosable result. This surfaced the real error: `Uncaught Error:
   initialization failed`, thrown from inside tesseract.js's bundled code
   (`node_modules/.vite/deps/tesseract__js.js`), with console warnings
   `Error opening data file ./eng.traineddata` / `Tesseract couldn't load
   any languages!` — these are native Tesseract-engine messages that occur
   when the WASM virtual filesystem never received a valid traineddata
   write, i.e. the JS-layer load succeeded enough to report progress but the
   native init still can't find usable data.
5. **Disabled tesseract.js's IndexedDB cache** (`cacheMethod: 'none'`) to
   rule out a stale/bad cache entry from an earlier failed attempt at the
   same `http://localhost:5173` origin shadowing a fresh fetch — identical
   failure, ruling this out too.

The same vendored files, same `createWorker` options shape, and same
known-string check all work correctly when loaded via `file://` (offline
leg). Something about tesseract.js's native data-loading path specifically
fails under the Vite dev server's `http://localhost` origin, and the precise
root cause is not yet identified. This is isolated to `npm run dev:vite`
(developer hot-reload convenience) — it does not affect the packaged/shipped
app, and does not touch redaction/masking (verified separately, still
passing).

### What a human needs to decide

- Whether OCR working under `npm run dev:vite` is actually required before
  resuming, or whether Phase 5's gate can be relaxed to the packaged/offline
  leg only (with dev-mode OCR tracked as a known follow-up, since the
  production path is fully verified).
- If dev-mode OCR must work: further investigation should start from the
  `Uncaught Error: initialization failed` / `node_modules/.vite/deps/
  tesseract__js.js` stack and tesseract.js's `worker-script/index.js`
  `loadAndGunzipFile` path, comparing exact byte-for-byte behavior between
  the two origins (e.g. instrument `adapter.gunzip`'s input/output lengths,
  or test whether Vite's dependency pre-bundling of `tesseract.js` itself
  — note the `.vite/deps/tesseract__js.js` path, meaning Vite is
  pre-bundling the package rather than leaving it untouched — somehow
  alters the worker-spawning code path versus a production build, where no
  such pre-bundling occurs).

### Files touched this phase (uncommitted as WIP)

`.gitignore`, `electron.vite.config.ts`, `package.json`,
`src/renderer/index.html` (CSP fix), `scripts/vendor-tesseract.js` (new),
`src/renderer/ocr-verify.html` (new), `src/renderer/src/ocr-verify.ts` (new),
`test/run-ocr-verify-dev-server.js` (new, failing),
`test/run-ocr-verify-vendored.js` (new, passing).

**Commit:** `migration: phase 5 - WIP (stopped)`

---

## Phase 6a - React renderer on legacy styles

**Status: not started**

---

## Phase 6b - Tailwind v4 conversion

**Status: not started**

---

## Phase 7 - Packaging

**Status: not started**

---

## Phase 8 - Cutover and cleanup

**Status: not started**

---

## Phase 9 - Rename to CardonetCapture

**Status: not started**

---

## Phase 10 - Azure AI provider

**Status: not started**

---

## Human verification checklist

(Copied from MIGRATION.md; will be filled in as the run progresses.)

- [ ] Source picker with **two or more displays** attached. (This run's dev
      machine has only one display — never automatically exercised.)
- [ ] Real summary via **Ollama**, **Anthropic** and **Azure** (unless the run
      had credentials and recorded a pass).
- [ ] Desktop capture of a real window and a real screen, if the run recorded
      it as not automatically verifiable.
- [ ] Install `dist/*-Setup-*.exe` silently (`/S`) as SYSTEM in **Windows
      Sandbox**: Program Files path, Start Menu shortcut, launch as a standard
      user, uninstall.
- [ ] **ThreatLocker**: blocked child processes (PowerShell spawn) or network
      (Ollama/Anthropic/Azure from the main process) in the unified audit.
- [ ] Visual review of every screen (screenshot diffs prove "unchanged", not
      "good").
- [ ] **ImmyBot** scripts and detection updated for the Phase 9 names before
      the first renamed release.
- [ ] **Phase 5 follow-up:** decide whether OCR must work under `npm run
      dev:vite` (see Phase 5's "Stop reason" above) — the packaged/offline
      path is fully verified; only the Vite-dev-server hot-reload path has
      an unresolved `Uncaught Error: initialization failed` from
      tesseract.js's bundled worker code.
