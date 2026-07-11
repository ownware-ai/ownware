// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { OwnwareStudio, type AgentTransport } from '../index.js'
import type { RunResult, ModelEntry } from '@ownware/client'

afterEach(cleanup)

function fakeTransport(): AgentTransport {
  return {
    run: vi.fn(async (): Promise<RunResult> => ({ threadId: 't-1' })),
    async *events() {
      /* no events for this structural test */
    },
    resume: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    models: vi.fn(async (): Promise<ModelEntry[]> => [{ id: 'ollama:llama3.2', hasCredentials: true, default: true }]),
  }
}

describe('<OwnwareStudio>', () => {
  const profiles = [
    { id: 'rosa', name: 'Rosa · support' },
    { id: 'lex', name: 'Lex · legal' },
  ]

  it('renders the shell: brand, profile picker, and an auto-opened conversation', () => {
    render(<OwnwareStudio client={fakeTransport()} profiles={profiles} brand="ownware" />)

    expect(screen.getByText('ownware')).toBeTruthy() // sidebar brand
    expect(screen.getByText('New chat')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Rosa · support' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Lex · legal' })).toBeTruthy()
    // the first profile auto-opens a conversation (shown in the sidebar list AND as the chat header)
    expect(screen.getAllByText('Rosa · support').length).toBeGreaterThanOrEqual(2)
  })

  it('adds a conversation on New chat', () => {
    render(<OwnwareStudio client={fakeTransport()} profiles={profiles} />)
    const convosBefore = screen.getAllByText('Rosa · support').length
    act(() => {
      fireEvent.click(screen.getByText('New chat'))
    })
    expect(screen.getAllByText('Rosa · support').length).toBeGreaterThan(convosBefore)
  })
})
