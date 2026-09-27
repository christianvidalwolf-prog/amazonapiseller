# Variaciones ROCKING GIFTS (Amazon ES) — 2026-09-25

Herramientas usadas para auditar y crear familias de variantes (parent/child) de los listings
Signes Grimalt (SKU *SGI) y Dcasa (*DCI/*DC), solo marca ROCKING GIFTS.

- `merge.py` / `fetch.py` / `group.py` / `report.py` — auditoría: cruza catálogo, proveedores y Listings API; genera `groups_final.json` y el Excel `propuesta_variantes_rocking_gifts.xlsx`.
- `sp.py` — cliente mínimo Listings API (usa `auth.py` de la raíz).
- `build.py` — payload del padre y patches de hijo.
- `run_group.py <dir> <spec> preview|submit` — familias de `pilot_spec.json` (PUT, permite cambiar productType: TEAPOT, LAMP, STORAGE_RACK, TRIVET…).
- `run_auto.py <dir> <batch.json> <familia> preview|submit` — familias con productType actual (PATCH hijos). En submit valida antes y omite hijos con error.
- `batch2.json`, `batch3.json`, `batchX.json`, `batchB.json` — familias enviadas (A y B). `bdec.py` = decisiones de la revisión visual de B.
- `write_log.jsonl` — todos los envíos a Amazon.

Ejecutar con `../../../.venv/bin/python` y pasar esta carpeta como primer argumento.
Pendiente: grupos prioridad C (`groups_final.json`, prio == "C").
