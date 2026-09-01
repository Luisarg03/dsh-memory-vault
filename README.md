# dsh-memory-vault

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh-4D6BFE?logo=deepseek)
![Cordis 4.0.1](https://img.shields.io/badge/Cordis-4.0.1-6C5CE7)
![pnpm 10.15.0](https://img.shields.io/badge/pnpm-10.15.0-F69220?logo=pnpm)
![Node.js ≥22.18](https://img.shields.io/badge/Node.js-%E2%89%A522.18-339933?logo=nodedotjs)
![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)
![Python ≥3.11](https://img.shields.io/badge/Python-%E2%89%A53.11-3776AB?logo=python)
![uv 0.11](https://img.shields.io/badge/uv-0.11-0B0B0F?logo=uv)
![MCP ≥1.2](https://img.shields.io/badge/MCP-%E2%89%A51.2-7C3AED)
![SQLite FTS5](https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite)
![Vitest 3.2](https://img.shields.io/badge/Vitest-3.2-6E9F18?logo=vitest)
![tsdown 0.15](https://img.shields.io/badge/tsdown-0.15-38BDF8)
![oxlint 1.13](https://img.shields.io/badge/oxlint-1.13-FF6B6B)

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
| `scripts/digest_session.py` | Optional standalone post-session digest (CLI, not used by the plugins) | — |

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
Requirement: `uv` installed (the server and the plugins run it via `uv run`).

The post-session digest runs **in-process** through the harness's own LLM
service (`ctx.llm`, provider `deepseek-official` by default — configurable with
`provider`/`model`), so the plugins need no external CLI and store no
credentials: they use the same key DSH is configured with.

Paths are resolved through **environment variables** (no hardcoded paths):

| Env var | Used for | Default |
|---|---|---|
| `DSH_MEMORY_PATH` | vault directory | `./memory-vault` |
| `DSH_MEMORY_SERVER_DIR` | directory with `server.py` (MCP server) | `./memory-vault-server` |

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
scripts/digest_session.py     # optional standalone digest CLI (not used by the plugins)
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
