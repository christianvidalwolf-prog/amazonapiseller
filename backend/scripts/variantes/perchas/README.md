# Perchas de pared de hierro colado ROCKING GIFTS — familia de variantes (2026-10-29)

Una familia `PARENT-PERCHAS-HIERRO-RG` (productType `STORAGE_HOOK`, tema `STYLE_NAME/SIZE_NAME`: motivo / medida) en ES, DE, FR e IT con 26 perchas y percheros de pared de hierro colado, con stock o sin él. Partió de `30343SG` (B0CW6QYG5V, correa de perro con 3 ganchos), que no tenía variantes. Los hijos que eran `SCULPTURE`, `FIGURINE` o `HOME_FURNITURE_AND_DECOR` pasan a `STORAGE_HOOK`. `36712SGI` y `36718SGI` (gallina) venían de `PARENT-B282-PERCHAPAREDG`, que queda sin hijos y no se ha borrado.

- `candidates.json` — búsqueda en `catalogo_completo.csv` (percha/perchero + pared + hierro colado/fundido, sin FBA).
- `fetch_live.py` — estado en los 4 países → `live_2026-10-29.json`.
- `spec.py` — motivo (con traducciones DE/FR/IT en `STYLE`) y medida de cada hijo. Excluidos: `24212SG` y `24220SG` (marca Vidal Regalos; `24212SG` ya borrado).
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas (imágenes y nodo de `30343SG`).
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../vintage/run.py`.

No entró: `35132SGI` (flamenco) en ES y DE, 8541 (datos distintos de los del ASIN B0HJRG8XYR del catálogo); sí entró en FR e IT.

Resultado: padre aceptado en los 4 países (ASIN ES B0HPPGKMRK, DE B0HPPKBGSG, FR B0HPPJZ8CH; DE en revisión 100521); hijos 25/25 `ACCEPTED` en cada país (`last_submit.json`, `write_log.jsonl`).
