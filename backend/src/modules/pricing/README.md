# Buy Box & Pricing module

Wraps `spapi/endpoints/productPricing.ts` for on-demand pricing checks and
`spapi/endpoints/notifications.ts` to subscribe to `ANY_OFFER_CHANGED`.

Planned files:
- `pricing.service.ts` — polling + alert generation into `PricingAlert`.
- `pricing.webhook.ts` — SQS consumer for `ANY_OFFER_CHANGED` notifications.
- `pricing.routes.ts` — `GET /api/pricing/:asin`, `GET /api/pricing/alerts`.
