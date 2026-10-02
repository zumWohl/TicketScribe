// Flat config (ESLint 9). Type-aware linting (`recommendedTypeChecked`) is
// scoped to src/**, the only trees covered by tsconfig.node.json/web.json's
// project references -- e2e/, test/, and scripts/ get syntax-only linting
// instead of a "file not in any project" error. .mjs extension forces ESM
// parsing regardless of package.json's (absent) "type" field.
//
// typescript is pinned to ~6.0.3 (see package.json) specifically so
// typescript-eslint can parse it -- it hard-errors on TS >=7 (tracking:
// https://github.com/typescript-eslint/typescript-eslint/issues/10940).
// tsc/the actual build still run against this same pinned 6.0.3 for now;
// collapse this note once that issue resolves and the project can move back
// to a current TypeScript release across the board.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'test/.build/**',
      'src/renderer/public/vendor/**',
      '.agents/**',
      '.claude/**',
      'e2e/phase1-actual/**',
      'e2e/phase6a-actual/**',
      'e2e/baseline/**',
      '*.tsbuildinfo',
    ],
  },
  js.configs.recommended,

  // Type-aware rules for the real app source, backed by the project
  // references in tsconfig.node.json/tsconfig.web.json.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // Fire-and-forget IPC/async calls in event handlers (onClick={() => { void x(); }})
      // are an established pattern throughout App.tsx -- don't fight it.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Several IPC handlers/providers are declared async to satisfy a
      // Promise-returning contract (ipcMain.handle, the provider interface)
      // even on branches that don't need to await anything -- that's a
      // deliberate consistency choice here, not a bug.
      '@typescript-eslint/require-await': 'off',
      // events-capture.ts's require('better-sqlite3') is a guarded, optional
      // native-module load (see the try/catch around it) -- a static import
      // would defeat the whole point of degrading gracefully when it's not
      // built for the current Electron ABI.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Test files mock untyped externals (Electron APIs, fetch Responses,
  // child_process) -- the unsafe-* family is mostly noise here, not signal.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Everything else TS/JS (e2e specs, test harnesses, scripts, root config
  // files) -- syntax-only, no tsconfig project backs these.
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off', // scripts/ and some main-process code use require() deliberately
    },
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // React 19 automatic JSX runtime
      'react/prop-types': 'off', // TypeScript props are the source of truth
      // This app's review/redact canvas is deliberately imperative --
      // keyframesRef/maskOverlayRef etc. are read during render on purpose,
      // matching the pre-port architecture (see CLAUDE.md: "port not
      // redesign"). This rule targets React Compiler-style code, which this
      // app doesn't opt into.
      'react-hooks/refs': 'off',
    },
    settings: { react: { version: 'detect' } },
  },

  eslintConfigPrettier,
);
