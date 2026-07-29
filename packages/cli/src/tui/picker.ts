/**
 * The one picker (shell spec): a bottom-anchored fuzzy list worn by
 * `/model` and `/profile` (and the slash palette itself). Grows upward
 * above the prompt, max ~40% of the viewport, filter-as-you-type,
 * ↑/↓ move, enter selects, esc cancels.
 *
 * The fuzzy scoring is pure and exported — provable without a terminal.
 */

import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core'
import { TOKENS } from '../theme.js'

export interface PickerItem {
  readonly id: string
  readonly label: string
  /** Dim right-hand annotation (e.g. `no key`, a description). */
  readonly hint?: string
  /** Unavailable items sort last and render fully dim. */
  readonly muted?: boolean
}

/**
 * Subsequence fuzzy score. Higher is better; null = no match.
 * Contiguous runs and prefix hits score up; the empty query matches all.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q === '') return 0
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    streak = found === ti ? streak + 1 : 1
    score += streak
    if (found === 0) score += 2
    ti = found + 1
  }
  return score
}

export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.id}`) }))
    .filter((entry): entry is { item: PickerItem; score: number } => entry.score !== null)
    .sort((a, b) => {
      if (a.item.muted !== b.item.muted) return a.item.muted === true ? 1 : -1
      return b.score - a.score
    })
    .map((entry) => entry.item)
}

const MAX_ROWS = 10

export class Picker {
  readonly box: BoxRenderable
  private readonly titleLine: TextRenderable
  private readonly rows: TextRenderable[]
  private readonly dimT = fg(TOKENS.carbonDim)
  private readonly accentT = fg(TOKENS.cobalt)
  private readonly boneT = fg(TOKENS.bone)

  private items: readonly PickerItem[] = []
  private filtered: PickerItem[] = []
  private title = ''
  private query = ''
  private cursor = 0
  private onDone: ((id: string | null) => void) | null = null

  constructor(private readonly renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      width: '100%',
      height: 0,
      flexDirection: 'column',
      visible: false,
    })
    this.titleLine = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
    this.box.add(this.titleLine)
    this.rows = Array.from({ length: MAX_ROWS }, () => {
      const row = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
      this.box.add(row)
      return row
    })
  }

  get visible(): boolean {
    return this.box.visible
  }

  /** Rows currently displayed (title + list) — the footer height share. */
  get height(): number {
    if (!this.box.visible) return 0
    return 1 + this.visibleRows()
  }

  private visibleRows(): number {
    const viewportShare = Math.max(3, Math.floor(this.renderer.height * 0.4) - 1)
    return Math.min(this.filtered.length, MAX_ROWS, viewportShare)
  }

  open(
    title: string,
    items: readonly PickerItem[],
    onDone: (id: string | null) => void,
    initialQuery = '',
  ): void {
    this.title = title
    this.items = items
    this.query = initialQuery
    this.cursor = 0
    this.onDone = onDone
    this.refilter()
    this.box.visible = true
    this.paint()
  }

  private close(result: string | null): void {
    const done = this.onDone
    this.onDone = null
    this.box.visible = false
    this.items = []
    this.filtered = []
    this.query = ''
    done?.(result)
  }

  /** Route one key. Returns true while the picker stays open. */
  handleKey(name: string, ctrl: boolean): boolean {
    if (!this.box.visible) return false
    if (name === 'escape' || (ctrl && name === 'c')) {
      this.close(null)
      return true
    }
    if (name === 'return' || name === 'kpenter' || name === 'linefeed') {
      this.close(this.filtered[this.cursor]?.id ?? null)
      return true
    }
    if (name === 'up') {
      this.cursor = Math.max(0, this.cursor - 1)
    } else if (name === 'down') {
      this.cursor = Math.min(Math.max(0, this.filtered.length - 1), this.cursor + 1)
    } else if (name === 'backspace' || name === 'delete') {
      this.query = this.query.slice(0, -1)
      this.refilter()
    } else if (name === 'space') {
      this.query += ' '
      this.refilter()
    } else if (name.length === 1 && !ctrl) {
      this.query += name
      this.refilter()
    }
    this.paint()
    return true
  }

  private refilter(): void {
    this.filtered = filterItems(this.items, this.query)
    this.cursor = 0
  }

  paint(): void {
    if (!this.box.visible) return
    const shown = this.visibleRows()
    this.box.height = 1 + shown
    this.titleLine.content = new StyledText([
      this.accentT(this.title),
      this.dimT(' › '),
      this.boneT(this.query === '' ? '' : this.query),
      this.dimT(this.query === '' ? 'type to filter' : ''),
      this.dimT(
        `   ${this.filtered.length} match${this.filtered.length === 1 ? '' : 'es'} · ↑↓ · enter · esc`,
      ),
    ])
    // Keep the cursor inside the window.
    const start = Math.max(0, Math.min(this.cursor - shown + 1, this.filtered.length - shown))
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = this.rows[i]!
      if (i >= shown) {
        row.visible = false
        continue
      }
      row.visible = true
      const item = this.filtered[start + i]
      if (item === undefined) {
        row.content = ''
        continue
      }
      const selected = start + i === this.cursor
      const chunks: TextChunk[] = [
        selected ? this.accentT('❯ ') : this.dimT('  '),
        item.muted === true
          ? this.dimT(item.label)
          : selected
            ? this.boneT(item.label)
            : this.dimT(item.label),
      ]
      if (item.hint !== undefined) chunks.push(this.dimT(`  ${item.hint}`))
      row.content = new StyledText(chunks)
    }
    this.renderer.requestRender()
  }
}
