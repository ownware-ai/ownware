/**
 * Onboarding handlers.
 *
 * POST /onboarding/role — set user's role + display name
 * POST /onboarding/complete — mark onboarding as done
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import { OnboardingRoleSchema, OnboardingCompleteSchema } from '../validation/schemas.js'

export function createOnboardingHandlers(state: GatewayState) {

  // POST /api/v1/onboarding/role
  async function setRole(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = OnboardingRoleSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    const { role, name } = parsed.data
    const displayName = name ?? role

    // Create or update local profile
    const existing = state.getLocalProfile()
    if (existing) {
      state.updateLocalProfile(existing.id, { displayName })
    } else {
      state.createLocalProfile(displayName)
    }

    // Store role as a setting
    state.setSetting('onboarding.role', role)

    sendJSON(res, 200, { role, displayName })
  }

  // POST /api/v1/onboarding/complete
  async function complete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    const parsed = OnboardingCompleteSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    // Mark onboarding as completed
    state.setAppState('onboarding_completed', 'true')

    const profilesInstalled = parsed.data.profileIds?.length ?? 0

    sendJSON(res, 200, { completed: true, profilesInstalled })
  }

  return { setRole, complete }
}
