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
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OwnwareGateway,
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
} from 'ownware'

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
await writeFile(join(profilesDir, 'assistant', 'agent.json'), '{"name":"assistant"}')

const gateway = new OwnwareGateway({
  profilesDir,
  dataDir,
  port: 0,
  tls: false,
  disableRateLimit: true,
  disableAccessLog: true,
  disableSourceWorker: true,
})
try {
  await gateway.start()
  if (gateway.state.storageKind !== 'sqlite') throw new Error('SQLite was not selected.')
  const response = await fetch('http://127.0.0.1:' + gateway.port + '/api/v1/health')
  if (!response.ok) throw new Error('SQLite health failed (' + response.status + ').')
} finally {
  await gateway.stop()
}

console.log('SQLITE_CONSUMER_OK pg=absent storage=sqlite')
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
  await gateway?.stop().catch(() => {})
  await admin.query('DROP DATABASE IF EXISTS ' + quote(databaseName) + ' WITH (FORCE)').catch(() => {})
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
