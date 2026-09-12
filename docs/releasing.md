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

1. Bump `version` in **both** `packages/memory-mcp/package.json` and
   `packages/memory-auto/package.json` — same version in a single commit.
2. `pnpm -r build && pnpm -r test` (CI runs both on `main`, plus a server
   import check under `uv`).
3. Publish from the repo root:
   ```sh
   pnpm --filter @luisarg/memory-mcp publish --access public --no-git-checks
   pnpm --filter @luisarg/memory-auto publish --access public --no-git-checks
   ```
   `prepare` runs `tsdown` + `scripts/bundle-assets.mjs`, so the tarball ships
   `dist/`, the Python server and the vault starter. Verify with
   `npm view @luisarg/memory-mcp dist.fileCount` (expect >20, not 7).
4. Tag the publish commit (step 1) and push the tag.
5. Bump the pinned install line in the root [README](../README.md#install) if
   the documented version changed.

## Released versions

| Tag | Published (UTC) | npm | Publish commit | Notes |
|---|---|---|---|---|
| [`v0.1.0`](../../releases/tag/v0.1.0) | 2026-09-03 15:30 | `0.1.0` | `3141e9e` | First publish; scope rename `@dsh-memory` → `@luisarg`. Tarball without `server/` (7 files). Live ~9 h. |
| [`v0.1.1`](../../releases/tag/v0.1.1) | 2026-09-04 00:38 | `0.1.1` | `a1ccb5f` | Self-contained tarballs (25 files): Python server + vault starter bundled, first-boot bootstrap. Requires `uv`. |
| [`v0.1.2`](../../releases/tag/v0.1.2) | 2026-09-07 16:32 | `0.1.2` | `930b7f7` | `launcher.mjs` falls back to a pip venv when `uv` is absent (27 files). Current `latest`. |

Untagged on purpose: `3610064` (docs state of 0.1.0, pushed after its publish)
and `861d54b` (central zone `~/.memories` — not published to npm; it will ride
along with the next release tag).

## Pitfalls

- **pnpm `minimumReleaseAge` (3 days).** A freshly published version is not
  resolved by default, so an unpinned `dsh plugin add @luisarg/memory-mcp`
  silently installs the previous release. That is why the README pins an exact
  version. When bumping, keep the pin in sync or users get stale code.
- **Never retag a pushed tag.** Publishing is not reversible: `npm unpublish`
  is heavily restricted after 72 h. A wrong publish commit needs a new version,
  not a moved tag.
- **`gh` CLI auth is currently invalid** on this machine (`gh api` → 401), so
  GitHub Releases cannot be created from here until `gh auth login`.
  Tags are plain git refs and push without GitHub auth.
