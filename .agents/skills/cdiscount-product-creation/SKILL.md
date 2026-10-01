---
name: cdiscount-product-creation
description: Create and activate products and offers in Cdiscount through the Octopia Seller API, including image validation, package integration, category and variant attributes, offer publication, and error diagnosis.
---

# Cdiscount product creation

Use this skill for creating, publishing, activating, retrying, or diagnosing Cdiscount products and offers through Octopia. Treat the product fiche and seller offer as separate asynchronous workflows.

## The rule that costs the most to get wrong

A **package accepted is not a product created**. `POST /products-integration` returning a `packageId` only means the upload was received. Persist progress only for the items the integration report marks `Integrated`; treat everything else as retryable. One daily batch marked 438 fichas as "sent" while 130 of them had been refused (125 by quota, 5 by data) and those were never retried.

## Get the official schema instead of guessing

The API host exposes no OpenAPI. The real spec downloads from:

```
https://developer.octopia-io.net/wp-json/octopia/v1/download/sellers    # YAML, ~650 KB
```

Product payload (`components/schemas/Product`), with `Accept-Language: fr-FR`:

```json
{
  "products": [{
    "gtin": "…", "sellerProductReference": "…", "title": "…",
    "description": "…", "brand": "…",
    "sellerPictureUrls": [{"index": 1, "url": "https://…jpg"}],
    "categoryCode": "0E040K",
    "variantGroupReference": "B0CV4…",
    "attributes": [{"propertyReference": "3263", "values": ["Argenté"]}]
  }]
}
```

## The three refusals you will actually hit

### 1. `CategorizationError` (on Title + Description)

> *Les éléments fournis dans le titre et - ou la description … ne sont pas assez explicites pour nous permettre de valider que la catégorie associée est adéquate.*

- **The title must name the product type of the category.** `Lot de 8 cannes à boisson …` was refused for category `PAILLE NON JETABLE`; `Lot de 8 pailles à boisson …` was integrated. Fix the wording, not only the field.
- Sending `categoryCode` alone does **not** clear it: the content still has to justify that category.
- Never leave a **contradicting** category in the description. A trailing `Catégorie : … Ornements à suspendre` while forcing `PAILLE` re-triggers the same error.
- Octopia recategorizes when the content justifies it: a forced `190K01 ESOTERISME-PARANORMAL` ended up as `0Z010I PIERRE VENDUE SEULE`, which is the better home.

### 2. `ER400-7480` — `VariantGroupReference` mandatory

The assigned category is a variant one (`GET /categories/{reference}` → `isVariant: true`). Send `variantGroupReference` (the ASIN works as the family identifier) **and keep sending it**: once Cdiscount moves on to asking for attributes it stops repeating this error, but it drops the product again if you stop sending the group.

### 3. `ER400-6067` — "L'attribut est requis"

Each error's `field` **is the property reference** (e.g. `3263`, `46830`). Resolve them with `GET /categories/{reference}/properties` (`necessity`, `choices`, `isVariation`, `isSize`) and send them as `attributes`. For `0Z0102 BAGUE - ANNEAU`: `3263` = Couleur(s) (free text) and `46830` = Taille bijou (list; `Taille unique` is a valid value, as are ring sizes). Variation properties also require `variantGroupReference`.

## Content rules that decide integration

- **Keep the whole title.** A formatter that grabbed the first 6 words plus 2 keywords produced `…2139462CLM en forme` (losing `de cœur`) and `…15 x` (losing `23 cm`). Max 132 characters, cut at a word boundary.
- **A description that repeats the title adds nothing.** Enrich it with the Amazon FR `bullet_point`, `product_description` and the classification path — that took a 45-character description to ~1.5 k and got a refused fiche integrated.
- Request from Amazon FR: `includedData=summaries,images,productTypes,classifications,attributes`. Use `browseClassification.displayName` and walk `classifications[].parent` for the localised path.

## API quirks (all verified against production)

| Quirk | Consequence |
| --- | --- |
| `/products-integration-reports` returns **max 25 items per package** and does not paginate (`page`, `offset`, `skip`, `limit`, `itemsPerPage` are ignored; `pageSize` returns HTTP 400) | Submit batches of **≤25**, or you can never verify a whole batch |
| Creation quota observed ≈ **25 fichas/hour** | 6 batches of ~50 in 28 s: the first passed, everything after was `QuotaExceeded`. Pace to ~25/h |
| `GET /products?sellerProductReference=…` is **ignored** (always returns the first product) | Verify existence with `?gtin=` |
| `GET /categories?…` returns bare references unless you pass `fields=…` | Always request `fields=label,categoryReference,level,isVariant` |
| The reports endpoint lags behind the upload | Poll the report; leave unseen items pending instead of marking them sent |

## Verification sequence

1. `POST /seller/v2/products-integration` → save `packageId`.
2. `GET /seller/v2/products-integration-reports?packageId={id}` → require `status: Integrated` **per item**, not per package.
3. `POST /seller/v2/offer-packages` with `{"packageType":"Upsert"}`.
4. `POST /seller/v2/offer-packages/{id}/offer-requests`.
5. `PATCH /seller/v2/offer-packages/{id}` with `{"state":"Ready"}`.
6. `GET /seller/v2/offer-packages/{id}/offer-requests-results` → require `integrationStatus: Integrated`.
7. `GET /seller/v2/offers?salesChannelId=CDISFR&sellerExternalReferences={sku}`.

## Product image

```json
"sellerPictureUrls": [{"index": 1, "url": "https://…jpg"}]
```

Reachable without login or redirect, 500×500 to 3000×3000 px, ≤5 MB, jpg/png/gif/bmp/webp.

## Offer delivery

```json
"preparationTime": 2,
"deliveryModes": [{"code": "THD", "cost": 4.99, "additionalCost": 0.0}]
```

Delivery codes depend on the seller/channel configuration; inspect integration results instead of silently substituting unsupported codes.

## Diagnosis index

- `MissingField SellerPicture_1` → use `sellerPictureUrls` with `index` and a reachable URL.
- `Product - non-existent` → integrate the product fiche before submitting an offer.
- `Offer inexistante` / update rejected → use `Upsert`, not `Update`, for the first offer.
- `PreparationTime: Wrong format` → send an integer such as `2`.
- `Delivery fees - Tracking mode` → configured delivery codes plus `cost`/`additionalCost`.
- Same-GTIN reports can contain older rejected attempts; identify the newest `packageId` and `submissionDate`.
- Full error table: https://developer.octopia-io.net/api-reference/product-management/product-error-report/

External mutations require explicit user intent. For batches, persist progress only after package acceptance, but do not mark a product successfully created until the integration report confirms it. Read [references/octopia-api-notes.md](references/octopia-api-notes.md) for the compact API checklist.
