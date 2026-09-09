# Zona central de memoria — `~/.memories`

Vault OKF único compartido por DeepSeek Harness (plugins `memory-mcp` /
`memory-auto`) y opencode (MCP `memory-server`). Git repo propio, fuera de
todo repo de proyectos — ningún `git clean`/checkout ajeno puede tocarla.
Writes solo vía tools MCP o `git commit` dentro de la zona.

## Layout

```
~/.memories/
  projects/<proyecto>/{decisions,facts,learnings,conventions,ideas,contexts}/   source of truth (.md OKF)
  raw/                          entries Source
  templates/ type-registry.yaml tag-vocabulary.json   starter (8 tipos)
  index.md (por proyecto, derivado) · log.md
  memory.db*                    índice FTS5 DERIVADO (gitignored, reconstruible)
```

El nombre describe contenido (`memories`), no formato (OKF describe los
archivos). Server de código única: `dsh-memory-vault/memory-vault-server/`
(`MEMORY_PATH` apunta a la raíz del vault; el server lee `type-registry.yaml`
de ahí).

## Clientes

| Cliente | Config | Spawn |
|---|---|---|
| DSH profile `web` | `~/.dsh/profiles/web/cordis.patch.yml` (`memory-mcp` env `MEMORY_PATH`, `memory-auto` memoryPath) | `uv run --directory dsh-memory-vault/memory-vault-server python server.py` |
| opencode (global) | `~/.config/opencode/opencode.json` → `mcp.memory-server` | mismo comando, `"environment": {"MEMORY_PATH": "~/.memories"}` |

> Pitfall: opencode usa la key **`environment`**, no `env` — `env` se ignora
> silenciosamente y el server cae al vault default (escribe fuera de la zona).

Rutas absolutas en esos 2 archivos: si el repo del server se mueve,
actualizar ambos.

## Unión / rebuild (procedimiento del 2026-09-09)

1. Backup: `tar -czf <backup>/central-union-<fecha>-<fuente>.tar.gz -C <repo> memory/...`
2. `mkdir ~/.memories`; copiar starter (`templates/ type-registry.yaml tag-vocabulary.json README.md`) del vault DSH.
3. Unión no destructiva por fuente, en orden de frescura:
   `rsync -a --ignore-existing <vault>/projects/ ~/.memories/projects/` (idem `raw/`); `log.md` solo de la fuente más fresca; excluir `memory.db* logs/ tool-calls.log index.md _CLAUDE.md CRITICAL_FACTS.md`.
4. `git init` + `.gitignore` (`memory.db*`, `logs/`, `tool-calls.log`) + commit.
5. Índice: borrar `memory.db*` y:
   ```sh
   uv run --directory dsh-memory-vault/memory-vault-server python rebuild_index.py --memory-path ~/.memories
   ```
   (`rebuild_index.py`: inserta filas directas, nunca reescribe `.md`;
   idempotente; colapsa duplicados por dedup; regenera `index.md` faltantes.)
6. DB-only (`profile` rows no viven en `.md`): migrar aparte
   (`SELECT project,content,tags FROM entries WHERE entry_type='profile'` del
   vault viejo → `upsert_profile`), priorizando la fuente más fresca.
7. Smoke: JSON-RPC stdio (patrón del README del repo) `ping` + `search_memory`.
8. Commit en la zona.

`.md` sueltos fuera de dirs de tipo (ej. `projects/<p>/foo.md`) no se
indexan — el server tampoco los escribiría.

## Rollback

- Vault: `git -C ~/.memories reset --hard` o restaurar tar de backups.
- DSH: revivir patch anterior (`~/.dsh/profiles/web/cordis.patch.yml`).
- opencode: revivir `mcp.memory-server` anterior en `opencode.json`.

## Tercer cliente

Cualquier cliente MCP que spawnée el server con `MEMORY_PATH=~/.memories`
comparte la zona. Concurrencia: SQLite WAL, timeout 5 s default — writes
pequeños single-user OK; si aparece `SQLITE_BUSY` agregar `busy_timeout`
en `store.py` (1 línea).
