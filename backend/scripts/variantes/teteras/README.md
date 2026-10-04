# Teteras de hierro colado ROCKING GIFTS — familia de variantes (2026-10-04)

Una familia `PARENT-TETERA-HIERRO` (productType `TEAPOT`, tema `SIZE_NAME/STYLE_NAME/COLOR_NAME`) en ES, DE, FR e IT: capacidad (0,3–1,8 L) / diseño (Flores, Bambú, Estriada, Puntos, Espiga, sets con tazas…) / color. Reutiliza el SKU padre del intento anterior (incompleto).

- `spec.py` — capacidad, diseño y color de cada tetera; traducciones de diseños y colores.
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas.
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../mimbre/run.py`.
- `live_2026-10-04.json` — estado previo; `write_log.jsonl` — respuestas de Amazon.

No se actualizaron por error 8541 (datos que no casan con el catálogo): 34185SGI, 39142SGI, 34193SGI, 39148SGI, 39164SGI, 39170SGI, 39183SGI en los 4 países y además 34182SGI, 34189SGI, 34202SGI en ES. Las que ya eran hijas de este padre siguen en la familia con sus datos anteriores.
Fuera de alcance: la línea `*SGRG/*RGSG` en la lista de borrado, Vidal Regalos, salvamanteles y filtros.
