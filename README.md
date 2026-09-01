# dsh-memory-vault — Memoria persistente para DeepSeek Harness (DSH)

Stack completo de memoria OKF para [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/):
MCP server en Python (SQLite FTS5 + markdown), dos plugins cordis (`memory-mcp`, `memory-auto`)
y un vault starter con plantillas y type registry.

## Componentes

| Componente | Descripción | Bundle |
|---|---|---|
| `memory-mcp` | MCP stdio wrapper: conecta DSH al memory vault server | `@dsh-memory/memory-mcp` |
| `memory-auto` | Auto-captura de memoria: digest de sesión, checkpoints en commit/compaction | `@dsh-memory/memory-auto` |
| `memory-vault-server/` | MCP server Python: SQLite FTS5 + markdown OKF | — |
| `memory-vault/` | Starter del vault: plantillas + type registry + tag vocabulary | — |
| `scripts/digest_session.py` | Digest post-sesión: transcript → entries OKF vía CLI LLM | — |

## Arquitectura

Diagramas interactivos (HTML autocontenido, se abren en cualquier navegador):

| Diagrama | Tipo | Qué muestra |
|---|---|---|
| [Stack completo](docs/diagrams/stack.html) | arquitectura | DSH, plugins, server y vault |
| [Digest de sesión](docs/diagrams/session-digest.html) | dataflow | del transcript a entradas OKF |
| [Llamada a tool MCP](docs/diagrams/mcp-tool-call.html) | secuencia | agente → client stdio → server → vault |
| [Ciclo de captura](docs/diagrams/capture-lifecycle.html) | lifecycle | checkpoints por sesión |

Los specs JSON de los diagramas viven en `docs/diagrams/*.json` (generados con
[archify](https://github.com/tt-a1i/archify)); documentación completa en
[`docs/architecture.md`](docs/architecture.md) e índice en
[`docs/README.md`](docs/README.md).

## Quickstart

```sh
pnpm install
pnpm -r build

# dev local con overlay (paths relativos al cwd del repo)
dsh web --patch ./examples/dev-memory.cordis.yml
```

## Install en perfil

```sh
# local checkout
dsh plugin --profile demo add ./packages/memory-mcp
dsh plugin --profile demo add ./packages/memory-auto

# tarball
pnpm --filter @dsh-memory/memory-mcp pack
pnpm --filter @dsh-memory/memory-auto pack
dsh plugin --profile demo add ./dsh-memory-memory-mcp-0.1.0.tgz ./dsh-memory-memory-auto-0.1.0.tgz

# npm (recomendado para distribución — pnpm no soporta subdirectorios en specs git:
# https://github.com/pnpm/pnpm/pull/7487, así que el root de un monorepo con
# subpaquetes no se puede instalar directamente desde github)
#   npm publish en packages/memory-mcp y packages/memory-auto, luego:
dsh plugin --profile demo add @dsh-memory/memory-mcp @dsh-memory/memory-auto
# ⚠️ `add github:Luisarg03/dsh-memory-vault` instala el root, que no declara
# `dsh.bundle` → queda como dependencia plana, NUNCA se activa como capa.

# verificar layer
dsh --profile demo --dump-config | grep -A2 memory
```

## Memory stack

Los plugins trabajan sobre un vault OKF (`memory-vault/` en este repo, o uno propio).
Requisitos: `uv` instalado; el digest (`scripts/digest_session.py`) delega la extracción
LLM al CLI `opencode` (no guarda credenciales propias).

Los paths se resuelven por **env vars** (sin rutas hardcodeadas):

| Env var | Uso | Default |
|---|---|---|
| `DSH_MEMORY_PATH` | directorio del vault | `./memory-vault` |
| `DSH_MEMORY_SERVER_DIR` | directorio con `server.py` del MCP server | `./memory-vault-server` |
| `DSH_DIGEST_SCRIPT` | ruta al script de digest | `./scripts/digest_session.py` |
| `DSH_DIGEST_LOG` | log del spawn del digest | `<tmpdir>/dsh-digest-spawn.log` |

```sh
# levantar el MCP server solo:
MEMORY_PATH=./memory-vault uv run --directory ./memory-vault-server python server.py
```

### Vault

`memory-vault/` es un bundle OKF: `templates/` (plantillas por tipo), `type-registry.yaml`
(fuente de verdad de tipos), `tag-vocabulary.json` (normalización de tags). Los datos
(`projects/`, `raw/`, `logs/`, `memory.db`) los crea el server automáticamente al primer
uso y están excluidos de git (`.gitignore`).

## Estructura

```
packages/memory-mcp/          # bundle cordis: MCP stdio client al vault
packages/memory-auto/         # bundle cordis: digest automático de sesiones
memory-vault-server/          # MCP server Python (SQLite + markdown OKF)
memory-vault/                 # starter del vault (templates + type registry)
scripts/digest_session.py     # digest post-sesión (LLM via opencode CLI)
examples/dev-memory.cordis.yml      # memory-mcp
examples/dev-memory-auto.cordis.yml # memory-mcp + memory-auto
```

## Layer order

1. `dsh.profile.bundles` (base + cada bundle instalado)
2. `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. `--patch` overlays

Patch reemplaza `config` completo, no merge.

## Troubleshooting pnpm

- `unable to open database file` → el store de pnpm no es escribible en el sandbox.
  Usar `--store-dir ./.pnpm-store` en cada `pnpm install` y en
  `dsh plugin --profile X --store-dir ./.pnpm-store add ...`.
- `dsh: pnpm failed` al instalar desde github → solo aplica a paquetes con script
  `prepare`; copiar la key impresa a `pnpm-workspace.yaml` del profile (allowBuilds).
  Nota: los subpaquetes de este monorepo no se pueden instalar con `github:...`
  (pnpm no soporta subdirectorios en git specs) — usar npm o tarball.

## Docs

- [`docs/`](docs/README.md) — documentación pública (arquitectura + diagramas)
- [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
- [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config)
- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
