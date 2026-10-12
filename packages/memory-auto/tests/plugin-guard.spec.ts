import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Stub vault server: speaks just enough MCP (initialize + tools/call) over
 * stdio and appends every `store_*` call to $MEMLOG. Lets the guard test
 * exercise the REAL plugin handlers + REAL digestSessionDSM without the live
 * server lane (whose list_tags is still landing).
 */
const STUB_LAUNCHER = `import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const logFile = process.env.MEMLOG ?? ''
const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n')
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    if (name === 'list_tags') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"tags":[],"truncated":false}' }] } })
      return
    }
    if (typeof name === 'string' && name.startsWith('store_')) {
      if (logFile) appendFileSync(logFile, JSON.stringify({ tool: name, project: args?.project ?? null }) + '\\n')
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"tags":[],"new_tags":[]}' }] } })
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool ' + name } })
  }
})
`

const FACT_JSON = JSON.stringify([
  {
    entry_type: 'fact',
    content: 'the deploy pipeline retries failed uploads automatically after a backoff',
    description: 'retry behavior',
    tags: ['deploy'],
    confidence: 0.8,
  },
])

/** Scripted ctx.llm: yields the fact above as one text block, then finishes. */
function scriptedLlm(): unknown {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: FACT_JSON },
    { type: 'block-end', index: 0, block: { type: 'text', text: FACT_JSON } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    async *stream(): AsyncGenerator<StreamChunk> {
      for (const c of chunks) yield c
    },
  }
}

interface Harness {
  ctx: any
  emit: (event: string, ...args: unknown[]) => Promise<unknown[]>
  cleanups: Array<() => void>
}

function fakeHarness(): Harness {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const cleanups: Array<() => void> = []
  const ctx: any = {
    on: (event: string, fn: (...args: any[]) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    inject: (_deps: unknown, cb: (c: unknown) => void) => {
      cb({ skills: { registerProvider: () => {} } })
    },
    effect: (fn: () => () => void) => {
      cleanups.push(fn())
      return () => {}
    },
    llm: scriptedLlm(),
  }
  return {
    ctx,
    cleanups,
    emit: async (event, ...args) => {
      const out: unknown[] = []
      for (const fn of handlers.get(event) ?? []) out.push(await fn(...args))
      return out
    },
  }
}

function memlogLines(path: string): Array<{ tool: string; project: string | null }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { tool: string; project: string | null })
}

async function waitFor(path: string, pred: (lines: ReturnType<typeof memlogLines>) => boolean, timeoutMs = 15000): Promise<ReturnType<typeof memlogLines>> {
  const start = Date.now()
  for (;;) {
    const lines = memlogLines(path)
    if (pred(lines)) return lines
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for memlog condition in ${path}: ${JSON.stringify(lines)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('plugin project guard (real handlers + real digest, stub MCP server)', () => {
  const dirs: string[] = []
  let vault = ''
  let unknownWork = ''
  let knownWork = ''
  let prevMemlog: string | undefined

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }

  beforeAll(() => {
    prevMemlog = process.env.MEMLOG
    vault = tmp('guard-vault-')
    const starter = join(REPO_ROOT, 'memory-vault')
    cpSync(join(starter, 'type-registry.yaml'), join(vault, 'type-registry.yaml'))
    cpSync(join(starter, 'tag-vocabulary.json'), join(vault, 'tag-vocabulary.json'))
    cpSync(join(starter, 'templates'), join(vault, 'templates'), { recursive: true })
    mkdirSync(join(vault, 'projects', 'known-proj'), { recursive: true })

    unknownWork = tmp('guard-unknown-')
    knownWork = tmp('guard-known-')
    writeFileSync(join(knownWork, 'AGENTS.md'), '# test\nMemory project: known-proj\n')
  })

  afterAll(() => {
    if (prevMemlog === undefined) delete process.env.MEMLOG
    else process.env.MEMLOG = prevMemlog
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  /**
   * Boot the plugin against the stub server; returns the harness + memlog path.
   * MEMLOG stays set (the stub reads it at spawn time, i.e. during digest).
   */
  function boot(memlog: string): Harness {
    const harness = fakeHarness()
    const serverDir = tmp('guard-server-')
    process.env.MEMLOG = memlog
    apply(harness.ctx as never, {
        memoryPath: vault,
        serverDir,
        provider: 'mock',
        model: 'mock',
        maxTokens: 256,
        minTranscriptChars: 10,
        enabled: true,
      })
    // apply() refreshes serverDir from the bundle AFTER our stub would land,
    // so the stub goes in after apply() returns.
    writeFileSync(join(serverDir, 'launcher.mjs'), STUB_LAUNCHER)
    return harness
  }

  const activity = (text: string) => ({ type: 'user/message', data: { text } })
  const LONG_TEXT = 'working on the deploy pipeline retry logic today, uploads fail on flaky networks and need backoff'

  it('stores nothing and queues no checkpoint for an unverified project', async () => {
    const memlog = join(tmp('guard-log-'), 'mem.log')
    const h = boot(memlog)
    const sid = 'sess-unknown'

    await h.emit('session/created', { id: sid, cwd: unknownWork, events: [] })
    await h.emit('session/event', { id: sid }, activity(LONG_TEXT))
    // commit checkpoint path must also stop (nothing delivered at pre-step)
    await h.emit('session/event', { id: sid }, { type: 'tool/call', data: { args: { command: 'git commit -m guard' } } })
    const delivered: unknown[] = []
    await h.emit('agent/pre-step', { agent: { sessionId: sid }, context: delivered }, async () => {})
    expect(delivered).toEqual([])
    // digest path must also stop (no store_* reaches the server)
    await h.emit('session/disposed', { id: sid, events: [activity(LONG_TEXT)] })
    expect(memlogLines(memlog)).toEqual([])
  })

  it('keeps capturing for a verified project (digest stores, commit checkpoint delivers)', async () => {
    const memlog = join(tmp('guard-log-'), 'mem.log')
    const h = boot(memlog)
    const sid = 'sess-known'

    await h.emit('session/created', { id: sid, cwd: knownWork, events: [] })
    await h.emit('session/event', { id: sid }, activity(LONG_TEXT))
    await h.emit('session/disposed', { id: sid, events: [activity(LONG_TEXT)] })

    const stores = memlogLines(memlog).filter((l) => l.tool === 'store_fact')
    expect(stores.length).toBeGreaterThan(0)
    expect(stores.every((l) => l.project === 'known-proj')).toBe(true)

    await h.emit('session/event', { id: sid }, { type: 'tool/call', data: { args: { command: 'git commit -m guard' } } })
    const delivered: unknown[] = []
    await h.emit('agent/pre-step', { agent: { sessionId: sid }, context: delivered }, async () => {})
    expect(delivered.length).toBe(1)
    expect(String(delivered[0])).toContain('[memory-checkpoint]')
    expect(String(delivered[0])).toContain('known-proj')
  })

  it('revalidates after the key is fixed (no cached negative) and the dispose batch respects the gate', async () => {
    const memlog = join(tmp('guard-log-'), 'mem.log')
    const h = boot(memlog)

    // Unknown first: tracked but blocked.
    await h.emit('session/created', { id: 'sess-late', cwd: unknownWork, events: [] })
    await h.emit('session/event', { id: 'sess-late' }, activity(LONG_TEXT))
    await h.emit('session/disposed', { id: 'sess-late', events: [activity(LONG_TEXT)] })
    expect(memlogLines(memlog)).toEqual([])

    // The user fixes the key by declaring a real project for that directory…
    writeFileSync(join(unknownWork, 'AGENTS.md'), '# fixed\nMemory project: known-proj\n')
    // …and a fresh session in the same directory now captures (no stale negative).
    await h.emit('session/created', { id: 'sess-fixed', cwd: unknownWork, events: [] })
    await h.emit('session/event', { id: 'sess-fixed' }, activity(LONG_TEXT))
    await h.emit('session/disposed', { id: 'sess-fixed', events: [activity(LONG_TEXT)] })
    const stores = await waitFor(memlog, (lines) => lines.some((l) => l.tool === 'store_fact'))
    expect(stores.every((l) => l.project === 'known-proj')).toBe(true)
  })

  it('dispose batch digests verified sessions and skips unverified ones', async () => {
    const memlog = join(tmp('guard-log-'), 'mem.log')
    // Fresh unknown dir: no AGENTS.md anywhere above it, basename not in the vault.
    const unknown2 = tmp('guard-unknown2-')
    const h = boot(memlog)

    await h.emit('session/created', { id: 'sess-batch-bad', cwd: unknown2, events: [] })
    await h.emit('session/event', { id: 'sess-batch-bad' }, activity(LONG_TEXT))
    await h.emit('session/created', { id: 'sess-batch-good', cwd: knownWork, events: [] })
    await h.emit('session/event', { id: 'sess-batch-good' }, activity(LONG_TEXT))

    for (const cleanup of h.cleanups) cleanup()
    const lines = await waitFor(memlog, (l) => l.some((e) => e.tool === 'store_fact'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.project === 'known-proj')).toBe(true)
  })
})
