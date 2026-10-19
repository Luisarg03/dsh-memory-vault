// Shared logic for the opencode adapter. Reads the canonical MCP server spec
// that ships inside this package (<pkg>/server/mcp-servers.json) and resolves
// it to opencode's `mcp.<name>` shape: a "local" server whose command is an
// argv array (spawned without a shell — no ~ expansion, so everything here is
// resolved to absolute paths) and whose env block is called `environment`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The server name every client sees; matches the manual configs users already have. */
export const SERVER_NAME = 'memory-server'

const SPEC_FILE = 'mcp-servers.json'

/** Loads this package's bundled server spec; throws if the bundle is missing. */
export function loadSpec(pkgDir) {
  let raw
  try {
    raw = readFileSync(join(pkgDir, 'server', SPEC_FILE), 'utf8')
  } catch {
    throw new Error(`${SPEC_FILE} not found under ${pkgDir}/server — run \`pnpm bundle\` in the repo root first`)
  }
  const spec = JSON.parse(raw)
  const entry = spec[SERVER_NAME]
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    throw new Error(`${SPEC_FILE} has no usable "${SERVER_NAME}" entry (needs command + args)`)
  }
  return entry
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** ${VAR} → value; an unset variable resolves to "" (never a literal ${VAR} at spawn). */
export function resolveVars(value, vars) {
  return value.replace(VAR_RE, (_, name) => vars[name] ?? '')
}

/** Resolves a spec entry to opencode's local-server shape. */
export function buildMcpEntry(entry, { serverDir, env = process.env }) {
  const vars = { SERVER_DIR: serverDir, ...env }
  return {
    type: 'local',
    command: [resolveVars(entry.command, vars), ...entry.args.map((arg) => resolveVars(String(arg), vars))],
    enabled: true,
    environment: Object.fromEntries(
      Object.entries(entry.env ?? {}).map(([key, value]) => [key, resolveVars(String(value), vars)]),
    ),
  }
}
