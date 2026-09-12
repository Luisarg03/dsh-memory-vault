// Pure helpers shared by scripts/release-check.mjs and its unit test.
// No I/O here: everything takes data in and returns data out.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor to the repo root (this script lives in <root>/scripts), not the cwd.
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The packages published to npm. Kept in lockstep: same version, one tag. */
export const PACKAGES = ['packages/memory-mcp', 'packages/memory-auto']

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

/** Paths every published tarball must contain (bundled server + vault starter). */
export const REQUIRED_TARBALL_FILES = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/dist/index.js',
  'package/server/server.py',
  'package/server/store.py',
  'package/server/launcher.mjs',
  'package/server/requirements.txt',
  'package/vault/type-registry.yaml',
]

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
export function tarballProblems(files) {
  const problems = []
  const set = new Set(files)
  for (const required of REQUIRED_TARBALL_FILES) {
    if (!set.has(required)) problems.push(`missing required file: ${required}`)
  }
  for (const file of files) {
    if (FORBIDDEN.some((re) => re.test(file))) problems.push(`forbidden path in tarball: ${file}`)
  }
  // A tarball far below this means the bundling step silently no-op'd; 0.1.0
  // shipped 7 files that way and nothing caught it.
  if (files.length < 20) problems.push(`only ${files.length} files (expected >= 20)`)
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
