# Globos terráqueos ROCKING GIFTS — familia de variantes (2026-10-04)

Una familia `globoterraqueo` (productType `GLOBE`, tema `SIZE_NAME/COLOR_NAME`: diámetro / modelo; el padre ya tenía el tema de color en el catálogo y Amazon exige mantenerlo, así que el nombre del modelo va en `color` y también en `style`) en ES, DE, FR e IT con los 21 globos vivos de ROCKING GIFTS (10,8–25 cm: vintage, iluminados, con soporte, base de madera o pie dorado). Reutiliza el SKU padre del intento anterior.

- `spec.py` — diámetro y modelo (en 4 idiomas) de cada globo, y excluidos con el motivo.
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas.
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../santos/run.py`.

No entró `22992SG` (error 8541, datos que no casan con el catálogo). Excluidos: `301902CLM` (ficha con viñetas de bolígrafos), otras marcas (Home Gadgets, Art Deco Home) y los globos borrados o en la lista de borrado.
