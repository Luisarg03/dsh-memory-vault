# @dsh-memory/memory-mcp

Cordis bundle that connects [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)
(DSH) to a persistent OKF memory vault over the Model Context Protocol.

It mounts `@deepseek-ai/dsh-mcp-client` configured for the vault's Python MCP
server (`memory-vault-server` in this repository) over stdio, exposing the
vault's tools (`search_memory`, `store_*`, `export_memories`, `get_profile`,
`ping`) to the agent.

## Install

```sh
dsh plugin --profile web add @dsh-memory/memory-mcp
```

Requires `uv` on PATH — the plugin spawns the server with `uv run`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DSH_MEMORY_SERVER_DIR` | directory containing `server.py` | `$DSH_HOME/memory-vault-server` |
| `DSH_MEMORY_PATH` | vault directory (forwarded to the server as `MEMORY_PATH`) | `$DSH_HOME/memory-vault` |

The bundle ships no cwd-dependent paths: the `cordis.patch.yml` layer resolves both
values from the environment, falling back to the harness home (`$DSH_HOME`, or
`~/.dsh`) — DSH does not chdir, so launching from any directory works.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

The bundle manifest (`dsh.bundle`) makes this package installable through the
standard `dsh plugin add` flow; the patch layer lives in `cordis.patch.yml`.
