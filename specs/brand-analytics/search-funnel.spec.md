# Especificación SDD: Funnels de Búsqueda (Search Funnel)
**Módulo:** Brand Analytics · Search Query Performance (SQP)  
**Versión de Especificación:** 1.0.0  
**Estado:** Aprobado / Implementado  

---

## 1. Propósito y Alcance del Módulo

El objetivo de **Funnels de Búsqueda** es auditar el rendimiento orgánico y de búsqueda de los productos de la marca analizando el Search Query Performance Report (SQP) de Amazon SP-API.
Permite diagnosticar con exactitud en qué fase del embudo (*funnel*) se pierden las conversiones:
1. **Fuga en SERP (`DROP_IMPRESSIONS_TO_CLICKS`)**: El producto aparece en búsquedas pero no atrae clics (problema de imagen principal, título, precio visible o reviews).
2. **Fuga en Ficha (`DROP_CLICKS_TO_CART`)**: El usuario entra a la ficha pero no añade a la cesta (problema de imágenes secundarias, bullets, A+, precio o stock).
3. **Fuga en Cierre (`DROP_CART_TO_PURCHASE`)**: El usuario añade a la cesta pero no compra (coste de envío, tiempos de entrega o abandono en checkout).
4. **Ganadores (`WINNER`)**: Términos donde el producto domina en cuota de compras y ratio de conversión, ideales para blindar en PPC.
5. **Poco Volumen (`LOW_VOLUME`)**: Términos con impresiones o clics insuficientes para determinar una tendencia estadística.

---

## 2. Origen de Datos e Integración Amazon SP-API

### 2.1 Report Type
- **Reporte:** `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`
- **Requisitos de Amazon:**
  - Rol de desarrollador SP-API: `Brand Analytics`.
  - La marca debe pertenecer a **Amazon Brand Registry** vinculada a la cuenta de vendedor (`sellerId`).
  - Límite de lote ASIN: Máximo 200 caracteres por batch separados por espacio.

### 2.2 Periodicidades Soportadas (`FunnelPeriod`)
1. `WEEK`: Última semana completa publicada (Domingo a Sábado).
2. `MONTH`: Último mes calendario completo cerrado.
3. `LAST_3_MONTHS`: Agregación consolidada de los últimos 3 meses cerrados.
4. `LAST_12_MONTHS`: Agregación consolidada de los últimos 12 meses cerrados.

---

## 3. Contratos de Datos y Esquemas

### 3.1 Entidad `SearchQueryMetrics`
| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `queryText` | `string` | Término de búsqueda buscado por el comprador. |
| `asin` | `string` | ASIN del producto auditado. |
| `periodStart` | `YYYY-MM-DD` | Fecha de inicio del periodo. |
| `periodEnd` | `YYYY-MM-DD` | Fecha de fin del periodo. |
| `totalQueryVolume` | `number` | Volumen total de búsquedas del término en Amazon. |
| `totalImpressions` | `number` | Impresiones totales de todos los competidores para el término. |
| `totalClicks` | `number` | Clics totales del mercado. |
| `totalCartAdds` | `number` | Añadidos a la cesta totales del mercado. |
| `totalPurchases` | `number` | Compras totales del mercado. |
| `asinImpressions` | `number` | Impresiones de nuestro ASIN. |
| `asinImpressionShare` | `number` | % cuota de impresiones (0 a 1). |
| `asinClicks` | `number` | Clics recibidos por nuestro ASIN. |
| `asinClickShare` | `number` | % cuota de clics (0 a 1). |
| `asinCartAdds` | `number` | Cestas de nuestro ASIN. |
| `asinCartAddShare` | `number` | % cuota de cestas (0 a 1). |
| `asinPurchases` | `number` | Compras de nuestro ASIN. |
| `asinPurchaseShare` | `number` | % cuota de compras (0 a 1). |

---

## 4. Reglas de Clasificación del Funnel (`FUNNEL_THRESHOLDS`)

| Estado | Condición Algorítmica |
| :--- | :--- |
| `DROP_IMPRESSIONS_TO_CLICKS` | `asinImpressions >= 500` Y `asinClickShare < asinImpressionShare * 0.5` |
| `DROP_CLICKS_TO_CART` | `asinClicks >= 30` Y `cartRate < 0.035` (3.5%) |
| `DROP_CART_TO_PURCHASE` | `asinCartAdds >= 10` Y `purchaseRate < 0.20` (20%) |
| `WINNER` | `asinPurchases >= 5` Y `asinPurchaseShare >= 0.20` Y `purchaseRate >= 0.40` |
| `NORMAL` | Si no cumple fuga ni ganador, pero tiene muestra suficiente (`>= 500` imp, `>= 30` clics o `>= 10` cestas). |
| `LOW_VOLUME` | Muestra por debajo de los umbrales mínimos estadísticos. |

---

## 5. Endpoints de la API (Arquitectura Híbrida)

### 5.1 `GET /api/brand-analytics/search-funnel`
- **Query Params:**
  - `period`: `WEEK` | `MONTH` | `LAST_3_MONTHS` | `LAST_12_MONTHS` (default: `WEEK`)
  - `asin`: (opcional) Filtra por ASIN específico.
  - `status`: (opcional) Filtra por estado de fuga (`FunnelStatus`).
- **Respuesta (200 OK):**
  - Objeto `SearchFunnelResponse`:
    - `summary`: Totales agregados (`totalQueries`, `dropImpressionsToClicks`, etc.).
    - `rows`: Array de `SearchFunnelRow` ordenados por `impactScore`.
    - `asinRows`: Array consolidado por ASIN (`terms`, métricas sumadas).
    - `asins`: Lista de pares `{ asin, name }`.

### 5.2 `POST /api/brand-analytics/search-funnel/sync`
- Dispara la sincronización en segundo plano con Amazon SP-API.
- Evita ejecuciones duplicadas si ya hay una sincronización en marcha (`running`).

### 5.3 `GET /api/brand-analytics/search-funnel/sync`
- Devuelve el estado actual de sincronización (`idle`, `running`, `done`, `failed`), horas de inicio/fin y errores si los hubo.

---

## 6. Manejo de Fallos y Resiliencia
1. **Fallback Dual:**
   - La API consulta primero la base de datos PostgreSQL/Prisma (`search_query_metrics`).
   - Si la DB está vacía o inalcanzable, responde con la última sincronización en memoria del proceso backend.
   - En entornos serverless sin backend activo, Next.js lee el snapshot publicado en Supabase.
2. **Reintento por Cuotas (Throttling):**
   - Si Amazon devuelve error de cuota `429 / Throttled` al solicitar el reporte, el servicio espera `90s` antes de reintentar.
