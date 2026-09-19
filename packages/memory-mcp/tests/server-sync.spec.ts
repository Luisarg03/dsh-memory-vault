// The bootstrap copied the server only when `server.py` was missing, so every
// install created before a release kept that release's Python code forever: the
// 0.1.6 `cli.py` and `store.py` fixes reached nobody. This pins the split the fix
// introduced — server code refreshed on every boot, vault (user data) written once,
// nothing in the target deleted.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const BUNDLED = fileURLToPath(new URL('../server/', import.meta.url))

/** Minimal skills service: `apply` only registers a provider through it. */
const ctx = {
  inject: (_deps: unknown, callback: (ctx: unknown) => void) =>
    callback({ skills: { registerProvider: () => {} } }),
}

const roots: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-sync-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('bootstrap: server code vs vault data', () => {
  const STALE = '# stale code from an older release\n'

  it('refreshes the server directory and deletes nothing in it', () => {
    expect(existsSync(join(BUNDLED, 'server.py')), 'run `pnpm bundle` first').toBe(true)

    const root = tempDir()
    const serverDir = join(root, 'memory-vault-server')
    mkdirSync(join(serverDir, '.venv', 'bin'), { recursive: true })
    mkdirSync(join(serverDir, '__pycache__'), { recursive: true })
    writeFileSync(join(serverDir, '.venv', 'bin', 'python'), 'venv')
    writeFileSync(join(serverDir, '__pycache__', 'store.cpython-312.pyc'), 'pyc')
    writeFileSync(join(serverDir, 'server.py'), STALE)
    writeFileSync(join(serverDir, 'cli.py'), STALE)

    apply(ctx as never, { memoryPath: join(root, 'vault'), serverDir })

    expect(readFileSync(join(serverDir, 'cli.py'), 'utf8')).toBe(readFileSync(join(BUNDLED, 'cli.py'), 'utf8'))
    expect(readFileSync(join(serverDir, 'cli.py'), 'utf8')).not.toBe(STALE)
    // The launcher's pip venv and build residue are not ours to delete.
    expect(existsSync(join(serverDir, '.venv', 'bin', 'python'))).toBe(true)
    expect(existsSync(join(serverDir, '__pycache__', 'store.cpython-312.pyc'))).toBe(true)
  })

  it('never overwrites an existing vault', () => {
    const root = tempDir()
    const serverDir = join(root, 'memory-vault-server')
    const vaultDir = join(root, 'vault')
    const entry = join(vaultDir, 'projects', 'demo', 'decisions', 'entry.md')
    mkdirSync(join(vaultDir, 'projects', 'demo', 'decisions'), { recursive: true })
    writeFileSync(join(vaultDir, 'type-registry.yaml'), '# mine\n')
    writeFileSync(entry, 'user data')

    apply(ctx as never, { memoryPath: vaultDir, serverDir })

    expect(readFileSync(join(vaultDir, 'type-registry.yaml'), 'utf8')).toBe('# mine\n')
    expect(readFileSync(entry, 'utf8')).toBe('user data')
  })
})
