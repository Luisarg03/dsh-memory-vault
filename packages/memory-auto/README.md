# @dsh-memory/memory-auto

Cordis bundle that auto-captures session memory for
[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (DSH):
it watches sessions and digests transcripts into an OKF vault at checkpoints —
idle, git commit, compaction, and session end.

The digest runs **in-process**: extraction uses the harness's own LLM service
(`ctx.llm.stream`, provider/model configurable, `deepseek-official` by
default), and the resulting OKF entries are written through the vault's MCP
server (`store_*` tools over stdio), keeping the Markdown source of truth and
the SQLite FTS5 index in sync. No external CLI and no stored credentials — the
plugin uses the same key DSH is configured with.

## Install

```sh
dsh plugin --profile web add @dsh-memory/memory-auto
```

Requires `uv` on PATH (the vault server is spawned with `uv run`) and the
vault server directory (`memory-vault-server` in this repository).

## Configuration

| Field | Purpose | Default |
|---|---|---|
| `memoryPath` | vault directory | `$DSH_MEMORY_PATH` or `$DSH_HOME/memory-vault` |
| `serverDir` | directory containing the vault `server.py` | `$DSH_MEMORY_SERVER_DIR` or `$DSH_HOME/memory-vault-server` |
| `provider` | LLM provider route (harness registry) | `deepseek-official` |
| `model` | LLM model id | `deepseek-v4-flash` |
| `maxTokens` | extraction output cap | `2048` |
| `minTranscriptChars` | minimum transcript size to digest | `200` |
| `enabled` | master switch | `true` |

Environment variables used at load time: `DSH_MEMORY_PATH`,
`DSH_MEMORY_SERVER_DIR`.

## Behavior

- `session.created` — registers the session (project name resolution).
- `session.disposed` / dispose path — post-session digest of the transcript.
- `agent/status` idle — auto-capture gate: skips sessions without activity or
  with a checkpoint already delivered.
- `tool.execute.after`-style event tracking — detects `git commit*` and queues
  a commit checkpoint prompt for the running agent.
- `experimental.session.compacting` — pre-compaction capture (always fires when
  there is activity).
- `agent/pre-step` — delivers queued checkpoint prompts (the agent writes
  entries with the `store_*` MCP tools).

Extraction failures are retried with bounded backoff and logged; a failed
digest never takes the agent down.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

The bundle manifest (`dsh.bundle`) makes this package installable through the
standard `dsh plugin add` flow; the patch layer lives in `cordis.patch.yml`.
