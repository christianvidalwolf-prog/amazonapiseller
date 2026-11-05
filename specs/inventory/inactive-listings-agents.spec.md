# Especificación SDD: Equipo de agentes de listings inactivos
**Módulo:** `inventory` (vigilante FBA) · **Script:** `backend/scripts/agents/inactive-listings.ts`
**Versión:** 1.0.0 · **Estado:** Activo

---

## 1. Propósito y alcance

Cerrar el ciclo completo de los listings FBA que tienen unidades vendibles en los almacenes de Amazon
pero no están `BUYABLE` en algún país: **detectar, diagnosticar, corregir por API y verificar**, todos
los días y en todos los mercados configurados.

Sustituye el ciclo manual "email del vigilante → abrir sesión → arreglar a mano":

| Antes | Ahora |
|---|---|
| `watch:inactive-fba` solo lee y manda email | escanea, clasifica, corrige y verifica en una pasada |
| el arreglo depende de que alguien abra una sesión | GitHub Actions diario, sin intervención |
| los casos irresolubles vuelven cada mañana | se escalan una vez y se listan como tarea de Seller Central |
| el aprendizaje queda en el runbook | el runbook y el triaje se actualizan con cada código nuevo |

**Fuera de alcance:** crear fichas de producto completas (`13013`), subir documentos, brand gating o
cambiar imágenes (van a Seller Central); stock FBM (el escaneo se basa en FBA Inventory).

## 2. Países

`INACTIVE_AGENTS_COUNTRIES` (por defecto `ES,DE,FR,IT`). El escaneo es independiente por marketplace:
un SKU puede estar `BUYABLE` en ES y no en IT, y solo se trata el país afectado. Los países no
autorizados para la app devuelven error de inventario y quedan en `errores` del informe.

## 3. Flujo (4 agentes)

```
FBA Inventory (fulfillableQuantity > 0)
        │
        ▼
[1] Escáner ──► getListingsItem (summaries, issues, attributes, es_ES)
        │        inactivo = sin BUYABLE · razón = issues ERROR
        ▼
[2] Triaje ──── src/lib/inactive-case.ts  (puro + tests)
        │        bounds | fill-price | create-offer | gpsr | wait | escalate | ignore
        ▼
[3] Corrector ── Listings Items PATCH/PUT · tope INACTIVE_AGENTS_MAX_FIXES (60/día)
        │        create-offer y gpsr: VALIDATION_PREVIEW antes de enviar
        ▼
[4] Verificador ─ relee estado inmediato · cierra los casos que ya no salen
                 · deja de reintentar tras INACTIVE_AGENTS_MAX_ATTEMPTS (2)
        │
        ▼
Supabase rules:inactive-listings:{state,last-run} + alerts:fba-inactive:last-run · email
```

## 4. Contrato del triaje

Entrada: `InactiveCase { sku, country, asin, units, status[], issues[], exists, productType, offer }`.
`offer` = `{ hasNormal, hasPrice, hasBusiness, hasExpiredSale }`, leído de `purchasable_offer`
del marketplace.

Orden de decisión (el primero que aplica gana):

| # | Condición | Acción | Auto |
|---|---|---|---|
| 1 | SKU `amzn.gr.*` | `ignore` | no |
| 2 | issue `100521` (en revisión) | `wait` | no |
| 3 | SKU no existe en el país, hay ASIN | `create-offer` | sí |
| 4 | SKU no existe en el país, sin ASIN | `escalate` | no |
| 5 | `100632` con texto GPSR | `gpsr` | sí |
| 6 | `100390`, `19084`, `19098`, `18146`, `18570`, `18967`, `18644`, `100720`, `13013`, `90220`, o `100632` RAP/EPR | `escalate` | no |
| 7 | `90244` (unit_count fuera de enum) | `escalate` | no |
| 8 | `18155`, `18639`, `99022` | `bounds` | sí |
| 9 | sin oferta normal o sin `our_price` | `fill-price` | sí |
| 10 | promoción / `end_at` vencidos | `bounds` | sí |
| 11 | sin BUYABLE y sin errores | `bounds` (si no cambia nada, escala tras 2 intentos) | sí |

`planFixes` deduplica por `SKU|país`, ordena por unidades descendentes y aplica el tope. Un caso con
`attempts >= MAX_ATTEMPTS` deja de escribirse y pasa a la lista de Seller Central.

## 5. Reglas de negocio (heredadas del runbook)

- **Precio**: `fixed_prices.csv` manda; si no, el precio del propio país; si no, se deduce de otro país
  con `FBA_COUNTRY_OFFSET` (DE = ES, FR = IT = ES + 2). El B2B nunca se toca.
- **Mínimo**: mitad del precio más bajo (normal, oferta vigente o B2B). Nunca por encima del B2B.
- **Promociones vencidas**: `withoutStaleSales` quita `discounted_price` sin importe o caducado y vacía
  un `end_at` pasado (omitirlo no lo borra).
- **Ofertas nuevas**: `LISTING_OFFER_ONLY` sobre el ASIN del inventario, `AMAZON_EU`, GPSR incluido en
  DE/FR/IT y `not_applicable` / `false` en mercancías peligrosas y baterías.
- **Nunca** se tocan SKU de `blocked_skus.txt` ni los que cubre `fba_watch_ignore.txt` (el triaje los
  manda a Seller Central).

## 6. Guardrails

1. **Simulación por defecto**: sin `INACTIVE_AGENTS_APPLY=1` no se escribe nada; el informe dice
   `validado (sin aplicar)`.
2. **Tope diario** de arreglos (`INACTIVE_AGENTS_MAX_FIXES`) y **tope de intentos** por caso.
3. **Preview antes de crear**: `VALIDATION_PREVIEW` en `create-offer` y `gpsr`; si Amazon rechaza el
   preview no se envía.
4. **Un arreglo por SKU+país y ejecución** (idempotente: si no hay cambio, no se envía).
5. **Verificación diferida**: el estado inmediato se anota, pero el cierre real es la ausencia del caso
   en el escaneo del día siguiente (Amazon tarda en recalcular).
6. **Secretos**: mismas credenciales SP-API que el resto del backend; el workflow no recibe permisos de
   escritura en el repo.

## 7. Observabilidad

- Supabase `rules:inactive-listings:state` → `{ attempts: { "SKU|PAÍS": { count, action, lastAt, lastResult, units } } }`.
- Supabase `rules:inactive-listings:last-run` → resumen, arreglos, backlog de Seller Central, resueltos, errores.
- Supabase `alerts:fba-inactive:last-run` → mismo formato que el vigilante anterior (compatibilidad).
- Email diario (Gmail SMTP) con tres tablas: arreglos intentados, Seller Central, y pendientes por tope.

## 8. Criterios de aceptación

- [x] Un SKU con stock y sin `BUYABLE` aparece en el informe con su motivo.
- [x] `18155` con oferta normal → mínimo explícito; sin cambio no se escribe.
- [x] Oferta solo B2B en DE/FR/IT → se le pone precio normal del país.
- [x] SKU con stock sin oferta en el país → preview válido y oferta creada sobre el ASIN.
- [x] `100632` GPSR → datos de fabricante y certificación.
- [x] `100390`/`18570`/`18146`/`19098` → no se escribe y salen como tarea de Seller Central.
- [x] Un caso que falla 2 veces deja de reintentarse.
- [x] Caso que desaparece del escaneo se marca resuelto.
- [x] Simulación sin `APPLY` no escribe en Amazon.
- [x] Tests de la clasificación y del plan (`backend/src/lib/inactive-case.test.ts`).

## 9. Operación manual

```bash
cd backend
npm run agents:inactive                                   # simulación (no escribe)
INACTIVE_AGENTS_SKUS=SKU1,SKU2 npm run agents:inactive     # solo esos SKU
npm run agents:inactive:apply                             # aplica con topes
INACTIVE_AGENTS_PREVIEW_ONLY=1 INACTIVE_AGENTS_APPLY=1 npm run agents:inactive  # valida sin enviar
```
