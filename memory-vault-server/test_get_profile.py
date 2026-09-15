#!/usr/bin/env python3
"""Self-check: get_profile answers with the profile, not with recent noise.

Regression guard for the bug where an unfiltered get_profile returned the 10
most recently updated rows of ANY type, so a caller asking for the profile of a
busy project got unrelated decisions and facts.

Run: python3 memory-vault-server/test_get_profile.py
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


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        # store.py resolves the type registry from MEMORY_PATH at import time,
        # so seed the throwaway vault before importing it.
        vault = Path(tmp)
        (vault / "projects").mkdir()
        shutil.copy(REPO_VAULT / "type-registry.yaml", vault / "type-registry.yaml")
        os.environ["MEMORY_PATH"] = str(vault)
        import store as store_mod

        s = store_mod.MemoryStore(storage_path=vault)
        s.initialize()

        s.upsert_profile(project="proj", content="PROFILE: python + sqlite")
        # Written afterwards, so these outrank the profile in updated_at:
        # the old code returned them and called it a profile.
        s.upsert_entry("decision", "proj", "DECISION: use sqlite for storage")
        s.upsert_entry("fact", "proj", "FACT: python 3.11 is required")

        got = s.get_profile(project="proj")
        assert len(got) == 1, f"expected only the profile row, got {len(got)}: {got}"
        assert got[0]["entry_type"] == "profile", got[0]["entry_type"]
        assert "PROFILE" in got[0]["content"], got[0]["content"]

        # entry_type=None must behave exactly like the default.
        assert s.get_profile(project="proj", entry_type=None) == got

        # Explicit entry_type still works (and is now a plain recency lookup).
        facts = s.get_profile(project="proj", entry_type="fact")
        assert len(facts) == 1 and facts[0]["entry_type"] == "fact", facts

        # A project with no profile yields nothing rather than unrelated rows.
        s.upsert_entry("fact", "other", "FACT: unrelated project")
        assert s.get_profile(project="other") == [], "profile leaked across projects"

        # The MCP tool handler agrees (binds the tool default to the store fix).
        # Needs the pinned `mcp` version from requirements.txt; skip when the
        # ambient one is older instead of failing the whole check.
        try:
            import server

            found = json.loads(server.handle_get_profile(s, {"project": "proj"}))
            assert len(found) == 1 and found[0]["entry_type"] == "profile", found
        except ImportError as exc:
            print(f"skip: MCP handler assertion ({exc})")

        s._db.close()

    print("ok: get_profile returns the profile, not the most recent rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
