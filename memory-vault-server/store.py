"""Memory storage layer: SQLite (WAL + FTS5) backed by OKF Markdown files.

The Markdown files under `memory-vault/projects/<project>/<type>/` are the
source of truth. SQLite is a derived search index that can be rebuilt from
the Markdown at any time via `scripts/rebuild_index.py`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re as _re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cli import get_memory_path
from registry import build_type_maps, load_type_registry
from tags import (
    VocabularyError,
    atomic_write_text,
    check_ambiguous_alias,
    load_vocabulary,
    normalize_tags,
    save_vocabulary,
    split_valid,
    stable_union,
    vault_write_lock,
)

# ponytail: registry-derived globals, initialized once at module load.
_registry_maps = build_type_maps(load_type_registry(get_memory_path()))

VALID_TYPES: set[str] = _registry_maps["valid_types"]
_TYPE_DIR_MAP: dict[str, str] = _registry_maps["type_dir_map"]
_TYPE_LABEL_MAP: dict[str, str] = _registry_maps["type_label_map"]
_DIR_TO_SINGULAR: dict[str, str] = _registry_maps["dir_to_singular"]
_type_order: list[str] = _registry_maps["type_order"]
_extraction_types: list[dict] = _registry_maps["extraction_types"]

# Valid source_kind values for Source entries (per raw-source spec)
SOURCE_KINDS = frozenset({"article", "transcript", "pdf", "video", "link", "other"})


class SourceImmutableError(Exception):
    """Raised when attempting to modify an existing Source entry."""


def _slug(text: str, max_len: int = 50) -> str:
    s = _re.sub(r"[^a-z0-9]+", "-", text.lower()[:max_len])
    return s.strip("-") or "entry"


def _first_non_heading_line(content: str) -> str:
    """Return the first line of `content` that is not a Markdown heading.

    Used to derive a one-sentence `description` when the caller did not provide
    one. Returns empty string if every line is a heading.
    """
    for line in content.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        return s[:200]
    return ""


def _parse_frontmatter(text: str) -> tuple[dict | None, str | None]:
    """Tiny YAML frontmatter parser for OKF-style blocks.

    Handles flat `key: value` pairs, inline arrays `[a, b, c]`, and quoted
    strings. Returns (frontmatter_dict, error). Error is None on success;
    frontmatter_dict is None on failure.
    """
    lines = text.splitlines()
    if not lines or lines[0].rstrip() != "---":
        return None, "no frontmatter block (file must start with `---`)"
    end = None
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            end = i
            break
    if end is None:
        return None, "unterminated frontmatter block"

    fm: dict = {}
    for raw in lines[1:end]:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            return None, f"malformed frontmatter line: {raw!r}"
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        fm[key] = _parse_value(value)
    return fm, None


def _parse_value(raw: str):
    if not raw:
        return ""
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip('"').strip("'") for item in inner.split(",")]
    if (raw.startswith('"') and raw.endswith('"')) or (
        raw.startswith("'") and raw.endswith("'")
    ):
        return raw[1:-1]
    if _re.fullmatch(r"-?\d+(\.\d+)?", raw):
        return float(raw) if "." in raw else int(raw)
    return raw


def _write_okf_file(
    memory_path: Path,
    project: str | None,
    entry_type: str,  # plural dir name: decisions | facts | learnings | conventions | raw
    content: str,
    description: str,
    tags: list[str] | None = None,
    resource: str | None = None,
    openspec_change_id: str | None = None,
    confidence: float | None = None,
    timestamp: str | None = None,
    title: str | None = None,
    extra_fields: dict[str, str] | None = None,
) -> Path:
    """Write an OKF Markdown file and return its path.

    Slug collisions get a numeric suffix so distinct content with the same
    first-line slug is not silently overwritten. When `project` is None the
    file lands in `memory_path/raw/` (Source entries); `extra_fields` are
    appended to the frontmatter after the standard fields.
    """
    ts = timestamp or datetime.now(timezone.utc).isoformat(timespec="seconds")
    date = ts[:10]
    title = title or content.split("\n")[0][:80].strip() or description[:80]
    slug = _slug(title)

    if entry_type in ("facts", "raw"):
        base_filename = f"{slug}.md"
    else:
        base_filename = f"{date}-{slug}.md"

    if project is None:
        okf_dir = memory_path / "raw"
    else:
        okf_dir = memory_path / "projects" / project / entry_type
    okf_dir.mkdir(parents=True, exist_ok=True)

    okf_path = okf_dir / base_filename
    if okf_path.exists():
        # Disambiguate by appending -2, -3, ...
        stem = okf_path.stem
        suffix_n = 2
        while True:
            candidate = okf_dir / f"{stem}-{suffix_n}.md"
            if not candidate.exists():
                okf_path = candidate
                break
            suffix_n += 1

    type_label = _TYPE_LABEL_MAP.get(entry_type, entry_type[:-1].capitalize())

    # OKF v0.1 frontmatter field order: type, title, description, resource,
    # tags, timestamp. Custom fields (project, openspec_change_id, confidence,
    # extra_fields) are appended after.
    frontmatter_lines = [
        "---",
        f"type: {type_label}",
        f"title: {title}",
        f"description: {description}",
    ]
    if resource:
        frontmatter_lines.append(f"resource: {resource}")
    frontmatter_lines.append(f"tags: {json.dumps(tags or [])}")
    frontmatter_lines.append(f"timestamp: {ts}")
    if project is not None:
        frontmatter_lines.append(f"project: {project}")
    if openspec_change_id:
        frontmatter_lines.append(f"openspec_change_id: {openspec_change_id}")
    # Confidence is a fact-only field: `templates/fact.md` is the only OKF template
    # that declares it, and `store_fact` is the only tool whose schema exposes it.
    if confidence is not None and entry_type == "facts":
        frontmatter_lines.append(f"confidence: {confidence}")
    for key, value in (extra_fields or {}).items():
        frontmatter_lines.append(f"{key}: {value}")
    frontmatter_lines.append("---")
    frontmatter_lines.append("")
    frontmatter_lines.append(content)

    atomic_write_text(okf_path, "\n".join(frontmatter_lines))
    return okf_path


def _replace_frontmatter_tags(text: str, tags: list[str]) -> str:
    """Swap the ``tags:`` frontmatter line, preserving body and all metadata."""
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        raise RuntimeError("entry file lost its frontmatter block")
    end = next(
        (i for i in range(1, len(lines)) if lines[i].rstrip() == "---"), None
    )
    if end is None:
        raise RuntimeError("entry file has unterminated frontmatter block")
    new_line = f"tags: {json.dumps(tags)}"
    for i in range(1, end):
        if lines[i].partition(":")[0].strip() == "tags":
            lines[i] = new_line
            break
    else:
        lines.insert(end, new_line)
    return "\n".join(lines)


def _parse_okf_file(path: Path) -> dict | None:
    """Parse an OKF Markdown file. Returns an entry dict or None on failure."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    fm, err = _parse_frontmatter(text)
    if err or not fm:
        return None

    # Map type label (e.g., "Decision") -> dir (e.g., "decisions") -> singular
    # (e.g., "decision"). Use a direct label->dir reverse map.
    type_label = str(fm.get("type", ""))
    label_to_dir = {v: k for k, v in _TYPE_LABEL_MAP.items()}
    dir_name = label_to_dir.get(type_label, "")
    entry_type = _DIR_TO_SINGULAR.get(dir_name, "")
    if not entry_type:
        return None

    tags_raw = fm.get("tags", "[]")
    if isinstance(tags_raw, list):
        tags = tags_raw
    elif isinstance(tags_raw, str):
        try:
            tags = json.loads(tags_raw)
        except (json.JSONDecodeError, TypeError):
            tags = []
    else:
        tags = []

    confidence = 1.0
    if "confidence" in fm:
        try:
            confidence = float(fm["confidence"])
        except (TypeError, ValueError):
            pass

    body_lines = text.split("---", 2)
    content = body_lines[2].strip() if len(body_lines) >= 3 else ""
    ts = str(fm.get("timestamp", ""))

    return {
        "id": path.stem,
        "entry_type": entry_type,
        "project": str(fm.get("project", path.parts[-3] if len(path.parts) >= 3 else "")),
        "content": content,
        "description": str(fm.get("description", "")),
        "tags": json.dumps(tags),
        "confidence": confidence,
        "openspec_change_id": fm.get("openspec_change_id") or None,
        "source_url": fm.get("source_url") or None,
        "source_kind": fm.get("source_kind") or None,
        "created_at": ts,
        "updated_at": ts,
    }


def _tags_list(raw: str | list | None) -> list[str]:
    """Decode a stored tags JSON blob (or list) into a plain string list."""
    if isinstance(raw, list):
        return [str(t) for t in raw]
    if not raw:
        return []
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if isinstance(decoded, list):
        return [str(t) for t in decoded]
    return []


def _project_excluded(proj: str, exclude: list[str] | tuple[str, ...] | None) -> bool:
    """Exclusions are exact full project keys: parent keys never nest."""
    return proj in (exclude or [])


class MemoryStore:
    """SQLite + OKF Markdown dual storage. Markdown is source of truth."""

    def __init__(self, storage_path: Path):
        self.storage_path = Path(storage_path)
        self._db: sqlite3.Connection | None = None

    # ── tag authority (vocabulary lives at the vault root) ───────────────

    def _normalize_for_store(
        self, tags: list[str] | None
    ) -> tuple[list[str], list[str]]:
        """Normalize incoming tags, persist valid new ones. Hold the lock."""
        vocab = load_vocabulary(self.storage_path)
        canonical, new_tags = normalize_tags(tags, vocab, register=True)
        if new_tags:
            save_vocabulary(self.storage_path, vocab)
        return canonical, new_tags

    def _normalize_for_query(
        self, tags: list[str] | None
    ) -> tuple[list[str], list[str]]:
        """Normalize filter tags (alias -> canonical). Never writes."""
        vocab = load_vocabulary(self.storage_path)
        return normalize_tags(tags, vocab, register=False)

    def _type_dir(self, entry_type: str) -> str:
        return _TYPE_DIR_MAP[entry_type]

    def _entry_files(self, project: str, entry_type: str) -> list[Path]:
        """Markdown files for one project/type (nested keys like a/b work)."""
        # ponytail: "/" inside one path component resolves as nesting on posix.
        type_path = self.storage_path / "projects" / project / self._type_dir(entry_type)
        if not type_path.is_dir():
            return []
        return [
            f for f in sorted(type_path.glob("*.md")) if f.name != "index.md"
        ]

    @property
    def db(self) -> sqlite3.Connection:
        assert self._db is not None, "MemoryStore.initialize() must be called first"
        return self._db

    def initialize(self) -> None:
        """Open DB, set WAL, create tables + FTS5, validate integrity."""
        self.storage_path.mkdir(parents=True, exist_ok=True)
        (self.storage_path / "projects").mkdir(exist_ok=True)

        db_path = self.storage_path / "memory.db"
        if db_path.exists() and db_path.stat().st_size > 0:
            try:
                # timeout=30: with WAL a live vault may be written by another
                # client (DSH + opencode). Without it the probe waits only 5 s
                # and a busy lock surfaces as "corrupt database".
                test_conn = sqlite3.connect(str(db_path), timeout=30)
                row = test_conn.execute("PRAGMA integrity_check").fetchone()
                test_conn.close()
                if row[0].lower() != "ok":
                    raise RuntimeError(f"integrity check failed: {row[0]}")
            except sqlite3.DatabaseError as e:
                raise RuntimeError(f"corrupt database: {e}") from e

        self._db = sqlite3.connect(str(db_path), timeout=30)
        self._db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                entry_type TEXT NOT NULL,
                project TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                confidence REAL NOT NULL DEFAULT 1.0,
                openspec_change_id TEXT,
                dedup_key TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project ON entries(project);
            CREATE INDEX IF NOT EXISTS idx_entry_type ON entries(entry_type);
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                content, tags, content=entries, content_rowid=rowid
            );
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
                INSERT INTO entries_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
            END;
        """
        )
        # The UNIQUE index is on dedup_key (enforced by the column constraint).
        self.db.commit()

    def _make_dedup_key(self, entry_type: str, project: str, content: str) -> str:
        # Full-content hash per memory-store spec. No truncation.
        key_str = f"{project}:{entry_type}:{content.strip().lower()}"
        return hashlib.sha256(key_str.encode()).hexdigest()

    def upsert_entry(
        self,
        entry_type: str,
        project: str,
        content: str,
        tags: list[str] | None = None,
        confidence: float = 1.0,
        openspec_change_id: str | None = None,
        min_confidence: float = 0.0,
        description: str | None = None,
        resource: str | None = None,
    ) -> dict:
        """Insert or update an entry. Returns dict with 'created'/'updated' flags.

        Primary storage: OKF Markdown files under projects/<project>/<type>/.
        Secondary index: SQLite entries table (kept in sync).

        Tags go through the vocabulary authority: incoming tags are validated
        (invalid -> error), aliases resolve to canonical, valid new tags are
        registered. Re-storing existing content unions stored + incoming tags
        (``[]``/``None`` never deletes) and rewrites the Markdown frontmatter
        so both layers agree. The response carries final ``tags``,
        ``new_tags`` and any preserved ``invalid_existing`` tags.
        """
        if entry_type not in VALID_TYPES or entry_type in ("profile", "source"):
            raise ValueError(
                f"invalid entry_type: {entry_type!r}. "
                f"Must be one of {VALID_TYPES - {'profile', 'source'}}"
            )
        if not content or not content.strip():
            raise ValueError("content must not be empty")
        if not project or not project.strip():
            raise ValueError("project must not be empty")
        if not (0.0 <= confidence <= 1.0):
            raise ValueError(f"confidence must be between 0.0 and 1.0, got {confidence}")
        if confidence < min_confidence:
            raise ValueError(f"confidence {confidence} is below minimum {min_confidence}")

        # Derive description from content when not provided.
        if not description or not description.strip():
            description = _first_non_heading_line(content) or content[:120]
        description = description.strip()

        dedup_key = self._make_dedup_key(entry_type, project, content)
        now = datetime.now(timezone.utc).isoformat()
        vocab_file = self.storage_path / "tag-vocabulary.json"
        created_files: list[Path] = []
        replaced_files: list[tuple[Path, str]] = []
        committed = False

        with vault_write_lock(self.storage_path):
            # Backup the vocabulary under the lock so a concurrent writer's
            # newer vocab is never clobbered by our rollback.
            vocab_backup = (
                vocab_file.read_text(encoding="utf-8") if vocab_file.exists() else None
            )
            try:
                canonical, new_tags = self._normalize_for_store(tags)

                # 1. Dedup check against SQLite (derived index) before writing files
                existing = self.db.execute(
                    "SELECT * FROM entries WHERE dedup_key = ?", (dedup_key,)
                ).fetchone()

                if existing:
                    stored = _tags_list(existing["tags"])
                    valid_hist, invalid_hist = split_valid(stored)
                    vocab = load_vocabulary(self.storage_path)
                    exist_canon, exist_new = normalize_tags(
                        valid_hist, vocab, register=True
                    )
                    if exist_new:
                        save_vocabulary(self.storage_path, vocab)
                    base = stable_union(exist_canon, [])
                    for old in invalid_hist:
                        if old not in base:
                            base.append(old)
                    final_tags = stable_union(base, canonical)
                    all_new = stable_union(exist_new, new_tags)

                    target = self._resolve_entry_file(
                        project, entry_type, dedup_key, content
                    )
                    original = target.read_text(encoding="utf-8")
                    replaced_files.append((target, original))
                    atomic_write_text(
                        target, _replace_frontmatter_tags(original, final_tags)
                    )

                    self.db.execute(
                        """UPDATE entries
                           SET content = ?, tags = ?, confidence = ?,
                               openspec_change_id = ?, updated_at = ?
                           WHERE dedup_key = ?""",
                        (
                            content,
                            json.dumps(final_tags),
                            confidence,
                            openspec_change_id,
                            now,
                            dedup_key,
                        ),
                    )
                    self.db.commit()
                    committed = True
                    row = self.db.execute(
                        "SELECT * FROM entries WHERE dedup_key = ?", (dedup_key,)
                    ).fetchone()
                    result = dict(row)
                    result["created"] = False
                    result["updated"] = True
                    result["tags"] = final_tags
                    result["new_tags"] = all_new
                    result["invalid_existing"] = invalid_hist
                    self._regenerate_project_index(project)
                    return result
                else:
                    # 2. Write OKF file (primary storage) only for new entries
                    okf_type = _TYPE_DIR_MAP[entry_type]
                    okf_path = _write_okf_file(
                        memory_path=self.storage_path,
                        project=project,
                        entry_type=okf_type,
                        content=content,
                        description=description,
                        tags=canonical,
                        resource=resource,
                        openspec_change_id=openspec_change_id,
                        confidence=confidence if entry_type in ("fact", "convention") else None,
                        timestamp=now,
                    )
                    created_files.append(okf_path)

                    entry_id = str(uuid.uuid4())
                    self._insert_row(
                        entry_id,
                        entry_type,
                        project,
                        content,
                        json.dumps(canonical),
                        confidence,
                        openspec_change_id,
                        dedup_key,
                        now,
                        now,
                    )
                    committed = True  # _insert_row commits
                    row = self.db.execute(
                        "SELECT * FROM entries WHERE id = ?", (entry_id,)
                    ).fetchone()
                    result = dict(row)
                    result["created"] = True
                    result["updated"] = False
                    result["tags"] = canonical
                    result["new_tags"] = new_tags
                    result["invalid_existing"] = []
                    self._regenerate_project_index(project)
                    return result
            except BaseException:
                # Ordinary rollback: DB, new files, replaced files, vocabulary.
                # Once the DB is committed the files/vocab must NOT be rolled
                # back — the row would survive while its .md got deleted.
                if committed:
                    raise
                try:
                    self.db.rollback()
                except Exception:
                    pass
                for path in created_files:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                for path, original in replaced_files:
                    try:
                        atomic_write_text(path, original)
                    except OSError:
                        pass
                try:
                    if vocab_backup is None:
                        if vocab_file.exists():
                            vocab_file.unlink()
                    else:
                        atomic_write_text(vocab_file, vocab_backup)
                except OSError:
                    pass
                raise

    def _resolve_entry_file(
        self, project: str, entry_type: str, dedup_key: str, content: str
    ) -> Path:
        """Find the single Markdown file holding this entry. Fail closed."""
        candidates: list[Path] = []
        for path in self._entry_files(project, entry_type):
            parsed = _parse_okf_file(path)
            if parsed is None:
                continue
            if self._make_dedup_key(entry_type, project, parsed["content"]) != dedup_key:
                continue
            if parsed["content"] != content:
                raise RuntimeError(
                    f"body divergence for {project}/{entry_type} in {path.name}: "
                    "index and file disagree, refusing to sync"
                )
            candidates.append(path)
        if not candidates:
            raise RuntimeError(
                f"entry Markdown missing for {project}/{entry_type}: "
                "index row exists but no file matches, refusing to sync"
            )
        if len(candidates) > 1:
            raise RuntimeError(
                f"ambiguous entry Markdown for {project}/{entry_type}: "
                f"{len(candidates)} files match, refusing to sync"
            )
        return candidates[0]

    def _insert_row(
        self,
        entry_id: str,
        entry_type: str,
        project: str,
        content: str,
        tags_json: str,
        confidence: float,
        openspec_change_id: str | None,
        dedup_key: str,
        created_at: str,
        updated_at: str,
    ) -> None:
        """Insert (or replace) one row in the entries table and commit."""
        self.db.execute(
            """INSERT OR REPLACE INTO entries
               (id, entry_type, project, content, tags, confidence,
                openspec_change_id, dedup_key, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry_id,
                entry_type,
                project,
                content,
                tags_json,
                confidence,
                openspec_change_id,
                dedup_key,
                created_at,
                updated_at,
            ),
        )
        self.db.commit()

    def upsert_profile(
        self,
        project: str,
        content: str,
        tags: list[str] | None = None,
    ) -> dict:
        """Insert or update a profile entry for a project.

        Profiles deduplicate by ``(project, entry_type)``, not by content hash.
        Each project has at most one profile. No OKF file is written — profiles
        are DB-only internal metadata. Content is replaced wholesale while tags
        union stored + incoming (``[]``/``None`` never deletes).
        """
        if not content or not content.strip():
            raise ValueError("content must not be empty")
        if not project or not project.strip():
            raise ValueError("project must not be empty")

        dedup_key = f"profile:{project}"
        now = datetime.now(timezone.utc).isoformat()
        entry_type = "profile"
        vocab_file = self.storage_path / "tag-vocabulary.json"
        committed = False

        with vault_write_lock(self.storage_path):
            # Backup the vocabulary under the lock so a concurrent writer's
            # newer vocab is never clobbered by our rollback.
            vocab_backup = (
                vocab_file.read_text(encoding="utf-8") if vocab_file.exists() else None
            )
            try:
                canonical, new_tags = self._normalize_for_store(tags)

                existing = self.db.execute(
                    "SELECT * FROM entries WHERE project = ? AND entry_type = ?",
                    (project, entry_type),
                ).fetchone()

                if existing:
                    stored = _tags_list(existing["tags"])
                    valid_hist, invalid_hist = split_valid(stored)
                    vocab = load_vocabulary(self.storage_path)
                    exist_canon, exist_new = normalize_tags(
                        valid_hist, vocab, register=True
                    )
                    if exist_new:
                        save_vocabulary(self.storage_path, vocab)
                    base = stable_union(exist_canon, [])
                    for old in invalid_hist:
                        if old not in base:
                            base.append(old)
                    final_tags = stable_union(base, canonical)
                    all_new = stable_union(exist_new, new_tags)
                    self.db.execute(
                        """UPDATE entries
                           SET content = ?, tags = ?, updated_at = ?
                           WHERE project = ? AND entry_type = ?""",
                        (content, json.dumps(final_tags), now, project, entry_type),
                    )
                    self.db.commit()
                    committed = True
                    row = self.db.execute(
                        "SELECT * FROM entries WHERE project = ? AND entry_type = ?",
                        (project, entry_type),
                    ).fetchone()
                    result = dict(row)
                    result["created"] = False
                    result["updated"] = True
                else:
                    entry_id = str(uuid.uuid4())
                    self.db.execute(
                        """INSERT INTO entries
                           (id, entry_type, project, content, tags, confidence,
                            openspec_change_id, dedup_key, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            entry_id,
                            entry_type,
                            project,
                            content,
                            json.dumps(canonical),
                            1.0,
                            None,
                            dedup_key,
                            now,
                            now,
                        ),
                    )
                    self.db.commit()
                    committed = True
                    row = self.db.execute(
                        "SELECT * FROM entries WHERE id = ?", (entry_id,)
                    ).fetchone()
                    result = dict(row)
                    result["created"] = True
                    result["updated"] = False
                    final_tags, all_new, invalid_hist = canonical, new_tags, []
                result["tags"] = final_tags
                result["new_tags"] = all_new
                result["invalid_existing"] = invalid_hist
                return result
            except BaseException:
                # Once the DB is committed the vocab must NOT be rolled back —
                # the row survives and stale vocab would clobber newer writes.
                if committed:
                    raise
                try:
                    self.db.rollback()
                except Exception:
                    pass
                try:
                    if vocab_backup is None:
                        if vocab_file.exists():
                            vocab_file.unlink()
                    else:
                        atomic_write_text(vocab_file, vocab_backup)
                except OSError:
                    pass
                raise

    def store_source(
        self,
        url: str,
        title: str,
        description: str,
        source_kind: str,
        tags: list[str] | None = None,
        content: str | None = None,
        supersedes: str | None = None,
    ) -> dict:
        """Store a Source entry under memory/raw/<slug>.md.

        Dedup key: (source_url, slug). Same URL returns existing slug.
        Same slug + different content raises SourceImmutableError.
        """
        if not url or not url.strip():
            raise ValueError("url must not be empty")
        if not title or not title.strip():
            raise ValueError("title must not be empty")
        if not description or not description.strip():
            raise ValueError("description must not be empty")
        if source_kind not in SOURCE_KINDS:
            raise ValueError(
                f"invalid source_kind: {source_kind!r}. "
                f"Must be one of {sorted(SOURCE_KINDS)}"
            )

        slug = _slug(title)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")

        vocab_file = self.storage_path / "tag-vocabulary.json"
        committed = False
        with vault_write_lock(self.storage_path):
            # Backup the vocabulary under the lock so a concurrent writer's
            # newer vocab is never clobbered by our rollback.
            vocab_backup = (
                vocab_file.read_text(encoding="utf-8") if vocab_file.exists() else None
            )
            try:
                canonical, new_tags = self._normalize_for_store(tags)

                # Check dedup by source_url first (stored in dedup_key)
                url_dedup_key = f"source:url:{url}"
                existing_by_url = self.db.execute(
                    "SELECT * FROM entries WHERE dedup_key = ?",
                    (url_dedup_key,),
                ).fetchone()
                if existing_by_url:
                    # Immutable no-op: same URL returns the entry untouched,
                    # including its tags.
                    return {
                        "id": existing_by_url["id"],
                        "slug": existing_by_url["id"],
                        "created": False,
                        "updated": False,
                        "tags": _tags_list(existing_by_url["tags"]),
                        "new_tags": [],
                    }

                # Slug collision: raise if a different URL reuses the slug with
                # different content; otherwise _write_okf_file disambiguates
                # with a numeric suffix.
                raw_dir = self.storage_path / "raw"
                raw_dir.mkdir(parents=True, exist_ok=True)
                okf_path = raw_dir / f"{slug}.md"
                if okf_path.exists():
                    existing_text = okf_path.read_text(encoding="utf-8")
                    new_body = content or ""
                    if new_body and new_body not in existing_text:
                        raise SourceImmutableError(
                            f"source slug {slug!r} already exists with different content"
                        )

                extra_fields = {
                    "source_url": url,
                    "source_kind": source_kind,
                    "captured_at": now,
                }
                if supersedes:
                    extra_fields["supersedes"] = supersedes
                created_path: Path | None = None
                try:
                    created_path = _write_okf_file(
                        memory_path=self.storage_path,
                        project=None,
                        entry_type="raw",
                        content=content or "",
                        description=description,
                        title=title,
                        tags=canonical,
                        timestamp=now,
                        extra_fields=extra_fields,
                    )
                    slug = created_path.stem

                    # Insert into SQLite
                    entry_id = slug
                    # Dedup key uses URL so same URL always maps to same entry
                    dedup_key = f"source:url:{url}"
                    self._insert_row(
                        entry_id,
                        "source",
                        "",
                        content or "",
                        json.dumps(canonical),
                        1.0,
                        None,
                        dedup_key,
                        now,
                        now,
                    )
                    committed = True  # _insert_row commits
                except BaseException:
                    # Once the DB is committed the .md must NOT be deleted —
                    # the row would survive as an orphan pointing nowhere.
                    if committed:
                        raise
                    try:
                        self.db.rollback()
                    except Exception:
                        pass
                    if created_path is not None:
                        try:
                            created_path.unlink()
                        except OSError:
                            pass
                    raise
                return {
                    "id": entry_id,
                    "slug": slug,
                    "created": True,
                    "updated": False,
                    "tags": canonical,
                    "new_tags": new_tags,
                }
            except BaseException:
                # Once the DB is committed the vocab must NOT be rolled back —
                # stale backup would clobber a concurrent writer's newer vocab.
                if committed:
                    raise
                try:
                    if vocab_backup is None:
                        if vocab_file.exists():
                            vocab_file.unlink()
                    else:
                        atomic_write_text(vocab_file, vocab_backup)
                except OSError:
                    pass
                raise

    def _scan_sources(self) -> list[dict]:
        """Scan raw/ for Source entries, sorted by file name descending."""
        raw_dir = self.storage_path / "raw"
        if not raw_dir.is_dir():
            return []
        entries: list[dict] = []
        for f in sorted(raw_dir.glob("*.md"), key=lambda p: p.name, reverse=True):
            entry = _parse_okf_file(f)
            if entry:
                entry["project"] = ""
                entries.append(entry)
        return entries

    def _iter_project_files(
        self,
        project: str | None,
        entry_type: str | None,
        excludes: list[str],
    ):
        """Yield ``(project_key, path)`` for OKF files, nested projects included.

        The project key is the path relative to ``projects/`` minus the
        trailing type directory (``org/repo`` for
        ``projects/org/repo/decisions/x.md``). Exclusions filter keys before
        any file body is read.
        """
        projects_dir = self.storage_path / "projects"
        if not projects_dir.is_dir():
            return
        if entry_type == "source":
            return
        if entry_type:
            wanted = {_TYPE_DIR_MAP.get(entry_type, entry_type + "s")}
        else:
            wanted = set(_TYPE_DIR_MAP.values())
        for md in sorted(projects_dir.rglob("*.md")):
            try:
                rel = md.relative_to(projects_dir)
            except ValueError:
                continue
            if len(rel.parts) < 3 or rel.parts[-2] not in wanted:
                continue
            key = "/".join(rel.parts[:-2])
            if project is not None and key != project:
                continue
            if _project_excluded(key, excludes):
                continue
            yield key, md

    def _profile_rows(
        self,
        project: str | None,
        excludes: list[str],
        canon_tags: list[str],
    ) -> list[dict]:
        """DB profile rows for a project, honoring exclusions and tag filter."""
        sql = "SELECT * FROM entries WHERE entry_type = 'profile'"
        params: list = []
        if project is not None:
            sql += " AND project = ?"
            params.append(project)
        out = []
        for r in self.db.execute(sql, params).fetchall():
            d = dict(r)
            if _project_excluded(d["project"], excludes):
                continue
            if canon_tags and not any(
                t in _tags_list(d.get("tags")) for t in canon_tags
            ):
                continue
            out.append(d)
        return out

    def _exclusion_clause(self, excludes: list[str]) -> tuple[str, list]:
        """SQL fragment excluding exact full project keys (no prefix matching)."""
        frags: list[str] = []
        params: list = []
        for e in excludes:
            frags.append("e.project != ?")
            params.append(e)
        return (" AND " + " AND ".join(frags)) if frags else "", params

    def search_entries(
        self,
        project: str | None = None,
        entry_type: str | None = None,
        tags: list[str] | None = None,
        query: str | None = None,
        max_results: int = 50,
        exclude_projects: list[str] | None = None,
        include_profiles: bool = False,
    ) -> list[dict]:
        """Search entries.

        Contract semantics: ``entry_type='source'`` opts into global Sources
        (combining it with ``project`` is an error); without ``entry_type``,
        Sources and profiles are excluded (profiles live behind
        ``get_profile``/``export_memories``). ``exclude_projects`` drops full
        nested project keys in SQL before rows/LIMIT and before Markdown
        bodies are read. Query tokens match with OR semantics (quoted FTS5
        literals); tag filters are OR over canonical tags. FTS queries rank by
        bm25 ascending with updated_at tiebreak; scans sort updated_at desc.
        """
        excludes = list(exclude_projects or [])
        if entry_type == "source" and project:
            raise ValueError(
                "entry_type='source' cannot be combined with 'project': "
                "sources are global"
            )
        canon_tags, _ = self._normalize_for_query(tags) if tags else ([], [])
        tokens = (query or "").replace('"', "").split()

        if tokens:
            # FTS5 treats bare words as boolean operators; quote each token
            # and join with OR for literal token-OR matching.
            fts_query = " OR ".join(f'"{t}"' for t in tokens)
            fts_sql = (
                "SELECT rowid, bm25(entries_fts, 1.0, 3.0) AS score "
                "FROM entries_fts WHERE entries_fts MATCH ?"
            )
            fts_rows = self.db.execute(fts_sql, (fts_query,)).fetchall()
            rowids = [r[0] for r in fts_rows]
            if not rowids:
                return []
            placeholders = ",".join("?" * len(rowids))
            base_sql = (
                "SELECT e.*, f.score FROM entries e "
                f"JOIN ({fts_sql}) f ON f.rowid = e.rowid "
                f"WHERE e.rowid IN ({placeholders})"
            )
            params: list = [fts_query, *rowids]
            if entry_type:
                base_sql += " AND e.entry_type = ?"
                params.append(entry_type)
            elif include_profiles:
                base_sql += " AND e.entry_type != 'source'"
            else:
                base_sql += " AND e.entry_type NOT IN ('source', 'profile')"
            if project:
                base_sql += " AND e.project = ?"
                params.append(project)
            excl_sql, excl_params = self._exclusion_clause(excludes)
            base_sql += excl_sql
            params.extend(excl_params)
            if canon_tags:
                tag_ph = ",".join("?" * len(canon_tags))
                base_sql += (
                    " AND EXISTS (SELECT 1 FROM json_each(e.tags) "
                    f"WHERE json_each.value IN ({tag_ph}))"
                )
                params.extend(canon_tags)
            # bm25() returns negative scores: more negative = more relevant,
            # so rank ascending; updated_at breaks ties.
            base_sql += " ORDER BY f.score ASC, e.updated_at DESC LIMIT ?"
            params.append(max_results)
            rows = self.db.execute(base_sql, params).fetchall()
            results = [dict(r) for r in rows]
            for r in results:
                r["score"] = round(r["score"], 3)
            return results

        results: list[dict] = []
        for key, md in self._iter_project_files(project, entry_type, excludes):
            entry = _parse_okf_file(md)
            if entry:
                entry["project"] = key
                results.append(entry)

        # Sources are opt-in only (entry_type='source', no project filter).
        if entry_type == "source":
            results.extend(self._scan_sources())
        elif include_profiles and entry_type in (None, "profile"):
            results.extend(self._profile_rows(project, excludes, []))

        if canon_tags:
            results = [
                r
                for r in results
                if any(t in _tags_list(r.get("tags")) for t in canon_tags)
            ]

        results.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return results[:max_results]

    def list_tags(
        self,
        query: str | None = None,
        project: str | None = None,
        exclude_projects: list[str] | None = None,
        limit: int = 20,
    ) -> dict:
        """List vocabulary tags with usage counts.

        Counts cover eligible memory files (Markdown, source of truth) plus
        DB profiles; Sources never count. Each entry contributes at most 1
        per tag. ``project``/``exclude_projects`` restrict to used tags only
        (zero-count tags hidden so filters never mislead); without them,
        zero-count vocabulary tags are listed. Query tokens match OR,
        case-insensitive literal, over name/aliases/description. Order: exact
        name/alias match first, then count desc, then name.
        """
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 50
        ):
            raise ValueError(f"limit must be an int in [1, 50], got {limit!r}")
        excludes = list(exclude_projects or [])
        filtered = project is not None or bool(excludes)
        vocab = load_vocabulary(self.storage_path)
        canon_map = vocab.get("canonical") or {}

        qlower = query.strip().lower() if query and query.strip() else None
        qtokens = qlower.split() if qlower else []
        for tok in qtokens:
            check_ambiguous_alias(vocab, tok)

        counts: dict[str, int] = {}
        for _key, md in self._iter_project_files(project, None, excludes):
            entry = _parse_okf_file(md)
            if not entry:
                continue
            for t in dict.fromkeys(_tags_list(entry.get("tags"))):
                counts[t] = counts.get(t, 0) + 1
        for prow in self._profile_rows(project, excludes, []):
            for t in dict.fromkeys(_tags_list(prow.get("tags"))):
                counts[t] = counts.get(t, 0) + 1

        items = []
        for name, meta in canon_map.items():
            if not isinstance(name, str):
                continue
            aliases = (
                [a for a in (meta.get("aliases") or []) if isinstance(a, str)]
                if isinstance(meta, dict)
                else []
            )
            desc = (
                meta.get("description") if isinstance(meta, dict) else None
            )
            count = counts.get(name, 0)
            if filtered and count == 0:
                continue
            if qtokens:
                hay = " ".join([name, *aliases, desc or ""]).lower()
                if not any(tok in hay for tok in qtokens):
                    continue
            exact = bool(
                qlower
                and (
                    qlower == name.lower()
                    or qlower in [a.lower() for a in aliases]
                )
            )
            item: dict = {
                "name": name,
                "aliases": aliases,
                "count": count,
            }
            if desc:
                item["description"] = desc
            items.append((0 if exact else 1, -count, name, item))

        items.sort(key=lambda t: (t[0], t[1], t[2]))
        tags_out = [t[3] for t in items]
        truncated = len(tags_out) > limit
        return {"tags": tags_out[:limit], "truncated": truncated}

    def _entry_revision(
        self,
        tags: list[str],
        content: str,
        updated_at: str,
        file_text: str | None,
    ) -> str:
        """Short hash revision over DB tags/content/date plus file body."""
        h = hashlib.sha1()
        h.update(json.dumps(tags, sort_keys=True).encode("utf-8"))
        h.update(b"\x00")
        h.update((content or "").encode("utf-8"))
        h.update(b"\x00")
        h.update((updated_at or "").encode("utf-8"))
        if file_text is not None:
            h.update(b"\x00")
            h.update(file_text.encode("utf-8"))
        return h.hexdigest()[:16]

    def update_memory_tags(
        self,
        project: str | None,
        entry_type: str,
        entry_id: str,
        tags: list[str] | None,
        dry_run: bool = True,
        expected_revision: str | None = None,
    ) -> dict:
        """Tags-only maintenance. Dry run by default (reads, never writes).

        Resolves the target by id (fail closed on missing/ambiguity/body
        divergence), returns before/after tag sets plus a revision hash over
        DB and file state. Applying (``dry_run=False``) requires the current
        ``expected_revision`` and replaces tags explicitly — body, URL, title,
        identity, dedup key and original dates are preserved (``updated_at``
        advances). Profiles are DB-only; sources resolve globally (project
        optional, must be empty when given).
        """
        if not entry_type or not str(entry_type).strip():
            raise ValueError("entry_type must not be empty")
        if not entry_id or not str(entry_id).strip():
            raise ValueError("id must not be empty")
        entry_type = str(entry_type).strip()
        entry_id = str(entry_id).strip()

        # CAS + writes share one lock with the row/file reads: without it,
        # two concurrent applies with the same expected_revision both pass.
        with vault_write_lock(self.storage_path):
            if entry_type == "profile":
                if not project or not str(project).strip():
                    raise ValueError("project is required for profile tags")
                project = str(project).strip()
                row = self.db.execute(
                    "SELECT * FROM entries WHERE project = ? AND entry_type = 'profile'",
                    (project,),
                ).fetchone()
                if row is None:
                    raise RuntimeError(f"profile missing for project {project!r}")
                if row["id"] != entry_id:
                    raise RuntimeError(
                        f"profile id mismatch for project {project!r}: "
                        "refusing to retag"
                    )
                target = ("profile", dict(row), None)
            elif entry_type == "source":
                if project is not None and str(project).strip() != "":
                    raise ValueError(
                        "sources are global: project must be omitted or empty"
                    )
                row = self.db.execute(
                    "SELECT * FROM entries WHERE id = ? AND entry_type = 'source'",
                    (entry_id,),
                ).fetchone()
                if row is None:
                    raise RuntimeError(f"source {entry_id!r} not found")
                src_file = self.storage_path / "raw" / f"{entry_id}.md"
                if not src_file.is_file():
                    raise RuntimeError(
                        f"source Markdown missing for {entry_id!r}: "
                        "index row exists but no file matches, refusing to retag"
                    )
                target = ("source", dict(row), src_file)
            else:
                if entry_type not in VALID_TYPES:
                    raise ValueError(f"invalid entry_type: {entry_type!r}")
                if not project or not str(project).strip():
                    raise ValueError("project is required for memory tags")
                project = str(project).strip()
                row = self.db.execute(
                    "SELECT * FROM entries WHERE id = ? AND entry_type = ? "
                    "AND project = ?",
                    (entry_id, entry_type, project),
                ).fetchone()
                if row is None:
                    raise RuntimeError(
                        f"entry {entry_id!r} not found for "
                        f"{project}/{entry_type}"
                    )
                rowd = dict(row)
                target_file = self._resolve_entry_file(
                    project, entry_type, rowd["dedup_key"], rowd["content"]
                )
                target = ("memory", rowd, target_file)

            _kind, rowd, file_path = target
            stored = _tags_list(rowd.get("tags"))
            file_text = (
                file_path.read_text(encoding="utf-8") if file_path else None
            )
            revision = self._entry_revision(
                stored, rowd.get("content") or "", rowd.get("updated_at") or "",
                file_text,
            )

            if dry_run:
                # Read-only: resolve aliases, never register, never persist.
                after, _ = self._normalize_for_query(tags)
                return {
                    "id": entry_id,
                    "project": project,
                    "entry_type": entry_type,
                    "dry_run": True,
                    "applied": False,
                    "before": stored,
                    "after": after,
                    "revision": revision,
                    "new_tags": [],
                    "invalid_existing": [],
                }

            if not expected_revision or expected_revision != revision:
                raise RuntimeError(
                    "stale or missing expected_revision: re-read the entry "
                    "(dry_run) and retry with the current revision"
                )

            vocab_file = self.storage_path / "tag-vocabulary.json"
            vocab_backup = (
                vocab_file.read_text(encoding="utf-8") if vocab_file.exists() else None
            )
            replaced: list[tuple[Path, str]] = []
            committed = False
            try:
                after, new_tags = self._normalize_for_store(tags)
                now = datetime.now(timezone.utc).isoformat()
                if file_path is not None:
                    assert file_text is not None
                    replaced.append((file_path, file_text))
                    atomic_write_text(
                        file_path,
                        _replace_frontmatter_tags(file_text, after),
                    )
                self.db.execute(
                    "UPDATE entries SET tags = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(after), now, entry_id),
                )
                self.db.commit()
                committed = True
                new_revision = self._entry_revision(
                    after, rowd.get("content") or "", now,
                    file_path.read_text(encoding="utf-8")
                    if file_path is not None
                    else None,
                )
                return {
                    "id": entry_id,
                    "project": project,
                    "entry_type": entry_type,
                    "dry_run": False,
                    "applied": True,
                    "before": stored,
                    "after": after,
                    "revision": new_revision,
                    "new_tags": new_tags,
                    "invalid_existing": [],
                }
            except BaseException:
                # Once the DB is committed the file/vocab must NOT be rolled
                # back — the row survives and its .md would lose the new tags.
                if committed:
                    raise
                try:
                    self.db.rollback()
                except Exception:
                    pass
                for path, original in replaced:
                    try:
                        atomic_write_text(path, original)
                    except OSError:
                        pass
                try:
                    if vocab_backup is None:
                        if vocab_file.exists():
                            vocab_file.unlink()
                    else:
                        atomic_write_text(vocab_file, vocab_backup)
                except OSError:
                    pass
                raise

    def export_entries(
        self,
        project: str,
        entry_type: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict]:
        """Export all entries for a project, optionally filtered by type/tags.

        Unlike search, export includes DB profiles with no result limit.
        """
        return self.search_entries(
            project=project,
            entry_type=entry_type,
            tags=tags,
            max_results=100000,
            include_profiles=True,
        )

    def get_profile(
        self,
        project: str,
        entry_type: str | None = None,
    ) -> list[dict]:
        """Retrieve the profile for a project.

        Defaults to ``profile`` entries: the tool is named get_profile, so an
        unfiltered call returning the 10 most recent rows of any type was a
        silent wrong answer. Pass ``entry_type`` to use it as a recency query.
        """
        entry_type = entry_type or "profile"
        sql = "SELECT * FROM entries WHERE project = ? AND entry_type = ?"
        params: list = [project, entry_type]
        sql += " ORDER BY updated_at DESC LIMIT 10"
        rows = self.db.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def _regenerate_project_index(self, project: str) -> None:
        """Regenerate `<project>/index.md` with links to all entries in the project.

        Atomic write: write to `.tmp` then `os.replace`.
        """
        proj_dir = self.storage_path / "projects" / project
        proj_dir.mkdir(parents=True, exist_ok=True)

        now = datetime.now(timezone.utc).isoformat()
        lines: list[str] = [
            "---",
            "type: Index",
            f"title: {project}",
            f"description: Project index for {project}.",
            "resource: ",
            "tags: [index]",
            f'timestamp: "{now}"',
            "---",
            "",
            f"# {project}\n",
        ]
        for tdir in _type_order:
            tpath = proj_dir / tdir
            if not tpath.is_dir():
                continue
            label = _TYPE_LABEL_MAP.get(tdir, tdir.capitalize())
            entries = sorted(
                (f for f in tpath.iterdir() if f.suffix == ".md"),
                key=lambda p: p.name,
                reverse=True,
            )
            if not entries:
                continue
            lines.append(f"## {label}\n")
            for f in entries:
                parsed = _parse_okf_file(f)
                if not parsed:
                    continue
                rel = f"{tdir}/{f.name}"
                title = parsed.get("description") or f.stem
                lines.append(f"- [{title}]({rel})")
            lines.append("")

        content = "\n".join(lines).rstrip() + "\n"
        tmp_path = proj_dir / "index.md.tmp"
        final_path = proj_dir / "index.md"
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, final_path)
