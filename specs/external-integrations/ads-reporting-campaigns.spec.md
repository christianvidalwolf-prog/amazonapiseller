# Especificación SDD: Integración Amazon Ads (Campañas Sponsored Products + Reporting v3)
**Módulo:** `external-integrations/ads-reporting`
**Scripts vinculados:** `backend/scripts/ads_auth_helper.py` (auth), `backend/ads/*` (a crear)
**Ficheros de datos:** `backend/ads/keywords/40973_keywords.json` (semillas por SKU)
**Versión:** 0.1.0 (spec — pendiente de implementar y de aprobación del usuario)

---

## 1. Propósito y Alcance
Gobierna dos capacidades sobre la **Amazon Ads API** (marketplace ES, `A1RKKUPIHCS9HS`):
1. **Reporting (lectura):** ingesta diaria de métricas de Sponsored Products vía **Reporting API v3** (campaña, término de búsqueda, keyword) hacia Supabase.
2. **Creación de campañas (escritura):** creación idempotente de 4 campañas SP para un SKU (Auto, Exact, Phrase, defensa de marca) con presupuestos y pujas controlados.

Fuera de alcance en v1: Sponsored Brands/Display, mutaciones masivas optimizadas (harvest/negativización automatizada con escritura), mercado DE/FR/IT.

## 2. Reglas Contractuales de Negocio
1. **Dry-run por defecto:** toda operación de escritura requiere flag explícito `ADS_APPLY=1` + sesión interactiva del usuario. Sin flag, solo reporta el plan (qué crearía) sin llamar a endpoints de escritura.
2. **Idempotencia de campañas:** antes de crear, consultar campañas existentes por `name`/`portfolioId` y `state != archived`; si existe, `SKIP` en vez de duplicar. Nombres de campaña: `SP-{SKU}-{intención}` con estado `PAUSED` al crear; activar solo tras validación.
3. **Gate de stock:** no crear/activar campañas de un SKU con término principal `*FBA` si el stock FBA + inbound es **< 20 unidades** (umbral mínimo de lanzamiento). El gate se resuelve en runtime contra Supabase (`fba stock`), no como constante local.
4. **Límites económicos (puja y ACoS):**
   - Break-even ACoS por marketplace calculado desde Supabase (`costs:products`) + fee FBA real (`getMyFeesEstimate`); para SKU 40973 el cálculo de referencia es: ES 24,3% · objetivo 19% · techo absoluto 20%.
   - CPC máximo permitido (`maxCpc`) debe mantener el bid ≥ break-even: `bid_limit = contribution-margin × target-ACoS` (7,25 € × 19% ≈ **1,38 €** ES FBA). Ninguna puja de campaña inicial supera el rango **0,30–0,60 €** autorizado en el plan.
   - Presupuestos diarios máximos de la v1: Auto **6 €**, Exact **6 €**, Phrase **4 €**, marca **3 €** (total ≈ 19 €/día). Subidas de presupuesto requieren nueva decisión del usuario en sesión.
5. **Términos de marca compartidos:** entre SKUs hermanos (40973MD, 42809MD, 41353MD) la keyword de marca vive **solo en la campaña de defensa de marca** del SKU propietario del ASIN que anuncia; el resto usa negativa exact para no pujar contra sí mismos.
6. **Un anunciante por ASIN:** con FBM y FBA del mismo ASIN (40973MD/40973MDFBA), solo una variante es anunciada por campaña (padre `40973MD`, hijos diferenciados por `state`); nunca ad-groups duplicados del mismo ASIN simultáneos.

## 3. Autenticación y Endpoints
1. **LWA:** refresh token vía `ADS_API_REFRESH_TOKEN` (generado con `ads_auth_helper.py`, scope `cpc_advertising:campaign_management`), almacenado en `backend/.env`. Nunca persistir access tokens en disco.
2. **Profile ID:** `ADS_API_PROFILE_ID` en `.env` (vacío hoy); proporcionado por `ads_auth_helper.py` tras el OAuth del usuario.
3. **Endpoints:** `https://advertising-api-eu.amazon.com` (EU). Header obligatorio `Amazon-Advertising-API-ClientId`, `Authorization: Bearer`, `Amazon-Advertising-API-Scope: <profileId>`.
4. **Rate limits:** tratar `429`/`503` con backoff exponencial (mín. 2 s) y respeto al header `Retry-After`; máx. 5 reintentos por llamada. Los endpoints de reporting v3 son asíncronos: crear **report** (`POST /reporting/reports`), encustar estado (`status`), descargar respuesta comprimida.

## 4. Manejo de Errores
- Si falta `ADS_API_REFRESH_TOKEN` o `ADS_API_PROFILE_ID`, abortar con instrucción clara de ejecutar `ads_auth_helper.py` (requiere intervención del usuario).
- Si Supabase no aporta COGS/fees de un SKU, abortar el cálculo de break-even (nunca usar margen estimado por defecto).
- Si el gate de stock falla o los datos de stock son `null`, abortar sin crear campañas y avisar.
- Registrar cada llamada Ads (endpoint, params, timestamp, HTTP status) en log rotativo; **no loguear tokens ni PII de clientes** (regla DPP).

## 5. Datos y Persistencia
- Tablas Supabase nuevas (schema a definir al implementar): `ads_daily_reports` (product-level: spend, clicks, impressions, sales por SKU/day/marketplace), `ads_search_terms` (términos + negativización pendiente), `ads_campaigns_registry` (campañas creadas, nombre, id, estado, presupuesto aplicado).
- Las métricas Ads **no sustituyen** nada existente; las charts del panel seguirán mostrando simulacros hasta que las tablas tengan datos reales.

## 6. Estados del Cycle (v1)
| Estado | Significado |
|---|---|
| DRAFT | Spec congelado y aprobado por el usuario; código no escrito |
| READY-TO-IMPLEMENT | Usuario OK en: restock FBA ≥20 u, ejecutar `ads_auth_helper.py`, confirmar presupuestos |
| BLOCKED | Sin STOCK ok / sin OAuth Ads / sin confirmación < creando campañas |

## 7. Open Questions del Usuario (bloquean READY-TO-IMPLEMENT)
1. **Restock:** ¿restock FBA a ≥20 unidades antes de lanzar? (obligatorio según regla 3)
2. **OAuth:** ejecutar `ads_auth_helper.py` para obtener `ADS_API_REFRESH_TOKEN` + `ADS_API_PROFILE_ID`.
3. **Presupuesto:** confirmar 19 €/día total para ES.
4. **Volumen mínimo:** consenso interno: lanzar exact+auto primero (10 €), añadir phrase/marca tras ≥30 clicks de datos.
