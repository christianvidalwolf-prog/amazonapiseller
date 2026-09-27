# AGENTS.md

Instructions for AI coding agents (Codex, Cursor, Kiro, Junie, OpenClaw, ...). Project details live in `CLAUDE.md` — read it first.

## Code exploration: codebase-memory-mcp (mandatory)

This project is indexed in the `codebase-memory-mcp` knowledge graph. Use its tools **before** grep/find/reading files blindly:

- `search_graph` (name/label/qualified-name patterns) to locate functions, classes, routes.
- `trace_path` (`mode=calls|data_flow|cross_service`) to follow call chains, e.g. frontend page -> `/api/*` route -> service -> `spapi/endpoints/*`.
- `get_code_snippet` for the exact source of a symbol; `get_architecture` for structure; `search_code` for text search.
- If `index_status` reports the project is missing or stale, run `index_repository` on the repo root first.

Plain grep/read is still fine for configs, CSVs and non-code files, and always read a file before editing it.

## Persistent Memory: Mem0 (permanently active)

This project has Mem0 integrated as a persistent memory layer (`mem0ai`, repository in `./mem0`).
- Use Mem0 to persist, recall, and retrieve long-term user context, strategic decisions, preferences, and operations across sessions.
- Memory modules: `from mem0 import Memory` (local/OSS) or `from mem0 import MemoryClient` (Platform).
- Reference skills and workflows are available in `.agents/skills/mem0/`.
