import { describe, expect, it } from 'vitest'
import { createRunHandlers } from '../../../src/gateway/handlers/run.js'
import type { GatewayState } from '../../../src/gateway/state.js'
import type { ProfileRegistry } from '../../../src/profile/registry.js'
import type { SessionRunner } from '../../../src/gateway/session-runner.js'

describe('run attachment processing failure', () => {
  it('returns only the safe typed failure before touching Gateway state', async () => {
    const handlers = createRunHandlers(
      {} as GatewayState,
      {} as ProfileRegistry,
      {} as SessionRunner,
      {
        processAttachmentsFn: async () => {
          throw new Error('RAW-PRIVATE-PARSER-DETAIL')
        },
      },
    )
    const thrown = await handlers.startProfileRun({
      profileId: 'never-resolved',
      prompt: 'inspect',
      attachments: [{
        filename: 'private-name.txt',
        mimeType: 'text/plain',
        data: Buffer.from('untrusted data').toString('base64'),
      }],
    }).catch((error: unknown) => error)

    expect(thrown).toMatchObject({
      status: 422,
      code: 'attachment_processing_failed',
      message: 'Attachment processing failed safely.',
    })
    expect(String(thrown)).not.toContain('RAW-PRIVATE-PARSER-DETAIL')
    expect(String(thrown)).not.toContain('private-name')
  })
})
