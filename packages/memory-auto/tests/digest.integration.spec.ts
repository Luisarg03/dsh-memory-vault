import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { connectMcp, digestSessionDSM, writeEntries, type DigestConfig } from '../src/digest.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const SERVER_DIR = join(REPO_ROOT, 'memory-vault-server')

/** Scripted ctx.llm: yields the given JSON as one text block, then finishes. */
function mockCtx(entriesJson: string): any {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: entriesJson },
    { type: 'block-end', index: 0, block: { type: 'text', text: entriesJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    llm: {
      async *stream(): AsyncGenerator<StreamChunk> {
        for (const c of chunks) yield c
      },
    },
  }
}

describe('digest integration (real vault server over stdio)', () => {
  let vault: string

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'memint-'))
    const starter = join(REPO_ROOT, 'memory-vault')
    cpSync(join(starter, 'type-registry.yaml'), join(vault, 'type-registry.yaml'))
    cpSync(join(starter, 'tag-vocabulary.json'), join(vault, 'tag-vocabulary.json'))
    cpSync(join(starter, 'templates'), join(vault, 'templates'), { recursive: true })
  })

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true })
  })

  it('writes entries through the MCP server (markdown + FTS5 index)', async () => {
    const client = await connectMcp(vault, SERVER_DIR)
    try {
      const res = await writeEntries(client, 'smoke', [
        { entry_type: 'decision', content: 'use sqlite fts5', description: 'd', tags: ['sqlite'], confidence: 0.9, openspec_change_id: null },
      ])
      expect(res.upserted).toBe(1)
      expect(res.failed).toBe(0)
    } finally {
      await client.close()
    }

    // Markdown source of truth was written (decisions are dated: YYYY-MM-DD-<slug>.md)
    const dir = join(vault, 'projects', 'smoke', 'decisions')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => readFileSync(join(dir, f), 'utf8').includes('use sqlite fts5'))).toBe(true)

    // The FTS5 index can find it through a fresh server connection
    const client2 = await connectMcp(vault, SERVER_DIR)
    try {
      const found = await client2.callTool('search_memory', { project: 'smoke', query: 'sqlite' })
      expect(JSON.stringify(found)).toContain('use sqlite fts5')
    } finally {
      await client2.close()
    }
  })

  it('runs the full digest with a scripted ctx.llm (no external CLI)', async () => {
    const ctx = mockCtx(
      JSON.stringify([
        { entry_type: 'fact', content: 'uv manages the server environment', description: 'env fact', tags: ['uv', 'python'], confidence: 0.8 },
      ]),
    )
    const config: DigestConfig = {
      memoryPath: vault,
      serverDir: SERVER_DIR,
      provider: 'mock',
      model: 'mock',
      maxTokens: 256,
      minTranscriptChars: 10,
    }
    await digestSessionDSM(
      ctx,
      config,
      'sess-1',
      '/tmp/proj',
      'smoke2',
      [
        { type: 'user/message', data: { text: 'we decided uv manages the server environment and that is a fact worth remembering' } },
        { type: 'assistant/message', data: { text: 'ok, noted' } },
      ],
    )
    const md = join(vault, 'projects', 'smoke2', 'facts', 'uv-manages-the-server-environment.md')
    expect(existsSync(md)).toBe(true)
    expect(readFileSync(md, 'utf8')).toContain('uv manages the server environment')
  })

  it('skips digests below the transcript minimum', async () => {
    const ctx = mockCtx('[]')
    const config: DigestConfig = {
      memoryPath: vault,
      serverDir: SERVER_DIR,
      provider: 'mock',
      model: 'mock',
      maxTokens: 256,
      minTranscriptChars: 10_000,
    }
    await digestSessionDSM(ctx, config, 'sess-short', '/tmp', 'smoke3', [
      { type: 'user/message', data: { text: 'hi' } },
    ])
    expect(existsSync(join(vault, 'projects', 'smoke3'))).toBe(false)
  })
})
