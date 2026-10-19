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
| DSH profile `web` | bundle default: vault `~/.memories`, server `$DSH_HOME/memory-vault-server` (override con `DSH_MEMORY_PATH` / `DSH_MEMORY_SERVER_DIR`, o `~/.dsh/profiles/web/cordis.patch.yml`) | `uv run --directory dsh-memory-vault/memory-vault-server python server.py` |
| opencode | `opencode plugin -g @luisarg/memory-opencode` (adaptador que registra `mcp.memory-server` + skills) | mismo comando, `MEMORY_PATH` default `~/.memories` |
| PI | `pi install npm:@luisarg/memory-pi` (adaptador: extension registra `memory-server` + skills) | mismo comando, `MEMORY_PATH` default `~/.memories` |

Los adaptadores leen el spec canónico `memory-vault-server/mcp-servers.json` (una entrada plana
`memory-server`, viaja bundlado como `<pkg>/server/mcp-servers.json`) y lo traducen al dialecto de
cada cliente. Un `memory-server` declarado a mano por el usuario siempre gana (en opencode no se
pisa; en PI el homónimo de `mcp.json` tiene prioridad sobre la extensión).

> El default del bundle es `~/.memories` (no `$DSH_HOME/memory-vault`, que era la
> regresión de 0.1.5): un perfil sin patch ya escribe en la zona central. Un patch
> vacío (`[]`) no pinea nada, así que el default es lo que manda.

> Pitfall (config manual): opencode usa la key **`environment`**, no `env` — `env` se ignora
> silenciosamente y el server cae al vault default (escribe fuera de la zona). El adaptador
> `@luisarg/memory-opencode` escribe la key correcta.

Rutas absolutas en la config manual: si el repo del server se mueve, actualizarla. Los
adaptadores npm no dependen de rutas de máquina (el server va dentro del paquete).

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
comparte la zona; para los dos soportados hay paquete npm (`@luisarg/memory-pi`,
`@luisarg/memory-opencode`) y para cualquier otro alcanza con copiar la entrada
del spec canónico. Concurrencia: SQLite WAL y `timeout=30` explícito en las
conexiones de `store.py` (antes 5 s default) — writes pequeños single-user OK.
El timeout aplica también al `PRAGMA integrity_check` del arranque: con el
default, un lock de otro cliente se reportaba como `corrupt database`.
