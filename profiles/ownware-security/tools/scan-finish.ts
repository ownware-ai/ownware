/**
 * Scan Finish Tool
 *
 * Completes the security review with a structured final report.
 * Only the root/orchestrator agent should call this.
 *
 * Requires: executive_summary, methodology, technical_analysis, recommendations.
 * All fields must be substantive — the tool validates non-empty content.
 *
 * Mirrors Strix's finish_scan tool.
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

export const finishScan: Tool = defineTool({
  name: 'finish_scan',
  description:
    'Complete the security review with a structured final report.\n' +
    '- Only the root/orchestrator agent should call this.\n' +
    '- All sub-agents must have finished before calling.\n' +
    '- Requires substantive content in all four fields.\n' +
    '- Call list_vulnerability_reports first to verify all findings are captured.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      executiveSummary: {
        type: 'string',
        description: 'High-level overview of findings for non-technical stakeholders. Include: scope tested, key findings count by severity, overall risk assessment.',
      },
      methodology: {
        type: 'string',
        description: 'What testing was performed — phases completed, tools used, approach taken, scan mode, areas covered.',
      },
      technicalAnalysis: {
        type: 'string',
        description: 'Detailed technical findings summary — common vulnerability patterns, attack surface analysis, notable technical observations.',
      },
      recommendations: {
        type: 'string',
        description: 'Prioritized remediation recommendations — ordered by severity and business impact, with specific actionable steps.',
      },
    },
    required: ['executiveSummary', 'methodology', 'technicalAnalysis', 'recommendations'],
  },
  async execute(input) {
    const {
      executiveSummary,
      methodology,
      technicalAnalysis,
      recommendations,
    } = input as Record<string, string>

    // --- Validate ---
    const fields: Array<[string, string]> = [
      ['executiveSummary', executiveSummary],
      ['methodology', methodology],
      ['technicalAnalysis', technicalAnalysis],
      ['recommendations', recommendations],
    ]

    const empty = fields.filter(([, val]) => !val || !val.trim()).map(([name]) => name)
    if (empty.length > 0) {
      return {
        content: `Error: These fields cannot be empty: ${empty.join(', ')}.\nAll four sections are required for a complete scan report.`,
        isError: true,
      }
    }

    const tooShort = fields.filter(([, val]) => val.trim().length < 50).map(([name]) => name)
    if (tooShort.length > 0) {
      return {
        content: `Error: These fields are too brief (minimum 50 characters each): ${tooShort.join(', ')}.\nProvide substantive content for the final report.`,
        isError: true,
      }
    }

    // --- Build report ---
    const report = [
      '# Security Review — Final Report',
      '',
      '## Executive Summary',
      executiveSummary.trim(),
      '',
      '## Methodology',
      methodology.trim(),
      '',
      '## Technical Analysis',
      technicalAnalysis.trim(),
      '',
      '## Recommendations',
      recommendations.trim(),
      '',
      `---`,
      `Report generated: ${new Date().toISOString()}`,
    ].join('\n')

    return {
      content: `Security review completed successfully.\n\n${report}`,
      isError: false,
      metadata: {
        scanCompleted: true,
        reportLength: report.length,
        sections: {
          executiveSummary: executiveSummary.trim().length,
          methodology: methodology.trim().length,
          technicalAnalysis: technicalAnalysis.trim().length,
          recommendations: recommendations.trim().length,
        },
      },
    }
  },
})
