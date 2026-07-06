/**
 * Check registry icon and ranking data
 */

async function main() {
  // Fetch raw from API to see ALL fields
  const res = await fetch('https://registry.modelcontextprotocol.io/v0.1/servers?limit=50&version=latest')
  const data = await res.json() as any

  console.log('=== ICON CHECK (50 entries) ===')
  let iconCount = 0
  let websiteCount = 0
  let repoCount = 0

  for (const wrapper of data.servers) {
    const s = wrapper.server ?? wrapper
    if (s.icons && s.icons.length > 0) {
      iconCount++
      console.log(`  HAS ICON: ${s.name} → ${JSON.stringify(s.icons)}`)
    }
    if (s.websiteUrl) websiteCount++
    if (s.repository?.url) repoCount++
  }

  console.log(`\n  Icons: ${iconCount}/50`)
  console.log(`  Website URLs: ${websiteCount}/50`)
  console.log(`  Repository URLs: ${repoCount}/50`)

  console.log('\n=== META DATA (ranking/popularity?) ===')
  const first = data.servers[0]
  console.log('Full wrapper keys:', Object.keys(first))
  console.log('_meta:', JSON.stringify(first._meta, null, 2))
  console.log('Server keys:', Object.keys(first.server ?? first))

  // Check for download counts, stars, etc
  const s = first.server ?? first
  console.log('\nAll server fields:', JSON.stringify(s, null, 2).substring(0, 500))

  // Search for popular servers by name
  console.log('\n=== SEARCH FOR KNOWN POPULAR SERVERS ===')
  for (const query of ['github', 'filesystem', 'slack', 'postgres', 'fetch']) {
    const searchRes = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${query}&limit=3&version=latest`)
    const searchData = await searchRes.json() as any
    console.log(`\n  "${query}" → ${searchData.servers?.length ?? 0} results`)
    for (const w of (searchData.servers ?? []).slice(0, 3)) {
      const srv = w.server ?? w
      console.log(`    ${srv.name} | icons: ${srv.icons?.length ?? 0} | website: ${srv.websiteUrl ?? 'none'} | repo: ${srv.repository?.url ?? 'none'}`)
    }
  }

  // Check GitHub-hosted server icons via repo
  console.log('\n=== GITHUB AVATAR STRATEGY ===')
  console.log('  Servers hosted on GitHub can use owner avatar:')
  console.log('  https://github.com/anthropics → https://avatars.githubusercontent.com/anthropics')
  console.log('  https://github.com/modelcontextprotocol → https://avatars.githubusercontent.com/modelcontextprotocol')

  // Extract GitHub owners from repos
  const allRes = await fetch('https://registry.modelcontextprotocol.io/v0.1/servers?limit=96&version=latest')
  const allData = await allRes.json() as any
  const owners = new Map<string, number>()
  for (const w of allData.servers) {
    const srv = w.server ?? w
    const repoUrl = srv.repository?.url
    if (repoUrl) {
      const match = repoUrl.match(/github\.com\/([^/]+)/)
      if (match) {
        owners.set(match[1], (owners.get(match[1]) ?? 0) + 1)
      }
    }
  }
  console.log('\n  Top GitHub owners:')
  const sorted = [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  for (const [owner, count] of sorted) {
    console.log(`    ${owner}: ${count} servers → https://avatars.githubusercontent.com/${owner}`)
  }
}

main().catch(console.error)
