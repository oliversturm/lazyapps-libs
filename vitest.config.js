import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    hookTimeout: 60000,
    isolate: true,
    projects: [
      {
        extends: true,
        test: {
          include: ['packages/*/tests/**/*.test.js'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/**/*.js'],
      exclude: [
        '**/node_modules/**',
        '**/tests/**',
        '**/test/**',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
})
