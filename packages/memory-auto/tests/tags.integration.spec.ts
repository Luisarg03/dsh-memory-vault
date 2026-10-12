import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { connectMcp, digestSessionDSM, type DigestConfig, type McpClient } from '../src/digest.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const SERVER_DIR = join(REPO_ROOT, 'memory-vault-server')

/** Call a tool and parse its JSON text envelope. */
async function call(client: McpClient, name: string, args: Record<string, unknown>): Promise<any> {
  const res: any = await client.callTool(name, args)
  const text = res?.content?.[0]?.text ?? JSON.stringify(res)
  return JSON.parse(text)
}

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

/** search_memory returns tags as a JSON string; normalize to an array. */
function tagsOf(entry: any): string[] {
  const t = entry?.tags
  if (Array.isArray(t)) return t.map(String)
  if (typeof t === 'string') {
    try {
      const parsed = JSON.parse(t)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

async function withClient<T>(vault: string, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = await connectMcp(vault, SERVER_DIR)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

/**
 * REAL MCP fixture integration (temp vault + real server over stdio — not the
 * stub in plugin-guard.spec.ts): proves the frozen tag contract end to end.
 * Uses MEMORY_PATH/DSH_MEMORY_PATH throughout; never touches ~/.memories.
 *
 * DEFERRED EXECUTION (oracle blockers, server lane live): this fixture is
 * prepared against the FROZEN contract (exclusions = exact full keys) but
 * must NOT run until the server fixes close — the live server still carries
 * the prefix-exclusion bug plus other oracle blockers. Run it for the final
 * validation pass, not while memory-vault-server/* is being edited.
 */
describe('tags contract integration (real vault server over stdio)', () => {
  let vault = ''
  let prevMemoryPath: string | undefined
  let prevDshMemoryPath: string | undefined

  beforeAll(() => {
    prevMemoryPath = process.env.MEMORY_PATH
    prevDshMemoryPath = process.env.DSH_MEMORY_PATH
    vault = mkdtempSync(join(tmpdir(), 'memtags-'))
    process.env.MEMORY_PATH = vault
    process.env.DSH_MEMORY_PATH = vault
    const starter = join(REPO_ROOT, 'memory-vault')
    cpSync(join(starter, 'type-registry.yaml'), join(vault, 'type-registry.yaml'))
    cpSync(join(starter, 'tag-vocabulary.json'), join(vault, 'tag-vocabulary.json'))
    cpSync(join(starter, 'templates'), join(vault, 'templates'), { recursive: true })
  })

  afterAll(() => {
    if (prevMemoryPath === undefined) delete process.env.MEMORY_PATH
    else process.env.MEMORY_PATH = prevMemoryPath
    if (prevDshMemoryPath === undefined) delete process.env.DSH_MEMORY_PATH
    else process.env.DSH_MEMORY_PATH = prevDshMemoryPath
    rmSync(vault, { recursive: true, force: true })
  })

  it('list_tags resolves aliases, counts usage, and registers new tags', async () => {
    await withClient(vault, async (client) => {
      await call(client, 'store_fact', {
        project: 'tagproj',
        content: 'the ci pipeline runs on hosted runners and caches dependencies',
        description: 'ci setup',
        tags: ['ci'],
        confidence: 0.9,
      })
      await call(client, 'store_fact', {
        project: 'tagproj',
        content: 'the deploy queue drains in order and retries with backoff enabled',
        description: 'deploy queue',
        tags: ['ci', 'deploy-queue'],
        confidence: 0.9,
      })

      const ci = await call(client, 'list_tags', { query: 'ci' })
      const cicd = (ci.tags as any[]).find((t) => t.name === 'ci-cd')
      expect(cicd).toBeDefined()
      expect(cicd.aliases).toContain('ci')
      expect(cicd.count).toBe(2)

      const fresh = await call(client, 'list_tags', { query: 'deploy-queue' })
      expect((fresh.tags as any[]).find((t) => t.name === 'deploy-queue')?.count).toBe(1)
      expect(fresh.truncated).toBe(false)
    })
  })

  it('list_tags truncates with limit and excludes nested keys before results', async () => {
    await withClient(vault, async (client) => {
      const page = await call(client, 'list_tags', { query: 'e', limit: 1 })
      expect(page.tags).toHaveLength(1)
      expect(page.truncated).toBe(true)

      await call(client, 'store_fact', {
        project: 'org/repo',
        content: 'nested project entries carry their full key in storage paths',
        description: 'nested key',
        tags: ['ci'],
        confidence: 0.9,
      })
      const used = await call(client, 'list_tags', { project: 'org/repo' })
      expect((used.tags as any[]).some((t) => t.name === 'ci-cd')).toBe(true)
      // Exclusions are EXACT full keys: a parent/prefix key excludes nothing.
      const kept = await call(client, 'list_tags', { project: 'org/repo', exclude_projects: ['org'] })
      expect((kept.tags as any[]).some((t) => t.name === 'ci-cd')).toBe(true)
      const partial = await call(client, 'list_tags', { project: 'org/repo', exclude_projects: ['org/re'] })
      expect((partial.tags as any[]).some((t) => t.name === 'ci-cd')).toBe(true)
      // Only the exact full key excludes: filtered views hide zero-count tags.
      const dropped = await call(client, 'list_tags', { project: 'org/repo', exclude_projects: ['org/repo'] })
      expect((dropped.tags as any[]).some((t) => t.name === 'ci-cd')).toBe(false)
    })
  })

  it('duplicate stores union tags, [] never erases, Markdown and DB agree', async () => {
    const content = 'the release checklist requires a green pipeline plus a second reviewer signoff'
    await withClient(vault, async (client) => {
      const first = await call(client, 'store_fact', {
        project: 'uniproj',
        content,
        description: 'release checklist',
        tags: ['alpha-tag'],
        confidence: 0.9,
      })
      expect(first.new_tags).toContain('alpha-tag')

      const second = await call(client, 'store_fact', {
        project: 'uniproj',
        content,
        description: 'release checklist',
        tags: ['beta-tag'],
        confidence: 0.9,
      })
      expect(second.updated).toBe(true)
      expect(second.tags).toEqual(expect.arrayContaining(['alpha-tag', 'beta-tag']))
      expect(second.new_tags).toContain('beta-tag')

      const third = await call(client, 'store_fact', {
        project: 'uniproj',
        content,
        description: 'release checklist',
        tags: [],
        confidence: 0.9,
      })
      expect(third.tags).toEqual(expect.arrayContaining(['alpha-tag', 'beta-tag']))
    })

    // Markdown source of truth carries the union…
    const dir = join(vault, 'projects', 'uniproj', 'facts')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    const hit = files.map((f) => readFileSync(join(dir, f), 'utf8')).find((t) => t.includes('second reviewer'))
    expect(hit).toBeDefined()
    expect(hit).toContain('alpha-tag')
    expect(hit).toContain('beta-tag')

    // …and the derived index agrees.
    await withClient(vault, async (client) => {
      const found = await call(client, 'search_memory', { project: 'uniproj', query: 'reviewer' })
      expect(found.length).toBeGreaterThan(0)
      expect(tagsOf(found[0])).toEqual(expect.arrayContaining(['alpha-tag', 'beta-tag']))
    })
  })

  it('digest end to end fetches the real catalog and stores canonical tags', async () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      const ctx = mockCtx(
        JSON.stringify([
          {
            entry_type: 'fact',
            content: 'the ci pipeline caches dependencies between runs on hosted runners',
            description: 'ci cache',
            tags: ['ci', 'fresh-digest-tag'],
            confidence: 0.8,
          },
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
        'sess-tags',
        '/tmp',
        'digestproj',
        [{ type: 'user/message', data: { text: 'looking at the ci pipeline cache behavior today' } }],
      )
      expect(warnings.some((w) => w.includes('tag catalog unavailable'))).toBe(false)
    } finally {
      console.warn = origWarn
    }

    await withClient(vault, async (client) => {
      const found = await call(client, 'search_memory', { project: 'digestproj', query: 'caches' })
      expect(found.length).toBeGreaterThan(0)
      // Alias resolved centrally, newcomer kept: never discarded locally.
      expect(tagsOf(found[0])).toEqual(expect.arrayContaining(['ci-cd', 'fresh-digest-tag']))
      const catalog = await call(client, 'list_tags', { query: 'fresh-digest-tag' })
      expect((catalog.tags as any[]).find((t) => t.name === 'fresh-digest-tag')?.count).toBe(1)
    })
  })

  it('brain mechanics: profile first, sources opt-in, exclusions before the 50-cap, zero case', async () => {
    await withClient(vault, async (client) => {
      // Local first: profile behind get_profile.
      await call(client, 'store_profile', {
        project: 'brainproj',
        content: 'stack is python 3.12 with sqlite fts5',
        tags: ['python'],
      })
      const profile = await call(client, 'get_profile', { project: 'brainproj' })
      expect(JSON.stringify(profile)).toContain('python 3.12')

      // Sources are global and opt-in, excluded from default search.
      await call(client, 'store_source', {
        url: 'https://example.com/extern-token-xyz',
        title: 'extern token doc',
        description: 'extern token reference',
        source_kind: 'article',
        tags: ['extern-token-xyz'],
      })
      await call(client, 'store_fact', {
        project: 'brainproj',
        content: 'extern-token-xyz is handled by the local adapter, not the remote one',
        description: 'local adapter',
        tags: ['extern-token-xyz'],
        confidence: 0.9,
      })
      const plain = await call(client, 'search_memory', { query: 'extern-token-xyz' })
      expect(plain.length).toBeGreaterThan(0)
      expect(plain.every((e: any) => e.entry_type !== 'source')).toBe(true)
      const sources = await call(client, 'search_memory', { query: 'extern-token-xyz', entry_type: 'source' })
      expect(sources.length).toBe(1)
      expect(sources[0].entry_type).toBe('source')
      await expect(
        call(client, 'search_memory', { query: 'extern-token-xyz', entry_type: 'source', project: 'brainproj' }),
      ).rejects.toThrow()

      // Exclusions apply before the 50-result cap: 30 + 30 same-token rows.
      for (let i = 0; i < 30; i++) {
        await call(client, 'store_fact', {
          project: 'exclproj',
          content: `kkw filler row number ${i} from the excluded project side`,
          description: `excluded ${i}`,
          tags: ['kkw'],
          confidence: 0.5,
        })
        await call(client, 'store_fact', {
          project: 'inclproj',
          content: `kkw filler row number ${i} from the included project side`,
          description: `included ${i}`,
          tags: ['kkw'],
          confidence: 0.5,
        })
      }
      const capped = await call(client, 'search_memory', { query: 'kkw' })
      expect(capped.length).toBe(50)
      const excluded = await call(client, 'search_memory', { query: 'kkw', exclude_projects: ['exclproj'] })
      expect(excluded.length).toBe(30)
      expect(excluded.every((e: any) => e.project === 'inclproj')).toBe(true)

      // Zero case: nothing earns it.
      expect(await call(client, 'search_memory', { query: 'no-such-token-zzz' })).toEqual([])

      // Export covers the whole project including the DB profile.
      const dump = await call(client, 'export_memories', { project: 'brainproj' })
      expect(JSON.stringify(dump)).toContain('python 3.12')
    })
  }, 120000)
})
