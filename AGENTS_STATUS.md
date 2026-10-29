# Coordinación de agentes

Tablero compartido entre Claude, Codex, Gemini y cualquier otro agente o persona que trabaje en este repo.
Reglas en `CLAUDE.md` → "Working in parallel".

1. Antes de empezar, añade una fila en **En curso** (y haz commit de este archivo en tu rama o en `main`).
2. Si otra fila toca los mismos archivos o la misma zona de Amazon, coordina antes (mensaje a la otra sesión o pregunta al usuario).
3. Al terminar (merge hecho o tarea abandonada), mueve la fila a **Terminado** con la fecha.

Zonas sensibles (escriben en Amazon o en producción): precios (`priceBounds`, `fixed_prices.csv`, `sync_prices_stock.py`, `fix_offer_prices.py`), réplica FBA, stock diario, variantes, listings EU, Cdiscount, workflow `sync-snapshots.yml`, tabla `snapshots` de Supabase.

## En curso

| Agente / sesión | Rama · worktree | Tarea | Archivos o zona | Desde |
|---|---|---|---|---|
| Claude (amazonapiseller) | wt/precio-3041402dci | 3041402DCI a 18,95 € en DE/FR/IT → `fixed_prices.csv` (precio ya aplicado en Amazon con `sync_prices_stock.py`) | `fixed_prices.csv` | 2026-10-29 |
| opencode | main (sin worktree) | Campaña -20% (25/10 → 31/12/2026) sobre 54 SKUs de stock FBA parado en ES/DE/FR/IT + informe programado del 31/12 | **Precios en Amazon** (`discounted_price` en 209 ofertas, preservando B2B) + Supabase `rules:sales`; `plan_oferta_20_2026.csv` (gitignored), `reporte_oferta_20.py`, LaunchAgent `com.christianvidalwolf.oferta20-reporte` | 2026-10-25 |
| Claude (amazonapiseller) | wt/fba-watch | Vigilante FBA + runbook de listings inactivos (autoaprendizaje) | `watch-inactive-fba`, workflow nuevo | 2026-10-21 |
| Claude (amazonapiseller) | wt/b2b-min-price | Mínimo por encima del precio B2B → FBA suprimidos | `priceBounds`, `enforce-price-bounds` | 2026-10-21 |

## Terminado

| Agente / sesión | Rama | Tarea | Fecha |
|---|---|---|---|
| Claude (amazonapiseller) | wt/bloqueo-skus | SKU bloqueados (`blocked_skus.txt`): 24350SG, 24348SG, 24342SG, 3360VC borrados y a stock 0 para siempre | 2026-10-26 |
| Claude (amazonapiseller) | wt/variantes-maquinas | Familia de variantes: figuras decorativas vintage (195 modelos, ES/DE/FR/IT) | 2026-10-25 |
| Claude (amazonapiseller) | wt/title-fixes | Limpieza de títulos: SKU en título, >200 bytes, cortados, ALL-CAPS, duplicados (Listings API PATCH) | 2026-10-23 |
| Claude (amazonapiseller) | wt/manual-prices | Precios cambiados en el panel → permanentes | 2026-10-12 |
| Claude (amazonapiseller) | wt/price-overrides | Precios fijos y ofertas → Supabase → feed diario de stock | 2026-10-12 |
| Claude (amazonapiseller) | wt/sale-price | Script `set_sale_price.py` (ofertas con `discounted_price`) | 2026-10-12 |
| Claude (amazonapiseller-fc) | chore/worktree-tooling | Script `scripts/new-worktree.sh` y este tablero | 2026-10-11 |
| opencode | main (sin worktree) | Inventario FBA: productos con stock y 0 ventas en 90 días (26/07–25/10/2026) | 2026-10-25 |
| opencode | main (sin worktree) | Fase 1 San Pancracio (40231SGI/40666SGI/40668SGI): 9 PATCH listings DE/FR/IT ACCEPTED (5 bullets + desc + kw localizados; arregla contenido ES en FR/IT). Pendiente: títulos FR/IT (no PATCH-eables), imágenes (falta usuario), FBA 14 cm, Ads 401 | 2026-10-25 |
