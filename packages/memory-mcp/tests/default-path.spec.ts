// The vault root is declared in five places (two resolvers, two bundle patches, the
// Python CLI). Nothing type-checks the YAML or Python copies, so a single stale default
// silently splits the writers: the digest would store to one vault, the MCP tools to
// another. This guards the one value they must agree on.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Each site spells the default differently; all five must point at the same directory. */
const VAULT_DEFAULT_SITES = [
  { file: 'packages/memory-mcp/src/index.ts', expected: "join(homedir(), '.memories')" },
  { file: 'packages/memory-auto/src/plugin.ts', expected: "join(homedir(), '.memories')" },
  { file: 'packages/memory-mcp/cordis.patch.yml', expected: "/.memories'" },
  { file: 'packages/memory-auto/cordis.patch.yml', expected: "/.memories'" },
  { file: 'memory-vault-server/cli.py', expected: 'Path.home() / ".memories"' },
]

describe('default vault path', () => {
  it('is ~/.memories at every declaration site', () => {
    for (const { file, expected } of VAULT_DEFAULT_SITES) {
      expect(read(file), `${file}: default drifted`).toContain(expected)
    }
  })

  it('never resolves the vault under $DSH_HOME', () => {
    for (const { file } of VAULT_DEFAULT_SITES) {
      const text = read(file)
      expect(text, `${file}: vault still tied to the harness home`).not.toContain("dshHomePath('memory-vault')")
      expect(text, `${file}: vault still tied to the harness home`).not.toContain("resolveUnderHome(config.memoryPath")
    }
  })

  it('keeps the server directory under the harness home', () => {
    expect(read('packages/memory-mcp/cordis.patch.yml')).toContain("dshHomePath('memory-vault-server')")
  })

  it('refreshes the server code on every boot, in both plugins', () => {
    // The bootstrap copies the vault only when it is missing (user data) but must
    // overwrite the server bundle (our code): the 0.1.5 shape skipped both once
    // they existed, so every Python fix stopped at the first install.
    for (const file of ['packages/memory-mcp/src/index.ts', 'packages/memory-auto/src/plugin.ts']) {
      const src = read(file)
      expect(src, `${file}: server bundle is not refreshed`).toContain(
        'cpSync(bundledServer, serverDir, { recursive: true, force: true })',
      )
      expect(src, `${file}: vault is no longer write-once`).toContain(
        "ensure(memoryPath, join(packageRoot, 'vault'), 'type-registry.yaml')",
      )
    }
  })

  it('keeps a registry-less checkout working (CI smoke test runs with no MEMORY_PATH)', () => {
    // The bare `python -c "import server"` on CI has neither the env var nor ~/.memories,
    // so the last fallback must still reach the starter shipped next to the server — and
    // it must come after the default, never before it.
    const cli = read('memory-vault-server/cli.py')
    const defaultAt = cli.indexOf('Path.home() / ".memories"')
    const fallbackAt = cli.indexOf('parent.parent / "memory-vault"')
    expect(defaultAt).toBeGreaterThan(-1)
    expect(fallbackAt).toBeGreaterThan(defaultAt)
  })
})
