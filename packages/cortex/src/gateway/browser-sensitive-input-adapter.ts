/**
 * Cortex-owned binding between the exact built-in browser tool and Loom's
 * low-level Playwright injection primitive. Registration is performed only by
 * a host that owns the managed browser lifecycle for the session.
 */

import {
  BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
  injectBrowserSensitiveInput,
  prepareBrowserSensitiveInputBinding,
  type BrowserSensitiveInputBinding,
} from '@ownware/loom'
import type { SensitiveInputAdapter } from './sensitive-input-broker.js'

export interface BrowserSensitiveInputAdapterOptions {
  /**
   * Browser-sensitive injection is root-only in this contract revision. The
   * host also denies it while helpers are active because browser ownership is
   * not yet partitioned between concurrent agents.
   */
  readonly hasActiveHelpers: () => boolean
  /**
   * Authoritative host observation for the exact live CDP endpoint. Reusable
   * browser profiles are unsupported because page or extension storage could
   * carry a value into a later capture-enabled process.
   */
  readonly isEphemeralManagedContext: (cdpUrl: string) => boolean
}

export function createBrowserSensitiveInputAdapter(
  options: BrowserSensitiveInputAdapterOptions,
): SensitiveInputAdapter<BrowserSensitiveInputBinding> {
  const adapter: SensitiveInputAdapter<BrowserSensitiveInputBinding> = {
    contractRevision: BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
    prepare(binding, context) {
      if (context.agentId !== null || options.hasActiveHelpers()) {
        throw new Error(
          'Browser-sensitive input requires an exclusively owned root browser session.',
        )
      }
      const prepared = prepareBrowserSensitiveInputBinding(binding)
      if (!options.isEphemeralManagedContext(prepared.cdpUrl)) {
        throw new Error(
          'Browser-sensitive input requires the exact live ephemeral managed browser context.',
        )
      }
      return prepared
    },
    inject: injectBrowserSensitiveInput,
  }
  return Object.freeze(adapter)
}
