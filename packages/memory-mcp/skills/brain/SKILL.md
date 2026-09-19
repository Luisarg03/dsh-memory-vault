---
name: brain
description: >-
  Read what the memory vault already knows: topic search, recall by project, the user
  profile, and full project dumps, through the memory plugin's MCP tools. Use when the
  user invokes /brain, asks "what do you know about", "search your memory", "recall what
  we said about", "do you remember when", "bring up the profile", or needs prior-session
  context before acting.
whenToUse: "/brain <query> · /brain profile · /brain export <project>"
---

# Brain — read from the vault

The memory plugin exposes a Markdown knowledge base (OKF) over MCP; the vault's
`memory.db` is a derived SQLite FTS5 index over that Markdown. Read it through the
plugin's tools — `mcp__memory__*` when the server is named `memory` — never by hand.

**`/brain` is read-only.** It writes nothing: capture is `/checkpoint`, and the profile
layer is `/checkpoint-perfil`.

## 1. Locate the vault

Only needed when you touch the filesystem. The plugin resolves the vault in this order:
`DSH_MEMORY_PATH` → `$HOME/.memories` (the OS home — `DSH_HOME` does not move it) → the
profile's own patch. The server receives the result as `MEMORY_PATH`. Paths are absolute
and do not depend on the cwd.

## 2. Resolve the project

`project` is the folder key under `<vault>/projects/`. A misspelled name silently creates
a new project — there is no validation against a list — so list before filtering:

```sh
ls "${DSH_MEMORY_PATH:-$HOME/.memories}"/projects/
```

The key is **not necessarily the repo basename**: it can be the `package.json` name, a
curated human name, or a nested path (`<org>/<repo>`). When unsure, search **without**
`project` (that scans every project) and narrow afterwards.

## 3. Pick the tool

| Need | Tool | Note |
|---|---|---|
| A topic, a decision, a bug, "what do you know about X" | `search_memory` | `query` is tokenized and **OR**-matched, ranked by relevance — not an exact phrase |
| Who the user is, the profile, the stack | `get_profile` | profile entries for one project |
| Everything about one project | `export_memories` | no limit; for dumps, not lookups |
| Is the server reachable? | `ping` | health check |

Traps that cost real time:

- **`search_memory` with `entry_type=profile` always returns 0 results.** Profiles come
  from `get_profile`.
- `get_profile` with **any other** `entry_type` does not filter: it returns the 10 most
  recent entries of that type.
- `tags` is **OR** as well: `["ci","release"]` returns entries carrying *either* tag.
- `search_memory` returns **at most 50** entries. For a whole project, use
  `export_memories`.
- `source` entries are excluded from every filtered search: only `entry_type="source"`
  with no other filter returns them.

## 4. Profile layers are documents, not index entries

A vault may keep a profile layer: a `profile/` directory inside a project, usually a
`README.md` map plus numbered documents. Those files are **not** in `memory.db`, so
`search_memory` never returns them — read them from the filesystem. `get_profile` returns
something else: internal metadata rows that live only in SQLite and write no Markdown, so
an index rebuild from Markdown cannot recover them.

## 5. Answer

- Cite project + entry (its description or first line). Quote; do not paraphrase a claim
  into something stronger than it is.
- Never fill gaps: if the vault does not say it, it is not there.
- No results? Say so, and separate **"not in the vault"** from **"I searched badly"**:
  retry without `project`, with other tags, or with `export_memories`.
