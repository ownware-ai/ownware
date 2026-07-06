/**
 * Settings handlers.
 *
 * GET /settings — all settings grouped by section
 * PUT /settings/:section — upsert keys for a section
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import { SaveSettingsSchema } from '../validation/schemas.js'

export function createSettingsHandlers(state: GatewayState) {

  // GET /api/v1/settings
  async function getSettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const all = state.getAllSettings()

    // Group by section: key format is "section.name" → { section: { name: value } }
    const grouped: Record<string, Record<string, string>> = {}
    for (const setting of all) {
      const dotIdx = setting.key.indexOf('.')
      if (dotIdx === -1) {
        // Top-level key — put under "general"
        grouped['general'] = grouped['general'] ?? {}
        grouped['general'][setting.key] = setting.value
      } else {
        const section = setting.key.slice(0, dotIdx)
        const name = setting.key.slice(dotIdx + 1)
        grouped[section] = grouped[section] ?? {}
        grouped[section][name] = name ? setting.value : setting.value
      }
    }

    sendJSON(res, 200, grouped)
  }

  // PUT /api/v1/settings/:section
  async function putSettingsSection(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const section = params['section']!
    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = SaveSettingsSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map(e => e.message).join('; '))
      return
    }

    const data = parsed.data
    for (const [key, value] of Object.entries(data)) {
      state.setSetting(`${section}.${key}`, value)
    }

    // Return the full section
    const all = state.getAllSettings()
    const sectionSettings: Record<string, string> = {}
    for (const s of all) {
      if (s.key.startsWith(`${section}.`)) {
        sectionSettings[s.key.slice(section.length + 1)] = s.value
      }
    }

    sendJSON(res, 200, { section, settings: sectionSettings })
  }

  return { getSettings, putSettingsSection }
}
