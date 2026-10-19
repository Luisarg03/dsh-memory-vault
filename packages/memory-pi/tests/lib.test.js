// Adapter logic tests: the spec → PI transformation and the extension's
// registration call. Run against the bundled server/ (`pnpm bundle` first);
// CI builds before testing.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import memoryServerExtension from '../extension.js'
import { buildMcpConfig, loadSpec, resolveVars, SERVER_NAME } from '../lib.js'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))
const SERVER_DIR = join(PKG_DIR, 'server')

describe('resolveVars', () => {
  it('substitutes known variables', () => {
    expect(resolveVars('${HOME}/.memories', { HOME: '/home/u' })).toBe('/home/u/.memories')
  })

  it('resolves unknown variables to empty, never a literal ${VAR}', () => {
    expect(resolveVars('${NOPE}', {})).toBe('')
  })

  it('leaves unrelated text alone', () => {
    expect(resolveVars('run --directory x python server.py', {})).toBe('run --directory x python server.py')
  })
})

describe('buildMcpConfig', () => {
  const entry = {
    command: 'uv',
    args: ['run', '--directory', '${SERVER_DIR}', 'python', 'server.py'],
    env: { MEMORY_PATH: '${HOME}/.memories' },
  }

  it('produces PI\'s command/args/env shape with absolute paths', () => {
    const config = buildMcpConfig(entry, { serverDir: '/pkg/server', env: { HOME: '/home/u' } })
    expect(config).toEqual({
      command: 'uv',
      args: ['run', '--directory', '/pkg/server', 'python', 'server.py'],
      env: { MEMORY_PATH: '/home/u/.memories' },
    })
  })

  it('defaults env to process.env', () => {
    const config = buildMcpConfig(entry, { serverDir: '/pkg/server' })
    expect(config.env.MEMORY_PATH).toBe(`${process.env.HOME ?? ''}/.memories`)
  })
})

describe('loadSpec', () => {
  it('reads the bundled spec', () => {
    const spec = loadSpec(PKG_DIR)
    expect(spec.command).toBe('uv')
    expect(spec.args).toContain('server.py')
  })

  it('throws a build hint when the bundle is missing', () => {
    expect(() => loadSpec(join(PKG_DIR, 'does-not-exist'))).toThrow(/pnpm bundle/)
  })
})

describe('extension registration', () => {
  it('registers memory-server exactly once, with a resolved config', () => {
    const calls = []
    memoryServerExtension({ registerMcpServer: (name, config) => calls.push([name, config]) })

    expect(calls).toHaveLength(1)
    const [name, config] = calls[0]
    expect(name).toBe(SERVER_NAME)
    expect(config.command).toBe('uv')
    expect(config.args).toEqual(['run', '--directory', SERVER_DIR, 'python', 'server.py'])
    expect(config.env.MEMORY_PATH).toBe(`${process.env.HOME ?? ''}/.memories`)
    expect(config.description).toMatch(/memory vault/i)
  })

  it('is the default export PI expects', async () => {
    expect(typeof (await import('../extension.js')).default).toBe('function')
  })
})
