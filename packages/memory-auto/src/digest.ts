import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Post-session digest runner: spawns scripts/digest_session.py via `uv run`.
// REPO_ROOT is derived from the digestScript location (parent of the scripts/ dir).

const DIGEST_LOG_FALLBACK = process.env.DSH_DIGEST_LOG ?? join(tmpdir(), 'dsh-digest-spawn.log')
const MIN_DIGEST_TRANSCRIPT_CHARS = 200

function log(msg: string) {
  console.log(`[memory-auto] ${msg}`)
}

export function transcriptOfDSM(events: any[]): string {
  // DSH SessionEvent -> transcript similar a opencode transcriptOf(messages)
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

export function spawnDigest(transcriptPath: string, project: string, digestScript: string, digestLog: string = DIGEST_LOG_FALLBACK, memoryPath?: string): ChildProcess | undefined {
  let fd: number
  try {
    mkdirSync(dirname(digestLog), { recursive: true })
    fd = openSync(digestLog, 'a')
  } catch (err) {
    console.warn(`[memory-auto] cannot open digest log ${digestLog}:`, err)
    return
  }
  try {
    // repo root = parent of the directory holding the digest script
    const repoDir = dirname(dirname(digestScript))
    const env: Record<string, string | undefined> = { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? '/tmp/uv-cache', XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '/tmp/opencode-data', HOME: process.env.HOME ?? '/tmp/fake-home' }
    if (memoryPath) env.MEMORY_PATH = memoryPath
    const child = spawn('uv', ['run', '--directory', repoDir, 'python', digestScript, '--transcript', transcriptPath, '--project', project], {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: env as any,
    })
    child.on('error', (err) => console.warn(`[memory-auto] digest spawn error:`, err.message))
    child.unref()
    log(`digest spawned project=${project} transcript=${transcriptPath}`)
    return child
  } catch (err) {
    console.warn(`[memory-auto] digest spawn failed:`, err)
  } finally {
    closeSync(fd)
  }
  return
}

export async function digestSessionDSM(sessionId: string, directory: string, project: string, events: any[], digestScript: string, memoryPath?: string): Promise<void> {
  const raw = transcriptOfDSM(events)
  // prepend context header for better LLM extraction
  const header = `## context\nproject: ${project}\ndirectory: ${directory}\n`
  const transcript = header + raw
  const trimmed = transcript.trim()
  if (!trimmed) {
    log(`digest skip ${sessionId}: empty`)
    return
  }
  if (trimmed.length < MIN_DIGEST_TRANSCRIPT_CHARS) {
    log(`digest skip ${sessionId}: too short ${trimmed.length}`)
    return
  }
  const tmpDir = process.env.DSH_DIGEST_TMP ?? join(tmpdir(), 'dsh-digest')
  try { mkdirSync(tmpDir, { recursive: true }) } catch {}
  const tmpPath = join(tmpDir, `dsh-digest-${sessionId}.txt`)
  await writeFile(tmpPath, transcript, 'utf-8')
  spawnDigest(tmpPath, project, digestScript, undefined, memoryPath)
}
