# dsh-memory-vault — Documentation

Public documentation for the [dsh-memory-vault](https://github.com/Luisarg03/dsh-memory-vault)
stack: persistent OKF memory for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).

## Architecture

- [architecture.md](architecture.md) — component overview with interactive diagrams
- Diagrams (standalone HTML, open in any browser):
  - [stack](diagrams/stack.html) — full component map: DSH, plugins, server, vault
  - [session-digest](diagrams/session-digest.html) — dataflow of the session digest pipeline
  - [mcp-tool-call](diagrams/mcp-tool-call.html) — sequence of an MCP tool call
  - [capture-lifecycle](diagrams/capture-lifecycle.html) — lifecycle of per-session memory capture

## Components

| Component | What it does | Docs |
|---|---|---|
| `@luisarg/memory-mcp` | Cordis bundle: MCP stdio client that connects DSH to the vault server | [packages/memory-mcp/README.md](../packages/memory-mcp/README.md) |
| `@luisarg/memory-auto` | Cordis bundle: auto-captures session memory at idle/commit/compaction/end checkpoints | [packages/memory-auto/README.md](../packages/memory-auto/README.md) |
| `memory-vault-server/` | Python MCP server: SQLite FTS5 + Markdown OKF | [architecture.md](architecture.md#memory-vault-server) |
| `memory-vault/` | Starter vault: OKF templates + type registry + tag vocabulary | [memory-vault/README.md](../memory-vault/README.md) |
| `scripts/digest_session.py` | Optional standalone digest CLI (not used by the plugins) | — |

## Design notes

- Paths are env-driven, never hardcoded: `DSH_MEMORY_PATH`, `DSH_MEMORY_SERVER_DIR`,
  `DSH_DIGEST_SCRIPT` (defaults in [README.md](../README.md#memory-stack)).
- Markdown files under `memory-vault/projects/` are the source of truth; SQLite is a
  derived, rebuildable search index.
- Everything installs through the standard `dsh plugin --profile <name> add <pkg>` flow
  via the `dsh.bundle` manifest in each package.
