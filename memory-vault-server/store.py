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
    if confidence is not None and entry_type in ("facts", "conventions"):
        frontmatter_lines.append(f"confidence: {confidence}")
    for key, value in (extra_fields or {}).items():
        frontmatter_lines.append(f"{key}: {value}")
    frontmatter_lines.append("---")
    frontmatter_lines.append("")
    frontmatter_lines.append(content)

    okf_path.write_text("\n".join(frontmatter_lines), encoding="utf-8")
    return okf_path


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
        "created_at": ts,
        "updated_at": ts,
    }


class MemoryStore:
    """SQLite + OKF Markdown dual storage. Markdown is source of truth."""

    def __init__(self, storage_path: Path):
        self.storage_path = Path(storage_path)
        self._db: sqlite3.Connection | None = None

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
                test_conn = sqlite3.connect(str(db_path))
                row = test_conn.execute("PRAGMA integrity_check").fetchone()
                test_conn.close()
                if row[0].lower() != "ok":
                    raise RuntimeError(f"integrity check failed: {row[0]}")
            except sqlite3.DatabaseError as e:
                raise RuntimeError(f"corrupt database: {e}") from e

        self._db = sqlite3.connect(str(db_path))
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

        tags = tags or []
        tags_json = json.dumps(tags)
        dedup_key = self._make_dedup_key(entry_type, project, content)
        now = datetime.now(timezone.utc).isoformat()

        # 1. Dedup check against SQLite (derived index) before writing any file
        existing = self.db.execute(
            "SELECT * FROM entries WHERE dedup_key = ?", (dedup_key,)
        ).fetchone()

        if existing:
            self.db.execute(
                """UPDATE entries
                   SET content = ?, tags = ?, confidence = ?,
                       openspec_change_id = ?, updated_at = ?
                   WHERE dedup_key = ?""",
                (content, tags_json, confidence, openspec_change_id, now, dedup_key),
            )
            self.db.commit()
            row = self.db.execute(
                "SELECT * FROM entries WHERE dedup_key = ?", (dedup_key,)
            ).fetchone()
            result = dict(row)
            result["created"] = False
            result["updated"] = True
            self._regenerate_project_index(project)
            return result
        else:
            # 2. Write OKF file (primary storage) only for new entries
            okf_type = _TYPE_DIR_MAP[entry_type]
            _write_okf_file(
                memory_path=self.storage_path,
                project=project,
                entry_type=okf_type,
                content=content,
                description=description,
                tags=tags,
                resource=resource,
                openspec_change_id=openspec_change_id,
                confidence=confidence if entry_type in ("fact", "convention") else None,
                timestamp=now,
            )

            entry_id = str(uuid.uuid4())
            self._insert_row(
                entry_id,
                entry_type,
                project,
                content,
                tags_json,
                confidence,
                openspec_change_id,
                dedup_key,
                now,
                now,
            )
            row = self.db.execute(
                "SELECT * FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            result = dict(row)
            result["created"] = True
            result["updated"] = False
            self._regenerate_project_index(project)
            return result

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
        Each project has at most one profile.  No OKF file is written — profiles
        are internal metadata, not human-readable entries.
        """
        if not content or not content.strip():
            raise ValueError("content must not be empty")
        if not project or not project.strip():
            raise ValueError("project must not be empty")

        tags = tags or []
        tags_json = json.dumps(tags)
        dedup_key = f"profile:{project}"
        now = datetime.now(timezone.utc).isoformat()
        entry_type = "profile"

        existing = self.db.execute(
            "SELECT * FROM entries WHERE project = ? AND entry_type = ?",
            (project, entry_type),
        ).fetchone()

        if existing:
            self.db.execute(
                """UPDATE entries
                   SET content = ?, tags = ?, updated_at = ?
                   WHERE project = ? AND entry_type = ?""",
                (content, tags_json, now, project, entry_type),
            )
            self.db.commit()
            row = self.db.execute(
                "SELECT * FROM entries WHERE project = ? AND entry_type = ?",
                (project, entry_type),
            ).fetchone()
            result = dict(row)
            result["created"] = False
            result["updated"] = True
            return result
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
                    tags_json,
                    1.0,
                    None,
                    dedup_key,
                    now,
                    now,
                ),
            )
            self.db.commit()
            row = self.db.execute(
                "SELECT * FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            result = dict(row)
            result["created"] = True
            result["updated"] = False
            return result

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

        # Check dedup by source_url first (stored in dedup_key)
        url_dedup_key = f"source:url:{url}"
        existing_by_url = self.db.execute(
            "SELECT * FROM entries WHERE dedup_key = ?",
            (url_dedup_key,),
        ).fetchone()
        if existing_by_url:
            return {
                "id": existing_by_url["id"],
                "slug": existing_by_url["id"],
                "created": False,
                "updated": False,
            }

        # Slug collision: raise if a different URL reuses the slug with
        # different content; otherwise _write_okf_file disambiguates with a
        # numeric suffix.
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
        okf_path = _write_okf_file(
            memory_path=self.storage_path,
            project=None,
            entry_type="raw",
            content=content or "",
            description=description,
            title=title,
            tags=tags,
            timestamp=now,
            extra_fields=extra_fields,
        )
        slug = okf_path.stem

        # Insert into SQLite
        entry_id = slug
        # Dedup key uses URL so same URL always maps to same entry
        dedup_key = f"source:url:{url}"
        tags_json = json.dumps(tags or [])
        self._insert_row(
            entry_id,
            "source",
            "",
            content or "",
            tags_json,
            1.0,
            None,
            dedup_key,
            now,
            now,
        )
        return {
            "id": entry_id,
            "slug": slug,
            "created": True,
            "updated": False,
        }

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

    def search_entries(
        self,
        project: str | None = None,
        entry_type: str | None = None,
        tags: list[str] | None = None,
        query: str | None = None,
        max_results: int = 50,
    ) -> list[dict]:
        """Search entries.

        FTS queries rank by relevance (bm25: content weight 1.0, tags weight
        3.0) with updated_at as tiebreak; each result gains a ``score`` field.
        Non-FTS queries scan the OKF Markdown files (the source of truth) and
        sort by updated_at desc. Tag filters apply before the result limit.
        """
        if query and query.strip():
            # FTS5 parses hyphens as column operators and bare words as
            # boolean operators; quote each token to force literal matching.
            fts_query = " ".join(f'"{t}"' for t in query.replace('"', "").split())
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
                f"SELECT e.*, f.score FROM entries e "
                f"JOIN ({fts_sql}) f ON f.rowid = e.rowid "
                f"WHERE e.rowid IN ({placeholders})"
            )
            params: list = [fts_query, *rowids]
            if entry_type == "source":
                base_sql += " AND e.entry_type = 'source'"
            elif project or entry_type:
                # Project-filtered and typed searches exclude Sources.
                base_sql += " AND e.entry_type != 'source'"
                if project:
                    base_sql += " AND e.project = ?"
                    params.append(project)
                if entry_type:
                    base_sql += " AND e.entry_type = ?"
                    params.append(entry_type)
            if tags:
                tag_ph = ",".join("?" * len(tags))
                base_sql += (
                    f" AND EXISTS (SELECT 1 FROM json_each(e.tags) "
                    f"WHERE json_each.value IN ({tag_ph}))"
                )
                params.extend(tags)
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
        projects_dir = self.storage_path / "projects"
        if projects_dir.is_dir():
            if project:
                proj_candidates = [projects_dir / project]
            else:
                proj_candidates = sorted(p for p in projects_dir.iterdir() if p.is_dir())

            for proj_dir in proj_candidates:
                if not proj_dir.is_dir():
                    continue
                proj_name = proj_dir.name

                if entry_type:
                    if entry_type == "source":
                        # Sources are not in project dirs
                        continue
                    type_subdirs = [_TYPE_DIR_MAP.get(entry_type, entry_type + "s")]
                else:
                    type_subdirs = list(_TYPE_DIR_MAP.values())

                for tdir in type_subdirs:
                    type_path = proj_dir / tdir
                    if not type_path.is_dir():
                        continue
                    for f in sorted(
                        type_path.iterdir(), key=lambda p: p.name, reverse=True
                    ):
                        if f.suffix == ".md":
                            entry = _parse_okf_file(f)
                            if entry:
                                entry["project"] = proj_name
                                results.append(entry)

        # Include Sources when no project filter and no entry_type filter
        # (or entry_type=source). Handles a missing projects dir too.
        if not project and (entry_type is None or entry_type == "source"):
            results.extend(self._scan_sources())

        if tags:
            results = [
                r
                for r in results
                if any(t in json.loads(r.get("tags") or "[]") for t in tags)
            ]

        results.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return results[:max_results]

    def export_entries(
        self,
        project: str,
        entry_type: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict]:
        """Export all entries for a project, optionally filtered by type/tags."""
        return self.search_entries(
            project=project,
            entry_type=entry_type,
            tags=tags,
            max_results=100000,
        )

    def get_profile(
        self,
        project: str,
        entry_type: str | None = None,
    ) -> list[dict]:
        """Retrieve profile entries for a project."""
        sql = "SELECT * FROM entries WHERE project = ?"
        params: list = [project]
        if entry_type:
            sql += " AND entry_type = ?"
            params.append(entry_type)
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
