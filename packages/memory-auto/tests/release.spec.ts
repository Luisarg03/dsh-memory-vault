// Tests for the release guardrails. If these break, the publish workflow is
// lying about what it verified — so they run in CI on every push.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PACKAGES,
  REQUIRED_TARBALL_FILES,
  ROOT,
  packageVersions,
  remoteTagIsAnnotated,
  tagProblems,
  tarballProblems,
  versionProblems,
} from '../../../scripts/release-lib.mjs'

const run = (args, opts = {}) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', ...opts }),
    }
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

const RELEASE_CHECK = join(ROOT, 'scripts', 'release-check.mjs')

describe('version lockstep', () => {
  it('accepts two packages on the same version', () => {
    expect(versionProblems({ a: { version: '1.2.3' }, b: { version: '1.2.3' } })).toEqual([])
  })

  it('rejects packages that drifted apart', () => {
    const problems = versionProblems({ 'packages/a': { version: '1.2.3' }, 'packages/b': { version: '1.2.4' } })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('lockstep')
  })

  it('rejects a missing version', () => {
    expect(versionProblems({ a: {} })[0]).toContain('no version')
  })

  it('holds for the real tree', () => {
    const versions = packageVersions()
    expect(versions.map(([, v]) => v)).toEqual([versions[0][1], versions[0][1]])
    expect(versions[0][1]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('tag matching', () => {
  it('accepts the matching tag', () => {
    expect(tagProblems('v1.2.3', '1.2.3')).toEqual([])
  })

  it('rejects a tag for another version', () => {
    expect(tagProblems('v1.2.4', '1.2.3')[0]).toContain('!= package.json version')
  })

  it('rejects a tag outside the v<semver> scheme', () => {
    expect(tagProblems('release-1.2.3', '1.2.3')[0]).toContain('scheme')
    expect(tagProblems(undefined, '1.2.3')[0]).toContain('scheme')
  })
})

describe('tarball contents', () => {
  const good = [...REQUIRED_TARBALL_FILES, ...Array.from({ length: 20 }, (_, i) => `package/vault/templates/t${i}.md`)]

  it('accepts a well-formed tarball', () => {
    expect(tarballProblems(good)).toEqual([])
  })

  it('rejects a bundle that lost the server (the 0.1.0 failure)', () => {
    const problems = tarballProblems(good.filter((f) => !f.startsWith('package/server/')))
    expect(problems.some((p) => p.includes('missing required file'))).toBe(true)
  })

  it('rejects vault data leaking into the package', () => {
    for (const leak of ['package/projects/x/decisions/a.md', 'package/memory.db', 'package/logs/x.log']) {
      expect(tarballProblems([...good, leak]).some((p) => p.includes('forbidden'))).toBe(true)
    }
  })

  it('rejects build residue', () => {
    for (const junk of ['package/server/__pycache__/x.pyc', 'package/server/.venv/bin/python']) {
      expect(tarballProblems([...good, junk]).some((p) => p.includes('forbidden'))).toBe(true)
    }
  })

  it('is not fooled by a file that merely mentions node_modules', () => {
    expect(tarballProblems([...good, 'package/dist/node_modules.js'])).toEqual([])
  })

  it('rejects a suspiciously small tarball', () => {
    expect(tarballProblems(REQUIRED_TARBALL_FILES).some((p) => p.includes('expected >= 20'))).toBe(true)
  })
})

describe('release-check CLI', () => {
  it('passes on the current tree', () => {
    const result = run([RELEASE_CHECK])
    expect(result.stdout).toContain('release-check: OK')
  })

  it('fails when the tag does not match the version', () => {
    const result = run([RELEASE_CHECK, '--tag', 'v9.9.9'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('!= package.json version')
  })

  it('fails on a tag that is not in this repository', () => {
    const result = run([RELEASE_CHECK, '--tag', 'v0.1.903'])
    expect(result.status).toBe(1)
    // Names the offending tag, whichever check rejected it first, and never
    // claims success on stderr.
    expect(result.stderr).toContain('v0.1.903')
    expect(result.stdout).not.toContain('release-check: OK')
  })

  it('reports one clear reason on a version mismatch', () => {
    const result = run([RELEASE_CHECK, '--tag', 'v0.1.1003'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('!= package.json version')
    expect(result.stdout).not.toContain('release-check: OK')
  })

  it('rejects a malformed --bump argument before writing anything', () => {
    const result = run([RELEASE_CHECK, '--bump', 'not-a-version'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('major.minor.patch')
  })
})

describe('bundle-assets call sites', () => {
  // Regression guard for the race CI caught: bundle-assets.mjs does
  // rmSync+cpSync on the same two target directories, so two concurrent
  // invocations (one per package `prepare`) produced
  // "ENOENT: chmod .../server" and "ENOTEMPTY". The fix was to call it once
  // from the root build instead of from both packages. This asserts the single
  // call site — the part that actually keeps the race from happening — and that
  // the script still serializes if something calls it twice (the lock).
  it('is invoked only by the root build, not by each package', () => {
    const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
    // The root build is the single call site, through its own `bundle` script.
    expect(rootScripts.build).toContain('pnpm bundle')
    expect(rootScripts.bundle).toContain('bundle-assets.mjs')

    for (const pkg of PACKAGES) {
      const scripts = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')).scripts
      expect(scripts.prepare ?? '', `${pkg} prepare must not bundle`).not.toContain('bundle-assets')
      for (const [name, cmd] of Object.entries(scripts)) {
        expect(cmd, `${pkg}:${name}`).not.toContain('bundle-assets')
      }
    }
  })
})

describe('annotated tag detection', () => {
  // The guard asks the *remote* whether the tag is annotated, because a shallow
  // CI checkout can hold the tag ref without the annotated tag object. This
  // covers both answers without touching the real repository.
  const bare = join(tmpdir(), `memtag-remote-${process.pid}.git`)
  const work = join(tmpdir(), `memtag-work-${process.pid}`)
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  // A CI runner has no git identity, and `git tag -a` insists on one for the
  // tagger. Set it on the fixture repo rather than trusting the environment.
  const IDENT = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid']

  beforeAll(() => {
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '--bare', bare])
    execFileSync('git', ['init', '-q', work])
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
    gitIn(work, 'add', 'package.json')
    gitIn(work, ...IDENT, 'commit', '-qm', 'init')
    gitIn(work, 'remote', 'add', 'origin', bare)
    gitIn(work, 'tag', 'v9.9.9')
    gitIn(work, ...IDENT, 'tag', '-a', 'v9.9.10', '-m', 'annotated')
    gitIn(work, 'push', '-q', 'origin', 'HEAD:main', '--tags')
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('detects an annotated tag on the remote', () => {
    expect(remoteTagIsAnnotated(work, 'v9.9.10', gitIn)).toBe(true)
  })

  it('detects a lightweight tag on the remote', () => {
    expect(remoteTagIsAnnotated(work, 'v9.9.9', gitIn)).toBe(false)
  })

  it('returns null when there is no origin to ask', () => {
    expect(remoteTagIsAnnotated(bare, 'v9.9.10', gitIn)).toBeNull()
  })
})

describe('workflow wiring', () => {
  it('publishes on version tags from a pinned workflow', () => {
    const publish = join(ROOT, '.github', 'workflows', 'publish.yml')
    expect(existsSync(publish)).toBe(true)
    const text = execFileSync('cat', [publish], { encoding: 'utf8' })
    expect(text).toContain('- "v*"')
    expect(text).toContain('id-token: write')
    expect(text).toContain('scripts/release-check.mjs')
    expect(text).toContain('scripts/check-tarball.mjs')
    // `pnpm -r build` does NOT run the root build, so the bundling step must be
    // explicit. Without it the tarballs ship 8 files and no server — which the
    // tarball guard then catches, after a wasted run.
    expect(text).toContain('pnpm bundle')
    // Every action must be pinned to a 40-char SHA, never a moving tag.
    for (const line of text.split('\n').filter((l) => l.includes('uses:'))) {
      expect(line).toMatch(/uses:\s+\S+@[0-9a-f]{40}/)
    }
  })

  it('keeps every workflow action pinned and least-privilege', () => {
    for (const file of ['ci.yml', 'publish.yml', 'security.yml']) {
      const text = execFileSync('cat', [join(ROOT, '.github', 'workflows', file)], { encoding: 'utf8' })
      expect(text).toMatch(/^permissions:/m)
      for (const line of text.split('\n').filter((l) => l.includes('uses:'))) {
        expect(line, `${file}: ${line}`).toMatch(/uses:\s+\S+@[0-9a-f]{40}/)
      }
    }
  })
})
