# Inventory & Supply Chain module

Uses `spapi/endpoints/fbaInventory.ts` (`getInventorySummaries`,
`calculateDaysOfCover`) plus `GET_FBA_MYI_ALL_INVENTORY_DATA` report ingestion
to populate `InventorySnapshot`.

Planned files:
- `inventory.service.ts` — snapshot capture + days-of-cover + stranded-inventory detection.
- `inventory.controller.ts` / `inventory.routes.ts` — `GET /api/inventory/snapshot`, `GET /api/inventory/stranded`.
