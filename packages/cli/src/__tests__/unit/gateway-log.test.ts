import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redirectConsoleToFile } from '../../gateway-log.js'

let tempRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'ownware-cli-log-'))
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
}

describe('redirectConsoleToFile', () => {
  it('routes every console method to the file and restores on dispose', async () => {
    const file = join(tempRoot, 'nested', 'gateway.log')
    const originalLog = console.log
    const restore = redirectConsoleToFile(file)

    expect(console.log).not.toBe(originalLog)
    console.log('[boot-trace] hello %d', 42)
    console.warn('[loom/pricing] fallback')
    console.error('bad thing')
    restore()
    await settle()

    expect(console.log).toBe(originalLog)
    const content = readFileSync(file, 'utf-8')
    expect(content).toContain('[log] [boot-trace] hello 42')
    expect(content).toContain('[warn] [loom/pricing] fallback')
    expect(content).toContain('[error] bad thing')
  })

  it('restore is idempotent and a second redirect works', async () => {
    const file = join(tempRoot, 'gateway.log')
    const restore = redirectConsoleToFile(file)
    restore()
    restore()

    const restore2 = redirectConsoleToFile(file)
    console.log('second round')
    restore2()
    await settle()
    expect(readFileSync(file, 'utf-8')).toContain('second round')
  })
})
