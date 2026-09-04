// Syncs the vault server and vault starter into both plugin packages so the
// published tarballs are self-contained (install without cloning the repo).
// Run from the repo root as part of each package's `prepare`.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor to the repo root (this script lives in <root>/scripts), not the cwd:
// `prepare` runs with the package directory as cwd.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const EXCLUDE = /(^|\/)(\.venv|__pycache__|node_modules)(\/|$)/

const SERVER_FILES = ['server.py', 'store.py', 'registry.py', 'cli.py', 'pyproject.toml', 'uv.lock']
const STARTER_FILES = ['type-registry.yaml', 'tag-vocabulary.json', 'README.md']
const STARTER_DIRS = ['templates']

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
