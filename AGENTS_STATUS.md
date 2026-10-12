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

## Terminado

| Agente / sesión | Rama | Tarea | Fecha |
|---|---|---|---|
| Claude (amazonapiseller) | wt/manual-prices | Precios cambiados en el panel → permanentes | 2026-10-12 |
| Claude (amazonapiseller) | wt/price-overrides | Precios fijos y ofertas → Supabase → feed diario de stock | 2026-10-12 |
| Claude (amazonapiseller) | wt/sale-price | Script `set_sale_price.py` (ofertas con `discounted_price`) | 2026-10-12 |
| Claude (amazonapiseller-fc) | chore/worktree-tooling | Script `scripts/new-worktree.sh` y este tablero | 2026-10-11 |
