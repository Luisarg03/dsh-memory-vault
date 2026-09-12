// memory-vault-server launcher — run `server.py` with uv when uv is on PATH,
// otherwise bootstrap a pip venv (.venv + requirements.txt) and run with that
// python. Used by both DSH launch points (memory-mcp cordis patch, memory-auto
// digest) so the fallback decision lives in exactly one place.
//
// stdout is the MCP channel of the spawned server — never print to it here.
// All progress/errors go to stderr.
//
// ponytail: fallback triggers only when the `uv` binary is absent, not when
// `uv run` fails (e.g. offline with an empty cache). If that ever matters,
// upgrade path: on uv run exit != 0, retry through the pip branch below.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))

/** Pure decision: which command runs the server, given uv presence. */
export function resolveRunner(hasUv, dir = DIR, platform = process.platform) {
  if (hasUv) return { command: 'uv', args: ['run', '--directory', dir, 'python', 'server.py'] }
  const pyBin = join(dir, platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
  return { command: pyBin, args: ['server.py'] }
}

export function hasUv() {
  return spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
}

/** Ensure a runnable venv with the server's deps installed (pip branch only). */
export function ensurePipEnv(dir = DIR, platform = process.platform) {
  const pyBin = join(dir, platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
  const venvCmd = platform === 'win32' ? 'py' : 'python3'
  if (!existsSync(pyBin)) {
    console.error('[memory-vault-server] uv not found — creating fallback venv with ' + venvCmd)
    // stdout is the MCP channel: keep install output off it.
    const created = spawnSync(venvCmd, ['-m', 'venv', join(dir, '.venv')], { stdio: ['ignore', 'ignore', 'inherit'] })
    if (created.status !== 0) {
      console.error(`[memory-vault-server] venv creation failed (exit ${created.status}) — install uv or fix ${venvCmd}`)
      process.exit(created.status ?? 1)
    }
  }
  const depsOk = spawnSync(pyBin, ['-c', 'import mcp, yaml'], { stdio: 'ignore' }).status === 0
  if (!depsOk) {
    console.error('[memory-vault-server] fallback venv missing deps — pip install -r requirements.txt')
    const pip = spawnSync(pyBin, ['-m', 'pip', 'install', '--quiet', '-r', join(dir, 'requirements.txt')], { stdio: ['ignore', 'ignore', 'inherit'] })
    if (pip.status !== 0) {
      console.error(`[memory-vault-server] pip install failed (exit ${pip.status}) — install uv, fix the network, or run the pip install manually`)
      process.exit(pip.status ?? 1)
    }
  }
  return pyBin
}

function main() {
  const withUv = hasUv()
  const { command, args } = resolveRunner(withUv)
  if (!withUv) ensurePipEnv()
  // Default the uv cache under the OS temp dir (Windows has no /tmp); an
  // explicit UV_CACHE_DIR from the patch layer or env still wins.
  const env = { UV_CACHE_DIR: join(tmpdir(), 'uv-cache'), ...process.env }
  const child = spawn(command, args, { cwd: DIR, env, stdio: 'inherit' })
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
  child.on('error', (err) => {
    console.error(`[memory-vault-server] spawn failed (${command}): ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
