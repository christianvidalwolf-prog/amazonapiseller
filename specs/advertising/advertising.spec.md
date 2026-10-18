# Especificación SDD: Advertising (Amazon Ads & PPC)
**Módulo:** `advertising`  
**Versión:** 1.6.0  
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
3. **Keywords Negativas:** solo en modo propuesta y con el criterio estadístico de §7 (sustituye a la regla fija «> 15 clics y 0 ventas», que con conversiones del 1-3 % niega términos por azar). Ninguna negativa se aplica en Amazon sin aprobación humana registrada.
4. **Registro de Auditoría:** Toda mutación de puja o estado de campaña debe persistirse con timestamp, valor anterior, nuevo valor y motivo algorítmico.

## 4. Endpoints y Operaciones
- `GET /api/advertising/summary`: KPIs del último informe de campañas guardado (ventana de 30 días que acaba hace 3 días).
- `GET /api/advertising/campaigns`: Todas las campañas SP con las métricas del mismo informe.
- `GET /api/advertising/profitability`: Puente de rentabilidad por SKU (§6).
- `GET /api/advertising/keywords/harvest`: Informe de fuga por términos de búsqueda y propuestas de negativas (§7); la cosecha (Proceso 3) se añadirá en el mismo payload.
- `PATCH /api/advertising/keywords/harvest` `{ id, decision: "approved" | "rejected" }`: registra la decisión humana sobre una propuesta vigente (negativa, cosecha o ACoS alto; 404 si no existe) y su asiento en el Change Log. No escribe en Amazon.
- `GET /api/advertising/changelog`: registro de decisiones del perfil (§9.6).
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

## 7. Fuga por Términos de Búsqueda y Negativas en Modo Propuesta (Proceso 2)
1. **Fuente:** informe `spSearchTerm` de la ventana de §6. El mismo término dentro del mismo grupo de anuncios (alcanzado por varios targets) es un único candidato. Solo son candidatos los términos con gasto y 0 pedidos.
2. **Conversión base del grupo:** pedidos/clics del informe `spAdvertisedProduct` del grupo, suavizada hacia la conversión de la cuenta con 50 clics de prior: `(pedidos + 50 × cvr_cuenta) / (clics + 50)`.
3. **Beneficio de una unidad del grupo:** media ponderada por clics del margen unitario antes de Ads (§6.4) de sus SKUs. Si ningún SKU del grupo tiene coste, el término queda **fuera de la automatización** (`noCost`).
4. **Criterio:** se propone negar si `P(0 ventas) = (1 − cvr_grupo)^clics < 0,05` **y** `gasto > beneficio de una unidad`. Si no, es `insufficient` (nunca "negar" por defecto).
5. **Tipo:** búsqueda de ASIN (`B0` + 8) → `NEGATIVE_PRODUCT_TARGET` (target negativo de producto); resto → `NEGATIVE_EXACT` (keyword negativa exacta) en el grupo de anuncios del término.
6. **Registro:** cada propuesta lleva `id` estable (`adGroupId|tipo|texto`), evidencia (clics, gasto, conversión base, `pNoSale`, beneficio por unidad) y motivo. Las decisiones se guardan en Supabase `ads:decisions:negatives:<profileId>` (`{ [id]: { decision, decidedAt } }`), separadas del snapshot `advertising:keywords:harvest`, y se conservan mientras la propuesta siga existiendo.
7. **Informe de fuga:** `gasto sin venta` = propuestas (recuperable) + `insufficient` + `noCost` (fuga dispersa). La fuga dispersa no se ataca con negativas sino con pujas (Proceso 4) y con los SKUs en fuga del puente (§6).
8. **Aplicación en Amazon:** fuera de este proceso. Solo propuestas `approved` podrán enviarse, por lote explícito y con log de auditoría (§3.4).

## 8. Multipaís (ES, DE, FR, IT)
1. **Perfiles:** la autorización de Amazon Ads da acceso a un perfil por país. Todos los endpoints de §4 aceptan `?country=XX`: se usa el perfil cuyo `countryCode` coincide (si no hay perfil autorizado, `connection_error`). Sin `country`, el perfil por defecto (§5.6, ES).
2. **Ingesta:** `ads:sync-reports` procesa `ADS_SYNC_COUNTRIES` (por defecto `ES,DE,FR,IT`). Los informes de todos los países se piden en paralelo; los márgenes se calculan después, país a país, para respetar los límites de SP-API del vendedor.
3. **Margen por país:** precio y comisiones del marketplace del perfil (`accountInfo.marketplaceStringId`), coste Sellerboard (común) e **IVA estándar del país** (ES 21, DE 19, FR 20, IT 22), que prevalece sobre el IVA por SKU de Sellerboard (el español). `margins:products` (precios de ES) solo se usa para el perfil de ES.
4. **TACoS:** ventas del canal del país (`Amazon.de`, `Amazon.fr`, `Amazon.it`).
5. **Snapshots:** las claves por defecto (`advertising:summary`, `:campaigns`, `:profitability`, `:keywords:harvest`) son ES; los demás países llevan sufijo `:<CC>` (p. ej. `advertising:summary:DE`). Las decisiones de negativas se guardan por perfil (`ads:decisions:negatives:<profileId>`).

## 9. Reglas incorporadas de la skill `amazon-ads-spapi-optimizer` (lo mejor de ambas)
Se adoptan las reglas de la skill que el sistema no tenía; donde chocan, prevalece la versión más segura y se documenta el motivo.

1. **Frenos por stock y Buy Box (`ads:context:<profileId>`, `adContext.ts`).** Por SKU anunciado: unidades FBA vendibles del marketplace (FBA Inventory), unidades vendidas en el canal en 30 días (velocidad) y Buy Box propia (`getItemOffers`, solo SKUs con gasto). `WOC = vendibles / (unidades 30 d / 30 × 7)`. Factor `alpha`: sin Buy Box o sin stock → **0 (pausar)**; WOC < 2 → 0,1; 2-4 → 0,5; 4-6 → 0,8; ≥ 6 → 1. SKUs sin registro FBA (FBM): `alpha` 1 con aviso `STOCK_NO_VERIFICADO`. Las alertas críticas (sin Buy Box, sin stock, WOC < 4) con gasto en la ventana se devuelven en `/profitability` (`alerts`).
2. **Devoluciones.** Tasa de devolución por SKU y canal en 90 días (devoluciones atribuidas al canal de su pedido), solo con ≥ 10 unidades vendidas. El beneficio unitario antes de Ads se multiplica por `(1 − tasa)`: una venta devuelta no deja beneficio (aproximación).
3. **ACoS objetivo y CPC sostenible (`bidAdvice.ts`).** `ACoS objetivo = 65 % del ACoS de equilibrio` (fase de madurez, 60-70 %). Con ≥ 15 clics: `CPC sostenible = ventas del mismo SKU / clics × ACoS objetivo × alpha`, con techo 1,50 €. Acción propuesta frente al CPC real: `bajar` (libre), `subir` (máx. +20 % por cambio), `mantener`, `pausar` (alpha 0) o `sin_datos`. En Amazon la puja vive en keywords/targets/grupos, no en SKUs: sirve para retirar SKUs y agruparlos por nivel de puja.
4. **Negativas (complementa §7).** Se **rechaza** la regla fija de la skill «≥ 10-15 clics y 0 ventas» (con CVR 1-3 % niega por azar). Se **adopta** su stop-loss: gasto ≥ 1,5 × beneficio de una unidad, 0 ventas y al menos 1 venta esperada (`clics × CVR_grupo ≥ 1`) → propuesta `stop_loss`.
5. **Cosecha y ACoS alto (Proceso 3, `harvest.ts`).** El ACoS de equilibrio de un término es la media ponderada por clics del de los SKUs de su grupo (≤ 100 %).
   - **Graduación:** término de descubrimiento (auto/broad/phrase) con ≥ 3 pedidos, CVR ≥ 1,5 × CVR de la cuenta y ACoS ≤ equilibrio → `HARVEST_EXACT` (o `HARVEST_PRODUCT_TARGET` si es un ASIN) con puja inicial = ingreso por clic × ACoS objetivo (≤ 1,50 €) y negativa exacta en el grupo de origen.
   - **ACoS alto:** ≥ 5 pedidos y ACoS > 2 × objetivo → desde descubrimiento `NEGATIVE_EXACT_ORIGIN` (y probar en Exacta con puja reducida); ya en Exacta `BID_DOWN` gradual, nunca pausar de golpe.
6. **Change Log (`ads:changelog:<profileId>`, `changelog.ts`).** Cada decisión registra entidad, acción, valor nuevo, métrica baseline, motivo y **revisión a +14 días**. Una entidad aprobada o aplicada hace < 14 días está **en maduración** (`maturingUntil`) y no debe cambiarse de nuevo.
7. **Ubicaciones.** Informe `spCampaigns` agrupado por `campaignPlacement` (`placements`). El resumen devuelve gasto, ventas, clics, pedidos, ACoS y CVR por ubicación; la auditoría señala las que superan 1,5 × el ACoS medio. Los modificadores de Top of Search se proponen solo si su conversión lo respalda.
8. **Auditoría semanal (`npm run ads:audit`, `audit.ts`).** Por país, las 5 secciones de la skill: (1) resumen de salud, (2) alertas críticas (incluye campañas activas sin impresiones), (3) corte de fugas, (4) escalado, (5) filas para el Change Log. Solo lectura.
9. **Pendiente (no adoptado aún):** dayparting con Marketing Stream (requiere infraestructura de streaming, §Proceso 7) y diagnóstico cruzado con SQP (ya existe `brand-analytics`; se integrará en la sección 4 de la auditoría).

## 10. Estructura profit-first desde cero (`npm run ads:plan` → `npm run ads:apply-plan`)
1. **Candidatos (por país):** SKUs FBA con stock vendible (pool paneuropeo) que en ese país tengan oferta con precio, Buy Box propia y cobertura de stock (factor `alpha` > 0, §9.1). Se excluyen, con motivo registrado: sin Buy Box, sin stock, sin precio, margen incompleto, beneficio por unidad < **3 €** (neto de IVA del país y devoluciones) o CPC sostenible < **0,05 €**.
2. **CPC sostenible:** `(ventas mismo SKU + 50 × precio × CVR país) / (clics + 50) × 65 % del ACoS de equilibrio × alpha`, entre 0,05 € y 1,50 €.
3. **Campañas (prefijo `PF`; separador ` | `: Amazon rechaza «·» en los nombres, y los nombres de grupo se sanean a letras, números y signos básicos):**
   - `PF | <CC> | AUTO | <familia>`: familia = grupo de display del catálogo de Amazon (ES); el número de campañas AUTO lo limita el presupuesto (≥ 3 €/día cada una): las familias mayores tienen campaña propia y el resto comparte «Varios» (o una única «Catálogo»); dentro de una campaña compartida, las familias con < 3 SKUs se agrupan en «Otros». Grupos de anuncios por **nivel de puja** (A ≥ 0,30 €, B ≥ 0,15 €, C ≥ 0,05 €), puja = mediana del grupo. Pujas por segmentación automática = puja × multiplicador del historial del país (`ACoS medio / ACoS del grupo`, entre 0,5 y 1,2; ≥ 5 € sin ventas → pausa; sin datos: cercana y sustitutos 1, amplia 0,6, complementos en pausa).
   - `PF | <CC> | MANUAL | EXACTA`: términos con ≥ 1 pedido y ACoS ≤ equilibrio, con los ≤ 5 SKUs que más vendieron en su grupo de origen. Puja inicial = ingreso por clic suavizado (100 clics de prior hacia el grupo) × ACoS objetivo, con techo **2 × CPC medio del país**.
   - `PF | <CC> | MANUAL | ASIN`: igual, para búsquedas de ASIN de competidores (targeting `ASIN_SAME_AS`).
   - `PF | <CC> | MARCA`: los términos que contienen una marca propia van solo aquí (exacta); marcas propias (`ADS_BRANDS`, por defecto «Rocking Gifts») en concordancia de frase, puja = 50 % de la mediana de sus SKUs.
   - Las AUTO llevan como **negativas de campaña** los términos (exacta) y ASIN de las manuales: cada búsqueda se paga una sola vez.
4. **Presupuesto diario por país:** por defecto 70 % del gasto real diario de la ventana (mín. 5 €; `ADS_PLAN_BUDGET_<CC>` lo fija). Reparto: EXACTA 15 %, ASIN 20 %, MARCA 5 %, el resto entre las AUTO según su capacidad (suma de CPC sostenibles); mínimo 1 € por campaña.
5. **Plan revisable:** `ads:plan:<profileId>` + markdown en `backend/data/ads-plan-<fecha>.md`. `ADS_STORE=file` lo guarda solo en local.
6. **Ejecución (`ads:apply-plan`, Ads API v3):** simulacro por defecto; `ADS_APPLY=1` crea. Las campañas se crean **EN PAUSA**; grupos, anuncios, keywords, targets, pujas automáticas (`PUT /sp/targets`) y negativas de campaña dentro. Idempotente por nombre (relanzar reanuda sin duplicar). `ADS_MODE=activate` activa las nuevas y pausa a la vez las antiguas activas (`pauseOld`); `ADS_MODE=rollback` lo revierte. Cada ejecución aplicada queda en el Change Log con revisión a +14 días. Las campañas antiguas nunca se archivan ni se borran.
7. **Productos no elegibles:** Amazon puede rechazar un anuncio de producto con `AD_INELIGIBLE` (categoría restringida o listing no apto); se registra en el log de ejecución y el resto continúa.

