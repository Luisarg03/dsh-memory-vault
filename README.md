# dsh-memory-vault

Persistent OKF memory for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (DSH):
a Python MCP server (SQLite FTS5 + Markdown), two Cordis plugins (`memory-mcp`, `memory-auto`)
and a vault starter with templates and a type registry.

![Stack architecture](docs/diagrams/stack.png)

![Session digest pipeline](docs/diagrams/session-digest.png)

## Components

| Component | What it does | Bundle |
|---|---|---|
| `memory-mcp` | MCP stdio wrapper: connects DSH to the memory vault server | `@dsh-memory/memory-mcp` |
| `memory-auto` | Auto memory capture: session digest with commit/compaction checkpoints | `@dsh-memory/memory-auto` |
| `memory-vault-server/` | Python MCP server: SQLite FTS5 + Markdown OKF | — |
| `memory-vault/` | Vault starter: templates + type registry + tag vocabulary | — |
| `scripts/digest_session.py` | Post-session digest: transcript → OKF entries via an LLM CLI | — |

## Quickstart

```sh
pnpm install
pnpm -r build

# local dev with an overlay (paths relative to the repo cwd)
dsh web --patch ./examples/dev-memory.cordis.yml
```

## Install into a profile

```sh
# local checkout
dsh plugin --profile demo add ./packages/memory-mcp
dsh plugin --profile demo add ./packages/memory-auto

# tarball
pnpm --filter @dsh-memory/memory-mcp pack
pnpm --filter @dsh-memory/memory-auto pack
dsh plugin --profile demo add ./dsh-memory-memory-mcp-0.1.0.tgz ./dsh-memory-memory-auto-0.1.0.tgz

# npm (recommended for distribution — pnpm does not support subdirectories in git
# specs, so the subpackages of this monorepo cannot be installed directly from GitHub:
# https://github.com/pnpm/pnpm/pull/7487)
#   npm publish in packages/memory-mcp and packages/memory-auto, then:
dsh plugin --profile demo add @dsh-memory/memory-mcp @dsh-memory/memory-auto
# ⚠️ `add github:Luisarg03/dsh-memory-vault` installs the repo root, which declares no
# `dsh.bundle` — it stays a plain dependency and never activates as a profile layer.

# verify the composed layer
dsh --profile demo --dump-config | grep -A2 memory
```

## Memory stack

The plugins work on an OKF vault (`memory-vault/` in this repo, or your own).
Requirements: `uv` installed; the digest (`scripts/digest_session.py`) delegates
LLM extraction to the `opencode` CLI (no credentials stored by the plugin).

Paths are resolved through **environment variables** (no hardcoded paths):

| Env var | Used for | Default |
|---|---|---|
| `DSH_MEMORY_PATH` | vault directory | `./memory-vault` |
| `DSH_MEMORY_SERVER_DIR` | directory with `server.py` (MCP server) | `./memory-vault-server` |
| `DSH_DIGEST_SCRIPT` | digest script path | `./scripts/digest_session.py` |
| `DSH_DIGEST_LOG` | digest spawn log | `<tmpdir>/dsh-digest-spawn.log` |

```sh
# run the MCP server standalone:
MEMORY_PATH=./memory-vault uv run --directory ./memory-vault-server python server.py
```

### Vault

`memory-vault/` is an OKF bundle: `templates/` (per-type templates),
`type-registry.yaml` (source of truth for types), `tag-vocabulary.json`
(tag normalization). Runtime data (`projects/`, `raw/`, `logs/`, `memory.db`)
is created by the server on first use and excluded from git (`.gitignore`).

## Architecture & diagrams

Interactive versions of the diagrams (standalone HTML, open in any browser):

- [stack.html](docs/diagrams/stack.html) — architecture
- [session-digest.html](docs/diagrams/session-digest.html) — dataflow
- [mcp-tool-call.html](docs/diagrams/mcp-tool-call.html) — sequence
- [capture-lifecycle.html](docs/diagrams/capture-lifecycle.html) — lifecycle

Editable specs live in `docs/diagrams/*.json` (generated with
[archify](https://github.com/tt-a1i/archify)). Full write-up:
[`docs/architecture.md`](docs/architecture.md); index: [`docs/README.md`](docs/README.md).

## Repository layout

```
packages/memory-mcp/          # cordis bundle: MCP stdio client to the vault
packages/memory-auto/         # cordis bundle: automatic session digest
memory-vault-server/          # Python MCP server (SQLite + Markdown OKF)
memory-vault/                 # vault starter (templates + type registry)
scripts/digest_session.py     # post-session digest (LLM via opencode CLI)
examples/dev-memory.cordis.yml      # memory-mcp
examples/dev-memory-auto.cordis.yml # memory-mcp + memory-auto
```

## Layer order

1. `dsh.profile.bundles` (base + every installed bundle)
2. `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. `--patch` overlays

Patch replaces `config` wholesale — it does not merge.

## Troubleshooting pnpm

- `unable to open database file` → the pnpm store is not writable in a sandboxed
  environment. Use `--store-dir ./.pnpm-store` on every `pnpm install` and on
  `dsh plugin --profile X --store-dir ./.pnpm-store add ...`.
- `dsh: pnpm failed` when installing from GitHub → only applies to packages with
  a `prepare` script; copy the printed key into the profile's
  `pnpm-workspace.yaml` (allowBuilds). Note: the subpackages of this monorepo
  cannot be installed with `github:...` (pnpm has no git-subdirectory support) —
  use npm or a tarball.

## Docs

- [`docs/`](docs/README.md) — public documentation (architecture + diagrams)
- [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
- [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config)
- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
