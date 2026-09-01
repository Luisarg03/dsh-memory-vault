# memory-vault (starter)

Vault de memoria OKF (Obsidian Knowledge Format) para los plugins de memoria de DSH.

Este directorio contiene el **esqueleto público** del vault: plantillas, type registry
y vocabulario de tags. Los datos (`projects/`, `raw/`, `logs/`, `memory.db`, `index.md`,
`log.md`) se generan localmente y están excluidos de git (`.gitignore`).

## Estructura

```
memory-vault/
├── templates/          # plantillas OKF por tipo de entrada
├── type-registry.yaml  # registro de tipos (fuente de verdad)
├── tag-vocabulary.json # normalización de tags
├── projects/           # entradas por proyecto (se crean al primer uso)
├── raw/                # entradas Source sueltas (se crean al primer uso)
├── logs/               # logs del digest (se crean al primer uso)
└── memory.db           # índice SQLite (FTS5), rebuildable desde markdown
```

Los directorios `projects/`, `raw/` y `logs/` y `memory.db` los crea
`memory-vault-server` automáticamente al primer uso (`MemoryStore.__init__`).

## Uso

Apuntar el server (o los plugins `memory-mcp` / `memory-auto`) a este directorio
con la env var `MEMORY_PATH` (o `DSH_MEMORY_PATH` para los plugins DSH):

```sh
MEMORY_PATH=./memory-vault uv run --directory ./memory-vault-server python server.py
```

## Rebuild del índice

El índice SQLite es un derivado de los markdown; si falta o está corrupto se puede
reconstruir con las tools de escritura del server (`store_*`), que upsertan cada
entrada desde su archivo.
