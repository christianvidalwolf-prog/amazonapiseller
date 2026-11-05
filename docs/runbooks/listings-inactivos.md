# Runbook: listings FBA inactivos con stock

Qué hacer cuando un listing tiene unidades en almacenes de Amazon pero no se vende (estado sin `BUYABLE`).
Cada día a las 7:00 lo resuelve el **equipo de agentes** (`.github/workflows/agents-inactive-listings.yml` →
`backend/scripts/agents/inactive-listings.ts`): escanea, clasifica, corrige por API y verifica en ES/DE/FR/IT.
El informe queda en Supabase `rules:inactive-listings:last-run` (y `alerts:fba-inactive:last-run`).

El vigilante antiguo (`watch-inactive-fba.yml`) solo lee y ya no tiene cron: queda para ejecución manual.

**Este documento se amplía con cada caso nuevo** (ver "Autoaprendizaje" al final). Antes de arreglar nada, busca aquí
el código de error; si no está, diagnostica, arregla y añade la entrada (y al triaje automático).

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
| **Oferta FBA solo B2B en DE/FR/IT, sin error** (o `our_price` vacío; sale DISCOVERABLE o solo BUYABLE para empresas) | Al crearse la oferta Pan-EU solo se rellenó el precio Business | Precio normal = `fixed_prices.csv` o ES con la regla de país; B2B intacta | Sí: `missingFbaPrice` en `enforce:price-bounds` (desde 2026-10-24) |
| **18639** "posible error de precio a la baja" | Precio muy por debajo de la referencia de Amazon | Revisar el precio; casi siempre va con el caso anterior y se va al poner el precio normal | Manual/plantilla |
| **"El SKU no existe" en todos los países** con stock FBA | Amazon borró el ASIN del catálogo (p. ej. tras vencer un plazo de documentos 100390) | Comprobar con Catalog Items API (`NOT_FOUND` en todos); Seller Central: documentos + reactivación, o retirada del stock | No |
| **"El SKU no existe en este marketplace"** (SKU normal) | Stock Pan-EU pero sin oferta en ese país | Crear oferta `LISTING_OFFER_ONLY` sobre el mismo ASIN (como `replicate:fba`) | Plantilla (lista `CREATE`) |
| SKU **"sin estado"** (registro vacío: solo `fulfillment_availability` y oferta sin precio, sin ASIN ni condición) | Registro a medias (visto con `AMAZON_EU_RAFN`) | Rehacer la oferta con PUT `LISTING_OFFER_ONLY` (`replaceShell`) | Plantilla |
| **DISCOVERABLE sin errores** | Oferta sin precio (`our_price` vacío; en FBA de DE/FR/IT lo arregla la regla nocturna) **o con `end_at` de la oferta en el pasado** (2776653CLMFBA FR: fin 2021) **o categoría restringida en ese país** (30052MDFBA FR catalogado `CIGARETTE_CASE`) | Precio: plantilla. `end_at` vencido: `set-price.ts` con el mismo precio (`withoutStaleSales` lo quita). Categoría: Seller Central | Parcial |
| **13013 + 90220 item_name** "el producto no está en el catálogo" | El ASIN no tiene ficha en ese país | Ficha completa (`requirements: LISTING`) con contenido traducido | Plantilla `scripts/ops/fix-full-listing.ts` |
| **99022 / 90244** unidad (`unit_count.type`) | Valor fuera de la lista del país | Usar el enum exacto del Product Type Definition (DE: `stück` en minúscula; FR `unité`, IT `unità`) | — |
| **90220** `supplier_declared_dg_hz_regulation` / `batteries_required` al crear oferta | ES tampoco lo tiene | `not_applicable` / `false` en minerales, joyería, decoración | Plantilla (por defecto) |
| **90220** `is_expiration_dated_product`, `country_of_origin`, `list_price`, `recommended_browse_nodes` en ficha nueva | Obligatorios en `LISTING` | `false`, origen real, `list_price` = precio, nodo de un producto hermano ya vendido en ese país (`catalogItems` → `classifications`) | Plantilla |
| **100521** "estamos revisando este anuncio" | Revisión de Amazon tras crear ficha/oferta | Esperar hasta 48 h; no reenviar | — |
| **99022** `schedule.value_with_tax` / "Angebotspreis" al reescribir la oferta | La oferta arrastra un `discounted_price` antiguo sin importe | `withoutStaleSales` (lo aplican la regla nocturna y las plantillas) | Sí |
| **100390** documentación (p. ej. `ps_jewelry_*`) | Cumplimiento de categoría | Subir documentos en Seller Central | No |
| **100632** GPSR ("regulación general de seguridad del producto") | Faltan `gpsr_manufacturer_reference` y `gpsr_safety_attestation` (típico en ofertas recién creadas en DE/FR/IT) | `scripts/ops/set-gpsr.ts <SKU> DE FR IT`: email del fabricante de la cuenta (`vidalregals@gmail.com`, el que llevan 318 listings DE) + certificación `true` | Sí (script) |
| **100632** RAP/EPR (DE, "información de una RER") | Falta número de registro del productor | Seller Central → Cumplimiento | No |
| **19084** "sujeta a otras restricciones" · **19098** GTIN no coincide con la marca | Restricción de categoría / GTIN de otra marca | Seller Central (solicitud de aprobación o exención GTIN / caso a soporte) | No |
| **18570** "necesitas autorización para publicar productos de esta marca" (visto en IT, 2776698CLMFBA) | Brand gating: la marca exige autorización en ese marketplace | Seller Central → Marcas → Solicitar autorización. No se arregla por API | No |
| **18146** "uso indebido de marcas comerciales" | Amazon no dice qué elemento. Revisar **texto e imágenes** (descargarlas y mirarlas): logotipos de otra marca en caja/etiquetas, fotos de tienda con etiquetas de proveedor, objetos con diseño registrado (p. ej. nevera estilo SMEG, marca italiana → solo saltó en IT) | Texto: reescribir sin la marca. Imágenes secundarias: `scripts/ops/remove-images.ts <SKU> ES,DE,FR,IT <huecos>` (en todos los países, los huecos coinciden). Imagen principal con logo: sustituirla con `set-images.ts` (foto limpia, fondo blanco, en `listing-images` de Supabase). Después, si sigue, recurrir en Seller Central | Parcial |
| **18967** seguridad del producto · **18644** imagen sin fondo blanco | Cumplimiento/contenido | Seller Central (imagen: subir MAIN con fondo blanco puro) | No |
| **100720** idioma no válido en palabras clave (DE/FR/IT) | `generic_keyword` / platinum en español | Reescribir keywords en el idioma del país | Pendiente de automatizar |
| **`amzn.gr.*`** "no existe" / 13013 / 101078 | Grade and Resell: Amazon crea estos SKU de devoluciones solo donde quiere | No se crean ni se arreglan; el vigilante ya ignora los "no existe" | — |
| Run sin acceso a **SE** (`Unauthorized`) | La app SP-API no tiene autorizado Suecia | Autorizar el marketplace en Seller Central | No |

## 3. Reglas de negocio aplicadas

- **Precio por país** (decisión del usuario 2026-10-21): DE = ES, FR = IT = ES + 2 € (o el de `fixed_prices.csv`). Si ES no tiene precio, se deduce al revés desde otro país (FR − 2).
- **Mínimo**: mitad del precio más bajo (normal, oferta vigente o B2B). Nunca por encima del B2B.
- **No tocar** ofertas que ya tienen precio normal salvo para el mínimo; los precios manuales del panel (`rules:manual-price:*`) mandan.
- **Contenido traducido**: sin promesas de salud ("curación", "sanación", "medicina alternativa") — Amazon suprime por *health claims*. Revisar que no quede texto del generador de IA ("Aquí tienes una descripción optimizada…": estaba en la ficha ES de 1981VCRGFBA).
- **`ACCEPTED` no significa aplicado**: comprobar después con `listing:status`/`lastUpdatedDate`. Visto el 2026-10-23: (1) un `delete` de atributo con solo `marketplace_id` se acepta y no hace nada, hay que enviar el valor exacto; (2) omitir `end_at` en un `replace` de `purchasable_offer` no lo borra, hay que enviarlo `{ value: null }`; (3) imágenes con URL externa tardan en aparecer (Amazon las descarga y procesa).
- **Escrituras en Amazon**: siempre simulación primero (`VALIDATION_PREVIEW` o sin `APPLY`), después `APPLY=1`. `VALIDATION_PREVIEW` no detecta todo (p. ej. 90244 de `unit_count` salió solo al enviar). **Excepción**: el equipo diario escribe solo (decisión del usuario 2026-11-05) dentro de sus topes — 60 arreglos/día, 2 intentos por caso, preview obligatorio antes de crear ofertas/GPSR y una sola escritura por SKU+país y ejecución.

## 4. Herramientas

| Herramienta | Uso |
|---|---|
| `npm run agents:inactive` | **Equipo completo en simulación**: escanea los 4 países, clasifica y dice qué haría. No escribe |
| `npm run agents:inactive:apply` | Igual, aplicando los arreglos con topes (60/día, 2 intentos por caso) |
| `INACTIVE_AGENTS_SKUS=A,B npm run agents:inactive` | Limitar el ciclo a esos SKU |
| `INACTIVE_AGENTS_PREVIEW_ONLY=1 INACTIVE_AGENTS_APPLY=1 npm run agents:inactive` | Ejecutar los correctores pero quedarse en `VALIDATION_PREVIEW` (crear ofertas/GPSR sin enviar) |
| `npm run listing:status -- <SKU>` | Diagnóstico por país |
| `npm run enforce:price-bounds` | Regla de mínimos (B2B + suprimidos 18155). Workflow nocturno con `PRICE_BOUNDS_APPLY=1` |
| `npm run watch:inactive-fba` | Vigilante (solo lectura). Ya sin cron: ejecución manual; el email diario lo manda el equipo de agentes |
| `fba_watch_ignore.txt` (raíz) | Casos sin arreglo por API que no deben salir más en el email: `SKU;PAÍS|*;MOTIVO`. Vuelven a salir si Amazon da otro motivo; quedan en `ignorados` del informe |
| `scripts/ops/fix-inactive.ts` | Plantilla: precio normal, crear ofertas, mínimos. Editar las listas del caso y ejecutar |
| `scripts/ops/fix-full-listing.ts` + `scripts/ops/data/<SKU>-content.json` | Plantilla: ficha completa traducida en países sin página |
| `scripts/ops/set-price.ts <SKU> ES=… DE=…` | Cambio puntual de precio (normal + B2B + límites); ver 4b |
| `scripts/ops/set-gpsr.ts <SKU> DE FR IT` | Datos GPSR (100632 de seguridad del producto) |
| `scripts/ops/remove-images.ts <SKU> <países> <huecos>` | Quitar imágenes secundarias (18146 por fotos con marcas) |
| `scripts/ops/set-images.ts <SKU> <países> <principal> [secundarias…]` | Sustituir imágenes. Alojarlas antes en el bucket público de Supabase `listing-images/<SKU>/` (subida con la service key: `POST /storage/v1/object/listing-images/<SKU>/<fichero>`) |

## 4b. Cambiar el precio de un SKU a mano

1. `npm run listing:status -- <SKU>`: ver si es FBM (sin `FBA`) y si hay un `<SKU>FBA` del mismo ASIN.
2. Precios por país: FBM usa los offsets del feed diario (`sync_daily_stock_amz.py`): DE +5, FR +6, IT +7 sobre ES; FBA usa DE = ES, FR/IT = ES + 2.
3. `npx tsx scripts/ops/set-price.ts <SKU> ES=… DE=… FR=… IT=…` (valida) y después con `APPLY=1`. Pone B2B = 0,95 × precio y corrige límites.
4. **Hacerlo permanente**: añadir las filas a `fixed_prices.csv` (`sku;pais;precio`). Si no, el feed FBM de las 9:00 vuelve al precio del fichero y `enforce-fbm-floor` lo sube a 1,05 × FBA del mismo ASIN (caso 309727CLM: FBA a 19,99 dejaba el FBM en 20,99).

## 4c. Equipo de agentes (ciclo automático)

Workflow `agents-inactive-listings.yml` (7:00 Madrid, lunes a domingo) → `backend/scripts/agents/inactive-listings.ts`.
Cuatro agentes en una pasada, con estado en Supabase (`rules:inactive-listings:state`):

1. **Escáner** — FBA Inventory (`fulfillableQuantity > 0`) + `getListingsItem` (`summaries, issues, attributes`, `es_ES`) por país. Inactivo = estado sin `BUYABLE`; motivo = issues `ERROR`.
2. **Triaje** — `backend/src/lib/inactive-case.ts` (con tests) decide: `bounds`, `fill-price`, `create-offer`, `gpsr`, `wait`, `escalate` o `ignore`. Es la tabla del apartado 2 en código: **si añades un código nuevo a la tabla, añádelo también ahí**.
3. **Corrector** — aplica por API con tope `INACTIVE_AGENTS_MAX_FIXES` (60/día) y valida con `VALIDATION_PREVIEW` antes de crear ofertas o GPSR. Precio: `fixed_prices.csv` → precio del país → regla por país; el B2B no se toca.
4. **Verificador** — relee el estado, cierra los casos que ya no aparecen y deja de reintentar tras `INACTIVE_AGENTS_MAX_ATTEMPTS` (2); esos pasan a la lista de Seller Central del email.

Un caso que el motor no puede arreglar (documentos, brand gating, marca, GTIN, categoría, RAP/EPR) **no se
reintenta**: sale en el email y en `seller_central` del informe. Cuando un arreglo manual se repita 2+ veces,
se automatiza en el triaje o en el corrector, con test.

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
| 2026-10-22 | 1886VCFBS DE | 99022 al poner precio | Promoción 2023-24 guardada sin importe en la oferta | `withoutStaleSales` en `priceBounds` | Pendiente de aplicar |
| 2026-10-22 | 18 SKU · 13 ofertas nuevas · 8 mínimos | Plantilla `fix-inactive` | — | Ya aplicados (re-ejecución: todo "ya tiene precio / ya existe / sin cambio") | OK |
| 2026-10-23 | 309727CLM (FBM) ES/DE/FR/IT | Pedido: vender a 11,95 en ES | Suelo FBM = 1,05 × FBA (19,99) lo tenía a 20,99 | `set-price.ts` ES 11,95 · DE 16,95 · FR 17,95 · IT 18,95 (B2B 0,95×) + `fixed_prices.csv`; FBA 309727CLMFBA bajado igual con regla FBA: ES/DE 11,95 · FR/IT 13,95 | Validado; pendiente de aplicar |
| 2026-10-23 | Email del vigilante: 19 filas (antes 115) | — | — | — | Lo automatizable de ayer resuelto |
| 2026-10-23 | 2857133CLMFBA DE/FR/IT | 100632 GPSR en ofertas creadas el 22 | Sin datos GPSR | `set-gpsr.ts` | Validado; pendiente de aplicar |
| 2026-10-23 | 2776653CLMFBA FR | DISCOVERABLE sin errores | `end_at` de la oferta en 2021 | `set-price.ts 2776653CLMFBA FR=20.95` (quita `end_at`) | Aplicado 2026-10-24: `end_at` borrado (comprobado en la oferta) |
| 2026-10-23 | 30052MDFBA FR | DISCOVERABLE sin errores | Catalogado `CIGARETTE_CASE` en FR (restringido) | Seller Central | Manual |
| 2026-10-23 | 22092SGFBA IT | 18146 marca | Texto limpio; fotos 5-7 hechas en tienda con etiquetas de otro proveedor | `remove-images.ts 22092SGFBA ES,DE,FR,IT 5,6,7` | Aplicado (el 24 ya no estaban); el 18146 seguía en IT el 24 → si persiste el 26, recurrir en Seller Central |
| 2026-10-23 | 17549SGFBA IT | 18146 marca | Texto limpio; foto 5 con nevera de diseño SMEG (marca italiana) | `remove-images.ts 17549SGFBA ES,DE,FR,IT 5` | Aplicado (el 24 ya no estaba); el 18146 seguía en IT el 24 → si persiste el 26, recurrir en Seller Central |
| 2026-10-23 | 2776439CLMFBA IT | 18146 marca | Única imagen (repetida en todos los huecos): caja con logo «dcasa» | Fotos nuevas del usuario (principal fondo blanco, infografía, 2 de ambiente) en Supabase `listing-images`; `set-images.ts` en ES/DE/FR/IT | Validado; pendiente de aplicar |
| 2026-10-24 | 2776653CLMFBA IT · 17549SGFBA IT · 7752VCFBA DE/FR/IT | Oferta solo B2B, sin precio normal (en el email salía por otro motivo o como DISCOVERABLE) | Igual que el 21: oferta Pan-EU sin `our_price` | `set-price.ts`: 20,95 · 18,95 · DE 10,35 / FR-IT 12,35 | ACCEPTED y comprobado; 2.ª repetición → automatizado (`missingFbaPrice`) |
| 2026-10-24 | 2776439CLMFBA ES/DE/FR/IT | 18146 IT, imágenes nuevas pendientes | — | `set-images.ts` necesita las URL de `listing-images/2776439CLMFBA/` (subidas desde el otro Mac; este no tiene credenciales de Supabase) | Pendiente: ejecutar desde el Mac con `SUPABASE_*` |
| 2026-10-24 | 14807VCFBA ES/DE/FR/IT · 28582RGSGFBA DE · 24465SG DE · 1297VCFBA IT · 7752VCFBA DE/FR/IT · 30052MDFBA FR | 100390 joyería · 100632 RAP · 19084 · 19098 GTIN · categoría `CIGARETTE_CASE` | Cumplimiento | Seller Central (ver tabla) | Manual. 14807VCFBA: plazo de documentos vencido el 21 |
| 2026-10-28 | 39195SGRIFBA FR/IT | 18155 sin mínimo propio (precio 48, B2B 45,6) | Umbral interno de Amazon; la regla nocturna aún no lo había cogido | `SKUS=39195SGRIFBA PRICE_BOUNDS_APPLY=1 npm run enforce:price-bounds` → mínimo 22,80 | 18155 desaparecido en minutos |
| 2026-10-28 | 2776653CLMFBA FR | Sigue DISCOVERABLE sin errores tras quitar `end_at` el 24 | Oferta FR idéntica a IT (que sí vende) y 6 uds. disponibles en FR: no es precio ni stock | Reenviada la oferta (`set-price.ts FR=20.95`, ACCEPTED) | Si sigue sin `BUYABLE` en 48 h: caso a soporte en Seller Central FR |
| 2026-10-28 | 14807VCFBA ES/DE/FR/IT | "El SKU no existe" en los 4 países (2 uds. FBA) | Tras vencer el plazo de documentos 100390 (21-10) Amazon borró el ASIN B0GM1JW8SG del catálogo; el FBM 14807VCI quedó apuntando a dos ASIN (101077) | Nada por API: subir documentos de joyería en Seller Central y pedir reactivación, o retirar las 2 uds. | Manual |
| 2026-10-28 | 14807VCFBA * · 1297VCFBA IT · 7752VCFBA DE/FR/IT | Sin arreglo por API (catálogo borrado, 19084, 19098) | — | Añadidos a `fba_watch_ignore.txt` a petición del usuario | Fuera del email |
| 2026-11-05 | IT completo (212 SKU con stock → 10 inactivos) | Primera pasada del equipo de agentes | 6 de cumplimiento, 4 arreglables (3 sin oferta, 1 de precio) | `npm run agents:inactive` (simulación) | Triaje correcto; quedó a la vista que faltaba el código 18570 |
| 2026-11-05 | 2776698CLMFBA IT | Sin BUYABLE; la regla de precio no encontraba nada que cambiar | **18570**: "necesitas autorización para publicar productos de esta marca" (brand gating) en IT | No se toca. Añadido 18570 al triaje y a la tabla 2 | Sale como Seller Central, deja de gastar intentos |
| 2026-11-05 | 5745SGFBA IT · 13439VCFBA IT | SKU con stock FBA sin oferta en IT | Oferta Pan-EU sin crear en ese país | `create-offer` con `VALIDATION_PREVIEW` | Preview válido en ambos; pendiente de la primera ejecución con `APPLY` |
| 2026-11-05 | 14807VCFBA IT | Sin BUYABLE y "sin precio de referencia" al intentar crear la oferta | El ASIN B0GM1JW8SG ya no está en el catálogo (plazo 100390 vencido) | Nada por API; el corrector lo detecta y no escribe | Escala tras 2 intentos (documentos de joyería) |
