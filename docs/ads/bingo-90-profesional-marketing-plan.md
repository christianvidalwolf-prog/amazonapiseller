# Plan de marketing ads — Bingo 90 Profesional (familia 40973)

> Plan operativo completo para implementar desde otro agente (Antigravity o similar).
> Complementa al runner `backend/scripts/ads-create-seed-campaigns.ts` y al spec
> `specs/external-integrations/ads-reporting-campaigns.spec.md` (fuente de verdad técnica).
> Última actualización: 2026-10-24 · estado: plan listo, campañas PAUSED, activación pendiente de stock.

---

## 1. Contexto del producto

| Campo | Valor |
|---|---|
| Producto | **Bingo 90 Profesional** (set grande con bolas sueltas, adulto/familiar) |
| ASIN | `B0FX2ZVG3F` |
| SKUs | `40973MDFBA` (FBA) · `40973MD` (FBM) |
| Marketplace | Amazon.es (`A1RKKUPIHCS9HS`) |
| Marca | ROCKING GIFTS |
| Precio de referencia | 29,90 € |
| Categoría competitiva | Juegos de mesa / bingo 90 bolas |
| Stock actual (2026-10-24) | 4 en FBA + 11 inbound = **15 u** (< umbral de 20) |

## 2. Guardrails económicos (inviolables)

Cualquier ajuste automatizado debe respetarlos. **Nunca** mover pujas/budgets si rompe esto.

| Métrica | Valor | Procedencia |
|---|---|---|
| Margen de contribución | **7,25 €/ud** | ERP (SP-API orders − fees 15 % − envío − COGS) |
| Precio suelo Buy Box | 29,90 € | guardrail de precios del spec |
| Break-even ACoS | **24,3 %** (= 7,25 / 29,90) | margen de contribución |
| ACoS objetivo | **19 %** | target operacional |
| TACoS máximo | 12 % | guardrail del spec |
| Puja máxima práctica | **≤ 0,72 €** (CVR objetivo 10 %) | fórmula de puja (`contribution × CVR`) |
| Puja máxima absoluta | 1,00 € | guardrail `acos_bid` del spec |
| Umbral de activación | **FBA + inbound ≥ 20 u** | spec §3.6 |
| Presupuesto total lanzamiento | **19 €/día** | este plan |

Las pujas iniciales parten por debajo del techo (0,35–0,60 €) y solo crecen con datos validados.

## 3. Arquitectura de campañas (creadas PAUSED)

4 campañas Sponsored Products, cada una con 1 ad group que contiene ambos SKUs
(`40973MDFBA` + `40973MD`). Ninguna otra SKU.

```
SP-40973-Auto    AUTO    6 €/día · ad group 40973-Auto   · autoBids close 0.60 / loose 0.40 / subs 0.35 / comps 0.30
SP-40973-Exact   MANUAL  6 €/día · ad group 40973-Exact  · 17 keywords EXACT
SP-40973-Phrase  MANUAL  4 €/día · ad group 40973-Phrase · 4 keywords PHRASE
SP-40973-Marca   MANUAL  3 €/día · ad group 40973-Marca  · 3 EXACT + 2 PHRASE (defensa de marca)
```

Estados: campañas `PAUSED`. Las keywords/targets se crean `ENABLED`; solo ejecutan
al activar la campaña.

### 3.1 Keywords Exact (17)

| Keyword | Puja (€) | Origen SQP |
|---|---|---|
| bingo juego de mesa adulto | 0,60 | corriente alta |
| bingo | 0,50 | corriente alta |
| bingo juego | 0,50 | corriente alta |
| juego de mesa bingo | 0,50 | corriente alta |
| bingo 90 bolas | 0,45 | corriente alta + rango |
| bingo grande | 0,40 | corriente alta |
| bolas bingo sueltas 90 | 0,40 | Producto/Rango |
| bingo 90 profesional | 0,40 | Producto / título |
| bingo de 90 bolas | 0,40 | corriente alta |
| bingo de 150 bolas | 0,40 | Producto/Rango |
| juego bingo | 0,40 | corriente alta |
| juegos de mesa familiar | 0,40 | Marketing |
| bingo para casa | 0,35 | corriente media |
| juego bingo más vendido | 0,35 | Rango |
| bingo sets | 0,35 | Producto |
| boulier bingo | 0,35 | Long-tail |
| cuatro sotas | 0,35 | Long-tail |

### 3.2 Keywords Phrase (4)

| Keyword | Puja (€) |
|---|---|
| bingo juego de mesa | 0,45 |
| bingo 90 bolas | 0,40 |
| juego de mesa bingo | 0,40 |
| bingo grande | 0,35 |

### 3.3 Marca (3 EXACT + 2 PHRASE)

| Keyword | Tipo | Puja (€) |
|---|---|---|
| rocking gifts bingo | EXACT | 0,60 |
| bingo rocking gifts | EXACT | 0,50 |
| rocking gifts | EXACT | 0,40 |
| rocking gifts bingo | PHRASE | 0,50 |
| bingo rocking gifts | PHRASE | 0,40 |

### 3.4 Negativos (por campaña y scope)

> Regla del spec: negativizar **a nivel de ad group**, no de campaña (salvo junk
> universal). Todos los negativos son **NegativeExact**.

| Campaña | Negativos | Scope |
|---|---|---|
| SP-40973-Auto | `rocking gifts`, `muñeca`, `zapatones` | ad group |
| SP-40973-Exact | `rocking gifts` | ad group |
| SP-40973-Phrase | `rocking gifts`, `muñeca`, `zapatones` | ad group |
| SP-40973-Marca | — | — |

Preview del dry-run (50 operaciones en total): 4 campañas + 4 ad groups + 8 product
ads + 26 keywords + 1 set de auto-bids + 7 negativos.

## 4. Presupuesto

| Campaña | €/día | % |
|---|---|---|
| Auto | 6 | 32 % |
| Exact | 6 | 32 % |
| Phrase | 4 | 21 % |
| Marca | 3 | 16 % |
| **Total** | **19** | 100 % |

Límites y umbrales concretos (rate limits, ACoS/TACoS, funnel) viven en el spec;
ese es la fuente de verdad si hay conflicto con este documento.

## 5. Gestión de pujas y escalado (semáforo por keyword)

Se aplica por keyword/ad group solo con **≥ 10 clicks** acumulados (regla mínima:
nunca cambiar una puja con menos clicks, es ruido estadístico).

| Estado | Condición | Acción |
|---|---|---|
| ✅ Rentable | ACoS < 19 % y ≥ 3 ventas | Subir puja +0,05 a +0,10 € (cap 0,72 €); si rinde mucho, dupla el término en Exact |
| 🟡 Neutral | 19 % ≤ ACoS < 24,3 % | Sin cambios; revisar en 10–14 días |
| 🟠 Perdiendo leve | 24,3 % ≤ ACoS < 35 % | Bajar −0,05 € pasos hasta mínimo 0,30 € o pausar |
| 🔴 Perdiendo claro | ACoS ≥ 35 % con > 15 clicks sin venta | Negativizar el término (desde Auto) o pausar la keyword |

Reglas Auto:
- **Harvest**: cada lunes, un search term que acumule **≥ 3 ventas o ≥ 10 clicks con
  ACoS ≤ 24,3 %** se añade como EXACT en `SP-40973-Exact` con la puja por defecto.
- **Exit**: negativizar en Auto los términos que se descarten en Exact/Phrase.

## 6. SQP / funnel de búsqueda

- **Tracking semanal** con SQP monthly: Search Frequency Rank y share por keyword.
- **Fuga del funnel**: revisar cada etapa (impresiones → clicks → pedidos) contra los
  umbrales de `funnel_leak` del spec; la fuga se arregla con puja/keyword, no con budget.
- **Harvest orgánico**: keywords con ≥ 3 ventas orgánicas en 30 días se dan de alta
  en Exact con la puja por defecto (0,60 / 0,50 / 0,45 / 0,40 según corriente).
- **TACoS guard**: TACoS sostenido > 12 % durante 14 días → replantear tras baja de
  pujas/presupuesto global.

## 7. Calendario de lanzamiento

| Fase | Cuándo | Acciones |
|---|---|---|
| F1 Crear | ya | Aplicar el runner (dry-run + `ADS_APPLY=1`) → 4 campañas PAUSED; verificar en Ads console. |
| F2 Activar | cuando FBA+inbound ≥ 20 u | Poner campañas `ENABLED` (Auto → Exact → Phrase → Marca); marca se activa siempre. |
| F3 Primer review | día 14 | Revisar ACoS/clicks/pedidos y aplicar el semáforo; nada antes de 10 clicks. |
| F4 Escalado | semanas 5–8 | +0,5–1 € presupuesto en campañas rentables (≥ 0,3 ventas/día); continuar harvest SQP. |
| F5 Mantenimiento | semana 9+ | Review semanal con umbrales 19 % / 24,3 % y TACoS < 12 %. |

El job diario de stock (`spapi.syncStock`) es el trigger de F2: cuando FBA+inbound
≥ 20 u desbloquea la activación y registra el evento en el Change Log.

## 8. Arquitectura técnica (lo que el agente implementador debe conocer)

### 8.1 Endpoints Ads usados

```
GET  /v2/profiles                                   → seleccionar el perfil de Amazon.es
POST /sp/campaigns                                  (lote ≤ 100)
POST /sp/adGroups                                   (lote ≤ 100)
POST /sp/productAds                                 (lote ≤ 100)
POST /sp/keywords                                   (keywords EXACT/PHRASE)
POST /sp/campaignNegativeKeywords
POST /sp/targets                                    (auto targeting bids)
GET  /sp/campaigns/list?...&nameFilter=SP-40973     (idempotencia por nombre)
PUT  /sp/campaigns/{campaignId}                     (state, dailyBudget)
PUT  /sp/keywords/{keywordId}                       (state, bid)
```

Rate limits del cliente (`backend/src/ads/adsClient.ts`): escritura `{rate:1,burst:3}`
req/s; listar `{rate:2,burst:5}`.

### 8.2 OAuth (problema actual — a resolver antes del apply)

- client_id: `amzn1.application-oa2-client.46a2f9dc22744f4f918c346ee4262509`
- Auth URL EU: `https://eu.account.amazon.com/ap/oa`
  `?client_id=<id>&scope=<SCOPE>&response_type=code&redirect_uri=https%3A%2F%2F127.0.0.1`
- **El scope `advertising::campaign_management` fue rechazado** con
  `lwa-invalid-parameter-bad-scope`. Probar (a) `cpc_advertising:campaign_management`,
  (b) habilitar la Ads API en el Security Profile y repetir.
- Token exchange: `POST https://api.amazon.com/auth/o2/token`,
  `Content-Type: application/x-www-form-urlencoded`, body `grant_type=authorization_code`,
  `code`, `redirect_uri`, `client_id`, `client_secret`. El refresh_token se intercambia
  por el **access token LWA** antes de cada llamada a la API.
- Helper automático: `backend/scripts/ads_auth_helper.py` (pide el code, escribe
  `ADS_API_REFRESH_TOKEN` + `ADS_API_PROFILE_ID` en `backend/.env`).

### 8.3 Puja con guardrails

- Puja de entrada **≤ 0,72 €** (CVR objetivo 10 %) y nunca por encima del cap
  `acos_bid` del spec; el máximo absoluto es 1,00 €.
- Puja objetivo = **contribución × CVR objetivo de la keyword** (con contribución
  7,25 € → CVR 10 % → 0,72 €).
- Si una keyword con ≥ 20 clicks y 0 ventas convive con términos orgánicos que sí
  venden, la puja puede subir — hasta 0,72 € y solo si hay señal orgánica real.
  Por debajo de 20 clicks: no tocar.

## 9. Prompt corto para el agente implementador (Antigravity)

> Implementa el plan de lanzamiento ads del Bingo 90 Profesional (familia 40973,
> marketplace ES A1RKKUPIHCS9HS, SKUs 40973MDFBA FBA + 40973MD FBM, ASIN B0FX2ZVG3F).
> Crea 4 campañas SP PAUSED (nombres `SP-40973-{Auto,Exact,Phrase,Marca}`), cada una
> con 1 ad group con ambos SKUs y las keywords/pujas/negativos del seed
> `backend/ads/keywords/40973_keywords.json`. Respeta SIEMPRE: dry-run por defecto
> (`ADS_APPLY=1` obligatorio para escrituras), ACoS break-even 24,3 % / objetivo 19 %,
> TACoS < 12 %, puja ≤ 0,72 € real y 1,00 € absoluto, umbral de stock FBA+inbound ≥ 20 u
> antes de activar FBA, no tocar pujas con < 10 clicks, y registro en el Change Log
> (`ads:changelog:*`) tras cada escritura. La lógica está en
> `backend/src/modules/advertising/` (CampaignPlanApplier, campaignPlan, changelog) y
> `backend/src/ads/adsClient.ts` (rate limits write {rate:1,burst:3} / list {rate:2,burst:5}).
> OAuth: `https://eu.account.amazon.com/ap/oa`, scope `cpc_advertising:campaign_management`
> (fallback: habilitar Ads API en el Security Profile); helper
> `backend/scripts/ads_auth_helper.py`.

## 10. Checklist de aceptación

- [ ] 4 campañas creadas y PAUSED con nombres `SP-40973-*` (verificado en Ads console)
- [ ] Ambos SKUs (FBA+FBM) en cada ad group
- [ ] 26 keywords exactamente como el seed JSON (sin extras)
- [ ] 7 negativos exactamente como el seed JSON (sin genéricos extra)
- [ ] Pujas dentro de caps (≤ 0,72 € práctica / ≤ 1,00 € absoluta)
- [ ] Auto-bids 0,60 / 0,40 / 0,35 / 0,30
- [ ] Presupuesto total = 19 €/día (6/6/4/3)
- [ ] Refresh token + profileId en `.env` con scope válido
- [ ] Change Log actualizado en Supabase tras cada operación real
- [ ] Dry-run (50 ops, 0 errores) verificado antes de cada apply real
- [ ] Sin `ADS_APPLY=1` no se toca Amazon (solo reporte offline)
