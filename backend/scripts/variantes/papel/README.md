# Papel de regalo en rollo ROCKING GIFTS — familia de variantes (2026-10-04)

Una familia `papelregalo` (productType `GIFT_WRAP`, tema `COLOR/SIZE`: diseño / medida) en ES, DE, FR e IT con los 143 papeles de regalo en rollo vivos (200x70, 300x100 y 500x70 cm; rollo suelto, packs de 2 y 3, y los "x N modelos"). Reutiliza el SKU padre `papelregalo`, que ya existía con tema `COLOR` (Amazon obliga a mantenerlo, así que el diseño va en `color`). Los hijos venían repartidos entre `papelregalo`, `PARENT-C500/C503/C505-PAPELDEREGAL`, `PARENT-OTROS-OTROS_PAPEL_DE_REGALO`, `P-NAVIDAD…`, `PARENT-DECORACIÓN…` y `PARENT-PELUCHE-PELUCHE_OSO`, y con productType GIFT_WRAP, FIGURINE, SCULPTURE, HOME o FURNITURE; todos pasan a `GIFT_WRAP` bajo `papelregalo`.

- `candidates.json` — búsqueda en `catalogo_completo.csv` (papel de regalo / rollo de papel, sin bolsas, cajas, sobres, cintas, manteles…).
- `fetch_live.py` — descarga el estado en los 4 países → `live_2026-10-04.json`; `keep.json` = candidatos menos padres, lista de borrado y archivados.
- `spec.py` — medida, lote y diseño (con traducciones) de cada rollo; `design_name()` compone el valor de `color`; excluidos con el motivo.
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas (imágenes y nodo de `3041104CLM`).
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../mantas/run.py`; `size` = medida, `number_of_items` = rollos del pack.

No entraron por errores que ya tenía la ficha (se omiten en su país, el resto del país sí entró): en DE `3041365CLM` (8541, EAN de otro ASIN), `3041446DCI`, `3041460DCI`, `3041530DCI` ("verschiedene Farben" en viñetas), `3041385CLM` ("Weihnachtsgeschenk" en el título), `3041373DCI`, `3041374DCI`, `3041377DCI` (título > 75 caracteres con viñetas destacadas); en FR e IT `3041383CLM` y `3041339CLM` (sin título); en IT además `3041365CLM` (101067, el ASIN es FURNITURE allí). `3041285CLM` solo existe en ES y DE.

Resultado del envío: padre aceptado en los 4 países; hijos ES 143/143, DE 134, FR 140, IT 139, todos `ACCEPTED` (`last_submit.json`, `write_log.jsonl`).

Los padres viejos (`PARENT-C500/C503/C505-PAPELDEREGAL`, etc.) quedan sin hijos de papel; no se han borrado.
