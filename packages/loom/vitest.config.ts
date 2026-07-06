import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    root: '.',
    include: [
      'tests/**/*.test.ts',
      'tests/framework/**/*.sse.ts',
      'tests/framework/**/*.tool.ts',
      'tests/framework/**/*.subagent.ts',
      'tests/framework/**/*.stress.ts',
      'tests/framework/**/*.provider.ts',
      'tests/framework/**/*.mcp.ts',
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@loom': resolve(__dirname, 'src'),
    },
  },
})
