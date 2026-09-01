"""MCP server exposing memory store tools via the Model Context Protocol.

Eight tools (per openspec/specs/memory-mcp-server/spec.md):
    search_memory, store_decision, store_fact, store_learning,
    store_convention, store_profile, export_memories, get_profile, ping.

All reads are explicit (no background polling). Server validates storage
accessibility at startup.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.lowlevel.server import ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)

from store import (
    VALID_TYPES,
    MemoryStore,
    _first_non_heading_line,
)

# Observability log: append-only JSONL. Path is derived from MEMORY_PATH so the
# log lives next to the bundle, never blocking tool behavior.
_LOG_PATH: Path | None = None


def _log_path() -> Path:
    global _LOG_PATH
    if _LOG_PATH is not None:
        return _LOG_PATH
    from cli import get_memory_path

    base = get_memory_path()
    _LOG_PATH = base / "tool-calls.log"
    return _LOG_PATH


def _log_tool_call(tool_name: str, params: dict) -> None:
    """Append a JSONL entry for each tool call. Silently ignore write errors."""
    try:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool": tool_name,
            "project": params.get("project"),
            "entry_type": params.get("entry_type"),
        }
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        pass


def _require(params: dict, key: str) -> str:
    val = params.get(key)
    if not val:
        raise ValueError(f"'{key}' is required and must not be empty")
    return val


def _derive_description(content: str) -> str:
    """Derive a one-sentence description from the first non-heading line."""
    return _first_non_heading_line(content) or content[:120]


# ── Tool handlers (sync, return JSON strings) ──────────────────────────────


def handle_search_memory(store: MemoryStore, params: dict) -> str:
    project = params.get("project") or None
    entry_type = params.get("entry_type") or None
    tags = params.get("tags") or None
    query = params.get("query") or None
    results = store.search_entries(
        project=project, entry_type=entry_type, tags=tags, query=query
    )
    return json.dumps(results)


def _handle_store_typed(
    store: MemoryStore, params: dict, entry_type: str
) -> str:
    project = _require(params, "project")
    content = _require(params, "content")
    tags = params.get("tags") or []
    description = params.get("description")
    if not description or not str(description).strip():
        description = _derive_description(content)
    openspec_change_id = params.get("openspec_change_id") or None
    confidence = params.get("confidence", 1.0)
    if confidence is None:
        confidence = 1.0
    entry = store.upsert_entry(
        entry_type=entry_type,
        project=project,
        content=content,
        tags=tags,
        description=str(description).strip(),
        confidence=float(confidence),
        openspec_change_id=openspec_change_id,
    )
    return json.dumps(entry)


def handle_store_decision(store: MemoryStore, params: dict) -> str:
    return _handle_store_typed(store, params, "decision")


def handle_store_fact(store: MemoryStore, params: dict) -> str:
    return _handle_store_typed(store, params, "fact")


def handle_store_learning(store: MemoryStore, params: dict) -> str:
    return _handle_store_typed(store, params, "learning")


def handle_store_convention(store: MemoryStore, params: dict) -> str:
    return _handle_store_typed(store, params, "convention")


def handle_store_profile(store: MemoryStore, params: dict) -> str:
    project = _require(params, "project")
    content = _require(params, "content")
    tags = params.get("tags") or []
    entry = store.upsert_profile(project=project, content=content, tags=tags)
    return json.dumps(entry)


def handle_export_memories(store: MemoryStore, params: dict) -> str:
    project = _require(params, "project")
    entry_type = params.get("entry_type") or None
    results = store.export_entries(project=project, entry_type=entry_type)
    return json.dumps(results)


def handle_get_profile(store: MemoryStore, params: dict) -> str:
    project = _require(params, "project")
    entry_type = params.get("entry_type") or None
    results = store.get_profile(project=project, entry_type=entry_type)
    return json.dumps(results)


def handle_ping(store: MemoryStore, params: dict) -> str:
    return json.dumps(
        {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
    )


def handle_store_source(store: MemoryStore, params: dict) -> str:
    url = _require(params, "url")
    title = _require(params, "title")
    description = _require(params, "description")
    source_kind = _require(params, "source_kind")
    tags = params.get("tags") or []
    content = params.get("content") or None
    supersedes = params.get("supersedes") or None
    result = store.store_source(
        url=url,
        title=title,
        description=description,
        source_kind=source_kind,
        tags=tags,
        content=content,
        supersedes=supersedes,
    )
    return json.dumps(result)


# ── Tool definitions (shared between list_tools and the wire-up) ──────────


def _tool_definitions() -> list[Tool]:
    """Static tool definitions for the memory-server MCP surface."""
    valid_types = sorted(VALID_TYPES)
    return [
        Tool(
            name="search_memory",
            description="Search memory entries across projects. Omit project to search all projects.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string"},
                    "entry_type": {"type": "string", "enum": valid_types},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "query": {"type": "string"},
                },
            },
        ),
        Tool(
            name="store_decision",
            description="Store a decision entry",
            inputSchema={
                "type": "object",
                "required": ["project", "content"],
                "properties": {
                    "project": {"type": "string"},
                    "content": {"type": "string"},
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "openspec_change_id": {"type": "string"},
                },
            },
        ),
        Tool(
            name="store_fact",
            description="Store a fact entry",
            inputSchema={
                "type": "object",
                "required": ["project", "content"],
                "properties": {
                    "project": {"type": "string"},
                    "content": {"type": "string"},
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
            },
        ),
        Tool(
            name="store_learning",
            description="Store a learning entry",
            inputSchema={
                "type": "object",
                "required": ["project", "content"],
                "properties": {
                    "project": {"type": "string"},
                    "content": {"type": "string"},
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        Tool(
            name="store_convention",
            description="Store a convention entry",
            inputSchema={
                "type": "object",
                "required": ["project", "content"],
                "properties": {
                    "project": {"type": "string"},
                    "content": {"type": "string"},
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        Tool(
            name="store_profile",
            description="Store or update a user profile entry for a project",
            inputSchema={
                "type": "object",
                "required": ["project", "content"],
                "properties": {
                    "project": {"type": "string"},
                    "content": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        Tool(
            name="store_source",
            description="Store a source reference (article, transcript, PDF, video, link)",
            inputSchema={
                "type": "object",
                "required": ["url", "title", "description", "source_kind"],
                "properties": {
                    "url": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "source_kind": {
                        "type": "string",
                        "enum": ["article", "transcript", "pdf", "video", "link", "other"],
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "content": {"type": "string"},
                    "supersedes": {"type": "string"},
                },
            },
        ),
        Tool(
            name="export_memories",
            description="Export all memory entries for a project (no limit)",
            inputSchema={
                "type": "object",
                "required": ["project"],
                "properties": {
                    "project": {"type": "string"},
                    "entry_type": {"type": "string", "enum": valid_types},
                },
            },
        ),
        Tool(
            name="get_profile",
            description="Retrieve the global tech profile for a project",
            inputSchema={
                "type": "object",
                "required": ["project"],
                "properties": {
                    "project": {"type": "string"},
                    "entry_type": {"type": "string", "enum": valid_types},
                },
            },
        ),
        Tool(
            name="ping",
            description="Health check — returns ok and current timestamp",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


# ── MCP server factory (mcp 1.26.0 keyword-arg API) ───────────────────────


def create_app(store: MemoryStore) -> Server:
    """Create and return a configured MCP server instance.

    Uses the keyword-argument API of `mcp.server.Server` (>= 1.0). The handlers
    run synchronously (the underlying MCP layer awaits them in an executor).
    """
    tool_defs = _tool_definitions()
    handlers = {
        "search_memory": handle_search_memory,
        "store_decision": handle_store_decision,
        "store_fact": handle_store_fact,
        "store_learning": handle_store_learning,
        "store_convention": handle_store_convention,
        "store_profile": handle_store_profile,
        "store_source": handle_store_source,
        "export_memories": handle_export_memories,
        "get_profile": handle_get_profile,
        "ping": handle_ping,
    }

    async def on_list_tools(
        ctx: ServerRequestContext, params: PaginatedRequestParams | None
    ) -> ListToolsResult:
        return ListToolsResult(tools=tool_defs)

    async def on_call_tool(
        ctx: ServerRequestContext, params: CallToolRequestParams
    ) -> CallToolResult:
        name = params.name
        arguments: dict[str, Any] = dict(params.arguments or {})
        if name not in handlers:
            raise ValueError(f"Unknown tool: {name}")
        text = handlers[name](store, arguments)
        _log_tool_call(name, arguments)
        return CallToolResult(
            content=[TextContent(type="text", text=text)],
            isError=False,
        )

    return Server(
        "memory-server",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


# ── Entry point for `memory-server` console script ──────────────────────────


async def run() -> None:
    """Validate storage, build store, start stdio MCP server."""
    from cli import get_memory_path, validate_storage_path

    memory_path = get_memory_path()
    validate_storage_path(str(memory_path))
    store = MemoryStore(storage_path=memory_path)
    store.initialize()
    app = create_app(store)
    async with stdio_server() as (r, w):
        await app.run(r, w, app.create_initialization_options())


def main() -> None:
    import asyncio

    asyncio.run(run())


if __name__ == "__main__":
    main()
