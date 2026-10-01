# Octopia API notes

## Verification sequence

1. `POST /seller/v2/products-integration` → save `packageId`.
2. `GET /seller/v2/products-integration-reports?packageId={id}` → require `status: Integrated` per item.
3. `POST /seller/v2/offer-packages` with `{"packageType":"Upsert"}`.
4. `POST /seller/v2/offer-packages/{id}/offer-requests`.
5. `PATCH /seller/v2/offer-packages/{id}` with `{"state":"Ready"}`.
6. `GET /seller/v2/offer-packages/{id}/offer-requests-results` → require `integrationStatus: Integrated`.
7. `GET /seller/v2/offers?salesChannelId=CDISFR&sellerExternalReferences={sku}`.

## Get the schema first

```bash
curl -sL https://developer.octopia-io.net/wp-json/octopia/v1/download/sellers -o octopia-sellers-api.yaml
```

Product payload fields: `gtin`, `sellerProductReference`, `title`, `description`, `richMarketingDescription`, `brand`, `sellerPictureUrls`, `categoryCode`, `variantGroupReference`, `attributes`.

```json
"attributes": [{"propertyReference": "3263", "values": ["Argenté"]}]
```

## Looking up what a category demands

```bash
GET /seller/v2/categories/{reference}              # label, level, isVariant, isBrandMandatory
GET /seller/v2/categories/{reference}/properties   # necessity, choices, isVariation, isSize
GET /seller/v2/categories?pageIndex=1&pageSize=200&fields=label,categoryReference,level,isVariant
```

`fields=…` is mandatory: without it the category list returns bare references. The list has ~8 000 entries.

Known examples:

| Category | Meaning | Mandatory properties |
| --- | --- | --- |
| `0Z0102` | BAGUE - ANNEAU (isVariant) | `3263` Couleur(s), `46830` Taille bijou |
| `0Z010I` | PIERRE VENDUE SEULE | none |
| `0E040K` | PAILLE NON JETABLE | none |
| `0C0I05` | DECORATION DE TABLE - CENTRE DE TABLE | none |
| `190K01` | ESOTERISME- PARANORMAL | none |

## Product image

```json
"sellerPictureUrls": [{"index": 1, "url": "https://...jpg"}]
```

## Offer delivery

```json
"preparationTime": 2,
"deliveryModes": [{"code": "THD", "cost": 4.99, "additionalCost": 0.0}]
```

Delivery codes depend on the seller/channel configuration; inspect integration results instead of silently substituting unsupported codes.

## Verified limits

- Reports return at most **25 items per package** and do not paginate → batch size ≤25 to verify 100%.
- Creation quota ≈ **25 fichas/hour**; over that, items come back `Refused / QuotaExceeded`.
- `GET /products?sellerProductReference=…` is ignored; use `?gtin=`.
