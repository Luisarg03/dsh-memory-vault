# Security policy

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability reporting](../../security/advisories/new)
(Security → Advisories → "Report a vulnerability"). Please do not open a public
issue for anything exploitable.

Include what you can: affected version (`npm view @luisarg/memory-mcp version`),
a reproduction, and the impact you see. This is a small project maintained by one
person, so expect a first reply within a few days rather than hours.

## Scope

The published artifacts are:

| Artifact | What runs |
|---|---|
| `@luisarg/memory-mcp` | Cordis bundle: spawns the vault MCP server over stdio |
| `@luisarg/memory-auto` | Cordis bundle: session digest, writes through the same server |
| `memory-vault-server/` (bundled in both) | Python MCP server: SQLite FTS5 index + Markdown vault |

In scope: the Python server, both bundles, the launcher that bootstraps the
Python environment, and the release pipeline in `.github/workflows/`.

Out of scope: the DSH host itself (report to the DeepSeek Harness project), and
anything requiring an already-compromised machine or a malicious local vault.

## What the project already does

- **No long-lived publish credentials.** npm releases authenticate through
  GitHub Actions OIDC (Trusted Publishing) and carry a provenance attestation.
  Longer-lived npm tokens are disallowed on both packages.
- **Dependency install scripts are blocked.** `allowBuilds: {}` in
  `pnpm-workspace.yaml` means no dependency runs a postinstall script; adding one
  is an explicit, reviewable change.
- **The published tarball is validated before it ships** — required bundled
  files present, no vault data (`*.db`, `projects/`, `logs/`), no `.venv` or
  `__pycache__` (`scripts/check-tarball.mjs`).
- **CI actions are pinned to commit SHAs**, the release job has no dependency
  cache, and every workflow declares least-privilege `permissions`.
- **Vault data stays local.** The vault is Markdown plus a local SQLite index;
  nothing is sent anywhere except the LLM calls the host itself makes.

## Reporting a data-exposure bug in the vault layout

The vault stores user memories as Markdown under a directory the user chooses
(`DSH_MEMORY_PATH` / `MEMORY_PATH`). Path traversal, index corruption and
"wrote outside the vault" bugs are security issues here — report them the same
way.
