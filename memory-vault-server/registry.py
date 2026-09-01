"""Type registry loader — reads memory/type-registry.yaml and provides
derived maps for store, server, and digest_session modules.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any


class RegistryValidationError(Exception):
    """Raised when the type registry fails validation."""


_REQUIRED_KEYS = ("name", "directory", "singular", "tool", "template", "extraction_hint")
_RESERVED_DIRECTORIES = {"index.md", "log.md", ".obsidian"}


def _validate_registry(types: list[dict[str, Any]]) -> None:
    """Validate a parsed registry. Raises RegistryValidationError on failure."""
    # Required keys
    for t in types:
        for key in _REQUIRED_KEYS:
            if key not in t:
                raise RegistryValidationError(
                    f"missing required key {key!r} in type {t.get('name', '<unnamed>')}"
                )

    # Duplicate name
    seen_names: set[str] = set()
    for t in types:
        n: str = t["name"]
        if n in seen_names:
            raise RegistryValidationError(f"duplicate name: {n!r}")
        seen_names.add(n)

    # Duplicate directory across project-attached types
    seen_project_dirs: set[str] = set()
    for t in types:
        if t.get("project_attached", True) is True:
            d: str = t["directory"]
            if d in seen_project_dirs:
                raise RegistryValidationError(
                    f"duplicate directory for project-attached types: {d!r}"
                )
            seen_project_dirs.add(d)

    # Reserved directory collision
    for t in types:
        d = t.get("directory", "")
        if d in _RESERVED_DIRECTORIES:
            raise RegistryValidationError(
                f"directory {d!r} collides with reserved path"
            )

    # Empty extraction_hint on project-attached types
    for t in types:
        if t.get("project_attached", True) is True:
            hint = t.get("extraction_hint")
            if hint is None or (isinstance(hint, str) and hint == ""):
                raise RegistryValidationError(
                    f"empty extraction_hint on project-attached type {t.get('name')!r}"
                )


@lru_cache(maxsize=1)
def load_type_registry(bundle_root: Path) -> list[dict[str, Any]]:
    """Load and validate the type registry from bundle_root/type-registry.yaml.

    Returns the list of type dicts. Raises RegistryValidationError on
    validation failure. Uses @lru_cache so the file is read only once.
    """
    import yaml  # lazy import: only needed when loading the registry

    registry_path = bundle_root / "type-registry.yaml"
    if not registry_path.is_file():
        raise RegistryValidationError(
            f"registry file not found: {registry_path}"
        )

    raw = registry_path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise RegistryValidationError(f"YAML parse error: {exc}") from exc

    if not isinstance(data, dict) or "types" not in data:
        raise RegistryValidationError(
            "registry must contain a top-level 'types' key"
        )

    types = data["types"]
    if not isinstance(types, list) or len(types) == 0:
        raise RegistryValidationError("'types' must be a non-empty list")

    _validate_registry(types)
    return types


def build_type_maps(
    types: list[dict[str, Any]],
) -> dict[str, Any]:
    """Derive the standard maps from a registry type list.

    Returns a dict with keys:
        valid_types: set of singular names
        type_dir_map: singular -> directory
        type_label_map: directory -> name (label)
        dir_to_singular: directory -> singular
        type_order: list of directory names in registry order (project-attached only)
        extraction_types: list of dicts for types with non-null extraction_hint
    """
    valid_types: set[str] = set()
    type_dir_map: dict[str, str] = {}
    type_label_map: dict[str, str] = {}
    dir_to_singular: dict[str, str] = {}
    type_order: list[str] = []
    extraction_types: list[dict[str, Any]] = []

    for t in types:
        singular = t["singular"]
        directory = t["directory"]
        name = t["name"]
        valid_types.add(singular)
        type_dir_map[singular] = directory
        type_label_map[directory] = name
        dir_to_singular[directory] = singular
        if t.get("project_attached", True):
            type_order.append(directory)
        if t.get("extraction_hint") is not None:
            extraction_types.append(t)

    return {
        "valid_types": valid_types,
        "type_dir_map": type_dir_map,
        "type_label_map": type_label_map,
        "dir_to_singular": dir_to_singular,
        "type_order": type_order,
        "extraction_types": extraction_types,
    }
