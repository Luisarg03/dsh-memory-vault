---
name: checkpoint
description: >-
  Capture what a session produced into the memory vault as decision, fact, learning and
  convention entries through the memory plugin's tools, then commit the vault. Use when
  the user invokes /checkpoint, says "save this session", "run the checkpoint", "remember
  this", or when a memory-auto [memory-checkpoint] prompt arrives.
whenToUse: "/checkpoint [topic] — with no argument it reviews the whole session"
---

# Checkpoint — capture the session

Write into the vault through the memory plugin's tools (`mcp__memory__*` when the server
is named `memory`). Never edit `memory.db` or the entry Markdown by hand: the tools keep
the Markdown source and the derived index in sync.

The `memory-auto` plugin runs this **same** procedure automatically — that is what its
`[memory-checkpoint]` prompt asks for: same types, same selection rules. If the request
arrived as `[memory-checkpoint]`, this is the path. Do not write the same thing twice:
search first (step 3).

## 1. Resolve the project

`project` is the folder key under `<vault>/projects/`; a misspelled name silently creates a
new project:

```sh
ls "${DSH_MEMORY_PATH:-$HOME/.memories}"/projects/
```

It is not always the repo basename — it can be the `package.json` name, a curated name, or
a nested path (`<org>/<repo>`). Reuse the key the vault already uses for this work.

## 2. Decide what qualifies

| Type | Tool | What goes in |
|---|---|---|
| **decision** | `store_decision` | Architecture or design choices, **and why**. Pass `openspec_change_id` when the choice came from a change |
| **fact** | `store_fact` | Stable, verifiable statements: versions, constraints, paths, endpoints. `confidence` 0.0–1.0 |
| **learning** | `store_learning` | Non-obvious lessons, debugging insights, a solution that cost effort |
| **convention** | `store_convention` | Agreed style rules, naming patterns, standards |
| **source** | `store_source` | External references (article, transcript, PDF, video, link), stored under `raw/`. Immutable per URL |

**Do not store:** greetings, acknowledgements, restatements of the request, or anything you
cannot ground in this session. Few high-signal entries beat many weak ones. If nothing
qualifies, say so and write nothing — an empty checkpoint is a valid outcome.

## 3. Search before writing

`search_memory` on the topic first. Deduplication is a hash of
`(project, entry_type, content)` over normalized content: resending the same text with
different casing **updates** the existing entry; changing one word creates a **new** one.

## 4. Write

- `content`: **one paragraph** — no headings, no lists, no markdown structure.
- `tags`: lowercase-kebab, at least one (`architecture`, `python`, `testing`, `ci`…).
- `confidence` only has an effect on `store_fact`; the other tools accept and ignore it.
- `store_profile` is **not** used here: it replaces a project's whole profile entry (one
  per project, no Markdown written). The profile layer has its own procedure.

## 5. Close

The vault is its own git repository — commit it:

```sh
cd "${DSH_MEMORY_PATH:-$HOME/.memories}"
git add -A && git commit -m "memory(<project>): <what changed and why>"
```

Follow whatever commit convention the vault's own history uses, and do not push unless
asked: with no remote configured, the commit is the end of the line.

Report 5–10 lines: what was written (tool + description), what was left out and why, and
what could not be verified.
