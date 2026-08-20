import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

const PROFILE = 'skills-public'

const SKILL = `---
name: weekly-digest
description: Summarize the week
---
1. Gather the week's threads.
2. Write the digest.
`

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('profile skills (public)', () => {
  it('installs from content, lists with the playbook body, toggles and removes', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const installed = await gateway.client.post(`/api/v1/profiles/${PROFILE}/skills`, {
      source: 'content',
      content: SKILL,
    })
    expect(installed.status).toBe(201)
    const slug = (installed.body as { slug: string }).slug

    const listed = await gateway.client.get(`/api/v1/profiles/${PROFILE}/skills`)
    expect(listed.status).toBe(200)
    const skills = (listed.body as { skills: Array<{ name: string; content: string; active: boolean }> }).skills
    expect(skills).toHaveLength(1)
    expect(skills[0]!.active).toBe(true)
    // The fold is the playbook in words — the body rides along.
    expect(skills[0]!.content).toContain('Write the digest')

    const disabled = await fetch(`${gateway.baseUrl}/api/v1/profiles/${PROFILE}/skills/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    })
    expect(disabled.status).toBe(200)
    const afterToggle = await gateway.client.get(`/api/v1/profiles/${PROFILE}/skills`)
    expect((afterToggle.body as { skills: Array<{ active: boolean }> }).skills[0]!.active).toBe(false)

    const removed = await fetch(`${gateway.baseUrl}/api/v1/profiles/${PROFILE}/skills/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${gateway.token}` },
    })
    expect(removed.status).toBe(204)
    const afterRemove = await gateway.client.get(`/api/v1/profiles/${PROFILE}/skills`)
    expect((afterRemove.body as { skills: unknown[] }).skills).toHaveLength(0)
  })

  it('refuses every skill surface to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Skills')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-skills',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['skills.read', 'skills.manage'],
    })
    const token = (issued.body as { token: string }).token
    // Skills are executable instructions: reading reveals playbooks,
    // installing changes agent behaviour. Never a delegated surface.
    for (const [method, path] of [
      ['GET', `/api/v1/profiles/${PROFILE}/skills`],
      ['POST', `/api/v1/profiles/${PROFILE}/skills`],
      ['DELETE', `/api/v1/profiles/${PROFILE}/skills/any`],
    ] as const) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ source: 'content', content: SKILL }) } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})
