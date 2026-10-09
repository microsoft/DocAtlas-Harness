import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  include: ['apps/**/*.spec.ts', 'packages/**/*.spec.ts'],
  maxWorkers: 4,
} })
