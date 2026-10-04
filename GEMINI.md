# GEMINI.md

Instructions for Gemini CLI. Project details live in `CLAUDE.md` — read it first.

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

## Metodología SDD (Spec-Driven Development) Obligatoria

Este proyecto opera bajo **SDD (Spec-Driven Development)**:
1. **La especificación es la única fuente de verdad ()**: Antes de crear o modificar endpoints, modelos de datos, cálculos algorítmicos o integraciones de Amazon SP-API / Ads, la especificación en  DEBE ser leída y actualizada.
2. **Generación automática de tipos ()**: Tras modificar contratos OpenAPI/YAML en , ejecuta  tanto en  como en .
3. **Guardrails y Reglas de Negocio**:
   - : Límites de puja y ACoS/TACoS.
   - : Precios suelo y reglas de Buy Box.
   - : Reglas de stock FBA/FBM y sincronización ERP ().
   - : Umbrales de fuga del Search Funnel.
   - : Cuotas y rate limits de Amazon.
   - : Cumplimiento Amazon DPP y no persistencia de datos PII.
4. **Al crear nuevas funcionalidades**: Añade siempre su especificación en  para que cualquier desarrollador o agente de IA en otro ordenador mantenga la coherencia total del sistema.
