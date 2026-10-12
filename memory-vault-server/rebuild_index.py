"""Rebuild the SQLite FTS5 index from the OKF Markdown bundle (index-only).

Walks `projects/<project>/<type>/*.md` (nested projects included) and
`raw/*.md`, parses each file and inserts rows directly into SQLite. Markdown
stays the source of truth: this script never rewrites .md files (upsert_entry's
write path would duplicate them with today's date on a fresh DB).

Idempotent: new row ids derive from file paths, dedup keys from content
(sources: ``source_url`` — never the path), so re-running converges.
Re-runs preserve existing row ids and refresh content/tags/metadata in place;
DB-only profile rows are left untouched (never deleted, never rewritten).

Idempotent: row ids derive from file paths, dedup keys from content, so
re-running converges. Run after importing a bundle into a new vault dir
(memory.db* may be deleted first; the script also works on a populated DB):

    uv run --directory memory-vault-server python rebuild_index.py \
        --memory-path /path/to/vault
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

_store_mod = None  # set in main() once MEMORY_PATH points at the target bundle


def _json_dumps(tags) -> str:
    return json.dumps(list(tags), ensure_ascii=False)


def _id_for(relpath: Path) -> str:
    """Stable row id derived from the file path (idempotent re-runs)."""
    digest = hashlib.sha1(str(relpath).encode()).hexdigest()[:24]
    return f"rebuild-{digest}"


def _collect(memory_path: Path):
    """Walk the bundle -> (entries, errors); entries are
    (singular, project, relpath, parsed) tuples, DB-only types skipped."""
    entries: list[tuple[str, str, Path, dict]] = []
    errors: list[str] = []
    dir_to_singular = _store_mod._DIR_TO_SINGULAR
    parse = _store_mod._parse_okf_file

    def handle(path: Path, parsed: dict | None, default_project: str, singular: str):
        if parsed is None:
            errors.append(f"unparseable: {path.relative_to(memory_path)}")
            return
        # Defensive: trust the directory, not the parsed label.
        parsed["entry_type"] = singular
        parsed["project"] = parsed.get("project") or default_project
        entries.append((singular, parsed["project"], path.relative_to(memory_path), parsed))

    projects_dir = memory_path / "projects"
    if projects_dir.is_dir():
        # Projects may nest (e.g. `@deepseek-ai/dsh-root`): any directory whose
        # name is a type dir is indexed; its project is the dir path below
        # `projects/`, joined with "/".
        def scan(prefix: Path, project: str):
            for d in sorted(child for child in prefix.iterdir() if child.is_dir()):
                singular = dir_to_singular.get(d.name)
                if singular is None:
                    if d.name != ".obsidian":
                        scan(d, f"{project}/{d.name}" if project else d.name)
                    continue
                if singular == "profile":
                    continue
                for f in sorted(d.glob("*.md")):
                    if f.name == "index.md":
                        continue
                    handle(f, parse(f), project, singular)

        for proj_dir in sorted(p for p in projects_dir.iterdir() if p.is_dir()):
            scan(proj_dir, proj_dir.name)

    raw_dir = memory_path / "raw"
    if raw_dir.is_dir():
        for f in sorted(raw_dir.glob("*.md")):
            handle(f, parse(f), "", "source")

    return entries, errors


def rebuild(memory_path: Path) -> tuple[int, int, list[str]]:
    """Sync the bundle into the index -> (inserted, updated, errors).

    Existing rows (matched by dedup key) keep their ids; content, tags and
    metadata are refreshed from the files. Sources match by ``source_url``,
    never by path. Profile rows have no files and are preserved untouched.
    File tags are validated through the vocabulary authority (valid new tags
    registered, historical invalids kept and reported).
    """
    store = _store_mod.MemoryStore(storage_path=memory_path)
    store.initialize()

    entries, errors = _collect(memory_path)
    if not entries:
        print("No entries found in bundle; nothing to do.", file=sys.stderr)
        return 0, 0, errors

    vocab = _store_mod.load_vocabulary(memory_path)
    vocab_new: list[str] = []
    n_inserted = n_updated = 0
    for singular, project, relpath, e in entries:
        try:
            if singular == "source":
                url = (e.get("source_url") or "").strip()
                dedup_key = f"source:url:{url}" if url else _id_for(relpath)
                row_id = Path(relpath).stem
            else:
                dedup_key = store._make_dedup_key(singular, project, e["content"])
                row_id = _id_for(relpath)
            file_tags = _store_mod._tags_list(e.get("tags"))
            try:
                canon, new = _store_mod.normalize_tags(
                    file_tags, vocab, register=True
                )
                vocab_new = _store_mod.stable_union(vocab_new, new)
            except _store_mod.VocabularyError as exc:
                # Historical invalid tags: keep the file's tags verbatim,
                # refresh everything else, report the row.
                canon = file_tags
                errors.append(f"invalid tags kept: {project}/{relpath}: {exc}")
            existing = store.db.execute(
                "SELECT * FROM entries WHERE dedup_key = ?", (dedup_key,)
            ).fetchone()
            if existing:
                # Preserve the id; refresh content/tags/metadata in place.
                store.db.execute(
                    "UPDATE entries SET content = ?, tags = ?, confidence = ?,"
                    " openspec_change_id = ?, updated_at = ?"
                    " WHERE dedup_key = ?",
                    (
                        e["content"],
                        _json_dumps(canon),
                        float(e["confidence"] or 1.0),
                        e["openspec_change_id"],
                        e["updated_at"],
                        dedup_key,
                    ),
                )
                store.db.commit()
                n_updated += 1
                continue
            clash = store.db.execute(
                "SELECT dedup_key FROM entries WHERE id = ?", (row_id,)
            ).fetchone()
            if clash:
                # Body edited: the content-derived dedup key changed and the
                # lookup above missed. Refresh the path-id row in place —
                # refusing would leave the index stale forever.
                store.db.execute(
                    "UPDATE entries SET content = ?, tags = ?, confidence = ?,"
                    " dedup_key = ?, openspec_change_id = ?, updated_at = ?"
                    " WHERE id = ?",
                    (
                        e["content"],
                        _json_dumps(canon),
                        float(e["confidence"] or 1.0),
                        dedup_key,
                        e["openspec_change_id"],
                        e["updated_at"],
                        row_id,
                    ),
                )
                store.db.commit()
                n_updated += 1
                continue
            store._insert_row(
                row_id,
                singular,
                project,
                e["content"],
                _json_dumps(canon),
                float(e["confidence"] or 1.0),
                e["openspec_change_id"],
                dedup_key,
                e["created_at"],
                e["updated_at"],
            )
            n_inserted += 1
        except Exception as exc:  # noqa: BLE001 — one bad file must not stop the rebuild
            errors.append(f"failed: {project}/{relpath}: {exc}")
    if vocab_new:
        with _store_mod.vault_write_lock(memory_path):
            _store_mod.save_vocabulary(memory_path, vocab)
    return n_inserted, n_updated, errors


def regen_missing_indexes(memory_path: Path, store) -> int:
    """Regenerate `<project>/index.md` only where it is missing (nested too)."""
    projects_dir = memory_path / "projects"
    if not projects_dir.is_dir():
        return 0
    n = 0

    def scan(prefix: Path):
        for d in sorted(child for child in prefix.iterdir() if child.is_dir()):
            if d.name in _store_mod._DIR_TO_SINGULAR or d.name == ".obsidian":
                continue  # type dir or editor cache — not a project
            if not (d / "index.md").exists():
                project = str(d.relative_to(projects_dir)).replace(os.sep, "/")
                store._regenerate_project_index(project)
                n += 1
            scan(d)

    for proj_dir in sorted(p for p in projects_dir.iterdir() if p.is_dir()):
        if not (proj_dir / "index.md").exists():
            store._regenerate_project_index(proj_dir.name)
            n += 1
        scan(proj_dir)
    return n


def main(argv: list[str] | None = None) -> int:
    global _store_mod
    parser = argparse.ArgumentParser(description="Rebuild SQLite index from OKF bundle")
    parser.add_argument(
        "--memory-path",
        default=None,
        help="OKF bundle directory (default: $MEMORY_PATH, else ~/.memories)",
    )
    args = parser.parse_args(argv)

    # store.py builds its type maps from MEMORY_PATH at import time — point it
    # at the target bundle before importing.
    if args.memory_path:
        os.environ["MEMORY_PATH"] = str(Path(args.memory_path).resolve())
    import store as _store_mod
    from cli import get_memory_path

    memory_path = get_memory_path().resolve()
    if not memory_path.is_dir():
        print(f"error: {memory_path} is not a directory", file=sys.stderr)
        return 2

    print(f"Rebuilding index from {memory_path} ...")
    n_ins, n_upd, errors = rebuild(memory_path)
    store = _store_mod.MemoryStore(storage_path=memory_path)
    store.initialize()
    n_index = regen_missing_indexes(memory_path, store)
    print(f"Inserted: {n_ins}, already-indexed: {n_upd}, index.md regenerated: {n_index}")
    for err in errors:
        print(f"  {err}", file=sys.stderr)
    print(f"Errors: {len(errors)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
