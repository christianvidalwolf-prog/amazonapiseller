# Figuras decorativas vintage ROCKING GIFTS — familia de variantes (2026-10-25)

Una familia `PARENT-FIGURAS-VINTAGE-RG` (productType `FIGURINE`, tema `STYLE_NAME/SIZE_NAME`: modelo / medida) en ES, DE, FR e IT con 195 figuras vintage, con stock o sin él: máquinas de escribir y de coser, cámaras, proyectores, radios, gramófono, caja registradora (`312407DCI`) y todos los vehículos retro (coches, furgonetas, motos, scooters, aviones, trenes, tranvías, bicicletas). Los vehículos venían repartidos en ~17 familias pequeñas (`figurascoches`, `PARENT-V047/V067/B200/C580/B270/C581/C412/B409/B410/B411/B225`, `grp_avion_01`, `P-OTROS…SCOOTER`, `P-OTROS…FURGONETA`, `PARENT-DECORACIÓN-DECORACIÓN_CAJA`, `grp_estatua_figura__metal_01`; `OLD_PARENTS` en `spec.py`); esos padres quedan sin estos hijos y no se han borrado.

- `candidates.json` — búsqueda en `catalogo_completo.csv` (198 SKU).
- `fetch_live.py` — estado en los 4 países → `live_2026-10-21.json`.
- `spec.py` — modelo (con traducciones DE/FR/IT en `STYLE`) y medida de cada hijo; los vehículos a escala usan "Escala 1:N" (Maßstab/Échelle/Scala). Excluidos: `17987SG` (adorno de pared) y `308508CLM`, `308510CLM` (huchas de la familia `huchasinfantiles`).
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas (imágenes y nodo de `312408DCI`).
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../papel/run.py`; `style` = modelo, `size` = medida, y el hijo pasa a productType `FIGURINE`.

No entraron por errores que ya tenía la ficha (se omiten en su país; el resto del país sí entró):
- `312411DCI` (ES) y `312412DCI` (ES, FR, IT): 101067, el ASIN es `VIDEO_PROJECTOR` y no puede pasar a `FIGURINE`.
- `22798SGR` (los 4) y `24384SG` (ES, DE, IT): 8541, datos distintos de los del ASIN del catálogo.
- `37258SGRI` (ES): "avion" más de dos veces en el título.
- `312405DCI` (DE): "ideales Geschenk" en las viñetas.
- `312436DCI` (DE): título > 75 caracteres con viñetas.

Resultado del envío: padre aceptado en los 4 países; hijos ES 190, DE 191, FR 191, IT 187, todos `ACCEPTED` (`last_submit.json`, `write_log.jsonl`).
