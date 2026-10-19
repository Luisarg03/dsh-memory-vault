// opencode plugin: registers the memory vault MCP server and its skills through
// the `config` hook, so users never hand-edit opencode.json (whose mcp entries
// need the `environment` key and a shell-free argv array) or copy skills into
// ~/.config/opencode/skills/ by hand.
//
// The hook runs on the resolved config: the mcp entry is injected only when the
// user has not declared a `memory-server` of their own (theirs wins), and the
// skills directory is appended once.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMcpEntry, loadSpec, SERVER_NAME } from './lib.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PKG_DIR, 'skills')

export const MemoryOpenCode = async () => ({
  config: async (input) => {
    input.mcp = input.mcp ?? {}
    if (!(SERVER_NAME in input.mcp)) {
      input.mcp[SERVER_NAME] = buildMcpEntry(loadSpec(PKG_DIR), { serverDir: join(PKG_DIR, 'server') })
    }
    // `skills` is an array of paths in the declarative config, but other
    // plugins (ponytail, superpowers) may have already rewritten it to the
    // resolved { paths: [...] } shape — accept both.
    const skills = input.skills
    if (!skills) input.skills = [SKILLS_DIR]
    else if (Array.isArray(skills)) {
      if (!skills.includes(SKILLS_DIR)) skills.push(SKILLS_DIR)
    } else if (Array.isArray(skills.paths)) {
      if (!skills.paths.includes(SKILLS_DIR)) skills.paths.push(SKILLS_DIR)
    }
  },
})
