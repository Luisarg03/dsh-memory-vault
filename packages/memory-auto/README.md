# @luisarg/memory-auto

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
dsh plugin --profile web add @luisarg/memory-auto
```

Requires the vault server directory (`memory-vault-server` in this repository) and either `uv`
on PATH or Python ≥3.11: the bundled `launcher.mjs` runs the server with `uv run` and falls back
to a pip-managed venv (`python3 -m venv` + `pip install -r requirements.txt`) when uv is missing.

## Skills

The package ships one skill, registered as a **bundled** provider (rank 600, the weakest in DSH's
local discovery table — a same-named skill in a user or project root still wins):

| Command | Source | What it does |
|---|---|---|
| `/checkpoint-auto` | `skills/checkpoint-auto/SKILL.md` | Explains and steers the automatic capture: the git-commit, compaction, idle and session-end triggers, what an injected `[memory-checkpoint]` prompt means, and the `provider` / `model` / `maxTokens` / `minTranscriptChars` / `enabled` knobs |

It deliberately does **not** restate the entry vocabulary: that lives in `packages/memory-mcp`'s
`checkpoint` skill and in `src/pure.ts`, which builds the injected prompt so it keeps working with
no skill loaded. Registration happens before the `enabled` gate — the skill is how a session
learns that capture is off and how to turn it back on.

## Configuration

| Field | Purpose | Default |
|---|---|---|
| `memoryPath` | vault directory | `$DSH_MEMORY_PATH` or `~/.memories` |
| `serverDir` | directory containing the vault `server.py` | `$DSH_MEMORY_SERVER_DIR` or `$DSH_HOME/memory-vault-server` |
| `provider` | LLM provider route (harness registry) | `deepseek-official` |
| `model` | LLM model id | `deepseek-v4-flash` |
| `maxTokens` | extraction output cap | `2048` |
| `minTranscriptChars` | minimum transcript size to digest | `200` |
| `enabled` | master switch | `true` |

Environment variables used at load time: `DSH_MEMORY_PATH`,
`DSH_MEMORY_SERVER_DIR`.

## Behavior

- `session/created` — registers the session and resolves the project name
  (`openspec/` present → directory basename; else `package.json` name; else
  `pyproject.toml` `[project].name`; else first `#` heading of `README.md`;
  else directory basename).
- `session/disposed` — digests the transcript, skipping sessions with no
  activity. A dispose-time `ctx.effect` batch-digests any session still
  pending, using the tracked activity summary as a stand-in transcript.
- `agent/status` with status `idle` — runs the auto-capture gate
  (`idleCheckpoint`): skips sessions without activity or already delivered, and
  on the first idle of a session also digests the tracked activity summary.
- `session/event` — tracks activity and queues checkpoints:
  - `tool/call` (also accepted as `tool_call`) whose `args.command` matches
    `git commit` queues a commit checkpoint.
  - `compaction/start` queues a pre-compaction checkpoint (fires whenever there
    is activity, even if one was already delivered).
  - `user/message` and `assistant/message` are recorded as tracked activity.
- `agent/pre-step` — delivers the queued checkpoint by pushing it onto
  `payload.context` (or `payload.messages`), and the agent writes entries with
  the `store_*` MCP tools.

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
