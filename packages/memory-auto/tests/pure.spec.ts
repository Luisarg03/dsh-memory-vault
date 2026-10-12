import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCheckpointPrompt,
  buildCommitCheckpointPrompt,
  buildExtractionPrompt,
  chunkTranscript,
  compactingCheckpoint,
  createSessionState,
  EXTRACTABLE_TYPES,
  formatTagCatalog,
  idleCheckpoint,
  isGitCommit,
  isSupportedVersion,
  parseMemoryProjectDeclaration,
  repairJson,
  resolveProjectKey,
  resolveProjectName,
  validateEntries,
  verifyProjectKey,
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

  it('defines every entry type and how to shape content', () => {
    // The agents writing checkpoints get the same vocabulary the extraction
    // model gets; without it they were told to write entries never defined.
    const p = buildCheckpointPrompt(createSessionState('p'), 'did things')
    for (const t of EXTRACTABLE_TYPES) {
      expect(p).toContain(`**${t}**`)
    }
    expect(p).toContain('single paragraph')
    expect(p).toContain('lowercase-kebab')
    expect(p).toContain('high-signal')
  })
})

describe('checkpoint and extraction prompts agree', () => {
  it('share one entry-type vocabulary', () => {
    const checkpoint = buildCheckpointPrompt(createSessionState('p'), 'a')
    const commit = buildCommitCheckpointPrompt(createSessionState('p'))
    const { system } = buildExtractionPrompt('p', 't')
    for (const t of EXTRACTABLE_TYPES) {
      expect(checkpoint).toContain(`**${t}**`)
      expect(commit).toContain(`**${t}**`)
      expect(system).toContain(`**${t}**`)
    }
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

describe('buildExtractionPrompt', () => {
  it('names the project, embeds the transcript and restricts the entry types', () => {
    const { system, user } = buildExtractionPrompt('dsh-memory-vault', 'we decided to use sqlite')
    expect(system).toContain('`dsh-memory-vault`')
    expect(system).toContain('"decision" | "fact" | "learning" | "convention"')
    expect(system).toContain('JSON array')
    expect(user).toContain('we decided to use sqlite')
  })

  it('embeds vault context files when provided', () => {
    const { system } = buildExtractionPrompt('p', 't', {
      criticalFacts: 'User: es-AR',
      claude: 'vault map',
    })
    expect(system).toContain('CRITICAL_FACTS.md\nUser: es-AR')
    expect(system).toContain('_CLAUDE.md\nvault map')
  })
})

describe('chunkTranscript', () => {
  it('returns a single chunk for short transcripts', () => {
    expect(chunkTranscript('short')).toEqual(['short'])
  })

  it('splits oversized transcripts with overlap and a cap', () => {
    const text = 'x'.repeat(60_000)
    const chunks = chunkTranscript(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThanOrEqual(3)
    expect(chunks[0].length).toBe(25_000)
  })
})

describe('repairJson', () => {
  it('parses plain JSON', () => {
    expect(repairJson('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  it('strips markdown fences', () => {
    expect(repairJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
  })

  it('removes trailing commas', () => {
    expect(repairJson('[{"a":1},]')).toEqual([{ a: 1 }])
  })

  it('converts single-quoted JSON when no double quotes exist', () => {
    expect(repairJson("[{'entry_type': 'fact'}]")).toEqual([{ entry_type: 'fact' }])
  })

  it('returns null for unusable output', () => {
    expect(repairJson('no json here')).toBeNull()
  })
})

describe('validateEntries', () => {
  it('accepts extractable types and normalizes fields', () => {
    const entries = validateEntries([
      { entry_type: 'fact', content: '  sqlite is the index  ', tags: ['sqlite', 42], confidence: 1.7, description: 'd' },
      { entry_type: 'idea', content: 'dropped', tags: [] }, // no store tool -> dropped
      { entry_type: 'fact', content: '   ' }, // empty -> dropped
      'not-an-object',
      null,
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entry_type: 'fact',
      content: 'sqlite is the index',
      tags: ['sqlite'],
      confidence: 1,
      description: 'd',
    })
  })

  it('keeps openspec_change_id and clamps confidence', () => {
    const entries = validateEntries([
      { entry_type: 'decision', content: 'use uv', openspec_change_id: 'fix-memory-store', confidence: -2 },
    ])
    expect(entries[0].openspec_change_id).toBe('fix-memory-store')
    expect(entries[0].confidence).toBe(0)
  })

  it('returns [] for non-arrays', () => {
    expect(validateEntries({})).toEqual([])
    expect(validateEntries(null)).toEqual([])
  })
})

describe('parseMemoryProjectDeclaration', () => {
  it('extracts the declared key', () => {
    expect(parseMemoryProjectDeclaration('# AGENTS\nMemory project: my-proj\n')).toBe('my-proj')
    expect(parseMemoryProjectDeclaration('Memory project: org/repo')).toBe('org/repo')
  })

  it('returns null when absent or empty', () => {
    expect(parseMemoryProjectDeclaration('# no declaration here\n')).toBeNull()
    expect(parseMemoryProjectDeclaration('Memory project:   \n')).toBeNull()
  })
})

describe('formatTagCatalog', () => {
  it('renders names with aliases and drops blanks', () => {
    const out = formatTagCatalog([
      { name: 'ci', aliases: ['continuous-integration'] },
      { name: 'python' },
      { name: '   ' },
    ])
    expect(out).toContain('- ci (aka continuous-integration)')
    expect(out).toContain('- python')
  })

  it('returns empty for empty input', () => {
    expect(formatTagCatalog([])).toBe('')
  })
})

describe('buildExtractionPrompt with catalog', () => {
  it('embeds known tags and permits new ones', () => {
    const { system } = buildExtractionPrompt('p', 't', {}, [
      { name: 'ci', aliases: ['continuous-integration'] },
    ])
    expect(system).toContain('Known tags')
    expect(system).toContain('- ci (aka continuous-integration)')
    expect(system).toContain('NEW lowercase-kebab tag')
    expect(system).toContain('no approval')
  })

  it('stays backwards compatible without a catalog', () => {
    const { system } = buildExtractionPrompt('p', 't')
    expect(system).not.toContain('Known tags')
    expect(system).toContain('NEW lowercase-kebab tag')
  })
})

describe('resolveProjectKey', () => {
  const dirs: string[] = []

  function fixture(): string {
    const d = mkdtempSync(join(tmpdir(), 'memkey-'))
    dirs.push(d)
    return d
  }

  function vaultWith(...keys: string[]): string {
    const v = fixture()
    for (const k of keys) mkdirSync(join(v, 'projects', k), { recursive: true })
    return v
  }

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('prefers the closest AGENTS.md declaration when verified', async () => {
    const vault = vaultWith('declared-proj')
    const work = fixture()
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'from-package' }))
    writeFileSync(join(work, 'AGENTS.md'), '# x\nMemory project: declared-proj\n')
    const r = await resolveProjectKey(work, { vaultPath: vault })
    expect(r.key).toBe('declared-proj')
    expect(r.source).toBe('agents')
    expect(r.verified).toBe(true)
  })

  it('supports nested keys', async () => {
    const vault = vaultWith('org/repo')
    const work = fixture()
    writeFileSync(join(work, 'AGENTS.md'), 'Memory project: org/repo\n')
    const r = await resolveProjectKey(work, { vaultPath: vault })
    expect(r).toMatchObject({ key: 'org/repo', source: 'agents', verified: true })
    expect(verifyProjectKey(vault, 'org/repo')).toBe(true)
  })

  it('rejects keys that escape the vault projects dir', () => {
    const vault = vaultWith('org/repo')
    expect(verifyProjectKey(vault, '../../etc')).toBe(false)
    expect(verifyProjectKey(vault, 'org/../../etc')).toBe(false)
    expect(verifyProjectKey(vault, '/etc')).toBe(false)
    expect(verifyProjectKey(vault, '..')).toBe(false)
    expect(verifyProjectKey(vault, 'org/repo')).toBe(true)
  })

  it('flags an unknown project instead of silently creating it', async () => {
    const vault = vaultWith('real-proj')
    const work = fixture()
    writeFileSync(join(work, 'AGENTS.md'), 'Memory project: typo-proj\n')
    const r = await resolveProjectKey(work, { vaultPath: vault })
    expect(r.key).toBe('typo-proj')
    expect(r.verified).toBe(false)
    expect(r.message).toContain('typo-proj')
  })

  it('falls back to heuristics with an actionable message when undeclared', async () => {
    const vault = vaultWith('elsewhere')
    const work = fixture()
    const r = await resolveProjectKey(work, { vaultPath: vault })
    expect(r.source).toBe('heuristic')
    expect(r.verified).toBe(false)
    expect(r.message).toContain('Memory project:')
  })

  it('honors an explicitly configured project', async () => {
    const vault = vaultWith('cfg-proj')
    const work = fixture()
    const r = await resolveProjectKey(work, { vaultPath: vault, configuredProject: 'cfg-proj' })
    expect(r).toMatchObject({ key: 'cfg-proj', source: 'configured', verified: true })
  })
})
