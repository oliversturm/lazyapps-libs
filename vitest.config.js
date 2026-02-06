import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    hookTimeout: 60000,
    projects: ['packages/*'],
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
