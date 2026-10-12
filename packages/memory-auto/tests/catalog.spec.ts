import { describe, expect, it } from 'vitest'
import {
  deriveCatalogQuery,
  fetchTagCatalog,
  parseTagCatalog,
  writeEntries,
  type McpClient,
} from '../src/digest.js'

function toolResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function fakeClient(handler: (name: string, args: Record<string, unknown>) => unknown): McpClient {
  return {
    callTool: async (name, args) => handler(name, args),
    close: async () => {},
  }
}

describe('deriveCatalogQuery', () => {
  it('is bounded and carries the project', () => {
    const q = deriveCatalogQuery('my-proj', `line1\n\nline2 ${'x'.repeat(500)}`)
    expect(q.startsWith('my-proj ')).toBe(true)
    expect(q.length).toBeLessThanOrEqual(200)
    expect(q).not.toContain('\n')
  })
})

describe('parseTagCatalog', () => {
  it('parses the contracted object shape', () => {
    const parsed = parseTagCatalog(
      toolResult({ tags: [{ name: 'ci', aliases: ['continuous-integration'], count: 3 }], truncated: false }),
    )
    expect(parsed).toEqual({ tags: [{ name: 'ci', aliases: ['continuous-integration'], count: 3 }], truncated: false })
  })

  it('accepts a bare array', () => {
    expect(parseTagCatalog(toolResult([{ name: 'python' }]))).toEqual({
      tags: [{ name: 'python' }],
      truncated: false,
    })
  })

  it('returns null for garbage', () => {
    expect(parseTagCatalog({ content: [{ text: 'not json' }] })).toBeNull()
    expect(parseTagCatalog(toolResult({ nope: 1 }))).toBeNull()
  })
})

describe('fetchTagCatalog', () => {
  it('sends a bounded query with limit and returns the catalog', async () => {
    let seen: Record<string, unknown> = {}
    const client = fakeClient((name, args) => {
      seen = { name, ...args }
      return toolResult({ tags: [{ name: 'ci' }], truncated: true })
    })
    const catalog = await fetchTagCatalog(client, 'my-proj ci pipeline')
    expect(catalog).toEqual({ tags: [{ name: 'ci' }], truncated: true })
    expect(seen.name).toBe('list_tags')
    expect(seen.query).toBe('my-proj ci pipeline')
    expect(seen.limit).toBe(20)
  })

  it('returns null when the server has no list_tags (old server)', async () => {
    const client = fakeClient(() => {
      throw new Error('tool list_tags failed: unknown tool')
    })
    await expect(fetchTagCatalog(client, 'q')).resolves.toBeNull()
  })
})

describe('writeEntries failure accounting', () => {
  const entry = (content: string) => ({
    entry_type: 'fact' as const,
    content,
    description: 'd',
    tags: ['ci'],
    confidence: 0.9,
    openspec_change_id: null,
  })

  it('reports actual counts with no silent loss', async () => {
    let calls = 0
    const client = fakeClient((name) => {
      if (name === 'store_fact') {
        // fail the second write only
        calls += 1
        if (calls === 2) throw new Error('boom')
      }
      return toolResult({ tags: ['ci'], new_tags: [] })
    })
    const res = await writeEntries(client, 'p', [entry('one two three'), entry('four five six')])
    expect(res.upserted).toBe(1)
    expect(res.failed).toBe(1)
  })

  it('collects server-reported new tags', async () => {
    const client = fakeClient(() => toolResult({ tags: ['fresh-tag'], new_tags: ['fresh-tag'] }))
    const res = await writeEntries(client, 'p', [entry('something memorable here')])
    expect(res).toMatchObject({ upserted: 1, failed: 0, newTags: ['fresh-tag'] })
  })

  it('treats old servers without new_tags as plain success', async () => {
    const client = fakeClient(() => toolResult({ created: true }))
    const res = await writeEntries(client, 'p', [entry('something memorable here')])
    expect(res).toMatchObject({ upserted: 1, failed: 0, newTags: [] })
  })
})
