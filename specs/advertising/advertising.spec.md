# Especificación SDD: Advertising (Amazon Ads & PPC)
**Módulo:** `advertising`  
**Versión:** 1.2.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Gestión algorítmica y supervisión de campañas publicitarias en Amazon Ads (Sponsored Products, Sponsored Brands y Sponsored Display) con enfoque *Profit-First*. Maximiza ventas orgánicas y de pago manteniendo el ACoS y TACoS dentro de los márgenes rentables.

## 2. Métricas y Fórmulas Contractuales
- **CTR (Click-Through Rate):** `Clicks / Impressions`
- **CPC (Cost Per Click):** `Spend / Clicks`
- **ACoS (Advertising Cost of Sales):** `(Spend / Sales) * 100`
- **ROAS (Return on Ad Spend):** `Sales / Spend`
- **Conversion Rate (CVR):** `Orders / Clicks`
- **TACoS (Total ACoS):** `(Total Ad Spend / Total Organic & Ad Sales) * 100`

## 3. Guardrails de Seguridad (Protección de Presupuesto)
1. **Límite de Incremento de Puja:** Ningún ajuste automático puede aumentar una puja más del **20%** en una sola iteración.
2. **Puja Máxima Absoluta (Max Bid Ceiling):** Por defecto **1.50 €** a menos que se defina un límite específico por SKU/Campaña.
3. **Cosecha de Keywords Negativas:** Términos de búsqueda con más de 15 clics y 0 ventas se clasifican automáticamente como `CANDIDATE_NEGATIVE_EXACT`.
4. **Registro de Auditoría:** Toda mutación de puja o estado de campaña debe persistirse con timestamp, valor anterior, nuevo valor y motivo algorítmico.

## 4. Endpoints y Operaciones
- `GET /api/advertising/summary`: KPIs del último informe de campañas guardado (ventana de 30 días que acaba hace 3 días).
- `GET /api/advertising/campaigns`: Todas las campañas SP con las métricas del mismo informe.
- `GET /api/advertising/profitability`: Puente de rentabilidad por SKU (§6).
- `GET /api/advertising/keywords/harvest`: Sugerencias algorítmicas de palabras clave para negación o escalado.
- `PATCH /api/advertising/bids`: Actualización por lotes de pujas con validación previa de los guardrails.
- Sincronización de informes: script `npm run ads:sync-reports` en el workflow programado (no endpoint HTTP: Amazon tarda minutos en generarlos).

## 5. Calidad del Dato (Proceso 0 — Regla de Oro)
**Cero datos o datos DEMO ⇒ "no concluyente". Nunca es permiso para cambiar nada en Amazon.**

1. **Sin datos simulados:** el backend no genera métricas ni campañas de demostración. Si falta el dato real, la respuesta lo dice.
2. **Contrato de estado:** `GET /api/advertising/summary` y `GET /api/advertising/campaigns` devuelven `dataStatus: "ok" | "inconclusive"` y, si es `inconclusive`, `inconclusiveReason`:
   - `not_configured`: faltan `ADS_API_CLIENT_ID`, `ADS_API_CLIENT_SECRET` o `ADS_API_REFRESH_TOKEN`.
   - `connection_error`: falló la llamada a Amazon Ads; `error.kind` indica la causa.
   - `no_performance_data`: conectado, pero sin informe de rendimiento para el periodo, o todas las métricas son cero.
   Con `inconclusive`, `metrics` es `null` (nunca ceros) y las campañas llevan `metrics: null`. Los conteos de campañas sí son reales.
3. **Errores clasificados, nunca silenciados:** `error.kind` ∈ `not_configured | auth (401/403) | throttled (429) | client (otros 4xx) | server (5xx) | network`. Todo error se registra en log con su tipo y viaja en la respuesta.
4. **Publicación:** `publish-snapshots` rechaza cualquier payload con `isDemoData: true`. El panel descarta snapshots antiguos sin `dataStatus`.
5. **Cliente Amazon Ads:** limitador token-bucket por operación (`ADS_API_RATE_LIMITS`: `ads.getProfiles`, `ads.listSpCampaigns`); reintentos ante 429/5xx/red con `Retry-After` o backoff exponencial con jitter (máx. 5); 401/403 no se reintentan. Las campañas SP se listan con v3 `/sp/campaigns/list` siguiendo `nextToken`.
6. **Perfil:** se listan todos los perfiles autorizados de la región (`/v2/profiles`). `ADS_API_PROFILE_ID` debe estar entre ellos; si no está definido, se usa el perfil cuyo `marketplaceStringId` coincide con el marketplace principal. Nunca "el primero".

## 6. Puente de Rentabilidad (Proceso 1)
1. **Informes (Reporting v3, Sponsored Products, `GZIP_JSON`, `SUMMARY`):** `spCampaigns` (por campaña), `spAdvertisedProduct` (por SKU anunciado, incluye `unitsSoldSameSku7d`/`attributedSalesSameSku7d`) y `spSearchTerm` (base de los Procesos 2 y 3). Atribución de ventas a 7 días.
2. **Ventana:** 30 días que acaban **3 días antes de hoy** (los datos de atribución llegan con ~72 h de retraso; nunca se decide sobre los últimos 3 días).
3. **Almacenamiento:** Supabase `snapshots`, clave `ads:report:<campaigns|advertisedProducts|searchTerms>:<profileId>` con `{profileId, kind, startDate, endDate, generatedAt, rows}`; sin Supabase, `backend/data/ads-reports/`. Un informe que falla o no termina en `ADS_SYNC_MAX_WAIT_MIN` (30) conserva la copia anterior y el script sale con error.
4. **Margen antes de publicidad por unidad:** `ads:sync-reports` calcula el margen de **cada SKU anunciado** (FBM y FBA sin stock incluidos) en `ads:margins:<profileId>`; `margins:products` (solo inventario FBA activo) completa lo que falte. Fórmula: `precio / (1 + IVA) − comisiones Amazon − coste puesto` (coste Sellerboard + envío doméstico). IVA de Sellerboard; si falta, 21 %. El precio es el de la oferta al consumidor (oferta activa si la hay).
5. **Por SKU:** `beneficio tras Ads = unidades del mismo SKU × margen unitario − gasto`. Las ventas halo (otros SKUs) no cuentan: su margen es desconocido y así el veredicto es conservador. `break-even ACoS = margen unitario / precio con IVA × 100` (comparable con el ACoS de Amazon, que usa ventas con IVA). Veredicto: `profitable`, `leak` (beneficio tras Ads < 0) o `no_cost` (sin margen completo: fuera de la automatización).
6. **Cobertura:** `gasto de SKUs con coste / gasto total`. Por debajo de **90 %** la respuesta es `inconclusive` con motivo `low_cost_coverage` (se muestran los datos, no se decide sobre ellos).
7. **TACoS:** gasto / ventas del canal del perfil (p. ej. `Amazon.es`) del informe de pedidos en la misma ventana. Si no hay ventas, `tacos` y `totalStoreSales` son `null`, nunca estimados.

