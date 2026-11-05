# Ciclo diario de listings inactivos

Ejecuta el equipo de agentes sobre listings FBA con stock que no están `BUYABLE`.

## Instrucciones

1. **Escanea** (solo lectura): desde `backend/`, `npm run agents:inactive`.
   - Con `$ARGUMENTS` = lista de SKU: `INACTIVE_AGENTS_SKUS=$ARGUMENTS npm run agents:inactive`.
   - Resume por país y por código de Amazon. No escribas nada todavía.

2. **Decide** qué toca:
   - Casos con acción automática (`límites`, `precio normal`, `crear oferta`, `GPSR`) → corregir.
   - Casos de cumplimiento/marca/categoría → no tocar; pasan a la lista de Seller Central.
   - Casos ya rechazados 2 veces → no reintentar; explicar por qué.

3. **Corrige** con el motor y sus topes, nunca a mano salvo que el caso no esté cubierto:
   ```bash
   cd backend && npm run agents:inactive:apply
   ```
   Antes de crear ofertas o GPSR en volumen, valida sin enviar:
   `INACTIVE_AGENTS_PREVIEW_ONLY=1 INACTIVE_AGENTS_APPLY=1 npm run agents:inactive`.

4. **Verifica**: relee con `npm run listing:status -- <SKU>` los que hayan dado `ACCEPTED`.
   `ACCEPTED` no significa aplicado (ver runbook, apartado 3).

5. **Aprende**: añade al runbook las filas nuevas del registro de casos y los códigos que no estuvieran.
   Si un arreglo manual se repite, automatízalo en `src/lib/inactive-case.ts` con test.

## Reglas

- Trabaja en worktree si vas a tocar código; `main` despliega a producción.
- No toques `blocked_skus.txt`, precios manuales del panel ni el precio B2B.
- Un único email diario lo manda el workflow `agents-inactive-listings.yml`; no dupliques avisos.
