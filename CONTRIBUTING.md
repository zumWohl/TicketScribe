# Contributing

## Setup

```bash
npm install     # also vendors tesseract's OCR assets and rebuilds better-sqlite3 (postinstall)
npm start       # launch the app, hot reload
```

See the README's "Install and run" section for the full script list. If you're setting up the Claude (cloud) summary model, you'll need `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and `AZURE_OPENAI_KEY` in your environment -- there's no Settings UI for these by design (see README > Configuration). Everything else works fully offline with Ollama.

## Finding your way around

- **README.md** -- what the app does, how to run it, how redaction works, user-facing configuration.
- **CLAUDE.md** -- the detailed architecture reference: source layout, the capture/dedupe/OCR/summary/masking pipeline stage by stage, and a running list of constraints and decisions (what not to re-break, and why). Read this before touching `lib/redact.ts`, the provider dispatcher, or anything in `events-capture.ts` -- most of the non-obvious behavior in this codebase is already explained there.
- **MIGRATION.md / MIGRATION-REPORT.md** -- historical record of the CommonJS-to-TypeScript+React port. Useful for _why_ something is shaped the way it is, not a guide for new work.

## Before opening a PR

Run the same checks CI runs:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm test              # mask-verify -- redaction is safety-critical, see below
npm run test:e2e       # Playwright; slower, but required for anything touching
                        # capture, review/redact, or the generation pipeline
```

A pre-commit hook (husky + lint-staged) runs ESLint and Prettier on staged files automatically. It only touches what you've staged -- it will not reformat the rest of the repo out from under you.

**Redaction is safety-critical.** Any change to `src/renderer/src/lib/redact.ts` or the masking pipeline (`maskAndDownscale`, `fillMasks`, how masks are unioned/applied) must keep `npm test` green. That test proves masking is destructive -- the original pixels are actually gone from the output, not just covered -- at both full-resolution and downscaled sizes. Don't weaken or skip it to make a change easier to land.

**Don't upgrade `electron`, `better-sqlite3`, or `tesseract.js`** without a deliberate, separately-reviewed decision -- see CLAUDE.md's "Migration status" section for why.

**`typescript` is pinned to `~6.0.3`**, one major version behind the project's actual target, because `typescript-eslint` can't parse TypeScript ≥7 yet ([tracking issue](https://github.com/typescript-eslint/typescript-eslint/issues/10940)). A Dependabot ignore rule (`.github/dependabot.yml`) keeps it from drifting back up on its own. Move it forward once that issue resolves, not before.

## Style

- No enforced prose style beyond what ESLint/Prettier check mechanically. Match the surrounding code's density and comment style rather than introducing a new one -- this codebase favors long, specific comments that explain _why_ (a bug found, a constraint, a tradeoff) over restating _what_ the code does.
- Comments that reference a specific past bug, decision, or migration phase are intentional institutional memory, not clutter -- don't strip them during unrelated edits.
- Don't add abstractions, config options, or defensive error handling for cases that can't occur. Three similar lines beat a premature abstraction.
