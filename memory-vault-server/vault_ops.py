"""Minimal operational utility: vault backup / restore / diagnose (stdlib only).

Never touches the live vault except through explicit absolute paths, and
never while writers may be running: backup/restore refuse without
``--ack-writers-stopped`` (this tool cannot stop real writers itself).

    uv run --directory memory-vault-server python vault_ops.py backup \
        --vault /abs/vault --dest /abs/external-dir --ack-writers-stopped
    uv run --directory memory-vault-server python vault_ops.py restore \
        --snapshot /abs/external-dir --vault /abs/empty-dir --ack-writers-stopped
    uv run --directory memory-vault-server python vault_ops.py diagnose \
        --vault /abs/vault

Backup layout: ``<dest>/memory.db`` (via ``sqlite3.Connection.backup`` from a
read-only source connection), the full file tree including hidden files but
excluding ``memory.db*``/``.lock``/``tool-calls.log``, plus
``manifest.json`` (sha256 per file, ``PRAGMA integrity_check``, row counts by
type). Files land 0600, directories 0700. The backup self-verifies by
restoring the snapshot DB to a temp dir and comparing row counts
(total/memories/profiles/tags) with the live vault. Restore only targets an
existing EMPTY directory, never overwrites, and never restores WAL/SHM files.
Diagnose is a dry run: per-entry before/after tag proposals (alias resolution
without writes, invalids flagged), alias/duplicate candidates listed, nothing
merged — similarity fusion is out of scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

OPS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(OPS_DIR))

DB_FILENAME = "memory.db"
MANIFEST_FILENAME = "manifest.json"
# Live/derived files that never belong in a snapshot.
SKIP_NAMES = {"memory.db", "memory.db-wal", "memory.db-shm", ".lock", "tool-calls.log"}

_store_mod = None  # lazy: imported after MEMORY_PATH points at the target vault


def _store():
    global _store_mod
    if _store_mod is None:
        import store as mod

        _store_mod = mod
    return _store_mod


def _require_abs_existing_dir(label: str, value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        raise ValueError(f"--{label} must be absolute, got {value!r}")
    if not p.is_dir():
        raise ValueError(f"--{label} is not an existing directory: {value!r}")
    return p.resolve()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _chmod_private(root: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o700)
        for name in filenames:
            try:
                os.chmod(os.path.join(dirpath, name), 0o600)
            except OSError:
                pass


def _row_counts(db_path: Path) -> dict:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        total = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        by_type = {
            r[0]: r[1]
            for r in con.execute(
                "SELECT entry_type, COUNT(*) FROM entries GROUP BY entry_type"
            ).fetchall()
        }
        tags = set()
        for (blob,) in con.execute("SELECT tags FROM entries").fetchall():
            try:
                tags.update(json.loads(blob or "[]"))
            except (json.JSONDecodeError, TypeError):
                pass
        return {
            "total": total,
            "by_type": by_type,
            "profiles": by_type.get("profile", 0),
            "memories": total - by_type.get("source", 0) - by_type.get("profile", 0),
            "distinct_tags": len(tags),
        }
    finally:
        con.close()


def _copy_tree(vault: Path, dest: Path) -> dict[str, str]:
    """Copy the vault tree (hidden files included, live files excluded)."""
    hashes: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(vault):
        dirnames.sort()
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in sorted(filenames):
            if name in SKIP_NAMES or name.endswith((".wal", ".shm")):
                continue
            if name.startswith(".") and name.endswith(".tmp"):
                continue
            src = Path(dirpath) / name
            rel = src.relative_to(vault).as_posix()
            target = dest / "tree" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            hashes[rel] = _sha256(target)
    return hashes


def cmd_backup(args) -> int:
    vault = _require_abs_existing_dir("vault", args.vault)
    dest = Path(args.dest)
    if not dest.is_absolute():
        raise ValueError(f"--dest must be absolute, got {args.dest!r}")
    if not args.ack_writers_stopped:
        print("refusing: pass --ack-writers-stopped once all writers are down",
              file=sys.stderr)
        return 2
    if vault == dest or dest.is_relative_to(vault):
        raise ValueError("--dest must be external to the vault")
    db_path = vault / DB_FILENAME
    if not db_path.is_file():
        raise ValueError(f"no {DB_FILENAME} in vault {vault}")

    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        raise ValueError(f"--dest must be empty, {dest} is not")

    # Snapshot the DB through the online-backup API from a read-only source.
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    snap_db = dest / DB_FILENAME
    try:
        dst = sqlite3.connect(str(snap_db))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    integrity = sqlite3.connect(str(snap_db)).execute(
        "PRAGMA integrity_check").fetchall()

    file_hashes = _copy_tree(vault, dest)
    live_counts = _row_counts(db_path)

    # Self-verify: temp-restore the snapshot DB, compare row counts.
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / DB_FILENAME
        shutil.copy2(snap_db, probe)
        snap_counts = _row_counts(probe)
    match = snap_counts == live_counts

    manifest = {
        "vault": str(vault),
        "db_sha256": _sha256(snap_db),
        "integrity_check": [r[0] for r in integrity],
        "rows": live_counts,
        "snapshot_rows": snap_counts,
        "snapshot_rows_match": match,
        "files": file_hashes,
    }
    (dest / MANIFEST_FILENAME).write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _chmod_private(dest)
    print(json.dumps({
        "snapshot": str(dest),
        "rows": live_counts,
        "snapshot_rows_match": match,
        "integrity_check": manifest["integrity_check"],
        "files": len(file_hashes),
    }))
    if integrity != [("ok",)] or not match:
        print("backup verification FAILED", file=sys.stderr)
        return 1
    return 0


def cmd_restore(args) -> int:
    snapshot = _require_abs_existing_dir("snapshot", args.snapshot)
    vault = Path(args.vault)
    if not vault.is_absolute():
        raise ValueError(f"--vault must be absolute, got {args.vault!r}")
    if not args.ack_writers_stopped:
        print("refusing: pass --ack-writers-stopped once all writers are down",
              file=sys.stderr)
        return 2
    manifest_path = snapshot / MANIFEST_FILENAME
    snap_db = snapshot / DB_FILENAME
    if not manifest_path.is_file() or not snap_db.is_file():
        raise ValueError(f"{snapshot} is not a backup snapshot")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if _sha256(snap_db) != manifest.get("db_sha256"):
        raise ValueError("snapshot DB hash mismatch: refusing to restore")

    vault.mkdir(parents=True, exist_ok=True)
    if any(vault.iterdir()):
        raise ValueError(
            f"refusing to overwrite non-empty --vault {vault}: "
            "restore into a clean directory")
    tree = snapshot / "tree"
    if tree.is_dir():
        for dirpath, dirnames, filenames in os.walk(tree):
            dirnames.sort()
            for name in sorted(filenames):
                if name in SKIP_NAMES or name.endswith((".wal", ".shm")):
                    continue  # never restore WAL/SHM or live files
                rel = (Path(dirpath) / name).relative_to(tree)
                target = vault / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(Path(dirpath) / name, target)
    shutil.copy2(snap_db, vault / DB_FILENAME)
    # Belt and braces: no stale WAL/SHM may survive beside the restored DB.
    for suffix in ("-wal", "-shm"):
        stale = vault / (DB_FILENAME + suffix)
        if stale.exists():
            stale.unlink()
    _chmod_private(vault)

    integrity = sqlite3.connect(str(vault / DB_FILENAME)).execute(
        "PRAGMA integrity_check").fetchall()
    rows = _row_counts(vault / DB_FILENAME)
    ok = integrity == [("ok",)] and rows == manifest.get("rows")
    print(json.dumps({
        "restored": str(vault), "rows": rows,
        "rows_match_manifest": rows == manifest.get("rows"),
        "integrity_check": [r[0] for r in integrity],
    }))
    if not ok:
        print("restore verification FAILED", file=sys.stderr)
        return 1
    return 0


def cmd_diagnose(args) -> int:
    vault = _require_abs_existing_dir("vault", args.vault)
    os.environ["MEMORY_PATH"] = str(vault)
    store = _store()
    vocab = store.load_vocabulary(vault)
    canon = vocab.get("canonical") or {}
    # Alias/duplicate candidates: one alias claimed by several canonicals.
    info_claims: dict[str, list[str]] = {}
    for name, meta in canon.items():
        aliases = meta.get("aliases") if isinstance(meta, dict) else []
        for alias in [name, *(aliases or [])]:
            if isinstance(alias, str):
                info_claims.setdefault(alias.strip().lower(), []).append(name)
    duplicates = {
        k: sorted(set(v)) for k, v in info_claims.items() if len(set(v)) > 1
    }

    report: dict = {"vault": str(vault), "entries": [], "duplicates": duplicates}
    s = store.MemoryStore(storage_path=vault)
    s.initialize()
    projects_dir = vault / "projects"
    if projects_dir.is_dir():
        for md in sorted(projects_dir.rglob("*.md")):
            if md.name == "index.md":
                continue
            parsed = store._parse_okf_file(md)
            if parsed is None:
                report["entries"].append(
                    {"file": md.relative_to(vault).as_posix(),
                     "error": "unparseable"})
                continue
            stored = store._tags_list(parsed.get("tags"))
            try:
                after, _ = store.normalize_tags(stored, vocab, register=False)
                error = None
            except store.VocabularyError as exc:
                after, error = stored, str(exc)
            report["entries"].append({
                "file": md.relative_to(vault).as_posix(),
                "before": stored,
                "after": after,
                "changes": after != stored,
                "error": error,
            })
    for prow in s._profile_rows(None, [], []):
        stored = s.db.execute(
            "SELECT tags FROM entries WHERE id = ?", (prow["id"],)).fetchone()
        tags = store._tags_list(stored[0])
        try:
            after, _ = store.normalize_tags(tags, vocab, register=False)
            error = None
        except store.VocabularyError as exc:
            after, error = tags, str(exc)
        report["entries"].append({
            "id": prow["id"], "project": prow["project"],
            "entry_type": "profile",
            "before": tags, "after": after,
            "changes": after != tags, "error": error,
        })
    print(json.dumps(report, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Vault backup/restore/diagnose")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("backup", "restore"):
        p = sub.add_parser(name)
        p.add_argument("--vault" if name == "backup" else "--snapshot",
                       required=True)
        p.add_argument("--dest" if name == "backup" else "--vault", required=True)
        p.add_argument("--ack-writers-stopped", action="store_true")
    d = sub.add_parser("diagnose")
    d.add_argument("--vault", required=True)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "backup":
            return cmd_backup(args)
        if args.cmd == "restore":
            return cmd_restore(args)
        return cmd_diagnose(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
