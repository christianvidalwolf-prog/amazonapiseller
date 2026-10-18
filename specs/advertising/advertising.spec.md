# Especificación SDD: Advertising (Amazon Ads & PPC)
**Módulo:** `advertising`  
**Versión:** 1.1.0  
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
- `GET /api/advertising/campaigns`: Listado paginado de campañas con métricas agregadas por ventana de tiempo (`7d`, `14d`, `30d`, `custom`).
- `GET /api/advertising/keywords/harvest`: Sugerencias algorítmicas de palabras clave para negación o escalado.
- `PATCH /api/advertising/bids`: Actualización por lotes de pujas con validación previa de los guardrails.
- `POST /api/advertising/sync`: Sincronización de reportes de rendimiento con Amazon Ads API.

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

