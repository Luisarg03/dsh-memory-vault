# Architecture

`dsh-memory-vault` is a persistent OKF memory stack for
[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (DSH).
Everything installs through the standard plugin flow: each Cordis bundle
declares a `dsh.bundle` manifest and mounts with
`dsh plugin --profile <name> add <package>`.

## Component overview

![Stack architecture](diagrams/stack.png?v=2)
<sub>[Interactive version](diagrams/stack.html)</sub>

```
DeepSeek Harness (web / headless)  ← plugins and services in the profile process
├── memory-mcp        @dsh-memory/memory-mcp   MCP stdio client (spawns the server via uv)
├── memory-auto       @dsh-memory/memory-auto  session hooks + in-process digest
├── ctx.llm           dsh-llm service          provider deepseek-official → DeepSeek API
│        │ store_* via MCP stdio
│        ▼
└── memory-vault-server        Python MCP server · 10 tools (spawned via uv run)
         │ SQLite FTS5 + Markdown
         ▼
    memory-vault                OKF bundle: templates · type-registry · tag-vocabulary
```

- **DSH** is the host: it loads the two bundles as Cordis plugins and exposes
  the vault to the agent as MCP tools.
- **memory-mcp** mounts `@deepseek-ai/dsh-mcp-client` pointed at the vault
  server over stdio (JSON-RPC). Tool calls reach the server, which reads and
  writes the vault.
- **memory-auto** watches the session event stream and triggers checkpoints
  (idle, git commit, compaction, session end). The post-session digest runs
  **in-process**: extraction uses the harness's own LLM service
  (`ctx.llm.stream`, provider/model configurable, `deepseek-official` by
  default — the same credentials DSH is configured with), and the resulting
  OKF entries are written through the vault server's `store_*` tools over
  stdio. No external CLI and no stored credentials.
- **memory-vault-server** (`memory-vault-server/`) is a Python MCP server:
  SQLite (WAL + FTS5) as a derived search index over Markdown OKF files, which
  remain the source of truth. It exposes 10 tools: `search_memory`,
  `store_decision`, `store_fact`, `store_learning`, `store_convention`,
  `store_profile`, `store_source`, `export_memories`, `get_profile`, `ping`.
- **memory-vault** (`memory-vault/`) is the starter bundle: OKF templates per
  entry type, `type-registry.yaml` (source of truth for types) and
  `tag-vocabulary.json` (tag normalization). Runtime data (`projects/`,
  `raw/`, `logs/`, `memory.db`) is created on first use and excluded from git.

## Session digest pipeline

![Session digest pipeline](diagrams/session-digest.png?v=2)
<sub>[Interactive version](diagrams/session-digest.html)</sub>

Session events are captured by `memory-auto` at checkpoints. When the gate
passes (activity recorded and transcript ≥ `minTranscriptChars`), the plugin
extracts entries **in-process**: it streams the extraction prompt through
`ctx.llm` (the harness's own LLM service, provider/model configurable,
`deepseek-official` by default), repairs and validates the JSON result, and
writes the entries through the vault server's `store_*` tools over MCP stdio —
the same write path the agent's checkpoint flow uses, keeping Markdown and the
SQLite FTS5 index in sync. Retries are bounded; a failed digest is logged and
never takes the agent down.

## MCP tool call

![MCP tool call](diagrams/mcp-tool-call.png?v=2)
<sub>[Interactive version](diagrams/mcp-tool-call.html)</sub>

The agent issues `tools/call`; `memory-mcp` forwards JSON-RPC over stdio to
`memory-vault-server` (spawned with `uv run`), which queries the store and
returns the tool result. The server runs as a separate process: a server crash
never takes the agent down.

## Per-session capture lifecycle

![Capture lifecycle](diagrams/capture-lifecycle.png?v=2)
<sub>[Interactive version](diagrams/capture-lifecycle.html)</sub>

Sessions are registered on creation; the capture rail runs
`created → active → gate → checkpoint → queued → digested`. The gate only
digests when there is recorded activity and a transcript above the minimum.
A failed digest is retried without losing the queue; the session keeps running
in the meantime. On session end the plugin flushes a post-session digest
(dispose path).

## Configuration

All paths are environment-driven, never hardcoded:

| Variable | Used by | Default |
|---|---|---|
| `DSH_MEMORY_PATH` | server (`MEMORY_PATH`), memory-auto | `./memory-vault` |
| `DSH_MEMORY_SERVER_DIR` | memory-mcp and memory-auto (server directory) | `./memory-vault-server` |

Plugin-level config (patch layer): `provider` (`deepseek-official`),
`model` (`deepseek-v4-flash`), `maxTokens`, `minTranscriptChars`, `enabled`.

Requires `uv` on PATH (the server and the plugins run it via `uv run`).

## Layer order

1. `dsh.profile.bundles` (base + each installed bundle)
2. `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. `--patch` overlays

Patch replaces `config` wholesale — it does not merge.
