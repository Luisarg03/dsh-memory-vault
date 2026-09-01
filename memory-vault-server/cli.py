"""Memory server CLI helpers (memory path resolution + storage validation)."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def get_memory_path() -> Path:
    """Return MEMORY_PATH from env, or default to `<project>/memory-vault/`."""
    env = os.environ.get("MEMORY_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "memory-vault"


def validate_storage_path(path: str) -> None:
    """Exit 1 with a clear message if `path` is missing or not a directory."""
    p = Path(path)
    if not p.exists():
        print(f"ERROR: Memory storage path does not exist: {path}", file=sys.stderr)
        print(f"  Run: mkdir -p {path}", file=sys.stderr)
        sys.exit(1)
    if not p.is_dir():
        print(f"ERROR: Memory storage path is not a directory: {path}", file=sys.stderr)
        sys.exit(1)
