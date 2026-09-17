/**
 * Bundled skill shipped in this package: `checkpoint-auto`, the contract of the
 * automatic capture this plugin performs (triggers, the `[memory-checkpoint]`
 * marker, the digest, and the knobs). The capture *procedure* it defers to
 * lives in `@luisarg/memory-mcp`'s `checkpoint` skill, which is installed
 * alongside this plugin.
 *
 * A provider rather than `ctx.skills.register()` on purpose. A registration
 * lands at the runtime rank, which outranks a user's own skill directories,
 * while BUNDLED_SKILL_RANK is the weakest rank in the local discovery table:
 * shipping at the weakest rank means a user who drops their own skill of the
 * same name into `~/.agents/skills` keeps winning. This is a default, not a
 * takeover.
 *
 * Each SKILL.md stays the single source of its own name, description and
 * usage guidance — the frontmatter is parsed here with the same `yaml`
 * dependency the harness's own filesystem provider uses, so the exact file that
 * ships in this package also works copied into a user skill root. Kept as a
 * copy of the sibling provider in `@luisarg/memory-mcp`: the two packages
 * publish independently, and a shared third package would add a release
 * artifact to maintain for this much stable plumbing.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
  type SkillResourceBase,
} from '@deepseek-ai/dsh-skill'

/** Provider name registered on `ctx.skills`. */
export const SKILLS_PROVIDER = 'memory-auto-skills'

/** Shipped skill directories, relative to the package root. */
const SKILL_NAMES = ['checkpoint-auto'] as const

const SKILLS_ROOT = new URL('../skills/', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

interface Frontmatter {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

function skillUrl(name: string): URL {
  return new URL(`${name}/SKILL.md`, SKILLS_ROOT)
}

function resourceBase(name: string): SkillResourceBase {
  return { kind: 'directory', path: fileURLToPath(new URL(`${name}/`, SKILLS_ROOT)) }
}

/** Split YAML frontmatter from the body, mirroring the harness filesystem provider. */
function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) throw new Error('SKILL.md has no YAML frontmatter')
  const parsed: unknown = parseYaml(match[1])
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('SKILL.md frontmatter must be a YAML mapping')
  }
  return { data: parsed as Record<string, unknown>, body: raw.slice(match[0].length).trim() }
}

function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one shipped skill, rejecting a file whose frontmatter disagrees with its directory. */
async function loadSkill(name: string): Promise<{ frontmatter: Frontmatter; body: string }> {
  const { data, body } = splitFrontmatter(await readFile(skillUrl(name), 'utf8'))
  const declared = textField(data, 'name')
  if (declared !== name) {
    throw new Error(`skills/${name}/SKILL.md declares name "${declared ?? '(none)'}"`)
  }
  const description = textField(data, 'description')
  if (description === undefined) throw new Error(`skills/${name}/SKILL.md has no description`)
  const whenToUse = textField(data, 'whenToUse')
  return {
    frontmatter: { name, description, ...whenToUse === undefined ? {} : { whenToUse } },
    body,
  }
}

/** Skills shipped as packaged Markdown assets. */
export const skillsProvider: SkillProvider = {
  name: SKILLS_PROVIDER,

  async list(): Promise<readonly SkillCandidate[]> {
    return await Promise.all(SKILL_NAMES.map(async (name) => {
      const { frontmatter } = await loadSkill(name)
      return {
        ...frontmatter,
        path: fileURLToPath(skillUrl(name)),
        invocation: INVOCATION,
        source: 'bundled',
        provider: SKILLS_PROVIDER,
        resourceBase: resourceBase(name),
        rank: BUNDLED_SKILL_RANK,
        locator: skillUrl(name),
      }
    }))
  },

  async get(candidate): Promise<SkillDefinition> {
    const { frontmatter, body } = await loadSkill(candidate.name)
    return {
      ...frontmatter,
      path: fileURLToPath(skillUrl(candidate.name)),
      invocation: INVOCATION,
      source: 'bundled',
      provider: SKILLS_PROVIDER,
      resourceBase: resourceBase(candidate.name),
      content: body,
    }
  },
}
