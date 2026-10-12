#!/usr/bin/env python3
"""Contract checks: tags authority, list_tags, search filters, maintenance ops.

Covers alias/invalid/new-tag registration, persistence across restarts,
failure rollback, tag union, missing/ambiguity fail-closed, exclusions,
source opt-in, query/tags OR, nested projects, profiles in export,
update_memory_tags revisions, source content preservation, backup/restore and
rebuild id/profile preservation. Temp vaults only — never the real vault.

Run: uv run --directory memory-vault-server python test_tags_maintenance.py
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

PASSED: list[str] = []


def check(name: str, fn) -> None:
    fn()
    PASSED.append(name)
    print(f"  ok: {name}")


def make_vault(tmp: str) -> Path:
    vault = Path(tmp) / "vault"
    vault.mkdir()
    (vault / "projects").mkdir()
    shutil.copy(REPO_VAULT / "type-registry.yaml", vault / "type-registry.yaml")
    shutil.copy(REPO_VAULT / "tag-vocabulary.json", vault / "tag-vocabulary.json")
    os.environ["MEMORY_PATH"] = str(vault)
    for mod in ("store", "server", "rebuild_index", "vault_ops"):
        sys.modules.pop(mod, None)
    return vault


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        vault = make_vault(tmp)
        import store as store_mod

        new_store = lambda: store_mod.MemoryStore(storage_path=vault)

        s = new_store()
        s.initialize()
        r1 = s.upsert_entry("decision", "proj", "Use sqlite for storage",
                            tags=["Architecture", "sqlite"])
        r2 = s.upsert_entry("fact", "proj", "Python 3.11 is required",
                            tags=["arch", "python"])
        s.upsert_profile(project="proj", content="PROFILE: python",
                         tags=["Python"])
        src = s.store_source(url="https://x.test/a", title="T", description="D",
                             source_kind="link", tags=["arch"])
        nested = s.upsert_entry("decision", "org/repo", "Nested project choice",
                                tags=["ci"])

        def t_alias():
            assert r1["tags"] == ["architecture", "database"], r1["tags"]
            assert r2["tags"] == ["architecture", "python"], r2["tags"]
            assert src["tags"] == ["architecture"], src["tags"]

        def t_invalid():
            try:
                s.upsert_entry("fact", "proj", "Bad tag probe",
                               tags=["BAD TAG!"])
            except store_mod.VocabularyError:
                return
            raise AssertionError("invalid tag accepted")

        def t_new_tag():
            r = s.upsert_entry("fact", "proj", "A brand new topic",
                               tags=["wayfinding"])
            assert r["new_tags"] == ["wayfinding"], r
            vocab = json.loads((vault / "tag-vocabulary.json").read_text())
            assert "wayfinding" in vocab["canonical"], "not persisted"

        def t_restart():
            s2 = new_store()
            s2.initialize()
            got = s2.search_entries(project="proj", query="wayfinding")
            assert len(got) == 1, got
            c, _ = s2._normalize_for_query(["wayfinding"])
            assert c == ["wayfinding"], "vocab did not survive restart"

        def t_queries_no_write():
            before = (vault / "tag-vocabulary.json").read_text()
            s.search_entries(query="never-seen-q")
            s.list_tags(query="never-seen-q")
            s._normalize_for_query(["never-seen-q"])
            assert (vault / "tag-vocabulary.json").read_text() == before

        def t_union():
            # Re-store same content: union, []/None never deletes.
            u = s.upsert_entry("decision", "proj", "Use sqlite for storage",
                               tags=["python"])
            assert u["tags"] == ["architecture", "database", "python"], u["tags"]
            u2 = s.upsert_entry("decision", "proj", "Use sqlite for storage",
                                tags=[])
            assert u2["tags"] == u["tags"], (u2["tags"], u["tags"])
            u3 = s.upsert_entry("decision", "proj", "Use sqlite for storage")
            assert u3["tags"] == u["tags"], (u3["tags"], u["tags"])

        def t_failure_rollback():
            (vault / "tag-vocabulary.json").write_text("{corrupt!")
            try:
                s.upsert_entry("fact", "proj", "Rollback probe", tags=["x"])
            except store_mod.VocabularyError:
                pass
            else:
                raise AssertionError("corrupt vocab accepted")
            assert s.search_entries(project="proj", query="Rollback probe") == []
            shutil.copy(REPO_VAULT / "tag-vocabulary.json",
                        vault / "tag-vocabulary.json")

        def t_exclusions():
            assert s.search_entries(query="sqlite",
                                    exclude_projects=["proj"]) == []
            assert s.search_entries(query="sqlite",
                                    exclude_projects=["other"]) != []
            # Exclusions are EXACT full keys: "org" must not drop "org/repo".
            assert s.search_entries(query="Nested",
                                    exclude_projects=["org"]) != []
            assert s.search_entries(query="Nested",
                                    exclude_projects=["org/repo"]) == []
            kept = s.list_tags(exclude_projects=["proj", "org"])
            assert {t["name"] for t in kept["tags"]} == {"ci-cd"}, kept
            assert s.list_tags(exclude_projects=["proj", "org/repo"]) == {
                "tags": [], "truncated": False}

        def t_source_optin():
            # Default search (query or scan) never leaks sources or profiles.
            assert all(r["entry_type"] not in ("source", "profile")
                       for r in s.search_entries(query="arch"))
            assert all(r["entry_type"] not in ("source", "profile")
                       for r in s.search_entries(tags=["architecture"]))
            got = s.search_entries(entry_type="source", query="architecture")
            assert len(got) == 1 and got[0]["entry_type"] == "source", got
            scan = s.search_entries(entry_type="source")
            assert any(r["entry_type"] == "source" for r in scan), scan
            many = s.search_entries(tags=["architecture"])
            assert len(many) <= 50
            try:
                s.search_entries(entry_type="source", project="proj")
            except ValueError:
                pass
            else:
                raise AssertionError("source+project accepted")

        def t_or_semantics():
            # Query tokens OR: each term hits a different entry.
            hits = s.search_entries(query="sqlite wayfinding")
            assert {r["content"] for r in hits} >= {
                "Use sqlite for storage", "A brand new topic"}, hits
            # Tags OR over canonical tags.
            thits = s.search_entries(tags=["database", "python"])
            assert len(thits) >= 2, thits

        def t_nested():
            assert nested["tags"] == ["ci-cd"], nested["tags"]  # alias
            hits = s.search_entries(project="org/repo")
            assert len(hits) == 1 and hits[0]["project"] == "org/repo", hits
            counts = {t["name"]: t["count"]
                      for t in s.list_tags(project="org/repo")["tags"]}
            assert counts.get("ci-cd") == 1, counts

        def t_export_profiles():
            types = {r["entry_type"] for r in s.export_entries(project="proj")}
            assert "profile" in types and "source" not in types, types

        def t_list_tags_order():
            top = s.list_tags(query="arch")["tags"]
            assert [t["name"] for t in top] == ["architecture"], top
            page = s.list_tags(limit=1)
            assert page["truncated"] is True and len(page["tags"]) == 1
            full = s.list_tags()
            assert full["truncated"] is True
            assert any(t["count"] == 0 for t in full["tags"]), "no zero-count"
            try:
                s.list_tags(limit=99)
            except ValueError:
                pass
            else:
                raise AssertionError("limit range not enforced")

        def t_ambiguous_alias():
            vocab = json.loads((vault / "tag-vocabulary.json").read_text())
            vocab["canonical"]["clone-a"] = {"aliases": ["dup-alias"]}
            vocab["canonical"]["clone-b"] = {"aliases": ["dup-alias"]}
            (vault / "tag-vocabulary.json").write_text(json.dumps(vocab))
            try:
                s.list_tags(query="dup-alias")
            except store_mod.VocabularyError:
                pass
            else:
                raise AssertionError("ambiguous alias accepted")
            shutil.copy(REPO_VAULT / "tag-vocabulary.json",
                        vault / "tag-vocabulary.json")

        def t_maintenance_memory():
            entry_id = r1["id"]
            dry = s.update_memory_tags(project="proj", entry_type="decision",
                                       entry_id=entry_id, tags=["fresh-tag"])
            assert dry["dry_run"] and not dry["applied"]
            assert dry["before"] != dry["after"] and dry["after"] == ["fresh-tag"]
            assert dry["new_tags"] == [], "dry run must not register"
            try:
                s.update_memory_tags(project="proj", entry_type="decision",
                                     entry_id=entry_id, tags=["fresh-tag"],
                                     dry_run=False, expected_revision="stale")
            except RuntimeError:
                pass
            else:
                raise AssertionError("stale revision accepted")
            applied = s.update_memory_tags(
                project="proj", entry_type="decision", entry_id=entry_id,
                tags=["fresh-tag"], dry_run=False,
                expected_revision=dry["revision"])
            assert applied["applied"] and applied["new_tags"] == ["fresh-tag"]
            assert applied["revision"] != dry["revision"]
            # Body + file/DB agreement preserved.
            row = s.db.execute("SELECT * FROM entries WHERE id = ?",
                               (entry_id,)).fetchone()
            assert row["content"] == "Use sqlite for storage", row["content"]
            assert json.loads(row["tags"]) == ["fresh-tag"]
            md = next((vault / "projects" / "proj").rglob("decisions/*.md"))
            text = md.read_text(encoding="utf-8")
            assert "Use sqlite for storage" in text and "fresh-tag" in text
            # Missing id fails closed.
            try:
                s.update_memory_tags(project="proj", entry_type="decision",
                                     entry_id="nope", tags=["x"])
            except RuntimeError:
                pass
            else:
                raise AssertionError("missing id accepted")

        def t_maintenance_source():
            dry = s.update_memory_tags(project=None, entry_type="source",
                                       entry_id=src["id"], tags=["src-tag"])
            assert dry["after"] == ["src-tag"] and dry["dry_run"]
            applied = s.update_memory_tags(
                project=None, entry_type="source", entry_id=src["id"],
                tags=["src-tag"], dry_run=False,
                expected_revision=dry["revision"])
            assert applied["applied"]
            again = s.store_source(url="https://x.test/a", title="T",
                                   description="D", source_kind="link",
                                   tags=["other"])
            assert again["created"] is False and again["tags"] == ["src-tag"], \
                again  # same-URL no-op keeps tags

        def t_backup_restore():
            import vault_ops
            snap = Path(tmp) / "snap"
            rc = vault_ops.main(["backup", "--vault", str(vault),
                                 "--dest", str(snap), "--ack-writers-stopped"])
            assert rc == 0, rc
            manifest = json.loads((snap / "manifest.json").read_text())
            assert manifest["snapshot_rows_match"] is True, manifest
            assert manifest["integrity_check"] == ["ok"], manifest
            assert manifest["rows"]["profiles"] >= 1, manifest["rows"]
            restored = Path(tmp) / "restored"
            rc = vault_ops.main(["restore", "--snapshot", str(snap),
                                 "--vault", str(restored),
                                 "--ack-writers-stopped"])
            assert rc == 0, rc
            assert not list(restored.glob("*.wal")) + list(restored.glob("*.shm"))
            rs = store_mod.MemoryStore(storage_path=restored)
            rs.initialize()
            assert len(rs.export_entries(project="proj")) == len(
                s.export_entries(project="proj"))
            assert rs.get_profile(project="proj") == s.get_profile(
                project="proj"), "restored profile differs"
            # Refuses a non-empty target.
            rc = vault_ops.main(["restore", "--snapshot", str(snap),
                                 "--vault", str(vault),
                                 "--ack-writers-stopped"])
            assert rc != 0, "overwrite allowed"

        def t_rebuild():
            import rebuild_index
            rebuild_index._store_mod = store_mod
            before_ids = {r["id"] for r in
                          s.db.execute("SELECT id FROM entries").fetchall()}
            before_profile = s.get_profile(project="proj")
            n_ins, n_upd, errors = rebuild_index.rebuild(vault)
            assert not errors, errors
            after_ids = {r["id"] for r in
                         s.db.execute("SELECT id FROM entries").fetchall()}
            assert before_ids <= after_ids, "ids churned"
            assert s.get_profile(project="proj") == before_profile, \
                "profile not preserved"
            # Second run converges (all updates, no inserts).
            n_ins2, _, errors2 = rebuild_index.rebuild(vault)
            assert not errors2 and n_ins2 == 0, (n_ins2, errors2)

        def t_rebuild_refresh():
            # Body edit after indexing: the content-derived dedup key changes,
            # the dedup lookup misses, and the path-derived id still exists.
            # The rebuild must refresh that row in place (id preserved) —
            # refusing to overwrite left the index stale forever.
            import rebuild_index
            rebuild_index._store_mod = store_mod
            v1 = "One-off body before the edit walk"
            v2 = "One-off body after the edit walk"
            md = store_mod._write_okf_file(
                memory_path=vault, project="proj", entry_type="decisions",
                content=v1, description="refresh check", tags=["python"],
                timestamp="2026-10-12T00:00:00+00:00")
            n_ins, _, errors = rebuild_index.rebuild(vault)
            assert not errors and n_ins >= 1, (n_ins, errors)
            row = s.db.execute(
                "SELECT id, content FROM entries WHERE content = ?",
                (v1,)).fetchone()
            assert row is not None, "rebuild did not index the new file"
            # Edit the body in place: same file path, new content.
            md.write_text(md.read_text(encoding="utf-8").replace(v1, v2),
                          encoding="utf-8")
            n_ins2, _, errors2 = rebuild_index.rebuild(vault)
            assert not errors2 and n_ins2 == 0, (n_ins2, errors2)
            row2 = s.db.execute(
                "SELECT content FROM entries WHERE id = ?",
                (row["id"],)).fetchone()
            assert row2 is not None, "refresh dropped the row"
            assert row2["content"] == v2, (row2["content"], v2)

        def t_server_handlers():
            try:
                import server
            except ImportError as exc:
                print(f"  skip: MCP handler assertions ({exc})")
                return
            lt = json.loads(server.handle_list_tags(s, {"query": "arch"}))
            assert lt["tags"] and lt["tags"][0]["name"] == "architecture", lt
            um = json.loads(server.handle_update_memory_tags(
                s, {"project": "proj", "entry_type": "fact",
                    "id": r2["id"], "tags": ["python"]}))
            assert um["dry_run"] and um["after"] == ["python"], um

        for name, fn in [
            ("alias resolution", t_alias),
            ("invalid tag error", t_invalid),
            ("new tag auto-register", t_new_tag),
            ("persistence across restart", t_restart),
            ("queries never write", t_queries_no_write),
            ("tag union, no delete", t_union),
            ("failure rollback", t_failure_rollback),
            ("exclude_projects", t_exclusions),
            ("source opt-in", t_source_optin),
            ("query/tags OR", t_or_semantics),
            ("nested projects", t_nested),
            ("profiles in export", t_export_profiles),
            ("list_tags ordering/limits", t_list_tags_order),
            ("ambiguous alias error", t_ambiguous_alias),
            ("maintenance memory+revision", t_maintenance_memory),
            ("maintenance source", t_maintenance_source),
            ("backup/restore", t_backup_restore),
            ("rebuild preserves", t_rebuild),
            ("rebuild refresh after body edit", t_rebuild_refresh),
            ("server handlers", t_server_handlers),
        ]:
            check(name, fn)

    print(f"ok: {len(PASSED)} contract checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
