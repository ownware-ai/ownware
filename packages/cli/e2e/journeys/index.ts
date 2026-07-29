/**
 * The catalogue. Order is roughly "first thing a customer meets" first.
 *
 * Every journey names the customer, what they expect, and what a BAD
 * experience would look like — that last field is the brief the judge
 * pass reads before looking at the captured screen. Checks in the
 * journey cover what a machine can decide; everything about whether the
 * screen is understandable is deliberately left to the judge.
 */

import type { Journey } from '../harness/journey.ts'
import { helpFirstContact } from './help-first-contact.ts'
import { noProviderDeadEnd } from './no-provider-dead-end.ts'
import { firstRunKeyless } from './first-run-keyless.ts'
import { narrowTerminal } from './narrow-terminal.ts'
import { noColorTerminal } from './no-color-terminal.ts'
import { pipedNonTty } from './piped-non-tty.ts'
import { cancelMidRun } from './cancel-mid-run.ts'
import { escBeforeFirstToken } from './esc-before-first-token.ts'
import { resumeNextMorning, resumeNextMorningTruth } from './resume-next-morning.ts'
import { tuiFirstContact } from './tui-first-contact.ts'
import { toolStory, toolStoryTruth } from './tool-story.ts'
import { checkpointSecretCanary } from './checkpoint-secret-canary.ts'
import { ctrlCCold, ctrlCAfterTurn, ctrlCAfterCancel } from './ctrl-c-after-a-turn.ts'

export const JOURNEYS: readonly Journey[] = [
  helpFirstContact,
  noProviderDeadEnd,
  firstRunKeyless,
  tuiFirstContact,
  narrowTerminal,
  noColorTerminal,
  pipedNonTty,
  cancelMidRun,
  escBeforeFirstToken,
  resumeNextMorning,
  resumeNextMorningTruth,
  toolStory,
  toolStoryTruth,
  checkpointSecretCanary,
  ctrlCCold,
  ctrlCAfterTurn,
  ctrlCAfterCancel,
]
