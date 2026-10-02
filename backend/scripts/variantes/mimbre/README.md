# Cestas de mimbre ROCKING GIFTS — subfamilias de variantes (2026-10-02)

Seis familias parent/child (productType `BASKET`, tema `STYLE_NAME/SIZE_NAME/COLOR_NAME`) en ES, DE, FR e IT:

| Familia | SKU padre |
|---|---|
| Paneras | `PARENT-PANERAS-MIMBRE-RG` |
| Cestas con forro (organizadoras) | `PARENT-CESTAS-FORRO-MIMBRE-RG` |
| Sets de cestas boho | `PARENT-SETS-CESTAS-BOHO-RG` |
| Sets de cestas artesanales | `PARENT-SETS-CESTAS-ARTESANAL-RG` |
| Cestos grandes y baúles | `PARENT-CESTOS-BAULES-MIMBRE-RG` |
| Revisteros (solo ES/DE) | `PARENT-REVISTEROS-MIMBRE-RG` |

- `spec.py` — modelo/tamaño/color de cada hijo, traducciones de modelos y colores, y los SKU excluidos con el motivo.
- `families.py` — hijos de cada familia y título, viñetas y descripción del padre en los 4 idiomas.
- `run.py preview|submit [ES,DE,...] [familia,...]` — valida (VALIDATION_PREVIEW) o crea el padre (PUT `LISTING_PRODUCT_ONLY`) y asigna los hijos (PATCH). En submit omite los hijos que no validan y no crea familias con menos de 2 hijos.
- `live_2026-10-02.json` — estado de los listings consultado antes de agrupar (presencia por país).
- `write_log.jsonl` — respuesta de Amazon de cada envío.

Quedaron fuera: `273526CLM` en IT (el ASIN es HOME en Italia), `2873115DCI` en ES (error 8541), `312516DCI` en DE (título de más de 75 caracteres) y revisteros en FR/IT (menos de 2 hijos).
