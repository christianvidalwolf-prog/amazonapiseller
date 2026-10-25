# Especificación SDD: Pricing (Repricing y Buy Box)
**Módulo:** `pricing`  
**Versión:** 1.0.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Monitorización de ofertas competitivas y Buy Box en tiempo real a través de SP-API Product Pricing API, con ejecución de reglas de repricing dinámico que protegen el margen neto.

## 2. Reglas Contractuales de Negocio
1. **Regla de Oro (Floor Price):** `newPrice >= minPrice` (precio suelo). Bajo ninguna circunstancia la API o el algoritmo permitirá enviar a Amazon un precio inferior al margen mínimo calculado (Coste Producto + Fees FBA + Envío + IVA + Margen mínimo de seguridad).
2. **Techo de Precio (Ceiling Price):** `newPrice <= maxPrice` para evitar alertas de precio elevado de Amazon que supriman la Buy Box.
3. **Estrategia Buy Box:**
   - Si el competidor que ostenta la Buy Box es **FBM** y nosotros somos **FBA**: Mantener paridad o hasta un 2%-3% por encima, aprovechando la ventaja logística de Prime.
   - Si el competidor es **FBA**: Igualar precio o situarse 0.01 € por debajo si el margen lo tolera.
   - Si no hay competidores: Subir gradualmente hacia el precio óptimo (`maxPrice`).

## 3. Manejo de Errores y Fail-Safe
- Los pares SKU/país de `fixed_prices.csv` tienen protección permanente, sin caducidad: el feed diario de STOCK AMZ omite `purchasable_offer` para ellos y continúa actualizando stock. El paso de precios fijos aplica el importe configurado. No se depende del orden de procesamiento asíncrono del feed.
- `2684319CLM`: ES 19,99 EUR; DE 24,99 EUR; FR 25,99 EUR; IT 26,99 EUR, hasta nueva instrucción explícita.
- **Oferta FBA sin precio normal (DE/FR/IT):** si la oferta `audience: ALL` no tiene `our_price` (solo B2B), la regla nocturna `enforce:price-bounds` le pone el de `fixed_prices.csv` o el de ES con la regla de país (DE = ES, FR = IT = ES + 2 €), conservando la oferta B2B (`missingFbaPrice`, `backend/src/lib/priceBounds.ts`).
- **Cambiar el precio no borra el resto de la oferta:** `purchasable_offer` es un atributo completo, así que todo `replace` que solo cambia el precio usa `offerWithNewPrice` (`backend/src/lib/priceBounds.ts`, copia en `frontend/lib/priceBounds.ts`): parte de las entradas existentes de ese marketplace, cambia solo el `our_price` de la audiencia `ALL` y conserva el `discounted_price` de las campañas en curso y las entradas B2B. Aplica a la réplica FBA (`replicate:fba`), al PATCH del panel (`updatePriceOrStock` y `frontend/app/api/listings/items/[sku]`) y a cualquier script que ajuste precios; reemplazar el atributo por una única entrada `ALL` anula las ofertas temporales y el precio de empresa.
- **Fallo de API:** Si la llamada a `getPricing` o `getItemOffers` falla, el sistema mantiene el precio actual y registra la anomalía sin modificar la oferta en Seller Central.

## 4. Endpoints y Operaciones

## 5. Criterio de ventas compatible con Sellerboard
- La fuente operativa sigue siendo el informe de pedidos de Amazon SP-API.
- `Sales`/facturación bruta equivale a `item-price` por línea; no incluye `shipping-price`, promociones, impuestos ni gift wrap.
- Las devoluciones se cargan desde el informe de devoluciones y se valoran con el precio unitario del pedido.
- No se mezclan líneas de devolución con ventas ni pedidos cancelados con ventas válidas.
### Sincronización masiva Business
- Autorización: todos los productos y países compatibles de la cuenta; precio B2B = precio normal local × 0,95, redondeo decimal HALF_UP a dos decimales.
- Fuente: informe de listings recién generado por marketplace. No modificar precio ALL, stock ni contenido. Excluir filas sin precio positivo y registrar omisiones.
- Enviar PATCH de `purchasable_offer` con selector B2B mediante JSON_LISTINGS_FEED; conservar descuentos por cantidad existentes. Distinguir aceptación del feed de éxito por mensaje, conservar plan y resultados y verificar muestras en Listings Items.
- Alcance de esta operación: sincronización puntual; no instala un nuevo proceso periódico.
- El precio mínimo (`minimum_seller_allowed_price`) del SKU también se aplica al precio B2B: si el B2B queda por debajo, Amazon suprime la oferta (error 18155, "el precio para empresas es inferior al precio mínimo"). `enforce:price-bounds` baja ese mínimo a la mitad del precio B2B (`priceBoundsFix` con `business`, leído por `readBusinessPrice`). En cada run programado del workflow, además del catálogo FBA de ES, escanea todos los marketplaces EU (Listings Items `searchListingsItems` con `withIssueSeverity=ERROR`) y revisa cualquier SKU con issue 18155 (la búsqueda corta en ~1000 resultados por país, así que los FBA del catálogo se revisan uno a uno con sus issues). Si un suprimido no tiene mínimo propio, se le pone uno explícito a la mitad de su precio más bajo (normal, oferta o B2B): anula el umbral interno de Amazon (probado en 347VCFBA ES). Al reescribir `purchasable_offer` se eliminan las entradas de `discounted_price` caducadas o sin `value_with_tax` (`withoutStaleSales`), porque Amazon rechaza el replace (99022) si arrastra una oferta antigua sin importe. Si el `end_at` de la oferta ya pasó se envía `{ value: null }` (omitirlo no lo borra; una oferta con fin vencido no se vende).

- `GET /api/pricing/offers`: Ofertas actuales por SKU/ASIN, estado de la Buy Box y competidores directos.
- `PUT /api/pricing/rules`: Configuración de márgenes suelo/techo por SKU.
- `POST /api/pricing/update`: Envío de nuevo precio a Amazon mediante Listings Items API / Feeds API con validación estricta de esquema.

### Precio para el margen unitario (`getUnitMargin`, snapshot `margins:products`)
`getPricing` (Product Pricing v0) a menudo responde sin `Offers`. En ese caso el precio es el de la oferta al consumidor del listing (Listings Items API, `purchasable_offer` con `audience` ALL): precio de oferta activo si lo hay, si no `our_price`. Ese precio incluye IVA; el campo `margin` del snapshot **no** descuenta IVA (el puente de rentabilidad de Ads sí lo hace, ver `specs/advertising` §6).
