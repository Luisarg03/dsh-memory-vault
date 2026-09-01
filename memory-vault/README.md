# memory-vault (starter)

OKF (Obsidian Knowledge Format) memory vault for the DSH memory plugins.

This directory is the **public skeleton** of the vault: templates, type registry
and tag vocabulary. Runtime data (`projects/`, `raw/`, `logs/`, `memory.db`,
`index.md`, `log.md`) is generated locally and excluded from git (`.gitignore`).

## Structure

```
memory-vault/
├── templates/          # OKF templates per entry type
├── type-registry.yaml  # type registry (source of truth)
├── tag-vocabulary.json # tag normalization
├── projects/           # per-project entries (created on first use)
├── raw/                # loose Source entries (created on first use)
├── logs/               # digest logs (created on first use)
└── memory.db           # SQLite index (FTS5), rebuildable from markdown
```

`projects/`, `raw/`, `logs/` and `memory.db` are created automatically by
`memory-vault-server` on first use (`MemoryStore.__init__`).

## Usage

Point the server (or the `memory-mcp` / `memory-auto` plugins) at this directory
with the `MEMORY_PATH` env var (or `DSH_MEMORY_PATH` for the DSH plugins):

```sh
MEMORY_PATH=./memory-vault uv run --directory ./memory-vault-server python server.py
```

## Rebuilding the index

The SQLite index is derived from the markdown; if it is missing or corrupted it
can be rebuilt with the server's `store_*` write tools, which upsert each entry
from its file.
