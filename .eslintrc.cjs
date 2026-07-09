/**
 * Strict, TypeScript-aware ESLint config. `eslint-config-prettier` is last so it
 * disables any stylistic rules that would fight Prettier (formatting is Prettier's job).
 */
module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // House rule: no `any`.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    'no-console': 'off',
  },
  ignorePatterns: [
    'out/',
    'dist/',
    'node_modules/',
    '*.config.ts',
    '*.config.js',
    '*.cjs',
  ],
};
