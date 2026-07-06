/**
 * Vulnerability Reporting Tool
 *
 * Creates structured vulnerability reports with CVSS 3.1 scoring,
 * CWE/CVE identifiers, code locations, and remediation guidance.
 *
 * Reports are stored in the tool context and surfaced at scan completion.
 * LLM-based deduplication prevents duplicate reports for the same root cause.
 *
 * Modeled after Strix's create_vulnerability_report.
 */

import { defineTool } from '@ownware/loom'
import type { Tool, ToolContext } from '@ownware/loom'

// ---------------------------------------------------------------------------
// CVSS 3.1 Calculator
// ---------------------------------------------------------------------------

interface CvssVector {
  readonly attackVector: 'N' | 'A' | 'L' | 'P'
  readonly attackComplexity: 'L' | 'H'
  readonly privilegesRequired: 'N' | 'L' | 'H'
  readonly userInteraction: 'N' | 'R'
  readonly scope: 'U' | 'C'
  readonly confidentiality: 'N' | 'L' | 'H'
  readonly integrity: 'N' | 'L' | 'H'
  readonly availability: 'N' | 'L' | 'H'
}

const AV_WEIGHTS: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.20 }
const AC_WEIGHTS: Record<string, number> = { L: 0.77, H: 0.44 }
const UI_WEIGHTS: Record<string, number> = { N: 0.85, R: 0.62 }
const CIA_WEIGHTS: Record<string, number> = { H: 0.56, L: 0.22, N: 0 }

function prWeights(scope: string): Record<string, number> {
  return scope === 'C'
    ? { N: 0.85, L: 0.68, H: 0.50 }
    : { N: 0.85, L: 0.62, H: 0.27 }
}

function calculateCvss(v: CvssVector): { score: number; severity: string; vector: string } {
  const av = AV_WEIGHTS[v.attackVector] ?? 0
  const ac = AC_WEIGHTS[v.attackComplexity] ?? 0
  const pr = prWeights(v.scope)[v.privilegesRequired] ?? 0
  const ui = UI_WEIGHTS[v.userInteraction] ?? 0
  const c = CIA_WEIGHTS[v.confidentiality] ?? 0
  const i = CIA_WEIGHTS[v.integrity] ?? 0
  const a = CIA_WEIGHTS[v.availability] ?? 0

  const iss = 1 - ((1 - c) * (1 - i) * (1 - a))
  if (iss <= 0) return { score: 0, severity: 'none', vector: formatVector(v) }

  const impact = v.scope === 'C'
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss

  const exploitability = 8.22 * av * ac * pr * ui

  let score: number
  if (v.scope === 'C') {
    score = Math.min(1.08 * (impact + exploitability), 10)
  } else {
    score = Math.min(impact + exploitability, 10)
  }

  score = Math.ceil(score * 10) / 10

  let severity: string
  if (score === 0) severity = 'none'
  else if (score <= 3.9) severity = 'low'
  else if (score <= 6.9) severity = 'medium'
  else if (score <= 8.9) severity = 'high'
  else severity = 'critical'

  return { score, severity, vector: formatVector(v) }
}

function formatVector(v: CvssVector): string {
  return `CVSS:3.1/AV:${v.attackVector}/AC:${v.attackComplexity}/PR:${v.privilegesRequired}/UI:${v.userInteraction}/S:${v.scope}/C:${v.confidentiality}/I:${v.integrity}/A:${v.availability}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_AV = new Set(['N', 'A', 'L', 'P'])
const VALID_AC = new Set(['L', 'H'])
const VALID_PR = new Set(['N', 'L', 'H'])
const VALID_UI = new Set(['N', 'R'])
const VALID_SCOPE = new Set(['U', 'C'])
const VALID_CIA = new Set(['N', 'L', 'H'])

function validateCvss(v: Record<string, string>): string[] {
  const errors: string[] = []
  if (!VALID_AV.has(v.attackVector)) errors.push(`Invalid attackVector: ${v.attackVector}. Must be N, A, L, or P`)
  if (!VALID_AC.has(v.attackComplexity)) errors.push(`Invalid attackComplexity: ${v.attackComplexity}. Must be L or H`)
  if (!VALID_PR.has(v.privilegesRequired)) errors.push(`Invalid privilegesRequired: ${v.privilegesRequired}. Must be N, L, or H`)
  if (!VALID_UI.has(v.userInteraction)) errors.push(`Invalid userInteraction: ${v.userInteraction}. Must be N or R`)
  if (!VALID_SCOPE.has(v.scope)) errors.push(`Invalid scope: ${v.scope}. Must be U or C`)
  if (!VALID_CIA.has(v.confidentiality)) errors.push(`Invalid confidentiality: ${v.confidentiality}. Must be N, L, or H`)
  if (!VALID_CIA.has(v.integrity)) errors.push(`Invalid integrity: ${v.integrity}. Must be N, L, or H`)
  if (!VALID_CIA.has(v.availability)) errors.push(`Invalid availability: ${v.availability}. Must be N, L, or H`)
  return errors
}

function validateCve(cve: string): boolean {
  return /^CVE-\d{4}-\d{4,}$/.test(cve)
}

function validateCwe(cwe: string): boolean {
  return /^CWE-\d+$/.test(cwe)
}

// ---------------------------------------------------------------------------
// Report Storage (in-memory, scoped to context)
// ---------------------------------------------------------------------------

interface VulnerabilityReport {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly severity: string
  readonly impact: string
  readonly target: string
  readonly technicalAnalysis: string
  readonly pocDescription: string
  readonly pocCode: string
  readonly remediation: string
  readonly cvssScore: number
  readonly cvssVector: string
  readonly cvssBreakdown: CvssVector
  readonly endpoint?: string
  readonly method?: string
  readonly cve?: string
  readonly cwe?: string
  readonly codeLocations?: ReadonlyArray<{
    readonly file: string
    readonly startLine: number
    readonly endLine: number
    readonly snippet?: string
    readonly label?: string
    readonly fixBefore?: string
    readonly fixAfter?: string
  }>
  readonly createdAt: string
}

// Global report store keyed by the ROOT session id.
//
// rootSessionId is shared across the whole agent tree, sessionId is per-agent.
// The security flow files findings from a `reporter` sub-agent but the
// orchestrator (and list_vulnerability_reports) must read them back — so we key
// by the root session, not the per-agent one, or the two would see different
// stores. Falls back to the per-agent id, then a constant, for direct callers
// (tests) that don't set a tree.
const reportStore = new Map<string, VulnerabilityReport[]>()

function getReports(context: ToolContext): VulnerabilityReport[] {
  const key = context.rootSessionId || context.sessionId || 'default'
  if (!reportStore.has(key)) {
    reportStore.set(key, [])
  }
  return reportStore.get(key)!
}

function generateReportId(): string {
  return `vuln-${crypto.randomUUID().slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// Simple deduplication (title + endpoint + target similarity)
// ---------------------------------------------------------------------------

function isDuplicate(
  candidate: { title: string; endpoint?: string; target: string; technicalAnalysis: string },
  existing: VulnerabilityReport[],
): { duplicate: boolean; duplicateOf?: string; reason?: string } {
  for (const report of existing) {
    // Same title (case-insensitive) + same target
    if (
      report.title.toLowerCase().trim() === candidate.title.toLowerCase().trim() &&
      report.target.toLowerCase().trim() === candidate.target.toLowerCase().trim()
    ) {
      return {
        duplicate: true,
        duplicateOf: report.id,
        reason: `Same title and target as existing report "${report.title}" (${report.id})`,
      }
    }

    // Same endpoint + same target + overlapping technical analysis
    if (
      candidate.endpoint &&
      report.endpoint &&
      report.endpoint.toLowerCase() === candidate.endpoint.toLowerCase() &&
      report.target.toLowerCase() === candidate.target.toLowerCase()
    ) {
      // Check for significant overlap in technical analysis
      const existingWords = new Set(report.technicalAnalysis.toLowerCase().split(/\s+/).filter(w => w.length > 4))
      const candidateWords = candidate.technicalAnalysis.toLowerCase().split(/\s+/).filter(w => w.length > 4)
      const overlap = candidateWords.filter(w => existingWords.has(w)).length
      const overlapRatio = candidateWords.length > 0 ? overlap / candidateWords.length : 0

      if (overlapRatio > 0.6) {
        return {
          duplicate: true,
          duplicateOf: report.id,
          reason: `Same endpoint "${report.endpoint}" on target "${report.target}" with similar technical analysis (${Math.round(overlapRatio * 100)}% overlap) as "${report.title}" (${report.id})`,
        }
      }
    }
  }

  return { duplicate: false }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const createVulnerabilityReport: Tool = defineTool({
  name: 'create_vulnerability_report',
  description:
    'Create a formal vulnerability report with CVSS 3.1 scoring.\n' +
    '- This is the ONLY way to formally report a vulnerability.\n' +
    '- Reports mentioned in messages or finish_scan do NOT count.\n' +
    '- The tool validates all fields and calculates CVSS score.\n' +
    '- Automatic deduplication prevents duplicate reports.\n' +
    '- If deduplication rejects the report, do NOT re-submit.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  // A finding is a panel/card surface (the security Report), not a one-line
  // tool row — `conversational` opts out of the inline chat row so the
  // client routes it to a dedicated renderer. The full structured finding rides in
  // the result `metadata` (observability-only, never sent to the model) so the
  // renderer can build the card without re-parsing the text summary.
  uiDescriptor: {
    kind: 'conversational',
    summary: {
      verb: 'Reported finding',
      primaryField: 'title',
      metaFields: ['cwe', 'endpoint'],
    },
  },
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Concise vulnerability title (e.g., "SQL Injection in /api/search via q parameter")',
      },
      description: {
        type: 'string',
        description: 'What the vulnerability is — clear, non-technical summary',
      },
      impact: {
        type: 'string',
        description: 'Business and technical impact of exploitation',
      },
      target: {
        type: 'string',
        description: 'The affected system/application (URL, domain, or codebase path)',
      },
      technicalAnalysis: {
        type: 'string',
        description: 'Root cause analysis — why the vulnerability exists',
      },
      pocDescription: {
        type: 'string',
        description: 'Step-by-step description of how to reproduce the issue',
      },
      pocCode: {
        type: 'string',
        description: 'Actual exploit script, payload, or curl command that demonstrates the vulnerability',
      },
      remediation: {
        type: 'string',
        description: 'Specific, actionable steps to fix the vulnerability',
      },
      attackVector: {
        type: 'string',
        enum: ['N', 'A', 'L', 'P'],
        description: 'CVSS Attack Vector: N=Network, A=Adjacent, L=Local, P=Physical',
      },
      attackComplexity: {
        type: 'string',
        enum: ['L', 'H'],
        description: 'CVSS Attack Complexity: L=Low, H=High',
      },
      privilegesRequired: {
        type: 'string',
        enum: ['N', 'L', 'H'],
        description: 'CVSS Privileges Required: N=None, L=Low, H=High',
      },
      userInteraction: {
        type: 'string',
        enum: ['N', 'R'],
        description: 'CVSS User Interaction: N=None, R=Required',
      },
      scope: {
        type: 'string',
        enum: ['U', 'C'],
        description: 'CVSS Scope: U=Unchanged, C=Changed',
      },
      confidentiality: {
        type: 'string',
        enum: ['N', 'L', 'H'],
        description: 'CVSS Confidentiality Impact: N=None, L=Low, H=High',
      },
      integrity: {
        type: 'string',
        enum: ['N', 'L', 'H'],
        description: 'CVSS Integrity Impact: N=None, L=Low, H=High',
      },
      availability: {
        type: 'string',
        enum: ['N', 'L', 'H'],
        description: 'CVSS Availability Impact: N=None, L=Low, H=High',
      },
      endpoint: {
        type: 'string',
        description: 'Specific URL path or API endpoint (e.g., /api/users/123)',
      },
      method: {
        type: 'string',
        description: 'HTTP method (GET, POST, PUT, DELETE, etc.)',
      },
      cve: {
        type: 'string',
        description: 'CVE identifier if known (format: CVE-YYYY-NNNNN)',
      },
      cwe: {
        type: 'string',
        description: 'CWE identifier (format: CWE-NNN)',
      },
      codeLocations: {
        type: 'string',
        description: 'JSON array of code locations: [{"file":"path","startLine":1,"endLine":10,"snippet":"code","label":"description","fixBefore":"old","fixAfter":"new"}]',
      },
    },
    required: [
      'title',
      'description',
      'impact',
      'target',
      'technicalAnalysis',
      'pocDescription',
      'pocCode',
      'remediation',
      'attackVector',
      'attackComplexity',
      'privilegesRequired',
      'userInteraction',
      'scope',
      'confidentiality',
      'integrity',
      'availability',
    ],
  },
  async execute(input, context) {
    const {
      title, description, impact, target, technicalAnalysis,
      pocDescription, pocCode, remediation,
      attackVector, attackComplexity, privilegesRequired,
      userInteraction, scope, confidentiality, integrity, availability,
      endpoint, method, cve, cwe, codeLocations,
    } = input as Record<string, string>

    // --- Validate required fields ---
    const requiredFields: Array<[string, string]> = [
      ['title', title],
      ['description', description],
      ['impact', impact],
      ['target', target],
      ['technicalAnalysis', technicalAnalysis],
      ['pocDescription', pocDescription],
      ['pocCode', pocCode],
      ['remediation', remediation],
    ]

    const missingFields = requiredFields
      .filter(([, val]) => !val || !val.trim())
      .map(([name]) => name)

    if (missingFields.length > 0) {
      return {
        content: `Error: Missing required fields: ${missingFields.join(', ')}`,
        isError: true,
      }
    }

    // --- Validate CVSS ---
    const cvssInput = {
      attackVector, attackComplexity, privilegesRequired,
      userInteraction, scope, confidentiality, integrity, availability,
    }
    const cvssErrors = validateCvss(cvssInput)
    if (cvssErrors.length > 0) {
      return {
        content: `Error: CVSS validation failed:\n${cvssErrors.join('\n')}`,
        isError: true,
      }
    }

    // --- Validate optional fields ---
    if (cve && !validateCve(cve)) {
      return {
        content: `Error: Invalid CVE format "${cve}". Expected CVE-YYYY-NNNNN`,
        isError: true,
      }
    }
    if (cwe && !validateCwe(cwe)) {
      return {
        content: `Error: Invalid CWE format "${cwe}". Expected CWE-NNN`,
        isError: true,
      }
    }

    // --- Parse code locations ---
    let parsedCodeLocations: VulnerabilityReport['codeLocations']
    if (codeLocations) {
      try {
        parsedCodeLocations = JSON.parse(codeLocations)
      } catch {
        return {
          content: 'Error: codeLocations must be valid JSON array',
          isError: true,
        }
      }
    }

    // --- Calculate CVSS ---
    const cvssVector = cvssInput as unknown as CvssVector
    const cvss = calculateCvss(cvssVector)

    // --- Check for duplicates ---
    const reports = getReports(context)
    const dedupeResult = isDuplicate(
      { title, endpoint, target, technicalAnalysis },
      reports,
    )
    if (dedupeResult.duplicate) {
      return {
        content: `Report rejected — duplicate of existing report ${dedupeResult.duplicateOf}.\nReason: ${dedupeResult.reason}\nDo NOT re-submit this vulnerability.`,
        isError: true,
        metadata: {
          duplicate: true,
          duplicateOf: dedupeResult.duplicateOf,
          reason: dedupeResult.reason,
        },
      }
    }

    // --- Create report ---
    const report: VulnerabilityReport = {
      id: generateReportId(),
      title: title.trim(),
      description: description.trim(),
      severity: cvss.severity,
      impact: impact.trim(),
      target: target.trim(),
      technicalAnalysis: technicalAnalysis.trim(),
      pocDescription: pocDescription.trim(),
      pocCode: pocCode.trim(),
      remediation: remediation.trim(),
      cvssScore: cvss.score,
      cvssVector: cvss.vector,
      cvssBreakdown: cvssVector,
      endpoint: endpoint?.trim() || undefined,
      method: method?.trim().toUpperCase() || undefined,
      cve: cve?.trim() || undefined,
      cwe: cwe?.trim() || undefined,
      codeLocations: parsedCodeLocations,
      createdAt: new Date().toISOString(),
    }

    reports.push(report)

    return {
      content: `Vulnerability report created successfully.\n\nID: ${report.id}\nTitle: ${report.title}\nSeverity: ${report.severity.toUpperCase()}\nCVSS: ${report.cvssScore} (${report.cvssVector})\nTarget: ${report.target}${report.endpoint ? `\nEndpoint: ${report.endpoint}` : ''}${report.cwe ? `\nCWE: ${report.cwe}` : ''}`,
      isError: false,
      // `finding` carries the entire structured report so the client's renderer
      // can build the Findings card (severity, PoC, file locations, remediation)
      // without re-parsing the text summary above. metadata is observability-
      // only — it is NOT sent back to the model, so this costs zero model tokens.
      metadata: {
        finding: report,
        reportId: report.id,
        severity: report.severity,
        cvssScore: report.cvssScore,
        cvssVector: report.cvssVector,
        totalReports: reports.length,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// List Reports Tool
// ---------------------------------------------------------------------------

export const listVulnerabilityReports: Tool = defineTool({
  name: 'list_vulnerability_reports',
  description:
    'List all vulnerability reports created during this scan.\n' +
    '- Shows report ID, title, severity, CVSS score, and target.\n' +
    '- Use to check what has already been reported and avoid duplicates.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low', 'none'],
        description: 'Filter by severity level. Omit for all.',
      },
    },
    required: [],
  },
  async execute(input, context) {
    const reports = getReports(context)
    const severity = input.severity as string | undefined

    const filtered = severity
      ? reports.filter(r => r.severity === severity)
      : reports

    if (filtered.length === 0) {
      return {
        content: severity
          ? `No ${severity} vulnerability reports found.`
          : 'No vulnerability reports found.',
        isError: false,
        metadata: { totalReports: 0 },
      }
    }

    const lines = filtered.map(r =>
      `[${r.id}] ${r.severity.toUpperCase()} (${r.cvssScore}) — ${r.title}\n  Target: ${r.target}${r.endpoint ? ` | Endpoint: ${r.endpoint}` : ''}${r.cwe ? ` | ${r.cwe}` : ''}`,
    )

    const summary: Record<string, number> = {}
    for (const r of reports) {
      summary[r.severity] = (summary[r.severity] ?? 0) + 1
    }

    const summaryLine = Object.entries(summary)
      .sort(([a], [b]) => {
        const order = ['critical', 'high', 'medium', 'low', 'none']
        return order.indexOf(a) - order.indexOf(b)
      })
      .map(([sev, count]) => `${count} ${sev}`)
      .join(', ')

    return {
      content: `Vulnerability Reports (${filtered.length} total — ${summaryLine}):\n\n${lines.join('\n\n')}`,
      isError: false,
      metadata: {
        totalReports: filtered.length,
        summary,
      },
    }
  },
})
