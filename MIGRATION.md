# MIGRATION.md

Plan to move TicketScribe from plain CommonJS Electron (`nodeIntegration: true`, no
bundler) to **TypeScript + React + Tailwind v4 + Vite**, built with **electron-vite** and
packaged with **electron-builder**.

## Execution mode: single autonomous run

This plan is executed in **one run**, Phase 0 through Phase 10, without stopping for
human review between phases. That only works because every phase ends in an
**automated gate** that Claude runs itself. The rules:

1. **Gate before commit.** A phase is finished only when every command in its Gate
   passes. Then commit with the message `migration: phase N - <title>` and move on.
   One commit per phase (fix-up commits within a phase are fine), so any phase can be
   reverted on its own.
2. **Never make a gate pass by weakening it.** Do not edit, skip, delete, loosen or
   `.skip`/`.only` any test, assertion, threshold, or screenshot baseline to get a
   green result. Do not add `|| true`, `continue-on-error`, or try/catch around test
   code. If a gate can only pass by changing the test, that is a stop condition.
3. **Stop conditions.** Stop the run (do not continue to the next phase) if:
   - a gate still fails after 3 genuine fix attempts;
   - passing would require breaking a constraint in this file or CLAUDE.md;
   - the mask-verify test fails at any point and the cause isn't obvious;
   - you need a decision this plan doesn't make.
   When stopping: commit the work-in-progress on the branch with message
   `migration: phase N - WIP (stopped)`, write the reason in MIGRATION-REPORT.md, and
   end the run with a summary.
4. **Progress log.** Keep `MIGRATION-REPORT.md` updated **as you go**, not at the end:
   for each phase record the commit SHA, every gate command with pass/fail, any
   deviation from this plan and why, and anything that could not be tested
   automatically. This file is also how a resumed session picks up after a context
   compaction or a restart: read it first, continue from the first phase not marked
   complete.
5. **Things you must never do in this run:** `git push`, `git tag`, merge into `main`,
   `npm audit fix --force`, edit `.github/workflows/release.yml` before Phase 9, or
   install global packages.

At the end of a successful run, MIGRATION-REPORT.md must contain the **Human
verification checklist** from the bottom of this file, filled in with exactly what the
human still needs to test.

## Decisions

1. **Installed base is zero.** No settings or API keys exist in the field, so no data
   migration is needed. The identity constraints (appId, productName, executableName,
   artifactName, `Documents\TicketScribe`, localStorage key names) still stay frozen
   through Phase 8 so each phase's diff is about one thing.
2. **Rename to CardonetCapture is its own Phase 9**, after the port.
3. **Tailwind v4 via `@tailwindcss/vite`**, configured in CSS only (`@import
   "tailwindcss"` plus `@theme`). No `tailwind.config.ts` anywhere.
4. **The earlier CardonetCapture draft is abandoned.** Start from TicketScribe's current
   source only.
5. **Production keeps `loadFile` over `file://`.** No custom protocol. HaloPSA auth is
   out of scope.
6. **Provider calls (Ollama, Anthropic, later Azure) move to the main process in
   Phase 2.** Recorded exception to "port, not redesign": keys leave the renderer and
   the CSP keeps `connect-src` closed.
7. **`eng.traineddata` is bundled locally and loaded via `langPath`.** Recorded
   exception: removes the runtime jsdelivr download, which fails silently on locked-down
   networks and disables auto-masking.
8. **Azure AI (static API key) is a third provider, added in Phase 10.**
9. **Automated end-to-end testing uses Playwright's Electron support** (`playwright`
   devDependency, `_electron.launch`). Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when
   installing; no browser binaries are needed to drive Electron.
10. **Providers get a test double.** When the main process starts with
    `TICKETSCRIBE_TEST_PROVIDER=echo`, the `generate` handler returns a fixed summary
    built from its inputs (image count, timeline length) instead of calling a network
    provider. This exists only for automated tests; it must not be reachable without
    the env var, and it is documented in CLAUDE.md.

## Scope snapshot

- `main.js` (103 lines): window, 6 `ipcMain.handle` channels, lifecycle. No preload,
  `nodeIntegration: true`, `contextIsolation: false`.
- `main/events-capture.js` (337 lines): PowerShell window-focus poller (inline C#
  P/Invoke), PSReadLine history diffing, opt-in transcript capture, `better-sqlite3`
  browser history behind a `try/catch` require.
- `renderer/`: `index.html` plus `app.js`, `providers.js`, `redact.js`,
  `scrub-timeline.js`, loaded through one `<script src="app.js">`. `app.js` has 9
  `ipcRenderer.invoke` call sites over 6 channels (`get-sources` x4, the rest x1).
- `electron-builder.yml`: `asar: false`, `files` allowlist, NSIS x64.
- `test/run-mask-verify.js` + `test/mask-verify.html`: hidden-window destructive
  masking test, `require('../renderer/redact.js')`. Run by `npm test`.
- `.github/workflows/release.yml`: tag-only, never runs tests.
- CLAUDE.md's "no tests configured" line is wrong (`npm test` exists). Fix it in
  Phase 8.

## Non-negotiable constraints (every phase)

- Behaviour must not change, apart from decisions 6, 7 and 10.
- Redaction stays destructive and full-res-before-downscale. `npm test` (mask-verify)
  passes at every gate. Its 5 assertions (`secretLeaked` false, `maskFillPresent`
  true, `greenSurvives` true, below-cap and above-cap downscale sizes) are never
  removed or weakened.
- Through Phase 8, do not change: `appId`, `productName`, `executableName`,
  `artifactName`, `Documents\TicketScribe`, any `localStorage` key name,
  `package.json` `name`, the transcript dir `os.tmpdir()/ticketscribe-transcripts`, or
  the PowerShell profile snippet text (including `$global:TicketScribeTranscriptStarted`).
  Do not add `productName` to `package.json`.
- Do not upgrade `electron`, `better-sqlite3`, or `tesseract.js`.
- Do not add `"type": "module"` to `package.json`. Main and preload stay CommonJS (a
  sandboxed preload cannot be ESM).
- Preserve `ls()` semantics exactly: `localStorage.getItem(k) || d` (empty string
  falls back to default). Never port it to `??`.
- Never point `package.json` `main` at build output before Phase 8. Launch compiled
  output directly: `npx electron out/main/index.js`.
- Legacy code freeze: no feature changes to `renderer/` or `main.js` except the Phase 2
  bridge repointing. Bug fixes go into both legacy and new code.
- The `v0.1.0` tag already exists and is the rollback baseline. Do not create, move or
  delete tags.

---

## Gate 0 - Baseline (before any change)

Capture the current behaviour so later gates have something to compare against.

- `npm ci` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` once Playwright is added) and
  `node node_modules/electron/install.js` if Electron's binary is missing.
- `npm test` must print `MASK VERIFY: PASS`. If it doesn't, stop: there is no safety
  net to migrate against.
- Add `playwright` as a devDependency. Write `e2e/legacy-baseline.spec.ts` that
  launches the **legacy** app (`_electron.launch({ args: ['.'] })`), walks every
  reachable stage and screen (ready, settings, templates, source picker, and as far
  into recording/review as works without real providers), and saves screenshots to
  `e2e/baseline/`. Commit the baseline images. These are the visual-parity reference
  for Phase 6a and 6b; never regenerate them after this gate.
- Record in MIGRATION-REPORT.md which stages could and couldn't be reached
  automatically.
- Commit: `migration: gate 0 - baseline`.

## Phase 0 - Scaffolding alongside the legacy app

- devDependencies: `electron-vite`, `vite`, `typescript`, `@vitejs/plugin-react`,
  `tailwindcss`, `@tailwindcss/vite`, `vitest`, `@types/node`, `@types/react`,
  `@types/react-dom`. Runtime: `react`, `react-dom`. Toolchain stays in
  devDependencies (with `asar: false`, anything in `dependencies` ships unpacked).
- `electron.vite.config.ts` with `main`, `preload`, `renderer` targets pointing at
  stub `src/main`, `src/preload`, `src/renderer`. Renderer `base: './'` (absolute
  `/` breaks under `file://`).
- `tsconfig.json` (split configs if the template wants them), `strict: true`.
- Tailwind per decision 3 in `src/renderer/src/index.css`.
- CSP `<meta>` in the stub renderer HTML:
  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
  connect-src 'self'
  ```
  `'self'` behaves inconsistently under `file://`, so this is re-checked against
  packaged builds in Phases 5 and 7.
- New scripts alongside the old ones: `dev:vite`, `build:vite`, `typecheck`
  (`tsc --noEmit` across all configs), `test:unit` (vitest), `test:e2e` (Playwright).
  `start`, `dev`, `dist`, `rebuild`, `test` stay pointed at legacy code.
- New PR workflow `.github/workflows/ci.yml` (leave `release.yml` alone): on
  `pull_request`, `windows-latest`: `npm ci`, `npm test`, `npm run typecheck`,
  `npm run test:unit`, `npm run build:vite`, `npx electron-builder --dir`, and upload
  the `--dir` output as an artifact. Add the OCR harness and e2e to it when they exist.

**Gate:** `npm test` passes; `npm run typecheck` passes; `npm run build:vite`
succeeds; a Playwright smoke test launches the built stub
(`out/main/index.js`) and asserts the window opens with zero console errors and zero
CSP violations; `npx electron-builder --dir` produces an output folder whose exe
launches the stub (Playwright `executablePath`); the legacy e2e baseline spec still
passes against `npm start`'s app.

## Phase 1 - Main process to TypeScript

- `src/main/index.ts` from `main.js`: same `BrowserWindow` options (isolation still
  off), loads the **legacy** `renderer/index.html` (path adjusted for `out/main/`),
  same 6 channels (`get-sources`, `save-summary`, `open-folder`, `events:start`,
  `events:stop`, `events:get-transcript-snippet`), same save path, same lifecycle.
- `src/main/events-capture.ts` 1:1 from `main/events-capture.js`. Type the module
  singletons; don't turn them into a class. Keep the `better-sqlite3` `try/catch`
  require.
- Export `WINDOW_POLL_SCRIPT` from both the legacy and the new module.
- `src/shared/events.ts`: `{ type, timestamp, detail, durationMs?, category? }`.

**Gate:** `npm test`; `npm run typecheck`; a vitest test asserting the legacy and new
`WINDOW_POLL_SCRIPT` strings are byte-identical; a vitest test spawning the poller
script for ~3 seconds and asserting at least one well-formed line (3+ `|`-separated
fields, numeric timestamp) is emitted; a Playwright test launching
`out/main/index.js` and asserting the legacy UI loads and `get-sources` returns at
least one source; the legacy baseline screenshots still match within the threshold set
in Gate 0.

## Phase 2 - Preload and main-process providers

- `src/preload/index.ts` with the `process.contextIsolated` fallback (isolation is
  still off):
  ```ts
  const api = {
    getSources: (opts) => ipcRenderer.invoke('get-sources', opts),
    saveSummary: (payload) => ipcRenderer.invoke('save-summary', payload),
    openFolder: () => ipcRenderer.invoke('open-folder'),
    eventsStart: (opts) => ipcRenderer.invoke('events:start', opts),
    eventsStop: (opts) => ipcRenderer.invoke('events:stop', opts),
    getTranscriptSnippet: () => ipcRenderer.invoke('events:get-transcript-snippet'),
    generate: (payload) => ipcRenderer.invoke('generate', payload),
    setApiKey: (provider, key) => ipcRenderer.invoke('keys:set', provider, key),
    hasApiKey: (provider) => ipcRenderer.invoke('keys:has', provider),
  }
  if (process.contextIsolated) contextBridge.exposeInMainWorld('ticketScribe', api)
  else (window as any).ticketScribe = api
  ```
  Plus `src/preload/index.d.ts` typing `window.ticketScribe`.
- Repoint all 9 `ipcRenderer.invoke` sites in `renderer/app.js` to
  `window.ticketScribe.*`. The legacy app must stay fully working.
- `generate` channel in `src/main/providers/`: port `SUMMARY_RULES`,
  `buildTimelinePrompt`, `ollamaGenerate`, `providers.ollama`, `providers.claude`.
  The renderer sends only non-secret data (Ollama URL and model names, template
  content, masked+downscaled image data URLs, scrubbed timeline).
- Implement decision 10 (`TICKETSCRIBE_TEST_PROVIDER=echo`).
- API keys via `safeStorage` in a file under `userData`, with `keys:set` / `keys:has`.
  Never readable from the renderer.
- `generate` rejects any image whose long edge exceeds `MODEL_IMAGE_MAX_DIMENSION`
  (via `nativeImage.createFromDataURL().getSize()`). Comment honestly: this proves the
  downscale ran, not that masking ran.

**Gate:** `npm test`; `npm run typecheck`; vitest unit tests for the providers module
with `fetch` mocked: correct Ollama and Anthropic request shapes, prompt contains
`SUMMARY_RULES` and the timeline, oversized image rejected, provider errors propagate
as thrown errors; Playwright test (legacy UI via `out/main/index.js`, echo provider)
that saves a key, restarts the app, asserts `hasApiKey` is true, and asserts the key
string appears nowhere in `localStorage` or `window` (serialise and search); legacy
baseline screenshots still match. If `ANTHROPIC_API_KEY` or a reachable Ollama
(`OLLAMA_URL`) is present in the environment, also run one real summary per available
provider and record the result; if not, record "not run, no credentials".

## Phase 3 - redact and scrub-timeline to TypeScript

- `src/renderer/src/lib/redact.ts`: same exports (`maskAndDownscale`, `fillMasks`,
  `downscale`, `MODEL_IMAGE_MAX_DIMENSION`), same full-res coordinate contract. Types
  only, no logic change.
- `src/renderer/src/lib/scrub-timeline.ts`: regexes and `scrubText`, `scrubEvent`,
  `scrubEvents`, `findSensitiveWords` unchanged; still reads `scrubClientNames` from
  `localStorage` under the same key.

**Gate:** `npm test`; `npm run typecheck`; vitest **differential tests** that run the
same inputs through the legacy `.js` and new `.ts` modules and assert identical output:
for scrub-timeline, a corpus covering every regex (IPs, emails, tokens, the
multi-token `Password = ...` case, client names); for redact's pure helpers, the
computed downscale dimensions across below-cap, at-cap and above-cap inputs.

## Phase 4 - Test harnesses on the new source

- Repoint mask-verify at `redact.ts` through a small standalone CJS build (esbuild or
  `tsc --module commonjs` for that file) so the existing Electron-window harness keeps
  `require()`-ing it unchanged. Keep all 5 assertions.
- New OCR harness (`npm run test:ocr`): render a known string on a canvas with a
  standard font, run the app's `createWorker`/`recognize` path, fail if `words` is
  empty or the expected text isn't found. Run it against the current (legacy-path)
  OCR loading first to get a baseline.
- Add both to `ci.yml`.

**Gate:** `npm test` passes against `redact.ts` (confirm the harness actually loads
the new build, e.g. by checking the required path); `npm run test:ocr` passes.

## Phase 5 - Tesseract asset resolution

- Vendor three asset sets into `src/renderer/public/vendor/tesseract/` via a
  `postinstall`/prebuild copy script (gitignore the output): `tesseract.js/dist/worker.min.js`,
  the `tesseract.js-core` `tesseract-core*.js`/`.wasm` files, and `eng.traineddata`.
- Build URLs relative to the document, never root-absolute:
  `new URL('vendor/tesseract/worker.min.js', document.baseURI).href`, same for
  `corePath` and `langPath`.
- `createWorker('eng', 1, { workerPath, corePath, langPath, logger: () => {} })` as
  today; only the path derivation changes.
- Move `tesseract.js` to devDependencies once vendored.

**Gate:** `npm run test:ocr` passes under `electron-vite dev` **and** against an
`electron-builder --dir` build launched with network access blocked (start the app
with `--proxy-server=127.0.0.1:9` or equivalent so any CDN fetch fails); zero CSP
violations in both runs.

## Phase 6a - React renderer on legacy styles

- Import `styles.css` unchanged; keep every class name and the
  `document.body.dataset.screen` / `.stage` mechanism.
- Components named after the stage classes (`.stage-ready`, `.stage-recording`,
  `.stage-review`, `.stage-processing`, `.stage-sent`). Port the capture pipeline
  (1500 ms interval, the `mandatory: { chromeMediaSource: 'desktop', maxWidth: 1920,
  maxHeight: 1080, maxFrameRate: 2 }` constraints), frame dedup (`aHash`/`hamming`),
  OCR via Phase 5, `generate` via Phase 2, Templates CRUD, Settings.
- Port the review/redact canvas **last**.
- At the end, set `contextIsolation: true`, `nodeIntegration: false` (renderer
  sandbox on) and re-run everything.

**Gate (run after the isolation flip):** `npm test`; `npm run test:ocr`;
`npm run typecheck`; `npm run test:unit`; a Playwright end-to-end test against the
**packaged** `--dir` build with the echo provider: pick a window source, record ~5
seconds, assert at least one keyframe captured, draw one mask on the review canvas,
generate, assert the summary appears, save, assert a file exists under
`Documents\TicketScribe` with the expected content, then delete that file. Screenshot
every stage and compare against `e2e/baseline/` (pixel diff threshold set in Gate 0;
differences above it fail the gate). If desktop capture returns no frames in the test
environment, record it as "not verifiable automatically" rather than stubbing capture.

## Phase 6b - Tailwind v4 conversion

- Tailwind configured per decision 3; `@theme` holds the Cardonet palette and the
  bundled Open Sans.
- Convert component by component; remove `styles.css` only when nothing uses it.

**Gate:** everything from Phase 6a's gate again, including the screenshot comparison
against the **Gate 0** baseline (not a regenerated one).

## Phase 7 - Packaging

- `electron-builder.yml` `files` for `out/main/`, `out/preload/`, `out/renderer/`.
  Keep `asar: false`. Keep `appId`, `productName`, `executableName`, `artifactName`.
- Scripts: `start`/`dev` run electron-vite dev; `dist` runs
  `electron-vite build && electron-builder --win nsis --x64 --publish never`; `rebuild`
  unchanged.

**Gate:** `npm run dist` produces `dist/TicketScribe-Setup-0.1.0-x64.exe`; list the
shipped `node_modules` in the `--dir` output and assert it contains `better-sqlite3`
and its runtime deps only (no vite, react, tailwind, typescript, playwright,
tesseract.js); run the full Phase 6a e2e test, mask-verify and the OCR harness against
the packaged build; zero CSP violations. Do **not** run the NSIS installer itself
(installing to Program Files is a human step).

## Phase 8 - Cutover and cleanup

- Delete `renderer/*.js`, `renderer/index.html`, `renderer/styles.css` (move
  `renderer/assets/` into the new pipeline if not done), root `main.js`,
  `main/events-capture.js`. Remove the legacy-vs-new differential tests and the
  `WINDOW_POLL_SCRIPT` equality test, since one side no longer exists; keep every other
  test.
- `package.json` `main` to the compiled entry.
- Update README.md and CLAUDE.md (new layout, contextBridge API, main-process
  providers, safeStorage, echo provider, test commands; fix the "no tests" line).

**Gate:** in a fresh clone of the branch in a temp directory: `npm ci`,
`npm test`, `npm run typecheck`, `npm run test:unit`, `npm run test:ocr`,
`npm run dist`, e2e against the packaged build. `git grep` finds no references to the
deleted files.

## Phase 9 - Rename to CardonetCapture

- `electron-builder.yml`: `appId`, `productName`, `executableName`, `artifactName`.
- `.github/workflows/release.yml`: the installer glob and release title.
- `package.json` `name`; `Documents\TicketScribe`; transcript dir; the
  `$global:TicketScribeTranscriptStarted` variable and profile snippet.
- README.md, CLAUDE.md, MIGRATION.md, window title (already "Cardonet Capture").
- Repo-wide `git grep -i ticketscribe` and handle every remaining hit.
- **Outside this repo (do not attempt, list in the report):** the ImmyBot Dynamic
  Versions script regex, the ImmyBot install script's `$ProcessName` and `$ExePath`,
  and the ImmyBot detection string must all change to the new names in the same
  release. Any machine that already has TicketScribe installed needs the old app
  uninstalled first.

**Gate:** everything from Phase 8's gate under the new names; `npm run dist` produces
the renamed installer; `git grep -i ticketscribe` returns only intentional references
(list them in the report).

## Phase 10 - Azure AI provider

- `POST https://<resource>.openai.azure.com/openai/v1/chat/completions`, `api-key`
  header, deployment name in `model`. Not the deprecated
  `services.ai.azure.com/models` route. Plain `fetch` from the main process.
- One call with every masked keyframe as `image_url` data URLs plus the scrubbed
  timeline and shared `SUMMARY_RULES`, reusing Phase 2's prompt construction.
- Settings: endpoint and deployment (non-secret, localStorage) plus key via
  `safeStorage`. Validate on save that the deployment accepts images.
- Distinct messages for 401/403 (key), 404 (deployment), 429 (rate limit) and
  content-filter rejections. Keep throw-on-failure and the "Use raw OCR text instead"
  fallback.
- Document key rotation (key1/key2) and UK South provisioning.

**Gate:** vitest with `fetch` mocked: request URL, headers, body shape and image
encoding; each of 401, 403, 404, 429 and a content-filter response maps to its distinct
message and throws; Playwright test with the echo provider still passes; if
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` and `AZURE_OPENAI_KEY` are set, run
one real summary and record it, otherwise record "not run, no credentials". Full
regression: `npm test`, `npm run test:ocr`, `npm run typecheck`, `npm run test:unit`,
packaged e2e.

---

## High-risk areas

### 1. Tesseract worker/wasm/language paths (Phase 5)

Today's OCR depends on `require.resolve` in the renderer, the forced browser build
(`tesseract.js/dist/tesseract.min.js`, because the Node entry's `worker_threads` worker
can't run in Electron's renderer), and `pathToFileURL`. All three disappear once
`nodeIntegration` is off. Root-absolute vendored URLs resolve against the filesystem
root under `file://` and fail only in the packaged build. The runtime CDN download of
`eng.traineddata` fails silently on blocked networks. Every one of these degrades to
"OCR returns no words", which silently disables auto-redaction. That's why Phase 5 is
isolated and gated against a packaged, offline build.

### 2. better-sqlite3 (Phases 1, 7)

The `try/catch` require must survive byte-for-byte. Packaging risk is avoided by
keeping `asar: false`.

### 3. Inline PowerShell (Phase 1)

`WINDOW_POLL_SCRIPT` is an opaque string. Formatters, lint auto-fixes or "tidying" can
break its quoting or the `-replace "\|", "/"` escaping, and the stdout parser silently
drops malformed lines, so breakage shows up as missing activity, not a crash. Gated by
the byte-identity test and a live poller test.

### 4. localStorage (Phases 2, 6a)

Lives under `userData`, derived from `package.json` `name`, frozen until Phase 9.
`ls()` uses `||`, not `??`. The dev server origin and `file://` have separate storage,
so persistence is only verified against packaged builds. API keys leave localStorage
entirely in Phase 2.

### 5. CSP (Phases 0, 5, 7)

Needs `wasm-unsafe-eval` and `worker-src blob:` for tesseract. Dev-server origin can
hide `file://` problems, so it's re-checked against packaged builds.

### 6. Renderer sandbox (Phase 6a)

Turning off `nodeIntegration` turns on the sandbox. Preload must be CommonJS.
Desktop capture with the `mandatory` constraints has never run sandboxed in this app.

---

## Human verification checklist (copy into MIGRATION-REPORT.md at the end)

Automated gates can't cover these. Fill in which ones the run did or didn't touch:

- [ ] Source picker with **two or more displays** attached.
- [ ] Real summary via **Ollama**, **Anthropic** and **Azure** (unless the run had
      credentials and recorded a pass).
- [ ] Desktop capture of a real window and a real screen, if the run recorded it as
      not automatically verifiable.
- [ ] Install `dist/*-Setup-*.exe` silently (`/S`) as SYSTEM in **Windows Sandbox**:
      Program Files path, Start Menu shortcut, launch as a standard user, uninstall.
- [ ] **ThreatLocker**: blocked child processes (PowerShell spawn) or network
      (Ollama/Anthropic/Azure from the main process) in the unified audit.
- [ ] Visual review of every screen (screenshot diffs prove "unchanged", not "good").
- [ ] **ImmyBot** scripts and detection updated for the Phase 9 names before the first
      renamed release.
