import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function providerHubAssetPath(moduleUrl: string, name: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl))
  const providerHubDirectory = basename(moduleDirectory) === 'provider-hub'
    ? moduleDirectory
    : resolve(moduleDirectory, 'provider-hub')
  return resolve(providerHubDirectory, 'catalog', name)
}

export const BUNDLED_MODELS_DEV_PATH = providerHubAssetPath(
  import.meta.url,
  'models-dev.snapshot.json',
)

export const MODELS_DEV_LICENSE_PATH = providerHubAssetPath(
  import.meta.url,
  'MODELS_DEV_LICENSE.txt',
)

export const __bundledProviderHubInternal = { providerHubAssetPath }
