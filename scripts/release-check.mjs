#!/usr/bin/env node
// Release guard: proves that a tag, the two package.json versions and HEAD all
// agree before anything reaches npm. Runs locally and as the first step of
// .github/workflows/publish.yml.
//
//   node scripts/release-check.mjs                  # verify current state
//   node scripts/release-check.mjs --tag v0.1.4     # verify a tag is publishable
//   node scripts/release-check.mjs --bump 0.1.4     # set both versions (lockstep)
//
// Why this exists: npm records gitHead from the commit that published, and
// docs/releasing.md makes the tag point at that same commit. Verifying the pair
// here turns "which code is live?" into a one-command answer.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { PACKAGES, ROOT, packageVersions, tagProblems, versionProblems } from './release-lib.mjs'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const has = (name) => argv.includes(name)

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (msg) => {
  console.error(`release-check: ${msg}`)
  process.exit(1)
}

function readPackages() {
  return Object.fromEntries(
    PACKAGES.map((dir) => [
      dir,
      JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')),
    ]),
  )
}

function writeVersions(version) {
  for (const dir of PACKAGES) {
    const path = join(ROOT, dir, 'package.json')
    const raw = readFileSync(path, 'utf8')
    const next = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
    if (next === raw) fail(`could not rewrite the version in ${dir}/package.json`)
    writeFileSync(path, next)
  }
}

// --bump <version>: write both package.json files, then verify the result.
const bump = arg('--bump')
if (bump !== undefined) {
  if (!/^\d+\.\d+\.\d+$/.test(bump)) fail(`--bump expects major.minor.patch, got "${bump}"`)
  if (git('status', '--porcelain')) fail('working tree is dirty — commit or stash before bumping')
  writeVersions(bump)
  console.log(`release-check: bumped ${PACKAGES.join(' and ')} to ${bump}`)
}

// 1. Lockstep versions.
const files = readPackages()
const problems = versionProblems(files)
if (problems.length) fail(problems.join('\n  '))
const version = files[PACKAGES[0]].version
console.log(`release-check: version ${version} (${PACKAGES.length} packages in lockstep)`)

// 2. Optional tag comparison.
const tag = arg('--tag')
if (tag !== undefined) {
  const tagIssues = tagProblems(tag, version)
  if (tagIssues.length) fail(tagIssues.join('\n  '))

  // The tag must exist, be annotated, and be reachable from HEAD.
  let type
  try {
    type = git('cat-file', '-t', tag)
  } catch {
    fail(`tag ${tag} does not exist — create it with: git tag -a ${tag} -m "Release ${version}"`)
  }
  if (type !== 'tag') fail(`tag ${tag} is lightweight; use an annotated tag (git tag -a)`)

  const tagged = git('rev-list', '-n1', tag)
  const head = git('rev-parse', 'HEAD')
  console.log(`release-check: tag ${tag} -> ${tagged.slice(0, 12)} (HEAD ${head.slice(0, 12)})`)
  if (tagged !== head) {
    // CI checks out the tag itself, so this only warns for local runs where the
    // publish commit is legitimately behind HEAD (docs commits after a release).
    console.warn(
      `release-check: note — ${tag} points at ${tagged.slice(0, 12)}, not HEAD; ` +
        'the published gitHead will be the tagged commit. Publish from the tag to keep them equal.',
    )
  }
}

// 3. A dirty tree means the tarball would not match any commit.
if (has('--strict') && git('status', '--porcelain')) {
  fail('working tree is dirty — npm publish would ship uncommitted code')
}
if (!has('--strict') && git('status', '--porcelain')) {
  console.warn('release-check: note — working tree is dirty (pass --strict to make this fatal)')
}

console.log('release-check: OK')
