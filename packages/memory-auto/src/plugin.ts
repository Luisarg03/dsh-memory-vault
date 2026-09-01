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
import { digestSessionDSM } from './digest.js'

export const name = 'memory-auto'

export interface Config {
  memoryPath: string
  digestScript: string
  minTranscriptChars: number
  enabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  memoryPath: Schema.string().default(process.env.DSH_MEMORY_PATH ?? './memory-vault'),
  digestScript: Schema.string().default(process.env.DSH_DIGEST_SCRIPT ?? './scripts/digest_session.py'),
  minTranscriptChars: Schema.number().default(200),
  enabled: Schema.boolean().default(true),
})

// DSH session shape minimal
type DSHEvt = any
type DSHSession = { id: string; events: DSHEvt[]; cwd?: string }

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) {
    console.log('[memory-auto] disabled via config')
    return
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
    await digestSessionDSM(sid, dir, proj, evts, config.digestScript, config.memoryPath)
  })

  // agent/status idle -> similar to session.idle
  ctx.on('agent/status', async (payload: any) => {
    const agent = payload?.agent
    const status = payload?.status ?? payload?.agentStatus
    if (status !== 'idle') return
    // agent.status payload may contain sessionId? Try to find sid via agent.id
    const sid: string | undefined = agent?.sessionId ?? payload?.sessionId ?? agent?.id
    if (!sid) return
    const st = states.get(sid)
    if (!st) return
    const text = idleCheckpoint(st, summary(sid))
    if (text) {
      console.log(`[memory-auto] idle checkpoint spawn for ${sid}`)
      const dir = sessionDirs.get(sid) ?? ''
      const proj = await projectFor(dir)
      // need events: try to get session from some store? fallback to empty
      // For now use activities as transcript proxy
      const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
      await digestSessionDSM(sid, dir, proj, fakeEvents, config.digestScript, config.memoryPath)
    }
  })

  // session/event -> git commit detect + compaction start
  ctx.on('session/event', async (session: DSHSession, event: DSHEvt) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId ?? (event as any)?.sessionId
    if (!sid) return
    const t = event?.type ?? ''
    const d = event?.data ?? {}

    // compaction/start -> checkpoint injection (log for now, actual injection via agent/pre-step)
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

  // agent/pre-step Waterfall -> deliver queued checkpoint (opencode messages.transform equivalent)
  // In DSH, agent/pre-step is Waterfall, must call next()
  ctx.on('agent/pre-step', async (payload: any, next: any) => {
    const sid: string | undefined = payload?.agent?.sessionId ?? payload?.sessionId
    if (sid) {
      const q = queued.get(sid)
      if (q) {
        queued.delete(sid)
        // payload has messages? Append checkpoint as user context
        // Best effort: if payload.context is array, push
        if (Array.isArray(payload?.context)) payload.context.push(q)
        else if (Array.isArray(payload?.messages)) payload.messages.push({ role: 'user', content: q })
        else console.log(`[memory-auto] deliver queued checkpoint for ${sid}`)
      }
    }
    return next()
  })

  // dispose -> batch digest remaining sessions (like opencode dispose)
  ctx.effect(() => {
    return () => {
      console.log(`[memory-auto] dispose batch ${sessionDirs.size} sessions`)
      // fire-and-forget digest for each remaining
      for (const [sid, dir] of sessionDirs) {
        const st = states.get(sid)
        if (!st?.hasActivity) continue
        projectFor(dir).then((proj) => {
          const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
          digestSessionDSM(sid, dir, proj, fakeEvents, config.digestScript, config.memoryPath)
        })
      }
    }
  })

  console.log('[memory-auto] active memoryPath=' + config.memoryPath)
}
