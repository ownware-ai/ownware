import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cortex = join(root, 'packages/cortex')
const client = join(root, 'packages/client')
const contractRevision = '0.30.0'

const cortexProofs = [
  'tests/framework/contracts/source-registration.contract.ts',
  'tests/framework/contracts/source-upload-sessions.contract.ts',
  'tests/framework/contracts/source-jobs.contract.ts',
  'tests/framework/contracts/source-quotas.contract.ts',
  'tests/framework/contracts/source-deletions.contract.ts',
  'tests/framework/contracts/access-grants.contract.ts',
  'tests/framework/contracts/data-view-query.contract.ts',
  'tests/framework/contracts/principals.contract.ts',
  'tests/integration/gateway/capabilities.test.ts',
  'tests/integration/gateway/source-registration-restart.test.ts',
  'tests/integration/gateway/source-upload-restart.test.ts',
  'tests/integration/gateway/source-job-restart.test.ts',
  'tests/integration/gateway/source-deletion-restart.test.ts',
  'tests/integration/gateway/access-grant-restart.test.ts',
  'tests/unit/gateway/source-upload-store.test.ts',
  'tests/unit/gateway/source-job-store.test.ts',
  'tests/unit/gateway/source-job-worker.test.ts',
  'tests/unit/gateway/source-quota-policy.test.ts',
  'tests/unit/gateway/source-byte-store-range.test.ts',
  'tests/unit/gateway/source-byte-store-search.test.ts',
  'tests/unit/gateway/source-byte-store-data-view.test.ts',
  'tests/unit/gateway/source-byte-store-deletion.test.ts',
  'tests/unit/gateway/csv-data-view.test.ts',
  'tests/unit/gateway/csv-data-view-selection.test.ts',
  'tests/unit/gateway/source-data-view-store.test.ts',
  'tests/unit/gateway/source-data-view-worker.test.ts',
  'tests/unit/gateway/protected-data-view-selection.test.ts',
  'tests/unit/gateway/protected-source-read.test.ts',
  'tests/unit/gateway/evidence-search-cache.test.ts',
  'tests/unit/gateway/evidence-search-cache-lifecycle.test.ts',
  'tests/unit/gateway/access-grant-store.test.ts',
  'tests/unit/gateway/access-grant-evaluator.test.ts',
  'tests/unit/gateway/source-deletion-store.test.ts',
  'tests/unit/gateway/source-deletion-worker.test.ts',
  'tests/unit/gateway/source-content-handler.test.ts',
]

const clientProofs = [
  'src/__tests__/client.test.ts',
  'src/__tests__/integration.test.ts',
  'src/__tests__/source-search-lifecycle.test.ts',
  'src/__tests__/source-lifecycle-coverage.test.ts',
]

const steps = [
  { label: 'Cortex build', command: 'bun', args: ['run', 'build'], cwd: cortex },
  { label: 'Client build', command: 'bun', args: ['run', 'build'], cwd: client },
  {
    label: 'Cortex source contract, restart and fault proofs',
    command: 'bunx',
    args: ['vitest', 'run', ...cortexProofs],
    cwd: cortex,
  },
  {
    label: 'Public SDK source journeys and ownership map',
    command: 'bunx',
    args: ['vitest', 'run', ...clientProofs],
    cwd: client,
  },
]

for (const step of steps) runStep(step)

process.stdout.write('\n[source-lifecycle] Spec, compatibility and release-note packaging\n')
checkContractPackaging()
runStep({
  label: 'Changesets release status',
  command: 'bun',
  args: ['run', 'release:status'],
  cwd: root,
})

process.stdout.write('\n[source-lifecycle] all proofs passed\n')

function runStep(step) {
  process.stdout.write(`\n[source-lifecycle] ${step.label}\n`)
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: { ...process.env, OWNWARE_SKIP_MCP_REGISTRY: '1' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function checkContractPackaging() {
  const requireFromCortex = createRequire(join(cortex, 'package.json'))
  const yaml = requireFromCortex('yaml')
  const openapi = yaml.parse(readFileSync(join(client, 'spec/openapi.yaml'), 'utf8'))
  const asyncapi = yaml.parse(readFileSync(join(client, 'spec/asyncapi.yaml'), 'utf8'))
  assert(openapi?.info?.version === contractRevision,
    `OpenAPI revision must be ${contractRevision}`)
  assert(asyncapi?.info?.version === contractRevision,
    `AsyncAPI revision must be ${contractRevision}`)

  const capabilitiesSource = readFileSync(
    join(cortex, 'src/gateway/handlers/capabilities.ts'), 'utf8',
  )
  assert(capabilitiesSource.includes(`revision: '${contractRevision}'`),
    `Gateway capability revision must be ${contractRevision}`)

  const compatibility = readFileSync(join(client, 'COMPATIBILITY.md'), 'utf8')
  assert(compatibility.includes(`| \`${contractRevision}\` |`),
    `COMPATIBILITY.md must contain revision ${contractRevision}`)
  const ownership = readFileSync(
    join(client, 'src/__tests__/source-lifecycle-coverage.ts'), 'utf8',
  )
  const ownedCapabilities = new Map(
    [...ownership.matchAll(/capabilityId: '([^']+)', capabilityVersion: (\d+)/g)]
      .map((match) => [match[1], Number(match[2])]),
  )
  for (const [capabilityId, version] of ownedCapabilities) {
    const marker = `\`${capabilityId}\``
    const offsets = []
    for (let offset = compatibility.indexOf(marker); offset !== -1;
      offset = compatibility.indexOf(marker, offset + marker.length)) offsets.push(offset)
    assert(offsets.length > 0, `COMPATIBILITY.md omits ${capabilityId}`)
    assert(offsets.some((offset) =>
      compatibility.slice(offset, offset + 500).includes(`version ${version}`)),
      `COMPATIBILITY.md does not associate ${capabilityId} with version ${version}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
