# Account Health, Compliance & CS module

Uses `spapi/endpoints/sellerPerformance.ts` (`GET_V2_SELLER_PERFORMANCE_REPORT`)
to populate `AccountHealthSnapshot` (ODR, late shipment rate, cancellations),
plus Returns Reports / Customer Feedback ingestion for negative-feedback
monitoring.

Planned files:
- `account-health.service.ts`, `account-health.controller.ts`, `account-health.routes.ts`.
