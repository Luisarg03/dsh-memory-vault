# dsh-memory-vault — Documentation

Public documentation for the [dsh-memory-vault](https://github.com/Luisarg03/dsh-memory-vault)
stack: persistent OKF memory for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).

## Architecture

- [architecture.md](architecture.md) — component overview, the entry surface, and the pipelines
- Diagrams (standalone HTML, open in any browser):
  - [memory-loop](diagrams/memory-loop.html) — one session per lap: recall, work, capture, commit
  - [stack](diagrams/stack.html) — full component map: DSH, plugins, server, vault
  - [session-digest](diagrams/session-digest.html) — dataflow of the session digest pipeline
  - [mcp-tool-call](diagrams/mcp-tool-call.html) — sequence of an MCP tool call
  - [capture-lifecycle](diagrams/capture-lifecycle.html) — lifecycle of per-session memory capture

## Components

| Component | What it does | Docs |
|---|---|---|
| `@luisarg/memory-mcp` | Cordis bundle: MCP stdio client that connects DSH to the vault server, plus the `brain` and `checkpoint` skills | [packages/memory-mcp/README.md](../packages/memory-mcp/README.md) |
| `@luisarg/memory-auto` | Cordis bundle: auto-captures session memory at idle/commit/compaction/end checkpoints, plus the `checkpoint-auto` skill | [packages/memory-auto/README.md](../packages/memory-auto/README.md) |
| `memory-vault-server/` | Python MCP server: SQLite FTS5 + Markdown OKF | [architecture.md](architecture.md#memory-vault-server) |
| `memory-vault/` | Starter vault: OKF templates + type registry + tag vocabulary | [memory-vault/README.md](../memory-vault/README.md) |
| `scripts/digest_session.py` | Optional standalone digest CLI (not used by the plugins) | — |

## Releasing

- [releasing.md](releasing.md) — version tags (`v0.1.0` … `v0.1.5`), the publish procedure, and
  the npm `gitHead` ↔ tag check

## Design notes

- Paths are env-driven, never hardcoded: `DSH_MEMORY_PATH` and `DSH_MEMORY_SERVER_DIR` (defaults
  in [README.md](../README.md#configuration)).
- Markdown files under `memory-vault/projects/` are the source of truth; SQLite is a derived,
  rebuildable search index (`memory-vault-server/rebuild_index.py` rebuilds it from Markdown).
  Profile rows are the exception: they live only in SQLite and are restored by the vault's own
  profile sync script, not by the rebuild.
- The digest runs in-process through `ctx.llm` — no external CLI and no digest-script env var.
- Skills ship inside the packages and register at DSH's **bundled** rank, so a user-level skill
  of the same name always wins. `checkpoint-perfil`, which maintains a personal profile layer,
  is deliberately not shipped.
- Everything installs through the standard `dsh plugin --profile <name> add <pkg>` flow via the
  `dsh.bundle` manifest in each package.
