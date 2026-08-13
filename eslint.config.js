// @ts-check

/**
 * Lint rules.
 *
 * Chosen narrowly. A rule earns its place here by catching something that could
 * plausibly cost money in this codebase — a floating promise that drops an
 * order, an `any` that lets a wrong type reach the broker — not by being part
 * of a popular preset. Style is left to the type checker and to review, because
 * a lint run that mostly reports formatting trains people to skip reading it.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'public/**', 'coverage/**', 'node_modules/**', 'eslint.config.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },

    rules: {
      // The one that matters most here. An unawaited promise in the order path
      // is an order whose outcome nobody is watching: the tick returns, the
      // process may exit, and the rejection surfaces — if at all — as an
      // unhandled rejection with no context. `void` remains available for the
      // genuinely fire-and-forget cases, which is why those are spelled that
      // way throughout.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Money and quantities are numbers; a stray `any` reaching them defeats
      // every other guarantee in the type system.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Unused code is usually a half-finished edit. Leading underscore opts
      // out, for the signatures an interface forces on an implementation.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `==` against null is the intended idiom in a few places; everywhere
      // else the loose comparison is a mistake.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',

      // Off deliberately. The repositories implement async ports synchronously
      // — the in-memory ones have nothing to await, and that is the point of
      // having them — so this rule fires 121 times on correct code and would
      // push someone towards inserting pointless awaits to silence it.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Build and config scripts are plain CommonJS and outside the TypeScript
    // project, so the type-aware rules have nothing to work from.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', console: 'readonly', process: 'readonly' },
    },
    rules: {
      // These files are CommonJS by design — they run under plain node, before
      // and independently of any build.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // Tests reach into internals and build deliberately malformed inputs; that
    // is their job. Type safety still applies — these relax only the rules that
    // would fight the fixtures.
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
