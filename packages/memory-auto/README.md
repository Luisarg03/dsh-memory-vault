# @dsh-memory/memory-auto

Cordis bundle that auto-captures session memory for
[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (DSH):
it watches sessions and digests transcripts into an OKF vault at checkpoints —
idle, git commit, compaction, and session end — by spawning a configurable
digest script that delegates LLM extraction to the `opencode` CLI.

## Install

```sh
dsh plugin --profile web add @dsh-memory/memory-auto
```

Requires `uv` on PATH and the `opencode` CLI (the digest delegates LLM
extraction to it; the plugin stores no credentials of its own).

## Configuration

| Field | Purpose | Default |
|---|---|---|
| `memoryPath` | vault directory | `$DSH_MEMORY_PATH` or `./memory-vault` |
| `digestScript` | post-session digest script | `$DSH_DIGEST_SCRIPT` or `./scripts/digest_session.py` |
| `minTranscriptChars` | minimum transcript size to digest | `200` |
| `enabled` | master switch | `true` |

Environment variables used at load time: `DSH_MEMORY_PATH`, `DSH_DIGEST_SCRIPT`,
`DSH_DIGEST_LOG` (spawn log location).

## Behavior

- `session.created` — registers the session (project name resolution).
- `session.idle` — auto-capture gate: skips sessions without activity or with a
  checkpoint already delivered.
- `tool.execute.after` — detects `git commit*` and queues a commit checkpoint.
- `experimental.session.compacting` — pre-compaction capture (always fires when
  there is activity).
- `session.end` — post-session digest (dispose path).

Checkpoint prompts instruct the model to write OKF entries with the `store_*`
MCP tools; if nothing is notable, the digest says so and exits.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

The bundle manifest (`dsh.bundle`) makes this package installable through the
standard `dsh plugin add` flow; the patch layer lives in `cordis.patch.yml`.
