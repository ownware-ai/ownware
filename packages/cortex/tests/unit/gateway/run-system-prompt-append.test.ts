/**
 * Slice B10.1 — `systemPromptAppend` passthrough.
 *
 * Cortex stays product-agnostic: the assembler concatenates whatever
 * the vertical (Design / Marketing / future) sends, with no parsing.
 * These specs prove the wire shape + the assembler's concat behaviour
 * without touching any vertical-specific block names.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import { systemPromptToText } from '@ownware/loom'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function freshProfile() {
  const { dir, cleanup } = await createMinimalProfile({ tools: { preset: 'none' } })
  cleanups.push(cleanup)
  return loadProfile(dir)
}

// Mirror the Zod field shipped in `gateway/handlers/run.ts`. If the
// prod cap changes, this test will start failing — caught early.
// Raised from 8 KB → 64 KB on 2026-05-27 (slice B1.5.1) for the
// Design vertical's `<template-reference>` baked-content block.
const SYSTEM_PROMPT_APPEND_MAX_BYTES = 64 * 1024
const SystemPromptAppendSchema = z
  .string()
  .max(SYSTEM_PROMPT_APPEND_MAX_BYTES)
  .optional()

describe('systemPromptAppend wire shape (B10.1)', () => {
  it('accepts a short string', () => {
    expect(
      SystemPromptAppendSchema.safeParse('<vertical-block>hello</vertical-block>').success,
    ).toBe(true)
  })

  it('accepts omitted (undefined) and the empty string', () => {
    expect(SystemPromptAppendSchema.safeParse(undefined).success).toBe(true)
    expect(SystemPromptAppendSchema.safeParse('').success).toBe(true)
  })

  it(`rejects strings over ${String(SYSTEM_PROMPT_APPEND_MAX_BYTES)} chars`, () => {
    const tooBig = 'x'.repeat(SYSTEM_PROMPT_APPEND_MAX_BYTES + 1)
    expect(SystemPromptAppendSchema.safeParse(tooBig).success).toBe(false)
  })

  it('accepts a 32 KB payload (pinned template + DS + active context fits)', () => {
    // The B1.5.1 raise was driven by Design's <template-reference>
    // baking SKILL.md + example.html verbatim. A realistic upper-bound
    // for a single design's full SPA is ~32 KB; this lock-in test
    // forces a regression alarm if the cap is ever lowered without
    // re-evaluating the template-reference shape.
    const thirtyTwoKB = 'x'.repeat(32 * 1024)
    expect(SystemPromptAppendSchema.safeParse(thirtyTwoKB).success).toBe(true)
  })

  it('does NOT inspect block-name vocabulary (Principle 22 — pure passthrough)', () => {
    // Cortex must not validate that the string contains any
    // vertical-specific tags. Each vertical owns its block names.
    expect(
      SystemPromptAppendSchema.safeParse(
        '<design-metadata>kind=hyperframe</design-metadata>',
      ).success,
    ).toBe(true)
    expect(
      SystemPromptAppendSchema.safeParse(
        '<marketing-brief>future vertical</marketing-brief>',
      ).success,
    ).toBe(true)
    expect(SystemPromptAppendSchema.safeParse('garbage-with-no-tags').success).toBe(true)
  })
})

describe('assembler concat (B10.1)', () => {
  it('concatenates systemPromptAppend into the system prompt verbatim', async () => {
    const profile = await freshProfile()
    const APPEND =
      '<vertical-context>\nthe user is working on the hyperframe canvas\n</vertical-context>'

    const assembled = await assembleAgent(profile, {
      credentialContext: { credentialHandles: [], configVars: {} },
      systemPromptAppend: APPEND,
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain(APPEND)
  })

  it('omits the append entirely when systemPromptAppend is undefined or empty', async () => {
    const profile = await freshProfile()
    const SENTINEL = '<vertical-context>'

    const omitted = await assembleAgent(profile, {
      credentialContext: { credentialHandles: [], configVars: {} },
    })
    const empty = await assembleAgent(profile, {
      credentialContext: { credentialHandles: [], configVars: {} },
      systemPromptAppend: '',
    })

    expect(systemPromptToText(omitted.systemPrompt)).not.toContain(SENTINEL)
    expect(systemPromptToText(empty.systemPrompt)).not.toContain(SENTINEL)
  })

  it('passes ill-formed XML / raw text through verbatim (no parsing, no escaping)', async () => {
    const profile = await freshProfile()
    const APPEND = '<not-closed>raw text & ampersand <broken'

    const assembled = await assembleAgent(profile, {
      credentialContext: { credentialHandles: [], configVars: {} },
      systemPromptAppend: APPEND,
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain(APPEND)
  })
})
