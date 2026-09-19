# Releasing & version tags

How versions of this stack map to commits, and how to tag a new release.

## Tag scheme

One **annotated tag per suite release**, named `v<version>`:

```sh
git tag -a v0.1.3 <publish-commit> -F notes.md
git push origin v0.1.3
```

There is no tag per package: `@luisarg/memory-mcp` and `@luisarg/memory-auto`
are versioned in lockstep and published together, so a single tag identifies
both artifacts of that release. If the packages ever diverge, switch to the
`<package>@<version>` scheme (the Changesets convention) and keep `v*` for the
already-published releases listed below.

### The one rule that matters

**The tag points at the commit whose `package.json` versions actually reached
npm** — never at a later documentation or feature commit. npm records that
commit as `gitHead`, so:

```sh
curl -s https://registry.npmjs.org/@luisarg/memory-mcp \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['versions']['0.1.2']['gitHead'])"
git rev-list -n1 v0.1.2   # must print the same SHA
```

That check is the whole point of tagging: it turns "which code is live?" into a
one-command answer. It also means release notes must not promise fixes that
landed after the publish commit (see the 0.1.1 note below).

## Publishing a release

Releases are published by CI, not from a laptop. Pushing an annotated tag
`v<version>` to `main` triggers `.github/workflows/publish.yml`, which builds,
tests, validates the tarballs and publishes both packages to npm with a
provenance attestation.

```sh
# 1. bump both package.json files in lockstep
pnpm release:bump 0.1.7
pnpm -r build && pnpm -r test && pnpm release:check

# 2. merge the bump to main through a PR (the ruleset requires the CI check)

# 3. tag the merged commit and push the tag
git tag -a v0.1.7 -m "Release 0.1.7" && git push origin v0.1.7
```

Then the workflow takes over:

1. fails fast if npm < 11.5.1 (Trusted Publishing requirement);
2. `release-check.mjs --tag v0.1.7 --strict` — tag, both package versions and
   HEAD must agree, and the tree must be clean;
3. packs both packages and validates every tarball (`check-tarball.mjs`):
   required bundled files present, no vault data, no build residue;
4. `npm publish <tarball> --access public` per package, authenticated by OIDC.
   A version already on npm is skipped, so a re-run resumes instead of failing;
5. verifies the published `gitHead` equals the tag's commit;
6. creates the GitHub Release for the tag.

If you must publish by hand (npm outage, hotfix), the equivalent manual path is
`pnpm -r build && pnpm pack` then `npm publish <tgz> --access public --otp=<code>`,
and only then tag — the tag must point at the commit whose `package.json`
versions actually reached npm.

### One-time npm setup (already done for 0.1.x — a new package needs it)

Per package on npmjs.com → Settings:

| Setting | Value |
|---|---|
| Trusted Publisher → Provider | GitHub Actions |
| Organization or user | `Luisarg03` |
| Repository | `dsh-memory-vault` |
| Workflow filename | `publish.yml` |
| Environment name | `release` |
| Allowed actions | `npm publish` |
| Publishing access | *Require 2FA and disallow tokens* |

The same setup is scriptable — one call per package (`npm` ≥ 11.5):

```sh
npm trust github @luisarg/memory-mcp \
  --file publish.yml --repo Luisarg03/dsh-memory-vault --env release --allow-publish -y
```

Validate the parameters first with `--dry-run`, which does not prompt. The real
call needs a one-time password: the account requires 2FA for writes and npm
treats a trust change as an account operation, so it opens a browser auth flow
and cannot be completed unattended. A mismatch between these fields and the
workflow is what the publish job reports as
`404 ... OIDC token exchange error - package not found` followed by `ENEEDAUTH`
— the package exists; it is the trust entry that does not match.

The last row is what removes the token: publishing authority flows only through
the OIDC exchange, and the workflow file is part of what npm verifies. **OIDC
cannot create a package that does not exist yet** — a brand-new package gets its
first version published manually with `--otp`, and OIDC takes over from the
second release onward.

### Security layers around the release

| Layer | Where | What it stops |
|---|---|---|
| No publish token anywhere; OIDC + provenance | npm settings + `publish.yml` | a leaked long-lived token publishing in your name |
| `id-token: write` only in the publish job; every other workflow is `contents: read` | `.github/workflows/*` | a compromised CI job minting release credentials |
| Tag push is the trigger; only admins can push tags | GitHub ruleset | writing to `main` alone cannot publish |
| `main` requires a PR and the `build-test` check | GitHub ruleset | unreviewed or red code reaching a release |
| Release job runs without a dependency cache | `publish.yml` (`package-manager-cache: false`, an input `setup-node` only honours from v7 on) | cache poisoning feeding the published artifact |
| Tarball contents validated before publish | `scripts/check-tarball.mjs` | vault data or `.venv`/`__pycache__` shipping to users |
| Actions pinned to commit SHAs, enforced repo-wide | workflows + `sha_pinning_required` | a retagged upstream action running unreviewed code |
| Secret scanning + push protection, plus a token-pattern grep in CI | GitHub settings + `security.yml` | credentials committed into the repo |

## Released versions

| Tag | Published (UTC) | npm | Publish commit | Notes |
|---|---|---|---|---|
| [`v0.1.0`](../../releases/tag/v0.1.0) | 2026-09-03 15:30 | `0.1.0` | `3141e9e` | First publish; scope rename `@dsh-memory` → `@luisarg`. Tarball without `server/` (7 files). Live ~9 h. |
| [`v0.1.1`](../../releases/tag/v0.1.1) | 2026-09-04 00:38 | `0.1.1` | `a1ccb5f` | Self-contained tarballs (25 files): Python server + vault starter bundled, first-boot bootstrap. Requires `uv`. |
| [`v0.1.2`](../../releases/tag/v0.1.2) | 2026-09-07 16:32 | `0.1.2` | `930b7f7` | `launcher.mjs` falls back to a pip venv when `uv` is absent (27 files). |
| [`v0.1.3`](../../releases/tag/v0.1.3) | 2026-09-12 17:35 | `0.1.3` | `9878fce` | SQLite `timeout=30` (a busy lock from the other MCP client surfaced as "corrupt database" at startup) + `UV_CACHE_DIR` default under the OS temp dir (28 files). |
| [`v0.1.4`](../../releases/tag/v0.1.4) | 2026-09-17 18:11 | `0.1.4` | `e862b23` | `dist/index.js` kept so the published entry points resolve (29 files). The npm Trusted Publisher was configured for this release; the verify step raced registry propagation and failed the job *after* a successful publish, so it took a second dispatch to create the Release. |
| [`v0.1.5`](../../releases/tag/v0.1.5) | 2026-09-17 18:53 | `0.1.5` | `6ebbd5f` | Bundled skills: `brain` + `checkpoint` in `memory-mcp`, `checkpoint-auto` in `memory-auto` (31 / 30 files). The verify step now polls the registry, so the release completed in a single dispatch. |
| [`v0.1.6`](../../releases/tag/v0.1.6) | 2026-09-19 17:46 | `0.1.6` | `f46608a` | Vault default moved to `~/.memories` (31 / 30 files). 0.1.5 resolved an unset path to `$DSH_HOME/memory-vault`, so a profile with no explicit patch — the normal case — wrote to an empty vault while the central zone sat unused. Fixed in both resolvers, both bundle patches and `cli.py`, guarded by `tests/default-path.spec.ts`; the server directory still follows `$DSH_HOME`. |
| [`v0.1.7`](../../releases/tag/v0.1.7) | 2026-09-19 18:25 | `0.1.7` | `40ef40c` | The server directory is refreshed on every boot (31 / 30 files). Until now the bootstrap copied it only when `server.py` was missing, so every install kept the Python code of the release that created it and no server fix could reach an existing user — including 0.1.6's own `cli.py`. Also: shipped skills corrected against the code (four triggers, only two of which queue a prompt; `memoryPath` default), `confidence` written on facts only, and PR CI now runs the root build so the packaged layout is tested before release day. Current `latest`. |

Untagged on purpose: `3610064` (docs state of 0.1.0, pushed after its publish),
`861d54b` (central zone `~/.memories`), `1220f71` and the CI/doc commits before
`9878fce` — none published to npm; they ride along inside the next release tag.

## Pitfalls

- **pnpm `minimumReleaseAge` (3 days).** A freshly published version is not
  resolved by default, so an unpinned `dsh plugin add @luisarg/memory-mcp`
  silently installs the previous release. That is why the README pins an exact
  version. When bumping, keep the pin in sync or users get stale code.
- **Never retag a pushed tag.** Publishing is not reversible: `npm unpublish`
  is heavily restricted after 72 h. A wrong publish commit needs a new version,
  not a moved tag.
- **npm publish needs an OTP — in CI it doesn't.** The account has 2FA enabled
  for writes, so a *manual* `npm publish` (or an agent) fails with 401
  "You must provide a one-time pass" unless `--otp=<code>` is passed. The
  `~/.npmrc` token is enough for reads (`whoami` succeeds) and not for writes.
  The automated path needs none of this: OIDC Trusted Publishing is not a token
  and is not subject to the OTP prompt. Once the Trusted Publisher is configured
  on both packages, `~/.npmrc` should hold no publish token at all.
- **The registry is eventually consistent.** Right after a publish the plain
  `GET /@luisarg/<pkg>` can still serve metadata without the new version;
  `npm view <pkg>@<version>` or a cache-busted request is authoritative.
- **`gh` CLI is authenticated** (logged in as `Luisarg03` since 2026-09-12), so
  GitHub Releases can be created and red CI runs diagnosed with
  `gh run view <id> --log-failed`. Note the job-logs API is admin-only for
  other tools (/actions/jobs/<id>/logs → 403) and `gh` needs a writable cache:
  set `XDG_CACHE_HOME` to a path inside the workspace when the sandbox blocks
  `~/.cache/gh`.
