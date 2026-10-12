"""Tag vocabulary + normalization authority + atomic persistence helpers.

Single authority for every tag that enters the vault (MCP tools and direct
``MemoryStore``/CLI use alike). Queries normalize without writing; stores
normalize, register valid new tags and persist the vocabulary.

Vocabulary file shape (``tag-vocabulary.json`` at the vault root)::

    {"canonical": {"architecture": {"aliases": ["arch"], "description": "..."}}}

Unknown top-level keys are preserved untouched on save. A missing vocabulary
file behaves as an empty catalog; a corrupt one is a hard error (never a
silent empty catalog).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover — non-posix hosts
    fcntl = None  # type: ignore[assignment]

TAG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
VOCAB_FILENAME = "tag-vocabulary.json"
LOCK_FILENAME = ".lock"


class VocabularyError(Exception):
    """Raised for corrupt vocabularies, invalid tags and ambiguous aliases."""


# ── interprocess lock + atomic file writes ─────────────────────────────────


@contextmanager
def vault_write_lock(vault: Path) -> Iterator[None]:
    """Exclusive interprocess lock for all vault writers (stdlib fcntl).

    Every mutation path (entries, profiles, sources, vocabulary, maintenance
    apply) must hold this while it reads-modifies-writes. Yields without
    locking on hosts without fcntl (declared limit, not a silent change).
    """
    vault = Path(vault)
    vault.mkdir(parents=True, exist_ok=True)
    lock_path = vault / LOCK_FILENAME
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` via a unique temp file + ``os.replace``."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# ── vocabulary ─────────────────────────────────────────────────────────────


def vocab_path(vault: Path) -> Path:
    return Path(vault) / VOCAB_FILENAME


def load_vocabulary(vault: Path) -> dict:
    """Load the vocabulary. Missing file -> empty catalog; corrupt -> error."""
    path = vocab_path(vault)
    if not path.exists():
        return {"canonical": {}}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise VocabularyError(f"cannot read vocabulary {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VocabularyError(f"corrupt vocabulary {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("canonical"), dict):
        raise VocabularyError(
            f"corrupt vocabulary {path}: top-level 'canonical' object required"
        )
    return data


def save_vocabulary(vault: Path, vocab: dict) -> None:
    """Persist ``vocab`` atomically, preserving unknown top-level keys.

    Must be called with :func:`vault_write_lock` held. Raises
    :class:`VocabularyError` (never a false success) on serialization issues.
    """
    try:
        text = json.dumps(vocab, indent=2, ensure_ascii=False) + "\n"
    except (TypeError, ValueError) as exc:
        raise VocabularyError(f"cannot serialize vocabulary: {exc}") from exc
    atomic_write_text(vocab_path(vault), text)


def _canonical_map(vocab: dict) -> dict[str, str]:
    """alias-or-name (lowercased) -> canonical name. Ambiguity checked later."""
    mapping: dict[str, str] = {}
    claimed: dict[str, list[str]] = {}
    for name, entry in (vocab.get("canonical") or {}).items():
        if not isinstance(name, str):
            continue
        lname = name.strip().lower()
        claimed.setdefault(lname, []).append(name)
        mapping.setdefault(lname, name)
        aliases = entry.get("aliases") if isinstance(entry, dict) else []
        for alias in aliases or []:
            if not isinstance(alias, str):
                continue
            claimed.setdefault(alias.strip().lower(), []).append(name)
            mapping.setdefault(alias.strip().lower(), name)
    ambiguous = {k: sorted(set(v)) for k, v in claimed.items() if len(set(v)) > 1}
    return {"mapping": mapping, "ambiguous": ambiguous}


def normalize_tags(
    tags: list[str] | tuple[str, ...] | None,
    vocab: dict,
    register: bool = True,
) -> tuple[list[str], list[str]]:
    """Normalize raw tags against ``vocab``.

    Strip + lowercase each tag; reject anything outside
    ``^[a-z0-9]+(?:-[a-z0-9]+)*$``; map known aliases to their canonical name;
    dedup preserving first-seen order. Valid unknown tags are registered into
    ``vocab`` in place when ``register`` is true (caller persists) and
    reported as ``new_tags``. Returns ``(canonical_tags, new_tags)``.
    """
    canonical: list[str] = []
    new_tags: list[str] = []
    if not tags:
        return canonical, new_tags
    info = _canonical_map(vocab)
    mapping: dict[str, str] = info["mapping"]
    ambiguous: dict[str, list[str]] = info["ambiguous"]
    for raw in tags:
        if not isinstance(raw, str):
            raise VocabularyError(f"invalid tag {raw!r}: must be a string")
        tag = raw.strip().lower()
        if not tag or not TAG_RE.match(tag):
            raise VocabularyError(
                f"invalid tag {raw!r}: must match lowercase-kebab "
                "[a-z0-9]+(-[a-z0-9]+)*"
            )
        if tag in ambiguous:
            raise VocabularyError(
                f"ambiguous alias {tag!r}: claimed by {ambiguous[tag]}"
            )
        known = mapping.get(tag)
        if known is not None:
            resolved = known.strip().lower()
        else:
            resolved = tag
            if register and resolved not in (vocab.get("canonical") or {}):
                vocab.setdefault("canonical", {})[resolved] = {"aliases": []}
                mapping[resolved] = resolved
                new_tags.append(resolved)
            elif not register and resolved not in new_tags and resolved not in canonical:
                # Query path: report the would-be-new tag without registering.
                new_tags.append(resolved)
        if resolved not in canonical:
            canonical.append(resolved)
    return canonical, new_tags


def stable_union(existing: list[str], incoming: list[str]) -> list[str]:
    """Union preserving order: existing first, then new incoming tags."""
    out = list(existing)
    for tag in incoming:
        if tag not in out:
            out.append(tag)
    return out


def split_valid(tags: list[str]) -> tuple[list[str], list[str]]:
    """Partition stored tags into (valid, invalid) per the canonical regex."""
    valid = [t for t in tags if isinstance(t, str) and TAG_RE.match(t.strip().lower())]
    invalid = [t for t in tags if t not in valid]
    return valid, invalid
