/**
 * Harness wiring for `memory-auto`. Registers exactly these hooks:
 *
 *   - `session/created`        resolve the project name for the session
 *   - `session/disposed`       digest the transcript
 *   - `agent/status` (idle)    auto-capture gate
 *   - `session/event`          activity tracking; `tool/call` with a
 *                              `git commit` command and `compaction/start`
 *                              queue checkpoints
 *   - `agent/pre-step`         deliver the queued checkpoint to the agent
 *   - `ctx.effect` dispose     batch-digest sessions still pending
 *
 * The agent writes the entries; this plugin only prompts it.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  createSessionState,
  resolveProjectKey,
  idleCheckpoint,
  compactingCheckpoint,
  isGitCommit,
  buildCommitCheckpointPrompt,
  defaultVaultPath,
  type SessionState,
} from './pure.js'
import { digestSessionDSM, type DigestConfig } from './digest.js'
import { skillsProvider } from './skills.js'

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

/** Copy the bundled dir into `target` when `key` is missing there (user data). */
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
  // Registered before the `enabled` gate on purpose: this skill documents the
  // automatic capture *and* its knobs, which is how a session finds out that
  // capture is off and how to turn it back on. Injected rather than declared in
  // `inject` so a deployment without a skill catalog still gets capture.
  ctx.inject(['skills'], (ctx) => {
    ctx.skills.registerProvider(() => skillsProvider)
  })

  if (!config.enabled) {
    console.log('[memory-auto] disabled via config')
    return
  }

  const memoryPath = defaultVaultPath(config.memoryPath)
  const serverDir = resolveUnderHome(config.serverDir, 'memory-vault-server')

  // Self-contained install. The vault is user data, so it is copied only when
  // missing; the server directory is our code, so it is refreshed on every boot.
  // 0.1.5 copied the server only when `server.py` was absent, which froze the
  // Python code of every existing install (and shipped fixes to nobody).
  // cpSync merges: a pip `.venv` or `__pycache__` left in the target survives.
  const bundledServer = join(packageRoot, 'server')
  // `resolve` because a checkout can legitimately point serverDir at the bundle
  // itself (tests and local dev); copying a directory onto itself throws EINVAL.
  if (existsSync(join(bundledServer, 'server.py')) && resolve(bundledServer) !== resolve(serverDir)) {
    const firstBoot = !existsSync(join(serverDir, 'server.py'))
    mkdirSync(serverDir, { recursive: true })
    cpSync(bundledServer, serverDir, { recursive: true, force: true })
    if (firstBoot) console.log(`[memory-auto] installed memory-vault-server -> ${serverDir}`)
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
  const projectCache = new Map<string, string>() // verified keys only — never negatives

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

  /**
   * Shared choke point for every capture path. Returns null when the key is
   * unverified: callers must STOP (no digest, no queued checkpoint) and keep
   * the reason in their skip log. Negatives are never cached, so declaring
   * the key (`Memory project:`) or creating the vault folder revalidates on
   * the next call.
   */
  const projectFor = async (dir: string): Promise<string | null> => {
    const cached = projectCache.get(dir)
    if (cached) return cached
    // Declared (`Memory project:` in the closest AGENTS.md) beats heuristics.
    const resolved = await resolveProjectKey(dir || process.cwd(), { vaultPath: memoryPath })
    if (!resolved.verified) {
      console.warn(`[memory-auto] capture blocked: ${resolved.message}`)
      return null
    }
    projectCache.set(dir, resolved.key)
    return resolved.key
  }

  const blockedReason = (sid: string, via: string) =>
    `[memory-auto] ${via} skip ${sid}: no verified project (see the capture-blocked warning above for how to declare it)`

  /** Shared capture gate: verified key for `sid` (synced onto `st.project`), or null after logging the skip. */
  const gatedProject = async (sid: string, via: string): Promise<string | null> => {
    const proj = await projectFor(sessionDirs.get(sid) ?? '')
    if (!proj) {
      console.warn(blockedReason(sid, via))
      return null
    }
    const st = states.get(sid)
    if (st) st.project = proj
    return proj
  }

  // session/created -> init state
  ctx.on('session/created' as any, async (session: DSHSession) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId
    const dir = (session as any)?.cwd ?? (session as any)?.directory ?? ''
    if (!sid) return
    const proj = await projectFor(dir)
    if (!states.has(sid)) {
      // Track activity even while unresolved: write paths re-resolve (never a
      // cached negative) and sync st.project, so fixing the key mid-session
      // still captures everything tracked so far.
      states.set(sid, createSessionState(proj ?? ''))
      activities.set(sid, [])
    }
    sessionDirs.set(sid, dir)
    console.log(`[memory-auto] session created ${sid} project=${proj ?? '(unresolved)'}`)
  })

  // session/disposed -> digest
  ctx.on('session/disposed' as any, async (session: DSHSession) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId
    if (!sid) return
    const st = states.get(sid)
    if (!st) return
    if (!st.hasActivity) {
      console.log(`[memory-auto] digest skip ${sid}: no activity`)
      return
    }
    const dir = sessionDirs.get(sid) ?? ''
    const proj = await gatedProject(sid, 'digest')
    if (!proj) return
    const evts: DSHEvt[] = (session as any)?.events ?? []
    await digestSessionDSM(ctx, digestConfig, sid, dir, proj, evts)
  })

  // agent/status idle -> in-session capture gate
  ctx.on('agent/status' as any, async (payload: any) => {
    const agent = payload?.agent
    const status = payload?.status ?? payload?.agentStatus
    if (status !== 'idle') return
    const sid: string | undefined = agent?.sessionId ?? payload?.sessionId ?? agent?.id
    if (!sid) return
    const st = states.get(sid)
    if (!st) return
    const text = idleCheckpoint(st, summary(sid))
    if (text) {
      const dir = sessionDirs.get(sid) ?? ''
      const proj = await gatedProject(sid, 'idle checkpoint')
      if (!proj) {
        // Let a later idle retry once the key is fixed.
        st.checkpointDelivered = false
        return
      }
      console.log(`[memory-auto] idle checkpoint digest for ${sid}`)
      const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
      await digestSessionDSM(ctx, digestConfig, sid, dir, proj, fakeEvents)
    }
  })

  // session/event -> git commit detect + compaction start
  ctx.on('session/event' as any, async (session: DSHSession, event: DSHEvt) => {
    const sid = (session as any)?.id ?? (session as any)?.sessionId ?? (event as any)?.sessionId
    if (!sid) return
    const t = event?.type ?? ''
    const d = event?.data ?? {}

    // compaction/start -> checkpoint injection (delivered on the next pre-step)
    if (t === 'compaction/start') {
      const st = states.get(sid)
      if (!st) return
      const proj = await gatedProject(sid, 'compaction checkpoint')
      if (!proj) return
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
          const proj = await gatedProject(sid, 'commit checkpoint')
          if (!proj) return
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
  ctx.on('agent/pre-step' as any, async (payload: any, next: any) => {
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
      // fire-and-forget digest for each remaining session (handled: no unhandled rejections)
      for (const [sid, dir] of sessionDirs) {
        const st = states.get(sid)
        if (!st?.hasActivity) continue
        void (async () => {
          try {
            const proj = await gatedProject(sid, 'dispose digest')
            if (!proj) return
            const fakeEvents = [{ type: 'user/message', data: { text: summary(sid) } }]
            await digestSessionDSM(ctx, digestConfig, sid, dir, proj, fakeEvents)
          } catch (err) {
            console.warn(`[memory-auto] dispose digest failed for ${sid}:`, err instanceof Error ? err.message : err)
          }
        })()
      }
    }
  })

  console.log(`[memory-auto] active memoryPath=${memoryPath} serverDir=${serverDir} llm=${config.provider}/${config.model}`)
}
