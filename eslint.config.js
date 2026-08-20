import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The dashboard and chat UIs are plain browser scripts served as static
    // files — no build step, no bundler, so they are linted with browser
    // globals rather than Node's.
    files: ['web/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        EventSource: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        alert: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        history: 'readonly',
      },
    },
  },
  // `evidence/` is run output, not source. `_scratch/` in particular is
  // git-ignored working space, and a throwaway probe script failing `npm run
  // lint` would make the gate red for a reason that never reaches the repo.
  { ignores: ['node_modules/', 'dist/', 'evidence/'] },
);
