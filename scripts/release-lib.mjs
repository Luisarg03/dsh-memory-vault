// Pure helpers shared by scripts/release-check.mjs and its unit test.
// No I/O here: everything takes data in and returns data out.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor to the repo root (this script lives in <root>/scripts), not the cwd.
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The packages published to npm. Kept in lockstep: same version, one tag. */
export const PACKAGES = [
  'packages/memory-mcp',
  'packages/memory-auto',
  'packages/memory-pi',
  'packages/memory-opencode',
]

/** The DSH packages ship a build (dist/) plus the vault starter. */
const DSH_PACKAGES = new Set(['packages/memory-mcp', 'packages/memory-auto'])

/** Matches the tag scheme used by the repo: v<semver>. */
export const TAG_RE = /^v(\d+\.\d+\.\d+)$/

export function readVersion(dir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
  return pkg.version
}

export function packageVersions() {
  return PACKAGES.map((dir) => [dir, readVersion(dir)])
}

/**
 * Returns a list of human-readable problems; empty means the release is
 * consistent. `files` maps each package path to its package.json contents.
 */
export function versionProblems(files) {
  const problems = []
  const entries = Object.entries(files)
  for (const [dir, pkg] of entries) {
    if (!pkg.version) problems.push(`${dir}/package.json has no version`)
  }
  const unique = [...new Set(entries.map(([, pkg]) => pkg.version))]
  if (unique.length > 1) {
    problems.push(
      `packages are not in lockstep: ${entries.map(([d, p]) => `${d}=${p.version}`).join(', ')}`,
    )
  }
  return problems
}

/** Files every published tarball must contain (the bundled vault server). */
export const REQUIRED_TARBALL_FILES = [
  'package/package.json',
  'package/server/server.py',
  'package/server/store.py',
  'package/server/requirements.txt',
  'package/server/mcp-servers.json',
]

/** Plus: a DSH package's build output, patch and vault starter. */
export const REQUIRED_DSH_FILES = [
  ...REQUIRED_TARBALL_FILES,
  'package/cordis.patch.yml',
  'package/dist/index.js',
  'package/server/launcher.mjs',
  'package/vault/type-registry.yaml',
]

/** Plus: an adapter's skills (bundled with the tool prefix rewritten). */
export const REQUIRED_ADAPTER_FILES = [
  ...REQUIRED_TARBALL_FILES,
  'package/skills/brain/SKILL.md',
  'package/skills/checkpoint/SKILL.md',
  'package/skills/checkpoint-auto/SKILL.md',
]

/** The required file list for one package directory. */
export function requiredFilesFor(dir) {
  return DSH_PACKAGES.has(dir) ? REQUIRED_DSH_FILES : REQUIRED_ADAPTER_FILES
}

/**
 * Maps a packed tarball's file name (`luisarg-memory-pi-0.3.0.tgz`) to the
 * package directory that produced it, or null when the name matches nothing.
 * npm joins the scope with a hyphen: `@luisarg/memory-pi` → `luisarg-memory-pi`.
 */
export function dirForTarballName(fileName) {
  const base = fileName.replace(/^.*\//, '').replace(/\.tgz$/, '')
  const name = base.replace(/-\d+\.\d+\.\d+$/, '')
  for (const dir of PACKAGES) {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    if (pkg.name.replace('@', '').replace('/', '-') === name) return dir
  }
  return null
}

// Anything that must never ship. `node_modules` and `.venv` are matched as path
// segments so a file like `dist/node_modules.js` is not a false positive; the
// vault data dirs are listed because users' memories live under them.
const FORBIDDEN = [
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.env(\.|$|\/)/,
  /\.db(-wal|-shm)?$/,
  /(^|\/)projects(\/|$)/,
  /(^|\/)logs(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /\.log$/,
]

/** Problems with the file list of a packed tarball; empty means publishable. */
export function tarballProblems(files, dir = 'packages/memory-mcp') {
  const problems = []
  const set = new Set(files)
  for (const required of requiredFilesFor(dir)) {
    if (!set.has(required)) problems.push(`missing required file: ${required}`)
  }
  for (const file of files) {
    if (FORBIDDEN.some((re) => re.test(file))) problems.push(`forbidden path in tarball: ${file}`)
  }
  // A tarball far below this means the bundling step silently no-op'd; 0.1.0
  // shipped 7 files that way and nothing caught it. Adapters carry no dist/ or
  // vault starter, so their floor is lower.
  const min = DSH_PACKAGES.has(dir) ? 20 : 12
  if (files.length < min) problems.push(`only ${files.length} files (expected >= ${min})`)
  return problems
}

/** Problems comparing a git tag against the version in package.json. */
export function tagProblems(tag, version) {
  const problems = []
  const m = TAG_RE.exec(tag ?? '')
  if (!m) {
    problems.push(`tag "${tag}" does not match the v<major.minor.patch> scheme`)
    return problems
  }
  if (m[1] !== version) {
    problems.push(`tag ${tag} != package.json version ${version}`)
  }
  return problems
}

/**
 * Is `tag` an annotated tag in the repository at `cwd`'s `origin`? Asks the
 * remote rather than the clone: a shallow CI checkout can hold the tag ref
 * without the annotated tag object, which would look like a lightweight tag and
 * fail a valid release. On a remote, an annotated tag appears twice —
 * `refs/tags/X` and the peeled `refs/tags/X^{}`. Returns null when there is no
 * origin to ask, so callers can fall back to the local object type.
 */
export function remoteTagIsAnnotated(cwd, tag, git) {
  let out
  try {
    out = git(cwd, 'ls-remote', '--tags', 'origin', `refs/tags/${tag}*`)
  } catch {
    return null
  }
  if (!out) return null
  return out.split('\n').some((line) => line.endsWith(`refs/tags/${tag}^{}`))
}
