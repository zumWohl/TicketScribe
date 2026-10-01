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

**Status: not started**

---

## Phase 3 - redact and scrub-timeline to TypeScript

**Status: not started**

---

## Phase 4 - Test harnesses on the new source

**Status: not started**

---

## Phase 5 - Tesseract asset resolution

**Status: not started**

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
