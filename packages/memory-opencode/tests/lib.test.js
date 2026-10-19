// Adapter logic tests: the spec → opencode transformation and the config hook's
// "don't clobber the user" behaviour. Run against the bundled server/
// (`pnpm bundle` first); CI builds before testing.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MemoryOpenCode } from '../index.js'
import { buildMcpEntry, loadSpec, resolveVars, SERVER_NAME } from '../lib.js'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))
const SERVER_DIR = join(PKG_DIR, 'server')

describe('resolveVars', () => {
  it('substitutes known variables', () => {
    expect(resolveVars('${HOME}/.memories', { HOME: '/home/u' })).toBe('/home/u/.memories')
  })

  it('resolves unknown variables to empty, never a literal ${VAR}', () => {
    expect(resolveVars('${NOPE}', {})).toBe('')
  })
})

describe('buildMcpEntry', () => {
  const entry = {
    command: 'uv',
    args: ['run', '--directory', '${SERVER_DIR}', 'python', 'server.py'],
    env: { MEMORY_PATH: '${HOME}/.memories' },
  }

  it('produces opencode\'s local shape: argv array + `environment`', () => {
    const mcp = buildMcpEntry(entry, { serverDir: '/pkg/server', env: { HOME: '/home/u' } })
    expect(mcp).toEqual({
      type: 'local',
      command: ['uv', 'run', '--directory', '/pkg/server', 'python', 'server.py'],
      enabled: true,
      environment: { MEMORY_PATH: '/home/u/.memories' },
    })
  })

  it('uses no shell: no `~` may survive into command or env', () => {
    const mcp = buildMcpEntry(entry, { serverDir: '/pkg/server', env: { HOME: '/home/u' } })
    expect(mcp.command.join(' ')).not.toContain('~')
    expect(Object.values(mcp.environment).join(' ')).not.toContain('~')
  })

  it('defaults env to process.env', () => {
    const mcp = buildMcpEntry(entry, { serverDir: '/pkg/server' })
    expect(mcp.environment.MEMORY_PATH).toBe(`${process.env.HOME ?? ''}/.memories`)
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

describe('config hook', () => {
  const hook = async () => (await MemoryOpenCode()).config

  it('injects the server when the user declared none', async () => {
    const input = {}
    await (await hook())(input)

    expect(input.mcp[SERVER_NAME].type).toBe('local')
    expect(input.mcp[SERVER_NAME].command[0]).toBe('uv')
    expect(input.mcp[SERVER_NAME].command).toContain(SERVER_DIR)
    expect(input.mcp[SERVER_NAME].environment.MEMORY_PATH).toBe(`${process.env.HOME ?? ''}/.memories`)
  })

  it('keeps the user\'s own memory-server entry untouched', async () => {
    const input = { mcp: { [SERVER_NAME]: { type: 'remote', url: 'http://mine' } } }
    await (await hook())(input)
    expect(input.mcp[SERVER_NAME]).toEqual({ type: 'remote', url: 'http://mine' })
  })

  it('appends the bundled skills dir once, idempotently', async () => {
    const input = { skills: ['/user/skills'] }
    await (await hook())(input)
    await (await hook())(input)

    expect(input.skills).toEqual(['/user/skills', join(PKG_DIR, 'skills')])
  })

  it('handles the resolved { paths } shape other plugins produce', async () => {
    const input = { skills: { paths: ['/user/skills'] } }
    await (await hook())(input)
    await (await hook())(input)

    expect(input.skills.paths).toEqual(['/user/skills', join(PKG_DIR, 'skills')])
  })

  it('creates the skills entry when the user declared none', async () => {
    const input = {}
    await (await hook())(input)
    expect(input.skills).toEqual([join(PKG_DIR, 'skills')])
  })
})
