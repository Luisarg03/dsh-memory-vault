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

**`/brain` is read-only.** It writes nothing: capture is `/checkpoint`. The profile layer
that `/checkpoint-perfil` maintains is a user-level skill, not one this plugin ships — if
that command is not in the skill catalog, `store_profile` is the only profile writer here.

## 1. Locate the vault

Only needed when you touch the filesystem. The plugin resolves the vault in this order:
`DSH_MEMORY_PATH` → `$HOME/.memories` (the OS home — `DSH_HOME` does not move it) → the
profile's own patch. The server receives the result as `MEMORY_PATH`. Paths are absolute
and do not depend on the cwd.

## 2. Resolve the project

`project` is the folder key under `<vault>/projects/` (nested keys like `<org>/<repo>`
work). A misspelled name silently creates a new project elsewhere — there is no
validation against a list — so verify before filtering:

1. `Memory project:` in the closest `AGENTS.md` walking up from the cwd wins.
2. Otherwise verify against the vault key: `ls "${DSH_MEMORY_PATH:-$HOME/.memories}"/projects/`.
3. The key is **not necessarily the repo basename**: it can be the `package.json` name, a
   curated human name, or a nested path. When unsure, search **without**
   `project` (that scans every project) and narrow afterwards.
4. Unknown or ambiguous — including which projects to exclude (step 6)? Ask. Never infer
   a new project key.

## 3. Pick the tool

| Need | Tool | Note |
|---|---|---|
| A topic, a decision, a bug, "what do you know about X" | `search_memory` | `query` is tokenized and **OR**-matched by default (`match="all"` requires every term); quote a span (`"use sqlite"`) for the exact phrase |
| Which tags exist for a topic | `list_tags` | thematic `query`, bounded `limit` (default 20, max 50); reuse instead of loading everything |
| Who the user is, the profile, the stack | `get_profile` | profile entries for one project |
| Everything about one project | `export_memories` | needs `project`; no limit; for dumps, not lookups |
| Is the server reachable? | `ping` | health check |

Traps that cost real time:

- **`search_memory` with `entry_type=profile` always returns 0 results.** Profiles come
  from `get_profile`.
- `get_profile` with **any other** `entry_type` does not filter: it returns the 10 most
  recent entries of that type.
- `tags` is **OR** as well: `["ci","release"]` returns entries carrying *either* tag.
- Every `search_memory` result carries `tags` as a **list** and a `description`
  (derived from the content when the entry has none). No `json.loads` needed.
- `search_memory` returns at most `max_results` entries (default 50, cap 200). For a
  whole project, use `export_memories`.
- Sharing a generic tag (`python`, `backend`) is **not** by itself a connection: it only
  counts with topical relevance behind it.
- Sources are global and opt-in: only `entry_type="source"` **without** `project`
  returns them (with `query`/`tags` narrowing). `entry_type="source"` **with** a project
  is an error. Never present a source as belonging to a project.

## 4. Profile layers are documents, not index entries

A vault may keep a profile layer: a `profile/` directory inside a project, usually a
`README.md` map plus numbered documents. Those files are **not** in `memory.db`, so
`search_memory` never returns them — read them from the filesystem. `get_profile` returns
something else: internal metadata rows that live only in SQLite and write no Markdown, so
an index rebuild from Markdown cannot recover them.

## 5. Local context first

1. `get_profile` for the resolved project.
2. Topic search inside the project (`search_memory` with `project`, or `export_memories`
   as fallback for a full dump).
3. Local rules always prevail: external experience never overrides them.

## 6. Then external antecedents — always, and separately

Even when the local context looks sufficient, always run one bounded cross-project pass:
`search_memory` (and/or `list_tags`) by topic/tags **without** `project`, excluding the
local project plus any agreed exclusions via `exclude_projects`. Exclusions are exact
project keys (nested paths in full) and the server applies them **before** retrieving
results and before the limit — excluded projects never leak in through counts or origins.

- **With a task:** aim the pass at the problem at hand.
- **Without a task:** aim it at the project's open topics and risks.
- Rank by relevance first; learnings break ties, they do not outrank relevance.

Answer with a separate antecedents block: up to **3** brief items is the suggested
starting default — not a quota. Zero when nothing earns it; say so explicitly instead of
forcing a connection. Each item names its origin **project** and **why** it matters for
this work.

## 7. Answer

- Cite project + entry (its description or first line). Quote; do not paraphrase a claim
  into something stronger than it is.
- Never fill gaps: if the vault does not say it, it is not there.
- No results? Say so, and separate **"not in the vault"** from **"I searched badly"**:
  retry without `project`, with other tags, or with `export_memories`.
