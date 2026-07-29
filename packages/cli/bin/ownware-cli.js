#!/usr/bin/env node
import('../dist/index.js').then((m) => m.main(process.argv.slice(2))).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
