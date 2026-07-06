/**
 * Profile Discovery
 *
 * Scans directories for agent profiles (directories containing agent.json).
 * Returns a map of profile name → directory path.
 */

import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all profiles under a root directory.
 *
 * Scans for subdirectories containing agent.json or agent.yaml.
 * Extracts the profile name from the config file.
 * Recursive: checks up to 3 levels deep.
 *
 * @param rootDir - Directory to scan
 * @param maxDepth - Maximum directory depth to scan. Default: 3.
 * @returns Map of profile name → absolute directory path
 */
export async function discoverProfiles(
  rootDir: string,
  maxDepth = 3,
): Promise<Map<string, string>> {
  const profiles = new Map<string, string>()
  await scanDirectory(rootDir, profiles, 0, maxDepth)
  return profiles
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function scanDirectory(
  dir: string,
  profiles: Map<string, string>,
  depth: number,
  maxDepth: number,
): Promise<void> {
  if (depth > maxDepth) return

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // Directory doesn't exist or isn't readable
  }

  // Check if this directory itself is a profile
  if (entries.includes('agent.json') || entries.includes('agent.yaml')) {
    const name = await extractProfileName(dir)
    if (name) {
      profiles.set(name, dir)
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue

    const fullPath = join(dir, entry)
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        await scanDirectory(fullPath, profiles, depth + 1, maxDepth)
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}

/**
 * Extract the profile name from agent.json.
 * Falls back to directory name if config can't be read.
 */
async function extractProfileName(dir: string): Promise<string | null> {
  // Try agent.json
  try {
    const content = await readFile(join(dir, 'agent.json'), 'utf-8')
    const config = JSON.parse(content)
    if (typeof config.name === 'string' && config.name) return config.name
  } catch { /* fall through */ }

  // Try agent.yaml (extract name: line)
  try {
    const content = await readFile(join(dir, 'agent.yaml'), 'utf-8')
    const match = content.match(/^name\s*:\s*(.+)$/m)
    if (match) return match[1]?.trim().replace(/^["']|["']$/g, '') ?? null
  } catch { /* fall through */ }

  // Fall back to directory name
  const parts = dir.split('/')
  return parts[parts.length - 1] ?? null
}
