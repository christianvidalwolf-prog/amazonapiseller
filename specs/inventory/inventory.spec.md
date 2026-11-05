# Especificación SDD: Inventory (Stock FBA & FBM)
**Módulo:** `inventory`  
**Versión:** 1.0.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Control bidireccional de existencias en almacenes de Amazon (FBA) y almacén propio (FBM). Sincronización con archivos locales/ERP (`signes_sgi_amazon.csv`) y previsión de días de cobertura para evitar roturas de stock o sobrecostes por almacenamiento prolongado (IPI score).

## 2. Métricas y Conceptos Clave
- **FBA Sellable Units:** Unidades disponibles para compra inmediata en centros logísticos.
- **FBA Reserved / Inbound:** Unidades en tránsito hacia los almacenes de Amazon o reservadas para pedidos de clientes.
- **Days of Supply (Días de Cobertura):** `(Stock Disponible + Stock en Tránsito) / Ventas Promedio Diarias (últimos 30 días)`.
- **Nivel de Alerta:**
  - `CRITICAL_LOW`: Días de cobertura < 14 días (riesgo inminente de perder ranking y Buy Box).
  - `OVERSTOCK`: Días de cobertura > 90 días (riesgo de cargos por almacenamiento de inventario envejecido).
  - `OPTIMAL`: Entre 30 y 60 días de cobertura.

## 3. Endpoints y Operaciones
- `GET /api/inventory/summary`: Estado global de inventario, valoración total de stock y distribución FBA vs FBM.
- `GET /api/inventory/alerts`: Productos en situación de rotura de stock inminente o sobrestock.
- `POST /api/inventory/sync-local`: Sincronización con los ficheros CSV locales de stock del almacén.

## Vigilante FBA (listings inactivos con stock)
- Diario a las 7:00 (Europe/Madrid), `.github/workflows/agents-inactive-listings.yml` → `backend/scripts/agents/inactive-listings.ts`: escanea, clasifica, corrige por API y verifica en ES/DE/FR/IT. Contrato y guardrails en `specs/inventory/inactive-listings-agents.spec.md`.
- El vigilante anterior (`.github/workflows/watch-inactive-fba.yml`, solo lectura) queda para ejecución manual; escribe el mismo informe compatible en `alerts:fba-inactive:last-run`.
- Países ES/DE/FR/IT (`INACTIVE_AGENTS_COUNTRIES`). Por país: FBA Inventory `getInventorySummaries` (granularidad marketplace), SKU con `fulfillableQuantity > 0`; Listings Items `getListingsItem` (`summaries,issues,attributes`, `issueLocale=es_ES`). Inactivo = estado sin `BUYABLE` o SKU inexistente en ese marketplace; motivo = issues `ERROR`. Los `amzn.gr.*` (Grade and Resell, creados por Amazon) no cuentan cuando no existen en un marketplace.
- El correo diario sale del equipo de agentes (Gmail SMTP, `smtp.gmail.com:465`, `nodemailer`, secretos `GMAIL_USER` y `GMAIL_APP_PASSWORD`) a `ALERT_EMAIL_TO`; sin incidencias no envía. Informe completo en Supabase `rules:inactive-listings:last-run`, más el formato compatible `alerts:fba-inactive:last-run`.
- Guardrails: simulación por defecto, tope `INACTIVE_AGENTS_MAX_FIXES` (60/día), 2 intentos por caso, `VALIDATION_PREVIEW` antes de crear ofertas/GPSR, y nunca toca `blocked_skus.txt` ni el precio B2B.

## SKU bloqueados (`blocked_skus.txt`)

SKU retirados para siempre. Se borran a mano de Amazon en todos los países (Listings Items DELETE) y no se vuelven a listar:
- `sync_daily_stock_amz.py` (feed de las 9:00) los envía con stock 0 y sin precio aunque el STOCK AMZ traiga unidades, y así quedan también a 0 en la copia de Supabase `stock:latest:*`. Para un SKU ya borrado Amazon rechaza el `PARTIAL_UPDATE`, así que no lo recrea.
- `npm run listings:reactivate` nunca los recrea, ni siquiera con `SKUS=`.
- `create_listings_eu.py` no los da de alta.

Para retirar un SKU: añadirlo al fichero (uno por línea) y borrarlo en Amazon. Para volver a venderlo: quitarlo del fichero.
