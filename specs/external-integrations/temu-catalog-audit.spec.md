# Temu catalog audit and guarded updates

## Scope

The Temu Open Platform client reads local listing data for the ES shop and supports only the catalog operations required by the authorized catalog audit. It signs requests with the Temu Open Platform MD5 scheme, posts JSON to the configured router URL, spaces requests by 150–250 ms, and never retries an API error. Credentials are loaded at runtime from a caller-selected local env file and are never copied into the repository, logs, command output, or reports.

## Read operations

- `bg.local.goods.list.query`: query status filters 1, 2, 4, 5, and 6 with pagination capped at 100 rows per page. Count status 1 only.
- `bg.local.goods.detail.query`: request details for every returned item in filters 2, 4, 5, and 6. Do not request details for filter 1.
- If error `5000003` / `NOT_IN_IP_WHITE_LIST` occurs, obtain the public IP using `curl -s https://api.ipify.org`, report it, and stop all product work.
- Code/status `150010205` means Temu is processing the product. Do not edit it.

## Guarded corrective updates

Only `bg.local.goods.partial.update` may change existing product content. Never delete a product or change status. Source description, bullets, external product ID, EAN, and images only from Amazon SP-API Catalog Items 2022-04-01 or PrestaShop facts for the matching SKU. Do not infer electrical or other compliance attributes.

For `150011000`, query the category template for the product's `catId`; provide only mandatory values directly supported by source/product facts; call `bg.local.goods.compliance.property.check`; update only if the check passes. For fewer than three or rejected images, use real Amazon/PrestaShop images and the Temu image upload operation before updating. Set stock only when PrestaShop confirms positive stock for the exact SKU. Any price sent must equal the current Amazon ES B2C price for marketplace `A1RKKUPIHCS9HS`.

If an adjustment fails, stop retrying that item, retain the exact Temu error code/message as `requiere_revision_manual`, and specify the Seller Center action needed. Never write to status-1 items.

Observed permanent response `150010110 — Editing Disabled During Review` is recorded verbatim. The Seller Center action is to review the active review task/status, wait for review to finish or resolve it, and then submit the content correction. If no current Amazon ES B2C offer can be verified, leave the SKU untouched and restore/confirm its consumer offer before rerunning. If the product has no source-matchable SKU/ASIN, verify the Temu-to-Amazon/PrestaShop reference in Seller Center first.

## Verification evidence

Connectivity verification uses a one-record read-only list call and reports only HTTP result, count, and response key names. The audit output is limited to identifiers, source-presence flags, counts, and API error details; it must not include credentials or full request/response bodies.
