# Auditoría de la aplicación

## Estado actual

| Área | Estado | Limitación principal | Solución recomendada |
|---|---|---|---|
| Inventario | Operativo | Los precios de todos los marketplaces pueden tardar por el rate limit de Amazon | Cache por marketplace en Supabase/Redis y refresco bajo demanda |
| Listings/precios | Operativo | Amazon acepta el envío de forma asíncrona | Guardar `submissionId`, consultar estado y mostrar `ACCEPTED`/`INVALID` |
| Ventas | Operativo | Los informes pueden tardar hasta dos minutos | Ejecutar creación/polling en BullMQ y consultar un job |
| Precios/Buy Box | Operativo | El análisis completo consume muchas llamadas SP-API | Persistir snapshots y actualizar por lotes programados |
| BSR | Parcial | El refresco en producción no está disponible | Ejecutar el refresh en backend/worker y publicar el resultado |
| Finanzas | Parcial | Los gastos manuales dependen de un backend persistente | Mantener backend desplegado con PostgreSQL accesible |
| Account Health | Snapshot | Vercel lee snapshots publicados | Programar sincronización por marketplace y conservar histórico |
| Publicidad | Parcial | Sin credenciales Ads devuelve datos simulados | Configurar credenciales Ads y marcar siempre los datos demo |
| Sincronización | No disponible en Vercel | El endpoint de trigger es local/backend-only | Moverlo a GitHub Actions o a un backend persistente con cola |

## Mejoras aplicadas

- Typecheck, Vitest, Playwright, Biome, Knip, CodeQL y Sentry configurados.
- El backend pasa Biome, typecheck y tests.
- El build de producción del frontend pasa.
- Se reorganizaron imports y se corrigieron avisos seguros sin cambiar contratos de Amazon.

## Próximos cambios de alto valor

1. Añadir un modelo de `AmazonSubmission` con marketplace, SKU, precio,
   `submissionId`, estado, issues y timestamps.
2. Añadir `GET /api/listings/items/:sku/status` para consultar el resultado
   posterior de Amazon y no confundir “aceptado” con “publicado”.
3. Mover informes de ventas, snapshots de pricing y refresh de BSR a BullMQ.
4. Persistir snapshots por marketplace con TTL para que Inventario no espere
   a cientos de llamadas en cada visita.
5. Convertir los avisos restantes de Biome del frontend en cambios pequeños,
   empezando por hooks con dependencias incompletas y botones sin `type`.

## Requisitos externos

- Variables `SENTRY_DSN` y `NEXT_PUBLIC_SENTRY_DSN`.
- Un backend persistente para operaciones que escriben en Amazon y gastos.
- Secretos SP-API y Ads configurados en GitHub Actions/Vercel/backend.
- Node.js 22+ para el MCP oficial de Amazon.
