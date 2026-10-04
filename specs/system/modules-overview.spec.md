# Especificación SDD: Listings, BSR, Account Health & Sync

---

## 1. Módulo `listings` (`specs/listings/listings.spec.md`)
- **Propósito:** Supervisión del catálogo, títulos, descripciones, imágenes principales y estado de supresión de listings (Listings Items API).
- **Contratos:**
  - `status`: `BUYABLE`, `DISCOVERABLE`, `DELETED`, `SUPPRESSED`.
  - Motivos de supresión: Falta de imagen principal, título no conforme a política o atributos obligatorios incompletos.
- **Endpoints:** `GET /api/listings`, `GET /api/listings/:sku/issues`.

---

## 2. Módulo `bsr` (`specs/bsr/bsr.spec.md`)
- **Propósito:** Monitorización histórica del Best Sellers Rank (BSR) por categoría y subcategoría para cada ASIN propio y de competidores directos.
- **Contratos:**
  - `categoryId`, `rank`, `timestamp`, `marketplaceId`.
- **Endpoints:** `GET /api/bsr/history?asin=...`, `GET /api/bsr/top-movers`.

---

## 3. Módulo `account-health` (`specs/account-health/account-health.spec.md`)
- **Propósito:** Detección preventiva de riesgos de suspensión y control de los SLAs exigidos por Amazon Seller Central.
- **Métricas Contractuales:**
  - **ODR (Order Defect Rate):** Debe ser estrictamente `< 1.00%`.
  - **CR (Cancellation Rate):** Debe ser `< 2.50%`.
  - **LDR (Late Dispatch Rate):** Debe ser `< 4.00%`.
  - **VTR (Valid Tracking Rate):** Debe ser `>= 95.00%`.
- **Endpoints:** `GET /api/account-health/status`, `GET /api/account-health/violations`.

---

## 4. Módulo `sync` & Sistema (`specs/sync/sync.spec.md`)
- **Propósito:** Motor de orquestación de tareas en segundo plano (*background workers*), cron jobs y gestión del almacenamiento dual (PostgreSQL + Snapshots para Frontend).
- **Contratos:**
  - Control de concurrencia: Bloqueo de sincronizaciones duplicadas del mismo tipo mediante semáforos/estados de tarea (`running`, `idle`, `failed`, `done`).
  - Límite de retención de reportes históricos en base de datos.
- **Endpoints:** `GET /api/sync/status`, `POST /api/sync/trigger/:module`.
