#!/usr/bin/env python3
"""Benchmark harness for memory/context retrieval latency (dsh-memory-vault).

Measures the retrieval hot paths identified in the performance investigation:

* warm per-tool latency at the MemoryStore layer: FTS queries, no-query scans,
  export, get_profile, list_tags, tag normalization (vocab read);
* write round trips (upsert + dedup) — ONLY on a vault copy;
* cold start: initialize() breakdown, integrity_check vs quick_check, and the
  full MCP stdio spawn -> ping handshake through launcher.mjs and the venv
  python;
* end-to-end /brain-style flows: local context retrieval + the external
  antecedents pass over every project.

By default every measurement runs on a COPY of the vault made on the same
filesystem, so the live vault is never touched. Pass --in-place to measure
against the vault directly (reads are read-only; initialize() opens the DB
read-write, hence the copy default).

Every op records its result count as an output signature so that baseline and
improved runs can be diffed for quality parity alongside speed.

Run:
    uv run --directory memory-vault-server python benchmarks/bench_retrieval.py
    uv run --directory memory-vault-server python \
        benchmarks/bench_retrieval.py --iterations 30 --json results.json
"""

from __future__ import annotations

import argparse
import json
import os
import selectors
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

import cli  # noqa: E402  (no import-time side effects)

DEFAULT_ITERATIONS = 30
HEAVY_DIVISOR = 6  # heavy ops run iterations//HEAVY_DIVISOR (min 3)


# ── stats ─────────────────────────────────────────────────────────────────


def _pct(samples: list[float], q: float) -> float:
    s = sorted(samples)
    idx = min(len(s) - 1, max(0, round(q * (len(s) - 1))))
    return s[idx]


def summarize(samples: list[float]) -> dict:
    return {
        "n": len(samples),
        "p50_ms": round(_pct(samples, 0.50), 3),
        "p95_ms": round(_pct(samples, 0.95), 3),
        "max_ms": round(max(samples), 3),
        "mean_ms": round(sum(samples) / len(samples), 3),
    }


def timed(fn, n: int, warmup: int = 2) -> tuple[dict, object]:
    out = None
    for _ in range(warmup):
        out = fn()
    samples: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        out = fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    stats = summarize(samples)
    try:
        stats["result_count"] = len(out) if out is not None else None
    except TypeError:
        stats["result_count"] = None
    return stats, out


# ── vault handling ────────────────────────────────────────────────────────


def copy_vault(src: Path, dst: Path) -> None:
    shutil.copytree(
        src,
        dst,
        ignore=shutil.ignore_patterns(".git", "tool-calls.log", "__pycache__"),
    )


def pick_busiest_project(vault: Path) -> str:
    """Project key with the most OKF files (same key rule as _iter_project_files)."""
    projects_dir = vault / "projects"
    counts: dict[str, int] = {}
    if not projects_dir.is_dir():
        return "bench-project"
    for md in projects_dir.rglob("*.md"):
        try:
            rel = md.relative_to(projects_dir)
        except ValueError:
            continue
        if len(rel.parts) < 3:
            continue
        key = "/".join(rel.parts[:-2])
        counts[key] = counts.get(key, 0) + 1
    return max(counts, key=counts.get) if counts else "bench-project"


def vault_stats(vault: Path) -> dict:
    projects_dir = vault / "projects"
    md_files = sum(1 for _ in projects_dir.rglob("*.md")) if projects_dir.is_dir() else 0
    db = vault / "memory.db"
    return {
        "md_files": md_files,
        "db_bytes": db.stat().st_size if db.exists() else 0,
    }


# ── MCP stdio handshake (cold start) ──────────────────────────────────────


def _read_json_line(proc, deadline: float, want_id: int | None):
    """Read newline-delimited JSON-RPC messages until the wanted id arrives."""
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    buf = ""
    while time.time() < deadline:
        events = sel.select(timeout=max(0.1, deadline - time.time()))
        if not events:
            continue
        chunk = os.read(proc.stdout.fileno(), 65536).decode("utf-8", "replace")
        if not chunk:
            break
        buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if want_id is None or msg.get("id") == want_id:
                return msg
    return None


def spawn_handshake(cmd: list[str], env: dict, timeout_s: float = 120.0) -> dict:
    """Spawn the MCP server and time spawn -> 'ping' tool result."""
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
    )
    try:
        deadline = time.time() + timeout_s
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "bench-retrieval", "version": "0"},
            },
        }
        proc.stdin.write(json.dumps(init_req) + "\n")
        proc.stdin.flush()
        if _read_json_line(proc, deadline, 1) is None:
            return {"ok": False, "error": "no initialize response"}
        proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            + "\n"
        )
        proc.stdin.flush()
        ping_req = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "ping", "arguments": {}},
        }
        proc.stdin.write(json.dumps(ping_req) + "\n")
        proc.stdin.flush()
        if _read_json_line(proc, deadline, 2) is None:
            return {"ok": False, "error": "no ping response"}
        return {"ok": True, "spawn_to_ping_ms": round((time.perf_counter() - t0) * 1000.0, 3)}
    finally:
        proc.kill()
        proc.wait()


# ── measurement sections ──────────────────────────────────────────────────


def _ids(out):
    """Extract result ids for parity diffs (list-of-dict results only)."""
    if isinstance(out, list):
        return [r.get("id") for r in out if isinstance(r, dict)]
    return None


def _clear_caches(store) -> None:
    """Reset parse + vocab caches so the next call is a true cold-cache first call."""
    sys.modules["store"]._parse_okf_file_cached.cache_clear()
    store._vocab_cache = None


def _first_call(fn) -> tuple[float, object]:
    """Time a single cold-cache call (clears caches first)."""
    t0 = time.perf_counter()
    out = fn()
    return (time.perf_counter() - t0) * 1000.0, out


def bench_warm(store, project: str, iterations: int, heavy: int, parity: dict | None = None) -> dict:
    ops: dict[str, dict] = {}
    light = [
        ("fts_short_or", lambda: store.search_entries(query="workflow memoria", max_results=50)),
        ("fts_words_and", lambda: store.search_entries(query="release ci", match="all", max_results=50)),
        ("fts_phrase", lambda: store.search_entries(query='"source of truth"', max_results=50)),
        ("fts_project", lambda: store.search_entries(query="release", project=project, max_results=20)),
        ("get_profile", lambda: store.get_profile(project)),
        ("normalize_query_tags", lambda: store._normalize_for_query(["ci", "release"])),
    ]
    heavy_ops = [
        ("scan_project_nq", lambda: store.search_entries(project=project)),
        ("scan_all_nq", lambda: store.search_entries(project=None)),
        ("export_project", lambda: store.export_entries(project)),
        ("list_tags_project", lambda: store.list_tags(project=project)),
        ("list_tags_all", lambda: store.list_tags()),
    ]
    for name, fn in light:
        print(f"  … {name}", file=sys.stderr)
        _clear_caches(store)
        first, _ = _first_call(fn)
        ops[name], out = timed(fn, iterations)
        ops[name]["first_ms"] = round(first, 3)
        if parity is not None and (ids := _ids(out)) is not None:
            parity[name] = ids
    for name, fn in heavy_ops:
        print(f"  … {name} (n={heavy})", file=sys.stderr)
        _clear_caches(store)
        first, _ = _first_call(fn)
        ops[name], out = timed(fn, heavy, warmup=1)
        ops[name]["first_ms"] = round(first, 3)
        if parity is not None and (ids := _ids(out)) is not None:
            parity[name] = ids
    return ops


def bench_writes(store, heavy: int) -> dict:
    ops: dict[str, dict] = {}
    counter = {"i": 0}

    def upsert_new():
        counter["i"] += 1
        return store.upsert_entry(
            "fact", "bench-project", f"bench content {counter['i']} {time.time_ns()}",
            tags=["bench"],
        )

    fixed = f"bench fixed content {time.time_ns()}"

    def upsert_dedup():
        return store.upsert_entry("fact", "bench-project", fixed, tags=["bench"])

    upsert_dedup()  # create the fixed entry before timing the dedup path
    print("  … upsert_new", file=sys.stderr)
    ops["upsert_new"], _ = timed(upsert_new, heavy, warmup=1)
    print("  … upsert_dedup", file=sys.stderr)
    ops["upsert_dedup"], _ = timed(upsert_dedup, heavy, warmup=1)
    return ops


def bench_cold(work_vault: Path, runner_cmd: list[str], env: dict, iterations: int) -> dict:
    out: dict = {}
    print("  … initialize (full)", file=sys.stderr)
    inits = []
    for _ in range(3):
        s = store.MemoryStore(work_vault)
        t0 = time.perf_counter()
        s.initialize()
        inits.append((time.perf_counter() - t0) * 1000.0)
        s.db.close()
    out["initialize"] = {"samples_ms": [round(x, 3) for x in inits]}
    for pragma in ("integrity_check", "quick_check"):
        samples = []
        for _ in range(3):
            conn = sqlite3.connect(str(work_vault / "memory.db"), timeout=30)
            t0 = time.perf_counter()
            conn.execute(f"PRAGMA {pragma}").fetchone()
            samples.append((time.perf_counter() - t0) * 1000.0)
            conn.close()
        out[pragma] = {"samples_ms": [round(x, 3) for x in samples]}
    print("  … spawn handshake (launcher.mjs)", file=sys.stderr)
    hs = [spawn_handshake(runner_cmd, env) for _ in range(max(2, iterations // 10))]
    out["spawn_launcher"] = {
        "ok": all(h["ok"] for h in hs),
        "samples_ms": [h.get("spawn_to_ping_ms") for h in hs],
    }
    venv_py = SERVER_DIR / ".venv" / "bin" / "python"
    if venv_py.exists():
        print("  … spawn handshake (venv python direct)", file=sys.stderr)
        hs2 = [spawn_handshake([str(venv_py), "server.py"], env) for _ in range(max(2, iterations // 10))]
        out["spawn_venv"] = {
            "ok": all(h["ok"] for h in hs2),
            "samples_ms": [h.get("spawn_to_ping_ms") for h in hs2],
        }
    return out


def bench_flows(store, project: str, all_projects: list[str], heavy: int) -> dict:
    out: dict = {}
    print("  … brain_local_flow", file=sys.stderr)

    def brain_local():
        a = store.get_profile(project)
        b = store.search_entries(project=project, query="workflow memoria", max_results=5)
        c = store.export_entries(project)
        return {"profile": len(a), "search": len(b), "export": len(c)}

    out["brain_local_flow"], res = timed(brain_local, max(3, heavy // 2), warmup=1)
    out["brain_local_flow"]["signature"] = res

    print(f"  … external_pass ({len(all_projects)} projects)", file=sys.stderr)

    def external_pass():
        total = 0
        for p in all_projects:
            total += len(store.export_entries(p))
        return {"total": total}

    # Cold-cache first pass (what a fresh session pays), then warm samples.
    _clear_caches(store)
    first, res = _first_call(external_pass)
    out["external_pass"], res = timed(external_pass, max(1, heavy // 4), warmup=1)
    out["external_pass"]["first_ms"] = round(first, 3)
    out["external_pass"]["signature"] = res
    return out


# ── main ──────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vault", help="vault root (default: cli.get_memory_path())")
    ap.add_argument("--project", help="project key to focus on (default: busiest)")
    ap.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    ap.add_argument("--in-place", action="store_true", help="measure against the vault directly")
    ap.add_argument("--skip-cold", action="store_true")
    ap.add_argument("--skip-writes", action="store_true")
    ap.add_argument("--skip-flows", action="store_true")
    ap.add_argument("--json", help="explicit results JSON path")
    ap.add_argument(
        "--parity-ids",
        help="dump {op: [result ids]} to this JSON for baseline-vs-change parity diffs",
    )
    args = ap.parse_args()

    live_vault = Path(args.vault) if args.vault else cli.get_memory_path()
    if not live_vault.is_dir():
        print(f"ERROR: vault not found: {live_vault}", file=sys.stderr)
        return 1

    work_vault = live_vault
    tmp_dir = None
    if not args.in_place:
        tmp_dir = tempfile.mkdtemp(prefix="mem-bench-", dir=str(SERVER_DIR.parent))
        work_vault = Path(tmp_dir) / "vault"
        print(f"Copying vault {live_vault} → {work_vault} …", file=sys.stderr)
        copy_vault(live_vault, work_vault)
    else:
        print(f"WARNING: --in-place opens {live_vault}/memory.db read-write", file=sys.stderr)

    # store.py resolves the type registry from MEMORY_PATH at import time.
    os.environ["MEMORY_PATH"] = str(work_vault)
    global store
    import store  # noqa: PLC0415  (must follow MEMORY_PATH)

    project = args.project or pick_busiest_project(work_vault)
    heavy = max(3, args.iterations // HEAVY_DIVISOR)
    stats = vault_stats(work_vault)
    results: dict = {
        "meta": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "vault_source": str(live_vault),
            "vault_mode": "copy" if tmp_dir else "in-place",
            "project": project,
            "iterations": args.iterations,
            "heavy_iterations": heavy,
            **stats,
        }
    }

    print("== warm ops ==", file=sys.stderr)
    st = store.MemoryStore(work_vault)
    st.initialize()
    parity_ids: dict = {}
    results["warm"] = bench_warm(st, project, args.iterations, heavy, parity_ids)

    if not args.skip_writes:
        print("== writes (copy only) ==", file=sys.stderr)
        results["writes"] = bench_writes(st, heavy)

    if not args.skip_flows:
        print("== /brain flows ==", file=sys.stderr)
        all_projects = sorted(
            {k for k, _ in st._iter_project_files(None, None, [])}
        )
        results["flows"] = bench_flows(st, project, all_projects, heavy)

    if not args.skip_cold:
        print("== cold start ==", file=sys.stderr)
        env = dict(os.environ)
        node = shutil.which("node") or "node"
        launcher = str(SERVER_DIR / "launcher.mjs")
        results["cold"] = bench_cold(
            work_vault, [node, launcher], env, args.iterations
        )

    st.db.close()
    results_path = Path(args.json) if args.json else (
        SERVER_DIR / "benchmarks" / "results"
        / f"bench-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    )
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    if args.parity_ids:
        Path(args.parity_ids).write_text(json.dumps(parity_ids, indent=2), encoding="utf-8")

    # markdown report to stdout
    print(f"# bench_retrieval — {results['meta']['timestamp']}")
    print(f"vault: {results['meta']['vault_mode']} of {results['meta']['vault_source']} "
          f"({stats['md_files']} md files, {stats['db_bytes'] // 1024} KiB db), project={project}")
    print()
    print("| op | n | p50 ms | p95 ms | max ms | first ms | results |")
    print("|---|---|---|---|---|---|---|")
    for section in ("warm", "writes", "flows"):
        for name, s in results.get(section, {}).items():
            first = s.get("first_ms", "")
            print(f"| {section}.{name} | {s['n']} | {s['p50_ms']} | {s['p95_ms']} | "
                  f"{s['max_ms']} | {first} | {s.get('result_count')} |")
    for name, s in results.get("cold", {}).items():
        samples = [x for x in s.get("samples_ms", []) if x is not None]
        if samples:
            print(f"| cold.{name} | {len(samples)} | {_pct(samples, 0.5):.1f} | "
                  f"{_pct(samples, 0.95):.1f} | {max(samples):.1f} | | |")
    print()
    print(f"results JSON: {results_path}")

    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
