import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildExtractionPrompt,
  chunkTranscript,
  repairJson,
  validateEntries,
  type ValidEntry,
} from './pure.js'

// Post-session digest runner: in-process LLM extraction via the harness's own
// `ctx.llm` service (no external CLI, no credentials of its own), followed by
// OKF writes through the vault's MCP server over stdio (`store_*` tools keep
// the Markdown source of truth and the SQLite FTS5 index in sync).

const MIN_DIGEST_TRANSCRIPT_CHARS = 200
const LLM_RETRIES = 3
const LLM_RETRY_DELAYS_MS = [2_000, 5_000]
const MCP_CALL_TIMEOUT_MS = 60_000

function log(msg: string) {
  console.log(`[memory-auto] ${msg}`)
}

export function transcriptOfDSM(events: any[]): string {
  // DSH SessionEvent -> transcript
  return (events ?? [])
    .map((ev: any) => {
      const t = ev?.type ?? ''
      const d = ev?.data ?? ev
      if (t === 'user/message' || t === 'user_message') {
        const text = typeof d.text === 'string' ? d.text : typeof d.content === 'string' ? d.content : JSON.stringify(d).slice(0, 500)
        return `## user\n${text}`
      }
      if (t === 'assistant/message' || t === 'assistant_message') {
        const text = typeof d.text === 'string' ? d.text : typeof d.content === 'string' ? d.content : ''
        return text ? `## assistant\n${text}` : null
      }
      if (t === 'tool/call' || t === 'tool_call') {
        const name = d.tool ?? d.name ?? 'tool'
        const args = d.args ?? d.arguments ?? {}
        return `## tool_call ${name}\n${JSON.stringify(args).slice(0, 1000)}`
      }
      if (t === 'tool/result' || t === 'tool_result') {
        const out = typeof d.output === 'string' ? d.output : JSON.stringify(d).slice(0, 1000)
        return `## tool_result\n${out}`
      }
      if (t.startsWith('compaction')) return `## ${t}\n${JSON.stringify(d).slice(0, 500)}`
      return null
    })
    .filter((x): x is string => Boolean(x))
    .join('\n\n')
}

/** Translate a terminal stream finish into a thrown error, mirroring dsh's own summarizers. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    default:
      return undefined
  }
}

export interface DigestConfig {
  memoryPath: string
  serverDir: string
  provider: string
  model: string
  maxTokens: number
  minTranscriptChars: number
}

/**
 * Run one extraction call through the harness's `ctx.llm` service: build the
 * prompt, stream, assemble, repair and validate the JSON entries.
 */
export async function extractEntriesWithLlm(
  ctx: Context,
  config: DigestConfig,
  project: string,
  transcript: string,
  contextFiles?: { criticalFacts?: string; claude?: string },
  signal?: AbortSignal,
): Promise<ValidEntry[]> {
  const { system, user } = buildExtractionPrompt(project, transcript, contextFiles)
  const assembler = new BlockAssembler()
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'memory-auto' },
    }),
  ]
  const options: GenerateOptions = {
    provider: config.provider,
    model: config.model,
    messages,
    system,
    maxTokens: config.maxTokens,
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const parsed = repairJson(text)
  return validateEntries(parsed)
}

/** Minimal MCP stdio client for the vault server (spawned via `uv run`). */
export interface McpClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  close(): Promise<void>
}

export function connectMcp(memoryPath: string, serverDir: string): Promise<McpClient> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      'uv',
      ['run', '--directory', serverDir, 'python', 'server.py'],
      {
        env: { ...process.env, MEMORY_PATH: memoryPath, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? '/tmp/uv-cache' },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    )
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    let nextId = 1
    let closed = false

    const failAll = (err: Error) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      pending.clear()
    }

    child.on('error', (err) => {
      closed = true
      failAll(new Error(`memory-vault-server spawn failed: ${err.message}`))
      reject(err)
    })
    child.on('exit', (code) => {
      if (closed) return
      closed = true
      failAll(new Error(`memory-vault-server exited unexpectedly (code ${code})`))
      reject(new Error(`memory-vault-server exited before initialize (code ${code})`))
    })

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
    rl.on('line', (line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (typeof msg?.id === 'number') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
      }
    })

    const send = (method: string, params: unknown, timeoutMs: number = MCP_CALL_TIMEOUT_MS): Promise<unknown> =>
      new Promise((res, rej) => {
        if (closed || !child.stdin?.writable) {
          rej(new Error('memory-vault-server is not running'))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          rej(new Error(`MCP call ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { resolve: res, reject: rej, timer })
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })

    const notify = (method: string, params: unknown) => {
      if (!closed && child.stdin?.writable) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
      }
    }

    // initialize handshake (notifications are fire-and-forget: no id, no reply)
    void send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'memory-auto', version: '0.1.0' },
    })
      .then(() => {
        notify('notifications/initialized', {})
      })
      .then(() => {
        if (closed) throw new Error('memory-vault-server closed during handshake')
        resolve({
          callTool: (name, args, timeoutMs = MCP_CALL_TIMEOUT_MS) =>
            send('tools/call', { name, arguments: args }, timeoutMs).then((result: any) => {
              if (result?.isError) {
                const text = Array.isArray(result.content) ? result.content.map((c: any) => c?.text ?? '').join('') : JSON.stringify(result)
                throw new Error(`tool ${name} failed: ${text}`)
              }
              return result
            }),
          close: async () => {
            if (closed) return
            closed = true
            for (const [, p] of pending) clearTimeout(p.timer)
            pending.clear()
            if (child.exitCode !== null) return
            child.kill()
            await new Promise((r) => child.once('exit', r))
          },
        })
      })
      .catch((err) => {
        closed = true
        child.kill()
        reject(err)
      })
  })
}

/**
 * Write validated OKF entries through the vault server's `store_*` tools,
 * which upsert both the Markdown file and the SQLite FTS5 index.
 */
export async function writeEntries(client: McpClient, project: string, entries: ValidEntry[]): Promise<{ upserted: number; failed: number }> {
  let upserted = 0
  let failed = 0
  for (const e of entries) {
    try {
      await client.callTool(`store_${e.entry_type}`, {
        project,
        content: e.content,
        ...(e.description ? { description: e.description } : {}),
        tags: e.tags,
        confidence: e.confidence,
        ...(e.openspec_change_id ? { openspec_change_id: e.openspec_change_id } : {}),
      })
      upserted += 1
    } catch (err) {
      failed += 1
      console.warn(`[memory-auto] store_${e.entry_type} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return { upserted, failed }
}

/**
 * Full post-session digest: transcript -> ctx.llm extraction (with retries) ->
 * OKF writes via the vault MCP server. Never throws; logs the outcome.
 */
export async function digestSessionDSM(
  ctx: Context,
  config: DigestConfig,
  sessionId: string,
  directory: string,
  project: string,
  events: any[],
  signal?: AbortSignal,
): Promise<void> {
  const header = `## context\nproject: ${project}\ndirectory: ${directory}\n`
  const transcript = (header + transcriptOfDSM(events)).trim()
  if (!transcript) {
    log(`digest skip ${sessionId}: empty`)
    return
  }
  if (transcript.length < (config.minTranscriptChars ?? MIN_DIGEST_TRANSCRIPT_CHARS)) {
    log(`digest skip ${sessionId}: too short ${transcript.length}`)
    return
  }

  const chunks = chunkTranscript(transcript)
  const entries: ValidEntry[] = []
  for (const chunk of chunks) {
    let attempt = 0
    for (;;) {
      try {
        const got = await extractEntriesWithLlm(ctx, config, project, chunk, undefined, signal)
        entries.push(...got)
        break
      } catch (err) {
        attempt += 1
        if (attempt >= LLM_RETRIES || signal?.aborted) {
          console.warn(`[memory-auto] digest extraction failed after ${attempt} attempt(s):`, err instanceof Error ? err.message : err)
          break
        }
        const delay = LLM_RETRY_DELAYS_MS[attempt - 1] ?? 5_000
        log(`digest extraction retry ${attempt}/${LLM_RETRIES} in ${delay}ms`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    if (signal?.aborted) break
  }

  if (entries.length === 0) {
    log(`digest ${sessionId}: no entries extracted`)
    return
  }

  let client: McpClient
  try {
    client = await connectMcp(config.memoryPath, config.serverDir)
  } catch (err) {
    console.warn(`[memory-auto] digest ${sessionId}: cannot reach vault server:`, err instanceof Error ? err.message : err)
    return
  }
  try {
    const { upserted, failed } = await writeEntries(client, project, entries)
    log(`digest ${sessionId}: ${upserted} upserted, ${failed} failed (${entries.length} extracted)`)
  } finally {
    await client.close().catch(() => {})
  }
}
