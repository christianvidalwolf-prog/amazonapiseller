# Lámparas de mesa mosaico ROCKING GIFTS — familia de variantes (2026-10-03)

Una familia `PARENT-LAMPARA-MOSAICO` (productType `LAMP`, tema `STYLE_NAME/SIZE_NAME`) en ES, DE, FR e IT con las 51 lámparas de la línea Signes Grimalt (`*SGI`). Modelo = diseño (seta, globo, cilindro, tortuga, pera… y su dibujo), tamaño = altura. Reutiliza el SKU padre del intento anterior, que estaba incompleto y no existía en DE.

- `spec.py` — diseño (en 4 idiomas) y altura de cada lámpara.
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas.
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../santos/run.py`, más los datos eléctricos obligatorios de `LAMP` (`power_plug_type`, `accepted_voltage_frequency`): lo ya declarado en el listing o, si falta, enchufe europeo tipo C y 220-240 V / 50 Hz.
- `live_2026-10-03.json` — estado previo; `write_log.jsonl` — respuestas de Amazon.

No entraron por error 8541 (datos que no casan con el catálogo de Amazon): `40404SGI` en los 4 países (su EAN coincide con otro ASIN), `39089SGI` y `40410SGI` en ES.
Fuera de alcance: la línea `*SG` de 2024 (familia `lamparasmosaico`), Vidal Regalos y las lámparas árabes `*SGRG`.
