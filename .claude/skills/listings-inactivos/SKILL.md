---
name: listings-inactivos
description: Diagnose and fix Amazon listings that are inactive, suppressed or not buyable (FBA stock but not selling, Amazon issue codes like 18155, 18639, 13013, 90220, 90244, 100390, 100632, "SKU no existe en este marketplace", email del Vigilante FBA). Use whenever the user reports deactivated/suppressed listings or forwards the daily FBA watcher email. Reads and then extends the project runbook so every new case is learned.
---

# Listings inactivos (con autoaprendizaje)

1. **Lee primero** `docs/runbooks/listings-inactivos.md`: tabla código → causa → arreglo, reglas de precio por país y casos ya resueltos.
2. **Diagnostica** sin escribir: `cd backend && npm run listing:status -- <SKU>`; para muchos, el informe del vigilante en Supabase `alerts:fba-inactive:last-run` agrupado por código.
3. **Arregla** con lo que ya existe, en este orden:
   - precio/mínimos → `npm run enforce:price-bounds` (con `SKUS=`), o la plantilla `scripts/ops/fix-inactive.ts`;
   - oferta que falta o registro vacío → `scripts/ops/fix-inactive.ts` (`CREATE`, `replaceShell`);
   - ASIN sin ficha en el país → `scripts/ops/fix-full-listing.ts` + `scripts/ops/data/<SKU>-content.json` traducido;
   - cumplimiento (documentos, RAP, seguridad, marca, imagen) → explicar al usuario qué hacer en Seller Central.
   Siempre simulación primero; escribir en Amazon (`APPLY=1`) solo con el OK del usuario. Trabaja en worktree (`scripts/new-worktree.sh`).
4. **Aprende** antes de terminar:
   - añade una fila a "Registro de casos" del runbook (fecha · SKU/país · síntoma · causa · arreglo · resultado);
   - si el código o la causa es nuevo, añádelo a la tabla del runbook;
   - si el mismo arreglo manual se repite 2+ veces, automatízalo (`src/lib/priceBounds.ts`, `enforce-price-bounds.ts` o el vigilante) con test, y actualiza la tabla a "Auto: sí";
   - commit del runbook junto con el código.
