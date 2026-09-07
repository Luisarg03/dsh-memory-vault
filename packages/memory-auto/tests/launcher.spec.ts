import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveRunner } from '../../../memory-vault-server/launcher.mjs'

describe('vault server launcher — runner selection', () => {
  it('uses `uv run` when uv is present', () => {
    expect(resolveRunner(true, '/srv')).toEqual({
      command: 'uv',
      args: ['run', '--directory', '/srv', 'python', 'server.py'],
    })
  })

  it('falls back to the pip venv python on posix', () => {
    expect(resolveRunner(false, '/srv', 'linux')).toEqual({
      command: '/srv/.venv/bin/python',
      args: ['server.py'],
    })
  })

  it('falls back to the pip venv python on win32', () => {
    expect(resolveRunner(false, 'C:\\srv', 'win32')).toEqual({
      command: join('C:\\srv', '.venv/Scripts/python.exe'),
      args: ['server.py'],
    })
  })
})
