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

`project` is the folder key under `<vault>/projects/` (nested keys like `<org>/<repo>`
work); a misspelled name silently creates a new project, so verify — never guess:

1. `Memory project:` in the closest `AGENTS.md` walking up from the cwd wins.
2. Otherwise list the vault and match: `ls "${DSH_MEMORY_PATH:-$HOME/.memories}"/projects/`.
3. It is not always the repo basename — it can be the `package.json` name or a curated name. Reuse the key the vault already uses for this work.
4. Unknown or ambiguous? Ask before writing. Do not infer a new project key.

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

Then consult the tag catalog thematically — never dump it whole:

- `list_tags` with a `query` for the session topic (bounded, default limit 20) to find reusable tags and aliases.
- Reuse a known tag or alias whenever one fits the concept.
- Coin a NEW lowercase-kebab tag for any concept none covers. Ordinary new tags need **no approval** and never block the write: the server normalizes aliases and records newcomers centrally.

## 4. Write

- `content`: **one paragraph** — no headings, no lists, no markdown structure.
- `tags`: lowercase-kebab, at least one (`architecture`, `python`, `testing`, `ci`…). Send them as chosen: the server returns the final `tags` plus `new_tags`.
- `confidence` only has an effect on `store_fact`; the other tools accept and ignore it.
- Re-storing identical content **unions** the new tags with the stored entry (Markdown and index stay in sync); sending `tags: []` never erases existing tags.
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

Report 5–10 lines: what was written (tool + description), for each entry which tags were
reused vs new **as the store response actually reported them** (never claim a tag is new
when the response normalized it to an existing one), what was left out and why, and
what could not be verified.
