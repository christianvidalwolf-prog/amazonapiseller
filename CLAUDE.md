# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two independent things living in the same directory:

1. **Root-level Python scripts** (`auth.py`, `get_fba_inventory.py`, `get_sales_2026.py`, `test_connection.py`) — standalone, one-off SP-API pulls that predate the app below. They write their output to the CSVs sitting next to them (`inventario_fba.csv`, `inventario_fba_con_stock.csv`, `ventas_2026.csv`). They are not imported by `backend/` or `frontend/` and don't need to be kept in sync with it.
2. **`backend/` + `frontend/`** — the actual SaaS app: a Node/TypeScript API and a Next.js dashboard for monitoring and managing an Amazon Seller Central account via SP-API. This is where new work happens.

Both talk to the same Amazon account; the Python scripts' refresh token/client id/secret in the root `.env` are the same credentials `backend/.env` needs.

## Commands

Everything below is run from `backend/` or `frontend/` respectively — there is no root-level package.json.

```bash
# infra (Postgres + Redis + ClickHouse)
docker compose up -d          # from repo root

# backend (Node/TS API, port 4000)
cd backend
npm install
npm run prisma:generate       # regenerate Prisma client after any schema.prisma change
npm run prisma:migrate        # create/apply a migration
npm run dev                   # tsx watch src/server.ts
npm run typecheck             # tsc --noEmit
npm run build && npm start    # compile to dist/ and run compiled output

# frontend (Next.js App Router, port 3000)
cd frontend
npm install
npm run dev
npm run build
```

There is no test suite in either package yet (no jest/vitest configured, no `*.test.ts` files). `npm run lint` is declared in `backend/package.json` but there is no ESLint config in the repo, so it will not run cleanly — don't rely on it as a gate.

Both `backend/.env` and `frontend/.env.local` are gitignored; copy from their `.env.example`. `backend/.env` needs `SP_API_SELLER_ID` and `SP_API_MARKETPLACE_IDS` in addition to the LWA credentials the Python scripts already use — the app throws on boot (`src/config/env.ts`) if any required var is missing.

## Architecture

### SP-API client layer (`backend/src/spapi/`)

Every module talks to Amazon through this layer — never call `fetch` against Amazon directly from a module/service.

- `client.ts` — `SpApiClient.request()` is the single entry point: attaches the LWA access token, applies per-operation rate limiting, retries 429/5xx with exponential backoff + jitter (honors `Retry-After`).
- `lwaAuth.ts` — `LwaAuthManager` exchanges the refresh token for an access token and caches it in memory until ~60s before expiry; concurrent calls collapse into one in-flight refresh.
- `rateLimiter.ts` — one token bucket per SP-API operation (keyed by string like `"listingsItems.putListingsItem"`), seeded from `SP_API_RATE_LIMITS` with Amazon's published rate/burst per operation. New endpoints must register their own key here (falls back to a conservative `{rate: 1, burst: 2}` default if omitted, which will be too slow for high-throughput operations).
- `endpoints/*.ts` — one file per SP-API surface (`orders`, `reports`, `fbaInventory`, `productPricing`, `finances`, `sellerPerformance`, `notifications`, `productTypeDefinitions`, `listingsItems`, `feeds`). These are thin typed wrappers around `client.request()` — no business logic, no persistence. Modules compose these, they don't call the raw client directly.

### Modules (`backend/src/modules/<name>/`)

Each module follows `*.service.ts` (business logic + SP-API orchestration) → `*.controller.ts` (Express req/res mapping) → `*.routes.ts` (Router, wrapped in `asyncHandler` from `src/lib/asyncHandler.ts` so rejected promises reach Express's error middleware). Wiring happens in `src/app.ts`, which constructs one `SpApiClient` and passes it into each service.

Current state per module:
- **`listings/`** — fully implemented (the catalog-upload engine): `getProductTypeSchema` (Product Type Definitions API, cached in-memory per process), `validateListing` (Listings Items `preview-errors`), `submitListingItem`/`patchListingItem` (put/patch, persisted via `ListingSubmissionRepository` → Prisma), `submitListingsBatch`/`getBatchStatus` (Feeds API, `JSON_LISTINGS_FEED`). Routes are mounted at `/api/listings/*` — note these are scoped item/schema/batch endpoints, **not** a catalog-listing endpoint; the frontend's `/listings` page calls `GET /api/listings` for a full product list, which does not exist yet on the backend.
- **`inventory/`** — implemented, live: `GET /api/inventory/snapshot` paginates `fbaInventory.getInventorySummaries` directly (no DB read/write, no caching — every request hits Amazon).
- **`sales/`** — implemented, live: `GET /api/sales/summary?start=&end=` requests `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` via the Reports API, polls until `DONE` (up to 2 min — `server.ts` raises Node's default socket timeout to 180s specifically for this), downloads and parses the tab-delimited flat file, and aggregates it server-side. `sales.service.ts` also has a fast path that reads the root `ventas_2026.csv` directly off disk when present, before falling back to the live report — the CSV is not otherwise wired into the app.
- **`brand-analytics/`** — "Funnels de Búsqueda", from `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` (weekly and monthly only; one marketplace per report; ASINs in space-separated batches of ≤200 chars). Full contract in `specs/brand-analytics/`.
  - **Store, download once:** raw report rows are kept per marketplace + report period + period start, in Supabase `snapshots` (`sqp:metrics:<marketplaceId>:<WEEK|MONTH>:<date>`, `searchFunnel.supabaseRepository.ts`) when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set, else in the Prisma table `search_query_metrics`. `SearchFunnelService.sync()` asks Amazon only for report batches with nothing stored, remembers a not-yet-published period for 20 h (`sqp:unavailable:*`), and stops at a report budget (`SQP_MAX_REPORTS`, refills one per minute) so a new marketplace backfills over several runs.
  - **Views:** `period=WEEK|MONTH|LAST_3_MONTHS|LAST_12_MONTHS` (the last two add up stored months with `mergePeriods`), `marketplace=ES|DE|FR|IT`. The response carries `rows` (per term) and `asinRows` (`aggregateByAsin`, every term of an ASIN added up); both are classified on read by `searchFunnel.classifier.ts`.
  - **ASINs:** `SQP_ASINS`, or the top `SQP_MAX_ASINS` sellers of `SQP_BRAND` in that marketplace's sales channel of `ventas_2026.csv`.
  - **Endpoints:** `GET /api/brand-analytics/search-funnel` (`refresh=true` waits for a sync; used only by `publish-snapshots.ts`, which publishes one snapshot per marketplace in `SQP_MARKETPLACES` and view) and `POST|GET /api/brand-analytics/search-funnel/sync`. `frontend/lib/searchFunnel.ts` mirrors the types and `summarizeFunnel`; the Next route serves the snapshot when the backend is absent or empty.
- **`pricing/`, `finance/`, `account-health/`** — structure only. Each has a `README.md` describing which `spapi/endpoints/*` wrapper it should use and which Prisma model it should write to; no service/controller/routes exist yet.

### Persistence (`backend/src/db/`)

`schema.prisma` models one table per monitoring panel (`SalesTrafficDaily`, `InventorySnapshot`, `PriceHistory`/`PricingAlert`, `FinancialEvent`/`UnitEconomics`, `AccountHealthSnapshot`) plus `ListingSubmission` and `SellingPartnerAccount`. In practice only `ListingSubmission` is actually written to today (via `listings.repository.ts`) — `inventory` and `sales` currently return live API data straight through without persisting a snapshot, so the other models are schema-only until their module's service is built out.

### Async work (`backend/src/workers/`)

`queues.ts` declares three BullMQ queues (`report-ingestion`, `feed-processing`, `pricing-poll`) against Redis. No `Worker` consumers exist yet — `workers/jobs/README.md` describes the intended one-job-per-file layout. Right now report-backed endpoints (`sales`) run synchronously inline in the HTTP request instead of going through a queue; moving them to a worker is the natural next step if request-time latency (currently up to ~2 min) becomes a problem.

### Frontend (`frontend/app/`)

Next.js App Router, one route per dashboard panel under `app/dashboard/<name>/page.tsx`, mirroring the backend module names. Pages that have live data (`dashboard/sales`, `dashboard/inventory`) are client components (`"use client"`) that `fetch()` the backend directly using `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) — there's no shared API client wrapper, no server-side data fetching, and no state management beyond local `useState`. `app/listings/` has a list page and `app/listings/new/page.tsx`, a form that calls the listings validate/submit endpoints. The other dashboard pages are still static placeholders. The home page (`app/page.tsx`) currently has hardcoded summary numbers in its panel cards — not fetched from the API.

## Conventions worth knowing before adding a module

- New SP-API operations: add a typed wrapper in `spapi/endpoints/`, then register its rate limit in `SP_API_RATE_LIMITS` (`spapi/rateLimiter.ts`) using the `"<api>.<operation>"` key convention already in use.
- New Express routes must be wrapped in `asyncHandler` (see any existing `*.routes.ts`) — Express 4 does not catch rejected promises from async handlers on its own.
- `SpApiError` (`spapi/types.ts`) carries `statusCode`/`errors`/`isThrottled`/`isRetryable`; controllers that need to distinguish a 4xx validation failure from a transport error should check `error instanceof SpApiError`, following `listings.controller.ts`'s pattern.
- Backend uses ESM (`"type": "module"` in `package.json`) with `NodeNext` module resolution — relative imports must work as ESM.

## Deployment (Vercel + Supabase)

Production does not run the Express backend. `.github/workflows/sync-snapshots.yml` runs the Python sync scripts, then `backend/scripts/publish-snapshots.ts` boots `buildApp()` in-process, calls its own GET endpoints, and upserts each JSON payload into the Supabase `snapshots` table (`key`, `data`, `updated_at`; see `supabase/schema.sql`). `frontend/app/api/**` route handlers just read those rows (`frontend/lib/snapshots.ts`), so response shapes must stay identical to the Express controllers. `frontend/middleware.ts` gates everything behind `APP_PASSWORD` (fails closed in production). `frontend/lib/apiBase.ts` picks localhost:4000 in dev and same-origin `/api` in production builds. When adding a dashboard endpoint, add its key to `TARGETS` in the publish script and a matching route under `frontend/app/api/`.

The same workflow (scheduled runs only) refreshes `catalogo_completo.csv` and runs `npm run replicate:fba` (`backend/scripts/replicate-fba-offers.ts`): every FBA listing sold in ES gets an offer in DE/FR/IT at DE = ES price, FR/IT = ES + 2 €, and the prices of offers the rule manages (ones it created, and every offer of SKUs added after the baseline) follow ES. Offers that already existed at the baseline are never repriced. State and the last-run report live in Supabase `snapshots` (`rules:fba-replication:*`). It only writes to Amazon when the repo variable `FBA_REPLICATION_APPLY` is `1`; it never uses `delete` patches, since deleting a sub-attribute of `purchasable_offer` removes the whole offer.

Before that, scheduled runs execute `npm run enforce:fbm-floor` (`backend/scripts/enforce-fbm-floor.ts`, logic in `scripts/lib/fbm-floor.ts`): in ES/DE/FR/IT every FBM offer must be at least 1.05 × the price of the FBA offer (not `amzn.gr.`) of the same ASIN (the most expensive one if there are several; sale price if one is active). FBM offers below are raised (skipping SKU/country pairs in `fixed_prices.csv` and FBM offers with an active sale below the floor), and the floors of every FBM are published to Supabase `rules:fbm-floor:prices`. `sync_daily_stock_amz.py` (the 9:00 FBM feed from STOCK AMZ, run on the Mac) loads those floors and sends `max(file price + country offset, floor)`, so the morning feed no longer reverts the rule. Writes by default; repo variable `FBM_FLOOR_APPLY=0` only reports (`rules:fbm-floor:last-run`).

Scheduled runs then execute `npm run enforce:price-bounds` (`backend/scripts/enforce-price-bounds.ts`) over every ES FBA SKU in ES/DE/FR/IT, applying the rule in `backend/src/lib/priceBounds.ts`: with a non-expired `discounted_price`, `minimum_seller_allowed_price` = half the sale price; if `our_price` is above `maximum_seller_allowed_price`, the max becomes twice the price (and a min left above the price drops to half of it). It writes by default; set repo variable `PRICE_BOUNDS_APPLY=0` to only report (`rules:price-bounds:last-run` in `snapshots`). Every code path that changes a price (panel PATCH in backend and `frontend/app/api/listings/items/[sku]`, replication `syncPrice`, `sync_prices_stock.py`) applies the same rule before patching; `frontend/lib/priceBounds.ts` is a copy of the backend module and must stay in sync.

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

## Listing cleanup (archive → delete → reactivate)

Dead listings (created ≤ 2024, no sales of the SKU or its ASIN since 2025-01-01 in `ventas_*.csv`, no FBM stock, no FBA inventory of any kind, not a variation parent, not BUYABLE anywhere) are removed in three steps, all under `backend/scripts/` with logic in `scripts/lib/listing-cleanup.ts`:

1. `npm run listings:archive` — read-only. Checks each candidate live in all EU marketplaces and archives it in Supabase `snapshots` (`listings:archive:<sku>`, plus a local copy in `backend/data/listing-archive.json`). Resumable. Writes `listings_a_borrar_<date>.csv` / `listings_excluidos_<date>.csv` at the repo root.
2. `npm run listings:delete` — re-checks live and deletes the SKU in every marketplace where it exists, oldest first, `LIMIT` per run (default 2000). Only deletes with `LISTINGS_DELETE_APPLY=1`.
3. `npm run listings:reactivate` — recreates deleted offers on the same ASIN (`LISTING_OFFER_ONLY`, same SKU). By default it reads the latest STOCK AMZ copy that `sync_daily_stock_amz.py` publishes to Supabase (`stock:latest:meta` + `stock:latest:NNNN`, skipped if older than `MAX_STOCK_AGE_HOURS`, default 48) and recreates every deleted FBM SKU with quantity > 0 in ES/DE/FR/IT at file price + ES 0 / DE 5 / FR 6 / IT 7, capped at `MAX_REACTIVATIONS` (300) per run. `STOCK_FILE=` (STOCK AMZ exported to text) or `SKUS=a,b,c` override the source. Validates only unless `LISTINGS_REACTIVATE_APPLY=1`. The scheduled workflow runs it with apply on by default (repo variable `LISTINGS_REACTIVATE_APPLY=0` to only validate); report in `rules:listings-reactivation:last-run`.

Deletion (step 2) is not in the workflow; it is run by hand.

Deleting the only offer of an ASIN usually makes Amazon drop that marketplace's detail page, so the archive (v2) keeps every listing attribute, content included, and reactivation falls back to a full `LISTING` put from the archived attributes when Amazon asks for `item_name`. `REFRESH_ARCHIVED=1 npm run listings:archive` rebuilds pending v1 records with full attributes (status `kept` if they no longer qualify); `npm run listings:recover-content` backfills already-deleted v1 records from the Catalog Items API (images are copied to marketplaces whose page is gone; text only where the page still exists).

The daily stock sync sends `PARTIAL_UPDATE`s, which Amazon rejects for deleted SKUs — a deleted listing never comes back on its own, only through step 3.

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
