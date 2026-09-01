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
