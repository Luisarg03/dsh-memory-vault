/**
 * DSH memory plugin (adapted from the OpenCode memory plugin).
 *
 * Implements session lifecycle hooks:
 *   - session.created: project name resolution only (no memory auto-injection)
 *   - session.idle: auto-capture gate (skip if no activity or already delivered)
 *   - tool.execute.after: detect `git commit*` and queue a checkpoint
 *   - tui.prompt.append: deliver queued checkpoint on next user message
 *   - experimental.session.compacting: pre-compaction capture (always fires)
 *   - session.end: invoke post-session digest
 *   - /brain search|recall|profile: opt-in reads via MCP (2s health check)
 *   - /checkpoint: manual structured review
 *   - OpenCode version guard: warn on < 1.17.10, disable gracefully
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

export const MIN_OPENCODE_VERSION = "1.17.10";
export const MCP_UNREACHABLE =
  "> ⚠️ Memory server unreachable — search cannot be completed.";
const CHECKPOINT_MARKER = "[memory-checkpoint]";

// ── Version guard ────────────────────────────────────────────────────────

/** Compare two "x.y.z" semver strings. Returns negative/0/positive. */
function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = a.split(".").map((n) => parseInt(n, 10) || 0);
  const [b1, b2, b3] = b.split(".").map((n) => parseInt(n, 10) || 0);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return (a3 || 0) - (b3 || 0);
}

export function isSupportedVersion(version: string): boolean {
  return compareSemver(version, MIN_OPENCODE_VERSION) >= 0;
}

// ── Project name resolution ──────────────────────────────────────────────

/**
 * Resolve the project name from a working directory.
 * Priority:
 *   1. OpenSpec presence: if `openspec/` exists, use the basename.
 *   2. package.json -> name
 *   3. pyproject.toml -> [project] -> name
 *   4. README.md: first 5 lines, heading pattern `# <ProjectName>`
 *   5. Fallback: basename of working directory
 */
export async function resolveProjectName(cwd: string): Promise<string> {
  if (existsSync(join(cwd, "openspec"))) {
    return basename(cwd);
  }
  // package.json
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return pkg.name.trim();
      }
    } catch {
      // ignore parse errors; try next strategy
    }
  }
  // pyproject.toml (minimal regex parse)
  const pyprojectPath = join(cwd, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const text = await readFile(pyprojectPath, "utf-8");
      const m = text.match(/\[project\][^\[]*?name\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch {
      // ignore
    }
  }
  // README.md heading
  const readmePath = join(cwd, "README.md");
  if (existsSync(readmePath)) {
    try {
      const text = await readFile(readmePath, "utf-8");
      const head = text.split("\n").slice(0, 5);
      for (const line of head) {
        const m = line.match(/^#\s+(.+)$/);
        if (m) return m[1].trim();
      }
    } catch {
      // ignore
    }
  }
  return basename(cwd);
}

// ── Checkpoint state ─────────────────────────────────────────────────────

export interface SessionState {
  project: string;
  hasActivity: boolean;
  checkpointDelivered: boolean;
  queuedCheckpoint: string | null;
}

export function createSessionState(project: string): SessionState {
  return {
    project,
    hasActivity: false,
    checkpointDelivered: false,
    queuedCheckpoint: null,
  };
}

/**
 * Build the checkpoint prompt body. Pure function — exported for testing.
 */
export function buildCheckpointPrompt(state: SessionState, activitySummary: string): string {
  return [
    `${CHECKPOINT_MARKER} End-of-session memory capture for project \`${state.project}\`.`,
    "",
    "Tracked activity:",
    activitySummary.trim() || "(none recorded)",
    "",
    "Write OKF entries for any notable decisions, facts, or learnings using the `store_*` MCP tools.",
    "If nothing is notable, say so explicitly and exit.",
  ].join("\n");
}

/**
 * Decide whether to deliver a checkpoint on `session.idle`.
 * Returns the prompt to deliver, or null to skip.
 */
export function idleCheckpoint(
  state: SessionState,
  activitySummary: string,
): string | null {
  if (!state.hasActivity) return null;
  if (state.checkpointDelivered) return null;
  state.checkpointDelivered = true;
  return buildCheckpointPrompt(state, activitySummary);
}

/**
 * Decide whether to fire on `experimental.session.compacting`.
 * Per spec: always fires when activity exists, even if checkpoint was delivered.
 */
export function compactingCheckpoint(
  state: SessionState,
  activitySummary: string,
): string | null {
  if (!state.hasActivity) return null;
  return buildCheckpointPrompt(state, activitySummary);
}

// ── Git commit detection ─────────────────────────────────────────────────

const GIT_COMMIT_PATTERN = /git\s+commit\b/;

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT_PATTERN.test(command);
}

export function buildCommitCheckpointPrompt(state: SessionState): string {
  return [
    `${CHECKPOINT_MARKER} Memory capture after \`git commit\` in project \`${state.project}\`.`,
    "",
    "Review the staged/committed changes and write OKF entries for any notable decisions, facts, or learnings.",
    "If nothing is notable, say so explicitly and exit.",
  ].join("\n");
}

// ── In-process session digest (ctx.llm) ──────────────────────────────────

/**
 * Entry types the vault's MCP server can store via `store_*` tools. The
 * extraction prompt is restricted to these so every produced entry has a
 * write path (no `idea`/`context`/`source` — those have no store tool).
 */
export const EXTRACTABLE_TYPES = ['decision', 'fact', 'learning', 'convention'] as const
export type ExtractableType = (typeof EXTRACTABLE_TYPES)[number]

/** One validated OKF entry ready to be stored through the vault server. */
export interface ValidEntry {
  entry_type: ExtractableType
  content: string
  description: string
  tags: string[]
  confidence: number
  openspec_change_id: string | null
}

/** Optional vault context files to embed in the extraction prompt. */
export interface DigestContextFiles {
  criticalFacts?: string
  claude?: string
}

/**
 * Build the system + user messages for the in-process extraction call.
 * The system part instructs the model to return a JSON array restricted to
 * EXTRACTABLE_TYPES; the user part carries the transcript.
 */
export function buildExtractionPrompt(
  project: string,
  transcript: string,
  contextFiles: DigestContextFiles = {},
): { system: string; user: string } {
  const sysParts: string[] = [
    'You are an assistant that extracts durable knowledge from a session transcript.',
  ]
  if (contextFiles.criticalFacts?.trim()) {
    sysParts.push(`Always-loaded context: CRITICAL_FACTS.md\n${contextFiles.criticalFacts.trim()}`)
  }
  if (contextFiles.claude?.trim()) {
    sysParts.push(`Always-loaded context: _CLAUDE.md\n${contextFiles.claude.trim()}`)
  }
  sysParts.push(
    `For the transcript of project \`${project}\`, identify:`,
    '- **Decisions**: architectural or design choices that were made.',
    '- **Facts**: stable, verifiable statements about the project (versions, conventions, constraints).',
    '- **Learnings**: non-obvious lessons, debugging insights, or solutions found.',
    '- **Conventions**: style rules, naming patterns, coding conventions agreed.',
    '',
    'Return a JSON array. Each element must have exactly:',
    '  - "entry_type": one of "decision" | "fact" | "learning" | "convention"',
    '  - "content": a single-paragraph statement (no headings, no lists)',
    '  - "description": a one-sentence summary of `content` (queryable)',
    '  - "tags": an array of lowercase-kebab tags (never empty if possible, at least 1 like architecture/python/testing)',
    '  - "confidence": a number 0.0-1.0',
    '  - "openspec_change_id": (optional) the change slug if the transcript names it',
    '',
    'Rules:',
    '- Skip trivial exchanges (greetings, "ok", "thanks", or anything with no project knowledge).',
    '- Prefer fewer, higher-signal entries over many weak ones.',
    '- Do not include anything not present in the transcript.',
    '',
    'Return only the JSON array. No prose, no markdown fences.',
  )
  return {
    system: sysParts.join('\n'),
    user: `Project: ${project}\n\nTranscript:\n---\n${transcript}\n---`,
  }
}

/**
 * Split an oversized transcript into overlapping chunks (mirrors the legacy
 * digest script: 25k chars per chunk, 1k overlap, at most `cap` chunks).
 */
export function chunkTranscript(text: string, maxLen = 50_000, chunkSize = 25_000, overlap = 1_000, cap = 3): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize))
    i += chunkSize - overlap
    if (chunks.length >= cap) break
  }
  return chunks
}

/** Best-effort repair of common LLM JSON output; returns parsed value or null. */
export function repairJson(text: string): unknown {
  const s = text.trim()
  // Strip code fences: ```json ... ```
  const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  // Trailing commas: `,]` / `,}` -> `]` / `}`
  const noTrailing = fenced.replace(/,(\s*[\]}])/g, '$1')
  const candidates = [s, fenced, noTrailing]
  // Single-quote to double-quote conversion only when no double quotes exist.
  if (noTrailing.includes("'") && !noTrailing.includes('"')) {
    candidates.push(convertSingleQuotes(noTrailing))
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // try the next candidate
    }
  }
  return null
}

function convertSingleQuotes(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString && ch === '\\') {
      if (i + 1 < text.length && text[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      out += ch
      if (i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === "'") {
      inString = !inString
      out += '"'
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Validate a parsed extraction payload into OKF entries. Unknown types,
 * empty content and malformed values are dropped; tags and confidence are
 * normalized. Returns the valid entries (possibly empty).
 */
export function validateEntries(payload: unknown): ValidEntry[] {
  if (!Array.isArray(payload)) return []
  const valid: ValidEntry[] = []
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const entryType = raw.entry_type
    if (typeof entryType !== 'string' || !(EXTRACTABLE_TYPES as readonly string[]).includes(entryType)) continue
    const content = typeof raw.content === 'string' ? raw.content.trim() : ''
    if (!content) continue
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
    let confidence = 1
    if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
      confidence = Math.max(0, Math.min(1, raw.confidence))
    }
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    const changeId = typeof raw.openspec_change_id === 'string' && raw.openspec_change_id ? raw.openspec_change_id : null
    valid.push({
      entry_type: entryType as ExtractableType,
      content,
      description,
      tags,
      confidence,
      openspec_change_id: changeId,
    })
  }
  return valid
}

// The full hook wiring is exposed for testing; the actual OpenCode integration
// is done in `register.ts` (the entry point the OpenCode runtime loads via
// package.json "main"). This module intentionally has no default export:
// opencode 1.18.x only loads plugin modules with a single export.
export const __testing = {
  createSessionState,
  isSupportedVersion,
  resolveProjectName,
  idleCheckpoint,
  compactingCheckpoint,
  isGitCommit,
  buildCheckpointPrompt,
  buildCommitCheckpointPrompt,
};
