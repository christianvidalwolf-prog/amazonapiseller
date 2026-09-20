# Job handlers

BullMQ `Worker`s that consume `../queues.ts`. One file per job:
- `reportIngestion.job.ts` — createReport → poll → download → hand off to the owning module's service (sales/inventory/account-health).
- `feedProcessing.job.ts` — polls `ListingsService.getBatchStatus` until DONE/FATAL and records results.
- `pricingPoll.job.ts` — periodic getCompetitivePricing sweep for SKUs without an active ANY_OFFER_CHANGED subscription.
