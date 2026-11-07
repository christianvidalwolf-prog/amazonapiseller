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

## Herramientas TypeScript (usan `backend/.env`, no el `auth.py` de la raíz)

Para grupos ya existentes, sin pasar por el flujo de auditoría en Python:

- `inspect-variations.ts <SKU1,SKU2,…> [ES]` — solo lectura: estado, productType, `parentage_level`, `variation_theme`, padre/hijos, color, tamaño y dimensiones. Sirve para encontrar la familia a la que pertenece (o no) un SKU.
- `attach-child.ts <SKU_HIJO> <SKU_PADRE> <COLOR|SIZE|COLOR/SIZE> <VALOR> [ES] [--apply] [--force]` — añade un SKU existente como hijo de una familia: escribe solo `parentage_level`, `child_parent_sku_relationship`, `variation_theme` y el valor de la dimensión, previa validación `VALIDATION_PREVIEW`. No toca precio, stock ni contenido. `--force` permite mover un hijo de otra familia.

```bash
cd backend
npm run variantes:inspect -- 40273SGI,relojpared60cm ES
npm run variantes:attach -- 40273SGI relojpared60cm COLOR "Blanco Nórdico" ES          # simula
npm run variantes:attach -- 40273SGI relojpared60cm COLOR "Blanco Nórdico" ES --apply  # envía
```

Notas: el valor de `color`/`size` va en el idioma del marketplace (ES `es_ES`, DE `de_DE`, FR `fr_FR`, IT `it_IT`;
Amazon rechaza con **100720** si no coincide). En productType `SCULPTURE` hay que enviar `power_plug_type`
(`no_plug` en relojes) o Amazon devuelve **90220**. Las variantes son por marketplace: hay que repetir el alta en
cada país donde exista la familia. `ACCEPTED` no significa aplicado: el padre/hijo tarda uno o dos minutos en reflejarse.

Caso 2026-11-07: `40273SGI` (B0HKDVTFB5, reloj 60 cm blanco) añadido a la familia `relojpared60cm`
(ES B0CJ9P5WLZ · DE B0CWPR22WV · FR B0CX9P9J8T · IT B0CWPVFNVM), tema COLOR, colores
`Blanco Nórdico` / `Weiß Nordischer Stil` / `Blanc Nordique` / `Bianco Nordico`.
