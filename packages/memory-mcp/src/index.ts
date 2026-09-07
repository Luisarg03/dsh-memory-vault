import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'memory-mcp'

export interface Config {
  memoryPath: string
  serverDir: string
}

export const Config: Schema<Config> = Schema.object({
  memoryPath: Schema.string().default(process.env.DSH_MEMORY_PATH ?? ''),
  serverDir: Schema.string().default(process.env.DSH_MEMORY_SERVER_DIR ?? ''),
})

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Harness home, resolved like the harness itself ($DSH_HOME, or ~/.dsh). */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env && env.length > 0 ? env : join(homedir(), '.dsh')
}

/** Absolute paths stay; empty/relative values resolve under the harness home. */
function resolveUnderHome(value: string, segment: string): string {
  const v = value.trim()
  if (v.length === 0) return join(dshHome(), segment)
  return isAbsolute(v) ? v : join(dshHome(), v)
}

/** Copy the bundled dir into `target` when `key` is missing there. */
function ensure(target: string, bundled: string, key: string): boolean {
  if (existsSync(join(target, key))) return false
  if (!existsSync(bundled)) return false
  mkdirSync(target, { recursive: true })
  cpSync(bundled, target, { recursive: true })
  return true
}

/** Copy one bundled file into `target` when missing (upgrades add files 0.1.1 → 0.1.2). */
function ensureFile(target: string, bundled: string, file: string): boolean {
  const dest = join(target, file)
  if (existsSync(dest)) return false
  const src = join(bundled, file)
  if (!existsSync(src)) return false
  mkdirSync(target, { recursive: true })
  cpSync(src, dest)
  return true
}

export function apply(ctx: Context, config: Config) {
  const serverDir = resolveUnderHome(config.serverDir, 'memory-vault-server')
  const memoryPath = resolveUnderHome(config.memoryPath, 'memory-vault')

  // Self-contained install: first boot copies the bundled server and vault
  // starter under the harness home when they are missing. Env-overridden
  // paths are respected (never overwritten, never copied over).
  if (ensure(serverDir, join(packageRoot, 'server'), 'server.py')) {
    console.log(`[memory-mcp] installed memory-vault-server -> ${serverDir}`)
  }
  if (ensure(memoryPath, join(packageRoot, 'vault'), 'type-registry.yaml')) {
    console.log(`[memory-mcp] installed vault starter -> ${memoryPath}`)
  }
  // launcher.mjs runs the server via uv or the pip-venv fallback; upgrades of
  // existing installs (server.py already present) still need the new files.
  const bundled = join(packageRoot, 'server')
  for (const file of ['launcher.mjs', 'requirements.txt']) {
    if (ensureFile(serverDir, bundled, file)) {
      console.log(`[memory-mcp] installed ${file} -> ${serverDir}`)
    }
  }
  if (!existsSync(join(serverDir, 'server.py'))) {
    console.warn(
      `[memory-mcp] memory-vault-server not found at ${serverDir} and not bundled — ` +
      'set DSH_MEMORY_SERVER_DIR (or run `node scripts/bundle-assets.mjs` in a checkout)',
    )
  }
}
