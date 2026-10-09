import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  include: ['apps/**/*.spec.ts', 'packages/**/*.spec.ts'],
  maxWorkers: 4,
  coverage: {
    provider: 'v8',
    reportsDirectory: '.cache/coverage/js',
    reporter: ['text-summary', 'json', 'json-summary', 'html'],
    reportOnFailure: true,
    include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts', 'apps/server/lib/**/*.js', 'packages/*/lib/**/*.js'],
    excludeAfterRemap: true,
    exclude: ['**/generated-*.{ts,js}', '**/generated_*.{ts,js}', '**/*.d.ts'],
    thresholds: {
      // Measured full-source + packaged-library baseline; browser/isolated-worker
      // journeys remain separate gates, not invented instrumented coverage.
      statements: 73, branches: 71, functions: 69, lines: 77,
      'packages/core/src/document/product-search.ts': { statements: 100, branches: 99, functions: 100, lines: 100 },
      'packages/core/src/document/presentation-budget.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
} })
