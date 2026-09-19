import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { skillsProvider } from './skills.js'

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

/** Vault root: `~/.memories` by default, independent of `$DSH_HOME`. */
function resolveMemoryPath(value: string): string {
  const v = value.trim()
  if (v.length === 0) return join(homedir(), '.memories')
  return isAbsolute(v) ? v : join(homedir(), v)
}

/** Copy the bundled dir into `target` when `key` is missing there. */
/** Copy the bundled dir into `target` when `key` is missing there (user data). */
function ensure(target: string, bundled: string, key: string): boolean {
  if (existsSync(join(target, key))) return false
  if (!existsSync(bundled)) return false
  mkdirSync(target, { recursive: true })
  cpSync(bundled, target, { recursive: true })
  return true
}

export function apply(ctx: Context, config: Config) {
  // Ship the skills that drive the tools this plugin exposes, at the bundled
  // rank, so a user's own `brain`/`checkpoint` in a skill directory still wins.
  // Injected rather than declared in the plugin's `inject`: the vault bootstrap
  // and the MCP client must keep working in a deployment with no skill catalog.
  ctx.inject(['skills'], (ctx) => {
    ctx.skills.registerProvider(() => skillsProvider)
  })

  const serverDir = resolveUnderHome(config.serverDir, 'memory-vault-server')
  const memoryPath = resolveMemoryPath(config.memoryPath)

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
    if (firstBoot) console.log(`[memory-mcp] installed memory-vault-server -> ${serverDir}`)
  }
  if (ensure(memoryPath, join(packageRoot, 'vault'), 'type-registry.yaml')) {
    console.log(`[memory-mcp] installed vault starter -> ${memoryPath}`)
  }
  if (!existsSync(join(serverDir, 'server.py'))) {
    console.warn(
      `[memory-mcp] memory-vault-server not found at ${serverDir} and not bundled — ` +
      'set DSH_MEMORY_SERVER_DIR (or run `node scripts/bundle-assets.mjs` in a checkout)',
    )
  }
}
