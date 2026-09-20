# Finance & Unit P&L module

Ingests `spapi/endpoints/finances.ts` (Finances API v2024) plus Settlement
Reports into `FinancialEvent`, and computes per-SKU `UnitEconomics`
(selling price − COGS − FBA fees − referral fee − ad spend).

Planned files:
- `finance.service.ts`, `finance.controller.ts`, `finance.routes.ts`.
