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
