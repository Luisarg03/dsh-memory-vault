# @luisarg/memory-mcp

Cordis bundle that connects [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)
(DSH) to a persistent OKF memory vault over the Model Context Protocol.

It mounts `@deepseek-ai/dsh-mcp-client` configured for the vault's Python MCP
server (`memory-vault-server` in this repository) over stdio, exposing the
vault's tools (`search_memory`, `store_*`, `export_memories`, `get_profile`,
`ping`) to the agent.

## Install

```sh
dsh plugin --profile web add @luisarg/memory-mcp
```

`uv` on PATH is recommended but not required: the bundled `launcher.mjs` runs the server with
`uv run` when uv is present and falls back to a pip-managed venv (`python3 -m venv` +
`pip install -r requirements.txt`, network on first boot) when it is not.

## Skills

The package also ships the two skills that drive its tools, so installing it is enough to get the
commands — nothing has to be copied into a skill directory:

| Command | Source | What it does |
|---|---|---|
| `/brain` | `skills/brain/SKILL.md` | Reads the vault: topic search, recall by project, the profile, full exports — including the tool traps (`entry_type=profile` in `search_memory` always returns 0; `tags` are OR-matched; searches cap at 50) |
| `/checkpoint` | `skills/checkpoint/SKILL.md` | Captures the session as `decision`/`fact`/`learning`/`convention` entries, then commits the vault |

They register at DSH's **bundled** rank (600), the weakest in the local discovery table, so a
skill of the same name in a user or project root still wins. Each `SKILL.md` is the single source
of its own name, description and usage guidance: the provider parses its frontmatter with `yaml`,
so the same file also works copied into `~/.agents/skills`. Registration goes through
`ctx.inject(['skills'], …)`, so a deployment with no skill catalog still gets the vault
bootstrap and the MCP client.

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
