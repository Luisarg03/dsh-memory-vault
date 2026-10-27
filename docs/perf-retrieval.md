# Memory retrieval performance — benchmark-driven results

Date: 2026-10-27. Every number below comes from
`benchmarks/bench_retrieval.py` run against a **copy** of a real vault
(3,864 OKF markdown files under `projects/`, 56 projects, `memory.db`
5,396 KiB; busiest project = `ArchCustomWidgets`, 626 files). Writes are
never exercised against the live vault: `MemoryStore.initialize()` opens
the DB read-write, so the harness copies the vault first.

Reproduce:

```bash
cd memory-vault-server
UV_CACHE_DIR=/tmp/uv-cache uv run python benchmarks/bench_retrieval.py \
  --iterations 30 \
  --json benchmarks/results/bench-baseline.json \
  --parity-ids benchmarks/results/parity-baseline.json
```

Methodology: `time.perf_counter`, light ops n=30, heavy (scan/export) ops
n=5, cold start n=3. `p50`/`p95` are steady-state ("warm") in a long-lived
process — the MCP server lives for the whole session, so warm is what a
session pays after its first call. `first` is the cold-cache cost of the
first call (parse + vocabulary caches cleared first) — what a fresh
session pays. The baseline had no caches, so its numbers are both.

Adoption bar agreed up front: a change is adopted only if it improves
p50/p95 by ≥10 % (or ≥50 ms absolute on a hot p95) **and** produces zero
result diffs (id-by-id parity on the real vault + equivalence suite).

## Baseline → final

`bench-baseline.json` (before) vs `bench-after-1.3b.json` (after), p50 ms.

| op | baseline p50 | final p50 | final p95 | final first | speed-up |
|---|---|---|---|---|---|
| `fts_short_or` | 0.240 | 0.280 | 0.422 | 0.728 | n/a (noise) |
| `fts_words_and` | 0.069 | 0.073 | 0.093 | 0.110 | n/a (noise) |
| `fts_phrase` | 0.194 | 0.202 | 0.305 | 0.268 | n/a (noise) |
| `fts_project` | 0.040 | 0.039 | 0.045 | 0.097 | n/a (noise) |
| `get_profile` | 0.012 | 0.012 | 0.014 | 0.044 | unchanged |
| `normalize_query_tags` | 0.429 | 0.246 | 0.258 | 1.025 | 1.7× |
| `scan_project_nq` | 103.9 | 2.34 | 2.47 | 18.8 | 44× |
| `scan_all_nq` | 163.1 | 16.1 | 18.3 | 99.7 | 10× |
| `export_project` | 104.1 | 2.36 | 2.37 | 14.8 | 44× |
| `list_tags_project` | 103.3 | 3.16 | 3.21 | 16.1 | 33× |
| `list_tags_all` | 164.3 | 19.7 | 22.4 | 97.7 | 8× |
| `writes.upsert_new` | 4.00 | 3.38 | 3.96 | — | ~unchanged |
| `writes.upsert_dedup` | 4.52 | 4.27 | 5.16 | — | ~unchanged |
| `flows.brain_local_flow` | 105.0 | 2.50 | 2.59 | — | 42× |
| `flows.external_pass` (55 projects) | 5,108 | 16.7 | — | 96.4 | 306× |
| `cold.initialize` | 13.5 | 13.5 | 14.0 | — | unchanged |
| `cold.spawn_launcher` | 375.7 | 388.6 | 394.2 | — | unchanged |
| `cold.spawn_venv` | 344.5 | 351.9 | 355.9 | — | unchanged |

Result-count parity: `parity-baseline.json` vs `parity-after-1.3b.json`
— identical result id lists in all 8 result-producing ops.

## What was slow (diagnosis)

1. **Every no-query retrieval walked the whole vault.**
   `search_entries` without a query (and `export_memories`, `list_tags`)
   iterated `sorted(projects_dir.rglob("*.md"))` — all 3,864 files even
   when the filter selected one project — then parsed each file's YAML
   frontmatter on every call. The `/brain` external pass does this once
   per project: 55 × ~93 ms ≈ 5.1 s.
2. **Per-file pathlib `relative_to` dominated the scan.** cProfile:
   `Path.relative_to`/`is_relative_to` accounted for the bulk of the
   per-file cost (~27 µs/file) in the key computation.
3. **Vocabulary and OKF frontmatter were re-read/re-parsed per call.**
   `load_vocabulary` on every tag-carrying query/store, YAML parse per
   file per retrieval.

FTS queries, `get_profile`, and writes were already fast (<0.3 ms /
~4 ms) and were left alone.

## Changes

All in `memory-vault-server/store.py`; tool contracts untouched.

1. **Scoped walk** (`_iter_project_files`): a `project` filter now walks
   only `projects/<project>/`. The `key == project` filter is unchanged,
   so nested keys (`org/repo`) and nested siblings (`projects/org`
   containing `projects/org/repo`) behave exactly as before; keys that
   would escape `projects/` (`..`, absolute) select nothing.
2. **Parse cache**: `_parse_okf_file` is fronted by
   `@lru_cache(maxsize=50000) _parse_okf_file_cached(path_str, mtime_ns, size)`.
   Any writer (store, hand-edit, backup restore) changes mtime/size, so
   the next read parses fresh. Returns a shallow copy per call —
   call-sites mutate results (`entry["project"] = key`) and must not
   corrupt the cache. `maxsize` bounds memory (≈3.9k files today).
3. **Read-only vocabulary cache** (`MemoryStore._vocab_readonly`): keyed
   by `(mtime_ns, size)` of `tag-vocabulary.json`; missing file caches
   the empty catalog, a corrupt file stays a hard error on every call
   (never negative-cached). Only query-side normalization and
   `list_tags` use it — every registering write path still loads fresh,
   because `normalize_tags(..., register=True)` mutates the catalog.
4. **String-key walk**: path→project-key math now uses plain string
   slicing/splitting instead of `Path.relative_to`. Sort order is
   identical: `Path.__lt__` compares `str(p).split(sep)` tuples, and
   every path shares the `projects/` prefix, so comparing the suffix is
   equivalent on the case-sensitive filesystems the vault requires
   (fcntl locks). Verified by parity + the order-tripwire test.

## Decisions (candidate → evidence → verdict)

| candidate | evidence | verdict |
|---|---|---|
| 1.1 scope no-query glob to project | 104.1 → 2.36 ms `export_project`; external pass 5,108 → 16.7 ms; 0 parity diffs | **adopted** |
| 1.2 parse + vocab caches (mtime, size) | `normalize_query_tags` 0.429 → 0.246 ms; enables 44× warm scans; hand-edit invalidation tested | **adopted** |
| 1.3 string-key walk (drop `relative_to`) | `scan_all_nq` 163.1 → 16.1 ms (10×), `list_tags_all` 164.3 → 19.7 ms; 0 parity diffs | **adopted** |
| 1.3b `list_tags` counts via SQL `json_each` | would diverge from Markdown (the source of truth) after hand edits — a quality regression; file walk is now 3.2–19.7 ms | **rejected** |
| 1.4a `integrity_check` → `quick_check`/opt-in | saves 2.7 ms of 13.5 ms on `initialize` (0.8 % of the ~355 ms spawn) and loses boot-time corruption detection | **rejected** |
| 1.4b launcher prefers `.venv` over `uv run` | 388.6 vs 351.9 ms = 36.7 ms (9.5 %) — below the bar; also drops `uv run`'s env sync with `uv.lock` | **rejected** |
| 1.5 cheaper `_log_tool_call` | measured p50 0.013 ms / p95 0.014 ms over 2,000 calls — noise | **rejected** |
| 1.6 FTS `ANALYZE`/optimize | every FTS op < 0.3 ms p95 already | **rejected** |
| 1.7 batch the `/brain` external pass at the skill level | external pass is now 96 ms first / 17 ms warm — no longer a bottleneck; skill contract stays untouched | **not needed** |

## Quality guards (why speed did not cost correctness)

- **Result parity**: id-by-id diff of every result-producing op on the
  real vault copy, before vs after (`benchmarks/results/parity-*.json`).
- **Equivalence suite** `test_retrieval_caches.py`: walk order equals the
  old `sorted(Path.rglob)` order (including the `x/y/` vs `x.y/` ordering
  tripwire and tie-breaks in `updated_at` sorts); scoped scan equals
  filter-of-full-scan; escape keys select nothing; parse cache returns
  fresh copies and invalidates on mtime change; vocabulary cache
  invalidates, tolerates a missing file, and raises on corrupt JSON every
  call; `list_tags` counts follow hand-edited Markdown.
- **Existing suites**: `test_get_profile.py`, `test_tags_maintenance.py`
  (24 contract checks), `pnpm -r test` (99 tests, includes tags contract
  integration against a real vault server over stdio) — all green.

## Files

- `memory-vault-server/store.py` — the four changes above.
- `memory-vault-server/benchmarks/bench_retrieval.py` — the harness
  (warm/first/cold measurements, `--parity-ids` id capture).
- `memory-vault-server/test_retrieval_caches.py` — equivalence suite.
- `benchmarks/results/bench-*.json`, `benchmarks/results/parity-*.json`
  — raw measurements and parity snapshots.
