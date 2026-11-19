// WEB-1: typescript-eslint, type-checked. Findings that predate the gate are
// demoted to `warn` (never `off`) and ratcheted down; CI runs --max-warnings=<baseline>.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'src-tauri/**', 'external/**', 'node_modules/**', 'test-results/**', '.claude/**', 'playwright-report/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // Ratchet: the any-propagation family predates the gate (external JSON parsed
  // without validation). Demoted to warn, not off; WEB-3 removes the boundary
  // `any`s and the final step promotes these to error.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
    },
  },
  // React Compiler rules shipped with eslint-plugin-react-hooks 7. The existing
  // panels reset state in effects and create sub-components inline; rewriting them
  // changes render behaviour, so they stay visible as warnings (not off) and are
  // cleaned up panel by panel, not in the gate PR.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
  // Tests build loose fetch/WebSocket/worker mocks and read untyped fixtures; the
  // any-propagation and async-without-await rules are noise there, not defects.
  {
    files: ['tests/**/*.{ts,tsx}', 'ui-tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
  {
    files: ['**/*.js', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
