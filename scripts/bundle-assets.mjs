// Syncs the vault server and vault starter into both plugin packages so the
// published tarballs are self-contained (install without cloning the repo).
// Run from the repo root at the end of `pnpm build`.
//
// Both packages' `prepare` scripts used to call this, and pnpm runs them
// concurrently — two processes doing rmSync+cpSync on the same two target
// directories, so one deleted what the other was copying:
//
//   ENOENT: no such file or directory, chmod '.../packages/memory-mcp/server'
//
// The lock below makes concurrent invocations safe for callers that still do
// that, and the target dirs are written once per run instead of once per package.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor to the repo root (this script lives in <root>/scripts), not the cwd:
// `prepare`/`build` may run with a package directory as cwd.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const EXCLUDE = /(^|\/)(\.venv|__pycache__|node_modules)(\/|$)/

const SERVER_FILES = ['server.py', 'store.py', 'registry.py', 'cli.py', 'pyproject.toml', 'uv.lock', 'launcher.mjs', 'requirements.txt']
const STARTER_FILES = ['type-registry.yaml', 'tag-vocabulary.json', 'README.md']
const STARTER_DIRS = ['templates']

const LOCK = join(ROOT, '.tmp', 'bundle-assets.lock')
const LOCK_STALE_MS = 60_000

/** Serializes concurrent invocations; a stale lock from a killed run is taken over. */
function acquireLock() {
  mkdirSync(dirname(LOCK), { recursive: true })
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      // mkdir is atomic: exactly one process creates it, and the name is the
      // timestamp, so the stale check cannot mistake a pid for an age.
      mkdirSync(LOCK)
      return true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        const age = Date.now() - Number(readFileSync(join(LOCK, 'at'), 'utf8') || 0)
        if (age > LOCK_STALE_MS) rmSync(LOCK, { recursive: true, force: true })
      } catch {
        // Released between the check and the read; the next attempt will win.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  return false
}

/** Writes the verification marker the stale check reads. */
function stampLock() {
  try {
    writeFileSync(join(LOCK, 'at'), String(Date.now()))
  } catch {
    // Best effort: the lock itself is what serializes.
  }
}

if (!acquireLock()) {
  console.error('bundle-assets: gave up waiting for the lock after 30s')
  process.exit(1)
}
stampLock()

try {
  for (const pkg of ['memory-mcp', 'memory-auto']) {
    const dir = join(ROOT, 'packages', pkg)

    // vault server (sources only)
    const serverTarget = join(dir, 'server')
    rmSync(serverTarget, { recursive: true, force: true })
    cpSync(join(ROOT, 'memory-vault-server'), serverTarget, { recursive: true, filter: (s) => !EXCLUDE.test(s) })
    for (const f of SERVER_FILES) {
      if (!existsSync(join(serverTarget, f))) {
        console.error(`bundle-assets: memory-vault-server/${f} missing — aborting`)
        process.exit(1)
      }
    }

    // vault starter (no data dirs)
    const vaultTarget = join(dir, 'vault')
    rmSync(vaultTarget, { recursive: true, force: true })
    for (const f of STARTER_FILES) cpSync(join(ROOT, 'memory-vault', f), join(vaultTarget, f))
    for (const d of STARTER_DIRS) cpSync(join(ROOT, 'memory-vault', d), join(vaultTarget, d), { recursive: true })
  }
} finally {
  rmSync(LOCK, { recursive: true, force: true })
}
