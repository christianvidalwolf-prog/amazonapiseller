# Auditoría independiente — plantilla de envío de Alemania (2026-11-04)

> **Regla vigente (corregida).** Toda oferta **FBM** (`fulfillment-channel` = `DEFAULT`) de Alemania
> (`A1PA6795UKMFR9`, vendedor `A3RY0L9OY3TPHI`) con **precio efectivo < 35,00 €** tiene que estar en la
> plantilla **de pago**: `merchant_shipping_group = legacy-template-id` (o el atributo ausente, que Amazon
> cobra igual). La plantilla del UUID `395e11ea-3c51-4820-aa8f-74e6cf2a4e72` es la de **envío gratis** y
> por debajo de 35 € es una violación. Por encima de 35 € no se toca nada; FBA tampoco.

Auditoría de solo lectura (solo `GET`) hecha por una sesión distinta de la que escribe el script de
corrección. No se ha escrito nada en Amazon ni en Supabase.

Material: `de_all_listing_report_fresh.tsv` (`GET_MERCHANT_LISTINGS_ALL_DATA` de DE, **generado hoy
2026-11-04 a las 22:11**, 32.684 filas), `blocked_skus.txt`, `fixed_prices.csv`, Supabase `rules:sales` /
`rules:manual-price:*`, `Product Pricing API` y el histórico de pedidos MFN de DE.

Verificador: `backend/scripts/verify-de-shipping-group.ts` → `npm run verify:de-shipping-group`.

**Nota histórica.** La primera versión de este documento (misma fecha, antes de la confirmación del
negocio) auditaba la regla tal como venía escrita —"todo FBM < 35 € al UUID"— y concluyó que la premisa
estaba invertida: el UUID no es la plantilla de pago. El 2026-11-04 el negocio confirmó la corrección y
este documento recoge la regla definitiva.

---

## 0. Resumen

| Concepto | Valor |
|---|---|
| Regla | FBM de DE con precio efectivo < 35,00 € → `legacy-template-id` |
| **Candidatos** (FBM en el UUID y precio de tarifa < 35 €) | **4.865** |
| … `Active` / `Inactive` | 2.351 / 2.514 |
| … con `quantity` > 0 | 2.524 |
| … en `blocked_skus.txt` | **0** |
| … que cambian de lado del umbral con el precio efectivo | **0** |
| FBM < 35 € ya en la plantilla de pago (correctos, no se tocan) | 13.701 |
| FBM en el UUID que hay que revisar además de los candidatos (35–47 €) | 1.044 |
| Fuga residual si no se aplica | 4.865 listings baratos enviando gratis |

---

## 1. Evidencia de qué plantilla cobra qué

### 1.1 `Product Pricing API` — `GET /products/pricing/v0/listings/{sku}/offers`

24 SKU FBM `Active` con precio < 35 €, 12 en cada plantilla (muestra aleatoria, semilla 99):

| Plantilla en vivo | SKU (muestra) | `Shipping` |
|---|---|---|
| UUID `395e11ea-…` | 3067211CLM, 306331CLM, 23481672CLM, 2185883CLM, 2676128CLM, 2676287CLM, 17840VCI, 15995VCI, 267689CLM, 306369CLM, 37978SGRI, 40067MD | **0,00 € en 12/12** |
| GRUPO 0 / `legacy-template-id` | 2185992DCI, 40178SGI, 3373VCI, 2714506DCI, 3098413DCI, 39913SGI, 39034SGI, 306832CLM, 308920CLM, 8978VC, 272747DCI, 2758455CLM | **3,99 € en 12/12** |

Ejemplos en crudo:

```
10007VC   (UUID)      ListingPrice 15.95  Shipping 0.00
27285SGRG (UUID)      ListingPrice 24.95  Shipping 0.00
22211966CLM (GRUPO 0) ListingPrice 31.50  Shipping 3.99
45927RGSG (GRUPO 0)   dos ofertas nuestras: 46.95 → Shipping 0.00 (B2B)
                                            54.95 → Shipping 3.99 (B2C)
```

Ojo con `45927RGSG`: la oferta **B2B** de un listing FBM sale con `Shipping 0.00`. La plantilla de envío
gobierna el envío **B2C**; el B2B no lo cobra. No es un dato contradictorio, es otra audiencia.

### 1.2 Pedidos reales (MFN de DE, 18/10 → 4/11)

| Plantilla en vivo | Líneas de pedido | `ShippingPrice` |
|---|---|---|
| UUID | 25 | ninguna a 3,99 € (23 a 0,00 €; 0,83 € y 2,16 € son repartos entre líneas) |
| `legacy-template-id` | 43 | 19 a **3,99 €** (+ 3,36 / 4,58 / 8,17 por banda de peso) |
| atributo ausente | 49 | 13 a **3,99 €**; los 0 € son todos listings FBA |

Prueba temporal: los `*DCI`/`*SGI` estaban en el UUID hasta el 25–26/10 y sus pedidos de esas fechas
salieron a **0 €**; desde el 26/10, ya en `legacy-template-id`, salen a **3,99 €**.

Corrobora lo que ya decía el repo: `sgi_reasignar_default.py:22` (`# …'GRUPO 4', envío 0 €`), `:68`
(`legacy-template-id = 3,99 €`) y `create_listings_en.py` → `create_listings_eu.py:285` (los listings
nuevos nacen en `legacy-template-id`).

### 1.3 Fiabilidad del informe

Con el informe de hoy, 150 candidatos muestreados: **150/150 con el UUID en vivo** y **150/150 con el
precio de tarifa igual al precio de venta en vivo**. El informe recién pedido es fiable; el volcado viejo
del 25/10 no lo era (5.698 SKU `*DCI`/`*SGI` se movieron después de generarse).

---

## 2. Números definitivos (`de_all_listing_report_fresh.tsv`)

32.684 filas · 32.005 FBM (`DEFAULT`) · 679 FBA (`AMAZON_EU`).

| Métrica | Valor |
|---|---|
| FBM por etiqueta del informe | GRUPO 0 (pago): 23.356 · GRUPO 4 (gratis): 8.649 |
| FBM con precio < 35 € | 18.566 (13.701 ya en pago + **4.865 en el UUID**) |
| **Candidatos a mover** | **4.865** |
| … `Active` / `Inactive` / `Incomplete` | 2.351 / 2.514 / 0 |
| … con `quantity` > 0 | 2.524 (2.351 `Active` + 173 `Inactive` con stock) |
| FBM en el UUID sin precio (no evaluables) | 691 |

### 2.1 Buckets de precio de los 4.865 candidatos

| < 10 € | 10–20 € | 20–30 € | 30–35 € |
|---|---|---|---|
| 66 | 2.377 | 1.837 | 585 |

### 2.2 Reparto del UUID por precio (dónde mirar)

| < 10 | 10–20 | 20–30 | 30–35 | **35–40** | **40–45** | **45–47** | 47–60 | ≥ 60 |
|---|---|---|---|---|---|---|---|---|
| 66 | 2.377 | 1.837 | 585 | 500 | 409 | 135 | 639 | 1.410 |

Los tramos 35–47 € (1.044 listings) no son candidatos, pero **sí** hay que leerlos: una oferta no
registrada puede dejarlos por debajo de 35 €. Ver 3.2.

### 2.3 Familias y tipos de producto

Product types de los candidatos (muestra de 150, 50 tipos distintos): `HOME` 48, `CHARM` 10, `BRACELET` 9,
`HOME_FURNITURE_AND_DECOR` 7, `GIFT_WRAP` 6, `TOTE_BAG` 4, `INCENSE` 4, `SOCKS` 4, `HANGING_ORNAMENT` 3,
`PICTURE_FRAME` 3, `DRINKING_CUP` 3, `LOOSE_CUT_GEM` 3… Ninguno es exótico.

Familias de SKU: `CLM` y `VC` dominan la fuga barata (históricamente el 100 % de `*DCI` y `*SGI` ya se
movió el 25–26/10, por eso no aparecen).

---

## 3. Precio efectivo (informe + overrides) y cruces de riesgo

### 3.1 Resultado: **0 de 4.865 cambian de lado**

Sobre los 4.865 candidatos, con la prioridad del repo (oferta vigente → precio manual del panel →
`fixed_prices.csv` → tarifa del informe):

| Fuente | Entradas DE | Candidatos afectados | Efecto |
|---|---|---|---|
| `rules:sales` (ofertas registradas) | 56, todas vigentes | **0** | ninguna: las 56 son SKU `*FBA` del stock parado |
| `rules:manual-price:*:DE` | 5 | **2**: `27285SGRG` 24,95 · `33101SGRI` 14,95 | idénticos a la tarifa → sin cambio |
| `fixed_prices.csv` | 47 | **4**: `11934VC` 19,95 · `176SGRG` 21,95 · `17999VCI` 25,95 · `2658VCT` 32,50 | idénticos a la tarifa → sin cambio |
| `blocked_skus.txt` | 9 SKU | **0** | nada que excluir |

Los 6 SKU con override tienen el mismo importe que la tarifa, así que el precio efectivo coincide con el
del informe. **Ninguno cruza el umbral**: no hay ningún candidato que deje de serlo.

### 3.2 El caso contrario: ofertas activas **no registradas**

En la muestra de 150 candidatos, **4 tenían una oferta vigente que no está en `rules:sales`** (campaña
−25 %, fin 2026-12-30): `2974VCO` 11,80 → 8,85 · `3982VC` 29,00 → 21,75 · `14914SGR` 29,60 → 22,20 ·
`4203VC` 12,60 → 9,45. Siguen < 35 €, así que no cambian el veredicto, pero demuestran que
**`rules:sales` no está completo**: el script no puede decidir el precio efectivo solo con Supabase.

Y hay un caso que el informe **no ve**: `7932VC0`, tarifa **43,90 €**, oferta vigente **32,92 €** (hasta el
30/12). Su precio efectivo es < 35 €, así que le corresponde la plantilla de pago, pero un filtro por
precio de tarifa lo deja fuera. En la muestra de 120 listings de 35–45 € del UUID apareció **1**, lo que
extrapola a ≈8 de los 923 de esa banda. **No forman parte de los 4.865** y hay que tratarlos aparte.

---

## 4. Riesgos y casos límite

1. **La oferta no registrada** (`7932VC0`, 43,90 € de tarifa con oferta de 32,92 €): el candidato se
   escapa si se filtra por tarifa. Mitigación: decidir con el precio efectivo leído en vivo y revisar la
   banda 35–47 € del UUID (1.044 listings, `VERIFY_NEAR` por defecto ya los cubre).
2. **`rules:sales` incompleto** (`2974VCO`, `3982VC`, `14914SGR`, `4203VC` tienen ofertas vigentes que no
   están en Supabase). El precio efectivo tiene que salir del listing, no de Supabase.
3. **Plantilla ausente ≠ GRUPO 0 "gratis".** Ausente cobra 3,99 € igual que `legacy-template-id`. Si el
   verificador tratase "ausente" como violación, daría miles de falsos positivos (13.701 FBM < 35 € están
   así y están bien). La violación es exactamente `merchant_shipping_group = <UUID gratis>`.
4. **Listings `Inactive` (2.514 de 4.865).** Son el 52 % de las escrituras. Moverlos es inocuo y evita que
   vuelvan gratis, pero multiplica las llamadas; decidir explícitamente si entran.
5. **`merchant_shipping_group` con una sola entrada por listing** (40 de 40 comprobados). Un `replace` con
   `[{value, marketplace_id: A1PA6795UKMFR9}]` no borra otros mercados.
6. **`purchasable_offer` trae dos audiencias** (`ALL` y `B2B`): leer la B2B da precios ~5 % más bajos
   (`3132VC`: 28,00 B2C vs 26,60 B2B) y desplaza el umbral.
7. **`discounted_price` caducada que parece vigente** (`33776SGI`, 01→02/01/2026): hay que mirar
   `end_at` (y `start_at` si se quieren descartar las programadas).
8. **Precio exactamente 35,00 €** (18 FBM; en el UUID, `10057VC`). La regla es `< 35`: se quedan.
9. **Borde 34,90–34,99 €** (13 candidatos; 93 entre 34 y 34,99 €): cualquier ajuste de precio cruza el
   umbral; la corrección no es de una sola pasada, hay que re-verificar.
10. **Listings sin precio (691 en el UUID)**: no evaluables, se omiten.
11. **`reactivate` deshace la corrección**: `create_listings_eu.py:285` y `listings:reactivate` recrean en
    `legacy-template-id`, que es lo correcto, pero un listing que se recree quedará fuera del estado que
    se verificó: hay que volver a pasar el verificador.
12. **Precios absurdos** (`5832VC` 4.459,80 €, `34367SGI` 2.065,20 €): no son candidatos, pero un parser
    que redondee mal los puede colar.

---

## 5. Rechazos previstos de Amazon

Evidencia disponible: **5.698 SKU** ya parcheados con `legacy-template-id` sin un solo error
(`dci_reasignar_done.json` 2.538 `ok`, `sgi_reasignar_done.json` 3.160 `ok`), repartidos en **172 product
types**, incluidos `PRODUCT` (31), `GIFT_WRAP` (86), `SOCKS`, `BRACELET`, `SCULPTURE`, `FIGURINE`… Es
decir, el valor `legacy-template-id` está aceptado de forma general.

Por eso la previsión es **≈0 rechazos** en los 4.865 candidatos. Lo que sí puede fallar:

| Colectivo | SKU / cuántos | Qué hará Amazon | Cómo tratarlo |
|---|---|---|---|
| SKU generados por Amazon | **17** en el informe, **0** en los candidatos (todos FBA). Ej.: `amzn.gr.22212969CLM-a8sb3HiyzSNGIR5xH-VG` | **404** en Listings API (comprobado) | filtrar por `fulfillment-channel`; si aparece, 404 = omitir |
| Borrados entre el informe y el PATCH | 0 en la muestra de 150 | 404 | 404 = omitir, no error fatal |
| `*FBA` que en realidad son FBM | **6** candidatos: `5106VCFBA`, `2182985CLMFBA`, `288450CLMFBA`, `29853SGFBA`, `305445CLMFBA`, `5074SGFBA` | los 6 son **híbridos** (`AMAZON_EU` + `DEFAULT`) y los 6 están en el UUID: el PATCH aplica a su oferta FBM | decidir por canal en vivo: FBM si **alguna** entrada de `fulfillment_availability` es `DEFAULT` (nunca por el sufijo ni por `[0]`) |
| Sin `productType` en `summaries` | 0 en la muestra | `InvalidInput` si el PATCH va sin `productType` | leerlo del GET; si falta, omitir |
| Product types raros | 50 tipos distintos en la muestra (`HOME`, `CHARM`, `GIFT_WRAP`, `PRODUCT`, `LOOSE_CUT_GEM`…) | aceptados: los 5.698 parches previos cubren 172 tipos, `PRODUCT` incluido | si hay dudas, validar ese SKU con `mode=VALIDATION_PREVIEW` antes del lote |
| Listings `Incomplete` (en el UUID sin precio) | 691, ninguno < 35 € | suelen devolver `WARNING`, no `ERROR` | no incluirlos en la corrección |
| `blocked_skus.txt` | `12962VCT`, `3924VC0`, `24350SG`… — **0** candidatos | — | excluidos por diseño |

Ninguno de los 4.865 candidatos tiene espacios ni símbolos en el SKU, ni le falta ASIN, ni está en
`blocked_skus.txt`. Para los 4 tipos de producto menos frecuentes conviene una validación previa con
`mode=VALIDATION_PREVIEW` (no publica) antes del lote completo.

---

## 6. Verificador (solo lectura)

`backend/scripts/verify-de-shipping-group.ts`. Pide el informe maestro de DE en vivo (o usa
`VERIFY_DE_REPORT_TSV`), **relee cada listing en vivo** y marca violación cuando un FBM tiene precio
efectivo < 35 € y `merchant_shipping_group` = el UUID de envío gratis. El atributo ausente y
`legacy-template-id` cuentan como correctos (ambos cobran 3,99 €). Sale con **código 1** si hay alguna.

Destino por defecto: **`legacy-template-id`** (`VERIFY_TARGET_GROUP`). Qué comprueba por defecto: todos los
FBM que el informe pone en la plantilla equivocada y están a menos de `VERIFY_NEAR` = 12 € por encima del
umbral (hoy: **5.909** listings del UUID por debajo de 47 €, que incluye los 4.865 candidatos y los 1.044
de la banda 35–47 €) **+ 100 de muestra aleatoria** del resto.

```bash
cd backend

# Verificación posterior a la aplicación (la que hay que usar)
npm run verify:de-shipping-group

# Más rápida, contra el informe guardado
VERIFY_DE_REPORT_TSV=../de_all_listing_report_fresh.tsv VERIFY_SAMPLE=100 npm run verify:de-shipping-group

# Exhaustiva (todos los FBM del informe). En la práctica Amazon da ~0,6 lecturas/s: son ~15 h
VERIFY_SAMPLE=0 npm run verify:de-shipping-group
```

El ritmo real medido es **~0,6 lecturas/s** (no los 5/s teóricos del límite de Amazon), así que la pasada
por defecto (5.909 + 100) tarda varias horas. Para una comprobación rápida y representativa:
`VERIFY_NEAR_CAP=400 VERIFY_SAMPLE=100` (~500 listings, ~15 min).

| Variable | Para qué | Por defecto |
|---|---|---|
| `VERIFY_SAMPLE=n` (`--sample=n`) | muestra aleatoria del resto de FBM (0 = todos) | 100 |
| `VERIFY_NEAR=n` (`--near=n`) | margen por encima del umbral que se comprueba entero | 12 € |
| `VERIFY_NEAR_CAP=n` (`--near-cap=n`) | tope (muestra aleatoria) del bloque anterior; 0 = sin tope | 0 |
| `VERIFY_PRICE_LIMIT` | umbral | 35 € |
| `VERIFY_TARGET_GROUP` | plantilla que debe llevar lo barato | `legacy-template-id` |
| `VERIFY_DE_REPORT_TSV` | usa un TSV en vez de pedir el informe | pide el informe |
| `VERIFY_CSV` | detalle por listing | `../de_shipping_group_verify.csv` |
| `VERIFY_CONCURRENCY` | lecturas en paralelo (límite de Amazon: 5/s) | 4 |
| `VERIFY_IGNORE_ERRORS=1` | no falla por listings ilegibles | no |

### 6.1 Línea base antes de aplicar (2026-11-04, informe fresco, muestra)

```
Informe DE: 32684 filas | FBM: 32005 | FBA: 679 | umbral 35 € | objetivo legacy-template-id
A comprobar: 500 (400 (muestra de 5909) en la plantilla equivocada y <47 € + 100 de muestra de 31605)
Comprobados: 500 | violaciones: 340 | sin precio: 7 | ilegibles: 0
Plantillas en vivo (FBM): {"395e11ea-…":425,"ausente (3,99 €)":55,"legacy-template-id":19}
El informe dice "GRUPO 4" y el vivo NO es la plantilla gratis: 0 de 425
❌ 340 FBM con precio efectivo < 35 € en la plantilla de envío gratis.   (exit 1)
```

Lectura:

- **340 violaciones de 400 muestreados** en el bloque de 5.909 (85 %). El 15 % restante son los 79
  listings del UUID con precio ≥ 35 € (tramos 35–47), que no violan.
- Las 340 están **todas** en el UUID y **todas** con el informe diciendo "GRUPO 4": el informe fresco no
  tiene ni una etiqueta mala (`0 de 425`). Extrapolado, la línea base real es **≈4.865 violaciones**, es
  decir los 4.865 candidatos y nada más.
- Reparto: 6 por debajo de 10 €, 144 entre 10 y 20, 143 entre 20 y 30, 47 entre 30 y 35.
- Las 55 filas con el atributo ausente y las 19 con `legacy-template-id` se cuentan como **correctas**
  (cobran 3,99 €): si el verificador las marcara, daría miles de falsos positivos.

Resultado completo en `de_shipping_group_verify_baseline_2026-11-04.log` y
`de_shipping_group_verify_baseline_2026-11-04.csv` (raíz del repo, ambos gitignored). Para repetirla con
el bloque completo (sin tope) hay que quitar `VERIFY_NEAR_CAP`; a las ~0,6 lecturas/s que da Amazon en la
práctica son varias horas.

---

## 7. Evidencia reproducible

```bash
# Qué cobra cada plantilla (Product Pricing API)
GET /products/pricing/v0/listings/10007VC/offers?MarketplaceId=A1PA6795UKMFR9&ItemCondition=New
#   → ListingPrice 15.95 · Shipping 0.00     (10007VC está en el UUID)
GET /products/pricing/v0/listings/22211966CLM/offers?MarketplaceId=A1PA6795UKMFR9&ItemCondition=New
#   → ListingPrice 31.50 · Shipping 3.99     (22211966CLM está en GRUPO 0)

# Plantilla en vivo de un SKU
GET /listings/2021-08-01/items/A3RY0L9OY3TPHI/10007VC?marketplaceIds=A1PA6795UKMFR9&includedData=attributes
#   → merchant_shipping_group [{"value":"395e11ea-…","marketplace_id":"A1PA6795UKMFR9"}]
```

- `de_all_listing_report_fresh.tsv` — 32.684 filas, mtime 2026-11-04 22:11.
- `dci_reasignar_done.json` / `sgi_reasignar_done.json` — 5.698 parches a `legacy-template-id` sin errores
  (25/10 21:42 y 26/10 09:43).
- `logs/envio_399_monitor.csv` — pedidos `*DCI`/`*SGI` con `ShippingPrice` 3,99 € / 0 €.
