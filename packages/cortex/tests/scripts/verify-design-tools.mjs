import { loadProfile } from '../dist/profile/loader.js'
import { applyToolPolicy, resolvePresetTools } from '../dist/profile/tool-policy.js'
import path from 'node:path'

const profileDir = path.resolve('profiles/ownware-design')
const profile = await loadProfile(profileDir)
const cfg = profile.config.tools

const base = resolvePresetTools(cfg.preset)
const filtered = applyToolPolicy(base, cfg.allow, cfg.deny)

console.log('preset:', cfg.preset)
console.log('allow:', cfg.allow)
console.log('deny:', cfg.deny)
console.log('---')
console.log('base count:', base.length)
console.log('---')
console.log('after policy:', filtered.length, 'tools:')
console.log(filtered.map(t => t.name).sort().join('\n'))
