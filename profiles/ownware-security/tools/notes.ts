/**
 * Notes Tool
 *
 * In-memory note-taking for the security review agent.
 * Allows the orchestrator to maintain findings, observations,
 * and methodology notes across the assessment.
 *
 * Mirrors Strix's notes system.
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface Note {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly category: string
  readonly tags: readonly string[]
  readonly createdAt: string
  updatedAt: string
}

const notesStore = new Map<string, Note>()
let nextNoteId = 1

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const createNote: Tool = defineTool({
  name: 'create_note',
  description:
    'Create a note to track findings, observations, or methodology.\n' +
    '- Use to record important observations during the assessment.\n' +
    '- Categories: general, findings, methodology, questions, plan',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      content: { type: 'string', description: 'Note content' },
      category: {
        type: 'string',
        enum: ['general', 'findings', 'methodology', 'questions', 'plan'],
        description: 'Note category. Default: general',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for filtering',
      },
    },
    required: ['title', 'content'],
  },
  async execute(input) {
    const title = (input.title as string)?.trim()
    const content = (input.content as string)?.trim()
    const category = (input.category as string) ?? 'general'
    const tags = (input.tags as string[]) ?? []

    if (!title) return { content: 'Error: title cannot be empty', isError: true }
    if (!content) return { content: 'Error: content cannot be empty', isError: true }

    const validCategories = ['general', 'findings', 'methodology', 'questions', 'plan']
    if (!validCategories.includes(category)) {
      return { content: `Error: category must be one of: ${validCategories.join(', ')}`, isError: true }
    }

    const id = `note_${String(nextNoteId++).padStart(3, '0')}`
    const now = new Date().toISOString()
    const note: Note = { id, title, content, category, tags, createdAt: now, updatedAt: now }
    notesStore.set(id, note)

    return {
      content: `Note created: [${id}] "${title}" (${category})`,
      isError: false,
      metadata: { noteId: id, category },
    }
  },
})

export const listNotes: Tool = defineTool({
  name: 'list_notes',
  description:
    'List all notes, optionally filtered by category or search term.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['general', 'findings', 'methodology', 'questions', 'plan'],
        description: 'Filter by category',
      },
      search: { type: 'string', description: 'Search in title and content' },
    },
    required: [],
  },
  async execute(input) {
    const category = input.category as string | undefined
    const search = (input.search as string | undefined)?.toLowerCase()

    let notes = Array.from(notesStore.values())

    if (category) {
      notes = notes.filter(n => n.category === category)
    }
    if (search) {
      notes = notes.filter(n =>
        n.title.toLowerCase().includes(search) ||
        n.content.toLowerCase().includes(search),
      )
    }

    if (notes.length === 0) {
      return { content: 'No notes found.', isError: false, metadata: { count: 0 } }
    }

    const lines = notes.map(n =>
      `[${n.id}] (${n.category}) ${n.title}\n  ${n.content.slice(0, 120)}${n.content.length > 120 ? '...' : ''}`,
    )

    return {
      content: `Notes (${notes.length}):\n\n${lines.join('\n\n')}`,
      isError: false,
      metadata: { count: notes.length },
    }
  },
})

export const updateNote: Tool = defineTool({
  name: 'update_note',
  description: 'Update an existing note by ID.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      noteId: { type: 'string', description: 'Note ID to update' },
      title: { type: 'string', description: 'New title (optional)' },
      content: { type: 'string', description: 'New content (optional)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'New tags (optional)' },
    },
    required: ['noteId'],
  },
  async execute(input) {
    const noteId = input.noteId as string
    const note = notesStore.get(noteId)
    if (!note) return { content: `Error: note "${noteId}" not found`, isError: true }

    const updated = { ...note, updatedAt: new Date().toISOString() } as Note & { title: string; content: string; tags: readonly string[] }
    if (input.title) updated.title = (input.title as string).trim()
    if (input.content) updated.content = (input.content as string).trim()
    if (input.tags) (updated as Record<string, unknown>).tags = input.tags as string[]
    notesStore.set(noteId, updated)

    return {
      content: `Note "${noteId}" updated.`,
      isError: false,
      metadata: { noteId },
    }
  },
})
