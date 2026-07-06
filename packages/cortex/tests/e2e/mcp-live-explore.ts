/**
 * Live MCP Registry Explorer — run this to see what's available
 */
import { fetchMCPRegistry } from '../../src/connector/mcp/registry.js'

async function main() {
  const entries = await fetchMCPRegistry()
  console.log('Total servers:', entries.length)
  console.log('')

  const noAuth = entries.filter(e => e.requiredEnv.length === 0 && e.package && e.transport === 'stdio')
  console.log('=== No-auth stdio servers ===', noAuth.length)
  noAuth.slice(0, 15).forEach(e => console.log(`  ${e.id} | ${e.title} | pkg: ${e.package} | runtime: ${e.runtime}`))

  console.log('')
  const withAuth = entries.filter(e => e.requiredEnv.length > 0 && e.package)
  console.log('=== Auth-required servers ===', withAuth.length)
  withAuth.slice(0, 10).forEach(e => {
    console.log(`  ${e.title} | pkg: ${e.package} | needs: ${e.requiredEnv.map(v => v.name + (v.isSecret ? '(secret)' : '')).join(', ')}`)
  })

  console.log('')
  const remote = entries.filter(e => e.remoteUrl)
  console.log('=== Remote (hosted) servers ===', remote.length)
  remote.slice(0, 5).forEach(e => console.log(`  ${e.title} | ${e.remoteUrl}`))

  console.log('')
  const categories = new Map<string, number>()
  for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + 1)
  console.log('=== Categories ===')
  for (const [cat, count] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`)
  }
}

main().catch(console.error)
