// Flat ESLint config for the FlowMap client.
//
// Curated intentionally: typescript-eslint *recommended* (non-type-checked)
// plus react-hooks' flat recommended preset. Type-aware rules are out of scope
// — `tsc -b` is the type gate — so this adds cheap hygiene on top: unused
// vars/imports, hook dependency correctness, and the TS recommended set.
// No stylistic/formatting rules (no import sorting, no quote rules).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Generated / artifact / vendored trees are never linted.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tests/e2e/__artifacts__/**',
      'test-results/**',
      'perf_report.json',
    ],
  },

  // Base TS hygiene for every source, test and config file.
  ...tseslint.configs.recommended,

  // React hooks. eslint-plugin-react-hooks v7's `recommended-latest` bundles
  // the React Compiler diagnostics (react-hooks/refs, /set-state-in-effect,
  // /preserve-manual-memoization, /immutability, ...). Those flag 40+ existing
  // patterns across files this config change leaves alone (client/src/App.tsx and
  // friends) and fixing them is a behavior-level rewrite, not lint tooling —
  // so the gate keeps the two classic correctness rules. Migrating to the
  // compiler rules is an open follow-up; it is not scheduled yet.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Browser globals for the app and its jsdom tests; Node globals for the
  // tooling side (vite/vitest/playwright configs, scripts/*.mjs).
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.{js,mjs,cjs,ts}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },

  // Warning budget: `npm run lint` runs with `--max-warnings 0`. The tree is
  // clean, so any new warning fails the gate. Do not raise the budget; fix the warning.
  //
  // Rule curation for the pre-existing tree:
  // - unused vars: allow the conventional `_`-prefixed deliberate ignores.
  // - `any`: kept as a visible warning. The e2e specs reach window hooks through one
  //   documented alias (client/tests/e2e/probe.ts), so the rule is not disabled there.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Token discipline: colours and font sizes in application TypeScript come
  // from the theme tokens in src/theme, not from literals. This covers TS/TSX only,
  // because ESLint does not parse CSS: the stylesheet half of the gate is
  // src/theme/tokenDiscipline.test.ts (font floor and ratchet). The gate is
  // a ratchet. Files listed in the exemption block below predate the rule and may
  // keep their literals; a literal in any other file is an error.
  // Shrink the exemption list as sites move to tokens. Do not add files to it.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/theme/**', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='fontSize'] > Literal[raw=/^.?[0-9.]+(px)?.?$/]",
          message: 'Use a font-size token from src/theme instead of a raw px value.',
        },
        {
          // Plain strings and the static parts of template literals.
          selector:
            'Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/], TemplateElement[value.raw=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: 'Use a theme token from src/theme instead of a hex colour literal.',
        },
        {
          selector: 'Literal[value=/^rgba?[(]/], TemplateElement[value.raw=/^rgba?[(]/]',
          message: 'Use a theme token from src/theme instead of an rgb()/rgba() literal.',
        },
      ],
    },
  },
  // Ratchet exemptions: the sites that predate the token rule, verified by search at
  // this revision. Each one is a candidate for migration to src/theme tokens.
  {
    files: [
      'src/drawings/painter.ts',
      'src/drawings/types.ts',
      'src/gl/lut.ts',
      'src/gl/overlays/palette.ts',
      'src/gl/overlays/priceLine.ts',
      'src/gl/textLayer.ts',
      'src/ui/CvdPane.tsx',
      'src/ui/DrawToolbar.tsx',
      'src/ui/IndicatorOverlayCanvas.tsx',
      'src/ui/IndicatorPicker.tsx',
      'src/ui/SettingsDrawer.tsx',
      'src/ui/exportPng.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // Function size: no function in application source may exceed the line budget.
  // The budget is the largest function on the tree (SymbolSearch, 403 lines) rounded
  // up to a multiple of 50. Lower it as the large components are split. Tests are
  // excluded because table-driven specs are long by nature.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'max-lines-per-function': ['error', { max: 450 }],
    },
  },
);
