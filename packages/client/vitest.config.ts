import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
})
