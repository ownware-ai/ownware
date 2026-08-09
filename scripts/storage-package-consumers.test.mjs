import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveRun()
      rejectRun(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}.`))
    })
  })
}

function capture(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveRun(stdout)
      rejectRun(new Error(
        `${command} exited with ${code ?? signal ?? 'unknown status'}: ${stderr.trim()}`,
      ))
    })
  })
}

async function packageDescriptor(relativeDirectory) {
  const directory = join(repoRoot, relativeDirectory)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const archiveName = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  return { directory, name: manifest.name, archiveName }
}

async function writeConsumer(directory, tarballs, includePostgreSql) {
  await mkdir(directory, { recursive: true })
  const local = (name) => `file:${tarballs.get(name)}`
  const localWorkspacePackages = {
    '@ownware/client': local('@ownware/client'),
    '@ownware/cortex': local('@ownware/cortex'),
    '@ownware/loom': local('@ownware/loom'),
    '@ownware/shuttle': local('@ownware/shuttle'),
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: `ownware-storage-${includePostgreSql ? 'postgresql' : 'sqlite'}-package-proof`,
    private: true,
    type: 'module',
    dependencies: {
      ownware: local('ownware'),
      ...localWorkspacePackages,
      ...(includePostgreSql ? { pg: '8.22.0' } : {}),
    },
    overrides: localWorkspacePackages,
  }, null, 2)}\n`)
}

const sqliteConsumer = String.raw`
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OwnwareGateway,
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
} from 'ownware'
import { OwnwareClient } from '@ownware/client'

const require = createRequire(import.meta.url)
try {
  require.resolve('pg')
  throw new Error('SQLite consumer unexpectedly installed pg.')
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error
}
for (const exported of [
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
]) {
  if (typeof exported !== 'function') throw new Error('Storage transfer export missing.')
}

const profilesDir = join(process.cwd(), 'profiles')
const dataDir = join(process.cwd(), 'data')
await mkdir(join(profilesDir, 'assistant'), { recursive: true })
await writeFile(
  join(profilesDir, 'assistant', 'agent.json'),
  '{"name":"assistant","model":"anthropic:fixture-placeholder"}',
)

const fixture = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'package-fixture', object: 'model', created: 1, owned_by: 'fixture' }],
    }))
    return
  }
  if (request.url === '/v1/chat/completions') {
    response.setHeader('content-type', 'text/event-stream')
    response.write('data: ' + JSON.stringify({
      id: 'chatcmpl-package-proof',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'package-fixture',
      service_tier: 'priority',
      choices: [{ index: 0, delta: { content: 'package proof' }, finish_reason: null }],
    }) + '\n\n')
    response.write('data: ' + JSON.stringify({
      id: 'chatcmpl-package-proof',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'package-fixture',
      service_tier: 'priority',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n\n')
    response.write('data: ' + JSON.stringify({
      id: 'chatcmpl-package-proof',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'package-fixture',
      service_tier: 'priority',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) + '\n\n')
    response.end('data: [DONE]\n\n')
    return
  }
  response.statusCode = 404
  response.end()
})
await new Promise((resolve, reject) => {
  fixture.once('error', reject)
  fixture.listen(0, '127.0.0.1', resolve)
})
const fixtureAddress = fixture.address()
if (fixtureAddress == null || typeof fixtureAddress === 'string') {
  throw new Error('Package fixture failed to bind.')
}
const fixtureBaseUrl = 'http://127.0.0.1:' + fixtureAddress.port + '/v1'

const gateway = new OwnwareGateway({
  profilesDir,
  dataDir,
  port: 0,
  tls: false,
  disableAuth: true,
  disableRateLimit: true,
  disableAccessLog: true,
  disableSourceWorker: true,
})
try {
  await gateway.start()
  if (gateway.state.storageKind !== 'sqlite') throw new Error('SQLite was not selected.')
  const gatewayBaseUrl = 'http://127.0.0.1:' + gateway.port
  const response = await fetch(gatewayBaseUrl + '/api/v1/health')
  if (!response.ok) throw new Error('SQLite health failed (' + response.status + ').')

  const client = new OwnwareClient({ baseUrl: gatewayBaseUrl })
  const connection = await client.saveOpenAICompatibleConnection({
    label: 'Package consumer fixture',
    baseUrl: fixtureBaseUrl,
    auth: { kind: 'none' },
    manualModelIds: [],
    discoveryEnabled: true,
  })
  await client.discoverOpenAICompatibleModels(connection.id)
  const modelId = connection.id + ':package-fixture'
  const models = await client.providerHubModels({
    providerRouteId: 'route:' + connection.id,
    scope: 'connected',
  })
  const selected = models.items.find(item => item.model.id === modelId)
  if (selected == null) throw new Error('Discovered package model was not listed.')
  if (selected.model.availability.verified !== false) {
    throw new Error('Unverified package model was promoted to verified.')
  }

  const run = await client.run({
    profileId: 'assistant',
    prompt: 'package-consumer-prompt-canary',
    model: modelId,
  })
  if (run.model !== modelId) throw new Error('Selected package model was not dispatched.')
  if (run.modelSubstitution !== undefined) {
    throw new Error('An explicit runnable model produced a false substitution receipt.')
  }
  if (run.runId == null) throw new Error('Package run did not return a run ID.')
  let completed = false
  for await (const event of client.streamReply(run.runId)) {
    if (event.type === 'error') throw new Error('Package run failed.')
    if (event.type === 'done') {
      completed = true
      break
    }
  }
  if (!completed) throw new Error('Package run did not complete.')

  const usage = await client.providerHubUsage({ threadId: run.threadId })
  if (usage.items.length !== 1) throw new Error('Package usage fact was not recorded exactly once.')
  if (usage.items[0].cost.classification !== 'local' || usage.items[0].cost.amountUsd !== null) {
    throw new Error('Package usage cost classification was not truthful.')
  }
  const summary = await client.providerHubUsageSummary({ threadId: run.threadId })
  if (summary.tokens.inputTextTokens !== 3 || summary.tokens.outputTextTokens !== 2) {
    throw new Error(
      'Package usage summary did not preserve provider tokens: ' + JSON.stringify(summary),
    )
  }
  const verification = await client.providerHubVerifications()
  if (verification.bundle !== null) {
    throw new Error('Missing verification evidence was not reported honestly.')
  }
  const evidence = await client.exportProviderHubUsageEvidence()
  if (evidence.entries.length !== 1 || evidence.pricebookSnapshots.length !== 0) {
    throw new Error('Package usage export was not lossless for local/null cost evidence.')
  }
  if (JSON.stringify(evidence).includes('package-consumer-prompt-canary')) {
    throw new Error('Package usage export leaked prompt content.')
  }
  const reconciledAt = '2026-08-09T10:00:00.000Z'
  const reconciled = await client.reconcileProviderHubUsageCost(usage.items[0].id, {
    classification: 'reconciled',
    amountUsd: 0.001,
    currency: 'USD',
    observedAt: reconciledAt,
    reconciledAt,
  })
  if (reconciled.cost.classification !== 'reconciled') {
    throw new Error('Package reconciliation did not append a reconciled observation.')
  }
} finally {
  await gateway.stop()
  await new Promise(resolve => fixture.close(() => resolve()))
}

console.log('SQLITE_CONSUMER_OK pg=absent storage=sqlite public=provider-hub-run-usage')
`

const postgresqlConsumer = String.raw`
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OwnwareGateway } from 'ownware'
import { Client } from 'pg'

const adminUrl = process.env.OWNWARE_TEST_POSTGRES_URL
if (!adminUrl) throw new Error('Disposable PostgreSQL admin URL missing.')
const databaseName = 'ownware_pack_test_' + randomUUID().replaceAll('-', '').slice(0, 20)
const quote = (value) => '"' + value.replaceAll('"', '""') + '"'
const admin = new Client({ connectionString: adminUrl, ssl: false })
await admin.connect()
await admin.query('CREATE DATABASE ' + quote(databaseName))
const runtimeUrl = new URL(adminUrl)
runtimeUrl.pathname = '/' + databaseName

const profilesDir = join(process.cwd(), 'profiles')
const dataDir = join(process.cwd(), 'data')
await mkdir(join(profilesDir, 'assistant'), { recursive: true })
await writeFile(join(profilesDir, 'assistant', 'agent.json'), '{"name":"assistant"}')

let gateway
try {
  gateway = new OwnwareGateway({
    profilesDir,
    dataDir,
    port: 0,
    tls: false,
    disableRateLimit: true,
    disableAccessLog: true,
    disableSourceWorker: true,
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => runtimeUrl.toString() },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { maxConnections: 4 },
    },
  })
  await gateway.start()
  if (gateway.state.storageKind !== 'postgresql') throw new Error('PostgreSQL was not selected.')
  const health = await fetch('http://127.0.0.1:' + gateway.port + '/api/v1/health')
  if (!health.ok) throw new Error('PostgreSQL health failed (' + health.status + ').')
  const thread = await fetch('http://127.0.0.1:' + gateway.port + '/api/v1/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'assistant', title: 'Pack proof' }),
  })
  if (thread.status !== 201) throw new Error('PostgreSQL thread failed (' + thread.status + ').')
} finally {
  await gateway?.stop()
  await admin.query('DROP DATABASE IF EXISTS ' + quote(databaseName))
  await admin.end().catch(() => {})
}

console.log('POSTGRESQL_CONSUMER_OK pg=present storage=postgresql')
`

test('published tarballs work for SQLite without pg and PostgreSQL with pg', {
  timeout: 180_000,
}, async (t) => {
  const adminUrl = process.env.OWNWARE_TEST_POSTGRES_URL
  if (!adminUrl) return t.skip('OWNWARE_TEST_POSTGRES_URL is required for the package proof.')

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ownware-storage-package-'))
  try {
    const archiveDirectory = join(temporaryRoot, 'archives')
    await mkdir(archiveDirectory)
    const packages = await Promise.all([
      packageDescriptor('packages/client'),
      packageDescriptor('packages/loom'),
      packageDescriptor('packages/cortex'),
      packageDescriptor('adapters/shuttle'),
      packageDescriptor('packages/ownware'),
    ])
    const tarballs = new Map()
    for (const packageInfo of packages) {
      await run(
        'bun',
        ['pm', 'pack', '--quiet', '--destination', archiveDirectory],
        packageInfo.directory,
      )
      tarballs.set(packageInfo.name, join(archiveDirectory, packageInfo.archiveName))
    }
    const cortexArchive = await capture(
      'tar',
      ['-tzf', tarballs.get('@ownware/cortex')],
      repoRoot,
    )
    assert.equal(
      cortexArchive.split('\n').includes('package/dist/gateway-bundle.mjs'),
      false,
      'The local-only gateway bundle must not make the published tarball nondeterministic.',
    )

    const sqliteDirectory = join(temporaryRoot, 'sqlite-consumer')
    await writeConsumer(sqliteDirectory, tarballs, false)
    await writeFile(join(sqliteDirectory, 'verify.mjs'), sqliteConsumer)
    await run('bun', ['install', '--offline'], sqliteDirectory)
    await run(process.execPath, ['verify.mjs'], sqliteDirectory)

    const postgresqlDirectory = join(temporaryRoot, 'postgresql-consumer')
    await writeConsumer(postgresqlDirectory, tarballs, true)
    await writeFile(join(postgresqlDirectory, 'verify.mjs'), postgresqlConsumer)
    await run('bun', ['install', '--offline'], postgresqlDirectory)
    await run(process.execPath, ['verify.mjs'], postgresqlDirectory, {
      ...process.env,
      OWNWARE_TEST_POSTGRES_URL: adminUrl,
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
