import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'memory-mcp'

export interface Config {
  memoryPath: string
}

export const Config: Schema<Config> = Schema.object({
  memoryPath: Schema.string().default(process.env.DSH_MEMORY_PATH ?? ''),
})

/**
 * Resolve the harness home the same way the harness does (`$DSH_HOME`, or
 * `~/.dsh`). Paths must never depend on the launch cwd: DSH does not chdir.
 */
function resolveMemoryPath(value: string): string {
  const v = value.trim()
  if (v.length === 0) return join((process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')), 'memory-vault')
  return isAbsolute(v) ? v : join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), v)
}

export function apply(ctx: Context, config: Config) {
  // This plugin is a placeholder; actual MCP wiring is via cordis.patch.yml
  // dsh-mcp-client row. This module allows Config validation and logs.
  const memoryPath = resolveMemoryPath(config.memoryPath)
  if (!existsSync(memoryPath)) {
    console.warn(`[memory-mcp] vault not found at ${memoryPath} — it will be created on first use.`)
  }
  console.log(`[memory-mcp] MEMORY_PATH=${memoryPath}`)
}
