# Amazon Seller Ops — SaaS scaffold

Modular SaaS para gestión integral de cuentas Amazon Seller Central sobre
SP-API. Este scaffold implementa el punto de partida pedido: estructura de
carpetas, cliente base SP-API (LWA + rate limiting + backoff), y el
`ListingsService` del motor de catalogación.

## Estructura

```
backend/                   Node.js/TypeScript API
  src/
    spapi/                 Cliente base SP-API (reutilizable por todos los módulos)
      client.ts            HTTP client: auth + token-bucket rate limit + retry/backoff
      lwaAuth.ts            OAuth LWA (refresh token -> access token, cacheado)
      rateLimiter.ts        Token bucket por operación + límites publicados por Amazon
      types.ts               Tipos compartidos + SpApiError
      endpoints/             Wrappers tipados por API (orders, reports, fbaInventory,
                              productPricing, finances, sellerPerformance, notifications,
                              productTypeDefinitions, listingsItems, feeds)
    modules/
      listings/             Motor de catalogación (implementado — ver abajo)
      sales/                Ventas y Rendimiento (estructura, ver README del módulo)
      inventory/             Inventario y Logística (estructura)
      pricing/                Buy Box y Precios (estructura)
      finance/                Finanzas y P&L Unitario (estructura)
      account-health/         Salud de Cuenta y Compliance (estructura)
    workers/                BullMQ: colas + jobs desacoplados para llamadas pesadas
    db/prisma/schema.prisma  Modelo relacional para los 5 paneles + catalogación
    config/env.ts            Carga y valida variables de entorno
    app.ts / server.ts       Wiring de Express

frontend/                  Next.js (App Router) + TypeScript + Tailwind
  app/dashboard/*           Un panel por módulo de monitorización
  app/listings/             Listado + formulario de alta de listing (conectado al backend)

docker-compose.yml          Postgres + Redis + ClickHouse para desarrollo local
```

## Los 3 entregables pedidos

1. **Cliente base SP-API** — `backend/src/spapi/client.ts`, apoyado en
   `lwaAuth.ts` (OAuth LWA con refresh automático) y `rateLimiter.ts`
   (token bucket por operación + backoff exponencial con jitter y respeto de
   `Retry-After`).
2. **`ListingsService`** — `backend/src/modules/listings/listings.service.ts`:
   - `getProductTypeSchema(productType, marketplaceId)` — Product Type
     Definitions API, con caché en memoria por proceso.
   - `validateListing(sku, payload)` — `preview-errors` de Listings Items API.
   - `submitListingItem(sku, payload)` — `putListingsItem`, persiste
     `submissionId` + issues vía `ListingSubmissionRepository`.
   - Bonus: `patchListingItem` (updates parciales) y `submitListingsBatch` /
     `getBatchStatus` (Feeds API, `JSON_LISTINGS_FEED`) para altas masivas.
3. **Estructura modular** — carpetas arriba; los módulos de monitorización
   (sales/inventory/pricing/finance/account-health) tienen su README con el
   plan de archivos y qué endpoint de `spapi/endpoints/` consumen; el schema
   Prisma ya modela sus tablas para que la implementación de cada servicio
   sea directa.

## Cómo arrancar

```bash
docker compose up -d          # postgres + redis + clickhouse
cp backend/.env.example backend/.env      # rellenar con las mismas credenciales que el .env raíz existente
cd backend && npm install && npm run prisma:migrate && npm run dev

cp frontend/.env.example frontend/.env.local
cd frontend && npm install && npm run dev
```

## Nota sobre los scripts Python existentes

`auth.py`, `get_fba_inventory.py`, `get_sales_2026.py` y `.env` en la raíz son
scripts previos independientes de este scaffold — no se han tocado. Las
credenciales LWA que ya usan (`LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`,
`SP_API_REFRESH_TOKEN`, `SP_API_REGION`) son las mismas que necesita
`backend/.env`.

## Despliegue (Vercel + Supabase + GitHub Actions)

Vercel no ejecuta el backend Express: los informes de Amazon tardan minutos. En su lugar,
un workflow programado descarga los datos y los guarda en Supabase, y Vercel solo los lee.

```
GitHub Action (cada 3 h) ─► scripts Python + backend ─► Supabase (tabla `snapshots`)
                                                              ▲
Navegador ─► Vercel (Next.js, login con contraseña) ─► /api/* ┘
```

1. **Supabase**: crea un proyecto y ejecuta `supabase/schema.sql` en el SQL Editor.
2. **GitHub → Settings → Secrets and variables → Actions**: `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`,
   `SP_API_REFRESH_TOKEN`, `SP_API_SELLER_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (opcionales: `ADS_API_CLIENT_ID`, `ADS_API_CLIENT_SECRET`, `ADS_API_REFRESH_TOKEN`, `ADS_API_PROFILE_ID`).
3. **Actions → "Sync Amazon data → Supabase" → Run workflow**. La primera ejecución descarga
   2025 y 2026 completos (puede tardar bastante); las siguientes son incrementales.
4. **Vercel**: importa el repo con *Root Directory* = `frontend` y define `APP_PASSWORD`,
   `AUTH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

En producción el panel es de solo lectura: alta de listings, panel Auto-Sync, detalle de ofertas
por ASIN y los botones "actualizar" requieren el backend en local (`npm run dev` en `backend/`).
