import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { apply } from '../src/index.js'
import { SKILLS_PROVIDER, skillsProvider } from '../src/skills.js'

/** See the sibling spec in memory-mcp: shipped skills must stay generic. */
const HARDCODED_VAULT_PATH = /~\/\.memories|\/home\/[a-z0-9]+/i

describe('memory-auto bundled skills', () => {
  it('lists exactly the skills shipped in this package', async () => {
    const candidates = await skillsProvider.list({})

    expect(candidates.map(candidate => candidate.name)).toEqual(['checkpoint-auto'])
    for (const candidate of candidates) {
      expect(candidate.provider).toBe(SKILLS_PROVIDER)
      expect(candidate.source).toBe('bundled')
      expect(candidate.rank).toBe(BUNDLED_SKILL_RANK)
      expect(candidate.description.length).toBeGreaterThan(20)
      expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(candidate.path?.endsWith('skills/checkpoint-auto/SKILL.md')).toBe(true)
    }
  })

  it('loads the body without leaking its frontmatter', async () => {
    const [candidate] = await skillsProvider.list({})
    if (candidate === undefined) throw new Error('provider listed no candidate')
    const skill = await skillsProvider.get(candidate, {})

    expect(skill.content.startsWith('# ')).toBe(true)
    expect(skill.content).not.toMatch(HARDCODED_VAULT_PATH)
  })

  it('defers the capture procedure instead of restating it', async () => {
    const [candidate] = await skillsProvider.list({})
    if (candidate === undefined) throw new Error('provider listed no candidate')
    const { content } = await skillsProvider.get(candidate, {})

    // The entry vocabulary belongs to /checkpoint and to pure.ts; this skill
    // must point at them rather than becoming a third copy.
    expect(content).toContain('/checkpoint')
    expect(content).not.toMatch(/ENTRY_TYPE_GLOSS|store_decision/)
  })

  it('resolves to undefined instead of throwing when a body is unloadable', async () => {
    const [candidate] = await skillsProvider.list({})
    if (candidate === undefined) throw new Error('provider listed no candidate')

    // See the sibling spec in memory-mcp: `undefined` is the provider contract,
    // while a throw would reach the caller as a raw ENOENT.
    await expect(
      skillsProvider.get({ ...candidate, name: 'no-such-skill' }, {}),
    ).resolves.toBeUndefined()
  })
})

describe('memory-auto skill wiring', () => {
  /**
   * Registration happens before the `enabled` gate on purpose: the skill is how
   * a session learns that capture is off and how to turn it back on. Disabling
   * capture must not remove the skill that documents the switch.
   */
  it('registers its provider even when capture is disabled', () => {
    const calls: { deps: unknown; callback: (ctx: unknown) => void }[] = []
    const ctx = {
      inject: (deps: unknown, callback: (ctx: unknown) => void) => {
        calls.push({ deps, callback })
      },
    }

    apply(ctx as never, {
      memoryPath: '',
      serverDir: '',
      provider: 'test',
      model: 'test',
      maxTokens: 1,
      minTranscriptChars: 1,
      enabled: false,
    })

    expect(calls.map(call => call.deps)).toEqual([['skills']])

    const registered: unknown[] = []
    calls[0]?.callback({ skills: { registerProvider: (create: unknown) => registered.push(create) } })
    expect(registered).toHaveLength(1)
    expect((registered[0] as () => unknown)()).toBe(skillsProvider)
  })
})
