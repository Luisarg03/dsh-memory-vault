---
name: checkpoint-auto
description: >-
  Explains and steers the automatic memory capture that the memory-auto plugin runs: the
  git-commit, compaction and idle triggers, what an injected [memory-checkpoint] prompt
  means, and the in-process digest that writes entries on its own. Use when the user asks
  "what is [memory-checkpoint]", "why did you save that", "how does automatic memory
  work", or wants to tune or disable it. Not the capture procedure itself — that is
  /checkpoint.
whenToUse: "/checkpoint-auto — what the automatic capture does, and its knobs"
---

# Automatic capture (memory-auto)

This plugin captures memory **without being asked**. This skill explains what it does and
how to steer it. The writing procedure itself lives in `/checkpoint` — same entry types,
same selection rules; load that one to actually write entries.

## Triggers

| Trigger | Fires when |
|---|---|
| git commit | a tool call runs a git commit |
| Compaction | the session compacts and activity exists |
| Idle | the session goes idle with activity |

A trigger queues a checkpoint; it reaches the agent on the next step as injected user
context whose first line carries the marker `[memory-checkpoint]`.

## The digest

Beyond prompting, `memory-auto` can digest the session itself: it calls the harness's own
LLM service (`ctx.llm` — the credentials the session already uses, no external CLI, no
stored keys) over the transcript and writes the resulting entries. Its activity shows up
as `[memory-auto] …` lines.

## Duplicate avoidance

Automatic and manual capture write to the same vault. Always search before writing — that
is step 3 of `/checkpoint`. A manual `/checkpoint` right after an automatic one should
normally add nothing: say so instead of writing a second copy of the same thing.

## Knobs

Configuration lives in the plugin's composition row (`cordis.patch.yml`, or the profile
patch), not in this skill:

| Field | Default | Effect |
|---|---|---|
| `enabled` | `true` | master switch for automatic capture |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | LLM target for the in-process digest |
| `maxTokens` | `2048` | digest response budget |
| `minTranscriptChars` | `200` | sessions with less transcript than this are not digested |
| `memoryPath` / `serverDir` | env, else the harness home | where the vault and its server live |

Turning capture off is a config change (`enabled: false`), not a skill change. State what
you changed and where.

## When a checkpoint prompt arrives without this skill's procedure

Follow the prompt's own instructions. It carries the entry vocabulary and the selection
rules precisely so it works with no skill loaded — do not improvise entry types.
