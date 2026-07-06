import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryPairingStore, FilePairingStore, PairingRateLimitError } from '../pairing.js'

describe('InMemoryPairingStore', () => {
  it('unknown user is not approved; approving a valid code approves them', async () => {
    const p = new InMemoryPairingStore({ generateCode: () => 'CODE1234' })
    expect(await p.isApproved('telegram', 'u1')).toBe(false)
    const code = await p.requestCode('telegram', 'u1')
    expect(code).toBe('CODE1234')
    expect(await p.approveCode('telegram', 'CODE1234')).toEqual({ approved: true, userId: 'u1' })
    expect(await p.isApproved('telegram', 'u1')).toBe(true)
  })

  it('a wrong code does not approve', async () => {
    const p = new InMemoryPairingStore({ generateCode: () => 'RIGHT111' })
    await p.requestCode('telegram', 'u1')
    expect(await p.approveCode('telegram', 'WRONG999')).toEqual({ approved: false })
    expect(await p.isApproved('telegram', 'u1')).toBe(false)
  })

  it('approval is case-insensitive and trims whitespace', async () => {
    const p = new InMemoryPairingStore({ generateCode: () => 'ABCD2345' })
    await p.requestCode('tg', 'u1')
    expect((await p.approveCode('tg', '  abcd2345 ')).approved).toBe(true)
  })

  it('rate-limits repeat requests within the cooldown', async () => {
    let t = 1000
    const p = new InMemoryPairingStore({ now: () => t, cooldownMs: 10_000, generateCode: () => 'X' })
    await p.requestCode('tg', 'u1')
    await expect(p.requestCode('tg', 'u1')).rejects.toBeInstanceOf(PairingRateLimitError)
    t += 10_001
    await expect(p.requestCode('tg', 'u1')).resolves.toBeTypeOf('string')
  })

  it('locks out a channel after too many failed approvals (even the right code is blocked)', async () => {
    const p = new InMemoryPairingStore({ maxFailedApprovals: 3, generateCode: () => 'GOODCODE' })
    await p.requestCode('tg', 'u1')
    for (let i = 0; i < 3; i++) await p.approveCode('tg', 'BADCODE0')
    const r = await p.approveCode('tg', 'GOODCODE')
    expect(r).toEqual({ approved: false, locked: true })
  })

  it('expires a code after its TTL', async () => {
    let t = 0
    const p = new InMemoryPairingStore({ now: () => t, codeTtlMs: 1000, generateCode: () => 'EXP12345' })
    await p.requestCode('tg', 'u1')
    t += 2000
    expect((await p.approveCode('tg', 'EXP12345')).approved).toBe(false)
  })

  it('isolates approvals per channel', async () => {
    const p = new InMemoryPairingStore({ generateCode: () => 'SAMECODE' })
    await p.requestCode('telegram', 'u1')
    await p.approveCode('telegram', 'SAMECODE')
    expect(await p.isApproved('telegram', 'u1')).toBe(true)
    expect(await p.isApproved('slack', 'u1')).toBe(false)
  })
})

describe('FilePairingStore', () => {
  const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ownware-pairing-')), 'pairing.json')

  it('mints in one instance, approves in ANOTHER instance (the cross-process handshake)', async () => {
    const file = tmpFile()
    const runner = new FilePairingStore({ file, generateCode: () => 'CODE1234' })
    const code = await runner.requestCode('telegram', 'u1')
    // A separate instance = a separate process (ownware channel approve).
    const cli = new FilePairingStore({ file })
    expect(await cli.approveCode('telegram', code)).toEqual({ approved: true, userId: 'u1' })
    // The runner instance sees the approval without any reload call.
    expect(await runner.isApproved('telegram', 'u1')).toBe(true)
  })

  it('persists approvals across restarts', async () => {
    const file = tmpFile()
    const a = new FilePairingStore({ file, generateCode: () => 'ABCD2345' })
    await a.requestCode('tg', 'u9')
    await a.approveCode('tg', 'ABCD2345')
    const b = new FilePairingStore({ file })
    expect(await b.isApproved('tg', 'u9')).toBe(true)
  })

  it('keeps the in-memory rules: cooldown, lockout, TTL expiry', async () => {
    const file = tmpFile()
    let t = 1000
    const p = new FilePairingStore({ file, now: () => t, cooldownMs: 10_000, codeTtlMs: 1000, maxFailedApprovals: 2, generateCode: () => 'GOODCODE' })
    await p.requestCode('tg', 'u1')
    await expect(p.requestCode('tg', 'u1')).rejects.toBeInstanceOf(PairingRateLimitError)
    // TTL expiry
    t += 2000
    expect((await p.approveCode('tg', 'GOODCODE')).approved).toBe(false)
    // Lockout after maxFailed
    expect(await p.approveCode('tg', 'BAD11111')).toEqual({ approved: false, locked: true })
  })

  it('a corrupt state file fail-closes to a fresh store (nobody approved)', async () => {
    const file = tmpFile()
    writeFileSync(file, 'not json{{{')
    const p = new FilePairingStore({ file })
    expect(await p.isApproved('tg', 'u1')).toBe(false)
    // And it can still mint + approve after recovering.
    const gen = new FilePairingStore({ file, generateCode: () => 'FRESH234' })
    const code = await gen.requestCode('tg', 'u1')
    expect((await gen.approveCode('tg', code)).approved).toBe(true)
  })

  it('state file is written 0600', async () => {
    const file = tmpFile()
    const p = new FilePairingStore({ file, generateCode: () => 'PERM1234' })
    await p.requestCode('tg', 'u1')
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
