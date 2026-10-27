#!/usr/bin/env python3
"""Self-check: scoped walks and retrieval caches never change results.

Regression guard for the retrieval performance work (docs/perf-retrieval.md):
the no-query scan was sped up by (a) scoping the walk to the project subtree,
(b) caching OKF parses by (mtime_ns, size) and the read-only vocabulary by
(mtime_ns, size), and (c) replacing pathlib relative_to with plain-string key
math. Each must produce byte-identical results to the old full-vault rglob,
and every cache must invalidate exactly when the file on disk changes.

Run: python3 memory-vault-server/test_retrieval_caches.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
REPO_VAULT = SERVER_DIR.parent / "memory-vault"
sys.path.insert(0, str(SERVER_DIR))

OKF = (
    "---\n"
    "type: Fact\n"
    "project: {project}\n"
    "tags: {tags}\n"
    "timestamp: {ts}\n"
    "---\n"
    "{body}\n"
)


def write_entry(root: Path, rel: str, project: str, tags: list[str], ts: str, body: str):
    p = root / "projects" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        OKF.format(project=project, tags=json.dumps(tags), ts=ts, body=body),
        encoding="utf-8",
    )
    return p


def reference_scan(projects_dir: Path, wanted: set[str]):
    """The pre-optimization walk, reimplemented here on purpose."""
    out = []
    for md in sorted(projects_dir.rglob("*.md")):
        rel = md.relative_to(projects_dir)
        if len(rel.parts) < 3 or rel.parts[-2] not in wanted:
            continue
        out.append(("/".join(rel.parts[:-2]), str(md)))
    return out


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp)
        (vault / "projects").mkdir()
        shutil.copy(REPO_VAULT / "type-registry.yaml", vault / "type-registry.yaml")
        os.environ["MEMORY_PATH"] = str(vault)
        import store as store_mod

        s = store_mod.MemoryStore(storage_path=vault)
        s.initialize()
        wanted = set(store_mod._TYPE_DIR_MAP.values())

        # ── layout: ordering tripwire + skipped strays ────────────────────
        # "x/y/..." sorts BEFORE "x.y/..." by pathlib parts but AFTER it by
        # plain string compare; only the parts order is acceptable.
        write_entry(vault, "x/y/facts/nested.md", "x/y", ["alpha"], "2026-10-27T10:00:00", "nested")
        write_entry(vault, "x.y/facts/dotted.md", "x.y", ["alpha"], "2026-10-27T10:00:00", "dotted")
        write_entry(vault, "foo/facts/zz.md", "foo", ["alpha"], "2026-10-27T11:00:00", "newest")
        write_entry(vault, "foo/facts/aa.md", "foo", ["beta"], "2026-10-27T09:00:00", "oldest-a")
        write_entry(vault, "foo/facts/Big.md", "foo", ["alpha", "beta"], "2026-10-27T09:00:00", "oldest-b")
        write_entry(vault, "foo/facts/sub/deep.md", "foo", ["alpha"], "2026-10-27T12:00:00", "deep")
        write_entry(vault, "foo/loose.md", "foo", ["alpha"], "2026-10-27T12:00:00", "loose")
        write_entry(vault, "foo/notes/stray.md", "foo", ["alpha"], "2026-10-27T12:00:00", "stray")

        projects_dir = vault / "projects"

        # ── 1. walk equivalence with the old sorted(rglob) scan ──────────
        ref = reference_scan(projects_dir, wanted)
        got = [(k, str(p)) for k, p in s._iter_project_files(None, None, [])]
        assert got == ref, f"walk mismatch:\n got={got}\n ref={ref}"
        assert [k for k, _ in got] == ["foo", "foo", "foo", "x/y", "x.y"], got

        # ── 2. scoped scan == filter of the full scan, order preserved ───
        for key in ["foo", "x/y", "x.y", "org", "no-such"]:
            ref_k = [x for x in ref if x[0] == key]
            got_k = [(k, str(p)) for k, p in s._iter_project_files(key, None, [])]
            assert got_k == ref_k, f"scoped mismatch for {key}:\n got={got_k}\n ref={ref_k}"
        assert [(k, str(p)) for k, p in s._iter_project_files("foo", "fact", [])] == \
            [x for x in ref if x[0] == "foo"]

        # Keys that would escape projects/ must select nothing.
        for bad in ["..", "../evil", "/etc", "foo/../../bar"]:
            assert list(s._iter_project_files(bad, None, [])) == [], bad

        # ── 3. no-query search: updated_at desc, walk order breaks ties ──
        ids = [e["id"] for e in s.search_entries(project="foo")]
        assert ids == ["zz", "Big", "aa"], ids
        ids_all = [e["id"] for e in s.search_entries(project=None)]
        assert ids_all == ["zz", "nested", "dotted", "Big", "aa"], ids_all

        # ── 4. parse cache: copies out, invalidates on change ────────────
        p = projects_dir / "foo" / "facts" / "zz.md"
        e1 = store_mod._parse_okf_file(p)
        e2 = store_mod._parse_okf_file(str(p))  # str form must work too
        assert e1 == e2 and e1 is not e2, "cached parse must return fresh copies"
        e1["project"] = "MUTATED"
        e1["content"] = "MUTATED"
        assert store_mod._parse_okf_file(p)["project"] == "foo", "cache leaked mutation"
        assert store_mod._parse_okf_file(p)["content"] == "newest", "cache leaked mutation"

        # Hand-edit (auto mtime) is visible on the next parse.
        p.write_text(p.read_text(encoding="utf-8").replace("newest", "edited"), encoding="utf-8")
        assert store_mod._parse_okf_file(p)["content"] == "edited", "mtime invalidation failed"

        # Same-size edit with a forced distinct mtime is also visible.
        text = p.read_text(encoding="utf-8")
        p.write_text(text.replace("edited", "edit-2"), encoding="utf-8")
        st = p.stat()
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1))
        assert store_mod._parse_okf_file(p)["content"] == "edit-2", "utime invalidation failed"

        p.unlink()
        assert store_mod._parse_okf_file(p) is None, "deleted file must parse to None"

        # ── 5. vocabulary cache: aliases resolve, never stale ────────────
        vpath = vault / "tag-vocabulary.json"

        def set_vocab(data: dict):
            vpath.write_text(json.dumps(data), encoding="utf-8")
            st = vpath.stat()
            os.utime(vpath, ns=(st.st_atime_ns, st.st_mtime_ns + 1))

        set_vocab({"canonical": {"release": {"aliases": ["rel"], "description": ""}}})
        canon, new = s._normalize_for_query(["rel", "ci"])
        assert canon == ["release", "ci"] and new == ["ci"], (canon, new)

        # An alias added afterwards must be picked up (mtime invalidation).
        set_vocab({"canonical": {"release": {"aliases": ["rel", "r2"], "description": ""}}})
        canon, new = s._normalize_for_query(["r2"])
        assert canon == ["release"] and new == [], (canon, new)

        # Missing vocabulary caches as empty but keeps working.
        vpath.unlink()
        canon, new = s._normalize_for_query(["fresh-tag"])
        assert canon == ["fresh-tag"] and new == ["fresh-tag"], (canon, new)

        # Corrupt vocabulary is a hard error on EVERY call (no negative cache).
        vpath.write_text("{ not json", encoding="utf-8")
        for attempt in (1, 2):
            try:
                s._normalize_for_query(["fresh-tag"])
            except store_mod.VocabularyError:
                pass
            else:
                raise AssertionError(f"corrupt vocabulary not rejected (call {attempt})")
        vpath.unlink()

        # ── 6. list_tags counts come from Markdown (source of truth) ─────
        # list_tags lists vocabulary tags only, so seed the catalog first.
        set_vocab({
            "canonical": {
                "alpha": {"aliases": [], "description": ""},
                "beta": {"aliases": [], "description": ""},
                "gamma": {"aliases": [], "description": ""},
            }
        })
        counts = s.list_tags(project="foo")["tags"]
        counted = {t["name"]: t["count"] for t in counts}
        # zz is gone; Big.md keeps alpha+beta; aa.md has beta.
        assert counted == {"alpha": 1, "beta": 2}, counted

        # A hand-edit to a tag line shows up without any store write.
        aa = projects_dir / "foo" / "facts" / "aa.md"
        aa.write_text(
            aa.read_text(encoding="utf-8").replace('"beta"', '"gamma"'),
            encoding="utf-8",
        )
        counted = {t["name"]: t["count"] for t in s.list_tags(project="foo")["tags"]}
        assert counted == {"alpha": 1, "beta": 1, "gamma": 1}, counted

        s._db.close()

    print("ok: scoped walks and retrieval caches match the source of truth")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
