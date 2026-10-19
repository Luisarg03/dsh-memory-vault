// Syncs the vault server and vault starter into the plugin packages so the
// published tarballs are self-contained (install without cloning the repo).
// Run from the repo root at the end of `pnpm build`.
//
// The DSH packages (memory-mcp, memory-auto) get the server plus the vault
// starter. The host adapters (memory-pi, memory-opencode) get the same server
// plus a copy of the skills with the MCP tool prefix rewritten to their server
// name — opencode names tools `<server>_<tool>`, PI uses `mcp__<server>__<tool>`,
// and the canonical skills say `mcp__memory__*` (DSH's own name).
//
// Both packages' `prepare` scripts used to call this, and pnpm runs them
// concurrently — two processes doing rmSync+cpSync on the same two target
// directories, so one deleted what the other was copying:
//
//   ENOENT: no such file or directory, chmod '.../packages/memory-mcp/server'
//
// The lock below makes concurrent invocations safe for callers that still do
// that, and the target dirs are written once per run instead of once per package.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor to the repo root (this script lives in <root>/scripts), not the cwd:
// `prepare`/`build` may run with a package directory as cwd.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const EXCLUDE = /(^|\/)(\.venv|__pycache__|node_modules)(\/|$)/

const SERVER_FILES = ['server.py', 'store.py', 'registry.py', 'cli.py', 'pyproject.toml', 'uv.lock', 'launcher.mjs', 'requirements.txt', 'mcp-servers.json']
const STARTER_FILES = ['type-registry.yaml', 'tag-vocabulary.json', 'README.md']
const STARTER_DIRS = ['templates']

// Which packages exist and what each one gets bundled.
const DSH_PACKAGES = ['memory-mcp', 'memory-auto']
const ADAPTER_PACKAGES = ['memory-pi', 'memory-opencode']

// Canonical skill sources and the tool-prefix rewrite per adapter. Skills are
// auto-discovered (every <source>/<skill>/SKILL.md dir) so a new skill cannot be
// silently left out of an adapter. The guard below makes an unrewritten
// `mcp__memory__` reference a build error instead of a broken tool name.
const SKILL_SOURCES = ['memory-mcp/skills', 'memory-auto/skills']
const SKILL_REWRITES = {
  'memory-pi': [
    [/mcp__memory__/g, 'mcp__memory-server__'],
    [/named `memory`/g, 'named `memory-server`'],
  ],
  'memory-opencode': [[/mcp__memory__/g, 'memory-server_']],
}

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

/** Copies one skill dir, applying the adapter's rewrites to .md files. */
function copySkill(pkgDir, source, skill, rewrites) {
  const from = join(ROOT, 'packages', source, skill)
  const to = join(pkgDir, 'skills', skill)
  cpSync(from, to, { recursive: true })
  if (!rewrites) return
  for (const file of walk(to)) {
    if (!file.endsWith('.md')) continue
    const before = readFileSync(file, 'utf8')
    const after = rewrites.reduce((text, [from_, to_]) => text.replace(from_, to_), before)
    writeFileSync(file, after)
    // An unrewritten prefix would produce a tool name that does not exist.
    if (/mcp__memory__/.test(after)) {
      console.error(`bundle-assets: ${file} still references mcp__memory__* after rewriting`)
      process.exit(1)
    }
  }
}

/** Every file under dir, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

try {
  for (const pkg of [...DSH_PACKAGES, ...ADAPTER_PACKAGES]) {
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
  }

  for (const pkg of DSH_PACKAGES) {
    const dir = join(ROOT, 'packages', pkg)

    // vault starter (no data dirs)
    const vaultTarget = join(dir, 'vault')
    rmSync(vaultTarget, { recursive: true, force: true })
    for (const f of STARTER_FILES) cpSync(join(ROOT, 'memory-vault', f), join(vaultTarget, f))
    for (const d of STARTER_DIRS) cpSync(join(ROOT, 'memory-vault', d), join(vaultTarget, d), { recursive: true })
  }

  for (const pkg of ADAPTER_PACKAGES) {
    const dir = join(ROOT, 'packages', pkg)

    // skills, with the tool prefix rewritten to this adapter's server name
    const skillsTarget = join(dir, 'skills')
    rmSync(skillsTarget, { recursive: true, force: true })
    for (const source of SKILL_SOURCES) {
      const from = join(ROOT, 'packages', source)
      for (const name of readdirSync(from)) {
        if (!statSync(join(from, name)).isDirectory()) continue
        if (!existsSync(join(from, name, 'SKILL.md'))) {
          console.error(`bundle-assets: ${source}/${name} has no SKILL.md — not a skill`)
          process.exit(1)
        }
        copySkill(dir, source, name, SKILL_REWRITES[pkg])
      }
    }
  }
} finally {
  rmSync(LOCK, { recursive: true, force: true })
}
