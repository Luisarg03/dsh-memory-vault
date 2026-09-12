#!/usr/bin/env node
// Tarball guard: refuses to publish a package whose file list is wrong. The
// published artifact is the security boundary — this is the last check before
// it leaves the machine.
//
//   node scripts/check-tarball.mjs packages/memory-mcp/luisarg-memory-mcp-0.1.4.tgz [more.tgz]
//
// Catches the two real failure modes: the bundling step silently no-op'ing
// (0.1.0 shipped 7 files, no server, no vault) and user data leaking into the
// package (memory.db, projects/, logs/).
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { tarballProblems } from './release-lib.mjs'

const tarballs = process.argv.slice(2)
if (tarballs.length === 0) {
  console.error('check-tarball: pass at least one .tgz path')
  process.exit(1)
}

let failed = false
for (const path of tarballs) {
  if (!existsSync(path)) {
    console.error(`check-tarball: ${path} does not exist`)
    failed = true
    continue
  }
  const listing = execFileSync('tar', ['-tzf', resolve(path)], { encoding: 'utf8' })
  const files = listing.split('\n').filter((line) => line && !line.endsWith('/'))
  const problems = tarballProblems(files)
  const size = (statSync(path).size / 1024).toFixed(1)

  if (problems.length) {
    failed = true
    console.error(`check-tarball: ${path} FAILED`)
    for (const p of problems) console.error(`  - ${p}`)
  } else {
    console.log(`check-tarball: ${path} OK — ${files.length} files, ${size} KB`)
  }
}

process.exit(failed ? 1 : 0)
