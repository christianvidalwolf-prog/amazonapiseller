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

## 6. Almacenamiento, Cuotas y Resiliencia

### 6.1 Almacén de métricas (descarga única)
- Amazon solo publica este informe por **semana** y por **mes**; no hay dato diario. Una semana o un mes cerrados no cambian.
- Las filas crudas del informe se guardan una sola vez por **marketplace + periodo + inicio de periodo**:
  - Con `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`: tabla `snapshots` de Supabase, clave `sqp:metrics:<marketplaceId>:<WEEK|MONTH>:<YYYY-MM-DD>`. Es el almacén que alcanzan el workflow nocturno, un backend local y uno alojado.
  - Sin Supabase: tabla PostgreSQL `search_query_metrics` (Prisma).
  - Si el almacén no responde, se sirve lo sincronizado en memoria por el proceso.
- Cada sincronización pide a Amazon **solo los lotes de ASIN que no tienen nada guardado** para un periodo. En régimen normal: la semana nueva una vez por semana y el mes nuevo una vez al mes, por país.
- `LAST_3_MONTHS` y `LAST_12_MONTHS` no son periodos de Amazon: suman los meses guardados (`mergePeriods`) sin pedir nada extra.
- Refrescar un único ASIN (`asin` en el `POST /sync`) sí vuelve a pedir sus datos.

### 6.2 Periodo recién cerrado sin publicar
- Si Amazon aún no tiene el periodo que acaba de cerrar, la ventana empieza un periodo antes.
- Se anota en `sqp:unavailable:<marketplaceId>:<periodo>:<inicio>` y no se vuelve a preguntar hasta pasadas 20 h.

### 6.3 Presupuesto de informes
- Cada proceso puede pedir `SQP_MAX_REPORTS` informes seguidos (12 por defecto) y recupera uno por minuto, igual que la cuota `createReport` de Amazon.
- Agotado el presupuesto, la sincronización termina con lo conseguido y el aviso "presupuesto de informes agotado"; lo que falta se pide en la siguiente (así se completa en varias noches el histórico de un país nuevo).
- Si Amazon responde `429`, el servicio espera 90 s y reintenta una vez.

### 6.4 Lectura en producción
- Next.js consulta el backend si existe y tiene filas; si no, sirve el snapshot publicado en Supabase.

---

## 7. Marketplaces
- Países soportados: `ES` (por defecto), `DE`, `FR`, `IT`. `SQP_MARKETPLACES` define cuáles publica el workflow.
- Los ASIN de cada país son `SQP_ASINS` o, si está vacío, los más vendidos de la marca en ese canal de venta (`sales-channel` de `ventas_2026.csv`); si el país aún no tiene ventas, los más vendidos en conjunto.
- Snapshots de panel: `brand-analytics:search-funnel:<PERIODO>` para el país por defecto y `brand-analytics:search-funnel:<PAÍS>:<PERIODO>` para el resto.

---

## 8. Vistas del Panel (`/dashboard/search-funnel`)
1. **Por término:** una fila por término de búsqueda y ASIN (`rows`).
2. **Por ASIN:** una fila por ASIN con todos sus términos sumados (`asinRows`, generadas por `aggregateByAsin`).
   - Se clasifican con las mismas reglas de la sección 4; existe porque un término suelto rara vez alcanza la muestra mínima.
   - `terms` indica cuántos términos se han sumado y `queryText` es el término con más impresiones del ASIN.
   - El "mercado" es el de los términos en los que aparece el ASIN; los precios medianos son los de su término principal.
   - Los snapshots publicados antes de existir esta vista no traen `asinRows`; el panel lo indica hasta la siguiente sincronización.
3. **Tabla tipo hoja de cálculo:** cada cabecera ordena (las columnas de métrica, por recuento o por ratio) y la fila inferior filtra por término, ASIN, mínimos de volumen/impresiones/clics/cestas/compras y estado. Orden y filtros se aplican sobre todos los términos del periodo (`frontend/lib/searchFunnelTable.ts`).
4. **Límite de filas:** `rows` se limita a los 5.000 términos de mayor impacto; `summary` se calcula antes del recorte.

