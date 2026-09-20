# Sales & Traffic module

Ingests `GET_SALES_AND_TRAFFIC_REPORT` (Reports API) and recent orders
(Orders API, `spapi/endpoints/orders.ts`) into `SalesTrafficDaily`.

Planned files:
- `sales.service.ts` — orchestrates report request → poll → download → parse → upsert.
- `sales.controller.ts` / `sales.routes.ts` — `GET /api/sales/daily`, `GET /api/sales/orders/recent`.

Metrics owned here: units, net sales, CVR, sessions, Buy Box %.
