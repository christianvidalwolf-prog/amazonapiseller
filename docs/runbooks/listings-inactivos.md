# Runbook: listings FBA inactivos con stock

Qué hacer cuando un listing tiene unidades en almacenes de Amazon pero no se vende (estado sin `BUYABLE`).
Lo detecta cada día el vigilante FBA (`.github/workflows/watch-inactive-fba.yml`, email a las 7:00) y el informe
queda en Supabase `alerts:fba-inactive:last-run`.

**Este documento se amplía con cada caso nuevo** (ver "Autoaprendizaje" al final). Antes de arreglar nada, busca aquí
el código de error; si no está, diagnostica, arregla y añade la entrada.

## 1. Diagnóstico

```bash
cd backend
npm run listing:status -- <SKU>            # estado, ofertas (normal/B2B/mínimo) y errores en ES/DE/FR/IT
```

Con el informe del vigilante agrupado por código ya se ve qué parte es automatizable. Ejemplo real (2026-10-22, 115 filas):
65 eran `amzn.gr.*`, 13 SKU sin oferta en algún país, 18 problemas de precio, 8 sin precio normal y el resto cumplimiento.

## 2. Tabla de errores → causa → arreglo

| Código / síntoma | Causa | Arreglo | ¿Auto? |
|---|---|---|---|
| **18155** "precio por debajo del umbral mínimo" con mínimo propio | `minimum_seller_allowed_price` por encima del precio B2B (la sincronización B2B puso B2B = 0,95 × precio y el mínimo estaba al ~97 %) | Mínimo = mitad del B2B (`priceBoundsFix` con `business`) | Sí: `enforce:price-bounds` (workflow nocturno) |
| **18155** sin mínimo propio | Umbral interno de Amazon que la API no muestra | Poner mínimo explícito = mitad del precio más bajo (normal, oferta o B2B). Probado en 347VCFBA: quita la supresión | Sí: `suppressedBelowMinFix` en `enforce:price-bounds` |
| **18155 / 18639** en oferta **solo B2B** (sin precio normal) | Falta la oferta `audience: ALL` o su `our_price` | Precio normal con la regla de país (abajo) + mínimo explícito | Plantilla `scripts/ops/fix-inactive.ts` (lista `SET_PRICE`) |
| **18639** "posible error de precio a la baja" | Precio muy por debajo de la referencia de Amazon | Revisar el precio; casi siempre va con el caso anterior y se va al poner el precio normal | Manual/plantilla |
| **"El SKU no existe en este marketplace"** (SKU normal) | Stock Pan-EU pero sin oferta en ese país | Crear oferta `LISTING_OFFER_ONLY` sobre el mismo ASIN (como `replicate:fba`) | Plantilla (lista `CREATE`) |
| SKU **"sin estado"** (registro vacío: solo `fulfillment_availability` y oferta sin precio, sin ASIN ni condición) | Registro a medias (visto con `AMAZON_EU_RAFN`) | Rehacer la oferta con PUT `LISTING_OFFER_ONLY` (`replaceShell`) | Plantilla |
| **DISCOVERABLE sin errores** | Casi siempre oferta sin precio (`our_price` vacío) en ese país | Igual que "solo B2B" | Plantilla |
| **13013 + 90220 item_name** "el producto no está en el catálogo" | El ASIN no tiene ficha en ese país | Ficha completa (`requirements: LISTING`) con contenido traducido | Plantilla `scripts/ops/fix-full-listing.ts` |
| **99022 / 90244** unidad (`unit_count.type`) | Valor fuera de la lista del país | Usar el enum exacto del Product Type Definition (DE: `stück` en minúscula; FR `unité`, IT `unità`) | — |
| **90220** `supplier_declared_dg_hz_regulation` / `batteries_required` al crear oferta | ES tampoco lo tiene | `not_applicable` / `false` en minerales, joyería, decoración | Plantilla (por defecto) |
| **90220** `is_expiration_dated_product`, `country_of_origin`, `list_price`, `recommended_browse_nodes` en ficha nueva | Obligatorios en `LISTING` | `false`, origen real, `list_price` = precio, nodo de un producto hermano ya vendido en ese país (`catalogItems` → `classifications`) | Plantilla |
| **100521** "estamos revisando este anuncio" | Revisión de Amazon tras crear ficha/oferta | Esperar hasta 48 h; no reenviar | — |
| **100390** documentación (p. ej. `ps_jewelry_*`) | Cumplimiento de categoría | Subir documentos en Seller Central | No |
| **100632** RAP/EPR (DE) | Falta número de registro del productor | Seller Central → Cumplimiento | No |
| **18967** seguridad del producto · **18146** marca · **18644** imagen sin fondo blanco | Cumplimiento/contenido | Seller Central (imagen: subir MAIN con fondo blanco puro) | No |
| **100720** idioma no válido en palabras clave (DE/FR/IT) | `generic_keyword` / platinum en español | Reescribir keywords en el idioma del país | Pendiente de automatizar |
| **`amzn.gr.*`** "no existe" / 13013 / 101078 | Grade and Resell: Amazon crea estos SKU de devoluciones solo donde quiere | No se crean ni se arreglan; el vigilante ya ignora los "no existe" | — |
| Run sin acceso a **SE** (`Unauthorized`) | La app SP-API no tiene autorizado Suecia | Autorizar el marketplace en Seller Central | No |

## 3. Reglas de negocio aplicadas

- **Precio por país** (decisión del usuario 2026-10-21): DE = ES, FR = IT = ES + 2 € (o el de `fixed_prices.csv`). Si ES no tiene precio, se deduce al revés desde otro país (FR − 2).
- **Mínimo**: mitad del precio más bajo (normal, oferta vigente o B2B). Nunca por encima del B2B.
- **No tocar** ofertas que ya tienen precio normal salvo para el mínimo; los precios manuales del panel (`rules:manual-price:*`) mandan.
- **Contenido traducido**: sin promesas de salud ("curación", "sanación", "medicina alternativa") — Amazon suprime por *health claims*. Revisar que no quede texto del generador de IA ("Aquí tienes una descripción optimizada…": estaba en la ficha ES de 1981VCRGFBA).
- **Escrituras en Amazon**: siempre simulación primero (`VALIDATION_PREVIEW` o sin `APPLY`), después `APPLY=1`. `VALIDATION_PREVIEW` no detecta todo (p. ej. 90244 de `unit_count` salió solo al enviar).

## 4. Herramientas

| Herramienta | Uso |
|---|---|
| `npm run listing:status -- <SKU>` | Diagnóstico por país |
| `npm run enforce:price-bounds` | Regla de mínimos (B2B + suprimidos 18155). Workflow nocturno con `PRICE_BOUNDS_APPLY=1` |
| `npm run watch:inactive-fba` | Vigilante (solo lectura); en GitHub envía el email |
| `scripts/ops/fix-inactive.ts` | Plantilla: precio normal, crear ofertas, mínimos. Editar las listas del caso y ejecutar |
| `scripts/ops/fix-full-listing.ts` + `scripts/ops/data/<SKU>-content.json` | Plantilla: ficha completa traducida en países sin página |

## 5. Autoaprendizaje — registro de casos

Al cerrar un caso nuevo, el agente **debe** añadir una fila aquí y, si aparece un código nuevo, una fila en la tabla 2
(y automatizarlo en `enforce:price-bounds` / plantillas si se repite). Formato: fecha · SKU/país · síntoma · causa · arreglo · resultado.

| Fecha | SKU / país | Síntoma | Causa | Arreglo | Resultado |
|---|---|---|---|---|---|
| 2026-10-21 | 58 SKU, ES/DE/FR/IT | 18155 "precio empresas < mínimo" | B2B 0,95 × precio < mínimo ~97 % | Mínimo = mitad B2B (79 + 186 ofertas) | Inactivos con stock 251 → 115 al día siguiente |
| 2026-10-21 | 347VCFBA ES | 18155 sin mínimo visible | Umbral interno de Amazon | Mínimo explícito 4,75 | Error desaparecido en minutos |
| 2026-10-21 | 43047SGRG, 2836613CLM, 15838VCI, 2847562CLM | Solo B2B en DE/FR/IT | Sin oferta normal | Precio con regla de país | 10 ACCEPTED |
| 2026-10-22 | 1981VCRGFBA DE/FR/IT | 13013 + 90220 item_name | ASIN sin ficha fuera de ES | Ficha completa traducida (`fix-full-listing`) | FR/IT ACCEPTED; DE rechazado por `Stück`, reenviado con `stück`: ficha creada en los 3, DE en revisión (100521) |
| 2026-10-22 | 2776439CLMFBA ES | "Sin estado" | Registro vacío sin ASIN/condición | PUT oferta completa (`replaceShell`) | Pendiente de aplicar |
| 2026-10-22 | 65 filas `amzn.gr.*` | No existe / 13013 / 101078 | Grade and Resell | Excluidos del vigilante | — |
