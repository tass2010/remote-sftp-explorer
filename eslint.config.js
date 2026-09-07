// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Import boundaries that TypeScript's `types` option cannot express.
 *
 * See docs/02-architecture.md: omitting "vscode" from a project's `types` array does not stop
 * an explicit `import ... from 'vscode'`, because `types` governs only auto-included global
 * type packages. The compiler catches ambient-global leaks (`Buffer`, `process`); these rules
 * and core/test/architecture.test.ts catch module-level leaks.
 */
const forbidVscode = {
  paths: [
    {
      name: 'vscode',
      message:
        'Only the extension package may import vscode. Depend on a port from core/ports and ' +
        'let the extension supply the adapter -- see docs/02-architecture.md.'
    }
  ],
  patterns: [
    {
      group: ['@remote-sftp-explorer/*/*'],
      message: 'Import the package root, not a path inside it.'
    }
  ]
};

export default tseslint.config(
  {
    // Build outputs, not sources. These live inside the packages, so the globs must be
    // rooted anywhere rather than at the repository top.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/media/**',
      '**/target/**',
      '**/bin/**'
    ]
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': ['error', forbidVscode]
    }
  },

  {
    files: ['src/packages/sftp-protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...forbidVscode,
          patterns: [
            ...forbidVscode.patterns,
            {
              group: ['node:*', '@remote-sftp-explorer/*'],
              message:
                'sftp-protocol is I/O-free and sits at the bottom of the dependency graph ' +
                '(ADR-0002). Take an injected ByteChannel instead.'
            }
          ]
        }
      ]
    }
  },

  {
    files: ['src/packages/extension/webview/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...forbidVscode,
          patterns: [
            ...forbidVscode.patterns,
            {
              group: ['node:*'],
              message: 'The webview client runs in a sandboxed iframe: DOM APIs only.'
            }
          ]
        }
      ]
    }
  },

  {
    // The extension package is the composition root and is allowed to see vscode.
    files: ['src/packages/extension/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [], patterns: forbidVscode.patterns }]
    }
  },

  {
    // Tests may reach for anything; they exist to exercise the boundaries, not to obey them.
    files: ['src/packages/*/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off'
    }
  },

  {
    // Build scripts run under node, outside any package.
    files: ['*.mjs', '*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' }
    }
  }
);
