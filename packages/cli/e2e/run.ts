/**
 * Round runner — drives every journey and leaves the evidence behind.
 *
 *   node e2e/run.ts                 every journey this machine can run
 *   node e2e/run.ts --only first-run-keyless,narrow-terminal
 *   node e2e/run.ts --list
 *
 * Exit code is 0 whenever the ROUND completed, even with failed checks:
 * a failed check is a finding to read, not a build break. Exit 1 means
 * the harness itself could not do its job (a journey crashed, or the
 * real `~/.ownware` was touched).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARTIFACT_ROOT, detectCapabilities, realDataDirStamp, runJourney, type Journey, type JourneyResult } from './harness/journey.ts'
import { JOURNEYS } from './journeys/index.ts'

function parse(argv: readonly string[]): { only: string[]; list: boolean } {
  const only: string[] = []
  let list = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else if (argv[i] === '--list') list = true
  }
  return { only, list }
}

function summarise(results: readonly JourneyResult[], caps: ReadonlySet<string>): string {
  const lines: string[] = []
  lines.push('# Round summary')
  lines.push('')
  lines.push(`capabilities: ${[...caps].join(', ') || 'none (scripted journeys only)'}`)
  lines.push('')
  lines.push('| journey | status | checks | duration | flags |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok).length
    const flags = r.frames.reduce((n, f) => n + f.hygiene.length, 0)
    const checks = r.checks.length === 0 ? '—' : `${r.checks.length - failed}/${r.checks.length}`
    lines.push(
      `| ${r.id} | ${r.status}${r.skipReason === undefined ? '' : ` (${r.skipReason})`} | ${checks} | ${(r.durationMs / 1000).toFixed(1)}s | ${flags || '—'} |`,
    )
  }
  lines.push('')
  for (const r of results) {
    if (r.status === 'skipped') continue
    const failed = r.checks.filter((c) => !c.ok)
    const flags = r.frames.flatMap((f) => f.hygiene.map((h) => `${f.label}: [${h.kind}] ${h.detail}`))
    if (failed.length === 0 && flags.length === 0 && r.error === undefined) continue
    lines.push(`## ${r.id} — ${r.title}`)
    if (r.error !== undefined) lines.push(`- **crashed:** ${r.error}`)
    for (const c of failed) lines.push(`- **failed check** \`${c.name}\` — ${c.detail}`)
    for (const f of flags) lines.push(`- **hygiene** ${f}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const { only, list } = parse(process.argv.slice(2))
  const selected: Journey[] = only.length === 0 ? [...JOURNEYS] : JOURNEYS.filter((j) => only.includes(j.id))

  if (list) {
    for (const j of JOURNEYS) {
      process.stdout.write(`${j.id.padEnd(28)} ${j.title}\n`)
      process.stdout.write(`${' '.repeat(28)} requires: ${(j.requires ?? []).join(', ') || 'nothing'}\n`)
    }
    return
  }

  if (selected.length === 0) {
    process.stderr.write(`no journeys matched ${only.join(',')}\n`)
    process.exitCode = 1
    return
  }

  mkdirSync(ARTIFACT_ROOT, { recursive: true })
  const caps = await detectCapabilities()
  const stampBefore = realDataDirStamp()

  const results: JourneyResult[] = []
  for (const journey of selected) {
    process.stdout.write(`▶ ${journey.id} — ${journey.title}\n`)
    const result = await runJourney(journey, caps)
    const failed = result.checks.filter((c) => !c.ok).length
    process.stdout.write(
      `  ${result.status}${result.skipReason === undefined ? '' : ` (${result.skipReason})`}` +
        ` · ${result.checks.length - failed}/${result.checks.length} checks` +
        ` · ${(result.durationMs / 1000).toFixed(1)}s\n`,
    )
    if (result.error !== undefined) process.stdout.write(`  error: ${result.error}\n`)
    results.push(result)
  }

  const stampAfter = realDataDirStamp()
  let breach = false
  if (stampBefore !== stampAfter) {
    breach = true
    process.stderr.write(
      `\n!! GUARDRAIL #4 BREACH: the real ~/.ownware/ownware.db changed during this round\n` +
        `   before=${stampBefore} after=${stampAfter}\n`,
    )
  }

  const summary = summarise(results, caps)
  writeFileSync(join(ARTIFACT_ROOT, 'SUMMARY.md'), `${summary}\n${breach ? '\n**GUARDRAIL #4 BREACH — a journey touched the real data dir.**\n' : ''}`)
  process.stdout.write(`\nartifacts: ${ARTIFACT_ROOT}\n`)

  if (breach || results.some((r) => r.status === 'crashed')) process.exitCode = 1
}

await main()
