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

- `GET /api/pricing/offers`: Ofertas actuales por SKU/ASIN, estado de la Buy Box y competidores directos.
- `PUT /api/pricing/rules`: Configuración de márgenes suelo/techo por SKU.
- `POST /api/pricing/update`: Envío de nuevo precio a Amazon mediante Listings Items API / Feeds API con validación estricta de esquema.

### Precio para el margen unitario (`getUnitMargin`, snapshot `margins:products`)
`getPricing` (Product Pricing v0) a menudo responde sin `Offers`. En ese caso el precio es el de la oferta al consumidor del listing (Listings Items API, `purchasable_offer` con `audience` ALL): precio de oferta activo si lo hay, si no `our_price`. Ese precio incluye IVA; el campo `margin` del snapshot **no** descuenta IVA (el puente de rentabilidad de Ads sí lo hace, ver `specs/advertising` §6).
