# Pulseras de chips de mineral ROCKING GIFTS — familia de variantes (2026-10-04)

Familia `pulseraschipmineral` (productType `BRACELET`, tema `COLOR_NAME`, el que ya tenía el padre en el catálogo) en ES, DE, FR e IT con las 68 pulseras vivas de marca ROCKING GIFTS. Los hijos, que se llamaban "Modelo 1…74", pasan a llamarse por su mineral (con "chip pequeño", "calidad A", "modelo II"… cuando hay dos del mismo mineral).

- `spec.py` — nombre del mineral de cada pulsera en ES/DE/FR/IT.
- `families.py` — título, viñetas y descripción del padre en los 4 idiomas.
- `run.py preview|submit [ES,DE,...]` — mismo flujo que `../mantas/run.py`, con un único atributo de variación (`color`).

En ES se corrigió el título de 13438VCT, 13439VCT y 3136VCI (frase prohibida "Alta Calidad").
No se actualizaron: 14807VCI en los 4 países (ASIN sugerido incoherente entre países), 1706VC en DE (viñetas promocionales), 2007RGVC y 5484RGVC en FR (sin título en francés).
