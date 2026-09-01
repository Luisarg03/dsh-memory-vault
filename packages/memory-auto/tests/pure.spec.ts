import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCheckpointPrompt,
  buildCommitCheckpointPrompt,
  compactingCheckpoint,
  createSessionState,
  idleCheckpoint,
  isGitCommit,
  isSupportedVersion,
  resolveProjectName,
  type SessionState,
} from '../src/pure.js'

const activity = 'ran build, fixed typo in README'

describe('isSupportedVersion', () => {
  it('accepts the minimum and newer versions', () => {
    expect(isSupportedVersion('1.17.10')).toBe(true)
    expect(isSupportedVersion('1.18.0')).toBe(true)
    expect(isSupportedVersion('2.0.0')).toBe(true)
  })

  it('rejects older versions and garbage', () => {
    expect(isSupportedVersion('1.17.9')).toBe(false)
    expect(isSupportedVersion('0.9.0')).toBe(false)
    expect(isSupportedVersion('not-a-version')).toBe(false)
  })
})

describe('createSessionState', () => {
  it('starts inert for a project', () => {
    const s = createSessionState('my-project')
    expect(s).toEqual({
      project: 'my-project',
      hasActivity: false,
      checkpointDelivered: false,
      queuedCheckpoint: null,
    })
  })
})

describe('idleCheckpoint', () => {
  it('skips sessions without activity', () => {
    const s = createSessionState('p')
    expect(idleCheckpoint(s, activity)).toBeNull()
    expect(s.checkpointDelivered).toBe(false)
  })

  it('delivers once and then stays silent', () => {
    const s: SessionState = { ...createSessionState('p'), hasActivity: true }
    const first = idleCheckpoint(s, activity)
    expect(first).toContain('[memory-checkpoint]')
    expect(s.checkpointDelivered).toBe(true)
    expect(idleCheckpoint(s, activity)).toBeNull()
  })

  it('uses the fallback text when nothing was tracked', () => {
    const s: SessionState = { ...createSessionState('p'), hasActivity: true }
    expect(idleCheckpoint(s, '   ')).toContain('(none recorded)')
  })
})

describe('compactingCheckpoint', () => {
  it('fires on every compaction while activity exists, even after delivery', () => {
    const s: SessionState = { ...createSessionState('p'), hasActivity: true, checkpointDelivered: true }
    expect(compactingCheckpoint(s, activity)).toContain('[memory-checkpoint]')
    expect(compactingCheckpoint(s, activity)).toContain('End-of-session memory capture')
  })

  it('skips compactions without activity', () => {
    expect(compactingCheckpoint(createSessionState('p'), activity)).toBeNull()
  })
})

describe('isGitCommit', () => {
  it('detects commit commands', () => {
    expect(isGitCommit('git commit -m "wip"')).toBe(true)
    expect(isGitCommit('git commit --amend')).toBe(true)
  })

  it('ignores other git commands', () => {
    expect(isGitCommit('git status')).toBe(false)
    expect(isGitCommit('git push origin main')).toBe(false)
    expect(isGitCommit('')).toBe(false)
  })
})

describe('buildCheckpointPrompt', () => {
  it('names the project and embeds the tracked activity', () => {
    const s = createSessionState('dsh-memory-vault')
    const p = buildCheckpointPrompt(s, 'fixed store.py path resolution')
    expect(p).toContain('[memory-checkpoint]')
    expect(p).toContain('`dsh-memory-vault`')
    expect(p).toContain('fixed store.py path resolution')
    expect(p).toContain('`store_*` MCP tools')
  })
})

describe('buildCommitCheckpointPrompt', () => {
  it('points at the committed changes', () => {
    const p = buildCommitCheckpointPrompt(createSessionState('p'))
    expect(p).toContain('[memory-checkpoint]')
    expect(p).toContain('Memory capture after `git commit`')
  })
})

describe('resolveProjectName', () => {
  const dirs: string[] = []

  function fixture(): string {
    const d = mkdtempSync(join(tmpdir(), 'memtest-'))
    dirs.push(d)
    return d
  }

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('uses the directory basename when openspec/ is present (documented priority)', async () => {
    const d = fixture()
    mkdirSync(join(d, 'openspec'))
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'from-package' }))
    expect(await resolveProjectName(d)).toBe(d.split('/').pop())
  })

  it('falls back to the package.json name', async () => {
    const d = fixture()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'from-package' }))
    expect(await resolveProjectName(d)).toBe('from-package')
  })

  it('reads the name from pyproject.toml when there is no package.json', async () => {
    const d = fixture()
    writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "from-pyproject"\nversion = "0.1.0"\n')
    expect(await resolveProjectName(d)).toBe('from-pyproject')
  })

  it('uses the first README heading as a last resort before the dirname', async () => {
    const d = fixture()
    writeFileSync(join(d, 'README.md'), '# My Cool Project\n\nIntro line.\n')
    expect(await resolveProjectName(d)).toBe('My Cool Project')
  })

  it('falls back to the directory basename', async () => {
    const d = fixture()
    expect(await resolveProjectName(d)).toBe(d.split('/').pop())
  })
})
