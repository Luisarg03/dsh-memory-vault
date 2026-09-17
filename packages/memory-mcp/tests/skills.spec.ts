import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { apply } from '../src/index.js'
import { SKILLS_PROVIDER, skillsProvider } from '../src/skills.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * The shipped skills are the public, user-facing half of this plugin: they must
 * stay generic. A hardcoded vault path is the regression that matters — every
 * skill resolves the vault from the plugin config or its env var instead.
 */
const HARDCODED_VAULT_PATH = /~\/\.memories|\/home\/[a-z0-9]+/i

describe('memory-mcp bundled skills', () => {
  it('lists exactly the skills shipped in this package', async () => {
    const candidates = await skillsProvider.list({})

    expect(candidates.map(candidate => candidate.name).sort()).toEqual(['brain', 'checkpoint'])
    for (const candidate of candidates) {
      expect(candidate.provider).toBe(SKILLS_PROVIDER)
      expect(candidate.source).toBe('bundled')
      expect(candidate.rank).toBe(BUNDLED_SKILL_RANK)
      expect(candidate.description.length).toBeGreaterThan(20)
      expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(candidate.path?.endsWith(`skills/${candidate.name}/SKILL.md`)).toBe(true)
    }
  })

  it('loads each candidate body without leaking its frontmatter', async () => {
    for (const candidate of await skillsProvider.list({})) {
      const skill = await skillsProvider.get(candidate, {})

      expect(skill.name).toBe(candidate.name)
      expect(skill.description).toBe(candidate.description)
      expect(skill.content.startsWith('# ')).toBe(true)
    }
  })

  it('keeps every shipped body generic', async () => {
    for (const candidate of await skillsProvider.list({})) {
      const skill = await skillsProvider.get(candidate, {})

      expect(skill.content).not.toMatch(HARDCODED_VAULT_PATH)
      expect(skill.description).not.toMatch(HARDCODED_VAULT_PATH)
    }
  })

  it('resolves its assets from the package root, not the cwd', async () => {
    const [candidate] = await skillsProvider.list({})

    expect(candidate?.resourceBase).toEqual({
      kind: 'directory',
      path: expect.stringContaining('skills/brain'),
    })
  })
})

describe('memory-mcp skill wiring', () => {
  /**
   * `apply` must hand the provider to the skills service through `ctx.inject`
   * (an optional dependency), not through the plugin's declared `inject`: the
   * vault bootstrap and the MCP client have to keep working where no skill
   * catalog is mounted. Pointing both paths at the package's own server/vault
   * keeps this test free of filesystem writes.
   */
  it('registers its provider with the skills service, and only with it', () => {
    const calls: { deps: unknown; callback: (ctx: unknown) => void }[] = []
    const ctx = {
      inject: (deps: unknown, callback: (ctx: unknown) => void) => {
        calls.push({ deps, callback })
      },
    }

    apply(ctx as never, {
      memoryPath: join(PACKAGE_ROOT, 'vault'),
      serverDir: join(PACKAGE_ROOT, 'server'),
    })

    expect(calls.map(call => call.deps)).toEqual([['skills']])

    const registered: unknown[] = []
    calls[0]?.callback({ skills: { registerProvider: (create: unknown) => registered.push(create) } })
    expect(registered).toHaveLength(1)
    expect((registered[0] as () => unknown)()).toBe(skillsProvider)
  })

  /**
   * The packaged layout is what users get: `dist/index.js` must still find
   * `../skills/` after bundling. `pnpm install` runs `prepare` (tsdown), so the
   * built entry exists by the time tests run, and the release guard builds
   * before testing too.
   */
  it('loads a skill body from the built entry point', async () => {
    const built = await import('../dist/index.js')
    const calls: { callback: (ctx: unknown) => void }[] = []
    built.apply(
      { inject: (_deps: unknown, callback: (ctx: unknown) => void) => calls.push({ callback }) } as never,
      { memoryPath: join(PACKAGE_ROOT, 'vault'), serverDir: join(PACKAGE_ROOT, 'server') },
    )

    const factories: (() => typeof skillsProvider)[] = []
    calls[0]?.callback({ skills: { registerProvider: (create: () => typeof skillsProvider) => factories.push(create) } })
    const provider = factories[0]?.()
    if (provider === undefined) throw new Error('built entry registered no provider')

    const [candidate] = await provider.list({})
    if (candidate === undefined) throw new Error('provider listed no candidate')
    const skill = await provider.get(candidate, {})

    expect(skill.name).toBe('brain')
    expect(skill.content).toContain('read from the vault')
  })
})
