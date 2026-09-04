import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  createSessionState,
  resolveProjectName,
  idleCheckpoint,
  compactingCheckpoint,
  isGitCommit,
  buildCheckpointPrompt,
  buildCommitCheckpointPrompt,
  type SessionState,
} from './pure.js'
import { digestSessionDSM, type DigestConfig } from './digest.js'

export const name = 'memory-auto'

export interface Config {
  memoryPath: string
  serverDir: string
  provider: string
  model: string
  maxTokens: number
  minTranscriptChars: number
  enabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  memoryPath: Schema.string().default(process.env.DSH_MEMORY_PATH ?? ''),
  serverDir: Schema.string().default(process.env.DSH_MEMORY_SERVER_DIR ?? ''),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  maxTokens: Schema.number().default(2048),
  minTranscriptChars: Schema.number().default(200),
  enabled: Schema.boolean().default(true),
})

/** Requires the harness LLM service: extraction runs in-process via ctx.llm. */
export const inject = ['llm']

/**
 * Resolve the harness home the same way the harness does (`$DSH_HOME`, or
 * `~/.dsh`). Paths must never depend on the launch cwd: DSH does not chdir.
 */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env && env.length > 0 ? env : join(homedir(), '.dsh')
}

/** Absolute paths stay; empty/relative values resolve under the harness home. */
function resolveUnderHome(value: string, fallbackSegment: string): string {
  const v = value.trim()
  if (v.length === 0) return join(dshHome(), fallbackSegment)
  return isAbsolute(v) ? v : join(dshHome(), v)
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Copy the bundled dir into `target` when `key` is missing there. */
function ensure(target: string, bundled: string, key: string): boolean {
  if (existsSync(join(target, key))) return false
  if (!existsSync(bundled)) return false
  mkdirSync(target, { recursive: true })
  cpSync(bundled, target, { recursive: true })
  return true
}

// DSH session shape minimal
type DSHEvt = any
type DSHSession = { id: string; events: DSHEvt[]; cwd?: string }

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) {
    console.log('[memory-auto] disabled via config')
    return
  }

  const memoryPath = resolveUnderHome(config.memoryPath, 'memory-vault')
  const serverDir = resolveUnderHome(config.serverDir, 'memory-vault-server')

  // Self-contained install: first boot copies the bundled server and vault
  // starter under the harness home when they are missing.
  if (ensure(serverDir, join(packageRoot, 'server'), 'server.py')) {
    console.log(`[memory-auto] installed memory-vault-server -> ${serverDir}`)
  }
  if (ensure(memoryPath, join(packageRoot, 'vault'), 'type-registry.yaml')) {
    console.log(`[memory-auto] installed vault starter -> ${memoryPath}`)
  }

  const digestConfig: DigestConfig = {
    memoryPath,
    serverDir,
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    minTranscriptChars: config.minTranscriptChars,
  }

  if (!existsSync(join(serverDir, 'server.py'))) {
    console.warn(
      `[memory-auto] vault server not found at ${serverDir} and not bundled — the digest cannot write. ` +
      'Set DSH_MEMORY_SERVER_DIR (or run `node scripts/bundle-assets.mjs` in a checkout).',
    )
  }
  if (!existsSync(join(memoryPath, 'type-registry.yaml'))) {
    console.warn(`[memory-auto] vault starter not found at ${memoryPath} — searches will fail until it exists.`)
  }

  const states = new Map<string, SessionState>()
  const activities = new Map<string, string[]>()
  const queued = new Map<string, string>()
  const sessionDirs = new Map<string, string>()
  const projectCache = new Map<string, string>()

  const ACTIVITY_MAX_LINES = 20
  const ACTIVITY_MAX_CHARS = 80

  const track = (sessionId: string, line: string) => {
    const st = states.get(sessionId)
    if (!st) return
    st.hasActivity = true
    const list = activities.get(sessionId) ?? []
    if (!list.includes(line)) {
      list.push(line)
      if (list.length > ACTIVITY_MAX_LINES) list.shift()
      activities.set(sessionId, list)
    }
  }

  const summary = (sid: string) => (activities.get(sid) ?? []).join('\n')

  const projectFor = async (dir: string): Promise<string> => {
    const cached = projectCache.get(dir)
    if (cached) return cached
    const p = await resolveProjectName(dir || process.cwd())
    projectCache.set(dir, p)
    return p
  }

  // session/created -> init state
  ctx.on('session/created', async (session: DSHSession) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId
    const dir = (session as any)?.cwd ?? (session as any)?.directory ?? ''
    if (!sid) return
    const proj = await projectFor(dir)
    if (!states.has(sid)) {
      states.set(sid, createSessionState(proj))
      activities.set(sid, [])
    }
    sessionDirs.set(sid, dir)
    console.log(`[memory-auto] session created ${sid} project=${proj}`)
  })

  // session/disposed -> digest
  ctx.on('session/disposed', async (session: DSHSession) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId
    if (!sid) return
    const st = states.get(sid)
    if (!st) return
    if (!st.hasActivity) {
      console.log(`[memory-auto] digest skip ${sid}: no activity`)
      return
    }
    const dir = sessionDirs.get(sid) ?? ''
    const proj = await projectFor(dir)
    const evts: DSHEvt[] = (session as any)?.events ?? []
    await digestSessionDSM(ctx, digestConfig, sid, dir, proj, evts)
  })

  // agent/status idle -> in-session capture gate
  ctx.on('agent/status', async (payload: any) => {
    const agent = payload?.agent
    const status = payload?.status ?? payload?.agentStatus
    if (status !== 'idle') return
    const sid: string | undefined = agent?.sessionId ?? payload?.sessionId ?? agent?.id
    if (!sid) return
    const st = states.get(sid)
    if (!st) return
    const text = idleCheckpoint(st, summary(sid))
    if (text) {
      console.log(`[memory-auto] idle checkpoint digest for ${sid}`)
      const dir = sessionDirs.get(sid) ?? ''
      const proj = await projectFor(dir)
      const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
      await digestSessionDSM(ctx, digestConfig, sid, dir, proj, fakeEvents)
    }
  })

  // session/event -> git commit detect + compaction start
  ctx.on('session/event', async (session: DSHSession, event: DSHEvt) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId ?? (event as any)?.sessionId
    if (!sid) return
    const t = event?.type ?? ''
    const d = event?.data ?? {}

    // compaction/start -> checkpoint injection (delivered on the next pre-step)
    if (t === 'compaction/start') {
      const st = states.get(sid)
      if (!st) return
      const txt = compactingCheckpoint(st, summary(sid))
      if (txt) {
        console.log(`[memory-auto] compaction checkpoint queued for ${sid}`)
        queued.set(sid, txt)
      }
      return
    }

    // tool/call -> git commit detection + activity track
    if (t === 'tool/call' || t === 'tool_call') {
      const cmd = d?.args?.command ?? d?.command ?? ''
      if (typeof cmd === 'string' && isGitCommit(cmd)) {
        const st = states.get(sid)
        if (st) {
          st.hasActivity = true
          queued.set(sid, buildCommitCheckpointPrompt(st))
          console.log(`[memory-auto] git commit queued for ${sid}`)
        }
        return
      }
      if (typeof cmd === 'string') {
        track(sid, `bash: ${cmd.trim().slice(0, ACTIVITY_MAX_CHARS)}`)
      }
      return
    }
    if (t === 'tool/result') {
      // ignore
      return
    }
    if (t === 'user/message' || t === 'assistant/message') {
      // track activity
      track(sid, `${t}: ${(d?.text ?? '').slice(0, ACTIVITY_MAX_CHARS)}`)
    }
  })

  // agent/pre-step Waterfall -> deliver queued checkpoint
  ctx.on('agent/pre-step', async (payload: any, next: any) => {
    const sid: string | undefined = payload?.agent?.sessionId ?? payload?.sessionId
    if (sid) {
      const q = queued.get(sid)
      if (q) {
        queued.delete(sid)
        // Best effort: append the checkpoint as user context
        if (Array.isArray(payload?.context)) payload.context.push(q)
        else if (Array.isArray(payload?.messages)) payload.messages.push({ role: 'user', content: q })
        else console.log(`[memory-auto] deliver queued checkpoint for ${sid}`)
      }
    }
    return next()
  })

  // dispose -> batch digest remaining sessions
  ctx.effect(() => {
    return () => {
      console.log(`[memory-auto] dispose batch ${sessionDirs.size} sessions`)
      // fire-and-forget digest for each remaining session
      for (const [sid, dir] of sessionDirs) {
        const st = states.get(sid)
        if (!st?.hasActivity) continue
        projectFor(dir).then((proj) => {
          const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
          void digestSessionDSM(ctx, digestConfig, sid, dir, proj, fakeEvents)
        })
      }
    }
  })

  console.log(`[memory-auto] active memoryPath=${memoryPath} serverDir=${serverDir} llm=${config.provider}/${config.model}`)
}
