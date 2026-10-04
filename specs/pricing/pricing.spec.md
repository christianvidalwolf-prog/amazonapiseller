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
- **Fallo de API:** Si la llamada a `getPricing` o `getItemOffers` falla, el sistema mantiene el precio actual y registra la anomalía sin modificar la oferta en Seller Central.

## 4. Endpoints y Operaciones
- `GET /api/pricing/offers`: Ofertas actuales por SKU/ASIN, estado de la Buy Box y competidores directos.
- `PUT /api/pricing/rules`: Configuración de márgenes suelo/techo por SKU.
- `POST /api/pricing/update`: Envío de nuevo precio a Amazon mediante Listings Items API / Feeds API con validación estricta de esquema.
