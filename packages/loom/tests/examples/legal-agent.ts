#!/usr/bin/env npx tsx
/**
 * Legal Contract Analysis Agent
 *
 * Shows that Loom works for ANY domain, not just coding.
 * Uses custom tools for clause analysis, precedent search, and issue flagging.
 *
 * Usage:
 *   npx tsx examples/legal-agent.ts ./sample-contract.txt
 */

import * as fs from 'node:fs/promises'
import { Loom, defineTool, collectResult, type Tool } from '../src/index.js'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
}

// ---------------------------------------------------------------------------
// Custom tools for legal analysis
// ---------------------------------------------------------------------------

const issues: Array<{ clause: string; issue: string; severity: string }> = []

const analyzeClause: Tool = defineTool({
  name: 'analyze_clause',
  description: 'Analyze a contract clause for legal risks. Returns a risk assessment with identified concerns.',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      clause: { type: 'string', description: 'The contract clause text to analyze' },
      context: { type: 'string', description: 'Additional context (e.g., "employment", "NDA")' },
    },
    required: ['clause'],
  },
  async execute(input) {
    const { clause, context } = input as { clause: string; context?: string }
    // In production this would call a legal analysis API or LLM
    const risks: string[] = []
    if (clause.toLowerCase().includes('indemnif')) risks.push('Contains indemnification — verify scope and caps')
    if (clause.toLowerCase().includes('terminat')) risks.push('Termination clause — check notice period and grounds')
    if (clause.toLowerCase().includes('non-compete')) risks.push('Non-compete — may be unenforceable in some jurisdictions')
    if (clause.toLowerCase().includes('unlimited')) risks.push('Unlimited liability — consider adding caps')
    if (clause.toLowerCase().includes('waiv')) risks.push('Waiver of rights — verify informed consent')
    if (risks.length === 0) risks.push('No obvious risks detected — manual review recommended')
    return {
      content: `Risk Assessment${context ? ` (${context})` : ''}:\n${risks.map(r => `  - ${r}`).join('\n')}`,
      isError: false,
    }
  },
})

const searchPrecedent: Tool = defineTool({
  name: 'search_precedent',
  description: 'Search for relevant legal precedents and case law related to a contract issue.',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Legal issue to search for' },
    },
    required: ['query'],
  },
  async execute(input) {
    const { query } = input as { query: string }
    // Mock — in production this queries a legal database
    return {
      content: `Precedent search for: "${query}"\n` +
        '  1. Smith v. Corp Inc (2023) — Limitation of liability clauses must be conspicuous\n' +
        '  2. Davis v. TechCo (2022) — Non-compete enforceability varies by jurisdiction\n' +
        '  3. Johnson v. Employer LLC (2024) — Indemnification requires clear scope definition',
      isError: false,
    }
  },
})

const flagIssue: Tool = defineTool({
  name: 'flag_issue',
  description: 'Flag an issue found in the contract for the final report.',
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      clause: { type: 'string', description: 'The clause text where the issue was found' },
      issue: { type: 'string', description: 'Description of the issue' },
      severity: {
        type: 'string',
        description: 'Severity level',
        enum: ['low', 'medium', 'high'],
      },
    },
    required: ['clause', 'issue', 'severity'],
  },
  async execute(input) {
    const { clause, issue, severity } = input as { clause: string; issue: string; severity: string }
    issues.push({ clause: clause.slice(0, 100), issue, severity })
    const icon = severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '🟢'
    return {
      content: `Issue flagged [${severity.toUpperCase()}]: ${issue}`,
      isError: false,
    }
  },
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const filePath = process.argv[2]
if (!filePath) {
  console.log(`${C.bold}Legal Contract Analyst${C.reset}`)
  console.log(`Usage: npx tsx examples/legal-agent.ts <contract-file>`)
  console.log(`\nExample: npx tsx examples/legal-agent.ts ./sample-contract.txt`)
  process.exit(1)
}

let contractText: string
try {
  contractText = await fs.readFile(filePath, 'utf-8')
} catch (e) {
  console.error(`${C.red}Error:${C.reset} Cannot read file: ${filePath}`)
  process.exit(1)
}

console.log(`${C.bold}Legal Contract Analyst${C.reset}`)
console.log(`${C.dim}Analyzing: ${filePath} (${contractText.length} characters)${C.reset}\n`)

const result = await Loom.run('anthropic:claude-sonnet-4-20250514', [
  `Analyze this contract thoroughly. For each section:`,
  `1. Use analyze_clause to assess risks`,
  `2. Use search_precedent for any concerning clauses`,
  `3. Use flag_issue for every problem found (with severity)`,
  `4. After analyzing all sections, write a summary report`,
  `\nContract text:\n---\n${contractText}\n---`,
].join('\n'), {
  tools: [analyzeClause, searchPrecedent, flagIssue],
  systemPrompt:
    'You are a senior legal contract analyst. Review contracts clause by clause. ' +
    'Flag any risks, ambiguities, or missing protections. Be thorough and precise. ' +
    'Always search for relevant precedents when you find an issue.',
  maxTurns: 20,
})

// Print summary
console.log(`\n${C.bold}Analysis Complete${C.reset}`)
console.log(`${C.dim}─────────────────────────────────────────${C.reset}`)
console.log(result.text)

if (issues.length > 0) {
  console.log(`\n${C.bold}Flagged Issues (${issues.length}):${C.reset}`)
  for (const issue of issues) {
    const color = issue.severity === 'high' ? C.red : issue.severity === 'medium' ? C.yellow : C.green
    console.log(`  ${color}[${issue.severity.toUpperCase()}]${C.reset} ${issue.issue}`)
    console.log(`    ${C.dim}Clause: "${issue.clause}..."${C.reset}`)
  }
}

console.log(`\n${C.dim}Tokens: ${result.usage.inputTokens.toLocaleString()} in / ${result.usage.outputTokens.toLocaleString()} out | Turns: ${result.turnCount}${C.reset}`)
