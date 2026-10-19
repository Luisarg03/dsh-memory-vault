// PI extension: registers the memory vault MCP server so users never hand-write
// ~/.pi/agent/mcp.json. A homonymous server in mcp.json takes precedence over an
// extension-registered one (PI docs/mcp.md), so an existing manual config wins
// and nothing gets duplicated. The package's skills are picked up through the
// "pi" manifest in package.json; nothing registers them here.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMcpConfig, loadSpec, SERVER_NAME } from './lib.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

export default function memoryServerExtension(pi) {
  const config = buildMcpConfig(loadSpec(PKG_DIR), { serverDir: join(PKG_DIR, 'server') })
  pi.registerMcpServer(SERVER_NAME, {
    ...config,
    description: 'Memory vault: search and store session memories (shared ~/.memories vault)',
  })
}
