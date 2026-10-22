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
- Diario a las 7:00 (Europe/Madrid), `.github/workflows/watch-inactive-fba.yml` → `backend/scripts/watch-inactive-fba.ts`.
- Países ES/DE/FR/IT (`FBA_WATCH_COUNTRIES`). Por país: FBA Inventory `getInventorySummaries` (granularidad marketplace), SKU con `fulfillableQuantity > 0`; Listings Items `getListingsItem` (`summaries,issues`, `issueLocale=es_ES`). Inactivo = estado sin `BUYABLE` o SKU inexistente en ese marketplace; motivo = issues `ERROR`.
- Solo lectura en Amazon. Si hay inactivos, email desde Gmail por SMTP (`smtp.gmail.com:465`, `nodemailer`, secretos `GMAIL_USER` y `GMAIL_APP_PASSWORD` = contraseña de aplicación) a `ALERT_EMAIL_TO` (por defecto christianvidalwolf@gmail.com); sin incidencias no envía. Resultado también en el log del run y en Supabase `snapshots` `alerts:fba-inactive:last-run`.
