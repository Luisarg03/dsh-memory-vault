import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'memory-mcp'

export interface Config {
  memoryPath: string
}

export const Config: Schema<Config> = Schema.object({
  memoryPath: Schema.string().default(process.env.DSH_MEMORY_PATH ?? './memory-vault'),
})

export function apply(ctx: Context, config: Config) {
  // This plugin is a placeholder; actual MCP wiring is via cordis.patch.yml
  // dsh-mcp-client row. This module allows Config validation and logs.
  console.log(`[memory-mcp] MEMORY_PATH=${config.memoryPath}`)
}
